import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { DtlsClient } from './dtls/handshake.js';
import { PreNegotiatedDataChannel } from './datachannel/pre-negotiated.js';
import { createNoopLogger } from '../shim/core.js';
import { toError } from '../shim/util.js';
import { TEXT_ENCODER, toArrayBuffer } from '../bytes.js';
import { buildAllocateForRelay, buildBindingRequest, buildWhatsAppPing, createWasmStreamDescriptors, parseStunResponse } from './stun.js';

// ============================================================================
// Manual DTLS+SCTP relay transport.
//
// This replaces WaSctpRelay.js's use of @roamhq/wrtc's RTCPeerConnection with
// a from-scratch UDP -> ICE STUN Binding -> DTLS -> SCTP -> pre-negotiated
// DataChannel stack, so the process no longer needs a native WebRTC binding
// at all. Everything above the transport layer (RTP/SRTP, Opus, H.264,
// signaling) is unchanged and untouched — this class exposes the exact same
// external interface WaSctpRelay.js did (constructor, setSsrc/setVideoSsrc/
// setSubscriptionSsrc, configureRelays, broadcast, hasConnection,
// getConnectedCount, cleanup, 'relay_connected'/'relay_receive' events) so
// WaCallMediaSession.js only needs its import/constructor call swapped.
//
// Background: an earlier investigation (see the old relay-transport.js this
// was rebuilt from) hand-rolled DTLS and SCTP from scratch and verified them
// byte-correct — independently re-derived checksums, and even an `openssl
// s_client` DTLS handshake sending the exact same SCTP INIT bytes got the
// identical "no response" result our own code did. That ruled out the wire
// format. What actually explained it only surfaced later, by reverse-
// engineering WaSctpRelay.js's SDP manipulation for wrtc's RTCPeerConnection:
// real WebRTC clients perform an ICE STUN Binding connectivity check BEFORE
// DTLS even starts, and — critically — this relay doesn't use freshly
// generated, independent local/remote ICE credentials the way real ICE does.
// WaSctpRelay.js forces BOTH sides' ice-ufrag/ice-pwd to the SAME value,
// taken from the relay allocation's own token/key:
//     iceUfrag = relayInfo.authToken || relayInfo.token
//     icePwd   = relayInfo.key
// A STUN Binding Request signed with the wrong (or no) credentials is
// presumably just silently ignored — the relay still completes a DTLS
// handshake with anyone (that layer is credential-agnostic), but apparently
// never responds at the SCTP layer without having first seen a valid Binding
// check. performIceBinding() below is that step, added to the proven-correct
// DTLS/SCTP client from before.
// ============================================================================

const CONFIG = {
  TRUE_WEB_CLIENT_RELAY_PORT: 3480,
  CONNECTION_TIMEOUT_MS: 20_000,
  // Short, fast-doubling retries — the relay either answers a Binding
  // Request within a couple hundred ms or it's not going to on this attempt.
  ICE_BINDING_TIMEOUTS_MS: [250, 400, 600, 1000, 1500, 2000],
  KEEPALIVE_INTERVAL_MS: 1100,
  ICE_CONSENT_REFRESH_MS: 400,
  MAX_BUFFER_SIZE: 256 * 1024,
};

const ConnectionState = {
  None: 'None',
  Connecting: 'Connecting',
  Open: 'Open',
  Closed: 'Closed',
  Failed: 'Failed',
};

function byteLengthOf(data) {
  return data?.byteLength ?? data?.length ?? 0;
}

// Only used in the post-open v1/v2 registration messages below (see
// sendStunAllocateOnOpen's comment) — not part of the pre-DTLS ICE binding,
// which uses iceUfrag (from the relay's own token) on both sides instead.
function randomUfrag() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export class WaManualRelay extends EventEmitter {
  logger;
  connections = new Map();
  relayMap = new Map();
  audioSsrc = 0;
  videoSsrc = 0;
  subscriptionSsrc = 0;
  configuring = false;
  globalBuffer = [];
  globalBufferedBytes = 0;
  stats = { sent: 0, received: 0, connected: 0 };

  constructor(options = {}) {
    super();
    this.logger = options.logger ?? createNoopLogger();
  }

  setSsrc(ssrc) {
    this.audioSsrc = ssrc;
    this.logger.debug('manual relay ssrc set', { ssrc: `0x${ssrc.toString(16).padStart(8, '0')}` });
  }

  /** See WaSctpRelay.setVideoSsrc's comment — same fix, same reason, carried
   * over: without registering the video SSRC with the relay (done inside
   * performIceBinding/the SCTP-layer subscription, mirrored from that fix),
   * outgoing video packets would be built and sent correctly but the relay
   * would have no record they were ours to forward. */
  setVideoSsrc(ssrc) {
    this.videoSsrc = ssrc;
    this.logger.debug('manual relay video ssrc set', { ssrc: `0x${ssrc.toString(16).padStart(8, '0')}` });
  }

  setSubscriptionSsrc(ssrc) {
    this.subscriptionSsrc = ssrc;
    this.logger.debug('manual relay subscription ssrc set', {
      ssrc: `0x${ssrc.toString(16).padStart(8, '0')}`
    });
  }

  makeConnectionId(ip, port, authTokenId) {
    const base = ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`;
    return authTokenId ? `${base}#${authTokenId}` : base;
  }

  async configureRelays(relays) {
    this.logger.debug('manual relay configuring relays', { count: relays.length });
    this.configuring = true;
    for (const relay of relays) {
      const port = relay.port || CONFIG.TRUE_WEB_CLIENT_RELAY_PORT;
      const connectionId = this.makeConnectionId(relay.ip, port, relay.authTokenId);
      this.relayMap.set(connectionId, {
        id: connectionId,
        ip: relay.ip,
        port,
        token: relay.token,
        authToken: relay.authToken,
        rawAuthToken: relay.rawAuthToken,
        rawToken: relay.rawToken,
        key: relay.key,
        relayId: relay.relayId,
        name: relay.name || 'unknown',
        authTokenId: relay.authTokenId,
        isFna: relay.isFna
      });
    }
    const connectionPromises = [];
    for (const [, relayInfo] of this.relayMap) {
      if (!this.connections.has(relayInfo.id)) {
        connectionPromises.push(this.ensureConnection(relayInfo));
      }
    }
    await Promise.all(connectionPromises);
    this.logger.debug('manual relay configuration done', { connected: this.stats.connected });
    this.configuring = false;
    if (this.globalBuffer.length > 0) {
      for (const item of this.globalBuffer) this.sendToRelay(item.ip, item.port, item.data);
      this.globalBuffer = [];
      this.globalBufferedBytes = 0;
    }
  }

  getOrCreateConnection(relayInfo) {
    let conn = this.connections.get(relayInfo.id);
    if (!conn) {
      conn = {
        state: ConnectionState.None,
        relayInfo,
        socket: null,
        dtlsClient: null,
        dataChannel: null,
        packetBuffer: [],
        bufferedBytes: 0,
        connectPromise: null,
        connectionTimeout: null,
        keepaliveTimer: null,
        iceConsentTimer: null,
        localUfrag: randomUfrag(),
        stats: { sentPackets: 0, receivedPackets: 0, sentBytes: 0, receivedBytes: 0 }
      };
      this.connections.set(relayInfo.id, conn);
    }
    return conn;
  }

  // Same shared-promise dance WaSctpRelay.js's #ensureConnection uses:
  // configureRelays()'s fan-out and any later sendToRelay()/broadcast() call
  // can both land here for the same still-connecting candidate, and both are
  // fire-and-forget — an uncaught rejection from either would otherwise
  // become an unhandledRejection that kills the whole worker over one
  // relay's DTLS alert, even while other candidates are fine.
  ensureConnection = async (relayInfo) => {
    const conn = this.getOrCreateConnection(relayInfo);
    if (conn.state === ConnectionState.Open || conn.state === ConnectionState.Connecting) {
      return (conn.connectPromise ?? Promise.resolve()).catch(() => {});
    }
    const promise = this.connect(conn);
    conn.connectPromise = promise;
    try {
      await promise;
    } catch (err) {
      this.logger.debug('manual relay connection attempt failed', {
        connectionId: relayInfo.id,
        message: toError(err).message
      });
    } finally {
      conn.connectPromise = null;
    }
  };

  /** Pre-DTLS ICE STUN Binding — see the module-level comment for why this
   * exists. Resolves (not rejects) either way, since we still attempt DTLS
   * even if no Binding Success ever comes back, on the chance it isn't
   * strictly required for a given relay generation. */
  performIceBinding(socket, relayInfo, conn) {
    return new Promise((resolve) => {
      const iceUfrag = relayInfo.authToken || relayInfo.token || '';
      const icePwd = relayInfo.key || '';
      // FOUND A BUG: this was `${iceUfrag}:${iceUfrag}` — the same value
      // twice. RFC 8445 §7.2.2's USERNAME format is "PEER-ufrag:LOCAL-ufrag"
      // (two DIFFERENT values), which sendStunAllocateOnOpen already builds
      // correctly a bit further down (`${remoteUfrag}:${localUfrag}`) — this
      // pre-DTLS step just never matched it. Re-checked against
      // WaSctpRelay.js's modifySdpForRelay: relayInfo.authToken/token only
      // ever get written into the FAKE ANSWER's ice-ufrag (the peer's
      // credential); our own local ufrag is whatever libwebrtc's real
      // offer.sdp already had, i.e. independently random — never that same
      // token. conn.localUfrag (generated in getOrCreateConnection) is that
      // per-connection random value.
      const username = TEXT_ENCODER.encode(`${iceUfrag}:${conn.localUfrag}`);
      const hmacKey = TEXT_ENCODER.encode(icePwd);
      let attempt = 0;
      let settled = false;
      let timer = null;

      const onMessage = (datagram) => {
        if (settled || datagram.length < 2) return;
        // Only STUN-shaped datagrams belong to this phase (top 2 bits of the
        // first byte are 0 per RFC 5389) — DTLS/RTP can't arrive yet since we
        // haven't started DTLS, but be defensive rather than assume that.
        if ((datagram[0] & 0xc0) !== 0) return;
        const info = parseStunResponse(datagram);
        if (info && info.method === 'binding' && (info.isSuccess || info.isError)) {
          settled = true;
          clearTimeout(timer);
          socket.removeListener('message', onMessage);
          this.logger.debug('ice binding response', {
            connectionId: relayInfo.id,
            class: info.stunClass,
            errorCode: info.errorCode
          });
          resolve(info.isSuccess);
        }
      };
      socket.on('message', onMessage);

      const sendAttempt = () => {
        if (settled) return;
        if (attempt >= CONFIG.ICE_BINDING_TIMEOUTS_MS.length) {
          settled = true;
          socket.removeListener('message', onMessage);
          this.logger.debug('ice binding got no response, proceeding to dtls anyway', {
            connectionId: relayInfo.id
          });
          resolve(false);
          return;
        }
        const packet = buildBindingRequest(username, hmacKey, undefined, { iceRole: 'controlling' });
        try {
          socket.send(packet, relayInfo.port, relayInfo.ip);
        } catch (err) {
          this.logger.trace('ice binding send failed', { connectionId: relayInfo.id, message: toError(err).message });
        }
        const wait = CONFIG.ICE_BINDING_TIMEOUTS_MS[attempt];
        attempt += 1;
        timer = setTimeout(sendAttempt, wait);
      };
      sendAttempt();
    });
  }

  /** See the comment at its call site in connect() — keeps plain (pre-DTLS-
   * layer) Binding Requests going on this same UDP socket for as long as the
   * connection is still being established, on the chance the relay expects
   * ongoing consent freshness rather than a single check. Stops itself once
   * the connection opens, fails, or is torn down. Fire-and-forget: unlike
   * performIceBinding, nothing here blocks DTLS/SCTP from proceeding in
   * parallel — this is just trying to keep whatever "permission" the first
   * successful Binding granted from lapsing while they do. */
  startIceConsentRefresh(socket, relayInfo, conn) {
    const iceUfrag = relayInfo.authToken || relayInfo.token || '';
    const icePwd = relayInfo.key || '';
    // Same fix as performIceBinding: PEER-ufrag:LOCAL-ufrag, not the same
    // value twice.
    const username = TEXT_ENCODER.encode(`${iceUfrag}:${conn.localUfrag}`);
    const hmacKey = TEXT_ENCODER.encode(icePwd);
    if (conn.iceConsentTimer) clearInterval(conn.iceConsentTimer);
    conn.iceConsentTimer = setInterval(() => {
      if (conn.state === ConnectionState.Open) {
        // The relay's own encrypted-channel keepalive (startKeepalive) takes
        // over from here — no need for both.
        clearInterval(conn.iceConsentTimer);
        conn.iceConsentTimer = null;
        return;
      }
      if (conn.state === ConnectionState.Failed || conn.state === ConnectionState.Closed || !conn.socket) {
        clearInterval(conn.iceConsentTimer);
        conn.iceConsentTimer = null;
        return;
      }
      try {
        const packet = buildBindingRequest(username, hmacKey, undefined, { iceRole: 'controlling' });
        socket.send(packet, relayInfo.port, relayInfo.ip);
      } catch (err) {
        this.logger.trace('ice consent refresh send failed', { connectionId: relayInfo.id, message: toError(err).message });
      }
    }, CONFIG.ICE_CONSENT_REFRESH_MS);
  }

  connect = async (conn) => {
    this.closePeerObjects(conn);
    conn.state = ConnectionState.Connecting;
    const relayInfo = conn.relayInfo;
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      conn.socket = socket;
      const targetIp = relayInfo.ip;
      const targetPort = relayInfo.port;

      let settledConn = false;
      const settle = (err) => {
        if (settledConn) return;
        settledConn = true;
        if (conn.connectionTimeout) {
          clearTimeout(conn.connectionTimeout);
          conn.connectionTimeout = null;
        }
        if (err) {
          conn.state = ConnectionState.Failed;
          this.closePeerObjects(conn);
          reject(err);
        } else {
          resolve();
        }
      };

      const connLogger = this.logger.child?.({ connectionId: relayInfo.id }) ?? this.logger;

      const dtls = new DtlsClient({
        sendDatagram: (datagram) => {
          try { socket.send(datagram, targetPort, targetIp); } catch { /* socket may already be closing */ }
        },
        logger: connLogger
      });
      conn.dtlsClient = dtls;

      const dc = new PreNegotiatedDataChannel({
        sendDtlsPayload: (plaintext) => {
          if (!dtls.isConnected) return;
          const record = dtls.encryptApplicationData(plaintext);
          try { socket.send(record, targetPort, targetIp); } catch { /* socket may already be closing */ }
        },
        logger: connLogger
      });
      conn.dataChannel = dc;

      // performIceBinding installs (and removes) its own temporary listener
      // for the pre-DTLS phase; this one only starts acting once that phase
      // hands off, so the two never fight over the same datagrams.
      let iceBindingDone = false;
      socket.on('message', (datagram) => {
        if (!iceBindingDone) return;
        // startIceConsentRefresh keeps sending plain STUN Binding Requests on
        // this same socket after this point (see its call site above), so
        // any reply to those needs to be filtered out here too — otherwise a
        // legitimate STUN Binding Success arriving while DTLS is also live
        // would get fed into dtls.handleDatagram/decryptApplicationData as
        // if it were a DTLS record, which it isn't.
        //
        // FOUND A BUG: this used to be `(datagram[0] & 0xc0) === 0` to detect
        // "STUN-shaped, skip it". That's wrong — DTLS records (ContentType
        // 20-23: change_cipher_spec/alert/handshake/application_data) ALSO
        // have their top 2 bits zeroed (20 = 0b00010100, ..., 23 =
        // 0b00010111), so that check matched STUN *and* every real DTLS
        // record equally. Every HelloVerifyRequest/ServerHello/Finished the
        // relay ever sent back was getting silently dropped right here,
        // which is exactly why the handshake would hang at "starting dtls
        // (client role)" and never advance until the 20s relay-connect
        // timeout fired — dtls.handleDatagram() was never being called with
        // the response at all, so there was nothing for it to log or error
        // on. Demux the two properly instead (RFC 7983 §7): DTLS's
        // ContentType byte only ever falls in 20-63; STUN's leading byte is
        // 0-3. Checking for the DTLS range (and letting anything outside it,
        // STUN included, fall through to "skip") is the precise version of
        // the same idea.
        const isDtlsRecord = datagram.length >= 1 && datagram[0] >= 20 && datagram[0] <= 63;
        if (!isDtlsRecord) {
          return;
        }
        if (dtls.isConnected) {
          const payloads = dtls.decryptApplicationData(datagram);
          for (const payload of payloads) dc.handleDtlsPayload(payload);
        } else {
          // Defensive try/catch: handleDatagram parses whatever arrives
          // against the state it's in, and a malformed or out-of-order
          // datagram shouldn't be able to throw synchronously out of this
          // event handler and crash the whole worker process.
          try {
            dtls.handleDatagram(datagram);
          } catch (err) {
            this.logger.trace('handleDatagram threw', {
              connectionId: relayInfo.id, message: toError(err).message
            });
          }
        }
      });
      socket.on('error', (err) => settle(err instanceof Error ? err : new Error(String(err))));

      dtls.on('connected', () => {
        this.logger.debug('dtls handshake complete', { connectionId: relayInfo.id });
        dc.start();
      });
      dtls.on('error', (err) => {
        this.logger.debug('dtls error', { connectionId: relayInfo.id, message: toError(err).message });
        settle(err);
      });
      dc.on('open', () => {
        this.logger.debug('datachannel open', { connectionId: relayInfo.id });
        conn.state = ConnectionState.Open;
        this.flushBufferedPackets(conn);
        this.startKeepalive(conn);
        this.sendStunAllocateOnOpen(conn, relayInfo);
        this.stats.connected++;
        this.emit('relay_connected', { ip: relayInfo.ip, port: relayInfo.port });
        settle(null);
      });
      dc.on('error', (err) => {
        this.logger.debug('datachannel error', { connectionId: relayInfo.id, message: toError(err).message });
        settle(err);
      });
      dc.on('message', (payload) => {
        conn.stats.receivedPackets++;
        conn.stats.receivedBytes += byteLengthOf(payload);
        this.stats.received++;
        this.emit('relay_receive', { ip: relayInfo.ip, port: relayInfo.port, data: payload });
      });

      conn.connectionTimeout = setTimeout(() => {
        settle(new Error(`relay connect timed out after ${CONFIG.CONNECTION_TIMEOUT_MS}ms`));
      }, CONFIG.CONNECTION_TIMEOUT_MS);

      socket.bind(0, async () => {
        this.logger.debug('udp socket bound, starting dtls (client role)', { connectionId: relayInfo.id });
        // REMOVED the pre-DTLS ICE Binding phase (performIceBinding +
        // startIceConsentRefresh, both still defined below, just unused —
        // reinstate the two commented calls a few lines up if this turns
        // out to be wrong) that used to run here. It was added because,
        // at the time, SCTP INIT got no response at all without it — but
        // that turned out to be the SCTP checksum bug (buildPacket/
        // parsePacketHeader writing the checksum field big-endian instead
        // of little-endian; see wire.js), fixed separately and BEFORE this
        // change. With that actually fixed, meowcaller's own reference
        // (engine_media.go's connectAndAllocate, cross-checked against a
        // real packet capture — see its comment: "matches the working
        // capture exactly — allocate+ping every second, NO STUN
        // binding-requests at all") goes straight from UDP bind to DTLS,
        // with zero ICE binding of any kind, for exactly this same relay
        // protocol. It's explicit that Binding Requests are actively
        // harmful here, not just unnecessary: "Binding-requests instead
        // flip the relay into ICE-consent mode and the bridge never
        // forms" — which fits this project's own prior symptom exactly:
        // transport (DTLS+SCTP+DataChannel) fully succeeded WITH binding
        // present, hundreds of packets sent, but the peer's WhatsApp app
        // received partial video and zero audio — consistent with the
        // relay accepting the connection but never actually bridging it
        // to the real participant because it was stuck treating the
        // session as ICE-consent rather than a plain WASM relay client.
        iceBindingDone = true;
        // await this.performIceBinding(socket, relayInfo, conn);
        // this.startIceConsentRefresh(socket, relayInfo, conn);
        dtls.start();
      });
    });
  };

  /** Called by WaCallMediaSession when the peer's actual SSRC differs from
   * the one we predicted — was entirely missing from this class (the
   * "resendSubscriptions is not a function" error), so that resubscribe path
   * silently failed every time instead of re-registering the corrected SSRC
   * with the relay, which is consistent with calls connecting but then
   * dropping into "Reconnecting..." shortly after. */
  resendSubscriptions() {
    for (const [, conn] of this.connections) {
      if (conn.state === ConnectionState.Open && conn.dataChannel) {
        this.sendStunAllocateOnOpen(conn, conn.relayInfo);
        this.logger.debug('manual relay subscriptions resent', { connectionId: conn.relayInfo.id });
      }
    }
  }

  /** Mirrors meowcaller's connectAndAllocate + its 1s keepalive ticker
   * exactly: build ONE Allocate packet (0x4000 relay token + 0x4024 stream
   * descriptors for the 9-slot array — see createWasmStreamDescriptors — +
   * 0x0016 relay endpoint), send it once here, then resend those exact
   * cached bytes every second alongside the WhatsApp ping from
   * startKeepalive (not rebuilt each time — SendCurrent in the reference
   * resends the same packet verbatim). No STUN Binding Request anywhere in
   * this path; see the comment where performIceBinding's call was removed
   * for why. */
  sendStunAllocateOnOpen(conn, relayInfo) {
    const connectionId = relayInfo.id;
    if (!relayInfo.rawToken || relayInfo.rawToken.length === 0) {
      this.logger.debug('allocate skipped, no relay token', { connectionId });
      return;
    }
    if (!relayInfo.key) {
      this.logger.debug('allocate skipped, no relay key', { connectionId });
      return;
    }
    if (!this.audioSsrc) {
      this.logger.debug('allocate skipped, no ssrc yet', { connectionId });
      return;
    }
    const hmacKey = TEXT_ENCODER.encode(relayInfo.key);
    // 9-slot plan (crypto/ssrc.js WASM_RELAY_STREAM_SLOT_WORDS): index 0 =
    // word 0 = audio, index 3 = word 2 = video. The other 7 slots are
    // group-call auxiliary/simulcast layers this 1:1 path never populates.
    const streamSsrcs = [this.audioSsrc, 0, 0, this.videoSsrc || 0, 0, 0, 0, 0, 0];
    const descriptors = createWasmStreamDescriptors(streamSsrcs);
    const packet = buildAllocateForRelay(relayInfo.rawToken, descriptors, hmacKey, relayInfo.ip, relayInfo.port);
    conn.allocatePacket = toArrayBuffer(packet);
    this.sendToChannel(conn, conn.allocatePacket);
    this.logger.trace('allocate sent', { connectionId, size: packet.length });
  }

  sendToChannel(conn, data) {
    if (conn.state !== ConnectionState.Open || !conn.dataChannel) return;
    try {
      conn.dataChannel.send(data);
      conn.stats.sentPackets++;
      conn.stats.sentBytes += byteLengthOf(data);
      this.stats.sent++;
    } catch (err) {
      this.logger.trace('sendToChannel failed', { connectionId: conn.relayInfo.id, message: toError(err).message });
    }
  }

  closePeerObjects(conn) {
    if (conn.keepaliveTimer) {
      clearInterval(conn.keepaliveTimer);
      conn.keepaliveTimer = null;
    }
    if (conn.iceConsentTimer) {
      clearInterval(conn.iceConsentTimer);
      conn.iceConsentTimer = null;
    }
    try { conn.dataChannel?.close?.(); } catch (err) { this.logger.trace('datachannel close failed', { message: toError(err).message }); }
    try { conn.dtlsClient?.close?.(); } catch (err) { this.logger.trace('dtls close failed', { message: toError(err).message }); }
    try { conn.socket?.close?.(); } catch (err) { this.logger.trace('socket close failed', { message: toError(err).message }); }
    conn.socket = null;
    conn.dtlsClient = null;
    conn.dataChannel = null;
  }

  startKeepalive(conn) {
    if (conn.keepaliveTimer) clearInterval(conn.keepaliveTimer);
    conn.keepaliveTimer = setInterval(() => {
      if (conn.state !== ConnectionState.Open || !conn.dataChannel) return;
      // Matches meowcaller's own keepalive ticker exactly: resend the
      // cached allocate packet (verbatim, not rebuilt) + a fresh ping,
      // every ~1s — "matches the working capture exactly ... NO STUN
      // binding-requests at all".
      if (conn.allocatePacket) this.sendToChannel(conn, conn.allocatePacket);
      this.sendToChannel(conn, toArrayBuffer(buildWhatsAppPing()));
    }, CONFIG.KEEPALIVE_INTERVAL_MS);
  }

  flushBufferedPackets(conn) {
    while (conn.packetBuffer.length > 0) {
      const packet = conn.packetBuffer.shift();
      if (!packet) continue;
      conn.bufferedBytes -= byteLengthOf(packet);
      try {
        conn.dataChannel.send(packet);
        conn.stats.sentPackets++;
        conn.stats.sentBytes += byteLengthOf(packet);
        this.stats.sent++;
      } catch (err) {
        this.logger.trace('flush send failed', { connectionId: conn.relayInfo.id, message: toError(err).message });
      }
    }
  }

  bufferPacket(conn, packet) {
    const size = byteLengthOf(packet);
    if (size > CONFIG.MAX_BUFFER_SIZE) return false;
    while (conn.packetBuffer.length > 0 && conn.bufferedBytes + size > CONFIG.MAX_BUFFER_SIZE) {
      const dropped = conn.packetBuffer.shift();
      if (dropped) conn.bufferedBytes -= byteLengthOf(dropped);
    }
    conn.packetBuffer.push(packet);
    conn.bufferedBytes += size;
    return true;
  }

  sendToRelay(ip, port, data) {
    if (this.configuring) {
      this.globalBuffer.push({ ip, port, data });
      this.globalBufferedBytes += byteLengthOf(data);
      return;
    }
    for (const [, conn] of this.connections) {
      if (conn.relayInfo.ip !== ip || conn.relayInfo.port !== port) continue;
      if (conn.state === ConnectionState.Open && conn.dataChannel) {
        try {
          conn.dataChannel.send(data);
          conn.stats.sentPackets++;
          conn.stats.sentBytes += byteLengthOf(data);
          this.stats.sent++;
        } catch (err) {
          this.logger.trace('sendToRelay failed', { connectionId: conn.relayInfo.id, message: toError(err).message });
        }
      } else {
        this.bufferPacket(conn, data);
        void this.ensureConnection(conn.relayInfo);
      }
    }
  }

  /** Sends to every currently-open relay connection — audio and video both
   * use this (see WaCallMediaSession.js), matching WaSctpRelay's redundant
   * multi-relay send pattern. */
  broadcast(data) {
    let sentAny = false;
    for (const [, conn] of this.connections) {
      if (conn.state === ConnectionState.Open && conn.dataChannel) {
        try {
          conn.dataChannel.send(data);
          conn.stats.sentPackets++;
          conn.stats.sentBytes += byteLengthOf(data);
          this.stats.sent++;
          sentAny = true;
        } catch (err) {
          this.logger.trace('broadcast send failed', { connectionId: conn.relayInfo.id, message: toError(err).message });
        }
      }
    }
    return sentAny;
  }

  hasConnection() {
    for (const [, conn] of this.connections) {
      if (conn.state === ConnectionState.Open) return true;
    }
    return false;
  }

  /** Diagnostic: send-queue depth of the (single) open connection's SCTP
   * association, if any — see SctpAssociation.getSendBacklog(). */
  getSendBacklog() {
    for (const [, conn] of this.connections) {
      if (conn.state === ConnectionState.Open && conn.dataChannel) {
        return conn.dataChannel.getSendBacklog();
      }
    }
    return null;
  }

  getConnectedCount() {
    let count = 0;
    for (const [, conn] of this.connections) {
      if (conn.state === ConnectionState.Open) count++;
    }
    return count;
  }

  cleanup() {
    for (const [, conn] of this.connections) this.closePeerObjects(conn);
    this.connections.clear();
    this.relayMap.clear();
    this.globalBuffer = [];
    this.globalBufferedBytes = 0;
  }
}

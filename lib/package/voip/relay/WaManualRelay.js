import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { DtlsClient } from './dtls/handshake.js';
import { PreNegotiatedDataChannel } from './datachannel/pre-negotiated.js';
import { createNoopLogger } from '../shim/core.js';
import { toError } from '../shim/util.js';
import { TEXT_ENCODER, toArrayBuffer } from '../bytes.js';
import { buildAllocateForRelay, buildBindingRequest, buildRelayBindingSuccess, buildWhatsAppPing, createWasmStreamDescriptors, parseStunResponse } from './stun.js';
import { randomBytes } from 'node:crypto';
import { PayloadType } from '../types.js';

const CONFIG = {
  TRUE_WEB_CLIENT_RELAY_PORT: 3480,
  CONNECTION_TIMEOUT_MS: 20_000,

  ICE_BINDING_TIMEOUTS_MS: [250, 400, 600, 1000, 1500, 2000],
  KEEPALIVE_INTERVAL_MS: 1000,
  ICE_BINDING_ENABLED: false,
  ICE_CONSENT_REFRESH_ENABLED: false,
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
  streamSsrcs = null;
  rxStun = { bindReq: 0, bindAnswered: 0, allocOk: 0, allocErr: 0, pong: 0, other: 0 };
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

  setStreamSsrcs(streamSsrcs) {
    const out = Array.from(streamSsrcs, (v) => v >>> 0);
    const used = new Set(out.slice(0, 6).filter((v) => v !== 0));
    for (let i = 6; i < 9; i++) {
      for (let attempt = 0; attempt < 64; attempt++) {
        const candidate = randomBytes(4).readUInt32LE(0);
        if (candidate === 0 || used.has(candidate)) continue;
        out[i] = candidate;
        used.add(candidate);
        break;
      }
    }
    this.streamSsrcs = out;
  }

  getRxStunStats() {
    return { ...this.rxStun };
  }

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

  performIceBinding(socket, relayInfo, conn) {
    return new Promise((resolve) => {
      const iceUfrag = relayInfo.authToken || relayInfo.token || '';
      const icePwd = relayInfo.key || '';

      const username = TEXT_ENCODER.encode(`${iceUfrag}:${conn.localUfrag}`);
      const hmacKey = TEXT_ENCODER.encode(icePwd);
      let attempt = 0;
      let settled = false;
      let timer = null;

      const onMessage = (datagram) => {
        if (settled || datagram.length < 2) return;

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

  startIceConsentRefresh(socket, relayInfo, conn) {
    const iceUfrag = relayInfo.authToken || relayInfo.token || '';
    const icePwd = relayInfo.key || '';

    const username = TEXT_ENCODER.encode(`${iceUfrag}:${conn.localUfrag}`);
    const hmacKey = TEXT_ENCODER.encode(icePwd);
    if (conn.iceConsentTimer) clearInterval(conn.iceConsentTimer);
    conn.iceConsentTimer = setInterval(() => {
      if (conn.state !== ConnectionState.Open || !conn.socket) {
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
          try { socket.send(datagram, targetPort, targetIp); } catch {  }
        },
        logger: connLogger
      });
      conn.dtlsClient = dtls;

      const dc = new PreNegotiatedDataChannel({
        sendDtlsPayload: (plaintext) => {
          if (!dtls.isConnected) return;
          const record = dtls.encryptApplicationData(plaintext);
          try { socket.send(record, targetPort, targetIp); } catch {  }
        },
        logger: connLogger
      });
      conn.dataChannel = dc;

      let iceBindingDone = false;
      socket.on('message', (datagram) => {
        if (!iceBindingDone) {
          return;
        }

        const isDtlsRecord = datagram.length >= 1 && datagram[0] >= 20 && datagram[0] <= 63;
        if (!isDtlsRecord) {
          return;
        }
        if (dtls.isConnected) {
          const payloads = dtls.decryptApplicationData(datagram);
          for (const payload of payloads) dc.handleDtlsPayload(payload);
        } else {

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
        this.logger.warn('[RELAY] mode=meowcaller v3 ice_binding=off consent_refresh=off allocate_streams=' + (this.streamSsrcs ? 9 : 2), { connectionId: relayInfo.id });
        this.startKeepalive(conn);
        if (CONFIG.ICE_CONSENT_REFRESH_ENABLED) this.startIceConsentRefresh(socket, relayInfo, conn);
        this.sendStunAllocateOnOpen(conn, relayInfo);
        this.sendToChannel(conn, toArrayBuffer(buildWhatsAppPing()));
        this.stats.connected++;
        this.emit('relay_connected', { ip: relayInfo.ip, port: relayInfo.port });
        settle(null);
      });
      dc.on('error', (err) => {
        this.logger.debug('datachannel error', { connectionId: relayInfo.id, message: toError(err).message });
        settle(err);
      });
      dc.on('message', (payload) => {
        this.handleRelayStun(conn, relayInfo, payload);
        conn.stats.receivedPackets++;
        conn.stats.receivedBytes += byteLengthOf(payload);
        this.stats.received++;
        this.emit('relay_receive', { ip: relayInfo.ip, port: relayInfo.port, data: payload });
      });

      conn.connectionTimeout = setTimeout(() => {
        settle(new Error(`relay connect timed out after ${CONFIG.CONNECTION_TIMEOUT_MS}ms`));
      }, CONFIG.CONNECTION_TIMEOUT_MS);

      socket.bind(0, async () => {
        this.logger.warn('[DIAG] udp socket bound, starting ice binding check', {
            connectionId: relayInfo.id, localPort: socket.address().port
        });

        if (CONFIG.ICE_BINDING_ENABLED) {
          const bindingOk = await this.performIceBinding(socket, relayInfo, conn);
          if (settledConn) return;
          if (!bindingOk) {
            this.logger.debug('ice binding failed, aborting before dtls', { connectionId: relayInfo.id });
            settle(new Error('ICE binding to relay failed or timed out'));
            return;
          }
        }

        iceBindingDone = true;
        this.logger.debug('ice binding ok, starting dtls (client role)', { connectionId: relayInfo.id });
        dtls.start();
      });
    });
  };

  resendSubscriptions() {
    for (const [, conn] of this.connections) {
      if (conn.state === ConnectionState.Open && conn.dataChannel) {
        this.sendStunAllocateOnOpen(conn, conn.relayInfo);
        this.logger.debug('manual relay subscriptions resent', { connectionId: conn.relayInfo.id });
      }
    }
  }

  handleRelayStun(conn, relayInfo, payload) {
    const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    if (data.length < 20 || (data[0] & 0xc0) !== 0) return;
    const type = (data[0] << 8) | data[1];
    const cookie = ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
    if (cookie !== 0x2112a442 && type !== 0x0802) return;
    if (type === 0x0001) {
      this.rxStun.bindReq++;
      if (!relayInfo.key) return;
      try {
        const response = buildRelayBindingSuccess(data.slice(8, 20), TEXT_ENCODER.encode(relayInfo.key));
        this.sendToChannel(conn, toArrayBuffer(response));
        this.rxStun.bindAnswered++;
      }
      catch (err) {
        this.logger.warn('[RELAY] binding success send failed', { message: toError(err).message });
      }
    }
    else if (type === 0x0103) {
      if (this.rxStun.allocOk++ === 0) this.logger.warn('[RELAY] allocate success from relay', { connectionId: relayInfo.id });
    }
    else if (type === 0x0113 || type === 0x0111) {
      if (this.rxStun.allocErr++ === 0) this.logger.warn('[RELAY] allocate/binding ERROR from relay', { connectionId: relayInfo.id, type: '0x' + type.toString(16), bytes: data.length });
    }
    else if (type === 0x0802) {
      this.rxStun.pong++;
    }
    else {
      this.rxStun.other++;
    }
  }

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

    const streamSsrcs = this.streamSsrcs
      ? [...this.streamSsrcs]
      : [this.audioSsrc, 0, 0, this.videoSsrc || 0, 0, 0, 0, 0, 0];
    streamSsrcs[0] = this.audioSsrc;
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

  broadcast(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const isAudio = bytes.length < 2 || (bytes[1] & 0x7f) !== PayloadType.H264;
    let sentAny = false;
    for (const [, conn] of this.connections) {
      if (conn.state === ConnectionState.Open && conn.dataChannel) {
        try {
          conn.dataChannel.send(data, isAudio);
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

  getSendBacklog() {
    for (const [, conn] of this.connections) {
      if (conn.state === ConnectionState.Open && conn.dataChannel) {
        return conn.dataChannel.getSendBacklog();
      }
    }
    return null;
  }

  getVideoFlushCount() {
    let total = 0;
    for (const [, conn] of this.connections) {
      const backlog = conn.dataChannel?.getSendBacklog?.();
      if (backlog) total += backlog.videoFlushes ?? 0;
    }
    return total;
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

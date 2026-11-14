import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { DtlsClient } from './dtls/handshake.js';
import { PreNegotiatedDataChannel } from './datachannel/pre-negotiated.js';
import { createNoopLogger } from '../shim/core.js';
import { toError } from '../shim/util.js';
import { TEXT_ENCODER, toArrayBuffer } from '../bytes.js';
import { buildAllocateForRelay, buildBindingRequest, buildBindingRequestWithSubs, buildRelayBindingSuccess, buildSenderSubscriptions, buildSSRCSubscriptionList, buildWhatsAppPing, createWasmStreamDescriptors, parseRelayedAddressMismatch, parseStunResponse } from './stun.js';
import { randomBytes } from '../crypto/primitives.js';
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
  rejectedModes = new Set();
  answeredRelayNames = new Set();
  maxActiveRelays = 3;
  logger;
  connections = new Map();
  relayMap = new Map();
  standbyRelays = [];
  failedRelays = new Set();
  audioSsrc = 0;
  videoSsrc = 0;
  subscriptionSsrc = 0;
  streamSsrcs = null;
  selfPid = 0;
  peerPid = 0;
  rxStun = { bindReq: 0, bindAnswered: 0, allocOk: 0, allocErr: 0, pong: 0, other: 0 };
  configuring = false;
  globalBuffer = [];
  globalBufferedBytes = 0;
  stats = { sent: 0, received: 0, connected: 0 };
  retrySchedule = [1000, 2000, 4000];
  transports = ['dtls', 'raw'];

  constructor(options = {}) {
    super();
    this.logger = options.logger ?? createNoopLogger();
    this.transports = options.transports ?? this.transports;
    this.maxActiveRelays = options.maxActiveRelays ?? this.maxActiveRelays;
  }

  setSsrc(ssrc) {
    this.audioSsrc = ssrc;
  }

  setParticipantIds(selfPid, peerPid) {
    this.selfPid = selfPid ?? 0;
    this.peerPid = peerPid ?? 0;
  }

  getRxStunStats() {
    return { ...this.rxStun };
  }

  setVideoSsrc(ssrc) {
    this.videoSsrc = ssrc;
  }

  setStreamSsrcs(ssrcs) {
    this.streamSsrcs = ssrcs;
  }

  setSubscriptionSsrc(ssrc) {
    this.subscriptionSsrc = ssrc;
  }

  makeConnectionId(ip, port, authTokenId) {
    const base = ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`;
    return authTokenId ? `${base}#${authTokenId}` : base;
  }

  toRelayInfo(relay) {
    const port = relay.port || CONFIG.TRUE_WEB_CLIENT_RELAY_PORT;
    return {
      id: this.makeConnectionId(relay.ip, port, relay.authTokenId),
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
      isFna: relay.isFna,
      fallbackPort: port === CONFIG.TRUE_WEB_CLIENT_RELAY_PORT ? 3478 : CONFIG.TRUE_WEB_CLIENT_RELAY_PORT
    };
  }

  async configureRelays(relays) {
    this.configuring = true;
    const infos = relays.map((relay) => this.toRelayInfo(relay)).filter((info) => !this.failedRelays.has(info.id));
    for (const info of infos) {
      if (this.relayMap.has(info.id)) {
        this.relayMap.set(info.id, info);
      }
      else if (this.relayMap.size < this.maxActiveRelays) {
        this.relayMap.set(info.id, info);
      }
    }
    this.standbyRelays = infos.filter((info) => !this.relayMap.has(info.id));
    const connectionPromises = [];
    for (const [, relayInfo] of this.relayMap) {
      if (!this.connections.has(relayInfo.id)) {
        connectionPromises.push(this.ensureConnection(relayInfo));
      }
    }
    if (connectionPromises.length > 0) {
      const settled = connectionPromises.map((promise) => promise.catch(() => {}));
      const firstOpen = new Promise((resolve) => {
        for (const promise of settled) {
          promise.then(() => {
            if (this.hasConnection()) resolve();
          });
        }
      });
      await Promise.race([Promise.all(settled), firstOpen]);
    }
    this.configuring = false;
    if (this.globalBuffer.length > 0) {
      for (const item of this.globalBuffer) this.sendToRelay(item.ip, item.port, item.data);
      this.globalBuffer = [];
      this.globalBufferedBytes = 0;
    }
  }

  buildRoutes(relayInfo) {
    const ports = [relayInfo.port];
    if (relayInfo.fallbackPort !== undefined && relayInfo.fallbackPort !== relayInfo.port) {
      ports.push(relayInfo.fallbackPort);
    }
    const routes = [];
    const preferRaw = !relayInfo.authToken && this.transports.includes('raw');
    const rank = (mode) => (this.rejectedModes.has(`${relayInfo.ip}|${mode}`) ? 2 : 0) + (preferRaw && mode !== 'raw' ? 1 : 0);
    const modes = [...this.transports].sort((a, b) => rank(a) - rank(b));
    for (const mode of modes) {
      for (const port of ports) {
        routes.push({ mode, port });
      }
    }
    if (routes.length === 0) {
      routes.push({ mode: 'dtls', port: relayInfo.port });
    }
    return routes;
  }

  applyRoute(conn, index) {
    const route = conn.routes[index];
    conn.routeIndex = index;
    conn.mode = route.mode;
    conn.dialPort = route.port;
    conn.returnPathSeen = false;
    this.restartAllocateLadder(conn);
  }

  restartAllocateLadder(conn) {
    conn.allocateStage = 0;
    conn.allocateLocked = false;
    conn.allocateExhausted = false;
    conn.allocateCandidates = null;
    conn.allocateAttempts.clear();
    conn.allocatePacket = null;
    conn.proven = false;
    conn.refused = false;
    conn.allocateResponses = 0;
    conn.stunTransactionId = randomBytes(12);
  }

  advanceRoute(conn, reason, targetIndex = conn.routeIndex + 1) {
    if (targetIndex >= conn.routes.length) {
      return false;
    }
    const from = conn.routes[conn.routeIndex];
    this.applyRoute(conn, targetIndex);
    this.logger.warn('[RELAY] switching relay route', { connectionId: conn.relayInfo.id, reason, from, to: conn.routes[conn.routeIndex] });
    this.closePeerObjects(conn);
    conn.state = ConnectionState.Closed;
    return true;
  }

  getOrCreateConnection(relayInfo) {
    let conn = this.connections.get(relayInfo.id);
    if (!conn) {
      const routes = this.buildRoutes(relayInfo);
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
        retryTimer: null,
        retryCount: 0,
        recovering: false,
        lastInboundAt: 0,
        localUfrag: randomUfrag(),
        stunTransactionId: randomBytes(12),
        routes,
        routeIndex: 0,
        mode: routes[0].mode,
        dialPort: routes[0].port,
        fallbackTimer: null,
        answered: false,
        keepaliveTicks: 0,
        allocateStage: 0,
        allocateLocked: false,
        allocateExhausted: false,
        allocateCandidates: null,
        allocateRounds: 0,
        returnPathSeen: false,
        proven: false,
        refused: false,
        allocateResponses: 0,
        openedAt: 0,
        allocateAttempts: new Map(),
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
    let failed = false;
    try {
      await promise;
    } catch {
      failed = true;
    } finally {
      conn.connectPromise = null;
    }
    if (failed && this.advanceRoute(conn, 'connect_failed')) {
      await this.ensureConnection(relayInfo);
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
          resolve(info.isSuccess);
        }
      };
      socket.on('message', onMessage);

      const sendAttempt = () => {
        if (settled) return;
        if (attempt >= CONFIG.ICE_BINDING_TIMEOUTS_MS.length) {
          settled = true;
          socket.removeListener('message', onMessage);
          resolve(false);
          return;
        }
        const packet = buildBindingRequest(username, hmacKey, undefined, { iceRole: 'controlling', transactionId: conn.stunTransactionId });
        try {
          socket.send(packet, conn.dialPort, relayInfo.ip);
        } catch { }
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
        socket.send(packet, conn.dialPort, relayInfo.ip);
      } catch { }
    }, CONFIG.ICE_CONSENT_REFRESH_MS);
  }

  connect = async (conn) => {
    this.closePeerObjects(conn);
    conn.state = ConnectionState.Connecting;
    conn.answered = false;
    const relayInfo = conn.relayInfo;
    const targetIp = relayInfo.ip;
    const targetPort = conn.dialPort;
    const dtlsRoute = conn.mode === 'dtls';
    const timeoutMs = dtlsRoute ? 6000 : CONFIG.CONNECTION_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      conn.socket = socket;

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

      const receive = (payload) => {
        if (conn.socket !== socket) return;
        conn.lastInboundAt = Date.now();
        conn.answered = true;
        const view = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
        if (!conn.returnPathSeen && view.length > 0 && (view[0] & 0xc0) !== 0) {
          conn.returnPathSeen = true;
          this.logger.info('[RELAY] return media confirmed', { connectionId: relayInfo.id, mode: conn.mode, port: conn.dialPort, bytes: view.length });
          this.markRelayProven(conn, 'media');
        }
        this.handleRelayStun(conn, relayInfo, payload);
        conn.stats.receivedPackets++;
        conn.stats.receivedBytes += byteLengthOf(payload);
        this.stats.received++;
        this.emit('relay_receive', { ip: relayInfo.ip, port: relayInfo.port, data: payload });
      };

      socket.on('error', (err) => {
        if (conn.state === ConnectionState.Open) this.handleRelayLoss(conn);
        settle(err instanceof Error ? err : new Error(String(err)));
      });

      conn.connectionTimeout = setTimeout(() => {
        settle(new Error(`relay connect timed out after ${timeoutMs}ms (${conn.mode} ${targetIp}:${targetPort})`));
      }, timeoutMs);

      if (!dtlsRoute) {
        socket.on('message', (datagram) => {
          receive(new Uint8Array(datagram.buffer, datagram.byteOffset, datagram.byteLength));
        });
        socket.connect(targetPort, targetIp, (err) => {
          if (settledConn) return;
          if (err) {
            settle(err);
            return;
          }
          conn.dataChannel = {
            send: (data) => {
              socket.send(Buffer.from(data));
            },
            getSendBacklog: () => 0,
            close: () => {}
          };
          this.handleChannelOpen(conn, relayInfo, socket, settle);
        });
        return;
      }

      const connLogger = this.logger.child?.({ connectionId: relayInfo.id }) ?? this.logger;

      const dtls = new DtlsClient({
        sendDatagram: (datagram) => {
          try { socket.send(datagram, targetPort, targetIp); } catch { }
        },
        logger: connLogger
      });
      conn.dtlsClient = dtls;

      const dc = new PreNegotiatedDataChannel({
        sendDtlsPayload: (plaintext) => {
          if (!dtls.isConnected) return;
          const record = dtls.encryptApplicationData(plaintext);
          try { socket.send(record, targetPort, targetIp); } catch { }
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
          } catch { }
        }
      });

      dtls.on('connected', () => {
        this.logger.info('[RELAY] dtls connected', { connectionId: relayInfo.id, port: targetPort });
        dc.start();
      });
      dtls.on('error', (err) => {
        settle(err);
      });
      dc.on('open', () => {
        this.handleChannelOpen(conn, relayInfo, socket, settle);
      });
      dc.on('error', (err) => {
        settle(err);
      });
      dc.on('message', receive);

      socket.bind(0, async () => {
        if (CONFIG.ICE_BINDING_ENABLED) {
          const bindingOk = await this.performIceBinding(socket, relayInfo, conn);
          if (settledConn) return;
          if (!bindingOk) {
            settle(new Error('ICE binding to relay failed or timed out'));
            return;
          }
        }
        iceBindingDone = true;
        dtls.start();
      });
    });
  };

  handleChannelOpen(conn, relayInfo, socket, settle) {
    if (conn.socket !== socket) return;
    if (conn.allocateLocked || conn.allocateExhausted || conn.proven || conn.refused) {
      this.restartAllocateLadder(conn);
    }
    conn.state = ConnectionState.Open;
    conn.answered = false;
    conn.openedAt = Date.now();
    this.flushBufferedPackets(conn);
    conn.lastInboundAt = Date.now();
    this.logger.info('[RELAY] channel open', { connectionId: relayInfo.id, mode: conn.mode, port: conn.dialPort, hasAuthToken: Boolean(relayInfo.authToken) });
    this.startKeepalive(conn);
    this.armRouteFallback(conn);
    if (conn.mode === 'dtls' && CONFIG.ICE_CONSENT_REFRESH_ENABLED) this.startIceConsentRefresh(socket, relayInfo, conn);
    this.sendStunAllocateOnOpen(conn, relayInfo);
    for (const delayMs of [50, 150, 500, 3000]) setTimeout(() => this.sendStunAllocateOnOpen(conn, conn.relayInfo), delayMs);
    this.sendToChannel(conn, toArrayBuffer(buildWhatsAppPing(conn.stunTransactionId)));
    this.stats.connected++;
    const wasRecovering = conn.recovering;
    if (wasRecovering) {
      conn.recovering = false;
      conn.retryCount = 0;
    }
    this.emit('relay_connected', { ip: relayInfo.ip, port: relayInfo.port });
    if (wasRecovering) this.emit('relay_recovered', { connectionId: relayInfo.id });
    settle(null);
  }

  armRouteFallback(conn) {
    if (conn.fallbackTimer) {
      clearTimeout(conn.fallbackTimer);
      conn.fallbackTimer = null;
    }
    if (conn.routeIndex + 1 >= conn.routes.length) {
      return;
    }
    const socket = conn.socket;
    conn.fallbackTimer = setTimeout(() => {
      conn.fallbackTimer = null;
      if (conn.socket !== socket || conn.state !== ConnectionState.Open || conn.answered) {
        return;
      }
      if (this.advanceRoute(conn, 'relay_unanswered')) {
        void this.ensureConnection(conn.relayInfo);
      }
    }, 4000);
    conn.fallbackTimer.unref?.();
  }

  resendSubscriptions() {
    for (const [, conn] of this.connections) {
      if (conn.state === ConnectionState.Open && conn.dataChannel) {
        if (conn.allocateExhausted) this.restartAllocateLadder(conn);
        this.sendStunAllocateOnOpen(conn, conn.relayInfo);
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
      this.rxStun.allocOk++;
      conn.allocateResponses++;
      this.lockAllocateForm(conn, data);
    }
    else if (type === 0x0113 || type === 0x0111) {
      const errorInfo = parseStunResponse(data);
      conn.allocateResponses++;
      if (this.rxStun.allocErr++ === 0) {
        this.logger.warn('[RELAY] allocate/binding ERROR from relay', { connectionId: relayInfo.id, type: '0x' + type.toString(16), bytes: data.length, errorCode: errorInfo?.errorCode, errorReason: errorInfo?.errorReason, hex: Buffer.from(data).toString('hex') });
      }
      if (type === 0x0113 && errorInfo?.errorCode === 452) {
        if (!conn.allocateLocked) conn.refused = true;
        this.advanceAllocateForm(conn, relayInfo, data, errorInfo);
      }
    }
    else if (type === 0x0802) {
      this.rxStun.pong++;
    }
    else {
      this.rxStun.other++;
    }
  }

  sendStunAllocateOnOpen(conn, relayInfo) {
    if (!relayInfo.key) {
      return;
    }
    const ssrc = this.subscriptionSsrc || this.audioSsrc;
    if (!ssrc) {
      return;
    }
    if (conn.mode === 'dtls') {
      this.sendBindingRegistrations(conn, relayInfo, ssrc);
    }
    this.sendAllocate(conn, relayInfo);
  }

  sendBindingRegistrations(conn, relayInfo, ssrc) {
    const hmacKey = TEXT_ENCODER.encode(relayInfo.key);
    const subs = buildSenderSubscriptions(ssrc);
    const remoteUfrag = relayInfo.authToken || relayInfo.token;
    if (remoteUfrag) {
      const username = TEXT_ENCODER.encode(`${remoteUfrag}:${conn.localUfrag}`);
      this.sendToChannel(conn, toArrayBuffer(buildBindingRequestWithSubs(username, hmacKey, subs, true, true, conn.stunTransactionId)));
    }
    if (relayInfo.token && relayInfo.token !== remoteUfrag) {
      const username = TEXT_ENCODER.encode(`${relayInfo.token}:${conn.localUfrag}`);
      this.sendToChannel(conn, toArrayBuffer(buildBindingRequestWithSubs(username, hmacKey, subs, true, true, conn.stunTransactionId)));
    }
    this.sendToChannel(conn, toArrayBuffer(buildBindingRequestWithSubs(undefined, undefined, subs, false, false, conn.stunTransactionId)));
  }

  resolveRelayTarget(conn, relayInfo) {
    const dialed = { ip: relayInfo.ip, port: conn.dialPort ?? relayInfo.port };
    if (conn.mode === 'dtls') {
      return dialed;
    }
    try {
      const remote = conn.socket?.remoteAddress();
      if (remote?.address && remote.port) {
        return { ip: remote.address, port: remote.port };
      }
    }
    catch (err) {
      this.logger.debug('[RELAY] remote address unavailable', { message: toError(err).message });
    }
    return dialed;
  }

  getAllocateCandidates(conn, relayInfo) {
    if (conn.allocateCandidates) {
      return conn.allocateCandidates;
    }
    const target = this.resolveRelayTarget(conn, relayInfo);
    const ports = [target.port, relayInfo.port, conn.dialPort, relayInfo.fallbackPort].filter((port, index, all) => Number.isInteger(port) && port > 0 && all.indexOf(port) === index);
    const candidates = ports.map((port) => ({ form: 'exact', ip: target.ip, port }));
    candidates.push({ form: 'mapped', ip: target.ip, port: ports[0] });
    candidates.push({ form: 'none', ip: target.ip, port: ports[0] });
    conn.allocateCandidates = candidates;
    return candidates;
  }

  lockAllocateForm(conn, data) {
    if (conn.allocateLocked) {
      return;
    }
    const attempt = conn.allocateAttempts.get(Buffer.from(data.subarray(8, 20)).toString('hex'));
    if (attempt) {
      conn.allocateStage = attempt.stage;
      conn.stunTransactionId = attempt.transactionId;
    }
    conn.allocateLocked = true;
    conn.allocateExhausted = false;
    conn.refused = false;
    this.rejectedModes.delete(`${conn.relayInfo.ip}|${conn.mode}`);
    this.logger.info('[RELAY] allocate accepted', { connectionId: conn.relayInfo.id, route: { mode: conn.mode, port: conn.dialPort }, relayedAddress: attempt?.candidate ?? null });
    this.markRelayProven(conn, 'allocate');
  }

  markRelayProven(conn, via) {
    if (conn.proven) {
      return;
    }
    conn.proven = true;
    const relayInfo = conn.relayInfo;
    this.logger.info('[RELAY] relay proven', { connectionId: relayInfo.id, via });
    if (this.answeredRelayNames.has(relayInfo.name)) {
      return;
    }
    this.answeredRelayNames.add(relayInfo.name);
    this.emit('relay_answered', { name: relayInfo.name, ip: relayInfo.ip, port: relayInfo.port, rttMs: conn.openedAt ? Date.now() - conn.openedAt : undefined });
  }

  advanceAllocateForm(conn, relayInfo, data, errorInfo) {
    if (conn.allocateLocked || conn.allocateExhausted) {
      return;
    }
    const attempt = conn.allocateAttempts.get(Buffer.from(data.subarray(8, 20)).toString('hex'));
    if (!attempt || attempt.stage !== conn.allocateStage) {
      return;
    }
    const candidates = this.getAllocateCandidates(conn, relayInfo);
    const mismatch = parseRelayedAddressMismatch(errorInfo?.errorReason);
    const learned = mismatch?.relay;
    if (learned && !candidates.some((entry) => entry.form === 'exact' && entry.ip === learned.ip && entry.port === learned.port)) {
      candidates.splice(conn.allocateStage + 1, 0, { form: 'exact', ip: learned.ip, port: learned.port });
    }
    const echoedSame = Boolean(mismatch?.destination && mismatch?.relay && mismatch.destination.ip === mismatch.relay.ip && mismatch.destination.port === mismatch.relay.port);
    if (echoedSame || conn.allocateStage >= candidates.length - 1) {
      this.handleAllocateExhausted(conn, relayInfo, errorInfo);
      return;
    }
    this.logger.warn('[RELAY] relayed address rejected, trying next candidate', { connectionId: relayInfo.id, rejected: attempt.candidate, next: candidates[conn.allocateStage + 1], serverRead: mismatch?.destination ?? null, serverRelay: mismatch?.relay ?? null });
    conn.allocateStage++;
    conn.stunTransactionId = randomBytes(12);
    this.sendAllocate(conn, relayInfo);
  }

  handleAllocateExhausted(conn, relayInfo, errorInfo) {
    conn.allocateExhausted = true;
    conn.refused = true;
    conn.allocatePacket = null;
    this.logger.warn('[RELAY] every relayed address candidate was rejected', { connectionId: relayInfo.id, route: { mode: conn.mode, port: conn.dialPort }, errorReason: errorInfo?.errorReason });
    this.rejectedModes.add(`${relayInfo.ip}|${conn.mode}`);
    if (this.advanceRoute(conn, 'allocate_rejected')) {
      void this.ensureConnection(relayInfo);
      return;
    }
    if (this.activateStandbyRelay(conn)) {
      return;
    }
    if (conn.allocateRounds < 2) {
      conn.allocateRounds += 1;
      this.applyRoute(conn, 0);
      this.closePeerObjects(conn);
      conn.state = ConnectionState.Closed;
      conn.retryTimer = setTimeout(() => {
        conn.retryTimer = null;
        if (this.connections.get(relayInfo.id) !== conn) return;
        void this.ensureConnection(relayInfo);
      }, 3000 * conn.allocateRounds);
      conn.retryTimer.unref?.();
      return;
    }
    this.logger.error('[RELAY] allocate failed on every route and relay', { connectionId: relayInfo.id, rounds: conn.allocateRounds });
  }

  activateStandbyRelay(conn) {
    const next = this.standbyRelays.shift();
    if (!next) {
      return false;
    }
    const failedId = conn.relayInfo.id;
    this.failedRelays.add(failedId);
    this.relayMap.delete(failedId);
    this.connections.delete(failedId);
    if (conn.retryTimer) {
      clearTimeout(conn.retryTimer);
      conn.retryTimer = null;
    }
    this.closePeerObjects(conn);
    conn.state = ConnectionState.Failed;
    this.relayMap.set(next.id, next);
    this.logger.warn('[RELAY] switching to standby relay', { from: failedId, to: next.id });
    void this.ensureConnection(next);
    return true;
  }

  sendAllocate(conn, relayInfo) {
    if (conn.allocateExhausted) {
      return;
    }
    if (!relayInfo.rawToken || relayInfo.rawToken.length === 0 || !relayInfo.key || !this.audioSsrc) {
      return;
    }
    const candidates = this.getAllocateCandidates(conn, relayInfo);
    const candidate = candidates[Math.min(conn.allocateStage, candidates.length - 1)];
    const descriptors = this.streamSsrcs ? createWasmStreamDescriptors(this.streamSsrcs) : buildSSRCSubscriptionList([this.audioSsrc], [this.subscriptionSsrc], this.selfPid, this.peerPid);
    conn.allocatePacket = toArrayBuffer(buildAllocateForRelay(relayInfo.rawToken, descriptors, TEXT_ENCODER.encode(relayInfo.key), candidate.ip, candidate.port, conn.stunTransactionId, { relayedAddress: candidate.form }));
    const attemptKey = Buffer.from(conn.stunTransactionId).toString('hex');
    if (!conn.allocateAttempts.has(attemptKey)) {
      conn.allocateAttempts.set(attemptKey, { stage: conn.allocateStage, transactionId: conn.stunTransactionId, candidate });
    }
    this.sendToChannel(conn, conn.allocatePacket);
  }

  sendToChannel(conn, data) {
    if (conn.state !== ConnectionState.Open || !conn.dataChannel) return;
    try {
      conn.dataChannel.send(data);
      conn.stats.sentPackets++;
      conn.stats.sentBytes += byteLengthOf(data);
      this.stats.sent++;
    } catch { }
  }

  closePeerObjects(conn) {
    if (conn.fallbackTimer) {
      clearTimeout(conn.fallbackTimer);
      conn.fallbackTimer = null;
    }
    if (conn.keepaliveTimer) {
      clearInterval(conn.keepaliveTimer);
      conn.keepaliveTimer = null;
    }
    if (conn.iceConsentTimer) {
      clearInterval(conn.iceConsentTimer);
      conn.iceConsentTimer = null;
    }
    try { conn.dataChannel?.close?.(); } catch { }
    try { conn.dtlsClient?.close?.(); } catch { }
    try { conn.socket?.close?.(); } catch { }
    conn.socket = null;
    conn.dtlsClient = null;
    conn.dataChannel = null;
  }

  startKeepalive(conn) {
    if (conn.keepaliveTimer) clearInterval(conn.keepaliveTimer);
    conn.keepaliveTimer = setInterval(() => {
      if (conn.state !== ConnectionState.Open || !conn.dataChannel) return;
      if (Date.now() - conn.lastInboundAt > 15_000) {
        this.handleRelayLoss(conn);
        return;
      }

      if (!conn.proven && conn.answered && !conn.refused && conn.allocateResponses === 0 && Date.now() - conn.openedAt >= 3000) {
        this.markRelayProven(conn, 'answered');
      }
      conn.keepaliveTicks++;
      if (conn.keepaliveTicks % 5 === 0) {
        this.logger.info('[RELAY] status', { connectionId: conn.relayInfo.id, mode: conn.mode, port: conn.dialPort, answered: conn.answered, locked: conn.allocateLocked, sentPackets: conn.stats.sentPackets, receivedPackets: conn.stats.receivedPackets, rx: this.rxStun });
      }
      if (conn.allocatePacket) this.sendToChannel(conn, conn.allocatePacket);
      this.sendToChannel(conn, toArrayBuffer(buildWhatsAppPing(conn.stunTransactionId)));
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
      } catch { }
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
        } catch { }
      } else {
        this.bufferPacket(conn, data);
        if (!conn.recovering) void this.ensureConnection(conn.relayInfo);
      }
    }
  }

  pickMediaConnections() {
    const open = [];
    for (const [, conn] of this.connections) {
      if (conn.state === ConnectionState.Open && conn.dataChannel) open.push(conn);
    }
    const proven = open.filter((conn) => conn.proven);
    if (proven.length > 0) return proven;
    const viable = open.filter((conn) => !conn.refused);
    return viable.length > 0 ? viable : open;
  }

  broadcast(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const isAudio = bytes.length < 2 || (bytes[1] & 0x7f) !== PayloadType.H264;
    let sentAny = false;
    for (const conn of this.pickMediaConnections()) {
      try {
        conn.dataChannel.send(data, isAudio);
        conn.stats.sentPackets++;
        conn.stats.sentBytes += byteLengthOf(data);
        this.stats.sent++;
        sentAny = true;
      } catch { }
    }
    return sentAny;
  }

  handleRelayLoss(conn) {
    if (conn.state !== ConnectionState.Open) return;
    if (!conn.answered) {
      if (this.advanceRoute(conn, 'relay_lost_unanswered')) {
        void this.ensureConnection(conn.relayInfo);
        return;
      }
      if (conn.routes.length > 1) {
        this.applyRoute(conn, 0);
      }
    }
    this.logger.warn('[RELAY] relay lost', { connectionId: conn.relayInfo.id, port: conn.dialPort, silentMs: Date.now() - conn.lastInboundAt, answered: conn.answered, rx: this.rxStun });
    this.closePeerObjects(conn);
    conn.state = ConnectionState.Closed;
    if (!conn.recovering) conn.retryCount = 0;
    conn.recovering = true;
    this.emit('relay_lost', { connectionId: conn.relayInfo.id, anyOpen: this.hasConnection(), max: this.retrySchedule.length });
    this.scheduleRelayRetry(conn);
  }

  scheduleRelayRetry(conn) {
    if (conn.retryCount >= this.retrySchedule.length) {
      this.emit('relay_failed', { connectionId: conn.relayInfo.id, anyOpen: this.hasConnection(), max: this.retrySchedule.length });
      return;
    }
    const delay = this.retrySchedule[conn.retryCount];
    conn.retryCount += 1;
    conn.retryTimer = setTimeout(async () => {
      conn.retryTimer = null;
      if (this.connections.get(conn.relayInfo.id) !== conn) return;
      this.emit('relay_retrying', { connectionId: conn.relayInfo.id, attempt: conn.retryCount, anyOpen: this.hasConnection(), max: this.retrySchedule.length });
      await this.ensureConnection(conn.relayInfo);
      if (conn.state !== ConnectionState.Open) this.scheduleRelayRetry(conn);
    }, delay);
    conn.retryTimer.unref?.();
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
    for (const [, conn] of this.connections) {
      if (conn.retryTimer) clearTimeout(conn.retryTimer);
      conn.retryTimer = null;
      this.closePeerObjects(conn);
    }
    this.connections.clear();
    this.relayMap.clear();
    this.standbyRelays = [];
    this.failedRelays.clear();
    this.answeredRelayNames.clear();
    this.rejectedModes.clear();
    this.globalBuffer = [];
    this.globalBufferedBytes = 0;
  }
}

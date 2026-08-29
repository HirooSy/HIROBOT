import { EventEmitter } from 'node:events';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { WaVoipCoordinator } from './WaVoipCoordinator.js';
import { createVoipDeps } from './voip-deps.js';
import { createConsoleLogger } from './shim/core.js';
const KEY_MAP = {
    'pre-key': 'preKeys',
    session: 'sessions',
    'sender-key': 'senderKeys',
    'app-state-sync-key': 'appStateSyncKeys',
    'app-state-sync-version': 'appStateVersions',
    'sender-key-memory': 'senderKeyMemory',
    'lid-mapping': 'lidMappings',
    'device-list': 'deviceLists',
    tctoken: 'tcTokens',
};
function useSQLiteAuthState(dbPath, baileys) {
    const { BufferJSON, initAuthCreds } = baileys;
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
    CREATE TABLE IF NOT EXISTS creds (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS keys (type TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (type, id));
  `);
    const replacer = (key, value) => (value == null ? undefined : BufferJSON.replacer(key, value));
    const readCreds = () => {
        const row = db.prepare('SELECT data FROM creds WHERE id = 1').get();
        return row ? JSON.parse(row.data, BufferJSON.reviver) : initAuthCreds();
    };
    const writeCreds = (creds) => {
        db.prepare('INSERT INTO creds (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
            .run(JSON.stringify(creds, replacer));
    };
    const creds = readCreds();
    const getStmt = db.prepare('SELECT data FROM keys WHERE type = ? AND id = ?');
    const setStmt = db.prepare('INSERT INTO keys (type, id, data) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET data = excluded.data');
    const delStmt = db.prepare('DELETE FROM keys WHERE type = ? AND id = ?');
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const dbType = Object.keys(KEY_MAP).find((k) => KEY_MAP[k] === type) || type;
                    const result = {};
                    for (const id of ids) {
                        const row = getStmt.get(dbType, id);
                        if (row)
                            result[id] = JSON.parse(row.data, BufferJSON.reviver);
                    }
                    return result;
                },
                set: async (data) => {
                    for (const category in data) {
                        const dbType = Object.keys(KEY_MAP).find((k) => KEY_MAP[k] === category) || category;
                        for (const id in data[category]) {
                            const value = data[category][id];
                            if (value)
                                setStmt.run(dbType, id, JSON.stringify(value, replacer));
                            else
                                delStmt.run(dbType, id);
                        }
                    }
                },
            },
        },
        saveCreds: async () => writeCreds(creds),
    };
}
const loadBaileys = async () => {
    try {
        return await import('baileys');
    }
    catch {
        throw new Error("Could not import 'baileys' (aliased to @whiskeysockets/baileys). Make sure it's installed.");
    }
};
async function resolvePeerLid(sock, target) {
    const raw = String(target || '').trim();
    if (!raw)
        throw new Error('resolvePeerLid: target is required');
    if (raw.endsWith('@lid'))
        return raw;
    const pnJid = raw.includes('@') ? raw : `${raw.replace(/\D/g, '')}@s.whatsapp.net`;
    const lid = await sock.signalRepository.lidMapping?.getLIDForPN(pnJid);
    return lid || pnJid;
}
function createVoipCtx(sock, deps, stores, logger, emitter) {
    return {
        deps,
        stores,
        logger,
        registerIncomingHandler({ tag, prepend, handler }) {
            const listener = (node) => {
                Promise.resolve(handler(node)).catch((err) => {
                    logger.error('voip incoming handler failed', { tag, message: err?.message });
                });
            };
            const key = `CB:${tag}`;
            if (prepend && typeof sock.ws.prependListener === 'function') {
                sock.ws.prependListener(key, listener);
            }
            else {
                sock.ws.on(key, listener);
            }
            return () => {
                try {
                    sock.ws.off(key, listener);
                }
                catch { }
            };
        },
        emit(event, payload) {
            emitter.emit(event, payload);
        }
    };
}
export class ActiveCall extends EventEmitter {
    callId;
    #coordinator;
    #endResolver;
    #endPromise;
    #endTimer = null;
    #ended = false;
    #connectedEmitted = false;
    constructor(coordinator, callId, durationMs) {
        super();
        this.callId = callId;
        this.#coordinator = coordinator;
        this.#endPromise = new Promise((res) => { this.#endResolver = res; });
        if (durationMs > 0)
            this.#endTimer = setTimeout(() => this.end(), durationMs);
    }
    _onState(call) {
        if (call.callId !== this.callId)
            return;
        if (call.isRinging)
            this.emit('ringing');
        if (call.isActive && !this.#connectedEmitted) {
            this.#connectedEmitted = true;
            this.emit('connected');
        }
    }
    _onEnded(call) {
        if (call.callId !== this.callId)
            return;
        this._forceEnd(call.stateData?.endReason ?? 'ended');
    }
    _onError(err) {
        this.emit('error', err);
    }
    end = async () => {
        if (this.#ended)
            return;
        if (this.#endTimer) {
            clearTimeout(this.#endTimer);
            this.#endTimer = null;
        }
        try {
            await this.#coordinator.endCall(this.callId);
        }
        catch (e) {
            this._forceEnd('ended');
            throw e;
        }
    };
    waitForEnd = () => this.#endPromise;
    _forceEnd = (reason) => {
        if (this.#ended)
            return;
        this.#ended = true;
        if (this.#endTimer) {
            clearTimeout(this.#endTimer);
            this.#endTimer = null;
        }
        this.emit('ended', reason);
        this.#endResolver(reason);
    };
}
export class VoipClient {
    #config;
    #sock = null;
    #baileys = null;
    #coordinator = null;
    #activeCall = null;
    constructor(config) {
        this.#config = config;
    }
    connect = async () => {
        if (this.#config.existingSocket) {
            this.#sock = this.#config.existingSocket;
        }
        else {
            this.#baileys = await loadBaileys();
            const { default: makeWASocket, DisconnectReason, Browsers } = this.#baileys;
            const makeSocket = makeWASocket ?? this.#baileys.makeWASocket ?? this.#baileys;
            const authDbPath = resolve(this.#config.authDir);
            const { state, saveCreds } = useSQLiteAuthState(authDbPath, this.#baileys);
            const silentLogger = {
                level: 'silent', child: () => silentLogger,
                trace: () => { }, debug: () => { }, info: () => { }, warn: () => { }, error: () => { }, fatal: () => { },
            };
            const createSocket = () => makeSocket({ auth: state, emitOwnEvents: true, browser: Browsers.macOS('Safari'), logger: silentLogger });
            await new Promise((resolveOpen, rejectOpen) => {
                let opened = false;
                let retries = 0;
                let pairingRequested = false;
                const maxRetries = 5;
                const connectSocket = () => {
                    this.#sock = createSocket();
                    this.#sock.ev.on('creds.update', saveCreds);
                    process.removeAllListeners('uncaughtException');
                    process.on('uncaughtException', (err) => {
                        const code = err?.output?.statusCode ?? err?.data?.attrs?.code;
                        if ((code === 515 || code === '515') && !opened && retries < maxRetries) {
                            retries += 1;
                            setTimeout(connectSocket, 1500);
                        }
                        else if (!opened) {
                            rejectOpen(err);
                        }
                    });
                    if (this.#config.pairingCode && !this.#sock.authState?.creds?.registered && !pairingRequested) {
                        pairingRequested = true;
                        const phone = String(this.#config.pairingCode).replace(/\D/g, '');
                        const customCode = this.#config.customPairingCode
                            ? String(this.#config.customPairingCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
                            : undefined;
                        setTimeout(async () => {
                            try {
                                const code = customCode ? await this.#sock.requestPairingCode(phone, customCode) : await this.#sock.requestPairingCode(phone);
                                console.log(`[ VOIP ] Pairing code for ${phone}: ${code}`);
                                console.log('[ VOIP ] Enter this in WhatsApp > Linked Devices > Link with phone number.');
                            }
                            catch (e) {
                                console.error('[ VOIP ] Failed to request pairing code:', e?.message ?? e);
                            }
                        }, 3000);
                    }
                    this.#sock.ev.on('connection.update', (update) => {
                        if (update.qr && !this.#config.pairingCode) {
                            void import('qrcode-terminal')
                                .then((qrt) => (qrt.default ?? qrt).generate(update.qr, { small: true }))
                                .catch(() => {
                                console.log('Scan this QR code in WhatsApp > Linked Devices:');
                                console.log(update.qr);
                            });
                        }
                        if (update.connection === 'open') {
                            opened = true;
                            process.removeAllListeners('uncaughtException');
                            resolveOpen();
                            return;
                        }
                        if (update.connection === 'close' && !opened) {
                            const statusCode = update.lastDisconnect?.error?.output?.statusCode;
                            const shouldReconnect = statusCode === 515 || statusCode === DisconnectReason?.restartRequired;
                            if (shouldReconnect && retries < maxRetries) {
                                retries += 1;
                                setTimeout(connectSocket, 1000);
                            }
                            else {
                                rejectOpen(update.lastDisconnect?.error ?? new Error('socket closed before open'));
                            }
                        }
                    });
                };
                connectSocket();
            });
        }
        if (!this.#baileys)
            this.#baileys = await loadBaileys();
        const { deps, stores } = await createVoipDeps(this.#sock);
        const logger = createConsoleLogger(this.#config.voipLogLevel ?? 'warn');
        const emitter = new EventEmitter();
        const ctx = createVoipCtx(this.#sock, deps, stores, logger, emitter);
        this.#coordinator = new WaVoipCoordinator(ctx, {
            maxConcurrentCalls: 1,
            logLevel: this.#config.voipLogLevel ?? 'warn'
        });
    };
    call = async (phoneNumber, opts = {}) => {
        if (!this.#sock || !this.#coordinator)
            throw new Error('Not connected. Call connect() first.');
        if (this.#activeCall)
            throw new Error('A call is already active.');
        const durationMs = opts.durationMs ?? 120_000;
        const peerJid = await resolvePeerLid(this.#sock, phoneNumber);
        const audioFile = opts.audioSource && opts.audioSource !== 'silence' ? opts.audioSource : undefined;
        const callId = await this.#coordinator.startCall({
            peerJid,
            isVideo: !!opts.isVideo,
            audioFile
        });
        // Same pattern as the audioFile fix above: starting the call only wires up
        // the codec/RTP session (via WaCallManager.startCall -> initMedia), it never
        // loads any media file. videoSource needs its own explicit loadVideo call,
        // same as audioFile needs loadAudio.
        if (audioFile) {
            try {
                await this.#coordinator.loadAudio(callId, audioFile);
            } catch (e) {
                console.error(`[ VOIP ] Failed to load audio "${audioFile}" for call ${callId}:`, e?.message || e);
            }
        }
        if (opts.isVideo && opts.videoSource) {
            try {
                await this.#coordinator.loadVideo(callId, opts.videoSource);
            } catch (e) {
                console.error(`[ VOIP ] Failed to load video "${opts.videoSource}" for call ${callId}:`, e?.message || e);
            }
        }
        const call = new ActiveCall(this.#coordinator, callId, durationMs);
        this.#activeCall = call;
        const onState = (info) => call._onState(info);
        const onEnded = (info) => call._onEnded(info);
        const onError = (err) => call._onError(err);
        this.#coordinator.on('call_state', onState);
        this.#coordinator.on('call_ended', onEnded);
        this.#coordinator.on('call_error', onError);
        call.once('ended', () => {
            this.#coordinator?.off('call_state', onState);
            this.#coordinator?.off('call_ended', onEnded);
            this.#coordinator?.off('call_error', onError);
            if (this.#activeCall === call)
                this.#activeCall = null;
        });
        return call;
    };
    disconnect = () => {
        try {
            this.#activeCall?.end();
        }
        catch { }
        try {
            this.#coordinator?.dispose();
        }
        catch { }
        try {
            this.#sock?.ws?.close?.();
        }
        catch { }
        this.#sock = null;
        this.#coordinator = null;
    };
}


import { EventEmitter } from "node:events";
import { randomBytes, createHmac } from "node:crypto";
import { resolve } from "node:path";
import { WasmEngine } from "./wasm-engine.js";
import { RelayRtcTransport } from "./relay-transport.js";
import { SignalingBridge } from "./signaling.js";
import { AudioFeeder } from "./audio-feeder.js";
import { CallState } from "./types.js";
export { CallState } from "./types.js";
const SHA256_LEN = 32;
const loadBaileys = async () => {
    try {
        return await import("baileys");
    }
    catch {
        throw new Error("Could not import 'baileys' (aliased to @whiskeysockets/baileys). Make sure it's installed.");
    }
};
const toBareJid = (jid) => {
    if (!jid)
        return jid;
    const at = jid.indexOf("@");
    if (at < 0)
        return jid;
    const user = jid.slice(0, at).split(":")[0];
    return `${user}@${jid.slice(at + 1)}`;
};
const computeHkdf = (key, salt, info, length) => {
    const effectiveSalt = salt && salt.length > 0 ? Buffer.from(salt) : Buffer.alloc(SHA256_LEN, 0);
    const prk = createHmac("sha256", effectiveSalt).update(key).digest();
    const blocks = Math.ceil(length / SHA256_LEN);
    const okm = Buffer.alloc(blocks * SHA256_LEN);
    let prev = Buffer.alloc(0);
    for (let i = 1; i <= blocks; i += 1) {
        prev = createHmac("sha256", prk)
            .update(prev)
            .update(info)
            .update(Buffer.from([i]))
            .digest();
        prev.copy(okm, (i - 1) * SHA256_LEN);
    }
    return new Uint8Array(okm.buffer, okm.byteOffset, length);
};
const computeHmacSha256 = (data, key) => {
    const result = createHmac("sha256", Buffer.from(key)).update(data).digest();
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
};
const isCallReceiptNode = (node) => {
    if (node?.tag !== "receipt")
        return false;
    const child = Array.isArray(node.content) ? node.content[0] : null;
    return !!(child?.attrs?.["call-id"] || child?.attrs?.call_id);
};

export class ActiveCall extends EventEmitter {
    callId;
    engine;
    #state = CallState.Idle;
    #endResolver;
    #endPromise;
    #endTimer = null;
    #ended = false;
    #wasActive = false;

    _audioSource = "silence";
    constructor(callId, engine, durationMs) {
        super();
        this.callId = callId;
        this.engine = engine;
        this.#endPromise = new Promise((res) => { this.#endResolver = res; });
        if (durationMs > 0) {
            this.#endTimer = setTimeout(() => this.end(), durationMs);
        }
    }
    get state() { return this.#state; }
    end = () => {
        if (this.#ended)
            return;
        this.#ended = true;
        if (this.#endTimer) {
            clearTimeout(this.#endTimer);
            this.#endTimer = null;
        }
        try {
            this.engine.endCall(0, true);
        }
        catch { }
    };
    mute = (muted) => {
        try {
            this.engine.setMute(muted);
        }
        catch { }
    };
    waitForEnd = () => this.#endPromise;

    _updateState = (state, callResult) => {
        this.#state = state;
        if (state === CallState.PreacceptReceived)
            this.emit("ringing");
        else if (state === CallState.Active) {
            this.#wasActive = true;
            this.emit("connected");
        }
        else if (state === CallState.Idle || state === CallState.Ending) {
            // A non-zero call_result arriving before the call ever reached
            // Active almost always means the peer rejected/declined the call
            // (or it failed to set up) rather than a normal hangup. Once the
            // call has been Active, non-zero call_result values can also show
            // up transiently during ICE reconnects — those must NOT be
            // treated as a decline, so we only use this signal pre-Active.
            if (!this.#wasActive && callResult != null && Number(callResult) !== 0) {
                this._forceEnd("declined");
            } else {
                this._forceEnd("ended");
            }
        }
    };

    _emitAudio = (pcm) => { this.emit("audio", pcm); };

    _forceEnd = (reason) => {
        if (this.#ended)
            return;
        this.#ended = true;
        if (this.#endTimer) {
            clearTimeout(this.#endTimer);
            this.#endTimer = null;
        }
        this.emit("ended", reason);
        this.#endResolver(reason);
    };
}

export class VoipClient {
    #config;
    #engine = null;
    #relay = null;
    #signaling = null;
    #sock = null;
    #activeCall = null;
    #baileys = null;

    #capturePtr = 0;
    #captureChunkBytes = 0;
    #captureSampleRate = 16000;
    #captureChannels = 1;
    #captureFramesPerChunk = 320;
    #feeder = null;
    // References to the CB:call/CB:receipt listeners we attach to the
    // (possibly shared/existingSocket) ws instance, so disconnect() can
    // remove exactly these. Without this, every reconnect on a shared
    // socket leaves a stale listener behind that keeps firing and
    // dereferencing #signaling/#engine after disconnect() nulls them out —
    // throwing on every future receipt and pinning old closures (and
    // everything they capture) in memory.
    #onCbCall = null;
    #onCbReceipt = null;
    constructor(config) {
        this.#config = config;
    }

    connect = async () => {
        if (this.#config.existingSocket) {
            this.#sock = this.#config.existingSocket;
        }
        else {
            this.#baileys = await loadBaileys();
            const { useMultiFileAuthState, default: makeWASocket, DisconnectReason } = this.#baileys;
            const makeSocket = makeWASocket ?? this.#baileys.makeWASocket ?? this.#baileys;
            const authDir = resolve(this.#config.authDir);
            const { state, saveCreds } = await useMultiFileAuthState(authDir);
            const silentLogger = {
                level: "silent",
                child: () => silentLogger,
                trace: () => { },
                debug: () => { },
                info: () => { },
                warn: () => { },
                error: () => { },
                fatal: () => { },
            };
            const createSocket = () => makeSocket({
                auth: state,
                emitOwnEvents: true,
                logger: silentLogger,
            });

            await new Promise((resolveOpen, rejectOpen) => {
                let opened = false;
                let retries = 0;
                let pairingRequested = false;
                const maxRetries = 5;
                const connectSocket = () => {
                    this.#sock = createSocket();
                    this.#sock.ev.on("creds.update", saveCreds);
                    process.removeAllListeners("uncaughtException");
                    process.on("uncaughtException", (err) => {
                        const code = err?.output?.statusCode ?? err?.data?.attrs?.code;
                        if ((code === 515 || code === "515") && !opened && retries < maxRetries) {
                            retries += 1;
                            setTimeout(connectSocket, 1500);
                        }
                        else if (!opened) {
                            rejectOpen(err);
                        }
                    });



                    if (this.#config.pairingCode && !this.#sock.authState?.creds?.registered && !pairingRequested) {
                        pairingRequested = true;
                        const phone = String(this.#config.pairingCode).replace(/\D/g, "");
                        const customCode = this.#config.customPairingCode
                            ? String(this.#config.customPairingCode).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)
                            : undefined;
                        setTimeout(async () => {
                            try {
                                const code = customCode
                                    ? await this.#sock.requestPairingCode(phone, customCode)
                                    : await this.#sock.requestPairingCode(phone);
                                console.log(`[ VOIP ] Pairing code for ${phone}: ${code}`);
                                console.log("[ VOIP ] Enter this in WhatsApp > Linked Devices > Link with phone number.");
                            }
                            catch (e) {
                                console.error("[ VOIP ] Failed to request pairing code:", e?.message ?? e);
                            }
                        }, 3000);
                    }
                    this.#sock.ev.on("connection.update", (update) => {
                        if (update.qr && !this.#config.pairingCode) {
                            void import("qrcode-terminal")
                                .then((qrt) => (qrt.default ?? qrt).generate(update.qr, { small: true }))
                                .catch(() => {
                                console.log("Scan this QR code in WhatsApp > Linked Devices:");
                                console.log(update.qr);
                            });
                        }
                        if (update.connection === "open") {
                            opened = true;
                            process.removeAllListeners("uncaughtException");
                            resolveOpen();
                            return;
                        }
                        if (update.connection === "close" && !opened) {
                            const statusCode = update.lastDisconnect?.error?.output?.statusCode;
                            const shouldReconnect = statusCode === 515 || statusCode === DisconnectReason?.restartRequired;
                            if (shouldReconnect && retries < maxRetries) {
                                retries += 1;
                                setTimeout(connectSocket, 1000);
                            }
                            else {
                                rejectOpen(update.lastDisconnect?.error ?? new Error("socket closed before open"));
                            }
                        }
                    });
                };
                connectSocket();
            });
        }
        this.#signaling = new SignalingBridge({ sock: this.#sock });
        await this.#signaling.init();
        this.#relay = new RelayRtcTransport({
            onTransportMessage: (data, ip, port) => this.#engine?.handleOnTransportMessage(data, ip, port),
            onIceRtt: (rttMs, ip, port) => this.#engine?.updateIceRtt(rttMs, ip, port),
        });
        this.#engine = new WasmEngine({
            callbacks: {
                onSignalingXmpp: (peerJid, callId, xmlPayload) => this.#signaling.sendSignaling(peerJid, callId, xmlPayload),
                onCallEvent: (eventType, eventData) => this.#handleCallEvent(eventType, eventData),
                sendDataToRelay: (data, ip, port) => this.#relay.send(data, ip, port),
                onAudioCaptureInit: (config) => this.#handleAudioCaptureInit(config),
                onAudioCaptureStart: () => this.#handleAudioCaptureStart(),
                onAudioCaptureStop: () => this.#handleAudioCaptureStop(),
                onAudioPlaybackData: (audioData) => this.#activeCall?._emitAudio(audioData),
                cryptoHkdf: computeHkdf,
                hmacSha256: computeHmacSha256,
            },
        });
        await this.#engine.initialize();
        this.#signaling.attachEngine(this.#engine);
        const selfPnJid = this.#sock.authState.creds.me?.id;
        const selfLidJid = this.#sock.authState.creds.me?.lid;
        this.#engine.initVoipStack(selfPnJid, toBareJid(selfPnJid), selfLidJid);
        await this.#engine.waitForVoipStackReady();
        try {
            this.#engine.updateNetworkMedium(2, 0);
        }
        catch { }
        this.#onCbCall = (node) => {
            if (!this.#signaling) return;
            this.#signaling.processIncomingCall(node, this.#engine, this.#activeCall?.callId ?? "");
        };
        this.#onCbReceipt = (node) => {
            if (!this.#signaling) return;
            if (!isCallReceiptNode(node))
                return;
            this.#signaling.processIncomingReceipt(node, this.#engine, this.#activeCall?.callId ?? "");
        };
        this.#sock.ws.on("CB:call", this.#onCbCall);
        this.#sock.ws.on("CB:receipt", this.#onCbReceipt);
    };

    call = async (phoneNumber, opts = {}) => {
        if (!this.#engine || !this.#signaling)
            throw new Error("Not connected. Call connect() first.");
        if (this.#activeCall)
            throw new Error("A call is already active.");
        const targetNumber = phoneNumber.replace(/\D/g, "");
        const targetPnJid = `${targetNumber}@s.whatsapp.net`;
        const durationMs = opts.durationMs ?? 120_000;
        const audioSource = opts.audioSource ?? "silence";
        const peerLid = await this.#signaling.resolveLid(targetPnJid);
        console.log('[ VOIP ] resolveLid result:', peerLid);
        if (!peerLid)
            throw new Error(`Could not resolve LID for ${targetPnJid}`);
        for (const jid of [targetPnJid, peerLid]) {
            try {
                await this.#sock.presenceSubscribe(jid);
            }
            catch (e) {
                console.warn('[ VOIP ] presenceSubscribe failed for', jid, ':', e?.message || e);
            }
        }
        await new Promise((r) => setTimeout(r, 750));
        const peerDeviceJids = await this.#signaling.discoverPeerDevices(peerLid);
        console.log('[ VOIP ] discoverPeerDevices result:', JSON.stringify(peerDeviceJids));
        const deviceList = peerDeviceJids.length ? peerDeviceJids : [toBareJid(peerLid)];
        console.log('[ VOIP ] final deviceList:', JSON.stringify(deviceList));
        await this.#signaling.ensureSessionsForPeers(deviceList);
        await new Promise((r) => setTimeout(r, 500));
        await this.#signaling.issueTcToken(peerLid);
        const tcToken = await this.#signaling.ensureTcToken(peerLid, targetPnJid);
        console.log('[ VOIP ] tcToken:', tcToken ? `present (len=${String(tcToken).length}, hex=${Buffer.from(tcToken).toString('hex').slice(0, 20)}...)` : 'MISSING/empty — will proceed anyway, WhatsApp may reject the call setup');
        const callId = ("00" + randomBytes(16).toString("hex").slice(2)).toUpperCase();
        const call = new ActiveCall(callId, this.#engine, durationMs);
        call._audioSource = audioSource;
        this.#activeCall = call;
        call.once("ended", () => {
            console.log('[ VOIP ] ActiveCall ended — force-stopping feeder and clearing state.');
            this.#feeder?.stop();
            this.#feeder = null;
            if (this.#activeCall === call) this.#activeCall = null;
        });
        this.#engine.startCall({
            peerJid: peerLid,
            peerPn: targetPnJid,
            peerList: deviceList,
            callId,
            isVideo: false,
            isLidCall: true,
            isFromDialer: false,
            extraData: tcToken,
        });
        return call;
    };

    disconnect = () => {
        this.#activeCall?._forceEnd("disconnect");
        this.#activeCall = null;
        this.#relay?.closeAll();
        this.#engine?.destroy();
        if (this.#sock?.ws) {
            if (this.#onCbCall) this.#sock.ws.removeListener("CB:call", this.#onCbCall);
            if (this.#onCbReceipt) this.#sock.ws.removeListener("CB:receipt", this.#onCbReceipt);
        }
        this.#onCbCall = null;
        this.#onCbReceipt = null;
        if (!this.#config.existingSocket) this.#sock?.end?.();
        this.#engine = null;
        this.#relay = null;
        this.#signaling = null;
        this.#sock = null;
    };

    #handleCallEvent = (eventType, eventData) => {
        if (eventType === 16 && eventData) {
            try {
                const parsed = JSON.parse(eventData);
                const info = parsed.call_info ?? parsed.callInfo ?? {};
                const callState = Number(info.call_state ?? info.callState ?? 0);
                const callResult = info.call_result ?? info.callResult;
                console.log(`[ VOIP ] call_state event: state=${callState}, call_result=${callResult}, error_type=${info.call_setup_error_type}`);
                this.#activeCall?._updateState(callState, callResult);
            }
            catch (e) {
                console.error('[ VOIP ] failed to parse call event (type 16):', e?.message || e);
            }
        }
        else if (eventType === 156 && eventData) {
            try {
                const update = JSON.parse(eventData);
                this.#relay?.updateRelayList(update);
            }
            catch (e) {
                console.error('[ VOIP ] failed to parse relay update (type 156):', e?.message || e);
            }
        }
        else if (eventType === 2) {
            console.log('[ VOIP ] eventType=2 (remote_end) received');
            this.#activeCall?._forceEnd("remote_end");
        }
        else if (eventType === 11 && eventData) {
            try {
                const parsed = JSON.parse(eventData);
                console.log(`[ VOIP ] eventType=11 (call terminated) received, call_id=${parsed.call_id}, reason=${parsed.reason || '(empty)'}`);
                this.#activeCall?._forceEnd(parsed.reason || "terminated");
            }
            catch (e) {
                console.error('[ VOIP ] failed to parse call event (type 11):', e?.message || e);
                this.#activeCall?._forceEnd("terminated");
            }
        }
        else {
            // High-frequency internal WASM telemetry events (stats, keepalives,
            // etc.) fire many times per call and dumping their full JSON payload
            // to console on every occurrence was a major source of memory/CPU
            // overhead. Log just the type + size so it's still visible for
            // debugging without retaining/printing the full payload each time.
            console.log(`[ VOIP ] unhandled callback event type=${eventType}` + (eventData ? ` (payload ${String(eventData).length} chars)` : ' (no data)'));
        }
    };
    #handleAudioCaptureInit = (config) => {
        if (!this.#engine)
            return;
        this.#captureSampleRate = config.sampleRate || 16000;
        this.#captureChannels = config.channels || 1;
        this.#captureFramesPerChunk = config.framesPerChunk || 320;
        const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels;
        this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
        this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes);
    };
    #handleAudioCaptureStart = () => {
        if (!this.#engine || !this.#capturePtr)
            return;
        const audioSource = this.#activeCall?._audioSource ?? "silence";
        const activeCallRef = this.#activeCall;
        let _chunkCount = 0;
        this.#feeder = new AudioFeeder(this.#captureSampleRate, this.#captureChannels, this.#captureFramesPerChunk, (chunk) => {
            _chunkCount += 1;
            if (_chunkCount === 1 || _chunkCount % 500 === 0) {
                console.log(`[ VOIP ] audio chunk #${_chunkCount} sent to WASM`);
            }
            if (this.#engine && this.#capturePtr)
                this.#engine.sendAudioData(chunk, this.#capturePtr);
        }, audioSource, () => {
            console.log('[ VOIP ] AudioFeeder reported finished — ending call.');
            if (activeCallRef && activeCallRef.state === CallState.Active) {
                activeCallRef.end();
            } else {
                console.log('[ VOIP ] Skipped auto-end: call not Active (state=' + activeCallRef?.state + '), likely still (re)connecting.');
            }
        });
        this.#feeder.start();
    };
    #handleAudioCaptureStop = () => {
        this.#feeder?.stop();
        this.#feeder = null;
        if (this.#engine && this.#capturePtr) {
            try {
                this.#engine.free(this.#capturePtr);
            }
            catch { }
            this.#capturePtr = 0;
        }
    };
}

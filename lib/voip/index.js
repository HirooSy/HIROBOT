import { EventEmitter } from "node:events";
import { randomBytes, createHmac } from "node:crypto";
import { resolve } from "node:path";
import { WasmEngine } from "./modules/wasm-engine.js";
import { RelayRtcTransport } from "./modules/relay-transport.js";
import { SignalingBridge } from "./modules/signaling.js";
import { AudioFeeder } from "./modules/audio-feeder.js";
import { VideoFeeder } from "./modules/video-feeder.js";

const MAX_VIDEO_WIDTH = 160;
const MAX_VIDEO_HEIGHT = 120;
const MAX_VIDEO_FPS = 12;
const MAX_VIDEO_FEEDER_RETRIES = 3;
import { CallState } from "./modules/types.js";
export { CallState } from "./modules/types.js";
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

    #wasActive = false;

    _updateState = (state, callResult) => {
        this.#state = state;
        if (state === CallState.PreacceptReceived)
            this.emit("ringing");
        else if (state === CallState.Active) {
            this.#wasActive = true;
            this.emit("connected");
        }
        else if (state === CallState.Idle || state === CallState.Ending) {
           
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

    #pendingAudioSource = "silence";
    #capturePtr = 0;
    #captureChunkBytes = 0;
    #captureSampleRate = 16000;
    #captureChannels = 1;
    #captureFramesPerChunk = 320;
    #feeder = null;

    #pendingVideoSource = null;
    #videoFeeder = null;
    #videoFeederReady = false;
    #videoReadyWaiters = [];
    #videoStreamId = 0;
    #videoWidth = 160;
    #videoHeight = 120;
    #videoFps = 12;
    #videoFeederFailureCount = 0;
    
    #videoRestartChain = Promise.resolve();
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
        this.#signaling = new SignalingBridge({
            sock: this.#sock,
            onSignalingError: (callId, error) => {
                if (this.#activeCall?.callId === callId) {
                    this.#activeCall._forceEnd(`signaling_error: ${error?.message || error}`);
                }
            },
        });
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
                onVideoCaptureStart: (config) => this.#handleVideoCaptureStart(config),
                onVideoCaptureStop: () => this.#handleVideoCaptureStop(),
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
        console.log('[ Call ] Connecting...');
        const targetNumber = phoneNumber.replace(/\D/g, "");
        const targetPnJid = `${targetNumber}@s.whatsapp.net`;
        const durationMs = opts.durationMs ?? 120_000;
        const audioSource = opts.audioSource ?? "silence";
        const isVideo = opts.isVideo ?? false;
        const videoSource = opts.videoSource ?? null;
        const peerLid = await this.#signaling.resolveLid(targetPnJid);
        if (!peerLid)
            throw new Error(`Could not resolve LID for ${targetPnJid}`);
        for (const jid of [targetPnJid, peerLid]) {
            try {
                await this.#sock.presenceSubscribe(jid);
            }
            catch { }
        }
        await new Promise((r) => setTimeout(r, 750));
        const peerDeviceJids = await this.#signaling.discoverPeerDevices(peerLid);
        const deviceList = peerDeviceJids.length ? peerDeviceJids : [toBareJid(peerLid)];
        await this.#signaling.ensureSessionsForPeers(deviceList);
        await new Promise((r) => setTimeout(r, 500));
        await this.#signaling.issueTcToken(peerLid);
        const tcToken = await this.#signaling.ensureTcToken(peerLid, targetPnJid);
        const callId = ("00" + randomBytes(16).toString("hex").slice(2)).toUpperCase();
        const call = new ActiveCall(callId, this.#engine, durationMs);
        call._audioSource = audioSource;
        this.#activeCall = call;
        this.#pendingAudioSource = audioSource;
        this.#pendingVideoSource = videoSource;
        this.#videoFeederFailureCount = 0;
        this.#videoFeederReady = false;
        this.#videoReadyWaiters = [];
        call.once("ended", () => {
            this.#feeder?.stop();
            this.#feeder = null;
            this.#videoFeeder?.stop();
            this.#videoFeeder = null;
            if (this.#activeCall === call) this.#activeCall = null;
        });
        this.#engine.startCall({
            peerJid: peerLid,
            peerPn: targetPnJid,
            peerList: deviceList,
            callId,
            isVideo,
            isLidCall: true,
            isFromDialer: false,
            extraData: tcToken,
        });
        return call;
    };

    #onCbCall = null;
    #onCbReceipt = null;

    disconnect = () => {
        this.#activeCall?._forceEnd("disconnect");
        this.#activeCall = null;
        this.#relay?.closeAll();
        this.#engine?.destroy();
        if (this.#sock?.ws) {
            if (this.#onCbCall) this.#sock.ws.off?.("CB:call", this.#onCbCall);
            if (this.#onCbReceipt) this.#sock.ws.off?.("CB:receipt", this.#onCbReceipt);
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
                this.#activeCall?._updateState(callState, callResult);
            }
            catch { }
        }
        else if (eventType === 156 && eventData) {
            try {
                const update = JSON.parse(eventData);
                this.#relay?.updateRelayList(update);
            }
            catch { }
        }
        else if (eventType === 2) {
            this.#activeCall?._forceEnd("remote_end");
        }
        else if (eventType === 11 && eventData) {
            try {
                const parsed = JSON.parse(eventData);
                this.#activeCall?._forceEnd(parsed.reason || "terminated");
            }
            catch {
                this.#activeCall?._forceEnd("terminated");
            }
        }
        else if (eventType === 164 && eventData) {
            try {
                const params = JSON.parse(eventData);
                this.#applyVideoEncoderParams(params);
            }
            catch { }
        }
        else if (eventType === 163 && eventData) {
            try {
                const params = JSON.parse(eventData);
                this.#applyVideoEncoderParams(params);
            }
            catch { }
        }
        else {
        }
    };
    #handleAudioCaptureInit = (config) => {
        if (!this.#engine)
            return;
        if (this.#capturePtr) {
            try { this.#engine.free(this.#capturePtr); } catch { }
            this.#capturePtr = 0;
        }
        this.#captureSampleRate = config.sampleRate || 16000;
        this.#captureChannels = config.channels || 1;
        this.#captureFramesPerChunk = config.framesPerChunk || 320;
        const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels;
        this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
        this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes);
    };
    #handleAudioCaptureStart = () => {
        if (!this.#engine || !this.#capturePtr) {
            return;
        }
        if (this.#feeder) {
            this.#feeder.stop();
            this.#feeder = null;
        }
        const audioSource = this.#pendingAudioSource ?? "silence";
        this.#feeder = new AudioFeeder(this.#captureSampleRate, this.#captureChannels, this.#captureFramesPerChunk, (chunk) => {
            if (this.#engine && this.#capturePtr)
                this.#engine.sendAudioData(chunk, this.#capturePtr);
        }, audioSource, () => {
            // Read this.#activeCall lazily here (not captured at start-of-call
            // time) since onAudioCaptureStart can itself fire before
            // this.#activeCall is guaranteed to be set — capturing it early
            // risked ending up with a stale/null reference and silently
            // failing to auto-hangup once the audio file finished.
            if (this.#activeCall && this.#activeCall.state === CallState.Active) {
                this.#activeCall.end();
            }
        });
        const feederAtStart = this.#feeder;
        if (this.#pendingVideoSource) {
            // Ada video untuk call ini — tunggu video feeder benar-benar
            // mulai mengirim frame pertama sebelum audio mulai, supaya
            // keduanya start dari titik waktu yang sama (bukan audio
            // duluan sementara video masih spawning ffmpeg). Timeout 5
            // detik sebagai pengaman: kalau video gagal/lambat, audio
            // tetap jalan agar call tidak diam total. Jeda kecil 20ms
            // tambahan setelah video ready supaya frame video pertama
            // sempat benar-benar terkirim lebih dulu, tanpa menambah
            // delay yang terasa (di bawah ambang persepsi audio-video
            // sync manusia, ~40-100ms).
            this.#waitForVideoReady(5000).then(() => new Promise((resolve) => setTimeout(resolve, 20))).then(() => {
                if (this.#feeder === feederAtStart) feederAtStart.start();
            });
        }
        else {
            this.#feeder.start();
        }
    };
    #waitForVideoReady = (timeoutMs) => {
        if (this.#videoFeederReady) return Promise.resolve();
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const idx = this.#videoReadyWaiters.indexOf(entry);
                if (idx !== -1) this.#videoReadyWaiters.splice(idx, 1);
                resolve();
            }, timeoutMs);
            const entry = () => {
                clearTimeout(timer);
                resolve();
            };
            this.#videoReadyWaiters.push(entry);
        });
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
    #handleVideoCaptureStart = (config) => {
        if (!this.#engine) return Promise.resolve();
        // Chained onto #videoRestartChain (not just locally awaited) so a
        // concurrent trigger — WASM re-firing startVideoCaptureJS, or
        // applyVideoEncoderParams's own restart — can't pass the "is there
        // an existing feeder" check while this one is still mid-stop.
        this.#videoRestartChain = this.#videoRestartChain.then(async () => {
            if (this.#videoFeeder) {
                await this.#videoFeeder.stop();
                this.#videoFeeder = null;
            }
            this.#videoStreamId = config?.streamId ?? 0;
            this.#videoWidth = Math.min(config?.width || this.#videoWidth, MAX_VIDEO_WIDTH);
            this.#videoHeight = Math.min(config?.height || this.#videoHeight, MAX_VIDEO_HEIGHT);
            this.#videoFps = Math.min(config?.fps || this.#videoFps, MAX_VIDEO_FPS);
            const videoSource = this.#pendingVideoSource;
            if (!videoSource) {
                // No video file supplied for this call (audio-only .voipcall) —
                // WASM still asked to start video capture because isVideo was
                // true, but there's nothing to encode. Leave #videoFeeder unset;
                // sendVideoData is simply never called, same as how AudioFeeder
                // behaves for a 'silence' source but without spawning a wasted
                // ffmpeg process for it.
                return;
            }
            if (this.#videoFeederFailureCount >= MAX_VIDEO_FEEDER_RETRIES) {
                // Circuit breaker: WASM's adaptive controller re-fires
                // startVideoCaptureJS/eventType=164 whenever it isn't receiving
                // video (which is exactly what happens on every failed
                // encode), so without this a broken source spins ffmpeg up and
                // down in a tight loop indefinitely — pegging CPU at 100%+ and
                // never actually recovering, since the source is the problem,
                // not the retry itself. Give up on video (audio keeps working
                // independently) rather than let it consume the whole host.
                if (this.#videoFeederFailureCount === MAX_VIDEO_FEEDER_RETRIES) {
                    console.error(`[ VOIP ] Video source failed ${MAX_VIDEO_FEEDER_RETRIES} times in a row, giving up on video for this call (audio continues normally): ${videoSource}`);
                    this.#videoFeederFailureCount += 1; // only log once
                }
                return;
            }
            this.#videoFeeder = new VideoFeeder(videoSource, this.#videoWidth, this.#videoHeight, this.#videoFps, (accessUnit, isKeyFrame) => {
                if (!this.#videoFeederReady) {
                    this.#videoFeederReady = true;
                    const waiters = this.#videoReadyWaiters;
                    this.#videoReadyWaiters = [];
                    waiters.forEach((resolveWaiter) => resolveWaiter());
                }
                if (!this.#engine) return;
                const timestampMs = Date.now();
                // latencyMs (capture-to-encode) and orientation are metadata
                // WhatsApp's own WebCodecs path reports for adaptive-quality
                // telemetry — we don't have a meaningful capture pipeline to
                // measure real latency from, and orientation 0 = no rotation
                // (matches self_camera_front_facing:false seen in call_info
                // logs, i.e. not front-camera-mirrored).
                this.#engine.sendVideoData(this.#videoStreamId, accessUnit, this.#videoWidth, this.#videoHeight, timestampMs, isKeyFrame, 0, 0);
                this.#videoFeederFailureCount = 0;
            }, () => {
                if (this.#activeCall && this.#activeCall.state === CallState.Active) {
                    this.#activeCall.end();
                }
            }, (err) => {
                this.#videoFeederFailureCount += 1;
                console.error(`[ VOIP ] VideoFeeder failed (attempt ${this.#videoFeederFailureCount}/${MAX_VIDEO_FEEDER_RETRIES}): ${err?.message || err}`);
            });
            this.#videoFeeder.start();
        }).catch((err) => {
            console.error(`[ VOIP ] video restart chain error: ${err?.message || err}`);
        });
        return this.#videoRestartChain;
    };
    #handleVideoCaptureStop = () => {
        this.#videoFeeder?.stop();
        this.#videoFeeder = null;
    };
 
    #applyVideoEncoderParams = (params) => {
        if (!this.#videoFeeder) return Promise.resolve();
        const newWidth = Math.min(params.target_width || this.#videoWidth, MAX_VIDEO_WIDTH);
        const newHeight = Math.min(params.target_height || this.#videoHeight, MAX_VIDEO_HEIGHT);
        const newFps = Math.min(params.target_fps || this.#videoFps, MAX_VIDEO_FPS);
        const unchanged = newWidth === this.#videoWidth && newHeight === this.#videoHeight && newFps === this.#videoFps;
        if (unchanged) {
            // WASM's adaptive-quality controller re-fires this event
            // frequently (often with request_keyframe set) even when
            // nothing actually needs to change on our end. Restarting the
            // whole feeder here would re-spawn ffmpeg and replay the video
            // from frame 0 every time — that's what was causing playback
            // to look "stuck"/out of order. A keyframe already recurs
            // naturally every ~1s from the encoder's own keyint setting,
            // so there's nothing to do here besides leave the feeder
            // running as-is.
            return Promise.resolve();
        }
        this.#videoWidth = newWidth;
        this.#videoHeight = newHeight;
        this.#videoFps = newFps;
        return this.#handleVideoCaptureStart({ streamId: this.#videoStreamId, width: newWidth, height: newHeight, fps: newFps });
    };
}

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { VoipClient } from './voipClient.js';
import { CallDirection, CallMediaType } from './types.js';

const RESOLUTION_PRESETS = {
    '240p': { width: 320, height: 240, frameRate: 20 },
    '360p': { width: 640, height: 360, frameRate: 30 },
    '480p': { width: 854, height: 480, frameRate: 30 },
    '720p': { width: 1280, height: 720, frameRate: 30 },
    '1080p': { width: 1920, height: 1080, frameRate: 30 },
};

function resolveVideoConfig(resolution, sourceDims) {
    if (!resolution) {
        if (!sourceDims?.width || !sourceDims?.height)
            return undefined;
        return applyOrientation(RESOLUTION_PRESETS['480p'], sourceDims);
    }
    if (typeof resolution === 'object')
        return resolution;
    const key = String(resolution).trim().toLowerCase();
    const preset = RESOLUTION_PRESETS[key];
    if (!preset) {
        const known = Object.keys(RESOLUTION_PRESETS).join(', ');
        throw new Error(`Unknown resolution "${resolution}". Use one of: ${known}, or pass { width, height, frameRate } directly.`);
    }
    return applyOrientation(preset, sourceDims);
}

function applyOrientation(preset, sourceDims) {
    if (!sourceDims?.width || !sourceDims?.height)
        return { ...preset };
    const sourceIsPortrait = sourceDims.height > sourceDims.width;
    const presetIsPortrait = preset.height > preset.width;
    if (sourceIsPortrait === presetIsPortrait)
        return { ...preset };
    return { ...preset, width: preset.height, height: preset.width };
}

const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|mkv|avi|m4v|3gp)(\?|#|$)/i;
const AUDIO_EXTENSIONS = /\.(mp3|ogg|opus|wav|m4a|aac|flac|weba)(\?|#|$)/i;

function detectKind(source) {
    if (VIDEO_EXTENSIONS.test(source))
        return 'video';
    if (AUDIO_EXTENSIONS.test(source))
        return 'audio';
    return null;
}

function isUrl(source) {
    return /^https?:\/\//i.test(source);
}

async function downloadToTemp(url, extHint, maxBytes, tmpDirOverride) {
    const axios = (await import('axios')).default;
    const response = await axios({
        method: 'get',
        url,
        responseType: 'arraybuffer',
        timeout: 30_000,
        maxContentLength: maxBytes,
        headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const os = await import('node:os');
    const tmpDir = tmpDirOverride || os.tmpdir();
    if (!fs.existsSync(tmpDir))
        fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, `voip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${extHint}`);
    fs.writeFileSync(filePath, Buffer.from(response.data));
    return filePath;
}

async function probeMedia(filePath, ffprobePath) {
    try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync(ffprobePath, [
            '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath
        ]);
        const parsed = JSON.parse(stdout);
        const duration = parsed?.format?.duration;
        const durationMs = (!duration || isNaN(duration)) ? null : Math.ceil(parseFloat(duration) * 1000);
        const videoStream = parsed?.streams?.find((s) => s.codec_type === 'video');
        let width = videoStream?.width || null;
        let height = videoStream?.height || null;
        const rotation = getEffectiveRotation(videoStream);
        if (width && height && Math.abs(rotation) % 180 === 90) {
            [width, height] = [height, width];
        }
        return { durationMs, width, height };
    }
    catch {
        return { durationMs: null, width: null, height: null };
    }
}

function getEffectiveRotation(videoStream) {
    const tagRotate = videoStream?.tags?.rotate;
    if (tagRotate !== undefined) {
        const n = parseInt(tagRotate, 10);
        if (!isNaN(n)) return ((n % 360) + 360) % 360;
    }
    const matrixSideData = videoStream?.side_data_list?.find((sd) => sd.rotation !== undefined);
    if (matrixSideData) {
        const n = Math.round(matrixSideData.rotation);
        if (!isNaN(n)) return ((n % 360) + 360) % 360;
    }
    return 0;
}

async function normalizeItem(item, ffprobePath, tmpDir) {
    let kind;
    let rawSource;
    let autoAdvance = false;
    if (typeof item === 'string') {
        rawSource = item;
        kind = detectKind(item) ?? 'audio';
    }
    else if (item && typeof item === 'object') {
        autoAdvance = !!item.autoAdvance;
        if (item.video) {
            rawSource = item.video;
            kind = 'video';
        }
        else if (item.audio) {
            rawSource = item.audio;
            kind = 'audio';
        }
        else {
            throw new Error('Playlist item must be a string, or an object with a "video" or "audio" key.');
        }
    }
    else {
        throw new Error('Playlist item must be a string or an object.');
    }
    let source = rawSource;
    let isTemp = false;
    if (isUrl(rawSource)) {
        const extHint = kind === 'video' ? '.mp4' : '.audio';
        const maxBytes = kind === 'video' ? 50 * 1024 * 1024 : 20 * 1024 * 1024;
        source = await downloadToTemp(rawSource, extHint, maxBytes, tmpDir);
        isTemp = true;
    }
    else if (!fs.existsSync(rawSource)) {
        throw new Error(`Media file not found: ${rawSource}`);
    }
    const probed = await probeMedia(source, ffprobePath);
    const durationMs = probed.durationMs ?? undefined;
    const result = { kind, source, isTemp, durationMs, autoAdvance };
    if (kind === 'video' && probed.width && probed.height) {
        result.sourceWidth = probed.width;
        result.sourceHeight = probed.height;
    }
    return result;
}

class VoipCall extends EventEmitter {
    #activeCall = null;
    #coordinator = null;
    #items;
    #index = -1;
    #ended = false;
    #onRelease;
    #autoEndCall;
    #loop;
    #onItemAdvance;
    #target;
    #autoDowngrade;
    #startVideoOnFirst;
    #videoDown = false;
    #silenced = false;
    _itemTimer = null;
    constructor(items, onRelease, opts = {}) {
        super();
        this.#items = items;
        this.#onRelease = onRelease;
        this.#autoEndCall = opts.autoEndCall === undefined ? true : !!opts.autoEndCall;
        this.#loop = !!opts.loop;
        this.#onItemAdvance = opts.onItemAdvance;
        this.#target = opts.target ?? null;
        this.#autoDowngrade = opts.autoDowngrade === undefined ? true : !!opts.autoDowngrade;
        this.#startVideoOnFirst = !!opts.startVideoOnFirst;
    }
    async _attach(activeCall) {
        this.#activeCall = activeCall;
        this.#coordinator = activeCall.coordinator;
        activeCall.on('ringing', () => this.emit('ringing'));
        activeCall.on('connected', () => {
            this.emit('connected');
            this._advance().catch((err) => this.emit('error', err));
        });
        activeCall.on('ended', (reason) => this._finish(reason));
        activeCall.on('error', (err) => this.emit('error', err));
        activeCall.on('peer_video', (change) => {
            this._onPeerVideo(change).catch((err) => this.emit('error', err));
        });
        if (activeCall.ended) {
            this._finish('ended');
            return;
        }
        if (activeCall.connected) {
            this.emit('connected');
            this._advance().catch((err) => this.emit('error', err));
        }
        for (const ev of ['peer_mute', 'hand_raise', 'reaction', 'screen_share', 'peer_video', 'inbound_audio', 'inbound_video', 'audio_finished']) {
            activeCall.on(ev, (...args) => this.emit(ev, ...args));
        }
    }
    get callId() {
        return this.#activeCall?.callId ?? null;
    }
    get target() {
        return this.#target;
    }
    mute(value = true) {
        return this.#activeCall?.setMute(value);
    }
    raiseHand(value = true) {
        return this.#activeCall?.raiseHand(value);
    }
    shareScreen(value = true) {
        return this.#activeCall?.shareScreen(value);
    }
    react(emoji) {
        return this.#activeCall?.react(emoji) ?? false;
    }
    async upgradeToVideo() {
        await this.#activeCall?.upgradeToVideo();
        this.#videoDown = false;
    }
    get isVideoDowngraded() {
        return this.#videoDown;
    }
    async _onPeerVideo(change) {
        if (!this.#autoDowngrade || this.#ended || this.#silenced || this.#videoDown)
            return;
        if (change?.direction !== 'inbound' || change.active || !change.allOff)
            return;
        const current = this.#items[this.#index];
        if (current?.kind !== 'video')
            return;
        const callId = this.#activeCall?.callId;
        if (!callId)
            return;
        this.#videoDown = true;
        try {
            await this.#coordinator.stopVideoMidCall(callId, { keepSource: true });
            this.emit('downgraded');
        }
        catch (err) {
            this.#videoDown = false;
            throw new Error(`Failed to downgrade call to audio: ${err?.message || err}`);
        }
    }

    async _advance() {
        if (this.#silenced)
            return;
        const previous = this.#items[this.#index] ?? null;
        this.#index += 1;
        let next = this.#items[this.#index];
        if (!next) {
            if (this.#loop && this.#items.length > 0) {
                this.emit('playlist_looped');
                this.#index = 0;
                next = this.#items[0];
            }
            else {
                this.emit('playlist_ended');
                if (this.#autoEndCall) {
                    this.end().catch((err) => this.emit('error', err));
                }
                return;
            }
        }
        const isFirst = previous === null && this.#index === 0;
        if (isFirst && next.kind === 'video' && this.#startVideoOnFirst) {
            try {
                await this.#coordinator.startVideoMidCall(this.#activeCall.callId);
            }
            catch (err) {
                this.emit('error', new Error(`Failed to start video: ${err?.message || err}`));
            }
        }
        if (!isFirst) {
            const callId = this.#activeCall.callId;
            const videoRunning = previous?.kind === 'video' && !this.#videoDown;
            try {
                if (next.kind === 'video') {
                    if (previous && previous.kind === 'video') {
                        await this.#coordinator.swapVideoSource(callId, next.source);
                    }
                    else {
                        await this.#coordinator.loadVideo(callId, next.source);
                    }
                    await this.#coordinator.loadAudio(callId, next.source);
                    if (!videoRunning) {
                        await this.#coordinator.startVideoMidCall(callId);
                    }
                }
                else {
                    await this.#coordinator.loadAudio(callId, next.source);
                    if (videoRunning) {
                        await this.#coordinator.stopVideoMidCall(callId, { keepSource: true });
                    }
                }
                this.#videoDown = false;
            }
            catch (err) {
                this.emit('error', new Error(`Failed to advance to playlist item ${this.#index} (${next.kind} "${next.source}"): ${err?.message || err}`));
            }
            finally {
                if (!this.#loop) {
                    this._cleanupItem(previous);
                }
            }
        }
        this.emit('item', { index: this.#index, kind: next.kind, source: next.source });
        this.#onItemAdvance?.(next);
        if ((next.kind !== 'video' || next.autoAdvance) && next.durationMs) {
            this._itemTimer = setTimeout(() => {
                this._advance().catch((err) => this.emit('error', err));
            }, next.durationMs);
        }
    }
    _cleanupItem(item) {
        if (item?.isTemp && fs.existsSync(item.source)) {
            fs.unlink(item.source, () => { });
        }
    }
    _finish(reason) {
        if (this.#ended)
            return;
        this.#ended = true;
        if (this._itemTimer)
            clearTimeout(this._itemTimer);
        for (const item of this.#items)
            this._cleanupItem(item);
        this.#onRelease();
        this.emit('ended', reason);
    }

    async hangup() {
        if (this.#ended)
            return;
        await this.#activeCall?.end();
    }

    async silent(value) {
        if (this.#ended)
            return this.#silenced;
        const next = value === undefined ? !this.#silenced : !!value;
        if (next === this.#silenced)
            return this.#silenced;
        this.#silenced = next;
        const callId = this.#activeCall?.callId;
        if (!callId)
            return this.#silenced;
        const current = this.#items[this.#index];
        try {
            if (next) {
                await this.#coordinator.setMute(callId, true);
                if (current?.kind === 'video' && !this.#videoDown) {
                    await this.#coordinator.stopVideoMidCall(callId, { keepSource: true });
                    this.#videoDown = true;
                }
                if (this._itemTimer) {
                    clearTimeout(this._itemTimer);
                    this._itemTimer = null;
                }
            }
            else {
                await this.#coordinator.setMute(callId, false);
                if (current?.kind === 'video') {
                    await this.#coordinator.startVideoMidCall(callId);
                    this.#videoDown = false;
                }

            }
            this.emit('silent', this.#silenced);
        }
        catch (err) {
            this.#silenced = !next;
            this.emit('error', new Error(`Failed to ${next ? 'silence' : 'resume'} call: ${err?.message || err}`));
        }
        return this.#silenced;
    }
    get isSilenced() {
        return this.#silenced;
    }

    async end() {
        return this.hangup();
    }
}

export default class Voip {
    #conn;
    #client = null;
    #clientForConn = null;
    #calls = new Set();
    #pending = 0;
    #maxConcurrentCalls;
    #ffprobePath;
    #tmpDir;
    #voipLogLevel;
    constructor(conn, opts = {}) {
        this.#conn = conn;
        this.#ffprobePath = opts.ffprobePath || 'ffprobe';
        this.#voipLogLevel = opts.voipLogLevel ?? 'warn';
        this.#maxConcurrentCalls = opts.maxConcurrentCalls ?? 1;
        if (!Number.isSafeInteger(this.#maxConcurrentCalls) || this.#maxConcurrentCalls < 1)
            throw new Error('maxConcurrentCalls must be a positive integer.');
        this.#tmpDir = opts.tmpDir;
    }
    #getClient() {
        if (this.#client && this.#clientForConn === this.#conn)
            return this.#client;
        this.#client = new VoipClient({
            existingSocket: this.#conn,
            voipLogLevel: this.#voipLogLevel,
            maxConcurrentCalls: this.#maxConcurrentCalls
        });
        this.#clientForConn = this.#conn;
        return this.#client;
    }
    get calls() {
        return [...this.#calls];
    }
    get maxConcurrentCalls() {
        return this.#maxConcurrentCalls;
    }

    #assertCapacity() {
        if (this.#calls.size + this.#pending >= this.#maxConcurrentCalls)
            throw new Error(`Maximum concurrent calls reached (${this.#maxConcurrentCalls}), wait for a call to end.`);
    }
    async call(jid, media, resolution, options = {}) {
        this.#assertCapacity();
        const targetJid = String(jid || '').replace(/\D/g, '');
        if (!targetJid)
            throw new Error('Invalid phone number / jid.');
        return this.#launch(targetJid, media, resolution, options, (client, first, videoConfig) => client.call(targetJid, {
            audioSource: first.source,
            isVideo: first.kind === 'video',
            ...(first.kind === 'video' ? { videoSource: first.source } : {}),
            durationMs: 0,
            videoConfig,
        }));
    }
    async accept(callId, media, resolution, options = {}) {
        await this.listen();
        this.#assertCapacity();
        const info = this.coordinator.getCall(callId);
        if (!info)
            throw new Error(`Unknown call ${callId}.`);
        if (!info.canAccept)
            throw new Error(`Call ${callId} cannot be accepted right now.`);
        const callIsVideo = info.mediaType === CallMediaType.Video;
        return this.#launch(info.peerJid, media, resolution, { ...options, startVideoOnFirst: !callIsVideo }, (client, first) => client.answer(callId, {
            audioSource: first.source,
            videoSource: first.kind === 'video' ? first.source : undefined,
            durationMs: 0,
        }));
    }
    async reject(callId, reason) {
        await this.listen();
        return this.coordinator.rejectCall(callId, reason);
    }
    get incoming() {
        return (this.coordinator?.getCalls() ?? []).filter((info) => info.direction === CallDirection.Incoming && info.isRinging);
    }
    onIncoming(listener) {
        const coordinator = this.#requireCoordinator();
        const wrapped = (info) => listener({
            callId: info.callId,
            jid: info.peerJid,
            creator: info.callCreator,
            isVideo: info.mediaType === CallMediaType.Video,
            canAccept: info.canAccept,
            info,
        });
        coordinator.on('call_incoming', wrapped);
        return () => coordinator.off('call_incoming', wrapped);
    }
    async #launch(targetJid, media, resolution, options, begin) {
        this.#pending++;
        let reserved = true;
        const releaseReservation = () => {
            if (!reserved)
                return;
            reserved = false;
            this.#pending--;
        };
        const items = [];
        const cleanupItems = () => {
            for (const item of items) {
                if (item?.isTemp && fs.existsSync(item.source))
                    fs.unlink(item.source, () => { });
            }
        };
        try {
            const rawItems = Array.isArray(media) ? media : [media ?? 'silence'];
            for (const raw of rawItems) {
                if (raw === 'silence' || raw == null) {
                    items.push({ kind: 'audio', source: 'silence', isTemp: false });
                    continue;
                }
                items.push(await normalizeItem(raw, this.#ffprobePath, this.#tmpDir));
            }
            const first = items[0];
            const videoConfig = resolveVideoConfig(resolution, { width: first.sourceWidth, height: first.sourceHeight });
            const client = this.#getClient();
            await client.connect();
            const safetyTimer = { handle: null };
            const scheduleSafety = (ms) => {
                if (safetyTimer.handle)
                    clearTimeout(safetyTimer.handle);
                safetyTimer.handle = setTimeout(() => {
                    call.emit('error', new Error('Safety timeout — call never reached ended/error.'));
                    this.#calls.delete(call);
                }, ms);
            };
            const rescheduleSafetyForItem = (item) => {
                const windowMs = item?.kind === 'video'
                    ? 10 * 60_000
                    : Math.max(item?.durationMs ?? 120_000, 45_000) + 60_000;
                scheduleSafety(windowMs);
            };
            const call = new VoipCall(items, () => { this.#calls.delete(call); }, {
                autoEndCall: options.autoEndCall,
                loop: options.loop,
                autoDowngrade: options.autoDowngrade,
                startVideoOnFirst: options.startVideoOnFirst,
                target: targetJid,
                onItemAdvance: rescheduleSafetyForItem,
            });
            this.#calls.add(call);
            releaseReservation();
            scheduleSafety(105_000);
            let activeCall;
            try {
                activeCall = await begin(client, first, videoConfig);
            }
            catch (err) {
                clearTimeout(safetyTimer.handle);
                call._finish('failed');
                throw err;
            }
            activeCall.on('ended', () => clearTimeout(safetyTimer.handle));
            activeCall.on('error', () => clearTimeout(safetyTimer.handle));
            await call._attach(activeCall);
            return call;
        }
        catch (err) {
            cleanupItems();
            throw err;
        }
        finally {
            releaseReservation();
        }
    }

    async callMany(targets, media, resolution, options = {}) {
        const seen = new Set();
        const list = [];
        for (const target of Array.isArray(targets) ? targets : [targets]) {
            const key = String(target ?? '').replace(/\D/g, '') || String(target ?? '');
            if (seen.has(key))
                continue;
            seen.add(key);
            list.push(target);
        }
        if (!list.length)
            throw new Error('callMany needs at least one target.');
        await this.listen();
        const settled = await Promise.allSettled(list.map((jid) => this.call(jid, media, resolution, options)));
        return settled.map((result, index) => result.status === 'fulfilled'
            ? { jid: list[index], call: result.value }
            : { jid: list[index], error: result.reason });
    }

    async listen() {
        await this.#getClient().connect();
        return this;
    }
    get coordinator() {
        return this.#client?.coordinator ?? null;
    }
    on(event, listener) {
        if (!this.coordinator)
            throw new Error('Call listen() before subscribing to voip events.');
        this.coordinator.on(event, listener);
        return this;
    }
    off(event, listener) {
        this.coordinator?.off(event, listener);
        return this;
    }
    async acceptCall(callId) {
        return this.#requireCoordinator().acceptCall(callId);
    }
    async rejectCall(callId, reason) {
        return this.#requireCoordinator().rejectCall(callId, reason);
    }
    async hangup(callId) {
        return this.#requireCoordinator().endCall(callId);
    }
    #requireCoordinator() {
        if (!this.coordinator)
            throw new Error('Call listen() first.');
        return this.coordinator;
    }
    async end(force = false) {
        if (force) {
            this.#calls.clear();
            return;
        }
        await Promise.all([...this.#calls].map((call) => call.hangup()));
    }
}

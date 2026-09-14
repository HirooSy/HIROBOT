import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { VoipClient } from './voipClient.js';

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
        // No resolution requested at all - fall back to the 480p preset's
        // long edge, oriented to match the source.
        return applyOrientation(RESOLUTION_PRESETS['480p'], sourceDims);
    }
    if (typeof resolution === 'object')
        return resolution; // explicit {width,height,...} - respect it as-is
    const key = String(resolution).trim().toLowerCase();
    const preset = RESOLUTION_PRESETS[key];
    if (!preset) {
        const known = Object.keys(RESOLUTION_PRESETS).join(', ');
        throw new Error(`Unknown resolution "${resolution}". Use one of: ${known}, or pass { width, height, frameRate } directly.`);
    }
    return applyOrientation(preset, sourceDims);
}

// Presets are defined landscape-first (e.g. 720p = 1280x720). If the source
// video is portrait, swap width/height so the call's output matches the
// source's orientation instead of always forcing landscape with pillarbox
// bars - the long edge (e.g. 1280 for 720p) still maps to whichever
// dimension is actually the longer one for this source.
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
        // Phone-recorded video is very often stored with landscape raw
        // frames plus a rotation tag/display matrix that rotates it to
        // portrait on playback - width/height above are the raw encoded
        // dimensions, not what's actually displayed. A 90 or 270 degree
        // rotation means the true displayed orientation is swapped.
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
    if (typeof item === 'string') {
        rawSource = item;
        kind = detectKind(item) ?? 'audio';
    }
    else if (item && typeof item === 'object') {
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
    const result = { kind, source, isTemp, durationMs };
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
    #silenced = false;
    _itemTimer = null;
    constructor(items, onRelease, opts = {}) {
        super();
        this.#items = items;
        this.#onRelease = onRelease;
        this.#autoEndCall = opts.autoEndCall === undefined ? true : !!opts.autoEndCall;
        this.#loop = !!opts.loop;
        this.#onItemAdvance = opts.onItemAdvance;
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
        // On loop, previous is the last item and next is item 0 again - not
        // "isFirst" in the sense of the call's very first item (that one is
        // already loaded by Voip.call() before the call connects), so the
        // normal reload-for-this-item path below still needs to run.
        const isFirst = previous === null && this.#index === 0;
        if (!isFirst) {
            const callId = this.#activeCall.callId;
            try {
                if (next.kind === 'video') {
                    await this.#coordinator.loadVideo(callId, next.source);
                    // See Voip.call()'s audioSource comment - a video
                    // file's audio track has to be loaded into the audio
                    // engine separately, WaVideoEngine only handles the
                    // video stream.
                    await this.#coordinator.loadAudio(callId, next.source);
                    if (!previous || previous.kind !== 'video') {
                        await this.#coordinator.startVideoMidCall(callId);
                    }
                }
                else {
                    await this.#coordinator.loadAudio(callId, next.source);
                    if (previous && previous.kind === 'video') {

                        await this.#coordinator.stopVideoMidCall(callId, { keepSource: true });
                    }
                }
            }
            catch (err) {
                this.emit('error', new Error(`Failed to advance to playlist item ${this.#index} (${next.kind} "${next.source}"): ${err?.message || err}`));
            }
            finally {
                // Temp files (downloaded URLs) must survive if we might loop
                // back to them later - only _finish() cleans those up.
                if (!this.#loop) {
                    this._cleanupItem(previous);
                }
            }
        }
        this.emit('item', { index: this.#index, kind: next.kind, source: next.source });
        this.#onItemAdvance?.(next);
        // Video items loop forever on their own (video via ffmpeg
        // -stream_loop -1, its paired audio via WaAudioEngine's loopMode -
        // see WaCallMediaSession.loadVideo()), so there's no natural
        // "finished" point to advance on and no need to reload on a timer.
        // Only single-shot audio items need this to move the playlist along.
        if (next.kind !== 'video' && next.durationMs) {
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
                if (current?.kind === 'video') {
                    await this.#coordinator.stopVideoMidCall(callId, { keepSource: true });
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
    #active = null;
    #ffprobePath;
    #tmpDir;
    #voipLogLevel;
    constructor(conn, opts = {}) {
        this.#conn = conn;
        this.#ffprobePath = opts.ffprobePath || 'ffprobe';
        this.#voipLogLevel = opts.voipLogLevel ?? 'warn';

        this.#tmpDir = opts.tmpDir;
    }
    #getClient() {
        if (this.#client && this.#clientForConn === this.#conn)
            return this.#client;
        this.#client = new VoipClient({ existingSocket: this.#conn, voipLogLevel: this.#voipLogLevel });
        this.#clientForConn = this.#conn;
        return this.#client;
    }

    async call(jid, media, resolution, options = {}) {
        if (this.#active)
            throw new Error('A call is already in progress, wait for it to finish.');
        const targetJid = String(jid || '').replace(/\D/g, '');
        if (!targetJid)
            throw new Error('Invalid phone number / jid.');
        const rawItems = Array.isArray(media) ? media : [media ?? 'silence'];
        const items = [];
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
                this.#active = null;
            }, ms);
        };
        const rescheduleSafetyForItem = (item) => {
            // Video items loop forever on their own (ffmpeg -stream_loop -1)
            // for as long as this item is active, so their real duration
            // isn't item.durationMs - give them a generous flat window
            // instead. Audio items are one-shot, so their own duration (plus
            // margin) is the right window. Called on every item advance
            // (including the first, right after connect), so this replaces
            // the old one-shot "schedule once on connected" logic - needed
            // for loop:true and any playlist that outlives its first item.
            const windowMs = item?.kind === 'video'
                ? 10 * 60_000
                : Math.max(item?.durationMs ?? 120_000, 45_000) + 60_000;
            scheduleSafety(windowMs);
        };
        const call = new VoipCall(items, () => { this.#active = null; }, {
            autoEndCall: options.autoEndCall,
            loop: options.loop,
            onItemAdvance: rescheduleSafetyForItem,
        });
        this.#active = call;
        scheduleSafety(105_000);
        let activeCall;
        try {
            activeCall = await client.call(targetJid, {
                // A video file's own audio track is the audio source too -
                // WaVideoEngine strips audio when encoding the video stream
                // (-an), so without this the video plays silently even
                // though the source file has sound. WaAudioEngine decodes
                // via ffmpeg, which extracts the audio track from a video
                // container the same as it would a plain audio file.
                audioSource: first.source,
                isVideo: first.kind === 'video',
                ...(first.kind === 'video' ? { videoSource: first.source } : {}),
                durationMs: 0,
                videoConfig,
            });
        }
        catch (err) {
            clearTimeout(safetyTimer.handle);
            this.#active = null;
            throw err;
        }
        activeCall.on('ended', () => clearTimeout(safetyTimer.handle));
        activeCall.on('error', () => clearTimeout(safetyTimer.handle));
        await call._attach(activeCall);

        return call;
    }

    async end(force = false) {
        if (!this.#active) {
            return;
        }
        if (force) {
            this.#active = null;
            return;
        }
        await this.#active.hangup();
    }
}

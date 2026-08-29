export var CallState;
(function (CallState) {
    CallState["Initiating"] = "initiating";
    CallState["Ringing"] = "ringing";
    CallState["IncomingRinging"] = "incoming_ringing";
    CallState["Connecting"] = "connecting";
    CallState["Active"] = "active";
    CallState["OnHold"] = "on_hold";
    CallState["Ended"] = "ended";
})(CallState || (CallState = {}));
export var CallDirection;
(function (CallDirection) {
    CallDirection["Outgoing"] = "outgoing";
    CallDirection["Incoming"] = "incoming";
})(CallDirection || (CallDirection = {}));
export var CallMediaType;
(function (CallMediaType) {
    CallMediaType["Audio"] = "audio";
    CallMediaType["Video"] = "video";
})(CallMediaType || (CallMediaType = {}));
export var EndCallReason;
(function (EndCallReason) {
    EndCallReason["UserEnded"] = "user_ended";
    EndCallReason["Declined"] = "declined";
    EndCallReason["Timeout"] = "timeout";
    EndCallReason["Busy"] = "busy";
    EndCallReason["Cancelled"] = "cancelled";
    EndCallReason["Failed"] = "failed";
    EndCallReason["DoNotDisturb"] = "do_not_disturb";
    EndCallReason["Unknown"] = "unknown";
})(EndCallReason || (EndCallReason = {}));
export var PayloadType;
(function (PayloadType) {
    PayloadType[PayloadType["WhatsAppOpus"] = 120] = "WhatsAppOpus";
    // WhatsApp video (H.264) RTP payload type. Source of truth: meowcaller's
    // rtp.RtpPayloadTypeH264 / WaCalls internal/voip/core/types.go.
    PayloadType[PayloadType["H264"] = 97] = "H264";
})(PayloadType || (PayloadType = {}));
export const DEFAULT_VIDEO_CONFIG = {
    // Was 640x360@15fps. Real video now reaches the peer (SSRC slot fix), but on
    // this container's limited CPU, real-time libx264 encoding at that size
    // couldn't keep up smoothly even at "ultrafast" — reported as stutter/lag.
    // fps is pinned at 15 (the floor asked for — not going lower); resolution is
    // dropped hard instead to claw back the CPU budget, since pixel count scales
    // encode cost roughly linearly and this is a ~4x cut from 640x360. Hardcoded
    // here rather than env-configurable, per instruction — raise width/height
    // back up directly in this file if a beefier container is used later.
    width: 320,
    height: 180,
    frameRate: 15,
    // 90kHz is the standard RTP video clock (independent of frameRate).
    clockRate: 90000
};
export const DEFAULT_AUDIO_CONFIG = {
    sampleRate: 16000,
    captureChunkSize: 960,
    playbackOutputSize: 256,
    maxBufferSize: 1600,
    intervalMs: 60
};
export const SRTP_SEND_AUTH_TAG_LEN = 4;
export const SRTP_RECV_AUTH_TAG_LEN = 4;
export const SRTP_AUTH_TAG_LEN = 4;
export const SRTP_LABEL = {
    ENCRYPTION: 0x00,
    AUTH: 0x01,
    SALT: 0x02
};
export const WA_RELAY_PORT = 3480;
export const WA_DTLS_FINGERPRINT = 'sha-256 F9:CA:0C:98:A3:CC:71:D6:42:CE:5A:E2:53:D2:15:20:D3:1B:BA:D8:57:A4:F0:AF:BE:0B:FB:F3:6B:0C:A0:68';

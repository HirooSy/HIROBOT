import { generateCallStanzaId } from './signaling.js';

function tryAsNumber(value) {
    if (value === undefined || value === null || value === '')
        return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

export const WA_SCREEN_SHARE_STATE = Object.freeze({
    NotSupported: 0,
    Started: 1,
    Stopped: 2,
    Failed: 3
});

export const WA_SCREEN_SHARE_VERSION = Object.freeze({
    Invalid: -1,
    Legacy: 0,
    V1: 1,
    V2: 2,
    V3: 3,
    V4: 4
});

export const WA_SCREEN_SHARE_SEND_VERSION = WA_SCREEN_SHARE_VERSION.V2;

export function parseScreenShareNode(node) {
    const attrs = node.attrs ?? {};
    const state = tryAsNumber(attrs.screenshare_state);
    const requestState = tryAsNumber(attrs['request-state'] ?? attrs.request_state);
    if (state === null && requestState === null)
        return null;
    return {
        state,
        requestState,
        version: tryAsNumber(attrs.version),
        screenWidth: tryAsNumber(attrs.screen_width),
        screenHeight: tryAsNumber(attrs.screen_height),
        deviceOrientation: tryAsNumber(attrs.device_orientation)
    };
}

export function buildScreenShareStanza(peerDeviceJid, callId, callCreator, screenShareState) {
    return {
        tag: 'call',
        attrs: { to: peerDeviceJid, id: generateCallStanzaId() },
        content: [
            {
                tag: 'screen_share',
                attrs: {
                    'call-id': callId,
                    'call-creator': callCreator,
                    screenshare_state: String(screenShareState),
                    version: String(WA_SCREEN_SHARE_SEND_VERSION)
                }
            }
        ]
    };
}

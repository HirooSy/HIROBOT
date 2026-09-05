import { hkdf } from '../shim/crypto.js';
import { readUInt32LE, TEXT_ENCODER, writeUInt32LE } from '../bytes.js';
export function generateSecureSsrc(callId, selfJid, counter = 0) {
    const key = TEXT_ENCODER.encode(callId);
    const salt = new Uint8Array(4);
    writeUInt32LE(salt, counter, 0);
    const info = TEXT_ENCODER.encode(selfJid);
    const result = hkdf(key, salt, info, 4);
    return readUInt32LE(result, 0);
}
// The 9-stream relay allocate plan (source of truth: meowcaller's
// rtp/ssrc.go WasmRelayStreamSlotWords, itself sourced from
// oxidezap/whatsapp-rust's wacore/src/voip/ssrc.rs). Index i of the
// returned array is the SSRC for relay stream slot i — NOT slot word i;
// WASM_RELAY_STREAM_SLOT_WORDS[i] is the slot *word* (the HKDF salt)
// generateSecureSsrc's counter derives that stream's SSRC from. Slot 0
// (word 0) is always this participant's audio; slot 3 (word 2) is always
// this participant's video — see VideoSlotWord's own comment elsewhere in
// this codebase for why video is word 2, not word 1.
export const WASM_RELAY_STREAM_SLOT_WORDS = [0, 1, 4, 2, 3, 5, 7, 8, 6];
export function deriveWasmRelayStreamSsrcs(callId, participantId) {
    return WASM_RELAY_STREAM_SLOT_WORDS.map((slotWord) => generateSecureSsrc(callId, participantId, slotWord));
}

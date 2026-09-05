import { writeUInt16BE, writeUInt32BE } from '../bytes.js';
import { randomBytes } from '../crypto/primitives.js';

export const RTCP_PT = {
    SR: 200,
    SDES: 202
};

const NTP_UNIX_OFFSET_SECS = 2208988800;
const WHATSAPP_RTCP_CNAME_LEN = 18;

const HEX_CHARS = '0123456789abcdef';

/**
 * Builds WhatsApp's native 18-byte randomized CNAME: 5 random hex chars,
 * literal "@pj", 6 more random hex chars, literal ".org". Ported from
 * rtp.BuildWhatsappRtcpCname — the exact hex-nibble source layout matters
 * (it reads nibbles from a 12-byte entropy buffer starting at byte 6, not a
 * simple hex-encode of the whole buffer).
 */
export function buildWhatsappRtcpCname(entropy) {
    const randomHex = new Array(11);
    for (let nibble = 0; nibble < 11; nibble++) {
        const b = entropy[6 + Math.floor(nibble / 2)];
        randomHex[nibble] = (nibble & 1) === 0 ? HEX_CHARS[b >> 4] : HEX_CHARS[b & 0x0f];
    }
    const cname = new Uint8Array(WHATSAPP_RTCP_CNAME_LEN);
    const encoder = new TextEncoder();
    cname.set(encoder.encode(randomHex.slice(0, 5).join('')), 0);
    cname.set(encoder.encode('@pj'), 5);
    cname.set(encoder.encode(randomHex.slice(5).join('')), 8);
    cname.set(encoder.encode('.org'), 14);
    return cname;
}

/** Builds the 28-byte Sender Report (PT 200, RC=0). nowMs is wall-clock ms. */
export function buildSenderReport(localSsrc, stats, nowMs) {
    const buf = new Uint8Array(28);
    buf[0] = 0x80; // V=2, P=0, RC=0
    buf[1] = RTCP_PT.SR;
    buf[3] = 6; // (6+1)*4 = 28 bytes
    writeUInt32BE(buf, localSsrc, 4);
    const ntpSec = Math.floor(nowMs / 1000) + NTP_UNIX_OFFSET_SECS;
    const ntpFrac = Math.round(((nowMs % 1000) / 1000) * 4294967296);
    writeUInt32BE(buf, ntpSec >>> 0, 8);
    writeUInt32BE(buf, ntpFrac >>> 0, 12);
    writeUInt32BE(buf, stats.rtpTimestamp >>> 0, 16);
    writeUInt32BE(buf, stats.packetsSent >>> 0, 20);
    writeUInt32BE(buf, stats.octetsSent >>> 0, 24);
    return buf;
}

/** Builds WhatsApp's one-chunk SDES packet (32 bytes: 8-byte header + PID
 * chunk + 18-byte CNAME, no padding needed since 8+2+18+4(ssrc) already
 * lands on a 4-byte boundary). */
export function buildSourceDescription(localSsrc, cname) {
    const packet = new Uint8Array(32);
    packet[0] = 0x81; // V=2, P=0, SC=1
    packet[1] = RTCP_PT.SDES;
    writeUInt16BE(packet, 7, 2); // length = (7+1)*4 = 32 bytes
    writeUInt32BE(packet, localSsrc, 4);
    packet[8] = 1; // CNAME item type
    packet[9] = WHATSAPP_RTCP_CNAME_LEN;
    packet.set(cname, 10);
    return packet;
}

/**
 * Builds WhatsApp's periodic compound SR+SDES packet — the two RTCP packets
 * concatenated back to back, exactly as sent as one SRTCP-protected unit.
 * Ported from meowcaller's BuildSenderReportWithSdes (no reception-report
 * block: this is the 1:1, receiver-report-less variant — our own send-only
 * implementation never tracks a reception report to attach).
 */
export function buildSenderReportWithSdes(localSsrc, stats, nowMs, cname) {
    const sr = buildSenderReport(localSsrc, stats, nowMs);
    const sdes = buildSourceDescription(localSsrc, cname);
    const out = new Uint8Array(sr.length + sdes.length);
    out.set(sr, 0);
    out.set(sdes, sr.length);
    return out;
}

/** Generates a fresh CNAME from random entropy — call once per call/SSRC, not per report. */
export function generateWhatsappRtcpCname() {
    return buildWhatsappRtcpCname(randomBytes(12));
}

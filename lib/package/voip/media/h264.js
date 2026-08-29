// H.264 RTP packetization (RFC 6184) for WhatsApp video calls.
//
// Ported from meowcaller's rtp/h264.go (itself ported from WaCalls, MIT), which is the
// same reference the rest of this voip/ package already follows for signaling and audio.
// Source of truth: https://github.com/purpshell/meowcaller/blob/main/rtp/h264.go

const H264_STAP_A_TYPE = 24; // STAP-A aggregation packet NAL type (RFC 6184 §5.7.1) — unused on send, kept for completeness
const H264_FUA_TYPE = 28; // FU-A fragmentation unit NAL type (RFC 6184 §5.8)
const MTU_PAYLOAD_MAX = 800;

/** Reports whether an Annex-B access unit contains an IDR NAL unit (type 5). */
export function auHasIDR(au) {
  for (const nalu of splitAnnexB(au)) {
    if (nalu.length > 0 && (nalu[0] & 0x1f) === 5) return true;
  }
  return false;
}

/**
 * Splits one NAL unit into RTP payloads: a single payload when it fits the MTU
 * budget, else FU-A fragments. Mirrors meowcaller's PackageH264NALU exactly —
 * WhatsApp expects the ENTIRE access unit's NALs (already concatenated with
 * start codes between them, see buildAccessUnitPayload below) fragmented as if
 * it were one oversized NAL, not each NAL fragmented separately.
 */
export function packageH264NALU(nalu) {
  if (!nalu || nalu.length === 0) return [];
  if (nalu.length <= MTU_PAYLOAD_MAX) {
    return [nalu.slice()];
  }
  const naluHeader = nalu[0];
  const fbitAndNri = naluHeader & 0xe0;
  const originalType = naluHeader & 0x1f;
  const fuIndicator = fbitAndNri | H264_FUA_TYPE;

  const body = nalu.subarray(1);
  const fragSize = MTU_PAYLOAD_MAX - 2;

  const out = [];
  let offset = 0;
  while (offset < body.length) {
    const end = Math.min(offset + fragSize, body.length);
    const chunk = body.subarray(offset, end);

    let fuHeader = originalType;
    if (offset === 0) fuHeader |= 0x80;
    if (end === body.length) fuHeader |= 0x40;

    const pkt = new Uint8Array(2 + chunk.length);
    pkt[0] = fuIndicator;
    pkt[1] = fuHeader;
    pkt.set(chunk, 2);
    out.push(pkt);

    offset = end;
  }
  return out;
}

function annexBStartCodeLen(data, offset) {
  if (
    offset + 3 < data.length &&
    data[offset] === 0 &&
    data[offset + 1] === 0 &&
    data[offset + 2] === 0 &&
    data[offset + 3] === 1
  ) {
    return 4;
  }
  if (offset + 2 < data.length && data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 1) {
    return 3;
  }
  return 0;
}

/**
 * Splits an Annex-B byte stream (00 00 01 / 00 00 00 01 start codes) into its
 * constituent NAL units, trimming trailing zero bytes before each start code.
 */
export function splitAnnexB(data) {
  const nalus = [];
  let start = -1;
  let i = 0;
  while (i < data.length) {
    const sc = annexBStartCodeLen(data, i);
    if (sc > 0) {
      if (start >= 0) {
        let end = i;
        while (end > start && data[end - 1] === 0) end--;
        if (end > start) nalus.push(data.subarray(start, end));
      }
      i += sc;
      start = i;
      continue;
    }
    i++;
  }
  if (start >= 0 && start < data.length) nalus.push(data.subarray(start));
  return nalus;
}

/**
 * Builds the single combined "NAL" WhatsApp expects for one access unit: every
 * real NAL (Access Unit Delimiter, type 9, stripped) concatenated with 4-byte
 * Annex-B start codes between them (not before the first). Matches
 * meowcaller's videoSender.protectAccessUnitLocked exactly.
 */
export function buildAccessUnitPayload(au) {
  const nalus = splitAnnexB(au);
  const parts = [];
  for (const n of nalus) {
    if (n.length === 0 || (n[0] & 0x1f) === 9) continue;
    if (parts.length > 0) parts.push(Uint8Array.of(0, 0, 0, 1));
    parts.push(n);
  }
  if (parts.length === 0) return null;
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

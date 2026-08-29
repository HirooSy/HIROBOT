import { EMPTY_BYTES, readUInt16BE, readUInt32BE, writeUInt16BE, writeUInt32BE } from '../bytes.js';
import { randomInt } from '../crypto/primitives.js';
import { PayloadType } from '../types.js';
const RTP_VERSION = 2;
const MIN_HEADER_SIZE = 12;
export class RtpHeader {
    version = RTP_VERSION;
    padding = false;
    extension = false;
    marker = false;
    payloadType;
    sequenceNumber;
    timestamp;
    ssrc;
    csrc = [];
    extensionProfile = 0;
    extensionData = EMPTY_BYTES;
    get csrcCount() {
        return this.csrc.length;
    }
    constructor(payloadType, sequenceNumber, timestamp, ssrc) {
        this.payloadType = payloadType;
        this.sequenceNumber = sequenceNumber;
        this.timestamp = timestamp;
        this.ssrc = ssrc;
    }
    size() {
        let s = MIN_HEADER_SIZE + this.csrcCount * 4;
        if (this.extension) {
            s += 4 + this.extensionData.length;
        }
        return s;
    }
    encode(buf) {
        if (buf.length < this.size()) {
            throw new Error('buffer too small for RTP header');
        }
        buf[0] =
            ((this.version & 0x03) << 6) |
                ((this.padding ? 1 : 0) << 5) |
                ((this.extension ? 1 : 0) << 4) |
                (this.csrcCount & 0x0f);
        buf[1] = ((this.marker ? 1 : 0) << 7) | (this.payloadType & 0x7f);
        writeUInt16BE(buf, this.sequenceNumber, 2);
        writeUInt32BE(buf, this.timestamp, 4);
        writeUInt32BE(buf, this.ssrc, 8);
        let offset = 12;
        for (let i = 0; i < this.csrc.length; i++) {
            writeUInt32BE(buf, this.csrc[i], offset);
            offset += 4;
        }
        if (this.extension) {
            if (this.extensionData.length % 4 !== 0) {
                throw new Error('RTP extension data must be 32-bit aligned');
            }
            writeUInt16BE(buf, this.extensionProfile, offset);
            writeUInt16BE(buf, this.extensionData.length / 4, offset + 2);
            buf.set(this.extensionData, offset + 4);
        }
        return this.size();
    }
    static decode(buf) {
        if (buf.length < MIN_HEADER_SIZE) {
            throw new Error('buffer too small for RTP header');
        }
        const version = (buf[0] >> 6) & 0x03;
        if (version !== RTP_VERSION) {
            throw new Error(`invalid RTP version: ${version}`);
        }
        const padding = ((buf[0] >> 5) & 0x01) !== 0;
        const extension = ((buf[0] >> 4) & 0x01) !== 0;
        const csrcCount = buf[0] & 0x0f;
        const marker = ((buf[1] >> 7) & 0x01) !== 0;
        const payloadType = buf[1] & 0x7f;
        const sequenceNumber = readUInt16BE(buf, 2);
        const timestamp = readUInt32BE(buf, 4);
        const ssrc = readUInt32BE(buf, 8);
        const headerSize = MIN_HEADER_SIZE + csrcCount * 4;
        if (buf.length < headerSize) {
            throw new Error('buffer too small for CSRC list');
        }
        const csrc = [];
        let offset = 12;
        for (let i = 0; i < csrcCount; i++) {
            csrc.push(readUInt32BE(buf, offset));
            offset += 4;
        }
        const header = new RtpHeader(payloadType, sequenceNumber, timestamp, ssrc);
        header.version = version;
        header.padding = padding;
        header.extension = extension;
        header.marker = marker;
        header.csrc = csrc;
        if (extension) {
            if (buf.length < offset + 4) {
                throw new Error('buffer too small for RTP extension header');
            }
            header.extensionProfile = readUInt16BE(buf, offset);
            const extWords = readUInt16BE(buf, offset + 2);
            const extBytes = extWords * 4;
            offset += 4;
            if (buf.length < offset + extBytes) {
                throw new Error('buffer too small for RTP extension data');
            }
            header.extensionData = buf.slice(offset, offset + extBytes);
        }
        return header;
    }
}
export class RtpPacket {
    header;
    payload;
    constructor(header, payload) {
        this.header = header;
        this.payload = payload;
    }
    size() {
        return this.header.size() + this.payload.length;
    }
    encode() {
        const buf = new Uint8Array(this.size());
        const headerSize = this.header.encode(buf);
        buf.set(this.payload, headerSize);
        return buf;
    }
    static decode(buf) {
        const header = RtpHeader.decode(buf);
        let end = buf.length;
        if (header.padding) {
            const padLen = buf[buf.length - 1];
            if (padLen > 0 && header.size() + padLen <= buf.length) {
                end = buf.length - padLen;
            }
        }
        const payload = buf.slice(header.size(), end);
        return new RtpPacket(header, payload);
    }
}
// WhatsApp's one-byte-header (RFC 5285) video RTP extension, carried under the
// same 0xdebe profile as the audio WARP extension. Ported from meowcaller's
// rtp.VideoRtpExtension.encode() / VideoRtpStream — same source of truth as
// media/h264.js. MediaFrameInfo low bits mark IDR/delta; the two low bits are
// also read by the peer as display-orientation quarter-turns, so 0 = no
// rotation which is what we always send (device_orientation is fixed at "0"
// in the signaling stanzas too).
export const VideoMediaFrameInfo = { IDR: 0x08, Delta: 0x20 };
const DEFAULT_VIDEO_RTP_STEP_SAMPLES = Math.round(90000 / 30);

/** Converts a real inter-frame duration to 90kHz RTP timestamp samples. */
export function videoRtpDurationSamples(durationMs) {
  if (!durationMs || durationMs <= 0) return DEFAULT_VIDEO_RTP_STEP_SAMPLES;
  const samples = Math.round((durationMs * 90000) / 1000);
  return samples || DEFAULT_VIDEO_RTP_STEP_SAMPLES;
}

function encodeWhatsappVideoExtension(ext) {
  const hasFrameNumber = ext.frameNumber !== null && ext.frameNumber !== undefined;
  const out = [];
  out.push(0x30 | ((hasFrameNumber ? 3 : 1) - 1), ext.mediaFrameInfo & 0xff);
  if (hasFrameNumber) {
    out.push((ext.frameNumber >>> 8) & 0xff, ext.frameNumber & 0xff);
  }
  out.push(0x51, (ext.initialBandwidth >>> 8) & 0xff, ext.initialBandwidth & 0xff);
  out.push(0x61, (ext.shortOffset >>> 8) & 0xff, ext.shortOffset & 0xff);
  out.push(0x91, (ext.transportSequence >>> 8) & 0xff, ext.transportSequence & 0xff);
  while (out.length % 4 !== 0) out.push(0);
  return new Uint8Array(out);
}

/**
 * Sequences WhatsApp video packets: all RTP packets belonging to one access
 * unit share a timestamp, and the 90kHz clock only advances on the
 * last-in-access-unit (marker) packet. Ported from meowcaller's
 * rtp.VideoRtpStream — see media/h264.js header for the source repo.
 */
export class VideoRtpStream {
  ssrc;
  sequenceNumber;
  timestamp;
  tsStride;
  transportSequence = 0;
  frameNumber = 1;
  firstPacket = true;
  constructor(ssrc, tsStride) {
    this.ssrc = ssrc;
    this.sequenceNumber = randomInt(0, 65536);
    this.timestamp = randomInt(0, 0xffffffff);
    this.tsStride = tsStride;
  }
  setTimestampStride(tsStride) {
    if (!tsStride) return false;
    this.tsStride = tsStride;
    return true;
  }
  /** Builds the next RTP header for one payload chunk of the current access unit. */
  nextPacket(lastInAccessUnit, mediaFrameInfo) {
    const frameNumber = this.firstPacket ? this.frameNumber : null;
    const ext = {
      mediaFrameInfo,
      frameNumber,
      initialBandwidth: 0,
      shortOffset: 0,
      transportSequence: this.transportSequence
    };
    const header = new RtpHeader(PayloadType.H264, this.sequenceNumber, this.timestamp, this.ssrc);
    header.marker = lastInAccessUnit;
    header.extension = true;
    header.extensionProfile = 0xdebe;
    header.extensionData = encodeWhatsappVideoExtension(ext);
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
    this.transportSequence = (this.transportSequence + 1) & 0xffff;
    if (lastInAccessUnit) {
      this.timestamp = (this.timestamp + this.tsStride) >>> 0;
      this.frameNumber = (this.frameNumber + 1) & 0xffff;
      this.firstPacket = true;
    } else {
      this.firstPacket = false;
    }
    return header;
  }
}

export class RtpSession {
    ssrc;
    payloadType;
    sequenceNumber;
    sampleRate;
    timestamp;
    samplesPerPacket;
    constructor(ssrc, payloadType, sampleRate, samplesPerPacket) {
        this.ssrc = ssrc;
        this.payloadType = payloadType;
        this.sequenceNumber = randomInt(0, 65536);
        this.sampleRate = sampleRate;
        this.timestamp = randomInt(0, 0xffffffff);
        this.samplesPerPacket = samplesPerPacket;
    }
    static whatsappOpus(ssrc) {
        return new RtpSession(ssrc, PayloadType.WhatsAppOpus, 16000, 960);
    }
    createPacket(payload, marker = false) {
        const header = new RtpHeader(this.payloadType, this.sequenceNumber, this.timestamp, this.ssrc);
        header.marker = marker;
        this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
        this.timestamp = (this.timestamp + this.samplesPerPacket) >>> 0;
        return new RtpPacket(header, payload);
    }
    createPacketWithDuration(payload, durationSamples, marker = false) {
        const header = new RtpHeader(this.payloadType, this.sequenceNumber, this.timestamp, this.ssrc);
        header.marker = marker;
        this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
        this.timestamp = (this.timestamp + durationSamples) >>> 0;
        return new RtpPacket(header, payload);
    }
}

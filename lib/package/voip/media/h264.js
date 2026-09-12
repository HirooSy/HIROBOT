const H264_STAP_A_TYPE = 24; 
const H264_FUA_TYPE = 28;
const MTU_PAYLOAD_MAX = 800;

export function auHasIDR(au) {
  for (const nalu of splitAnnexB(au)) {
    if (nalu.length > 0 && (nalu[0] & 0x1f) === 5) return true;
  }
  return false;
}

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

const MAX_FU_REASSEMBLY_BYTES = 4 << 20;
const MAX_ACCESS_UNIT_BYTES = 8 << 20;

export class H264Depacketizer {
  fuBuf = new Uint8Array(0);
  fuActive = false;
  overflow = false;

  depacketize(payload) {
    if (!payload || payload.length < 1) return [];
    const naluType = payload[0] & 0x1f;
    const fbitAndNri = payload[0] & 0xe0;

    if (naluType >= 1 && naluType <= 23) {
      this.fuActive = false;
      return [payload.slice()];
    }

    if (naluType === H264_STAP_A_TYPE) {
      this.fuActive = false;
      let body = payload.subarray(1);
      const out = [];
      while (body.length >= 2) {
        const size = (body[0] << 8) | body[1];
        body = body.subarray(2);
        if (size <= 0 || size > body.length) return out;
        out.push(body.slice(0, size));
        body = body.subarray(size);
      }
      return out;
    }

    if (naluType === H264_FUA_TYPE) {
      if (payload.length < 2) {
        this.fuActive = false;
        return [];
      }
      const fuHeader = payload[1];
      const startBit = fuHeader & 0x80;
      const endBit = fuHeader & 0x40;
      const origType = fuHeader & 0x1f;
      const body = payload.subarray(2);

      if (startBit !== 0) {
        if (1 + body.length > MAX_FU_REASSEMBLY_BYTES) {
          this.fuActive = false;
          this.fuBuf = new Uint8Array(0);
          this.overflow = true;
          return [];
        }
        this.fuActive = true;
        this.fuBuf = new Uint8Array(1 + body.length);
        this.fuBuf[0] = fbitAndNri | origType;
        this.fuBuf.set(body, 1);
      } else if (this.fuActive) {
        if (this.fuBuf.length + body.length > MAX_FU_REASSEMBLY_BYTES) {
          this.fuActive = false;
          this.fuBuf = new Uint8Array(0);
          this.overflow = true;
          return [];
        }
        const merged = new Uint8Array(this.fuBuf.length + body.length);
        merged.set(this.fuBuf, 0);
        merged.set(body, this.fuBuf.length);
        this.fuBuf = merged;
      } else {
        return [];
      }

      if (endBit !== 0 && this.fuActive) {
        this.fuActive = false;
        const out = this.fuBuf;
        this.fuBuf = new Uint8Array(0);
        return [out];
      }
      return [];
    }

    this.fuActive = false;
    return [];
  }
}

export class H264AccessUnitAssembler {
  depacketizer = new H264Depacketizer();
  accessUnit = new Uint8Array(0);
  expectedSeq = 0;
  hasSequence = false;
  keyframeNeeded = false;

  reset() {
    this.depacketizer = new H264Depacketizer();
    this.accessUnit = new Uint8Array(0);
  }

  push(sequence, marker, payload) {
    let recoveryNeeded = false;
    if (this.hasSequence && sequence !== this.expectedSeq) {
      recoveryNeeded = !this.keyframeNeeded;
      this.reset();
      this.keyframeNeeded = true;
    }
    this.hasSequence = true;
    this.expectedSeq = (sequence + 1) & 0xffff;

    for (const nalu of this.depacketizer.depacketize(payload)) {
      if (this.accessUnit.length + 4 + nalu.length > MAX_ACCESS_UNIT_BYTES) {
        recoveryNeeded = recoveryNeeded || !this.keyframeNeeded;
        this.reset();
        this.keyframeNeeded = true;
        break;
      }
      const merged = new Uint8Array(this.accessUnit.length + 4 + nalu.length);
      merged.set(this.accessUnit, 0);
      merged.set([0, 0, 0, 1], this.accessUnit.length);
      merged.set(nalu, this.accessUnit.length + 4);
      this.accessUnit = merged;
    }
    if (this.depacketizer.overflow) {
      recoveryNeeded = recoveryNeeded || !this.keyframeNeeded;
      this.reset();
      this.keyframeNeeded = true;
    }
    if (!marker) {
      return [null, false, recoveryNeeded];
    }

    const accessUnit = this.accessUnit;
    this.reset();
    if (accessUnit.length === 0) {
      return [null, false, recoveryNeeded];
    }
    if (this.keyframeNeeded) {
      if (!auHasIDR(accessUnit)) {
        return [null, false, recoveryNeeded];
      }
      this.keyframeNeeded = false;
    }
    return [accessUnit, true, recoveryNeeded];
  }
}
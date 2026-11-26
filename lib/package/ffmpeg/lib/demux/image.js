import { badData } from '../errors.js';
import { detectImage, probeImage, codecNames } from '../image/index.js';

class ImageDemuxer {
  static probe(head) {
    return detectImage(head) !== null;
  }

  static async open(reader) {
    const demuxer = new ImageDemuxer(reader);
    await demuxer.init();
    return demuxer;
  }

  constructor(reader) {
    this.reader = reader;
    this.format = 'image2';
    this.tags = {};
    this.streams = [];
    this.duration = 0;
    this.data = null;
    this.sent = false;
  }

  async init() {
    const r = this.reader;
    r.seek(0);
    this.data = await r.readExact(r.size);
    const info = probeImage(this.data);
    if (!info) throw badData('unrecognized image');
    this.kind = info.format;
    this.streams.push({ index: 0, type: 'video', codec: codecNames[info.format], width: info.width, height: info.height, timeScale: 1, frameRate: 0 });
  }

  async readPacket() {
    if (this.sent) return null;
    this.sent = true;
    return { stream: 0, data: this.data, pts: 0, dts: 0, duration: 1, keyframe: true };
  }

  async close() {
    this.data = null;
    await this.reader.close();
  }
}

export { ImageDemuxer };

import { writeUInt32BE, writeBigUInt64BE } from '../bytes.js';
import { aesCtr128, hmacSha1 } from './primitives.js';
import { RTCP_AUTH_TAG_LEN, SRTCP_LABEL } from '../types.js';

const RTCP_HEADER_LEN = 8;

function deriveKey(masterKey, masterSalt, label, length) {
    const iv = new Uint8Array(16);
    iv.set(masterSalt.subarray(0, 14), 0);
    iv[7] ^= label;
    const zeros = new Uint8Array(length);
    return aesCtr128(masterKey, iv, zeros);
}

export class SrtcpSendContext {
    #cipherKey;
    #authKey;
    #salt;
    #index = 1;
    #ssrcBuffer = new Uint8Array(4);
    #ivBuffer = new Uint8Array(16);
    #indexBuffer = new Uint8Array(8);

    constructor(keying) {
        this.#cipherKey = deriveKey(keying.masterKey, keying.masterSalt, SRTCP_LABEL.ENCRYPTION, 16);
        this.#authKey = deriveKey(keying.masterKey, keying.masterSalt, SRTCP_LABEL.AUTH, 20);
        this.#salt = deriveKey(keying.masterKey, keying.masterSalt, SRTCP_LABEL.SALT, 14);
    }

    #generateIv(ssrc, roc, seq) {
        this.#ivBuffer.fill(0);
        this.#ivBuffer.set(this.#salt.subarray(0, 14), 0);
        writeUInt32BE(this.#ssrcBuffer, ssrc, 0);
        for (let i = 0; i < 4; i++) this.#ivBuffer[4 + i] ^= this.#ssrcBuffer[i];
        const index = (BigInt(roc >>> 0) << 16n) | BigInt(seq & 0xffff);
        writeBigUInt64BE(this.#indexBuffer, index, 0);
        for (let i = 0; i < 6; i++) this.#ivBuffer[8 + i] ^= this.#indexBuffer[2 + i];
        return this.#ivBuffer;
    }

    protect(senderSsrc, rtcpPacket) {
        const splitAt = Math.min(rtcpPacket.length, RTCP_HEADER_LEN);
        const header = rtcpPacket.subarray(0, splitAt);
        const body = rtcpPacket.subarray(splitAt);

        const index = this.#index >>> 0;
        this.#index = (this.#index + 1) >>> 0;

        const roc = index >>> 16;
        const seq = index & 0xffff;
        const iv = this.#generateIv(senderSsrc, roc, seq);
        const encryptedBody = aesCtr128(this.#cipherKey, iv, body);

        const withIndexWord = new Uint8Array(header.length + encryptedBody.length + 4);
        withIndexWord.set(header, 0);
        withIndexWord.set(encryptedBody, header.length);
        writeUInt32BE(withIndexWord, 0x80000000 | index, header.length + encryptedBody.length);

        const tag = hmacSha1(this.#authKey, withIndexWord).subarray(0, RTCP_AUTH_TAG_LEN);

        const out = new Uint8Array(withIndexWord.length + RTCP_AUTH_TAG_LEN);
        out.set(withIndexWord, 0);
        out.set(tag, withIndexWord.length);
        return out;
    }
}

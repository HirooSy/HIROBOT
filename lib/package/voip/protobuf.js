import { concatBytes } from './bytes.js';

const WIRE_TYPE_VARINT = 0;
const WIRE_TYPE_LENGTH_DELIMITED = 2;
const VARINT_CONTINUATION = 0x80;
const VARINT_PAYLOAD_MASK = 0x7fn;
const VARINT_SHIFT = 7n;
function encodeVarint(value) {
    const bytes = [];
    let remaining = value;
    while (remaining > VARINT_PAYLOAD_MASK) {
        bytes.push(Number(remaining & VARINT_PAYLOAD_MASK) | VARINT_CONTINUATION);
        remaining >>= VARINT_SHIFT;
    }
    bytes.push(Number(remaining & VARINT_PAYLOAD_MASK));
    return new Uint8Array(bytes);
}
function encodeTag(fieldNumber, wireType) {
    return encodeVarint((BigInt(fieldNumber) << 3n) | BigInt(wireType));
}
export function encodeProtoVarintField(fieldNumber, value) {
    return concatBytes([encodeTag(fieldNumber, WIRE_TYPE_VARINT), encodeVarint(value)]);
}
export function encodeProtoLengthDelimited(fieldNumber, data) {
    return concatBytes([
        encodeTag(fieldNumber, WIRE_TYPE_LENGTH_DELIMITED),
        encodeVarint(BigInt(data.length)),
        data
    ]);
}

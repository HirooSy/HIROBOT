import { concatBytes, EMPTY_BYTES, TEXT_DECODER, TEXT_ENCODER } from '../bytes.js';
import { encodeProtoLengthDelimited, encodeProtoVarintField } from '../protobuf.js';

const APP_DATA_PAYLOADS_MESSAGES = 1;
const APP_DATA_MESSAGE_REACTION_INFO = 1;
const APP_DATA_MESSAGE_AR_EFFECT_INFO = 3;
const REACTION_INFO_TRANSACTION_ID = 1;
const REACTION_INFO_REACTION = 2;
const AR_EFFECT_INFO_TRANSACTION_ID = 1;
const AR_EFFECT_INFO_AR_EFFECT_ID = 2;
const WIRE_TYPE_VARINT = 0;
const WIRE_TYPE_FIXED64 = 1;
const WIRE_TYPE_LENGTH_DELIMITED = 2;
const WIRE_TYPE_FIXED32 = 5;
const VARINT_CONTINUATION = 0x80;
const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_SHIFT = 7n;

const MAX_MESSAGES_PER_PAYLOAD = 32;
function readVarint(data, offset) {
    let value = 0n;
    let shift = 0n;
    let cursor = offset;
    while (cursor < data.length) {
        const byte = data[cursor++];
        value |= BigInt(byte & VARINT_PAYLOAD_MASK) << shift;
        if ((byte & VARINT_CONTINUATION) === 0)
            return { value, next: cursor };
        shift += VARINT_SHIFT;
        if (shift > 63n)
            break;
    }
    throw new Error('truncated protobuf varint');
}

function* readFields(data) {
    let offset = 0;
    while (offset < data.length) {
        const tag = readVarint(data, offset);
        offset = tag.next;
        const fieldNumber = Number(tag.value >> 3n);
        const wireType = Number(tag.value & 0x7n);
        if (fieldNumber === 0)
            throw new Error('invalid protobuf field number 0');
        if (wireType === WIRE_TYPE_VARINT) {
            const read = readVarint(data, offset);
            offset = read.next;
            yield { fieldNumber, wireType, varint: read.value, bytes: EMPTY_BYTES };
            continue;
        }
        if (wireType === WIRE_TYPE_LENGTH_DELIMITED) {
            const length = readVarint(data, offset);
            const start = length.next;
            const end = start + Number(length.value);
            if (end > data.length)
                throw new Error('truncated protobuf length-delimited field');
            offset = end;
            yield { fieldNumber, wireType, varint: 0n, bytes: data.subarray(start, end) };
            continue;
        }
        if (wireType === WIRE_TYPE_FIXED64) {
            offset += 8;
        }
        else if (wireType === WIRE_TYPE_FIXED32) {
            offset += 4;
        }
        else {
            throw new Error(`unsupported protobuf wire type ${wireType}`);
        }
        if (offset > data.length)
            throw new Error('truncated protobuf fixed-width field');
    }
}

export function encodeReactionPayload(reaction) {
    const reactionInfo = concatBytes([
        encodeProtoVarintField(REACTION_INFO_TRANSACTION_ID, reaction.transactionId),
        encodeProtoLengthDelimited(REACTION_INFO_REACTION, TEXT_ENCODER.encode(reaction.reaction))
    ]);
    const message = encodeProtoLengthDelimited(APP_DATA_MESSAGE_REACTION_INFO, reactionInfo);
    return encodeProtoLengthDelimited(APP_DATA_PAYLOADS_MESSAGES, message);
}
function decodeReactionInfo(data, requireTransactionId) {
    let transactionId = null;
    let reaction = null;
    for (const field of readFields(data)) {
        if (field.fieldNumber === REACTION_INFO_TRANSACTION_ID && field.wireType === 0) {
            transactionId = field.varint;
        }
        else if (field.fieldNumber === REACTION_INFO_REACTION && field.wireType === 2) {
            reaction = TEXT_DECODER.decode(field.bytes);
        }
    }
    if (reaction === null)
        return null;
    if (transactionId === null && requireTransactionId)
        return null;
    return { transactionId: transactionId ?? 0n, reaction };
}
function decodeArEffectInfo(data, requireTransactionId) {
    let transactionId = null;
    let arEffectId = null;
    for (const field of readFields(data)) {
        if (field.fieldNumber === AR_EFFECT_INFO_TRANSACTION_ID && field.wireType === 0) {
            transactionId = field.varint;
        }
        else if (field.fieldNumber === AR_EFFECT_INFO_AR_EFFECT_ID && field.wireType === 2) {
            arEffectId = TEXT_DECODER.decode(field.bytes);
        }
    }
    if (arEffectId === null)
        return null;
    if (transactionId === null && requireTransactionId)
        return null;
    return { transactionId: transactionId ?? 0n, arEffectId };
}

function decodeAppDataMessage(data, strict) {
    let reaction = null;
    let arEffect = null;
    for (const field of readFields(data)) {
        if (field.wireType !== WIRE_TYPE_LENGTH_DELIMITED)
            continue;
        if (field.fieldNumber === APP_DATA_MESSAGE_REACTION_INFO) {
            reaction = decodeReactionInfo(field.bytes, strict);
        }
        else if (field.fieldNumber === APP_DATA_MESSAGE_AR_EFFECT_INFO) {
            arEffect = decodeArEffectInfo(field.bytes, strict);
        }
    }
    if (reaction)
        return arEffect ? { reaction, arEffect } : { reaction };
    return arEffect ? { arEffect } : null;
}
function decodeAsPayloads(data) {
    const items = [];
    let truncated = false;
    for (const field of readFields(data)) {
        if (field.fieldNumber !== APP_DATA_PAYLOADS_MESSAGES)
            continue;
        if (field.wireType !== WIRE_TYPE_LENGTH_DELIMITED)
            continue;
        if (items.length >= MAX_MESSAGES_PER_PAYLOAD) {
            truncated = true;
            break;
        }
        const item = decodeAppDataMessage(field.bytes, false);
        if (item)
            items.push(item);
    }
    return { items, truncated };
}

export function decodeAppDataPayload(data) {
    try {
        const nested = decodeAsPayloads(data);
        if (nested.items.length > 0) {
            return { shape: 'payloads', items: nested.items, truncated: nested.truncated };
        }
    }
    catch {
    }
    try {
        const flat = decodeAppDataMessage(data, true);
        if (flat)
            return { shape: 'message', items: [flat], truncated: false };
    }
    catch {
        return null;
    }
    return null;
}

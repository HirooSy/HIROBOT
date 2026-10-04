import { toError } from '../shim/util.js';
import { randomInt } from '../crypto/primitives.js';
import { RtpHeader, RtpPacket } from '../media/rtp.js';
import { decodeAppDataPayload, encodeReactionPayload } from './protocol.js';

const DEFAULT_RETRANSMISSION_INTERVAL_MS = 60;
const DEFAULT_CLEAR_INTERVAL_MS = 600;

const MAX_TRACKED_TRANSACTIONS = 64;

export const WA_APP_DATA_PAYLOAD_TYPE = 119;

export class WaAppDataStream {
    ssrc;
    logger;
    sendPacket;
    retransmissionIntervalMs;
    clearIntervalMs;
    sequenceNumber = randomInt(0, 65_536);
    
    timestamp = randomInt(0, 0xffffffff);
    outgoing = null;
    retransmitTimer = null;
    
    seenTransactions = new Set();
    
    nextTransactionId = 1n;
    learnedPayloadType;
    configuredPayloadType;
    sframeRequired = false;
    sframeProtect = null;
    txReactionCount = 0;
    txReactionErrorCount = 0;
    rxReactionCount = 0;
    constructor(options) {
        this.logger = options.logger;
        this.ssrc = options.ssrc;
        this.sendPacket = options.sendPacket;
        this.configuredPayloadType = options.payloadType ?? null;
        this.learnedPayloadType = null;
        this.retransmissionIntervalMs =
            options.retransmissionIntervalMs ?? DEFAULT_RETRANSMISSION_INTERVAL_MS;
        this.clearIntervalMs = options.clearIntervalMs ?? DEFAULT_CLEAR_INTERVAL_MS;
    }
    
    get payloadType() {
        return this.configuredPayloadType ?? WA_APP_DATA_PAYLOAD_TYPE;
    }
    
    get peerPayloadType() {
        return this.learnedPayloadType;
    }
    
    observeInboundPayloadType(payloadType) {
        if (this.configuredPayloadType !== null || this.learnedPayloadType === payloadType)
            return;
        this.learnedPayloadType = payloadType;
        this.logger.debug('app data payload type learned from peer', {
            payloadType,
            ssrc: `0x${this.ssrc.toString(16)}`
        });
    }
    
    setSframe(required, protect) {
        this.sframeRequired = required;
        this.sframeProtect = protect;
    }
    
    sendReaction(reaction) {
        const transactionId = this.nextTransactionId++;
        const payload = encodeReactionPayload({ transactionId, reaction });
        const clearAt = Date.now() + this.clearIntervalMs;
        this.outgoing = { payload, transactionId, reaction, clearAt };
        this.txReactionCount++;
        const sent = this.transmit();
        this.armRetransmission();
        this.logger.debug('call reaction queued', {
            reaction,
            transactionId: transactionId.toString(),
            ssrc: `0x${this.ssrc.toString(16)}`,
            firstAttemptSent: sent,
            total: this.txReactionCount
        });
        return sent;
    }
    
    receive(payload, ssrc) {
        if (payload.length === 0)
            return EMPTY_REACTIONS;
        const decoded = decodeAppDataPayload(payload);
        if (!decoded) {
            this.logger.debug('app data payload not understood', {
                ssrc: `0x${this.ssrc.toString(16)}`,
                bytes: payload.length,
                sframeRequired: this.sframeRequired,
                sframeKeyed: this.sframeProtect !== null
            });
            return EMPTY_REACTIONS;
        }
        if (decoded.truncated) {
            this.logger.debug('app data payload carried more messages than are read', {
                ssrc: `0x${ssrc.toString(16)}`,
                read: decoded.items.length
            });
        }
        const fresh = [];
        for (const item of decoded.items) {
            const reaction = item.reaction;
            if (!reaction)
                continue;
            const key = `${ssrc}:${reaction.transactionId}`;
            if (this.seenTransactions.has(key))
                continue;
            this.rememberTransaction(key);
            this.rxReactionCount++;
            fresh.push(reaction);
        }
        if (fresh.length > 0) {
            this.logger.debug('call reaction received', {
                shape: decoded.shape,
                count: fresh.length,
                total: this.rxReactionCount
            });
        }
        return fresh;
    }
    close() {
        this.clearOutgoing();
        this.seenTransactions.clear();
    }
    rememberTransaction(key) {
        if (this.seenTransactions.size >= MAX_TRACKED_TRANSACTIONS) {
            const oldest = this.seenTransactions.values().next().value;
            if (oldest !== undefined)
                this.seenTransactions.delete(oldest);
        }
        this.seenTransactions.add(key);
    }
    armRetransmission() {
        if (this.retransmitTimer)
            return;
        this.retransmitTimer = setInterval(() => {
            this.onRetransmissionTick();
        }, this.retransmissionIntervalMs);
        this.retransmitTimer.unref?.();
    }
    onRetransmissionTick() {
        const outgoing = this.outgoing;
        if (!outgoing) {
            this.clearOutgoing();
            return;
        }
        if (Date.now() >= outgoing.clearAt) {
            this.logger.debug('call reaction cleared from send buffer', {
                transactionId: outgoing.transactionId.toString()
            });
            this.clearOutgoing();
            return;
        }
        this.transmit();
    }
    clearOutgoing() {
        this.outgoing = null;
        if (this.retransmitTimer) {
            clearInterval(this.retransmitTimer);
            this.retransmitTimer = null;
        }
    }
    transmit() {
        const outgoing = this.outgoing;
        if (!outgoing)
            return false;
        const payloadType = this.payloadType;
        try {
            const header = new RtpHeader(payloadType, this.sequenceNumber, this.timestamp, this.ssrc);
            this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
            const payload = this.sframeProtect
                ? this.sframeProtect(outgoing.payload)
                : outgoing.payload;
            return this.sendPacket(new RtpPacket(header, payload));
        }
        catch (err) {
            this.txReactionErrorCount++;
            this.logger.debug('failed to send app data rtp packet', {
                ssrc: `0x${this.ssrc.toString(16)}`,
                errors: this.txReactionErrorCount,
                message: toError(err).message
            });
            return false;
        }
    }
}
const EMPTY_REACTIONS = [];

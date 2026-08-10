
export type BaileysSocket = {
    authState: any;
    signalRepository: any;
    generateMessageTag: () => string;
    query: (node: any) => Promise<any>;
    sendNode: (node: any) => Promise<void>;
    waitForMessage: (tag: string, timeoutMs: number) => Promise<any>;
    getUSyncDevices: (jids: string[], ignoreZeroDevices: boolean, forceQuery: boolean) => Promise<any[]>;
    presenceSubscribe: (jid: string) => Promise<void>;
    ws: any;
    ev: any;
};
export type SignalingBridgeConfig = {
    sock: BaileysSocket;
};
export declare class SignalingBridge {
    #private;
    constructor(config: SignalingBridgeConfig);

    attachEngine: (voip: any) => void;
    init: () => Promise<void>;
    sendSignaling: (peerJid: string, callId: string, xmlPayload: Uint8Array) => void;
    processIncomingCall: (node: any, voip: any, activeCallId: string) => void;
    processIncomingReceipt: (node: any, voip: any, activeCallId: string) => void;
    requestTcToken: (jid: string) => Promise<Uint8Array | undefined>;
    ensureTcToken: (...jids: string[]) => Promise<Uint8Array | undefined>;
    discoverPeerDevices: (peerLidJid: string) => Promise<string[]>;
    ensureSessionsForPeers: (jids: string[]) => Promise<void>;
    resolveLid: (pnJid: string) => Promise<string | undefined>;
    issueTcToken: (jid: string) => Promise<boolean>;
    getRemoteDeviceJid: (callId: string) => string | undefined;
}

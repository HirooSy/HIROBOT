
import { EventEmitter } from "node:events";
import { WasmEngine } from "./wasm-engine.js";
import { CallState, type VoipSdkConfig } from "./types.js";
export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig } from "./types.js";
export { CallState } from "./types.js";

export declare class ActiveCall extends EventEmitter {
    #private;
    readonly callId: string;
    private readonly engine;

    _audioSource: string;
    constructor(callId: string, engine: WasmEngine, durationMs: number);
    get state(): CallState;
    end: () => void;
    mute: (muted: boolean) => void;
    waitForEnd: () => Promise<string>;

    _updateState: (state: number) => void;

    _emitAudio: (pcm: Float32Array) => void;

    _forceEnd: (reason: string) => void;
}

export declare class VoipClient {
    #private;
    constructor(config: VoipSdkConfig);

    connect: () => Promise<void>;

    call: (phoneNumber: string, opts?: {
        audioSource?: string;
        durationMs?: number;
    }) => Promise<ActiveCall>;

    disconnect: () => void;
}

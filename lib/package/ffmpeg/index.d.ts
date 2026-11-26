export type Input = string | Buffer | Uint8Array;

export interface RunOptions {
  input?: Input | Input[];
  inputs?: Input[];
  output?: string | { format?: string };
  format?: string;
  codec?: string;
  audioCodec?: string;
  videoCodec?: 'copy';
  start?: number | string;
  end?: number | string;
  duration?: number | string;
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  bitrate?: number;
  volume?: number | string;
  fadeIn?: number;
  fadeOut?: number;
  noAudio?: boolean;
  noVideo?: boolean;
  streams?: number[];
  metadata?: Record<string, string>;
  stripMetadata?: boolean;
  faststart?: boolean;
  overwrite?: boolean;
  videoFilter?: string;
  vf?: string;
  frames?: number;
  vframes?: number;
  qscale?: number;
  quality?: number;
  compressionLevel?: number;
  pixFmt?: string;
  merge?: boolean;
  maps?: { input: number; type?: 'audio' | 'video'; nth?: number; optional?: boolean; text?: string }[];
  shortest?: boolean;
  net?: { headers?: Record<string, string>; userAgent?: string; referer?: string; timeoutMs?: number };
  smartCopy?: boolean;
  maxPixels?: number;
}

export interface RunResult {
  output: string | Buffer;
  format: string;
  size: number;
  duration: number;
  streams: { index: number; type: 'audio' | 'video'; codec: string }[];
}

export interface StreamInfo {
  index: number;
  type: 'audio' | 'video';
  codec: string;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  bitRate?: number;
  duration?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  timeScale?: number;
}

export interface ProbeResult {
  format: {
    name: string;
    size: number;
    duration?: number;
    bitRate?: number;
    tags: Record<string, string>;
  };
  streams: StreamInfo[];
}

export class FFError extends Error {
  code: 'EINVAL' | 'EFORMAT' | 'EUNSUPPORTED';
}

export function run(options: RunOptions): Promise<RunResult>;
export function convert(options: RunOptions): Promise<RunResult>;
export function probe(input: Input): Promise<ProbeResult>;
export function setDebug(enabled: boolean): void;
export function isDebug(): boolean;
export function parseArgs(argv: string[]): RunOptions;
export function main(argv: string[]): Promise<number>;
export function canConvertNatively(input: string, output: string): boolean;
export function convertNative(input: string, output: string): Promise<boolean>;
export function decodePcm16(input: string, options: { sampleRate: number; channels?: number; maxBytes?: number }): Promise<Int16Array | null>;
export function canConvertImage(output: string): boolean;
export function convertImage(input: Input, output: string, options?: Omit<RunOptions, 'input' | 'inputs' | 'output'>): Promise<boolean>;
export function runFfmpegArgs(argv: string[], extra?: Partial<RunOptions>): Promise<boolean>;

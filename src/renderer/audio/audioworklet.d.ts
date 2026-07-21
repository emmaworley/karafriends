// Ambient AudioWorklet globals.
//
// @types/audioworklet ships no TypeScript 6 typings: its `typesVersions` only
// maps `<=5.9`, so under TS6 the package falls back to a stub and its worklet
// globals are not picked up. This local shim restores the globals used by
// phazeAudioWorklet.ts. It intentionally mirrors upstream's parameterless
// AudioWorkletProcessor constructor, so the existing `@ts-expect-error` on the
// `super(options)` call there stays valid. Remove this file once
// @types/audioworklet supports TS6.

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (...args: any[]) => AudioWorkletProcessor,
): void;

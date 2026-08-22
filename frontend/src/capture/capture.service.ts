export type CaptureState = 'idle' | 'listening' | 'paused';

export type CapturedAudio = {
  filePath: string;
  durationSeconds: number;
};

export interface CaptureService {
  start(): Promise<{ systemAudioEnabled: boolean }>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<CapturedAudio>;
  cancel(): Promise<void>;
  getState(): CaptureState;
}

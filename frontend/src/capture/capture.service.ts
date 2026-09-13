export type CaptureState = 'idle' | 'listening' | 'paused';

export type CapturedAudio = {
  filePath: string;
  durationSeconds: number;
  micFilePath?: string;
  systemFilePath?: string;
};

export type CaptureLevels = {
  mic: number;
  system: number;
};

export type CaptureDevice = {
  inputName: string;
};

export type CaptureSessionInfo = {
  systemAudioEnabled: boolean;
  inputName: string;
};

export interface CaptureService {
  preview(): Promise<CaptureSessionInfo>;
  start(): Promise<CaptureSessionInfo>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<CapturedAudio>;
  cancel(): Promise<void>;
  getState(): CaptureState;
  subscribeLevels(listener: (levels: CaptureLevels) => void): () => void;
  subscribeDevice(listener: (device: CaptureDevice) => void): () => void;
}

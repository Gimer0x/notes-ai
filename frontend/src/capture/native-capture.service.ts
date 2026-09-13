import type {
  CapturedAudio,
  CaptureDevice,
  CaptureLevels,
  CaptureService,
  CaptureSessionInfo,
  CaptureState,
} from './capture.service';
import { HelperClient } from './helper-client';

export class NativeCaptureService implements CaptureService {
  private state: CaptureState = 'idle';
  private readonly helper = new HelperClient();
  private readonly levelListeners = new Set<(levels: CaptureLevels) => void>();
  private readonly deviceListeners = new Set<(device: CaptureDevice) => void>();
  private lastDevice: CaptureDevice = { inputName: '' };
  private micLost = false;

  constructor() {
    this.helper.onLevels((levels) => {
      for (const listener of this.levelListeners) {
        listener(levels);
      }
    });
    this.helper.onDevice((device, lost) => {
      this.lastDevice = device;
      this.micLost = lost;
      for (const listener of this.deviceListeners) {
        listener(device);
      }
    });
  }

  getState(): CaptureState {
    return this.state;
  }

  subscribeLevels(listener: (levels: CaptureLevels) => void): () => void {
    this.levelListeners.add(listener);
    return () => {
      this.levelListeners.delete(listener);
    };
  }

  subscribeDevice(listener: (device: CaptureDevice) => void): () => void {
    this.deviceListeners.add(listener);
    if (this.lastDevice.inputName || this.micLost) {
      listener(this.lastDevice);
    }
    return () => {
      this.deviceListeners.delete(listener);
    };
  }

  isMicLost(): boolean {
    return this.micLost;
  }

  async preview(): Promise<CaptureSessionInfo> {
    if (process.platform !== 'darwin') {
      throw new Error('macos_only');
    }
    const msg = await this.helper.send('preview');
    return this.sessionFrom(msg);
  }

  async start(): Promise<CaptureSessionInfo> {
    if (process.platform !== 'darwin') {
      throw new Error('macos_only');
    }
    const msg = await this.helper.send('start');
    this.state = 'listening';
    return this.sessionFrom(msg);
  }

  async pause(): Promise<void> {
    await this.helper.send('pause');
    this.state = 'paused';
    this.emitLevels({ mic: 0, system: 0 });
  }

  async resume(): Promise<void> {
    await this.helper.send('resume');
    this.state = 'listening';
  }

  async stop(): Promise<CapturedAudio> {
    try {
      const msg = await this.helper.send('stop');
      this.state = 'idle';
      if (!msg.filePath) {
        throw new Error('empty');
      }
      return {
        filePath: msg.filePath,
        durationSeconds: msg.durationSeconds ?? 0,
        micFilePath: msg.micFilePath,
        systemFilePath: msg.systemFilePath,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (
        message === 'not_listening' ||
        message === 'empty' ||
        message === 'too_short' ||
        message === 'helper_exit' ||
        message === 'helper_timeout'
      ) {
        this.state = 'idle';
      }
      throw error;
    }
  }

  async cancel(): Promise<void> {
    try {
      await this.helper.send('cancel');
    } catch {
      // Helper may already be gone.
    }
    this.state = 'idle';
  }

  dispose(): void {
    void this.cancel();
    this.helper.stopProcess();
    this.levelListeners.clear();
    this.deviceListeners.clear();
    this.state = 'idle';
  }

  private sessionFrom(msg: {
    systemAudioEnabled?: boolean;
    inputName?: string;
  }): CaptureSessionInfo {
    const inputName = msg.inputName ?? this.lastDevice.inputName;
    this.lastDevice = { inputName };
    this.micLost = !inputName;
    for (const listener of this.deviceListeners) {
      listener(this.lastDevice);
    }
    return {
      systemAudioEnabled: Boolean(msg.systemAudioEnabled),
      inputName,
    };
  }

  private emitLevels(levels: CaptureLevels): void {
    for (const listener of this.levelListeners) {
      listener(levels);
    }
  }
}

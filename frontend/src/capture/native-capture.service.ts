import type { CapturedAudio, CaptureService, CaptureState } from './capture.service';
import { HelperClient } from './helper-client';

export class NativeCaptureService implements CaptureService {
  private state: CaptureState = 'idle';
  private readonly helper = new HelperClient();

  getState(): CaptureState {
    return this.state;
  }

  async start(): Promise<{ systemAudioEnabled: boolean }> {
    if (process.platform !== 'darwin') {
      throw new Error('macos_only');
    }
    const msg = await this.helper.send('start');
    this.state = 'listening';
    return { systemAudioEnabled: Boolean(msg.systemAudioEnabled) };
  }

  async pause(): Promise<void> {
    await this.helper.send('pause');
    this.state = 'paused';
  }

  async resume(): Promise<void> {
    await this.helper.send('resume');
    this.state = 'listening';
  }

  async stop(): Promise<CapturedAudio> {
    const msg = await this.helper.send('stop');
    this.state = 'idle';
    if (!msg.filePath) {
      throw new Error('empty');
    }
    return {
      filePath: msg.filePath,
      durationSeconds: msg.durationSeconds ?? 0,
    };
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
    this.state = 'idle';
  }
}

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { CaptureDevice, CaptureLevels } from './capture.service';

type HelperOk = {
  id: string;
  ok: true;
  systemAudioEnabled?: boolean;
  filePath?: string;
  durationSeconds?: number;
  state?: string;
  inputName?: string;
};

type HelperErr = {
  id: string;
  ok: false;
  error?: string;
};

type HelperLevels = {
  event: 'levels';
  mic: number;
  system: number;
};

type HelperDevice = {
  event: 'device';
  inputName: string;
  lost?: boolean;
};

type HelperMsg = HelperOk | HelperErr | HelperLevels | HelperDevice;

function isLevels(msg: HelperMsg): msg is HelperLevels {
  return 'event' in msg && msg.event === 'levels';
}

function isDevice(msg: HelperMsg): msg is HelperDevice {
  return 'event' in msg && msg.event === 'device';
}

export class HelperClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<
    string,
    { resolve: (msg: HelperOk) => void; reject: (err: Error) => void }
  >();
  private levelsListener: ((levels: CaptureLevels) => void) | null = null;
  private deviceListener: ((device: CaptureDevice, lost: boolean) => void) | null =
    null;

  onLevels(listener: ((levels: CaptureLevels) => void) | null): void {
    this.levelsListener = listener;
  }

  onDevice(listener: ((device: CaptureDevice, lost: boolean) => void) | null): void {
    this.deviceListener = listener;
  }

  startProcess(): void {
    if (this.child && !this.child.killed) {
      return;
    }
    const binary = helperBinaryPath();
    if (!fs.existsSync(binary)) {
      throw new Error('helper_missing');
    }
    this.child = spawn(binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) {
          this.onLine(line);
        }
        newline = this.buffer.indexOf('\n');
      }
    });
    this.child.stderr.on('data', (chunk: string) => {
      process.stderr.write(chunk);
    });
    this.child.on('exit', () => {
      this.failAll(new Error('helper_exit'));
      this.child = null;
    });
  }

  async send(cmd: string): Promise<HelperOk> {
    this.startProcess();
    const id = String(this.nextId++);
    const line = JSON.stringify({ id, cmd }) + '\n';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child?.stdin.write(line, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  stopProcess(): void {
    this.failAll(new Error('helper_exit'));
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  private onLine(line: string): void {
    let msg: HelperMsg;
    try {
      msg = JSON.parse(line) as HelperMsg;
    } catch {
      return;
    }
    if (isLevels(msg)) {
      this.levelsListener?.({
        mic: clamp01(msg.mic),
        system: clamp01(msg.system),
      });
      return;
    }
    if (isDevice(msg)) {
      this.deviceListener?.(
        { inputName: msg.inputName || '' },
        Boolean(msg.lost),
      );
      return;
    }
    const waiter = this.pending.get(msg.id);
    if (!waiter) {
      return;
    }
    this.pending.delete(msg.id);
    if (msg.ok) {
      waiter.resolve(msg);
    } else {
      waiter.reject(new Error(msg.error || 'helper_error'));
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function helperBinaryPath(): string {
  const candidates = [
    path.join(process.resourcesPath, 'CaptureHelper.app', 'Contents', 'MacOS', 'CaptureHelper'),
    path.join(__dirname, '../native/CaptureHelper.app/Contents/MacOS/CaptureHelper'),
    path.join(app.getAppPath(), 'native/CaptureHelper.app/Contents/MacOS/CaptureHelper'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return found ?? candidates[1];
}

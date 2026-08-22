import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

type HelperOk = {
  id: string;
  ok: true;
  systemAudioEnabled?: boolean;
  filePath?: string;
  durationSeconds?: number;
  state?: string;
};

type HelperErr = {
  id: string;
  ok: false;
  error?: string;
};

type HelperMsg = HelperOk | HelperErr;

export class HelperClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<
    string,
    { resolve: (msg: HelperOk) => void; reject: (err: Error) => void }
  >();

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

function helperBinaryPath(): string {
  const candidates = [
    path.join(process.resourcesPath, 'CaptureHelper.app', 'Contents', 'MacOS', 'CaptureHelper'),
    path.join(__dirname, '../native/CaptureHelper.app/Contents/MacOS/CaptureHelper'),
    path.join(app.getAppPath(), 'native/CaptureHelper.app/Contents/MacOS/CaptureHelper'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return found ?? candidates[1];
}

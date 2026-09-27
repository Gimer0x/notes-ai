import { readFile } from 'fs/promises';
import FormData from 'form-data';

export type TranscriptResult = {
  text: string;
  language: 'en' | 'es';
  logs: string[];
};

export class SpikeRequestError extends Error {
  logs: string[];

  constructor(message: string, logs: string[] = []) {
    super(message);
    this.logs = logs;
  }
}

export class SpikeClient {
  constructor(
    private readonly backendUrl: string,
    private readonly spikeKey: string,
  ) {}

  async transcribe(
    wavPathOrBuffer: string | Buffer,
    filename = 'mix.wav',
  ): Promise<TranscriptResult> {
    if (!this.spikeKey) {
      throw new Error('no_spike_key');
    }
    const bytes =
      typeof wavPathOrBuffer === 'string'
        ? await readFile(wavPathOrBuffer)
        : Buffer.from(wavPathOrBuffer);

    if (!isRiffWav(bytes)) {
      throw new Error(
        `empty: mix is not a PCM WAV (bytes=${bytes.length} head=${bytes.subarray(0, 12).toString('hex')})`,
      );
    }

    const form = new FormData();
    form.append('audio', bytes, {
      filename,
      contentType: 'audio/wav',
      knownLength: bytes.length,
    });

    const response = await fetch(`${this.backendUrl.replace(/\/$/, '')}/spike/transcribe`, {
      method: 'POST',
      headers: {
        'X-Spike-Key': this.spikeKey,
        ...form.getHeaders(),
      },
      body: Uint8Array.from(form.getBuffer()),
    });
    const body = (await response.json()) as {
      text?: string;
      language?: 'en' | 'es';
      message?: string | string[] | { message?: string; logs?: string[] };
      logs?: string[];
    };
    const logs = readLogs(body);
    if (!response.ok) {
      const raw = body.message;
      const message = Array.isArray(raw)
        ? raw.join(', ')
        : typeof raw === 'string'
          ? raw
          : raw?.message;
      throw new SpikeRequestError(message || `spike_${response.status}`, logs);
    }
    return {
      text: body.text ?? '',
      language: body.language === 'es' ? 'es' : 'en',
      logs,
    };
  }
}

function readLogs(body: { logs?: string[]; message?: string | string[] | { logs?: string[] } }): string[] {
  const direct = Array.isArray(body.logs) ? body.logs : [];
  const nested =
    body.message && typeof body.message === 'object' && !Array.isArray(body.message) && Array.isArray(body.message.logs)
      ? body.message.logs
      : [];
  return [...direct, ...nested].filter((line) => typeof line === 'string');
}

function isRiffWav(bytes: Buffer): boolean {
  return (
    bytes.length >= 44 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WAVE'
  );
}

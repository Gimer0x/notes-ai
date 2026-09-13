import { readFile } from 'fs/promises';
import FormData from 'form-data';

export type TranscriptResult = {
  text: string;
  language: 'en' | 'es';
};

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
      message?: string | string[];
    };
    if (!response.ok) {
      const message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
      throw new Error(message || `spike_${response.status}`);
    }
    return {
      text: body.text ?? '',
      language: body.language === 'es' ? 'es' : 'en',
    };
  }
}

function isRiffWav(bytes: Buffer): boolean {
  return (
    bytes.length >= 44 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WAVE'
  );
}

import { canonicalizeWav } from './canonicalize-wav';

type PcmWav = {
  fmt: Buffer;
  data: Buffer;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
};

/** PCM duration in seconds after canonicalize, or null if the buffer is not a WAV. */
export function wavDurationSeconds(input: Buffer): number | null {
  const canonical = canonicalizeWav(input);
  const parsed = parsePcmWav(canonical);
  if (!parsed) {
    return null;
  }
  const bytesPerFrame = parsed.channels * (parsed.bitsPerSample / 8);
  if (!Number.isInteger(bytesPerFrame) || bytesPerFrame <= 0) {
    return null;
  }
  return parsed.data.length / bytesPerFrame / parsed.sampleRate;
}

/**
 * Split a PCM WAV into parts of at most `chunkSeconds` (from GET /config).
 * Used so each OpenAI STT call stays under the 25 MB API limit.
 */
export function splitWavBySeconds(input: Buffer, chunkSeconds: number): Buffer[] {
  const canonical = canonicalizeWav(input);
  const parsed = parsePcmWav(canonical);
  if (!parsed || !(chunkSeconds > 0)) {
    return [canonical];
  }
  const bytesPerFrame = parsed.channels * (parsed.bitsPerSample / 8);
  if (!Number.isInteger(bytesPerFrame) || bytesPerFrame <= 0) {
    return [canonical];
  }
  const chunkBytes = Math.floor(chunkSeconds * parsed.sampleRate) * bytesPerFrame;
  if (chunkBytes <= 0 || parsed.data.length <= chunkBytes) {
    return [canonical];
  }
  const parts: Buffer[] = [];
  for (let offset = 0; offset < parsed.data.length; offset += chunkBytes) {
    const slice = parsed.data.subarray(
      offset,
      Math.min(offset + chunkBytes, parsed.data.length),
    );
    parts.push(buildWav(parsed.fmt, slice));
  }
  return parts;
}

function parsePcmWav(input: Buffer): PcmWav | null {
  if (
    input.length < 44 ||
    input.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    input.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    return null;
  }
  let fmt: Buffer | undefined;
  let data: Buffer | undefined;
  let offset = 12;
  while (offset + 8 <= input.length) {
    const id = input.subarray(offset, offset + 4).toString('ascii');
    const size = input.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > input.length) {
      break;
    }
    if (id === 'fmt ') {
      fmt = input.subarray(start, end);
    } else if (id === 'data') {
      data = input.subarray(start, end);
    }
    offset = end + (size % 2);
  }
  if (!fmt || !data || fmt.length < 16) {
    return null;
  }
  const audioFormat = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const bitsPerSample = fmt.readUInt16LE(14);
  if (audioFormat !== 1 || channels < 1 || sampleRate < 1 || bitsPerSample < 8) {
    return null;
  }
  return { fmt: fmt.subarray(0, 16), data, sampleRate, channels, bitsPerSample };
}

function buildWav(fmt: Buffer, data: Buffer): Buffer {
  const pad = data.length % 2;
  const riffSize = 4 + 8 + fmt.length + 8 + data.length + pad;
  const out = Buffer.alloc(8 + riffSize);
  out.write('RIFF', 0);
  out.writeUInt32LE(riffSize, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(fmt.length, 16);
  fmt.copy(out, 20);
  const dataOff = 20 + fmt.length;
  out.write('data', dataOff);
  out.writeUInt32LE(data.length, dataOff + 4);
  data.copy(out, dataOff + 8);
  return out;
}

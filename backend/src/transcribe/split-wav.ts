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

/**
 * Split a 16-bit mono mix on longer silences so STT does not lock onto the
 * last language (YouTube then muted-tab speech).
 */
export function splitWavBySilence(
  input: Buffer,
  options?: { minSilenceSeconds?: number; minSegmentSeconds?: number; rmsThreshold?: number },
): Buffer[] {
  const analysis = analyzeWavSilence(input, options);
  if (analysis.regions.length <= 1 || !analysis.canonical || !analysis.fmt) {
    return [analysis.canonical ?? canonicalizeWav(input)];
  }
  return analysis.regions.map((region) =>
    buildWav(
      analysis.fmt!,
      analysis.pcm!.subarray(region.startSample * 2, region.endSample * 2),
    ),
  );
}

export type SilenceRegion = {
  startSec: number;
  endSec: number;
  startSample: number;
  endSample: number;
  rms: number;
  peak: number;
};

export type SilenceAnalysis = {
  durationSec: number;
  threshold: number;
  maxGapSec: number;
  activeRatio: number;
  regions: SilenceRegion[];
  summary: string;
  canonical?: Buffer;
  fmt?: Buffer;
  pcm?: Buffer;
};

export function analyzeWavSilence(
  input: Buffer,
  options?: { minSilenceSeconds?: number; minSegmentSeconds?: number; rmsThreshold?: number },
): SilenceAnalysis {
  const canonical = canonicalizeWav(input);
  const parsed = parsePcmWav(canonical);
  const threshold = options?.rmsThreshold ?? 0.01;
  if (!parsed || parsed.channels !== 1 || parsed.bitsPerSample !== 16) {
    return {
      durationSec: 0,
      threshold,
      maxGapSec: 0,
      activeRatio: 0,
      regions: [],
      summary: 'silence n/a (not 16-bit mono PCM)',
      canonical,
    };
  }
  const minSilence = options?.minSilenceSeconds ?? 0.8;
  const minSegment = options?.minSegmentSeconds ?? 0.45;
  const sampleCount = Math.floor(parsed.data.length / 2);
  const durationSec = sampleCount / parsed.sampleRate;
  const frame = Math.max(1, Math.round(parsed.sampleRate * 0.02));
  const minSilentFrames = Math.max(1, Math.round((minSilence * parsed.sampleRate) / frame));
  const minSegSamples = Math.round(minSegment * parsed.sampleRate);
  const pad = Math.round(0.12 * parsed.sampleRate);

  const active: boolean[] = [];
  for (let offset = 0; offset < sampleCount; offset += frame) {
    const end = Math.min(offset + frame, sampleCount);
    active.push(frameRms(parsed.data, offset, end) >= threshold);
  }
  const activeFrames = active.filter(Boolean).length;
  const activeRatio = active.length === 0 ? 0 : activeFrames / active.length;

  const regions: SilenceRegion[] = [];
  let index = 0;
  let maxGapSec = 0;
  let previousEnd = 0;
  while (index < active.length) {
    while (index < active.length && !active[index]) {
      index += 1;
    }
    if (index >= active.length) {
      break;
    }
    const startFrame = index;
    let lastActive = index;
    let silentRun = 0;
    index += 1;
    while (index < active.length) {
      if (active[index]) {
        lastActive = index;
        silentRun = 0;
      } else {
        silentRun += 1;
        if (silentRun >= minSilentFrames) {
          break;
        }
      }
      index += 1;
    }
    const start = Math.max(0, startFrame * frame - pad);
    const end = Math.min(sampleCount, (lastActive + 1) * frame + pad);
    if (end - start >= minSegSamples) {
      const gap = (start - previousEnd) / parsed.sampleRate;
      if (regions.length > 0 && gap > maxGapSec) {
        maxGapSec = gap;
      }
      regions.push({
        startSec: start / parsed.sampleRate,
        endSec: end / parsed.sampleRate,
        startSample: start,
        endSample: end,
        rms: frameRms(parsed.data, start, end),
        peak: framePeak(parsed.data, start, end),
      });
      previousEnd = end;
    }
    index = lastActive + 1 + minSilentFrames;
  }

  const regionText =
    regions.length === 0
      ? 'none'
      : regions
          .map(
            (region) =>
              `[${region.startSec.toFixed(2)}-${region.endSec.toFixed(2)}s rms=${region.rms.toFixed(3)} peak=${region.peak}]`,
          )
          .join(' ');
  const summary = `silence duration=${durationSec.toFixed(2)}s threshold=${threshold} regions=${regions.length} maxGap=${maxGapSec.toFixed(2)}s activeRatio=${activeRatio.toFixed(3)} ${regionText}`;

  return {
    durationSec,
    threshold,
    maxGapSec,
    activeRatio,
    regions,
    summary,
    canonical,
    fmt: parsed.fmt,
    pcm: parsed.data,
  };
}

export function wavEnergyReport(input: Buffer, windowSeconds = 1): string {
  const canonical = canonicalizeWav(input);
  const parsed = parsePcmWav(canonical);
  if (!parsed || parsed.channels !== 1 || parsed.bitsPerSample !== 16) {
    return 'energy n/a';
  }
  const sampleCount = Math.floor(parsed.data.length / 2);
  const win = Math.max(1, Math.round(windowSeconds * parsed.sampleRate));
  const parts: string[] = [];
  for (let start = 0; start < sampleCount; start += win) {
    const end = Math.min(start + win, sampleCount);
    parts.push(
      `${(start / parsed.sampleRate).toFixed(0)}s rms=${frameRms(parsed.data, start, end).toFixed(3)} peak=${framePeak(parsed.data, start, end)}`,
    );
  }
  return `sec=${(sampleCount / parsed.sampleRate).toFixed(2)} ${parts.join(' | ')}`;
}

function framePeak(data: Buffer, startSample: number, endSample: number): number {
  let peak = 0;
  for (let sample = startSample; sample < endSample; sample += 1) {
    const value = Math.abs(data.readInt16LE(sample * 2));
    if (value > peak) {
      peak = value;
    }
  }
  return peak;
}

function frameRms(data: Buffer, startSample: number, endSample: number): number {
  const count = endSample - startSample;
  if (count <= 0) {
    return 0;
  }
  let sum = 0;
  for (let sample = startSample; sample < endSample; sample += 1) {
    const normalized = data.readInt16LE(sample * 2) / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / count);
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

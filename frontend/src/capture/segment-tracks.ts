const SAMPLE_RATE = 16_000;
const WINDOW_SEC = 0.2;
const MIN_SEGMENT_SEC = 0.5;
const PAD_SEC = 0.08;
const MIN_PEAK = 500;
const DOMINANT_RATIO = 2;

export type SegmentSource = 'system' | 'mic' | 'mix';

export type TrackSegment = {
  source: SegmentSource;
  startSec: number;
  endSec: number;
  peak: number;
  wav: Buffer;
};

type PcmWav = {
  fmt: Buffer;
  data: Buffer;
  sampleRate: number;
};

export function segmentTracks(micWav: Buffer | null, systemWav: Buffer | null, mixWav: Buffer): TrackSegment[] {
  const mic = parsePcm(micWav);
  const system = parsePcm(systemWav);
  const mix = parsePcm(mixWav);
  if (!mix) {
    return [];
  }
  const rate = mix.sampleRate || SAMPLE_RATE;
  const window = Math.max(1, Math.round(WINDOW_SEC * rate));
  const sampleCount = Math.max(
    mix.data.length / 2,
    mic ? mic.data.length / 2 : 0,
    system ? system.data.length / 2 : 0,
  );
  if (sampleCount <= 0) {
    return [];
  }

  const labels: Array<SegmentSource | 'silence'> = [];
  for (let start = 0; start < sampleCount; start += window) {
    const end = Math.min(start + window, sampleCount);
    const micPeak = peakOf(mic?.data, start, end);
    const sysPeak = peakOf(system?.data, start, end);
    labels.push(classifyWindow(micPeak, sysPeak));
  }

  const merged = mergeLabels(labels, window, sampleCount, rate);
  const segments: TrackSegment[] = [];
  for (const region of merged) {
    const sourceWav =
      region.source === 'system' && system
        ? system
        : region.source === 'mic' && mic
          ? mic
          : mix;
    const pad = Math.round(PAD_SEC * rate);
    const start = Math.max(0, region.startSample - pad);
    const end = Math.min(sourceWav.data.length / 2, region.endSample + pad);
    if (end - start < Math.round(MIN_SEGMENT_SEC * rate) * 0.5) {
      continue;
    }
    segments.push({
      source: region.source,
      startSec: start / rate,
      endSec: end / rate,
      peak: peakOf(sourceWav.data, start, end),
      wav: buildWav(sourceWav.fmt, sourceWav.data.subarray(start * 2, end * 2)),
    });
  }
  return segments;
}

function classifyWindow(micPeak: number, sysPeak: number): SegmentSource | 'silence' {
  if (micPeak < MIN_PEAK && sysPeak < MIN_PEAK) {
    return 'silence';
  }
  if (sysPeak >= MIN_PEAK && sysPeak >= micPeak * DOMINANT_RATIO) {
    return 'system';
  }
  if (micPeak >= MIN_PEAK && micPeak >= sysPeak * DOMINANT_RATIO) {
    return 'mic';
  }
  if (sysPeak >= MIN_PEAK && micPeak >= MIN_PEAK) {
    return 'mix';
  }
  return sysPeak >= micPeak ? 'system' : 'mic';
}

function mergeLabels(
  labels: Array<SegmentSource | 'silence'>,
  window: number,
  sampleCount: number,
  rate: number,
): Array<{ source: SegmentSource; startSample: number; endSample: number }> {
  const minSamples = Math.round(MIN_SEGMENT_SEC * rate);
  const regions: Array<{ source: SegmentSource; startSample: number; endSample: number }> = [];
  let index = 0;
  while (index < labels.length) {
    const label = labels[index];
    if (label === 'silence') {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < labels.length && labels[end] === label) {
      end += 1;
    }
    const startSample = index * window;
    const endSample = Math.min(end * window, sampleCount);
    if (endSample - startSample >= minSamples) {
      const last = regions[regions.length - 1];
      if (last && last.source === label) {
        last.endSample = endSample;
      } else {
        regions.push({ source: label, startSample, endSample });
      }
    }
    index = end;
  }
  return regions;
}

function peakOf(data: Buffer | undefined, startSample: number, endSample: number): number {
  if (!data) {
    return 0;
  }
  const last = Math.min(endSample, data.length / 2);
  const first = Math.max(0, startSample);
  let peak = 0;
  for (let sample = first; sample < last; sample += 1) {
    const value = Math.abs(data.readInt16LE(sample * 2));
    if (value > peak) {
      peak = value;
    }
  }
  return peak;
}

function parsePcm(input: Buffer | null): PcmWav | null {
  if (!input || input.length < 44) {
    return null;
  }
  if (input.subarray(0, 4).toString('ascii') !== 'RIFF' || input.subarray(8, 12).toString('ascii') !== 'WAVE') {
    return null;
  }
  let fmt: Buffer | undefined;
  let data: Buffer | undefined;
  let sampleRate = SAMPLE_RATE;
  let offset = 12;
  while (offset + 8 <= input.length) {
    const id = input.subarray(offset, offset + 4).toString('ascii');
    const size = input.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, input.length);
    if (id === 'fmt ' && end - start >= 16) {
      fmt = input.subarray(start, start + 16);
      sampleRate = fmt.readUInt32LE(4) || SAMPLE_RATE;
    } else if (id === 'data') {
      data = input.subarray(start, end);
    }
    offset = end + (size % 2);
  }
  if (!fmt || !data) {
    return null;
  }
  return { fmt, data, sampleRate };
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

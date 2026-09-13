import { splitWavBySeconds, splitWavBySilence, analyzeWavSilence, wavDurationSeconds } from './split-wav';

function pcmMono16k(sampleCount: number): Buffer {
  const dataSize = sampleCount * 2;
  const fmtSize = 16;
  const riffSize = 4 + 8 + fmtSize + 8 + dataSize;
  const out = Buffer.alloc(8 + riffSize);
  out.write('RIFF', 0);
  out.writeUInt32LE(riffSize, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(fmtSize, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24);
  out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(dataSize, 40);
  return out;
}

describe('wavDurationSeconds', () => {
  it('returns PCM seconds for a 16 kHz mono mix', () => {
    expect(wavDurationSeconds(pcmMono16k(16000 * 3))).toBeCloseTo(3);
  });

  it('returns null when the buffer is not a WAV', () => {
    expect(wavDurationSeconds(Buffer.from('not wav'))).toBeNull();
  });
});

describe('splitWavBySeconds', () => {
  it('keeps a short clip as one part', () => {
    const wav = pcmMono16k(16000);
    const parts = splitWavBySeconds(wav, 600);
    expect(parts).toHaveLength(1);
  });

  it('splits a 5-second mix into 2-second parts using chunkSeconds', () => {
    const wav = pcmMono16k(16000 * 5);
    const parts = splitWavBySeconds(wav, 2);
    expect(parts).toHaveLength(3);
    expect(parts[0].readUInt32LE(40)).toBe(16000 * 2 * 2);
    expect(parts[1].readUInt32LE(40)).toBe(16000 * 2 * 2);
    expect(parts[2].readUInt32LE(40)).toBe(16000 * 1 * 2);
  });

  it('returns the input when it is not a WAV', () => {
    const buf = Buffer.from('not wav');
    expect(splitWavBySeconds(buf, 10)).toEqual([buf]);
  });
});

describe('splitWavBySilence', () => {
  it('keeps a continuous tone as one part', () => {
    const wav = pcmMono16k(16000);
    fillTone(wav, 0, 16000, 8000);
    expect(splitWavBySilence(wav)).toHaveLength(1);
  });

  it('splits two bursts separated by a long silence', () => {
    const wav = pcmMono16k(16000 * 5);
    fillTone(wav, 0, 16000, 12000);
    fillTone(wav, 16000 * 4, 16000, 12000);
    const parts = splitWavBySilence(wav);
    expect(parts).toHaveLength(2);
    expect(wavDurationSeconds(parts[0])).toBeGreaterThan(0.9);
    expect(wavDurationSeconds(parts[1])).toBeGreaterThan(0.9);
    const analysis = analyzeWavSilence(wav);
    expect(analysis.regions).toHaveLength(2);
    expect(analysis.maxGapSec).toBeGreaterThan(0.7);
  });
});

function fillTone(wav: Buffer, startSample: number, count: number, amplitude: number): void {
  for (let i = 0; i < count; i += 1) {
    wav.writeInt16LE(amplitude, 44 + (startSample + i) * 2);
  }
}

import { canonicalizeWav } from './canonicalize-wav';

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

function wavWithJunk(): Buffer {
  const inner = pcmMono16k(8);
  const wave = inner.subarray(8);
  const junk = Buffer.alloc(12);
  junk.write('JUNK', 0);
  junk.writeUInt32LE(4, 4);
  junk.writeUInt32LE(0, 8);
  const body = Buffer.concat([Buffer.from('WAVE'), junk, wave.subarray(4)]);
  const out = Buffer.alloc(8 + body.length);
  out.write('RIFF', 0);
  out.writeUInt32LE(body.length, 4);
  body.copy(out, 8);
  return out;
}

describe('canonicalizeWav', () => {
  it('keeps a canonical 16-bit PCM mono 16 kHz WAV', () => {
    const input = pcmMono16k(16);
    const out = canonicalizeWav(input);
    expect(out.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(out.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(out.indexOf('JUNK')).toBe(-1);
    expect(out.readUInt16LE(22)).toBe(1);
    expect(out.readUInt32LE(24)).toBe(16000);
    expect(out.readUInt16LE(34)).toBe(16);
  });

  it('strips a JUNK chunk so only fmt and data remain', () => {
    const input = wavWithJunk();
    expect(input.includes(Buffer.from('JUNK'))).toBe(true);
    const out = canonicalizeWav(input);
    expect(out.includes(Buffer.from('JUNK'))).toBe(false);
    expect(out.subarray(12, 16).toString('ascii')).toBe('fmt ');
  });

  it('returns non-WAV buffers unchanged', () => {
    const input = Buffer.from('not a wav');
    expect(canonicalizeWav(input)).toBe(input);
  });
});

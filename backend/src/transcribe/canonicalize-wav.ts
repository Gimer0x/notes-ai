/**
 * Rewrite a PCM WAV to a canonical RIFF (fmt + data only).
 * macOS/QuickTime often prepends a JUNK chunk; GPT transcribe models reject that
 * with "unsupported_format". Non-WAV buffers are returned unchanged.
 */
export function canonicalizeWav(input: Buffer): Buffer {
  if (
    input.length < 12 ||
    input.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    input.subarray(8, 12).toString('ascii') !== 'WAVE'
  ) {
    return input;
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
    return input;
  }

  const fmtBody = fmt.subarray(0, 16);
  const pad = data.length % 2;
  const riffSize = 4 + 8 + fmtBody.length + 8 + data.length + pad;
  const out = Buffer.alloc(8 + riffSize);
  out.write('RIFF', 0);
  out.writeUInt32LE(riffSize, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(fmtBody.length, 16);
  fmtBody.copy(out, 20);
  const dataOff = 20 + fmtBody.length;
  out.write('data', dataOff);
  out.writeUInt32LE(data.length, dataOff + 4);
  data.copy(out, dataOff + 8);
  return out;
}

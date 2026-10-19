/** Pull readable strings out of a PDF without a native parser. */
export function extractPdfText(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  const found: string[] = [];
  const re = /\(((?:\\[nrtbf()\\]|\\[0-7]{1,3}|[^\\)])*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const text = decodePdfString(match[1]).replace(/\s+/g, ' ').trim();
    if (text.length > 1 && /[\p{L}]/u.test(text)) {
      found.push(text);
    }
  }
  return found.join(' ').replace(/\s+/g, ' ').trim().slice(0, 12000);
}

function decodePdfString(value: string): string {
  return value.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_all, code: string) => {
    if (code === 'n') return '\n';
    if (code === 'r') return '\r';
    if (code === 't') return '\t';
    if (code === 'b') return '\b';
    if (code === 'f') return '\f';
    if (code === '(' || code === ')' || code === '\\') return code;
    return String.fromCharCode(Number.parseInt(code, 8));
  });
}

const STT_PROMPT_ECHOES = [
  'Transcribe all speech in this application playback from the beginning. Ignore trailing silence. The language may be English or Spanish.',
  'Transcribe the microphone speech from the beginning to the end. The language may be English or Spanish.',
  'Transcribe every spoken word from the start of this clip to the end. The audio may include English and Spanish, app playback, and a microphone.',
];

/** Drop prompt echoes, symbol-only tokens, and words the recognizer did not form. */
export function cleanSpeech(value: string): string {
  let text = value;
  for (const prompt of STT_PROMPT_ECHOES) {
    const escaped = prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    text = text.replace(new RegExp(escaped, 'ig'), ' ');
  }
  text = text.replace(/\[[^\]\n]{0,48}\]/g, ' ').replace(/[♪♫♬]+/g, ' ');
  const words = text
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && keepToken(token));
  return words
    .join(' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function keepToken(token: string): boolean {
  const letters = token.replace(/[^\p{L}]/gu, '');
  if (!letters) {
    return false;
  }
  if (/^(.)\1{3,}$/iu.test(letters)) {
    return false;
  }
  if (letters.length >= 5 && !/[aeiouáéíóúüàèìòùâêîôûäëïöüy]/i.test(letters)) {
    return false;
  }
  return true;
}

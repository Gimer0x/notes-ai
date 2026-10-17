import { cleanSpeech } from './clean-speech';

describe('cleanSpeech', () => {
  it('drops symbols, prompt echoes, and words with no vowels', () => {
    const cleaned = cleanSpeech(
      'Transcribe the microphone speech from the beginning to the end. The language may be English or Spanish. Hola ??? [music] ♪ zxcvbnm hola.',
    );
    expect(cleaned).toBe('Hola hola.');
  });
});

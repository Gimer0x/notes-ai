import { cleanSpeech } from './clean-speech';

describe('cleanSpeech', () => {
  it('drops symbols, prompt echoes, and words with no vowels', () => {
    const cleaned = cleanSpeech(
      'Transcribe the microphone speech from the beginning to the end. The language may be English or Spanish. Hola ??? [music] ♪ zxcvbnm hola.',
    );
    expect(cleaned).toBe('Hola hola.');
  });

  it('drops a lone accented letter and characters from other writing systems', () => {
    expect(cleanSpeech('É')).toBe('');
    expect(cleanSpeech('베')).toBe('');
    expect(cleanSpeech('pero no tanto. É Creo que sí. 베 Pero híjole.')).toBe(
      'pero no tanto. Creo que sí. Pero híjole.',
    );
    expect(cleanSpeech('A y o I Éxito')).toBe('A y o I Éxito');
  });
});

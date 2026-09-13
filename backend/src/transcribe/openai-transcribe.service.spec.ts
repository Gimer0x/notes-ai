import { stripSttPromptEcho } from './openai-transcribe.service';

describe('stripSttPromptEcho', () => {
  it('drops the mic instruction when it is the whole result', () => {
    expect(
      stripSttPromptEcho(
        'Transcribe the microphone speech from the beginning to the end. The language may be English or Spanish.',
      ),
    ).toBe('');
  });

  it('keeps speech after the instruction', () => {
    expect(
      stripSttPromptEcho(
        'Transcribe the microphone speech from the beginning to the end. The language may be English or Spanish. Hola, ¿cómo estás?',
      ),
    ).toBe('Hola, ¿cómo estás?');
  });

  it('leaves a real transcript unchanged', () => {
    expect(stripSttPromptEcho('OK, now I am going back to YouTube.')).toBe(
      'OK, now I am going back to YouTube.',
    );
  });
});

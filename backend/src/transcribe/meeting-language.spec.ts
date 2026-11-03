import { mainMeetingLanguage, meetingLanguage } from './meeting-language';

describe('meetingLanguage', () => {
  it('uses Spanish when Spanish is the main language', () => {
    expect(
      meetingLanguage(
        'Hola, vamos a revisar la propuesta y vamos a hablar de los siguientes puntos en la reunión.',
      ),
    ).toBe('es');
  });

  it('uses English for English audio', () => {
    expect(
      meetingLanguage('Hello, we are going to review the proposal and talk about the next points.'),
    ).toBe('en');
  });

  it('uses English when the audio is neither English nor Spanish', () => {
    expect(
      meetingLanguage('Guten Tag, wir sprechen heute über das Projekt und die nächsten Schritte.'),
    ).toBe('en');
  });

  it('lets a long Spanish stretch outweigh a short English one', () => {
    expect(
      mainMeetingLanguage([
        { text: 'Okay, the meeting is starting.', seconds: 8 },
        {
          text: 'Hola, vamos a revisar la propuesta y vamos a hablar de los siguientes puntos en la reunión de hoy.',
          seconds: 120,
        },
      ]),
    ).toBe('es');
  });

  it('keeps English when English is the longer part', () => {
    expect(
      mainMeetingLanguage([
        { text: 'Hola, gracias por venir a la reunión.', seconds: 8 },
        {
          text: 'We are going to review the proposal and talk about the next points with the team.',
          seconds: 120,
        },
      ]),
    ).toBe('en');
  });
});

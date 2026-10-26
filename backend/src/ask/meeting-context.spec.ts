import { buildChatMessages } from './ask.prompts';
import { buildMeetingContext } from './meeting-context';
import { extractPdfText } from './pdf-text';

describe('buildMeetingContext', () => {
  it('puts the open note first and still keeps room for another meeting', () => {
    const context = buildMeetingContext(
      [
        {
          id: 'newer',
          title: 'Standup',
          workspace: 'Personal',
          when: '2026-10-21',
          summary: 'Ship the draft.',
          transcript: '',
        },
        {
          id: 'open-note',
          title: 'Maricela colors',
          workspace: 'Personal',
          when: '2026-10-17',
          summary: 'Marisela will look up the colors.',
          transcript: '',
        },
      ],
      24000,
      'open-note',
    );
    expect(context.startsWith('Open note: Maricela colors')).toBe(true);
    expect(context).toContain('Meeting: Standup');
  });

  it('keeps the newest meetings until the character budget is full', () => {
    const context = buildMeetingContext(
      [
        {
          title: 'Network helpers',
          workspace: 'CoBuilders',
          when: '2026-10-16',
          summary: 'Next steps: send the one-pager.',
          transcript: 'We agreed on three scenarios.',
        },
        {
          title: 'Later',
          workspace: 'Personal',
          when: '2026-10-17',
          summary: 'x'.repeat(30000),
          transcript: '',
        },
      ],
      500,
    );
    expect(context).toContain('Network helpers');
    expect(context).not.toContain('Later');
  });
});

describe('buildChatMessages', () => {
  it('names the meeting and sends an image with the latest question', () => {
    const messages = buildChatMessages(
      [
        {
          title: 'Canton team',
          workspace: 'Personal',
          when: '2026-10-14',
          summary: 'Next steps: call Lautaro.',
          transcript: '',
        },
      ],
      [{ role: 'user', text: 'What did we decide?' }],
      [{ name: 'photo.png', mime: 'image/png', dataBase64: 'aGk=' }],
    );
    expect(messages[0]?.content).toContain('Canton team');
    expect(Array.isArray(messages[1]?.content)).toBe(true);
  });
});

describe('extractPdfText', () => {
  it('reads parenthesized text from a PDF buffer', () => {
    const buffer = Buffer.from('BT (Network helpers) Tj ET', 'latin1');
    expect(extractPdfText(buffer)).toBe('Network helpers');
  });
});

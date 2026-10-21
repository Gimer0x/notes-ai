import { buildTodoAnswer, extractTodoItems, isTodoRequest } from './next-steps';

const now = new Date('2026-10-21T18:00:00.000Z');

describe('extractTodoItems', () => {
  it('keeps next steps and to-dos, and reads a due date', () => {
    const items = extractTodoItems(
      `# Decisions
• Ship the draft
# Next steps
• Send the one-pager before 4/11/2026
# Pendientes
• Book the review on 21 de octubre de 2026
# Conclusions
• Nothing else`,
      2026,
    );
    expect(items).toEqual([
      { text: 'Send the one-pager before 4/11/2026', due: '4/11/2026' },
      { text: 'Book the review on 21 de octubre de 2026', due: '21/10/2026' },
    ]);
  });

  it('reads Spanish follow-ups and ignores a conclusions-only note', () => {
    expect(extractTodoItems(`# Próximos pasos\n• Llamar a Lautaro`, 2026)).toEqual([
      { text: 'Llamar a Lautaro', due: '' },
    ]);
    expect(extractTodoItems(`# Conclusiones\n• Cerrar el tema`, 2026)).toEqual([]);
  });

  it('reads actions from the whole note, not only a task heading', () => {
    const items = extractTodoItems(
      `# Objetivo de la reunión
• Discutir los colores
# Tareas asignadas
• Marisela Moreno se encargará de buscar los colores específicos.
# Proceso de trabajo
• Se acordó seguir los siguientes pasos:
  1. Marisela buscará los colores.
  2. Se actualizará la aplicación una vez que se tengan los colores.
# Seguimiento
• Se programará una próxima reunión para revisar los avances.
# Conclusiones
• Se definieron las tareas.`,
      2026,
    );
    expect(items.map((item) => item.text)).toEqual([
      'Marisela Moreno se encargará de buscar los colores específicos.',
      'Marisela buscará los colores.',
      'Se actualizará la aplicación una vez que se tengan los colores.',
      'Se programará una próxima reunión para revisar los avances.',
    ]);
  });

  it('keeps a next step written as a sentence and skips past tactics', () => {
    expect(
      extractTodoItems(
        'The candidate is interested in a senior Rust position.\nThe next steps include scheduling the technical interview.',
        2026,
      ).map((item) => item.text),
    ).toEqual(['The next steps include scheduling the technical interview.']);
    expect(
      extractTodoItems(
        `# Estrategia
• Ajustes tácticos:
  1. En el primer partido, Pumas dominó el juego.
  2. En el segundo partido, se cambió a una línea de 4.`,
        2026,
      ),
    ).toEqual([]);
  });
});

describe('buildTodoAnswer', () => {
  it('groups the last four weeks by note and skips older notes', () => {
    const answer = buildTodoAnswer(
      [
        {
          title: 'Tarea de Colores de Maricela',
          workspace: 'Personal',
          when: '2026-10-18T15:00:00.000Z',
          summary: '# Próximos pasos\n• Marisela buscará los colores.\n• Revisar avances el 4/11/2026',
          transcript: '',
        },
        {
          title: 'Standup',
          workspace: 'Personal',
          when: '2026-10-10T15:00:00.000Z',
          summary: '# Conclusiones\n• No follow-up',
          transcript: '',
        },
        {
          title: 'Old meeting',
          workspace: 'Personal',
          when: '2026-08-01T15:00:00.000Z',
          summary: '# Next steps\n• Ignore this',
          transcript: '',
        },
      ],
      now,
    );
    expect(answer).toContain('@@todos');
    expect(answer).toContain('from 2026-09-23T18:00:00.000Z');
    expect(answer).toContain('to 2026-10-21T18:00:00.000Z');
    expect(answer).toContain('@@note\nTarea de Colores de Maricela');
    expect(answer).toContain('Marisela buscará los colores.');
    expect(answer).toContain('@@due\n4/11/2026');
    expect(answer).not.toContain('Standup');
    expect(answer).not.toContain('Old meeting');
    expect(answer).not.toContain('Ignore this');
  });
});

describe('isTodoRequest', () => {
  it('matches the list-recent-todos prompts', () => {
    expect(isTodoRequest('List the recent to-dos and next steps from my meetings.')).toBe(true);
    expect(isTodoRequest('What did we decide?')).toBe(false);
  });
});

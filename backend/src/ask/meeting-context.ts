export type MeetingSnippet = {
  id?: string;
  title: string;
  workspace: string;
  when: string;
  summary: string;
  transcript: string;
};

const SUMMARY_LIMIT = 2000;
const TRANSCRIPT_LIMIT = 2500;
const FOCUS_SUMMARY_LIMIT = 8000;
const FOCUS_TRANSCRIPT_LIMIT = 6000;

export function buildMeetingContext(
  meetings: MeetingSnippet[],
  maxChars = 24000,
  focusId?: string,
): string {
  const ordered = orderMeetings(meetings, focusId);
  const blocks: string[] = [];
  let used = 0;
  const reserve = focusId ? Math.min(8000, Math.floor(maxChars / 3)) : 0;
  for (const meeting of ordered) {
    const focused = Boolean(focusId) && meeting.id === focusId;
    const summary = meeting.summary.trim().slice(0, focused ? FOCUS_SUMMARY_LIMIT : SUMMARY_LIMIT);
    const transcript = meeting.transcript.trim().slice(0, focused ? FOCUS_TRANSCRIPT_LIMIT : TRANSCRIPT_LIMIT);
    const lines = [
      `${focused ? 'Open note' : 'Meeting'}: ${meeting.title.trim() || 'Untitled'}`,
      `Workspace: ${meeting.workspace.trim() || 'Personal'}`,
      `When: ${meeting.when}`,
    ];
    if (summary) {
      lines.push(`Summary:\n${summary}`);
    }
    if (transcript) {
      lines.push(`Transcript:\n${transcript}`);
    }
    const block = lines.join('\n');
    const cap = focused ? Math.max(0, maxChars - reserve) : maxChars;
    if (blocks.length > 0 && used + block.length > cap) {
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  return blocks.join('\n\n');
}

function orderMeetings(meetings: MeetingSnippet[], focusId?: string): MeetingSnippet[] {
  if (!focusId) {
    return meetings;
  }
  const index = meetings.findIndex((meeting) => meeting.id === focusId);
  if (index <= 0) {
    return meetings;
  }
  const ordered = meetings.slice();
  const [focus] = ordered.splice(index, 1);
  return focus ? [focus, ...ordered] : ordered;
}

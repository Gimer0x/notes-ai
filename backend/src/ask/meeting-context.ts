export type MeetingSnippet = {
  title: string;
  workspace: string;
  when: string;
  summary: string;
  transcript: string;
};

const SUMMARY_LIMIT = 2000;
const TRANSCRIPT_LIMIT = 2500;

export function buildMeetingContext(meetings: MeetingSnippet[], maxChars = 24000): string {
  const blocks: string[] = [];
  let used = 0;
  for (const meeting of meetings) {
    const summary = meeting.summary.trim().slice(0, SUMMARY_LIMIT);
    const transcript = meeting.transcript.trim().slice(0, TRANSCRIPT_LIMIT);
    const lines = [
      `Meeting: ${meeting.title.trim() || 'Untitled'}`,
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
    if (blocks.length > 0 && used + block.length > maxChars) {
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  return blocks.join('\n\n');
}

import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';

type TraceSource = 'helper' | 'frontend';

type TraceLine = {
  at: string;
  source: TraceSource;
  line: string;
};

export type TraceSegment = {
  index: number;
  startSec: number;
  endSec: number;
  source: string;
  peak: number;
  bytes: number;
  language?: string;
  chars?: number;
  preview?: string;
};

const lines: TraceLine[] = [];

export function resetSessionTrace(): void {
  lines.length = 0;
}

export function trace(source: TraceSource, text: string): void {
  const at = new Date().toISOString();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    lines.push({ at, source, line: trimmed });
  }
}

export async function writeSessionTrace(details: {
  inputName: string;
  systemAudioEnabled: boolean;
  durationSeconds?: number;
  segments: TraceSegment[];
  backendLogs: string[];
  error?: string;
}): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(__dirname, '..', 'debug-logs');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `capture-${stamp}.log`);
  const body = render(file, details);
  await writeFile(file, body, 'utf8');
  return file;
}

function render(
  file: string,
  details: {
    inputName: string;
    systemAudioEnabled: boolean;
    durationSeconds?: number;
    segments: TraceSegment[];
    backendLogs: string[];
    error?: string;
  },
): string {
  const helper = lines.filter((line) => line.source === 'helper');
  const frontend = lines.filter((line) => line.source === 'frontend');
  const devices = helper.filter((line) => isDeviceLine(line.line));
  const duration =
    details.durationSeconds !== undefined && Number.isFinite(details.durationSeconds)
      ? details.durationSeconds.toFixed(2)
      : 'unknown';
  const sources =
    details.segments.length === 0
      ? '(no segments)'
      : details.segments
          .map((segment) => {
            const transcript =
              segment.language !== undefined
                ? ` lang=${segment.language} chars=${segment.chars ?? 0} preview=${segment.preview ?? ''}`
                : '';
            return `segment ${segment.index} ${segment.startSec.toFixed(2)}-${segment.endSec.toFixed(2)}s source=${segment.source} peak=${segment.peak} bytes=${segment.bytes}${transcript}`;
          })
          .join('\n');
  return [
    '# Pith capture debug',
    'Temporary log for bug reports. Not used by the app.',
    `file: ${file}`,
    `written: ${new Date().toISOString()}`,
    `input: ${details.inputName || 'unknown'}`,
    `systemAudio: ${details.systemAudioEnabled}`,
    `durationSeconds: ${duration}`,
    ...(details.error ? [`error: ${details.error}`] : []),
    '',
    '## Audio sources',
    sources,
    '',
    '## Devices',
    devices.length === 0 ? '(no device lines)' : devices.map(formatLine).join('\n'),
    '',
    '## Helper',
    helper.length === 0 ? '(no helper lines)' : helper.map(formatLine).join('\n'),
    '',
    '## Frontend',
    frontend.length === 0 ? '(no frontend lines)' : frontend.map(formatLine).join('\n'),
    '',
    '## Backend',
    details.backendLogs.length === 0 ? '(no backend lines)' : details.backendLogs.join('\n'),
    '',
  ].join('\n');
}

function formatLine(line: TraceLine): string {
  return `${line.at} ${line.line}`;
}

function isDeviceLine(line: string): boolean {
  return (
    line.includes('bluetooth') ||
    line.includes('route ') ||
    line.includes('device router') ||
    line.includes('rebind mic') ||
    line.includes('handover') ||
    line.includes('mic start') ||
    line.includes('mic format') ||
    line.includes('mic input') ||
    line.includes('system tap') ||
    line.includes('system audio') ||
    line.includes('input format') ||
    line.includes('output format') ||
    line.includes('configuration changed')
  );
}

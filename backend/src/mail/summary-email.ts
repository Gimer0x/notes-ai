export type SummaryEmailInput = {
  title: string;
  dateLabel: string;
  lines: string[];
};

export type SummaryEmailContent = {
  subject: string;
  text: string;
  html: string;
};

const ACCENT = '#2537d5';
const WASH = '#7e89e6';
const INK = '#2a2e3c';
const MUTED = '#6b7080';
const PAGE = '#ffffff';
const WELL = '#f7f8fb';

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'bullet'; text: string; depth: number }
  | { kind: 'numbered'; text: string; n: string; depth: number }
  | { kind: 'paragraph'; text: string };

export function buildSummaryEmail(input: SummaryEmailInput): SummaryEmailContent {
  const title = input.title.trim() || 'Untitled';
  const dateLabel = input.dateLabel.trim() || '';
  const blocks = parseBlocks(input.lines);
  const subject = dateLabel
    ? `Notes for "${title}" - ${dateLabel}`
    : `Notes for "${title}"`;
  const titleLine = dateLabel ? `${title} ${dateLabel}` : title;
  return {
    subject,
    text: buildText(titleLine, blocks),
    html: buildHtml(title, titleLine, blocks),
  };
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let bulletDepth = 0;
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    const indent = line.match(/^ */)?.[0].length ?? 0;
    const depth = Math.min(3, Math.floor(indent / 2));
    const text = line.trim();
    if (!text) {
      continue;
    }
    if (/^#+\s+/.test(text)) {
      bulletDepth = 0;
      blocks.push({ kind: 'heading', text: text.replace(/^#+\s+/, '').trim() });
      continue;
    }
    const numbered = text.match(/^(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      // Numbered steps sit under a bullet (third visual level), even if indent was stripped.
      const nested = Math.max(depth, bulletDepth + 1, 1);
      blocks.push({
        kind: 'numbered',
        n: numbered[1],
        text: numbered[2].trim(),
        depth: nested,
      });
      continue;
    }
    const bullet = text.match(/^[•\-*]\s+(.*)$/);
    if (bullet) {
      bulletDepth = depth;
      blocks.push({ kind: 'bullet', text: bullet[1].trim(), depth });
      continue;
    }
    blocks.push({ kind: 'paragraph', text });
  }
  return blocks;
}

function buildText(titleLine: string, blocks: Block[]): string {
  const parts = ['Meeting notes', titleLine, ''];
  for (const block of blocks) {
    if (block.kind === 'heading') {
      if (parts[parts.length - 1] !== '') {
        parts.push('');
      }
      parts.push(block.text);
      parts.push('');
      continue;
    }
    const pad = '  '.repeat(block.kind === 'paragraph' ? 0 : block.depth + 1);
    if (block.kind === 'numbered') {
      parts.push(`${pad}${block.n}. ${block.text}`);
    } else if (block.kind === 'bullet') {
      parts.push(`${pad}• ${block.text}`);
    } else {
      parts.push(block.text);
    }
  }
  parts.push('', 'Shared with Pith. Reply to this email to reach the sender.');
  return parts.join('\n').trim() + '\n';
}

function buildHtml(title: string, titleLine: string, blocks: Block[]): string {
  const body = blocks.map((block) => renderBlock(block)).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${WELL};color:${INK};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${WELL};padding:24px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:${PAGE};border-radius:12px;overflow:hidden;border:1px solid rgba(37,55,213,0.14);">
        <tr>
          <td style="height:4px;line-height:4px;font-size:0;background:${ACCENT};">&nbsp;</td>
        </tr>
        <tr>
          <td style="padding:28px 28px 8px;background:${PAGE};">
            <p style="margin:0;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:${ACCENT};font-weight:600;">Meeting notes</p>
            <h1 style="margin:8px 0 0;font-size:22px;line-height:1.3;font-weight:700;color:${INK};">${escapeHtml(titleLine)}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 28px 8px;">
            ${body || `<p style="margin:0;color:${MUTED};">No summary.</p>`}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 28px 24px;background:${WELL};border-top:1px solid rgba(37,55,213,0.12);">
            <p style="margin:0;font-size:12px;line-height:1.5;color:${MUTED};">Shared with Pith. Reply to this email to reach the sender.</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function renderBlock(block: Block): string {
  if (block.kind === 'heading') {
    return `<h2 style="margin:24px 0 10px;font-size:16px;line-height:1.35;font-weight:700;color:${ACCENT};">${escapeHtml(block.text)}</h2>`;
  }
  if (block.kind === 'paragraph') {
    return `<p style="margin:0 0 10px;font-size:15px;line-height:1.55;color:${INK};">${escapeHtml(block.text)}</p>`;
  }
  const pad = 8 + block.depth * 22;
  if (block.kind === 'numbered') {
    return `<p style="margin:0 0 8px;padding-left:${pad}px;font-size:15px;line-height:1.55;color:${INK};"><span style="color:${WASH};font-weight:600;margin-right:8px;">${escapeHtml(block.n)}.</span>${escapeHtml(block.text)}</p>`;
  }
  return `<p style="margin:0 0 8px;padding-left:${pad}px;font-size:15px;line-height:1.55;color:${INK};"><span style="color:${WASH};margin-right:8px;">•</span>${escapeHtml(block.text)}</p>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

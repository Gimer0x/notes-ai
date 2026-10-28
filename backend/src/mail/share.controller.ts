import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user';
import { NotesService } from '../notes/notes.service';
import { UsersService } from '../users/users.service';
import { MailService } from './mail.service';
import { buildSummaryEmail } from './summary-email';

const MAX_RECIPIENTS = 10;

@Controller()
@UseGuards(AuthGuard)
export class ShareController {
  constructor(
    private readonly notes: NotesService,
    private readonly users: UsersService,
    private readonly mail: MailService,
  ) {}

  @Post('notes/:id/share')
  @HttpCode(204)
  async share(
    @CurrentUserId() userId: string,
    @Param('id') noteId: string,
    @Body() body: { emails?: unknown },
  ): Promise<void> {
    const recipients = cleanEmails(body?.emails);
    if (recipients.length === 0) {
      throw new BadRequestException('emails_required');
    }
    const note = await this.notes.get(userId, noteId);
    if (note.status !== 'ready') {
      throw new ConflictException('not_ready');
    }
    const summary = note.summaryText
      .map((line) => line.replace(/\s+$/g, ''))
      .filter((line) => line.trim().length > 0);
    if (summary.length === 0) {
      throw new ConflictException('no_summary');
    }
    const user = await this.users.findById(userId);
    if (!user?.email) {
      throw new NotFoundException('user_not_found');
    }
    const title = (note.title ?? '').trim() || 'Untitled';
    const when = formatShareDate(note.startedAt ?? note.createdAt);
    const email = buildSummaryEmail({
      title,
      dateLabel: when,
      lines: summary,
    });
    await this.mail.sendSummary({
      to: recipients,
      replyTo: user.email,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
  }
}

function cleanEmails(value: unknown): string[] {
  const raw: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        raw.push(item);
      }
    }
  } else if (typeof value === 'string') {
    raw.push(...value.split(/[\s,;]+/));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const email = item.trim().toLowerCase();
    if (!email || seen.has(email) || !isEmail(email)) {
      continue;
    }
    seen.add(email);
    out.push(email);
    if (out.length >= MAX_RECIPIENTS) {
      break;
    }
  }
  return out;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function formatShareDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

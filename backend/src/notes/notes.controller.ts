import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user';
import type { NoteResponse } from './note.types';
import { NotesService } from './notes.service';

@Controller()
@UseGuards(AuthGuard)
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get('workspaces/:workspaceId/notes')
  list(
    @CurrentUserId() userId: string,
    @Param('workspaceId') workspaceId: string,
  ): Promise<NoteResponse[]> {
    return this.notes.list(userId, workspaceId);
  }

  @Post('workspaces/:workspaceId/notes')
  @HttpCode(201)
  create(
    @CurrentUserId() userId: string,
    @Param('workspaceId') workspaceId: string,
    @Body() body: { title?: string | null },
  ): Promise<NoteResponse> {
    return this.notes.create(userId, workspaceId, body.title ?? null);
  }

  @Get('notes/:id')
  get(@CurrentUserId() userId: string, @Param('id') noteId: string): Promise<NoteResponse> {
    return this.notes.get(userId, noteId);
  }

  @Patch('notes/:id')
  rename(
    @CurrentUserId() userId: string,
    @Param('id') noteId: string,
    @Body() body: { title?: string | null },
  ): Promise<NoteResponse> {
    return this.notes.rename(userId, noteId, body.title ?? null);
  }

  @Post('notes/:id/move')
  @HttpCode(200)
  move(
    @CurrentUserId() userId: string,
    @Param('id') noteId: string,
    @Body() body: { workspaceId?: string },
  ): Promise<NoteResponse> {
    return this.notes.move(userId, noteId, body.workspaceId ?? '');
  }

  @Delete('notes/:id')
  @HttpCode(204)
  async remove(@CurrentUserId() userId: string, @Param('id') noteId: string): Promise<void> {
    await this.notes.remove(userId, noteId);
  }

  @Post('notes/:id/cancel')
  @HttpCode(200)
  async cancel(
    @CurrentUserId() userId: string,
    @Param('id') noteId: string,
  ): Promise<{ ok: true }> {
    await this.notes.cancel(userId, noteId);
    return { ok: true };
  }

  @Post('notes/:id/stop')
  @HttpCode(200)
  stop(
    @CurrentUserId() userId: string,
    @Param('id') noteId: string,
    @Body() body: { durationSeconds?: number; transcriptText?: string | null; language?: string | null },
  ): Promise<NoteResponse> {
    const language = body.language === 'en' || body.language === 'es' ? body.language : null;
    return this.notes.stop(
      userId,
      noteId,
      Number(body.durationSeconds),
      body.transcriptText,
      language,
    );
  }

  @Post('notes/:id/retry')
  @HttpCode(200)
  retry(@CurrentUserId() userId: string, @Param('id') noteId: string): Promise<NoteResponse> {
    return this.notes.retry(userId, noteId);
  }
}

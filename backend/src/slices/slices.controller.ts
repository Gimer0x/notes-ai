import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Express } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user';
import { SlicesService, type SliceProgress } from './slices.service';

const SLICE_MAX_BYTES = 32 * 1024 * 1024;

@Controller()
@UseGuards(AuthGuard)
export class SlicesController {
  constructor(private readonly slices: SlicesService) {}

  @Post('notes/:id/slices')
  @HttpCode(202)
  @UseInterceptors(
    FileInterceptor('audio', {
      storage: memoryStorage(),
      limits: { fileSize: SLICE_MAX_BYTES },
    }),
  )
  accept(
    @CurrentUserId() userId: string,
    @Param('id') noteId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { seq?: string; startSec?: string; endSec?: string; source?: string },
  ): Promise<{ sliceId: string }> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('audio_required');
    }
    if (file.buffer.length < 44 || file.buffer.toString('ascii', 0, 4) !== 'RIFF') {
      throw new BadRequestException('invalid_audio');
    }
    if (body == null || typeof body !== 'object') {
      throw new BadRequestException('invalid_input');
    }
    const source = body.source === 'mic' || body.source === 'system' || body.source === 'mix' ? body.source : null;
    if (!source) {
      throw new BadRequestException('source');
    }
    return this.slices.accept({
      userId,
      noteId,
      seq: Number(body.seq),
      source,
      startSec: Number(body.startSec),
      endSec: Number(body.endSec),
      wav: file.buffer,
    });
  }

  @Get('notes/:id/slices')
  progress(@CurrentUserId() userId: string, @Param('id') noteId: string): Promise<SliceProgress> {
    return this.slices.progress(userId, noteId);
  }

  @Post('notes/:id/seal')
  @HttpCode(200)
  async seal(
    @CurrentUserId() userId: string,
    @Param('id') noteId: string,
    @Body() body: { finalSeq?: number; durationSeconds?: number; typedNotes?: string | null },
  ): Promise<{ ok: true }> {
    if (typeof body.finalSeq !== 'number' || typeof body.durationSeconds !== 'number') {
      throw new BadRequestException('final_seq');
    }
    if (body.typedNotes != null && typeof body.typedNotes !== 'string') {
      throw new BadRequestException('typed_notes');
    }
    await this.slices.seal({
      userId,
      noteId,
      finalSeq: body.finalSeq,
      durationSeconds: body.durationSeconds,
      typedNotes: body.typedNotes ?? '',
    });
    return { ok: true };
  }
}

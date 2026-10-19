import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user';
import { AskService } from './ask.service';
import type { AskFile, AskTurn } from './ask.prompts';

@Controller('ask')
@UseGuards(AuthGuard)
export class AskController {
  constructor(private readonly ask: AskService) {}

  @Post()
  @HttpCode(200)
  answer(
    @CurrentUserId() userId: string,
    @Body() body: { messages?: AskTurn[]; attachments?: AskFile[] },
  ): Promise<{ answer: string }> {
    return this.ask.ask(userId, body.messages ?? [], body.attachments ?? []);
  }

  @Post('voice')
  @HttpCode(200)
  voice(
    @Body() body: { dataBase64?: string; mime?: string; name?: string },
  ): Promise<{ text: string }> {
    return this.ask.transcribeQuestion(body.dataBase64 ?? '', body.mime ?? '', body.name ?? '');
  }
}

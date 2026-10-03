import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user';
import type { WorkspaceResponse } from './note.types';
import { WorkspacesService } from './workspaces.service';

@Controller('workspaces')
@UseGuards(AuthGuard)
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  list(@CurrentUserId() userId: string): Promise<WorkspaceResponse[]> {
    return this.workspaces.list(userId);
  }

  @Post()
  @HttpCode(201)
  create(
    @CurrentUserId() userId: string,
    @Body() body: { name?: string },
  ): Promise<WorkspaceResponse> {
    return this.workspaces.create(userId, body.name ?? '');
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUserId() userId: string,
    @Param('id') workspaceId: string,
  ): Promise<void> {
    await this.workspaces.remove(userId, workspaceId);
  }
}

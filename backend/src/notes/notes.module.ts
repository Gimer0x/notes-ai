import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { SlicesModule } from '../slices/slices.module';
import { SummaryModule } from '../summary/summary.module';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [AuthModule, BillingModule, SummaryModule, SlicesModule],
  controllers: [WorkspacesController, NotesController],
  providers: [WorkspacesService, NotesService],
  exports: [NotesService],
})
export class NotesModule {}


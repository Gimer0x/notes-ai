import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AskController } from './ask.controller';
import { AskService } from './ask.service';

@Module({
  imports: [AuthModule],
  controllers: [AskController],
  providers: [AskService],
})
export class AskModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotesModule } from '../notes/notes.module';
import { UsersModule } from '../users/users.module';
import { MailModule } from './mail.module';
import { ShareController } from './share.controller';

@Module({
  imports: [AuthModule, UsersModule, NotesModule, MailModule],
  controllers: [ShareController],
})
export class ShareModule {}

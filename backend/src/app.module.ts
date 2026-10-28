import { config as loadEnv } from 'dotenv';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { spikeEnabled } from './config/app-config';
import { AskModule } from './ask/ask.module';
import { BillingModule } from './billing/billing.module';
import { ConfigApiModule } from './config/config-api.module';
import { DbModule } from './db/db.module';
import { HealthModule } from './health/health.module';
import { MeModule } from './me/me.module';
import { NotesModule } from './notes/notes.module';
import { AuthModule } from './auth/auth.module';
import { ShareModule } from './mail/share.module';
import { SpikeModule } from './spike/spike.module';
import { SlicesModule } from './slices/slices.module';
import { TranscribeModule } from './transcribe/transcribe.module';


const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
loadEnv({ path: envFile });

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: envFile }),
    DbModule,
    HealthModule,
    ConfigApiModule,
    AuthModule,
    MeModule,
    BillingModule,
    NotesModule,
    ShareModule,
    SlicesModule,
    AskModule,
    TranscribeModule,
    ...(spikeEnabled() ? [SpikeModule] : []),
  ],
})
export class AppModule {}

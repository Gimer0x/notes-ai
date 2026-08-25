import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { MeController } from './me.controller';

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [MeController],
})
export class MeModule {}

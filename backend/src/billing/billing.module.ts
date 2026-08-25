import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { StripeService } from './stripe.service';

@Module({
  imports: [AuthModule, UsersModule],
  controllers: [BillingController],
  providers: [BillingService, StripeService],
  exports: [BillingService],
})
export class BillingModule {}

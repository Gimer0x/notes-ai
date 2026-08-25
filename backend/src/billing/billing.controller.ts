import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user';
import { StripeService } from './stripe.service';

@Controller('billing')
export class BillingController {
  constructor(private readonly stripe: StripeService) {}

  @Post('checkout-session')
  @UseGuards(AuthGuard)
  createCheckout(
    @CurrentUserId() userId: string,
    @Body() body: { interval?: string },
  ): Promise<{ url: string }> {
    const interval = body.interval;
    if (interval !== 'month' && interval !== 'year') {
      throw new BadRequestException('interval must be month or year');
    }
    return this.stripe.createCheckoutSession(userId, interval);
  }

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Headers('stripe-signature') signature: string | undefined,
    @Req() request: RawBodyRequest<Request>,
  ): Promise<{ received: true }> {
    const raw = request.rawBody;
    if (!raw) {
      throw new BadRequestException('missing raw body');
    }
    await this.stripe.handleWebhook(raw, signature);
    return { received: true };
  }
}

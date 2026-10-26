import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user';
import { BillingService } from '../billing/billing.service';
import { StripeService } from '../billing/stripe.service';
import { UsersService } from '../users/users.service';

export type MeResponse = {
  id: string;
  email: string;
  displayName: string | null;
  pictureUrl: string | null;
  plan: 'free' | 'paid';
  planInterval: 'month' | 'year' | null;
  remainingSeconds: number;
  remainingNotes: number | null;
};

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly billing: BillingService,
    private readonly stripe: StripeService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async me(@CurrentUserId() userId: string): Promise<MeResponse> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new Error('user not found');
    }
    const status = await this.billing.getStatus(userId);
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      pictureUrl: user.avatar_url ?? null,
      plan: status.plan,
      planInterval: status.planInterval,
      remainingSeconds: status.remainingSeconds,
      remainingNotes: status.remainingNotes,
    };
  }

  @Delete()
  @HttpCode(204)
  async remove(
    @CurrentUserId() userId: string,
    @Body() body: { confirm?: string },
  ): Promise<void> {
    if (body.confirm !== 'DELETE') {
      throw new BadRequestException('confirm_delete');
    }
    const subscriptionId = await this.users.subscriptionId(userId);
    if (subscriptionId) {
      await this.stripe.cancelSubscription(subscriptionId);
    }
    await this.users.deleteAccount(userId);
  }
}

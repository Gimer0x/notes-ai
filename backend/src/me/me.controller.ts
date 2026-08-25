import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUserId } from '../auth/current-user';
import { BillingService } from '../billing/billing.service';
import { UsersService } from '../users/users.service';

export type MeResponse = {
  id: string;
  email: string;
  displayName: string | null;
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
      plan: status.plan,
      planInterval: status.planInterval,
      remainingSeconds: status.remainingSeconds,
      remainingNotes: status.remainingNotes,
    };
  }
}

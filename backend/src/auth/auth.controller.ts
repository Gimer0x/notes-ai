import { Body, Controller, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService, type OAuthCallbackBody } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('electron/callback')
  electronCallback(
    @Body() body: OAuthCallbackBody,
  ): Promise<{ accessToken: string }> {
    return this.auth.loginElectron(body);
  }

  @Post('web/callback')
  async webCallback(
    @Body() body: OAuthCallbackBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ ok: true }> {
    await this.auth.loginWeb(body, response);
    return { ok: true };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) response: Response): { ok: true } {
    this.auth.logoutWeb(response);
    return { ok: true };
  }
}

import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import { UsersService } from '../users/users.service';
import { exchangeGoogleCode } from './google-oauth';
import { COOKIE_MAX_AGE_MS, signUserToken } from './jwt';

export type OAuthCallbackBody = {
  code?: string;
  codeVerifier?: string;
  redirectUri?: string;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly users: UsersService,
  ) {}

  async loginElectron(body: OAuthCallbackBody): Promise<{ accessToken: string }> {
    const { code, codeVerifier, redirectUri } = requireCallback(body);
    if (!isLoopbackRedirect(redirectUri)) {
      throw new BadRequestException('redirectUri must be http://127.0.0.1:<port>/callback');
    }
    const clientId = requiredEnv(this.config, 'GOOGLE_DESKTOP_CLIENT_ID');
    const clientSecret = requiredEnv(this.config, 'GOOGLE_DESKTOP_CLIENT_SECRET');
    const profile = await exchangeOr401({
      clientId,
      clientSecret,
      code,
      codeVerifier,
      redirectUri,
    });
    const user = await this.users.upsertFromGoogle(profile);
    return { accessToken: signUserToken(user.id, this.jwtSecret()) };
  }

  async loginWeb(body: OAuthCallbackBody, response: Response): Promise<void> {
    const { code, codeVerifier, redirectUri } = requireCallback(body);
    if (!this.isWebsiteRedirect(redirectUri)) {
      throw new BadRequestException('redirectUri must match WEBSITE_URL/auth/callback');
    }
    const clientId = requiredEnv(this.config, 'GOOGLE_WEB_CLIENT_ID');
    const clientSecret = requiredEnv(this.config, 'GOOGLE_WEB_CLIENT_SECRET');
    const profile = await exchangeOr401({
      clientId,
      clientSecret,
      code,
      codeVerifier,
      redirectUri,
    });
    const user = await this.users.upsertFromGoogle(profile);
    const token = signUserToken(user.id, this.jwtSecret());
    response.cookie(this.cookieName(), token, this.cookieOptions());
  }

  logoutWeb(response: Response): void {
    response.clearCookie(this.cookieName(), {
      ...this.cookieOptions(),
      maxAge: 0,
    });
  }

  cookieName(): string {
    return this.config.get<string>('AUTH_COOKIE_NAME')?.trim() || 'pith_session';
  }

  jwtSecret(): string {
    return requiredEnv(this.config, 'JWT_SECRET');
  }

  websiteOrigin(): string {
    return (
      this.config.get<string>('WEBSITE_URL')?.trim().replace(/\/$/, '') ||
      'http://localhost:5173'
    );
  }

  private isWebsiteRedirect(redirectUri: string): boolean {
    return redirectUri === `${this.websiteOrigin()}/auth/callback`;
  }

  private cookieOptions(): CookieOptions {
    const secure =
      (this.config.get<string>('AUTH_COOKIE_SECURE') ?? '').toLowerCase() ===
      'true';
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: COOKIE_MAX_AGE_MS,
    };
  }
}

function requireCallback(body: OAuthCallbackBody): {
  code: string;
  codeVerifier: string;
  redirectUri: string;
} {
  const code = body.code?.trim() ?? '';
  const codeVerifier = body.codeVerifier?.trim() ?? '';
  const redirectUri = body.redirectUri?.trim() ?? '';
  if (!code || !codeVerifier || !redirectUri) {
    throw new BadRequestException('code, codeVerifier, and redirectUri are required');
  }
  return { code, codeVerifier, redirectUri };
}

function isLoopbackRedirect(redirectUri: string): boolean {
  return /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri);
}

function requiredEnv(config: ConfigService, key: string): string {
  const value = config.get<string>(key)?.trim() ?? '';
  if (!value) {
    throw new BadRequestException(`${key} is not set`);
  }
  return value;
}

async function exchangeOr401(
  input: Parameters<typeof exchangeGoogleCode>[0],
): Promise<Awaited<ReturnType<typeof exchangeGoogleCode>>> {
  try {
    return await exchangeGoogleCode(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'google_oauth_failed';
    throw new UnauthorizedException(message);
  }
}

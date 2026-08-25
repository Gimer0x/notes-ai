import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { verifyUserToken } from './jwt';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerToken(request) ?? this.cookieToken(request);
    if (!token) {
      throw new UnauthorizedException('not signed in');
    }
    const userId = verifyUserToken(token, this.auth.jwtSecret());
    if (!userId) {
      throw new UnauthorizedException('not signed in');
    }
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException('not signed in');
    }
    (request as Request & { userId: string }).userId = user.id;
    return true;
  }

  private cookieToken(request: Request): string | null {
    const name = this.auth.cookieName();
    const value = request.cookies?.[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

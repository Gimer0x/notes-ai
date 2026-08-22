import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

@Injectable()
export class SpikeKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('CAPTURE_SPIKE_KEY')?.trim() ?? '';
    if (!expected) {
      throw new UnauthorizedException('CAPTURE_SPIKE_KEY is not configured');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = String(request.header('x-spike-key') ?? '');
    if (!this.secureEquals(provided, expected)) {
      throw new UnauthorizedException();
    }
    return true;
  }

  private secureEquals(provided: string, expected: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }
}

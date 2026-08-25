import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<Request & { userId?: string }>();
    const userId = request.userId;
    if (!userId) {
      throw new Error('CurrentUserId used without AuthGuard');
    }
    return userId;
  },
);

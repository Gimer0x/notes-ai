import { randomUUID } from 'crypto';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { publicErrorBody } from './safe-error';

@Catch()
export class PublicExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PublicExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const requestId = randomUUID();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : undefined;
    const body = publicErrorBody(raw, status, requestId);
    if (status >= 500) {
      const cause = exception instanceof Error ? exception.message : 'internal_error';
      this.logger.error(
        `requestId=${requestId} status=${status} code=${body.error.code} path=${request.path} cause=${cause}`,
      );
    }
    const logs =
      raw && typeof raw === 'object' && 'logs' in raw ? (raw as { logs?: unknown }).logs : undefined;
    response.status(status).json(logs === undefined ? body : { ...body, logs });
  }
}

import { HttpException } from '@nestjs/common';

const PERMANENT_STATUS = new Set([400, 401, 403, 404, 413, 422]);
const PERMANENT_MESSAGE = new Set([
  'missing_wav',
  'invalid_audio',
  'transcription_unconfigured',
  'summary_unconfigured',
  'ask_unconfigured',
]);

/** Network and provider outages can be tried again. Bad audio and missing config cannot. */
export function sliceErrorRetries(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  if (PERMANENT_MESSAGE.has(message)) {
    return false;
  }
  if (error instanceof HttpException && PERMANENT_STATUS.has(error.getStatus())) {
    return false;
  }
  return true;
}

export function sliceFailureIsFinal(error: unknown, attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts || !sliceErrorRetries(error);
}

export function sliceRetryDelaySeconds(attempts: number): number {
  return attempts <= 1 ? 5 : 20;
}

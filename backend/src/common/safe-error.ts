import { BadRequestException } from '@nestjs/common';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, code = 'invalid_id'): void {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new BadRequestException(code);
  }
}

/** Keep stored and client-facing failures as stable codes, not provider text. */
export function safeErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message.trim() : '';
  if (/^[a-z0-9_]+$/i.test(raw) && raw.length <= 80) {
    return raw;
  }
  return fallback;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export type PublicErrorBody = {
  code: string;
  message: string;
  retryable: boolean;
  requestId: string;
  retryAfterSeconds?: number;
  missing?: number[];
};

export function publicErrorCode(body: unknown, status: number): { code: string; missing?: number[] } {
  if (typeof body === 'string' && /^[a-z0-9_]+$/i.test(body)) {
    return { code: body };
  }
  if (body && typeof body === 'object') {
    const record = body as { code?: unknown; message?: unknown; missing?: unknown };
    const missing = Array.isArray(record.missing)
      ? record.missing.filter((item) => Number.isInteger(item))
      : undefined;
    if (typeof record.code === 'string' && /^[a-z0-9_]+$/i.test(record.code)) {
      return { code: record.code, missing };
    }
    if (typeof record.message === 'string' && /^[a-z0-9_]+$/i.test(record.message)) {
      return { code: record.message, missing };
    }
    if (record.message && typeof record.message === 'object') {
      return publicErrorCode(record.message, status);
    }
  }
  if (status === 400 || status === 413 || status === 422) {
    return { code: 'invalid_input' };
  }
  if (status === 401) {
    return { code: 'session_expired' };
  }
  if (status === 403) {
    return { code: 'forbidden' };
  }
  if (status === 404) {
    return { code: 'not_found' };
  }
  if (status === 409) {
    return { code: 'conflict' };
  }
  if (status === 429) {
    return { code: 'rate_limited' };
  }
  if (status === 502 || status === 503 || status === 504) {
    return { code: 'unavailable' };
  }
  return { code: 'internal_error' };
}

export function publicErrorBody(
  body: unknown,
  status: number,
  requestId: string,
): { message: string; missing?: number[]; error: PublicErrorBody } {
  const parsed = publicErrorCode(body, status);
  const error: PublicErrorBody = {
    code: parsed.code,
    message: parsed.code,
    retryable: RETRYABLE_STATUS.has(status),
    requestId,
  };
  return {
    message: parsed.code,
    ...(parsed.missing && parsed.missing.length > 0 ? { missing: parsed.missing } : {}),
    error,
  };
}

export function cancellationFailureCode(error: unknown): 'gone' | 'failed' {
  if (typeof error === 'object' && error && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    if (code === 'resource_missing') {
      return 'gone';
    }
  }
  return 'failed';
}

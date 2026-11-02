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

export function cancellationFailureCode(error: unknown): 'gone' | 'failed' {
  if (typeof error === 'object' && error && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    if (code === 'resource_missing') {
      return 'gone';
    }
  }
  return 'failed';
}

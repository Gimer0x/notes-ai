import { BadRequestException } from '@nestjs/common';
import { assertUuid, cancellationFailureCode, publicErrorCode, safeErrorMessage } from './safe-error';

describe('safe errors', () => {
  it('keeps a short code and hides provider prose', () => {
    expect(safeErrorMessage(new Error('empty_summary'), 'summary_failed')).toBe('empty_summary');
    expect(safeErrorMessage(new Error('Invalid API key sk-test'), 'summary_failed')).toBe(
      'summary_failed',
    );
  });

  it('treats a missing Stripe subscription as already gone', () => {
    expect(cancellationFailureCode({ code: 'resource_missing' })).toBe('gone');
    expect(cancellationFailureCode(new Error('network down'))).toBe('failed');
  });

  it('turns an http body into a stable code', () => {
    expect(publicErrorCode({ code: 'slices_missing', missing: [2] }, 409)).toEqual({
      code: 'slices_missing',
      missing: [2],
    });
    expect(publicErrorCode('provider exploded', 503).code).toBe('unavailable');
    expect(publicErrorCode('nope happened', 500).code).toBe('internal_error');
  });

  it('rejects a non-uuid before it reaches the database', () => {
    expect(() => assertUuid('not-a-uuid')).toThrow(BadRequestException);
    expect(() => assertUuid('11111111-1111-4111-8111-111111111111')).not.toThrow();
  });
});

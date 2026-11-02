import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { sliceErrorRetries, sliceFailureIsFinal, sliceRetryDelaySeconds } from './slice-retry';

describe('slice retries', () => {
  it('retries a provider outage and stops on invalid audio', () => {
    expect(sliceErrorRetries(new ServiceUnavailableException('transcription_unavailable'))).toBe(true);
    expect(sliceErrorRetries(new BadRequestException('invalid_audio'))).toBe(false);
    expect(sliceErrorRetries(new ServiceUnavailableException('transcription_unconfigured'))).toBe(false);
    expect(sliceErrorRetries(new Error('missing_wav'))).toBe(false);
    expect(sliceFailureIsFinal(new Error('socket hang up'), 1, 3)).toBe(false);
    expect(sliceFailureIsFinal(new Error('socket hang up'), 3, 3)).toBe(true);
    expect(sliceRetryDelaySeconds(1)).toBe(5);
    expect(sliceRetryDelaySeconds(2)).toBe(20);
  });
});

import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SpikeKeyGuard } from './spike-key.guard';

function requestWithKey(value: string | undefined) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        header: (name: string) =>
          name.toLowerCase() === 'x-spike-key' ? value : undefined,
      }),
    }),
  };
}

describe('SpikeKeyGuard', () => {
  const config = {
    get: (key: string) => (key === 'CAPTURE_SPIKE_KEY' ? 'expected-key' : ''),
  } as ConfigService;
  const guard = new SpikeKeyGuard(config);

  it('allows a matching X-Spike-Key', () => {
    expect(guard.canActivate(requestWithKey('expected-key') as never)).toBe(
      true,
    );
  });

  it('rejects a missing or wrong key', () => {
    expect(() => guard.canActivate(requestWithKey(undefined) as never)).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(requestWithKey('nope') as never)).toThrow(
      UnauthorizedException,
    );
  });
});

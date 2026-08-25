import { ConfigService } from '@nestjs/config';
import { readPublicAppConfig, spikeEnabled } from './app-config';

describe('readPublicAppConfig', () => {
  it('reads timings from env and does not hard-code product caps', () => {
    const config = {
      get: (key: string) =>
        ({
          MIN_LISTEN_SECONDS: '45',
          PAUSE_AUTO_CANCEL_SECONDS: '99',
          PAUSE_WARNING_SECONDS: '12',
          UPLOAD_RETRY_SECONDS: '33',
          WAV_CHUNK_SECONDS: '77',
        })[key],
    } as ConfigService;
    expect(readPublicAppConfig(config)).toEqual({
      minListenSeconds: 45,
      pauseAutoCancelSeconds: 99,
      pauseWarningSeconds: 12,
      uploadRetrySeconds: 33,
      wavChunkSeconds: 77,
    });
  });
});

describe('spikeEnabled', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalKey = process.env.CAPTURE_SPIKE_KEY;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    process.env.CAPTURE_SPIKE_KEY = originalKey;
  });

  it('is false in test even if a spike key is set', () => {
    process.env.NODE_ENV = 'test';
    process.env.CAPTURE_SPIKE_KEY = 'secret';
    expect(spikeEnabled()).toBe(false);
  });

  it('is true only in development with a key', () => {
    process.env.NODE_ENV = 'development';
    process.env.CAPTURE_SPIKE_KEY = 'secret';
    expect(spikeEnabled()).toBe(true);
  });
});

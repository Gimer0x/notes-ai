import { ConfigService } from '@nestjs/config';

export type PublicAppConfig = {
  minListenSeconds: number;
  pauseAutoCancelSeconds: number;
  pauseWarningSeconds: number;
  uploadRetrySeconds: number;
  wavChunkSeconds: number;
};

function envInt(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string>(key)?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readPublicAppConfig(config: ConfigService): PublicAppConfig {
  return {
    minListenSeconds: envInt(config, 'MIN_LISTEN_SECONDS', 30),
    pauseAutoCancelSeconds: envInt(config, 'PAUSE_AUTO_CANCEL_SECONDS', 1200),
    pauseWarningSeconds: envInt(config, 'PAUSE_WARNING_SECONDS', 60),
    uploadRetrySeconds: envInt(config, 'UPLOAD_RETRY_SECONDS', 600),
    wavChunkSeconds: envInt(config, 'WAV_CHUNK_SECONDS', 600),
  };
}

export function spikeEnabled(): boolean {
  const env = (process.env.NODE_ENV ?? '').toLowerCase();
  const key = (process.env.CAPTURE_SPIKE_KEY ?? '').trim();
  return env === 'development' && key.length > 0;
}

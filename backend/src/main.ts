import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { PublicExceptionFilter } from './common/http-exception.filter';

function corsOrigins(): (string | RegExp)[] {
  const website = (process.env.WEBSITE_URL ?? 'http://localhost:5173')
    .trim()
    .replace(/\/$/, '');
  return [website, /^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/];
}

function logProcessFailure(kind: string, error: unknown): void {
  const message = error instanceof Error ? error.message : kind;
  console.error(JSON.stringify({ event: kind, message }));
}

process.on('uncaughtException', (error) => {
  logProcessFailure('uncaught', error);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  logProcessFailure('unhandled_rejection', error);
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    rawBody: true,
    // logger: ['error', 'warn', 'log'], // startup route list
    logger: ['error', 'warn'],
  });
  app.useBodyParser('json', { limit: '8mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '1mb' });
  app.use(cookieParser());
  app.useGlobalFilters(new PublicExceptionFilter());
  app.enableCors({
    origin: corsOrigins(),
    credentials: true,
  });
  const port = process.env.PORT ?? '3000';
  await app.listen(port);
}

void bootstrap();

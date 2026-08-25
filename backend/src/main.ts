import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

function corsOrigins(): (string | RegExp)[] {
  const website = (process.env.WEBSITE_URL ?? 'http://localhost:5173')
    .trim()
    .replace(/\/$/, '');
  return [website, /^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/];
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.use(cookieParser());
  app.enableCors({
    origin: corsOrigins(),
    credentials: true,
  });
  const port = process.env.PORT ?? '3000';
  await app.listen(port);
}

void bootstrap();

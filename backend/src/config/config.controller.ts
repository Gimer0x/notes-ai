import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readPublicAppConfig, type PublicAppConfig } from './app-config';

@Controller('config')
export class ConfigController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  get(): PublicAppConfig {
    return readPublicAppConfig(this.config);
  }
}

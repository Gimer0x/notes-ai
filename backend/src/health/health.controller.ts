import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DbService } from '../db/db.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get()
  check(): { ok: true } {
    return { ok: true };
  }

  @Get('ready')
  async ready(): Promise<{ ok: true }> {
    try {
      await this.db.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException('database_unavailable');
    }
    return { ok: true };
  }
}

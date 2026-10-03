import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { SCHEMA_STATEMENTS, SEED_PLANS_SQL } from './schema';

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private pool: Pool | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.get<string>('DATABASE_URL')?.trim();
    if (!url) {
      throw new Error(
        'DATABASE_URL is not set. Copy backend/.env.example and start Postgres (see README).',
      );
    }
    this.pool = new Pool({ connectionString: url });
    await this.query('SELECT 1');
    for (const statement of SCHEMA_STATEMENTS) {
      await this.query(statement);
    }
    await this.query(SEED_PLANS_SQL);
    const plans = await this.query<{ code: string }>(
      'SELECT code FROM plans ORDER BY code',
    );
    this.logger.log(
      `postgres ready; plans=${plans.rows.map((row) => row.code).join(',')}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('database is not connected');
    }
    return this.pool.query<T>(text, params);
  }

  async transaction<T>(
    run: (query: DbService['query']) => Promise<T>,
  ): Promise<T> {
    if (!this.pool) {
      throw new Error('database is not connected');
    }
    const client = await this.pool.connect();
    const query = clientQuery(client);
    try {
      await client.query('BEGIN');
      const result = await run(query);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function clientQuery(
  client: PoolClient,
): DbService['query'] {
  return (text, params) => client.query(text, params);
}

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import type { PersistentWorld } from '../../../shared/src/types.js';
import type { GameStore } from './Store.js';

export class PostgresStore implements GameStore {
  readonly mode = 'postgres' as const;
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    let useTls = false;
    try {
      useTls = new URL(databaseUrl).hostname.endsWith('.neon.tech');
    } catch {
      // The Pool will provide the useful connection-string error during initialize.
    }
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      ...(useTls ? { ssl: { rejectUnauthorized: true } } : {}),
    });
    this.pool.on('error', (error) => console.error('[postgres] Idle connection error:', error.message));
  }

  async initialize(): Promise<void> {
    const migration = await readFile(resolve(process.cwd(), 'server/migrations/001_initial.sql'), 'utf8');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration);
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        [1],
      );
      await client.query('COMMIT');
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async load(): Promise<PersistentWorld | null> {
    const result = await this.pool.query<{ data: PersistentWorld }>(
      'SELECT data FROM world_state WHERE singleton = true LIMIT 1',
    );
    return result.rows[0]?.data ?? null;
  }

  async save(world: PersistentWorld): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO world_state (singleton, data, updated_at, snapshot_at)
         VALUES (true, $1::jsonb, now(), to_timestamp($2 / 1000.0))
         ON CONFLICT (singleton) DO UPDATE
         SET data = EXCLUDED.data, updated_at = now(), snapshot_at = EXCLUDED.snapshot_at`,
        [JSON.stringify(world), world.lastSimulatedAt],
      );
      for (const player of Object.values(world.players)) {
        await client.query(
          `INSERT INTO players (id, nickname, inventory, last_seen_at)
           VALUES ($1::uuid, $2, $3::jsonb, to_timestamp($4 / 1000.0))
           ON CONFLICT (id) DO UPDATE
           SET nickname = EXCLUDED.nickname, inventory = EXCLUDED.inventory, last_seen_at = EXCLUDED.last_seen_at`,
          [player.id, player.nickname, JSON.stringify(player.inventory), player.lastSeenAt],
        );
      }
      for (const event of world.events.slice(-250)) {
        await client.query(
          `INSERT INTO colony_events (id, kind, message, occurred_at)
           VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
           ON CONFLICT (id) DO NOTHING`,
          [event.id, event.kind, event.message, event.at],
        );
      }
      await client.query('DELETE FROM colony_events WHERE occurred_at < now() - interval \'60 days\'');
      await client.query('COMMIT');
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Keep the original transaction error.
  }
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { PersistentWorld } from '../../../shared/src/types.js';
import type { GameStore } from './Store.js';

export class JsonStore implements GameStore {
  readonly mode = 'local-file' as const;
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
  }

  async load(): Promise<PersistentWorld | null> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const value = JSON.parse(raw) as PersistentWorld;
      if (value.version !== 1 || !value.colony || !Array.isArray(value.agents)) return null;
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      console.error('[store] Could not read local world save:', error);
      return null;
    }
  }

  async save(world: PersistentWorld): Promise<void> {
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(world), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.path);
  }

  async close(): Promise<void> {}
}

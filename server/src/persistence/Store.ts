import type { PersistentWorld } from '../../../shared/src/types.js';

export interface GameStore {
  readonly mode: 'postgres' | 'local-file';
  initialize(): Promise<void>;
  load(): Promise<PersistentWorld | null>;
  save(world: PersistentWorld): Promise<void>;
  close(): Promise<void>;
}

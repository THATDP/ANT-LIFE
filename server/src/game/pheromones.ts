import type { PersistentWorld, PheromoneCell, PheromoneType } from '../../../shared/src/types.js';

const CELL_SIZE = 4;
const MAX_CELLS = 560;

function cellKey(x: number, z: number, type: PheromoneType): string {
  return `${Math.round(x / CELL_SIZE)},${Math.round(z / CELL_SIZE)},${type}`;
}

export function depositPheromone(world: PersistentWorld, x: number, z: number, type: PheromoneType, strength = 0.18): void {
  const cx = Math.round(x / CELL_SIZE) * CELL_SIZE;
  const cz = Math.round(z / CELL_SIZE) * CELL_SIZE;
  const key = cellKey(cx, cz, type);
  const existing = world.pheromones.find((cell) => cellKey(cell.x, cell.z, cell.type) === key);
  if (existing) existing.strength = Math.min(1, existing.strength + strength);
  else world.pheromones.push({ x: cx, z: cz, type, strength: Math.min(1, strength) });
  if (world.pheromones.length > MAX_CELLS) {
    world.pheromones.sort((a, b) => b.strength - a.strength);
    world.pheromones.length = MAX_CELLS;
  }
}

export function strongestPheromone(world: PersistentWorld, x: number, z: number, type: PheromoneType, radius = 12): PheromoneCell | null {
  let best: PheromoneCell | null = null;
  let bestScore = 0;
  for (const cell of world.pheromones) {
    if (cell.type !== type) continue;
    const distance = Math.hypot(cell.x - x, cell.z - z);
    if (distance > radius) continue;
    const score = cell.strength / (1 + distance * 0.08);
    if (score > bestScore) {
      best = cell;
      bestScore = score;
    }
  }
  return best;
}

export function decayPheromones(world: PersistentWorld, dt: number): void {
  if (dt <= 0 || world.pheromones.length === 0) return;
  for (const cell of world.pheromones) {
    const halfLife = cell.type === 'danger' ? 26 : cell.type === 'food' ? 105 : 70;
    cell.strength *= Math.exp((-Math.LN2 * dt) / halfLife);
  }
  world.pheromones = world.pheromones.filter((cell) => cell.strength >= 0.025);
}

export function pheromoneAttraction(world: PersistentWorld, x: number, z: number, type: PheromoneType): { x: number; z: number } | null {
  const cell = strongestPheromone(world, x, z, type, 16);
  if (!cell) return null;
  const dx = cell.x - x;
  const dz = cell.z - z;
  const length = Math.hypot(dx, dz) || 1;
  return { x: dx / length, z: dz / length };
}

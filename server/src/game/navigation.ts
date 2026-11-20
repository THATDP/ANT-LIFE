import type { Vec3 } from '../../../shared/src/types.js';
import { createWorldProps, isInPond } from '../../../shared/src/world.js';

interface GridNode {
  x: number;
  z: number;
  g: number;
  f: number;
  parent: GridNode | null;
}

class MinHeap {
  private items: GridNode[] = [];
  get size(): number { return this.items.length; }

  push(node: GridNode): void {
    this.items.push(node);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].f <= node.f) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = node;
  }

  pop(): GridNode | undefined {
    if (this.items.length === 0) return undefined;
    const first = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= this.items.length) break;
        const child = right < this.items.length && this.items[right].f < this.items[left].f ? right : left;
        if (this.items[child].f >= last.f) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = last;
    }
    return first;
  }
}

/** A small, deterministic grid for colony navigation and server-side obstacle checks. */
export class NavigationGrid {
  readonly cellSize = 4;
  private readonly minCell = -19;
  private readonly maxCell = 19;
  private readonly blocked = new Set<string>();
  private readonly obstacles = createWorldProps(0).filter((prop) => prop.kind === 'rock' || prop.kind === 'tree' || prop.kind === 'stump' || prop.kind === 'log');

  constructor(seed: number) {
    const props = createWorldProps(seed);
    this.obstacles = props.filter((prop) => prop.kind === 'rock' || prop.kind === 'tree' || prop.kind === 'stump' || prop.kind === 'log');
    for (const prop of this.obstacles) {
      const minX = Math.floor((prop.x - prop.radius - 0.7) / this.cellSize);
      const maxX = Math.ceil((prop.x + prop.radius + 0.7) / this.cellSize);
      const minZ = Math.floor((prop.z - prop.radius - 0.7) / this.cellSize);
      const maxZ = Math.ceil((prop.z + prop.radius + 0.7) / this.cellSize);
      for (let x = minX; x <= maxX; x += 1) {
        for (let z = minZ; z <= maxZ; z += 1) {
          if (Math.hypot(x * this.cellSize - prop.x, z * this.cellSize - prop.z) <= prop.radius + 1) this.blocked.add(this.key(x, z));
        }
      }
    }
    for (let x = this.minCell; x <= this.maxCell; x += 1) {
      for (let z = this.minCell; z <= this.maxCell; z += 1) {
        if (isInPond(x * this.cellSize, z * this.cellSize)) this.blocked.add(this.key(x, z));
      }
    }
    // Keep the entrance and first corridor clear even if a procedural prop overlaps it.
    for (let x = -2; x <= 2; x += 1) for (let z = -2; z <= 2; z += 1) this.blocked.delete(this.key(x, z));
  }

  isBlockedPosition(x: number, z: number, padding = 0.35): boolean {
    if (Math.abs(x) > 74 || Math.abs(z) > 74) return true;
    if (isInPond(x, z)) return true;
    for (const obstacle of this.obstacles) {
      const radius = obstacle.radius + padding;
      if (Math.abs(obstacle.x - x) > radius || Math.abs(obstacle.z - z) > radius) continue;
      if (Math.hypot(obstacle.x - x, obstacle.z - z) < radius) return true;
    }
    return false;
  }

  findPath(start: Pick<Vec3, 'x' | 'z'>, goal: Pick<Vec3, 'x' | 'z'>): Array<{ x: number; z: number }> {
    const startCell = this.toCell(start.x, start.z);
    let goalCell = this.toCell(goal.x, goal.z);
    goalCell = this.nearestOpen(goalCell.x, goalCell.z) ?? goalCell;
    const safeStart = this.nearestOpen(startCell.x, startCell.z) ?? startCell;
    const startKey = this.key(safeStart.x, safeStart.z);
    const goalKey = this.key(goalCell.x, goalCell.z);
    if (startKey === goalKey) return [{ x: goal.x, z: goal.z }];

    const open = new MinHeap();
    const bestG = new Map<string, number>([[startKey, 0]]);
    const closed = new Set<string>();
    open.push({ ...safeStart, g: 0, f: this.heuristic(safeStart, goalCell), parent: null });
    const directions = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]] as const;
    let end: GridNode | null = null;
    let visited = 0;

    while (open.size > 0 && visited < 3200) {
      const current = open.pop()!;
      const currentKey = this.key(current.x, current.z);
      if (closed.has(currentKey)) continue;
      closed.add(currentKey);
      visited += 1;
      if (currentKey === goalKey) {
        end = current;
        break;
      }
      for (const [dx, dz, cost] of directions) {
        const x = current.x + dx;
        const z = current.z + dz;
        const key = this.key(x, z);
        if (x < this.minCell || x > this.maxCell || z < this.minCell || z > this.maxCell || this.blocked.has(key) || closed.has(key)) continue;
        if (dx !== 0 && dz !== 0 && (this.blocked.has(this.key(current.x + dx, current.z)) || this.blocked.has(this.key(current.x, current.z + dz)))) continue;
        const nextG = current.g + cost;
        if (nextG >= (bestG.get(key) ?? Infinity)) continue;
        bestG.set(key, nextG);
        open.push({ x, z, g: nextG, f: nextG + this.heuristic({ x, z }, goalCell), parent: current });
      }
    }
    if (!end) return [{ x: goal.x, z: goal.z }];

    const reversed: Array<{ x: number; z: number }> = [];
    let cursor: GridNode | null = end;
    while (cursor && cursor.parent) {
      reversed.push({ x: cursor.x * this.cellSize, z: cursor.z * this.cellSize });
      cursor = cursor.parent;
    }
    reversed.reverse();
    const smoothed = this.smoothPath(reversed);
    if (smoothed.length > 0) smoothed[smoothed.length - 1] = { x: goal.x, z: goal.z };
    return smoothed;
  }

  private smoothPath(path: Array<{ x: number; z: number }>): Array<{ x: number; z: number }> {
    if (path.length < 3) return path;
    const result = [path[0]];
    for (let i = 1; i < path.length - 1; i += 1) {
      const a = result[result.length - 1];
      const b = path[i];
      const c = path[i + 1];
      const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
      if (Math.abs(cross) > 0.01) result.push(b);
    }
    result.push(path[path.length - 1]);
    return result;
  }

  private toCell(x: number, z: number): { x: number; z: number } {
    return {
      x: Math.max(this.minCell, Math.min(this.maxCell, Math.round(x / this.cellSize))),
      z: Math.max(this.minCell, Math.min(this.maxCell, Math.round(z / this.cellSize))),
    };
  }

  private nearestOpen(x: number, z: number): { x: number; z: number } | null {
    if (!this.blocked.has(this.key(x, z))) return { x, z };
    for (let radius = 1; radius <= 5; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          const nx = x + dx;
          const nz = z + dz;
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius || nx < this.minCell || nx > this.maxCell || nz < this.minCell || nz > this.maxCell) continue;
          if (!this.blocked.has(this.key(nx, nz))) return { x: nx, z: nz };
        }
      }
    }
    return null;
  }

  private heuristic(a: { x: number; z: number }, b: { x: number; z: number }): number {
    const dx = Math.abs(a.x - b.x);
    const dz = Math.abs(a.z - b.z);
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  }

  private key(x: number, z: number): string { return `${x},${z}`; }
}

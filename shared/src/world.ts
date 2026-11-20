import type { ResourceKind, ResourceNode, StaticProp, Vec3 } from './types.js';

export const WORLD_RADIUS = 76;
export const RESOURCE_KINDS: ResourceKind[] = ['seed', 'berry', 'sugar', 'dew', 'soil', 'leaf', 'mushroom'];

export function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function terrainHeight(x: number, z: number): number {
  const broad = Math.sin(x * 0.075 + 0.6) * Math.cos(z * 0.065) * 0.34;
  const ripple = Math.sin((x + z) * 0.16) * 0.1 + Math.cos((x - z) * 0.11) * 0.09;
  const hillA = Math.exp(-((x - 29) ** 2 + (z + 10) ** 2) / 520) * 1.2;
  const hillB = Math.exp(-((x + 34) ** 2 + (z - 32) ** 2) / 780) * 0.8;
  const nestBowl = Math.exp(-(x * x + z * z) / 42) * -0.18;
  return broad + ripple + hillA + hillB + nestBowl;
}

export function groundHeight(x: number, z: number, underground: boolean): number {
  return underground ? -7.5 : terrainHeight(x, z);
}

export function isInPond(x: number, z: number): boolean {
  return Math.hypot(x - 22, z + 22) < 7.1;
}

export function createWorldProps(seed: number): StaticProp[] {
  const random = mulberry32(seed ^ 0x5f3759df);
  const props: StaticProp[] = [];
  const kinds: StaticProp['kind'][] = ['rock', 'log', 'stump', 'flower', 'mushroom', 'fern', 'tree', 'leaf'];
  const weights = [0.18, 0.075, 0.05, 0.17, 0.12, 0.16, 0.055, 0.19];
  const count = 460;
  let id = 0;

  for (let i = 0; i < count; i += 1) {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * WORLD_RADIUS;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    if (Math.hypot(x, z) < 6.8 || isInPond(x, z)) continue;

    const choice = random();
    let cursor = 0;
    let kind = kinds[0];
    for (let j = 0; j < kinds.length; j += 1) {
      cursor += weights[j];
      if (choice <= cursor) {
        kind = kinds[j];
        break;
      }
    }
    const large = kind === 'tree' || kind === 'log';
    props.push({
      id: `prop-${id++}`,
      kind,
      x,
      z,
      radius: kind === 'tree' ? 1.15 + random() * 1.2 : kind === 'rock' ? 0.45 + random() * 1.15 : large ? 0.5 + random() * 1.1 : 0.15 + random() * 0.45,
      height: kind === 'tree' ? 7 + random() * 6 : kind === 'fern' ? 0.9 + random() * 1.6 : kind === 'flower' ? 0.55 + random() * 1.2 : kind === 'mushroom' ? 0.3 + random() * 0.9 : 0.35 + random() * 2,
      variant: Math.floor(random() * 4),
    });
  }

  // Landmarks are fixed so players can orient themselves across sessions.
  props.push(
    { id: 'landmark-old-oak', kind: 'tree', x: -31, z: -35, radius: 2.5, height: 14, variant: 2 },
    { id: 'landmark-split-log', kind: 'log', x: 37, z: 18, radius: 2.1, height: 1.1, variant: 1 },
    { id: 'landmark-moss-stone', kind: 'rock', x: -35, z: 21, radius: 2.6, height: 2.4, variant: 0 },
  );
  return props;
}

const resourceCycle: ResourceKind[] = ['seed', 'berry', 'seed', 'dew', 'sugar', 'soil', 'leaf', 'mushroom', 'berry'];

export function createResourceNodes(seed: number): ResourceNode[] {
  const random = mulberry32(seed ^ 0x41c64e6d);
  const nodes: ResourceNode[] = [];
  const count = 52;
  let id = 0;

  for (let i = 0; i < count; i += 1) {
    const angle = random() * Math.PI * 2;
    const radius = 11 + Math.sqrt(random()) * 47;
    let x = Math.cos(angle) * radius;
    let z = Math.sin(angle) * radius;
    if (isInPond(x, z)) {
      x -= 10;
      z += 8;
    }
    let kind = resourceCycle[Math.floor(random() * resourceCycle.length)];
    if (i % 11 === 0) kind = 'dew';
    if (i % 13 === 0) kind = 'sugar';
    const amount = 8 + Math.floor(random() * 13);
    const pos: Vec3 = { x, y: terrainHeight(x, z), z };
    nodes.push({ id: `resource-${id++}`, kind, pos, amount, maxAmount: amount, respawnAt: 0 });
  }

  // A small starter cache sits just outside the nest, but still requires a trip.
  nodes.push({ id: 'resource-starter-seed', kind: 'seed', pos: { x: 8.5, y: terrainHeight(8.5, 0), z: 0 }, amount: 10, maxAmount: 10, respawnAt: 0 });
  return nodes;
}

export function flatDistance(a: Pick<Vec3, 'x' | 'z'>, b: Pick<Vec3, 'x' | 'z'>): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

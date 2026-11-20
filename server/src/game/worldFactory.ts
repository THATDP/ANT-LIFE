import { randomInt } from 'node:crypto';
import type { AgentRole, AgentState, ColonyEvent, Inventory, PersistentWorld, PlayerState, ResourceKind, Vec3 } from '../../../shared/src/types.js';
import { createResourceNodes, terrainHeight } from '../../../shared/src/world.js';

export const EMPTY_INVENTORY = (): Inventory => ({ seed: 0, berry: 0, sugar: 0, dew: 0, soil: 0, leaf: 0, mushroom: 0 });

const initialRoles: AgentRole[] = [
  'worker', 'worker', 'worker', 'worker', 'worker', 'worker', 'worker', 'worker', 'worker',
  'soldier', 'soldier', 'soldier', 'soldier',
  'scout', 'scout', 'scout', 'scout',
  'digger', 'digger', 'digger',
  'nurse', 'nurse', 'nurse', 'nurse',
];

export function createDefaultWorld(now = Date.now(), seed = randomInt(1, 2 ** 30)): PersistentWorld {
  const world: PersistentWorld = {
    version: 1,
    seed,
    lastSimulatedAt: now,
    colony: {
      name: 'Myrmecia Grove',
      food: 46,
      water: 28,
      soil: 38,
      leaves: 16,
      population: initialRoles.length + 1,
      eggs: 5,
      larvae: 4,
      pupae: 2,
      queenHealth: 100,
      research: 0,
      storageCapacity: 140,
      upgrades: [],
      lastEvent: 'A colônia está em atividade.',
    },
    worldTime: { seconds: 115, dayLength: 720, weather: 'clear', weatherSecondsLeft: 210, flood: 0, seasonDay: 1 },
    players: {},
    agents: initialRoles.map((role, index) => createAgent(`ant-${index + 1}`, role, index)),
    resources: createResourceNodes(seed),
    structures: [{ id: 'nest-main-chamber', kind: 'chamber', pos: { x: 0, y: -7.5, z: 0 }, rotation: 0, createdAt: now, createdBy: 'colony', level: 1 }],
    predators: [
      { id: 'predator-spider-1', kind: 'spider', pos: { x: 34, y: terrainHeight(34, 10), z: 10 }, yaw: 0.2, health: 100, mode: 'patrol', targetId: null, phase: 1.4 },
      { id: 'predator-beetle-1', kind: 'beetle', pos: { x: -28, y: terrainHeight(-28, 27), z: 27 }, yaw: 1.8, health: 100, mode: 'patrol', targetId: null, phase: 3.2 },
      { id: 'predator-spider-2', kind: 'spider', pos: { x: -43, y: terrainHeight(-43, -18), z: -18 }, yaw: 2.8, health: 100, mode: 'patrol', targetId: null, phase: 4.1 },
    ],
    pheromones: [],
    tasks: [],
    discoveries: [
      { id: 'discovery-nest', label: 'Formigueiro', kind: 'nest', x: 0, z: 0, discoveredAt: now },
      { id: 'region-old-oak', label: 'Carvalho antigo', kind: 'region', x: -31, z: -35, discoveredAt: now },
    ],
    events: [makeEvent(now, 'colony', 'A rainha está protegida. A colônia começa com 24 formigas em atividade.')],
  };
  return world;
}

export function createAgent(id: string, role: AgentRole, index = 0, now = Date.now()): AgentState {
  const angle = index * 2.399963229728653;
  const radius = 0.45 + (index % 5) * 0.46;
  const underground = role === 'nurse' || role === 'digger' || index % 3 !== 0;
  const pos: Vec3 = underground
    ? { x: Math.cos(angle) * radius, y: -7.5, z: Math.sin(angle) * radius }
    : { x: Math.cos(angle) * (6 + radius), y: terrainHeight(Math.cos(angle) * (6 + radius), Math.sin(angle) * (6 + radius)), z: Math.sin(angle) * (6 + radius) };
  return {
    id,
    role,
    pos,
    yaw: angle,
    mode: 'idle',
    taskId: null,
    targetId: null,
    carrying: null,
    carryAmount: 0,
    health: 100,
    isUnderground: underground,
    phase: (index * 1.7 + now / 3000) % (Math.PI * 2),
  };
}

export function addAgent(world: PersistentWorld, role?: AgentRole): AgentState {
  const counts = world.agents.reduce<Record<AgentRole, number>>((acc, agent) => {
    acc[agent.role] += 1;
    return acc;
  }, { worker: 0, soldier: 0, scout: 0, digger: 0, nurse: 0 });
  const preferred: AgentRole = role ?? (counts.worker < counts.soldier * 2 ? 'worker'
    : counts.nurse < counts.worker * 0.45 ? 'nurse'
      : counts.scout < 6 ? 'scout'
        : counts.digger < 5 ? 'digger' : 'soldier');
  const index = world.agents.length;
  const agent = createAgent(`ant-${Date.now().toString(36)}-${index}`, preferred, index);
  world.agents.push(agent);
  return agent;
}

export function createPlayer(id: string, nickname: string, now = Date.now()): PlayerState {
  return {
    id,
    nickname,
    pos: { x: -1.6, y: terrainHeight(-1.6, 5.5), z: 5.5 },
    yaw: 0,
    health: 100,
    hunger: 88,
    thirst: 91,
    energy: 100,
    inventory: EMPTY_INVENTORY(),
    online: true,
    isUnderground: false,
    color: playerColor(id),
    lastSeenAt: now,
    deadUntil: 0,
  };
}

export function playerColor(id: string): string {
  const colors = ['#64d7b0', '#f0ad63', '#83b8ff', '#e78eba', '#f0da71', '#a893f2', '#f07d68'];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

export function makeEvent(at: number, kind: ColonyEvent['kind'], message: string): ColonyEvent {
  return { id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 9)}`, at, kind, message };
}

export function inventoryCount(inventory: Inventory): number {
  return Object.values(inventory).reduce((sum, quantity) => sum + quantity, 0);
}

export function isFood(kind: ResourceKind): boolean {
  return kind === 'seed' || kind === 'berry' || kind === 'sugar' || kind === 'mushroom';
}

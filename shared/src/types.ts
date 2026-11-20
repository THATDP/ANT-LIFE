export type ResourceKind = 'seed' | 'berry' | 'sugar' | 'dew' | 'soil' | 'leaf' | 'mushroom';
export type AgentRole = 'worker' | 'soldier' | 'scout' | 'digger' | 'nurse';
export type AgentMode = 'idle' | 'foraging' | 'returning' | 'patrolling' | 'exploring' | 'digging' | 'caring' | 'fleeing';
export type PheromoneType = 'food' | 'danger' | 'home' | 'explore' | 'defence';
export type WeatherKind = 'clear' | 'mist' | 'drizzle' | 'rain';
export type BuildKind = 'chamber' | 'store' | 'nursery' | 'tunnel' | 'barrier';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Inventory = Record<ResourceKind, number>;

export interface PlayerState {
  id: string;
  nickname: string;
  pos: Vec3;
  yaw: number;
  health: number;
  hunger: number;
  thirst: number;
  energy: number;
  inventory: Inventory;
  online: boolean;
  isUnderground: boolean;
  color: string;
  lastSeenAt: number;
  deadUntil: number;
}

export interface AgentState {
  id: string;
  role: AgentRole;
  pos: Vec3;
  yaw: number;
  mode: AgentMode;
  taskId: string | null;
  targetId: string | null;
  carrying: ResourceKind | null;
  carryAmount: number;
  health: number;
  isUnderground: boolean;
  phase: number;
}

export interface ResourceNode {
  id: string;
  kind: ResourceKind;
  pos: Vec3;
  amount: number;
  maxAmount: number;
  respawnAt: number;
}

export interface StructureState {
  id: string;
  kind: BuildKind;
  pos: Vec3;
  rotation: number;
  createdAt: number;
  createdBy: string;
  level: number;
}

export interface PredatorState {
  id: string;
  kind: 'spider' | 'beetle';
  pos: Vec3;
  yaw: number;
  health: number;
  mode: 'patrol' | 'hunt' | 'retreat';
  targetId: string | null;
  phase: number;
}

export interface PheromoneCell {
  x: number;
  z: number;
  type: PheromoneType;
  strength: number;
}

export interface Discovery {
  id: string;
  label: string;
  kind: 'resource' | 'threat' | 'region' | 'nest';
  x: number;
  z: number;
  discoveredAt: number;
}

export type ColonyTaskKind = 'forage' | 'explore' | 'patrol' | 'defend' | 'care' | 'excavate';

export interface ColonyTask {
  id: string;
  kind: ColonyTaskKind;
  targetId: string | null;
  x: number;
  z: number;
  priority: number;
  assignedTo: string | null;
  createdAt: number;
}

export interface ColonyStats {
  name: string;
  food: number;
  water: number;
  soil: number;
  leaves: number;
  population: number;
  eggs: number;
  larvae: number;
  pupae: number;
  queenHealth: number;
  research: number;
  storageCapacity: number;
  upgrades: string[];
  lastEvent: string;
}

export interface WorldTime {
  seconds: number;
  dayLength: number;
  weather: WeatherKind;
  weatherSecondsLeft: number;
  flood: number;
  seasonDay: number;
}

export interface ColonyEvent {
  id: string;
  at: number;
  kind: 'colony' | 'discovery' | 'threat' | 'build' | 'birth' | 'weather' | 'player';
  message: string;
}

export interface PersistentWorld {
  version: number;
  seed: number;
  lastSimulatedAt: number;
  colony: ColonyStats;
  worldTime: WorldTime;
  players: Record<string, PlayerState>;
  agents: AgentState[];
  resources: ResourceNode[];
  structures: StructureState[];
  predators: PredatorState[];
  pheromones: PheromoneCell[];
  discoveries: Discovery[];
  tasks: ColonyTask[];
  events: ColonyEvent[];
}

export interface GameSnapshot {
  tick: number;
  serverTime: number;
  seed: number;
  colony: ColonyStats;
  worldTime: WorldTime;
  players: PlayerState[];
  agents: AgentState[];
  resources: ResourceNode[];
  structures: StructureState[];
  predators: PredatorState[];
  pheromones: PheromoneCell[];
  discoveries: Discovery[];
  tasks: ColonyTask[];
  events: ColonyEvent[];
}

export type GameAction =
  | { type: 'interact' }
  | { type: 'deposit' }
  | { type: 'eat' }
  | { type: 'drink' }
  | { type: 'rest' }
  | { type: 'attack' }
  | { type: 'build'; kind: BuildKind };

export type ClientMessage =
  | { type: 'join'; nickname: string; inviteCode: string; sessionToken?: string }
  | { type: 'move'; seq: number; x: number; z: number; yaw: number; run: boolean; jump: boolean }
  | { type: 'action'; action: GameAction }
  | { type: 'ping'; at: number };

export type ServerMessage =
  | { type: 'joined'; sessionToken: string; selfId: string; snapshot: GameSnapshot; resumed: boolean }
  | { type: 'snapshot'; snapshot: GameSnapshot }
  | { type: 'event'; event: ColonyEvent }
  | { type: 'notice'; message: string; tone: 'info' | 'success' | 'warning' | 'error' }
  | { type: 'pong'; at: number; serverTime: number }
  | { type: 'error'; code: string; message: string };

export interface StaticProp {
  id: string;
  kind: 'rock' | 'log' | 'stump' | 'flower' | 'mushroom' | 'fern' | 'tree' | 'leaf' | 'grass';
  x: number;
  z: number;
  radius: number;
  height: number;
  variant: number;
}

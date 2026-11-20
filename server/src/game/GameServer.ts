import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import type {
  BuildKind, ClientMessage, ColonyEvent, GameAction, GameSnapshot, Inventory, PersistentWorld,
  PlayerState, ResourceKind, ServerMessage, Vec3,
} from '../../../shared/src/types.js';
import { flatDistance, groundHeight, isInPond, terrainHeight } from '../../../shared/src/world.js';
import type { ServerConfig } from '../config.js';
import type { GameStore } from '../persistence/Store.js';
import { SessionManager, normalizeNickname } from '../security/session.js';
import { ColonyAI } from './antAI.js';
import { NavigationGrid } from './navigation.js';
import { depositPheromone } from './pheromones.js';
import { createDefaultWorld, createPlayer, inventoryCount, isFood, makeEvent } from './worldFactory.js';
import { simulateOffline } from './offlineSimulation.js';
import { simulateColonyHour } from './colonyEconomy.js';

const SIMULATION_HZ = 20;
const SNAPSHOT_INTERVAL_MS = 100;
const SAVE_INTERVAL_MS = 20_000;
const CARRY_LIMIT = 8;
const FOOD_PRIORITY: ResourceKind[] = ['sugar', 'berry', 'seed', 'mushroom'];

interface PlayerInput {
  x: number;
  z: number;
  yaw: number;
  run: boolean;
  jump: boolean;
}

interface PlayerRuntime {
  input: PlayerInput;
  jumpQueued: boolean;
  verticalVelocity: number;
  grounded: boolean;
  lastSeq: number;
  lastActionAt: number;
  lastDiscoveryAt: number;
}

interface SocketMeta {
  playerId: string | null;
  windowStartedAt: number;
  messageCount: number;
  lastActionWindowAt: number;
  actionCount: number;
}

interface PredatorRuntime {
  home: Vec3;
  attackAt: number;
  path: Array<{ x: number; z: number }>;
  waypoint: number;
  targetKey: string;
  repathAt: number;
}

const emptyInput = (): PlayerInput => ({ x: 0, z: 0, yaw: 0, run: false, jump: false });
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const asNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export class GameServer {
  readonly world: PersistentWorld;
  private readonly ai: ColonyAI;
  private readonly navigation: NavigationGrid;
  private readonly sessions: SessionManager;
  private readonly clients = new Map<string, WebSocket>();
  private readonly socketMeta = new Map<WebSocket, SocketMeta>();
  private readonly playerRuntime = new Map<string, PlayerRuntime>();
  private readonly predatorRuntime = new Map<string, PredatorRuntime>();
  private readonly store: GameStore;
  private readonly config: ServerConfig;
  private tickCount = 0;
  private lastTickAt = Date.now();
  private lastSnapshotAt = 0;
  private lastSaveAt = Date.now();
  private lastAIDelta = 0;
  private lastWorldClockAt = 0;
  private lastColonyHour = 0;
  private savePromise: Promise<void> = Promise.resolve();
  private simulationTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  private constructor(world: PersistentWorld, store: GameStore, config: ServerConfig) {
    this.world = world;
    this.store = store;
    this.config = config;
    this.sessions = new SessionManager(config.sessionSecret, config.inviteCode);
    this.ai = new ColonyAI(world.seed);
    this.navigation = new NavigationGrid(world.seed);
    this.lastColonyHour = Math.floor(world.worldTime.seconds / 60);
    for (const predator of world.predators) this.predatorRuntime.set(predator.id, this.newPredatorRuntime(predator));
  }

  static async create(store: GameStore, config: ServerConfig): Promise<GameServer> {
    await store.initialize();
    const now = Date.now();
    const loaded = await store.load();
    const world = loaded ? normalizeLoadedWorld(loaded) : createDefaultWorld(now);
    const offlineSeconds = loaded ? simulateOffline(world, now) : 0;
    for (const player of Object.values(world.players)) player.online = false;
    world.lastSimulatedAt = now;
    if (offlineSeconds > 60) {
      world.events.push(makeEvent(now, 'colony', `A colônia evoluiu durante sua ausência (${formatElapsed(offlineSeconds)} simulados).`));
      world.events = world.events.slice(-100);
      console.info(`[simulation] Applied ${formatElapsed(offlineSeconds)} of bounded offline colony simulation.`);
    }
    const server = new GameServer(world, store, config);
    await store.save(world);
    console.info(`[world] ${loaded ? 'Loaded saved colony' : 'Created new colony'} · ${world.agents.length} autonomous ants · seed ${world.seed}`);
    return server;
  }

  start(): void {
    if (this.simulationTimer) return;
    const stepMs = 1000 / SIMULATION_HZ;
    this.lastTickAt = Date.now();
    this.simulationTimer = setInterval(() => this.tick(), stepMs);
    this.saveTimer = setInterval(() => void this.persist(), SAVE_INTERVAL_MS);
  }

  attachSocket(socket: WebSocket): void {
    this.socketMeta.set(socket, {
      playerId: null,
      windowStartedAt: Date.now(),
      messageCount: 0,
      lastActionWindowAt: Date.now(),
      actionCount: 0,
    });
    socket.on('message', (data) => this.handleRawMessage(socket, data));
    socket.on('close', () => this.disconnect(socket));
    socket.on('error', (error) => console.warn('[ws] Client socket error:', error.message));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.simulationTimer) clearInterval(this.simulationTimer);
    if (this.saveTimer) clearInterval(this.saveTimer);
    const openSockets = [...this.clients.values()];
    this.clients.clear();
    for (const socket of openSockets) {
      if (socket.readyState === WebSocket.OPEN) socket.close(1001, 'server shutdown');
    }
    const now = Date.now();
    for (const player of Object.values(this.world.players)) {
      if (player.online) {
        player.online = false;
        player.lastSeenAt = now;
      }
    }
    await this.persist(true);
    await this.store.close();
  }

  get onlineCount(): number { return this.clients.size; }

  private handleRawMessage(socket: WebSocket, data: RawData): void {
    const meta = this.socketMeta.get(socket);
    if (!meta) return;
    const now = Date.now();
    if (now - meta.windowStartedAt >= 1000) {
      meta.windowStartedAt = now;
      meta.messageCount = 0;
    }
    meta.messageCount += 1;
    if (meta.messageCount > 65) {
      this.send(socket, { type: 'error', code: 'RATE_LIMIT', message: 'Muitas mensagens. Aguarde um instante.' });
      socket.close(1008, 'rate limit');
      return;
    }

    const raw = rawDataToString(data);
    if (raw.length > 8_192) {
      socket.close(1009, 'message too large');
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      this.send(socket, { type: 'error', code: 'BAD_JSON', message: 'Mensagem inválida.' });
      return;
    }
    if (!isClientMessage(value)) {
      this.send(socket, { type: 'error', code: 'BAD_MESSAGE', message: 'Ação inválida.' });
      return;
    }

    if (!meta.playerId) {
      if (value.type !== 'join') {
        this.send(socket, { type: 'error', code: 'AUTH_REQUIRED', message: 'Entre na colônia para continuar.' });
        return;
      }
      this.join(socket, meta, value, now);
      return;
    }
    if (value.type === 'join') {
      this.send(socket, { type: 'error', code: 'ALREADY_JOINED', message: 'Esta conexão já está autenticada.' });
      return;
    }
    if (value.type === 'move') {
      this.acceptMovement(meta.playerId, meta, value);
    } else if (value.type === 'action') {
      if (now - meta.lastActionWindowAt >= 1000) {
        meta.lastActionWindowAt = now;
        meta.actionCount = 0;
      }
      meta.actionCount += 1;
      if (meta.actionCount > 7) {
        this.sendNotice(meta.playerId, 'Aguarde um instante antes de interagir novamente.', 'warning');
        return;
      }
      this.performAction(meta.playerId, value.action, now);
    } else if (value.type === 'ping') {
      this.send(socket, { type: 'pong', at: value.at, serverTime: now });
    }
  }

  private join(socket: WebSocket, meta: SocketMeta, message: Extract<ClientMessage, { type: 'join' }>, now: number): void {
    const nickname = normalizeNickname(message.nickname);
    if (!nickname) {
      this.send(socket, { type: 'error', code: 'BAD_NICKNAME', message: 'Use um nickname de 2 a 18 letras ou números.' });
      return;
    }

    const resumedId = this.sessions.verify(message.sessionToken);
    const existing = resumedId ? this.world.players[resumedId] : undefined;
    const resumed = Boolean(existing);
    if (!resumed && !this.sessions.verifyInvite(message.inviteCode)) {
      this.send(socket, { type: 'error', code: 'INVITE_REQUIRED', message: 'Convite privado inválido. Peça o código ao proprietário da colônia.' });
      return;
    }

    const duplicate = Object.values(this.world.players).find((player) => player.id !== existing?.id && player.online && player.nickname.toLocaleLowerCase() === nickname.toLocaleLowerCase());
    if (duplicate) {
      this.send(socket, { type: 'error', code: 'NICKNAME_IN_USE', message: 'Esse nickname já está conectado à colônia.' });
      return;
    }

    const playerId = existing?.id ?? randomUUID();
    const previousSocket = this.clients.get(playerId);
    if (previousSocket && previousSocket !== socket) previousSocket.close(4001, 'session resumed elsewhere');
    const player = existing ?? createPlayer(playerId, nickname, now);
    player.nickname = nickname;
    player.online = true;
    player.lastSeenAt = now;
    if (player.deadUntil > 0 && player.deadUntil < now) this.respawn(player, now);
    this.world.players[playerId] = player;
    this.clients.set(playerId, socket);
    this.playerRuntime.set(playerId, {
      input: emptyInput(), jumpQueued: false, verticalVelocity: 0, grounded: true,
      lastSeq: -1, lastActionAt: 0, lastDiscoveryAt: 0,
    });
    meta.playerId = playerId;
    const issued = this.sessions.issue(playerId, now);
    this.send(socket, { type: 'joined', sessionToken: issued.token, selfId: playerId, snapshot: this.createSnapshot(now), resumed });
    this.publishEvent(makeEvent(now, 'player', resumed ? `${nickname} voltou à colônia.` : `${nickname} entrou na colônia.`));
    this.sendNotice(playerId, resumed ? 'Sessão recuperada. Bom retorno à colônia.' : 'Bem-vindo! A rainha e a colônia contam com você.', 'success');
    void this.persist();
  }

  private disconnect(socket: WebSocket): void {
    const meta = this.socketMeta.get(socket);
    this.socketMeta.delete(socket);
    if (!meta?.playerId) return;
    const playerId = meta.playerId;
    if (this.clients.get(playerId) !== socket) return;
    this.clients.delete(playerId);
    this.playerRuntime.delete(playerId);
    const player = this.world.players[playerId];
    if (player) {
      player.online = false;
      player.lastSeenAt = Date.now();
      this.publishEvent(makeEvent(Date.now(), 'player', `${player.nickname} saiu da colônia.`));
      void this.persist();
    }
  }

  private acceptMovement(playerId: string, meta: SocketMeta, message: Extract<ClientMessage, { type: 'move' }>): void {
    const player = this.world.players[playerId];
    const runtime = this.playerRuntime.get(playerId);
    if (!player || !runtime || message.seq <= runtime.lastSeq || !asNumber(message.x) || !asNumber(message.z) || !asNumber(message.yaw)) return;
    runtime.lastSeq = message.seq;
    const x = clamp(message.x, -1, 1);
    const z = clamp(message.z, -1, 1);
    const length = Math.hypot(x, z);
    runtime.input.x = length > 1 ? x / length : x;
    runtime.input.z = length > 1 ? z / length : z;
    runtime.input.yaw = normalizeAngle(message.yaw);
    runtime.input.run = Boolean(message.run);
    const jump = Boolean(message.jump);
    if (jump && !runtime.input.jump) runtime.jumpQueued = true;
    runtime.input.jump = jump;
    player.yaw = runtime.input.yaw;
    player.lastSeenAt = Date.now();
  }

  private tick(): void {
    if (this.stopped) return;
    const now = Date.now();
    const dt = clamp((now - this.lastTickAt) / 1000, 0.01, 0.12);
    this.lastTickAt = now;
    this.tickCount += 1;
    this.advanceClock(dt, now);
    this.regenerateResources(dt, now);
    this.updatePlayers(dt, now);
    this.updatePredators(dt, now);
    this.lastAIDelta += dt;
    if (this.lastAIDelta >= 0.25) {
      this.ai.update(this.world, this.lastAIDelta, now);
      this.lastAIDelta = 0;
    }
    this.discoverForPlayers(now);
    if (now - this.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
      this.broadcastSnapshot(now);
      this.lastSnapshotAt = now;
    }
  }

  private advanceClock(dt: number, now: number): void {
    const previousSeason = Math.floor(this.world.worldTime.seconds / this.world.worldTime.dayLength);
    this.world.worldTime.seconds += dt;
    const nextSeason = Math.floor(this.world.worldTime.seconds / this.world.worldTime.dayLength);
    if (nextSeason > previousSeason) this.world.worldTime.seasonDay += nextSeason - previousSeason;
    const colonyHour = Math.floor(this.world.worldTime.seconds / 60);
    while (this.lastColonyHour < colonyHour) {
      this.lastColonyHour += 1;
      simulateColonyHour(this.world, this.lastColonyHour, now);
    }
    this.world.worldTime.weatherSecondsLeft -= dt;
    if (this.world.worldTime.weatherSecondsLeft <= 0) {
      const options: Array<PersistentWorld['worldTime']['weather']> = ['clear', 'mist', 'drizzle', 'rain'];
      let selection = Math.floor(Math.random() * options.length);
      if (this.world.worldTime.weather === options[selection]) selection = (selection + 1) % options.length;
      this.world.worldTime.weather = options[selection];
      this.world.worldTime.weatherSecondsLeft = 120 + Math.random() * 170;
      const labels = { clear: 'céu aberto', mist: 'neblina', drizzle: 'garoa', rain: 'chuva forte' };
      this.publishEvent(makeEvent(now, 'weather', `O tempo mudou: ${labels[this.world.worldTime.weather]}.`));
    }
    if (this.world.worldTime.weather === 'rain' || this.world.worldTime.weather === 'drizzle') {
      const intensity = this.world.worldTime.weather === 'rain' ? 0.0022 : 0.0007;
      this.world.worldTime.flood = Math.min(0.72, this.world.worldTime.flood + dt * intensity);
    } else {
      this.world.worldTime.flood = Math.max(0, this.world.worldTime.flood - dt * 0.0012);
    }
    if (this.world.worldTime.flood > 0.5 && this.world.colony.lastEvent !== 'A chuva elevou o nível da água; a colônia reforçou a entrada.') {
      this.world.colony.lastEvent = 'A chuva elevou o nível da água; a colônia reforçou a entrada.';
      this.publishEvent(makeEvent(now, 'weather', 'A água está subindo nas áreas baixas. Evite a entrada do formigueiro.'));
    }
    if (now - this.lastWorldClockAt > 60_000) {
      this.lastWorldClockAt = now;
      if (this.world.colony.food < 0.5 && this.world.agents.length > 0) {
        this.world.colony.lastEvent = 'Os estoques de alimento estão quase vazios.';
      }
    }
  }

  private regenerateResources(dt: number, now: number): void {
    for (const node of this.world.resources) {
      if (node.amount <= 0 && node.respawnAt > 0 && now >= node.respawnAt) {
        node.amount = Math.max(1, Math.ceil(node.maxAmount * 0.3));
        node.respawnAt = 0;
      } else if (node.amount > 0 && node.amount < node.maxAmount) {
        node.amount = Math.min(node.maxAmount, node.amount + dt * 0.025);
      }
    }
  }

  private updatePlayers(dt: number, now: number): void {
    for (const player of Object.values(this.world.players)) {
      if (!player.online) continue;
      const runtime = this.playerRuntime.get(player.id);
      if (!runtime) continue;
      if (player.health <= 0) {
        if (player.deadUntil === 0) player.deadUntil = now + 5_000;
        if (now >= player.deadUntil) this.respawn(player, now);
        continue;
      }

      const input = runtime.input;
      const magnitude = Math.hypot(input.x, input.z);
      const wantsRun = input.run && player.energy > 1 && magnitude > 0.05;
      const speed = wantsRun ? 5.9 : 3.4;
      if (magnitude > 0.01) {
        const forward = -input.z;
        const dx = Math.sin(input.yaw) * forward + Math.cos(input.yaw) * input.x;
        const dz = Math.cos(input.yaw) * forward - Math.sin(input.yaw) * input.x;
        const nextX = player.pos.x + dx * speed * dt;
        const nextZ = player.pos.z + dz * speed * dt;
        if (player.isUnderground) {
          player.pos.x = clamp(nextX, -22, 22);
          player.pos.z = clamp(nextZ, -22, 22);
          player.pos.y = -7.5;
        } else {
          const allowedX = clamp(nextX, -73, 73);
          const allowedZ = clamp(nextZ, -73, 73);
          if (!this.navigation.isBlockedPosition(allowedX, allowedZ, 0.4)) {
            player.pos.x = allowedX;
            player.pos.z = allowedZ;
          } else {
            if (!this.navigation.isBlockedPosition(allowedX, player.pos.z, 0.4)) player.pos.x = allowedX;
            if (!this.navigation.isBlockedPosition(player.pos.x, allowedZ, 0.4)) player.pos.z = allowedZ;
          }
        }
      }

      if (wantsRun) player.energy = Math.max(0, player.energy - dt * 0.43);
      else player.energy = Math.min(100, player.energy + dt * (magnitude > 0.01 ? 1.5 : 4.3));

      if (!player.isUnderground) {
        const floor = terrainHeight(player.pos.x, player.pos.z);
        if (runtime.jumpQueued && runtime.grounded) {
          runtime.verticalVelocity = 5.1;
          runtime.grounded = false;
        }
        runtime.jumpQueued = false;
        if (!runtime.grounded) {
          runtime.verticalVelocity -= 13.5 * dt;
          player.pos.y += runtime.verticalVelocity * dt;
          if (player.pos.y <= floor) {
            player.pos.y = floor;
            runtime.verticalVelocity = 0;
            runtime.grounded = true;
          }
        } else {
          player.pos.y = floor;
        }
      } else {
        runtime.jumpQueued = false;
        runtime.grounded = true;
        runtime.verticalVelocity = 0;
        player.pos.y = -7.5;
      }

      player.hunger = Math.max(0, player.hunger - dt * 0.0042);
      player.thirst = Math.max(0, player.thirst - dt * 0.0062);
      if (player.hunger <= 0 || player.thirst <= 0) {
        player.health = Math.max(0, player.health - dt * 0.35);
      } else if (player.health < 100 && player.hunger > 30 && player.thirst > 30) {
        player.health = Math.min(100, player.health + dt * 0.015);
      }
      if (player.health <= 0 && player.deadUntil === 0) {
        player.deadUntil = now + 5_000;
        this.publishEvent(makeEvent(now, 'player', `${player.nickname} caiu; a colônia preparou um retorno seguro.`));
      }
    }
  }

  private updatePredators(dt: number, now: number): void {
    for (const predator of this.world.predators) {
      let runtime = this.predatorRuntime.get(predator.id);
      if (!runtime) {
        runtime = this.newPredatorRuntime(predator);
        this.predatorRuntime.set(predator.id, runtime);
      }
      predator.phase = (predator.phase + dt * 0.42) % (Math.PI * 2);
      const playerTarget = Object.values(this.world.players)
        .filter((player) => player.online && !player.isUnderground && player.health > 0 && flatDistance(player.pos, predator.pos) < 17)
        .sort((a, b) => flatDistance(a.pos, predator.pos) - flatDistance(b.pos, predator.pos))[0];
      const agentTarget = this.world.agents
        .filter((agent) => !agent.isUnderground && agent.health > 0 && flatDistance(agent.pos, predator.pos) < 6)
        .sort((a, b) => flatDistance(a.pos, predator.pos) - flatDistance(b.pos, predator.pos))[0];
      const target: PlayerState | PersistentWorld['agents'][number] | undefined = playerTarget ?? agentTarget;

      if (target) {
        predator.mode = 'hunt';
        predator.targetId = target.id;
        const dx = target.pos.x - predator.pos.x;
        const dz = target.pos.z - predator.pos.z;
        const distance = Math.hypot(dx, dz) || 1;
        predator.yaw = Math.atan2(dx, dz);
        if (distance > 1.15) {
          const speed = predator.kind === 'spider' ? 2.25 : 2.9;
          predator.pos.x += dx / distance * Math.min(speed * dt, distance - 1.1);
          predator.pos.z += dz / distance * Math.min(speed * dt, distance - 1.1);
          predator.pos.y = terrainHeight(predator.pos.x, predator.pos.z);
        } else if (now >= runtime.attackAt) {
          runtime.attackAt = now + 1_300;
          if (playerTarget) {
            playerTarget.health = Math.max(0, playerTarget.health - (predator.kind === 'spider' ? 13 : 9));
            this.sendNotice(playerTarget.id, `${predator.kind === 'spider' ? 'A aranha' : 'O besouro'} atacou você!`, 'warning');
          } else if (agentTarget) {
            agentTarget.health -= predator.kind === 'spider' ? 16 : 11;
            if (agentTarget.health <= 0) {
              this.world.agents = this.world.agents.filter((agent) => agent.id !== agentTarget.id);
              this.world.colony.population = Math.max(1, this.world.colony.population - 1);
              this.publishEvent(makeEvent(now, 'threat', `Um predador levou uma formiga ${agentTarget.role}.`));
            }
          }
        }
        if (now % 2000 < dt * 1000) depositPheromone(this.world, predator.pos.x, predator.pos.z, 'danger', 0.3);
        continue;
      }

      predator.mode = 'patrol';
      predator.targetId = null;
      const radius = predator.kind === 'spider' ? 4.3 : 6.2;
      const targetX = runtime.home.x + Math.sin(predator.phase) * radius;
      const targetZ = runtime.home.z + Math.cos(predator.phase) * radius;
      const dx = targetX - predator.pos.x;
      const dz = targetZ - predator.pos.z;
      const distance = Math.hypot(dx, dz);
      if (distance > 0.4) {
        const step = Math.min((predator.kind === 'spider' ? 0.7 : 1.05) * dt, distance);
        predator.pos.x += dx / distance * step;
        predator.pos.z += dz / distance * step;
        predator.pos.y = terrainHeight(predator.pos.x, predator.pos.z);
        predator.yaw = Math.atan2(dx, dz);
      }
    }
  }

  private discoverForPlayers(now: number): void {
    for (const player of Object.values(this.world.players)) {
      if (!player.online || now - (this.playerRuntime.get(player.id)?.lastDiscoveryAt ?? 0) < 1_200) continue;
      const runtime = this.playerRuntime.get(player.id);
      if (runtime) runtime.lastDiscoveryAt = now;
      for (const node of this.world.resources) {
        if (node.amount < 1 || flatDistance(node.pos, player.pos) > 8) continue;
        const id = `resource-${node.id}`;
        if (!this.world.discoveries.some((discovery) => discovery.id === id)) {
          this.world.discoveries.push({ id, label: resourceName(node.kind), kind: 'resource', x: node.pos.x, z: node.pos.z, discoveredAt: now });
          this.publishEvent(makeEvent(now, 'discovery', `${player.nickname} encontrou ${resourceName(node.kind).toLowerCase()}.`));
        }
      }
      const regions = [
        { id: 'north-meadow', label: 'Prado do norte', x: 0, z: -30 },
        { id: 'stone-garden', label: 'Jardim de pedras', x: -34, z: 22 },
        { id: 'old-oak', label: 'Carvalho antigo', x: -31, z: -35 },
        { id: 'fallen-log', label: 'Tronco caído', x: 37, z: 18 },
        { id: 'pond-edge', label: 'Margem úmida', x: 21, z: -15 },
        { id: 'sunny-rise', label: 'Elevação ensolarada', x: 39, z: -34 },
      ];
      for (const region of regions) {
        if (flatDistance(player.pos, region) > 10) continue;
        const id = `region-${region.id}`;
        if (this.world.discoveries.some((discovery) => discovery.id === id)) continue;
        this.world.discoveries.push({ id, label: region.label, kind: 'region', x: region.x, z: region.z, discoveredAt: now });
        this.publishEvent(makeEvent(now, 'discovery', `${player.nickname} mapeou a região: ${region.label}.`));
      }
      for (const predator of this.world.predators) {
        if (flatDistance(predator.pos, player.pos) > 14) continue;
        const id = `threat-${predator.id}`;
        if (this.world.discoveries.some((discovery) => discovery.id === id)) continue;
        this.world.discoveries.push({ id, label: predator.kind === 'spider' ? 'Aranha' : 'Besouro', kind: 'threat', x: predator.pos.x, z: predator.pos.z, discoveredAt: now });
        this.publishEvent(makeEvent(now, 'threat', `Ameaça identificada perto de ${player.nickname}.`));
      }
    }
  }

  private performAction(playerId: string, action: GameAction, now: number): void {
    const player = this.world.players[playerId];
    const runtime = this.playerRuntime.get(playerId);
    if (!player || !runtime) return;
    if (now - runtime.lastActionAt < 240) return;
    runtime.lastActionAt = now;

    switch (action.type) {
      case 'interact': this.interact(player, now); break;
      case 'deposit': this.depositInventory(player, now); break;
      case 'eat': this.eat(player); break;
      case 'drink': this.drink(player, now); break;
      case 'rest': this.rest(player); break;
      case 'attack': this.attack(player, now); break;
      case 'build': this.build(player, action.kind, now); break;
    }
  }

  private interact(player: PlayerState, now: number): void {
    const nestDistance = flatDistance(player.pos, { x: 0, z: 0 });
    if (player.isUnderground) {
      if (nestDistance <= 3.2 && this.world.worldTime.flood < 0.58) {
        player.isUnderground = false;
        player.pos.x = 0;
        player.pos.z = 0;
        player.pos.y = terrainHeight(0, 0);
        this.sendNotice(player.id, 'Você emergiu pela entrada do formigueiro.', 'info');
        return;
      }
      if (inventoryCount(player.inventory) > 0) {
        this.depositInventory(player, now);
        return;
      }
      this.sendNotice(player.id, 'Explore a câmara ou use B para expandir o formigueiro.', 'info');
      return;
    }

    const node = this.world.resources
      .filter((resource) => resource.amount >= 1)
      .sort((a, b) => flatDistance(a.pos, player.pos) - flatDistance(b.pos, player.pos))[0];
    if (node && flatDistance(node.pos, player.pos) <= 2.8) {
      this.collect(player, node, now);
      return;
    }
    if (nestDistance <= 3.2) {
      if (this.world.worldTime.flood >= 0.58) {
        this.sendNotice(player.id, 'A entrada está inundada. Aguarde a água baixar.', 'warning');
        return;
      }
      player.isUnderground = true;
      player.pos.x = 0;
      player.pos.z = 0;
      player.pos.y = -7.5;
      this.sendNotice(player.id, 'Você entrou na câmara principal. Pressione E na entrada para sair.', 'success');
      return;
    }
    if (isInPond(player.pos.x, player.pos.z) || Math.hypot(player.pos.x - 22, player.pos.z + 22) < 8.2) {
      this.drink(player, now);
      return;
    }
    this.sendNotice(player.id, 'Nada para interagir aqui. Aproxime-se de um recurso ou da entrada.', 'info');
  }

  private collect(player: PlayerState, node: PersistentWorld['resources'][number], now: number): void {
    const space = CARRY_LIMIT - inventoryCount(player.inventory);
    if (space <= 0) {
      this.sendNotice(player.id, 'Você está carregando o máximo. Volte ao formigueiro para guardar os recursos.', 'warning');
      return;
    }
    const amount = Math.min(space, Math.max(1, Math.floor(node.amount)));
    if (amount <= 0) {
      this.sendNotice(player.id, 'Esse recurso acabou.', 'info');
      return;
    }
    node.amount -= amount;
    node.respawnAt = node.amount <= 0 ? now + 90_000 : 0;
    player.inventory[node.kind] += amount;
    if (!this.world.discoveries.some((discovery) => discovery.id === `resource-${node.id}`)) {
      this.world.discoveries.push({ id: `resource-${node.id}`, label: resourceName(node.kind), kind: 'resource', x: node.pos.x, z: node.pos.z, discoveredAt: now });
    }
    depositPheromone(this.world, player.pos.x, player.pos.z, isFood(node.kind) ? 'food' : 'home', 0.35);
    this.sendNotice(player.id, `Coletou ${amount} ${resourceName(node.kind)}. Leve ao formigueiro para armazenar.`, 'success');
  }

  private depositInventory(player: PlayerState, now: number): void {
    if (!player.isUnderground && flatDistance(player.pos, { x: 0, z: 0 }) > 7) {
      this.sendNotice(player.id, 'Aproxime-se da entrada do formigueiro para guardar os recursos.', 'warning');
      return;
    }
    const total = inventoryCount(player.inventory);
    if (total === 0) {
      this.sendNotice(player.id, 'Seu inventário está vazio.', 'info');
      return;
    }
    let deposited = 0;
    for (const kind of Object.keys(player.inventory) as ResourceKind[]) {
      const amount = player.inventory[kind];
      if (!amount) continue;
      player.inventory[kind] = 0;
      deposited += amount;
      if (isFood(kind)) this.world.colony.food = Math.min(this.world.colony.storageCapacity, this.world.colony.food + amount);
      else if (kind === 'dew') this.world.colony.water = Math.min(this.world.colony.storageCapacity, this.world.colony.water + amount);
      else if (kind === 'soil') this.world.colony.soil = Math.min(180, this.world.colony.soil + amount);
      else this.world.colony.leaves = Math.min(120, this.world.colony.leaves + amount);
    }
    this.world.colony.lastEvent = `${player.nickname} armazenou ${deposited} unidades de recursos.`;
    this.publishEvent(makeEvent(now, 'colony', this.world.colony.lastEvent));
    this.sendNotice(player.id, `${deposited} recursos armazenados na colônia.`, 'success');
  }

  private eat(player: PlayerState): void {
    if (player.hunger >= 92) {
      this.sendNotice(player.id, 'Você não está com fome.', 'info');
      return;
    }
    const kind = FOOD_PRIORITY.find((resource) => player.inventory[resource] > 0);
    if (!kind) {
      this.sendNotice(player.id, 'Sem comida no inventário. Procure sementes, frutas ou néctar.', 'warning');
      return;
    }
    player.inventory[kind] -= 1;
    player.hunger = Math.min(100, player.hunger + (kind === 'sugar' ? 40 : 32));
    player.energy = Math.min(100, player.energy + 12);
    this.sendNotice(player.id, `Você comeu ${resourceName(kind)}.`, 'success');
  }

  private drink(player: PlayerState, now: number): void {
    if (player.thirst >= 92) {
      this.sendNotice(player.id, 'Você não está com sede.', 'info');
      return;
    }
    if (player.inventory.dew > 0) {
      player.inventory.dew -= 1;
      player.thirst = Math.min(100, player.thirst + 42);
      this.sendNotice(player.id, 'Você bebeu uma gota de orvalho.', 'success');
      return;
    }
    if (Math.hypot(player.pos.x - 22, player.pos.z + 22) < 8.2 && !player.isUnderground) {
      player.thirst = Math.min(100, player.thirst + 36);
      this.world.colony.water = Math.min(this.world.colony.storageCapacity, this.world.colony.water + 1);
      this.sendNotice(player.id, 'Você bebeu da poça e recolheu uma gota para a colônia.', 'success');
      depositPheromone(this.world, player.pos.x, player.pos.z, 'home', 0.22);
      return;
    }
    this.sendNotice(player.id, 'Sem água no inventário. Procure orvalho ou a poça ao sudeste.', 'warning');
    void now;
  }

  private rest(player: PlayerState): void {
    if (!player.isUnderground && flatDistance(player.pos, { x: 0, z: 0 }) > 5) {
      this.sendNotice(player.id, 'Descanse em segurança dentro do formigueiro.', 'warning');
      return;
    }
    player.energy = Math.min(100, player.energy + 45);
    player.health = Math.min(100, player.health + 8);
    this.sendNotice(player.id, 'Você descansou na câmara e recuperou energia.', 'success');
  }

  private attack(player: PlayerState, now: number): void {
    const predator = this.world.predators
      .filter((candidate) => flatDistance(candidate.pos, player.pos) <= 2.3)
      .sort((a, b) => flatDistance(a.pos, player.pos) - flatDistance(b.pos, player.pos))[0];
    if (!predator) {
      this.sendNotice(player.id, 'Nenhuma ameaça ao alcance das mandíbulas.', 'info');
      return;
    }
    predator.health -= 24;
    player.energy = Math.max(0, player.energy - 6);
    this.sendNotice(player.id, `Você mordeu o ${predator.kind === 'spider' ? 'aracnídeo' : 'besouro'}!`, 'warning');
    if (predator.health <= 0) {
      this.world.predators = this.world.predators.filter((candidate) => candidate.id !== predator.id);
      this.predatorRuntime.delete(predator.id);
      this.world.colony.food = Math.min(this.world.colony.storageCapacity, this.world.colony.food + 5);
      this.world.colony.lastEvent = `${player.nickname} ajudou a afastar uma ameaça.`;
      this.publishEvent(makeEvent(now, 'threat', this.world.colony.lastEvent));
      this.sendNotice(player.id, 'A ameaça foi derrotada. A colônia recuperou alimento.', 'success');
    }
  }

  private build(player: PlayerState, kind: BuildKind, now: number): void {
    if (!player.isUnderground) {
      this.sendNotice(player.id, 'A construção só pode ser feita dentro do formigueiro. Pressione E na entrada.', 'warning');
      return;
    }
    if (this.world.structures.length >= 36) {
      this.sendNotice(player.id, 'A colônia atingiu o limite atual de estruturas.', 'warning');
      return;
    }
    const costs: Record<BuildKind, { soil: number; leaves: number; label: string }> = {
      tunnel: { soil: 4, leaves: 1, label: 'túnel' },
      chamber: { soil: 12, leaves: 4, label: 'câmara' },
      store: { soil: 8, leaves: 5, label: 'depósito' },
      nursery: { soil: 10, leaves: 6, label: 'berçário' },
      barrier: { soil: 3, leaves: 4, label: 'barreira' },
    };
    const cost = costs[kind];
    if (this.world.colony.soil < cost.soil || this.world.colony.leaves < cost.leaves) {
      this.sendNotice(player.id, `Faltam materiais. ${cost.label}: ${cost.soil} terra e ${cost.leaves} folhas.`, 'warning');
      return;
    }
    const nearest = this.world.structures
      .slice()
      .sort((a, b) => flatDistance(a.pos, player.pos) - flatDistance(b.pos, player.pos))[0];
    if (!nearest || flatDistance(nearest.pos, player.pos) > 8) {
      this.sendNotice(player.id, 'Aproxime-se de uma câmara existente para expandir o formigueiro.', 'warning');
      return;
    }

    const directionX = Math.sin(player.yaw);
    const directionZ = Math.cos(player.yaw);
    const distance = kind === 'tunnel' || kind === 'barrier' ? 4 : 6.2;
    const x = clamp(player.pos.x + directionX * distance, -20, 20);
    const z = clamp(player.pos.z + directionZ * distance, -20, 20);
    const requiredSpace = kind === 'chamber' || kind === 'nursery' ? 4.2 : kind === 'store' ? 3.4 : kind === 'tunnel' ? 2.0 : 1.4;
    if (this.world.structures.some((structure) => flatDistance(structure.pos, { x, z }) < requiredSpace)) {
      this.sendNotice(player.id, 'Não há espaço suficiente nesse ponto. Gire a câmera e tente novamente.', 'warning');
      return;
    }
    if (flatDistance(nearest.pos, { x, z }) > 13) {
      this.sendNotice(player.id, 'A nova estrutura precisa se conectar ao formigueiro existente.', 'warning');
      return;
    }

    this.world.colony.soil -= cost.soil;
    this.world.colony.leaves -= cost.leaves;
    const structure = {
      id: `build-${randomUUID()}`, kind, pos: { x, y: -7.5, z }, rotation: player.yaw,
      createdAt: now, createdBy: player.id, level: 1,
    };
    this.world.structures.push(structure);
    if (kind === 'chamber' || kind === 'store' || kind === 'nursery') {
      const cap = kind === 'store' ? 30 : kind === 'nursery' ? 12 : 8;
      this.world.colony.storageCapacity = Math.min(300, this.world.colony.storageCapacity + cap);
    }
    if (kind === 'nursery' && !this.world.colony.upgrades.includes('brood-care')) this.world.colony.upgrades.push('brood-care');
    const message = `${player.nickname} construiu ${kind === 'tunnel' ? 'um túnel' : `um(a) ${cost.label}`} no formigueiro.`;
    this.world.colony.lastEvent = message;
    this.publishEvent(makeEvent(now, 'build', message));
    this.sendNotice(player.id, `Construção concluída: ${cost.label}.`, 'success');
  }

  private respawn(player: PlayerState, now: number): void {
    const lost: Inventory = { ...player.inventory };
    for (const kind of Object.keys(lost) as ResourceKind[]) {
      const kept = Math.floor(lost[kind] / 2);
      lost[kind] -= kept;
      player.inventory[kind] = kept;
    }
    player.pos = { x: -1.6, y: terrainHeight(-1.6, 5.5), z: 5.5 };
    player.isUnderground = false;
    player.health = 75;
    player.hunger = Math.max(35, player.hunger);
    player.thirst = Math.max(35, player.thirst);
    player.energy = 100;
    player.deadUntil = 0;
    const runtime = this.playerRuntime.get(player.id);
    if (runtime) {
      runtime.verticalVelocity = 0;
      runtime.grounded = true;
      runtime.jumpQueued = false;
    }
    this.publishEvent(makeEvent(now, 'player', `${player.nickname} retornou ao formigueiro após uma queda.`));
    this.sendNotice(player.id, 'Você reapareceu na entrada segura. Metade da carga foi mantida.', 'info');
  }

  private sendNotice(playerId: string, message: string, tone: 'info' | 'success' | 'warning' | 'error'): void {
    const socket = this.clients.get(playerId);
    if (socket) this.send(socket, { type: 'notice', message, tone });
  }

  private publishEvent(event: ColonyEvent): void {
    this.world.events.push(event);
    this.world.events = this.world.events.slice(-100);
    this.world.colony.lastEvent = event.message;
    const payload: ServerMessage = { type: 'event', event };
    const text = JSON.stringify(payload);
    for (const socket of this.clients.values()) if (socket.readyState === WebSocket.OPEN) socket.send(text);
  }

  private createSnapshot(now = Date.now()): GameSnapshot {
    return {
      tick: this.tickCount,
      serverTime: now,
      seed: this.world.seed,
      colony: this.world.colony,
      worldTime: this.world.worldTime,
      players: Object.values(this.world.players).filter((player) => player.online),
      agents: this.world.agents,
      resources: this.world.resources,
      structures: this.world.structures,
      predators: this.world.predators,
      pheromones: this.world.pheromones,
      discoveries: this.world.discoveries,
      tasks: this.world.tasks,
      events: this.world.events.slice(-24),
    };
  }

  private broadcastSnapshot(now: number): void {
    if (this.clients.size === 0) return;
    const text = JSON.stringify({ type: 'snapshot', snapshot: this.createSnapshot(now) } satisfies ServerMessage);
    for (const socket of this.clients.values()) if (socket.readyState === WebSocket.OPEN) socket.send(text);
  }

  private send(socket: WebSocket, payload: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  private async persist(force = false): Promise<void> {
    if (!force && Date.now() - this.lastSaveAt < 2_500) return;
    const previous = this.savePromise;
    const saving = previous.catch(() => undefined).then(async () => {
      this.world.lastSimulatedAt = Date.now();
      const snapshot = structuredClone(this.world);
      try {
        await this.store.save(snapshot);
        this.lastSaveAt = Date.now();
      } catch (error) {
        console.error(`[store:${this.store.mode}] Snapshot save failed:`, error instanceof Error ? error.message : error);
      }
    });
    this.savePromise = saving;
    await saving;
    if (this.savePromise === saving) this.savePromise = Promise.resolve();
  }

  private newPredatorRuntime(predator: PersistentWorld['predators'][number]): PredatorRuntime {
    return { home: { ...predator.pos }, attackAt: 0, path: [], waypoint: 0, targetKey: '', repathAt: 0 };
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function normalizeLoadedWorld(world: PersistentWorld): PersistentWorld {
  world.version = 1;
  world.players ??= {};
  world.agents ??= [];
  world.resources ??= [];
  world.structures ??= [];
  world.predators ??= [];
  world.pheromones ??= [];
  world.discoveries ??= [];
  world.tasks ??= [];
  world.events ??= [];
  world.colony.upgrades ??= [];
  world.colony.storageCapacity ??= 140;
  world.worldTime ??= { seconds: 0, dayLength: 720, weather: 'clear', weatherSecondsLeft: 150, flood: 0, seasonDay: 1 };
  for (const player of Object.values(world.players)) {
    player.online = false;
    player.inventory ??= { seed: 0, berry: 0, sugar: 0, dew: 0, soil: 0, leaf: 0, mushroom: 0 };
    player.deadUntil ??= 0;
    player.isUnderground ??= false;
  }
  return world;
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'join') return typeof message.nickname === 'string' && typeof message.inviteCode === 'string';
  if (message.type === 'move') return asNumber(message.seq) && asNumber(message.x) && asNumber(message.z) && asNumber(message.yaw);
  if (message.type === 'ping') return asNumber(message.at);
  if (message.type === 'action') {
    if (!message.action || typeof message.action !== 'object') return false;
    const action = message.action as Record<string, unknown>;
    if (['interact', 'deposit', 'eat', 'drink', 'rest', 'attack'].includes(String(action.type))) return true;
    return action.type === 'build' && ['chamber', 'store', 'nursery', 'tunnel', 'barrier'].includes(String(action.kind));
  }
  return false;
}

function normalizeAngle(angle: number): number {
  const wrapped = ((angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return clamp(wrapped, -Math.PI, Math.PI);
}

function resourceName(kind: ResourceKind): string {
  const labels: Record<ResourceKind, string> = {
    seed: 'sementes', berry: 'frutas', sugar: 'néctar', dew: 'orvalho', soil: 'terra', leaf: 'folhas', mushroom: 'cogumelos',
  };
  return labels[kind];
}

function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days} dia(s)`;
  if (hours > 0) return `${hours} hora(s)`;
  return `${Math.max(1, Math.floor(seconds / 60))} minuto(s)`;
}

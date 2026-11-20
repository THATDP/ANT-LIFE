import type { AgentRole, AgentState, ColonyTask, ColonyTaskKind, PersistentWorld, PredatorState, ResourceKind, Vec3 } from '../../../shared/src/types.js';
import { flatDistance, terrainHeight } from '../../../shared/src/world.js';
import { NavigationGrid } from './navigation.js';
import { decayPheromones, depositPheromone, pheromoneAttraction, strongestPheromone } from './pheromones.js';
import { makeEvent } from './worldFactory.js';

interface AgentRuntime {
  path: Array<{ x: number; z: number }>;
  waypoint: number;
  pathKey: string;
  nextRepathAt: number;
  actionAt: number;
  idleUntil: number;
  lastUpdatedAt: number;
}

const nest = { x: 0, z: 0 };
const FOOD_KINDS = new Set<ResourceKind>(['seed', 'berry', 'sugar', 'mushroom']);

export class ColonyAI {
  private readonly runtime = new Map<string, AgentRuntime>();
  private nextPlanAt = 0;
  private readonly navigation: NavigationGrid;

  constructor(seed: number) {
    this.navigation = new NavigationGrid(seed);
  }

  update(world: PersistentWorld, dt: number, now: number): void {
    decayPheromones(world, dt);
    if (now >= this.nextPlanAt) {
      this.refreshTasks(world, now);
      this.nextPlanAt = now + 4_000;
    }

    const onlinePlayers = Object.values(world.players).filter((player) => player.online);
    for (const agent of world.agents) {
      const runtime = this.getRuntime(agent);
      const nearPlayer = onlinePlayers.some((player) => player.isUnderground === agent.isUnderground && flatDistance(player.pos, agent.pos) < 26);
      const nearThreat = !agent.isUnderground && world.predators.some((predator) => predator.health > 0 && flatDistance(predator.pos, agent.pos) < 15);
      const cadence = nearPlayer || nearThreat ? 0.25 : 0.75;
      const elapsed = runtime.lastUpdatedAt > 0 ? Math.max(dt, (now - runtime.lastUpdatedAt) / 1000) : dt;
      if (runtime.lastUpdatedAt > 0 && elapsed + 0.02 < cadence) continue;
      const agentDt = Math.max(0.01, Math.min(1.25, elapsed));
      runtime.lastUpdatedAt = now;
      agent.phase = (agent.phase + agentDt * (agent.mode === 'idle' || agent.mode === 'caring' ? 1.3 : 8.5)) % (Math.PI * 2);
      this.avoidThreats(world, agent, runtime, agentDt, now);
      if (agent.mode === 'fleeing') continue;
      if (agent.mode === 'returning') {
        this.returnToNest(world, agent, runtime, agentDt, now);
        continue;
      }
      if (agent.mode === 'caring') {
        if (now >= runtime.actionAt) {
          if (world.colony.food > 0 && world.colony.larvae > 0) world.colony.food = Math.max(0, world.colony.food - 0.04);
          runtime.actionAt = now + 15_000;
        }
        continue;
      }
      if (agent.mode === 'idle' && now < runtime.idleUntil) continue;
      const task = world.tasks.find((candidate) => candidate.id === agent.taskId);
      if (!task || (task.assignedTo && task.assignedTo !== agent.id)) {
        this.releaseTask(world, agent);
        this.assignTask(world, agent, now);
        continue;
      }
      this.performTask(world, agent, task, runtime, agentDt, now);
    }

    // Agents leave a very light home signal; it decays in the field rather than growing forever.
    if (now % 4_000 < dt * 1_000) depositPheromone(world, 0, 0, 'home', 0.12);
  }

  private refreshTasks(world: PersistentWorld, now: number): void {
    const next: ColonyTask[] = [];
    const activeAssignments = new Set<string>();
    const desired = new Map<string, ColonyTask>();
    const foodNeed = Math.max(0, 1 - world.colony.food / Math.max(1, world.colony.storageCapacity * 0.8));
    const waterNeed = Math.max(0, 1 - world.colony.water / Math.max(1, world.colony.storageCapacity * 0.65));

    if (foodNeed > 0.04) {
      const foodNodes = world.resources
        .filter((node) => node.amount >= 1 && FOOD_KINDS.has(node.kind))
        .sort((a, b) => {
          const aScent = strongestPheromone(world, a.pos.x, a.pos.z, 'food', 14)?.strength ?? 0;
          const bScent = strongestPheromone(world, b.pos.x, b.pos.z, 'food', 14)?.strength ?? 0;
          return flatDistance(a.pos, nest) - aScent * 8 - (flatDistance(b.pos, nest) - bScent * 8);
        })
        .slice(0, Math.max(3, Math.min(8, Math.ceil(2 + foodNeed * 6))));
      for (const node of foodNodes) {
        desired.set(`forage-${node.id}`, {
          id: `forage-${node.id}`, kind: 'forage', targetId: node.id, x: node.pos.x, z: node.pos.z,
          priority: 50 + foodNeed * 28 - flatDistance(node.pos, nest) * 0.12 + (strongestPheromone(world, node.pos.x, node.pos.z, 'food', 14)?.strength ?? 0) * 16, assignedTo: null, createdAt: now,
        });
      }
    }

    if (waterNeed > 0.06) {
      const waterNodes = world.resources
        .filter((node) => node.kind === 'dew' && node.amount >= 1)
        .sort((a, b) => {
          const aScent = strongestPheromone(world, a.pos.x, a.pos.z, 'home', 14)?.strength ?? 0;
          const bScent = strongestPheromone(world, b.pos.x, b.pos.z, 'home', 14)?.strength ?? 0;
          return flatDistance(a.pos, nest) - aScent * 7 - (flatDistance(b.pos, nest) - bScent * 7);
        })
        .slice(0, Math.max(2, Math.min(4, Math.ceil(1 + waterNeed * 3))));
      for (const node of waterNodes) {
        desired.set(`water-${node.id}`, {
          id: `water-${node.id}`, kind: 'forage', targetId: node.id, x: node.pos.x, z: node.pos.z,
          priority: 58 + waterNeed * 30 - flatDistance(node.pos, nest) * 0.1 + (strongestPheromone(world, node.pos.x, node.pos.z, 'home', 14)?.strength ?? 0) * 13, assignedTo: null, createdAt: now,
        });
      }
    }

    const nearestThreat = world.predators
      .filter((predator) => predator.health > 0)
      .sort((a, b) => flatDistance(a.pos, nest) - flatDistance(b.pos, nest))[0];
    if (nearestThreat && flatDistance(nearestThreat.pos, nest) < 38) {
      for (let i = 0; i < 4; i += 1) {
        desired.set(`defend-${nearestThreat.id}-${i}`, {
          id: `defend-${nearestThreat.id}-${i}`, kind: 'defend', targetId: nearestThreat.id,
          x: nearestThreat.pos.x, z: nearestThreat.pos.z,
          priority: 96 - i, assignedTo: null, createdAt: now,
        });
      }
    } else {
      desired.set('patrol-entrance-west', { id: 'patrol-entrance-west', kind: 'patrol', targetId: null, x: -5, z: 1, priority: 34, assignedTo: null, createdAt: now });
      desired.set('patrol-entrance-east', { id: 'patrol-entrance-east', kind: 'patrol', targetId: null, x: 5, z: -1, priority: 33, assignedTo: null, createdAt: now });
    }

    const knownRegions = new Set(world.discoveries.filter((d) => d.kind === 'region').map((d) => d.id));
    const explorationTargets = [
      { id: 'north-meadow', x: 0, z: -31 }, { id: 'stone-garden', x: -34, z: 22 },
      { id: 'old-oak', x: -31, z: -35 }, { id: 'fallen-log', x: 37, z: 18 },
      { id: 'pond-edge', x: 21, z: -14 }, { id: 'sunny-rise', x: 39, z: -34 },
    ];
    const explorerCount = world.agents.filter((agent) => agent.role === 'scout').length;
    const unknown = explorationTargets.filter((target) => !knownRegions.has(`region-${target.id}`));
    for (const target of unknown.slice(0, Math.max(1, Math.min(explorerCount, 3)))) {
      desired.set(`explore-${target.id}`, {
        id: `explore-${target.id}`, kind: 'explore', targetId: target.id,
        x: target.x, z: target.z, priority: 64 + (unknown.indexOf(target) === 0 ? 8 : 0), assignedTo: null, createdAt: now,
      });
    }

    const chamberCount = world.structures.filter((structure) => structure.kind === 'chamber' || structure.kind === 'nursery').length;
    if (world.colony.population > 25 + chamberCount * 7 && world.colony.soil >= 12 && world.structures.length < 18) {
      const index = world.structures.length;
      const angle = index * 2.399963229728653;
      const x = Math.cos(angle) * (7 + (index % 3) * 3);
      const z = Math.sin(angle) * (7 + (index % 3) * 3);
      desired.set(`excavate-${index}`, { id: `excavate-${index}`, kind: 'excavate', targetId: null, x, z, priority: 52, assignedTo: null, createdAt: now });
    }

    if (world.colony.eggs + world.colony.larvae > 0) {
      desired.set('care-brood', { id: 'care-brood', kind: 'care', targetId: null, x: 0, z: 0, priority: 60 + Math.min(16, world.colony.larvae * 2), assignedTo: null, createdAt: now });
    }

    const agentsById = new Map(world.agents.map((agent) => [agent.id, agent]));
    for (const task of desired.values()) {
      const previous = world.tasks.find((candidate) => candidate.id === task.id);
      const previousAssignee = previous?.assignedTo ? agentsById.get(previous.assignedTo) : undefined;
      const assignedTo = previousAssignee?.taskId === task.id ? previousAssignee.id : null;
      if (assignedTo && activeAssignments.has(assignedTo)) continue;
      if (assignedTo) activeAssignments.add(assignedTo);
      next.push({ ...task, assignedTo, createdAt: previous?.createdAt ?? now });
    }
    world.tasks = next;
    for (const agent of world.agents) {
      if (agent.taskId && !world.tasks.some((task) => task.id === agent.taskId && task.assignedTo === agent.id)) {
        agent.taskId = null;
        agent.targetId = null;
        if (agent.mode !== 'returning' && agent.mode !== 'fleeing') agent.mode = 'idle';
      }
    }
  }

  private assignTask(world: PersistentWorld, agent: AgentState, now: number): void {
    const task = world.tasks
      .filter((candidate) => !candidate.assignedTo && this.roleCanDo(agent.role, candidate.kind))
      .sort((a, b) => this.utility(agent.role, b) - this.utility(agent.role, a))[0];
    if (!task) {
      agent.mode = 'idle';
      agent.taskId = null;
      agent.targetId = null;
      const runtime = this.getRuntime(agent);
      runtime.idleUntil = now + 900 + Math.random() * 1600;
      return;
    }
    task.assignedTo = agent.id;
    agent.taskId = task.id;
    agent.targetId = task.targetId;
    agent.mode = this.modeForTask(task.kind);
    const runtime = this.getRuntime(agent);
    runtime.path = [];
    runtime.waypoint = 0;
    runtime.pathKey = '';
  }

  private performTask(world: PersistentWorld, agent: AgentState, task: ColonyTask, runtime: AgentRuntime, dt: number, now: number): void {
    const goal: Vec3 = { x: task.x, z: task.z, y: agent.isUnderground ? -7.5 : terrainHeight(task.x, task.z) };
    const undergroundGoal = task.kind === 'care' || task.kind === 'excavate';

    if (task.kind === 'forage') {
      const node = world.resources.find((candidate) => candidate.id === task.targetId);
      if (!node || node.amount < 1) {
        this.finishTask(world, agent, task, now);
        return;
      }
      goal.x = node.pos.x;
      goal.z = node.pos.z;
      goal.y = node.pos.y;
    }
    if (task.kind === 'defend') {
      const predator = world.predators.find((candidate) => candidate.id === task.targetId && candidate.health > 0);
      if (!predator) {
        this.finishTask(world, agent, task, now);
        return;
      }
      goal.x = predator.pos.x;
      goal.z = predator.pos.z;
    }

    const speed = agent.role === 'scout' ? 4.1 : agent.role === 'worker' ? 3.4 : agent.role === 'soldier' ? 3.8 : 2.5;
    const forageNode = task.kind === 'forage' ? world.resources.find((candidate) => candidate.id === task.targetId) : undefined;
    const scentType = forageNode?.kind === 'dew' ? 'home' : 'food';
    const attraction = forageNode && !agent.isUnderground && flatDistance(agent.pos, goal) < 22
      ? pheromoneAttraction(world, agent.pos.x, agent.pos.z, scentType)
      : null;
    const reached = this.moveTowards(agent, goal, undergroundGoal, speed, dt, now, runtime, attraction);
    if (!reached) {
      if (agent.mode === 'foraging' && !agent.isUnderground && now % 900 < dt * 1000) depositPheromone(world, agent.pos.x, agent.pos.z, 'food', 0.035);
      if (agent.mode === 'exploring' && !agent.isUnderground && now % 1700 < dt * 1000) depositPheromone(world, agent.pos.x, agent.pos.z, 'explore', 0.04);
      return;
    }

    if (task.kind === 'forage') {
      const node = world.resources.find((candidate) => candidate.id === task.targetId);
      if (!node || node.amount < 1) {
        this.finishTask(world, agent, task, now);
        return;
      }
      const amount = Math.min(5, Math.floor(node.amount));
      if (amount <= 0) return;
      node.amount -= amount;
      node.respawnAt = node.amount <= 0 ? now + 90_000 : 0;
      agent.carrying = node.kind;
      agent.carryAmount = amount;
      if (!world.discoveries.some((discovery) => discovery.id === `resource-${node.id}`)) {
        world.discoveries.push({ id: `resource-${node.id}`, label: resourceLabel(node.kind), kind: 'resource', x: node.pos.x, z: node.pos.z, discoveredAt: now });
        world.events.push(makeEvent(now, 'discovery', `Exploradoras encontraram ${resourceLabel(node.kind).toLowerCase()}.`));
      }
      depositPheromone(world, node.pos.x, node.pos.z, node.kind === 'dew' ? 'home' : 'food', 0.5);
      this.finishTask(world, agent, task, now);
      agent.mode = 'returning';
      agent.taskId = null;
      agent.targetId = null;
      return;
    }

    if (task.kind === 'explore') {
      const regionId = `region-${task.targetId}`;
      if (!world.discoveries.some((discovery) => discovery.id === regionId)) {
        const names: Record<string, string> = {
          'meadow-north': 'Prado do norte', 'stone-garden': 'Jardim de pedras', 'old-oak': 'Carvalho antigo',
          'fallen-log': 'Tronco caído', 'pond-edge': 'Margem úmida', 'sunny-rise': 'Elevação ensolarada',
        };
        world.discoveries.push({ id: regionId, label: names[String(task.targetId)] ?? 'Nova região', kind: 'region', x: task.x, z: task.z, discoveredAt: now });
        world.events.push(makeEvent(now, 'discovery', `Nova região mapeada: ${names[String(task.targetId)] ?? 'área desconhecida'}.`));
      }
      depositPheromone(world, agent.pos.x, agent.pos.z, 'explore', 0.48);
      this.finishTask(world, agent, task, now);
      return;
    }

    if (task.kind === 'defend') {
      const predator = world.predators.find((candidate) => candidate.id === task.targetId);
      if (predator) {
        predator.health -= agent.role === 'soldier' ? 7 : 2;
        agent.yaw = Math.atan2(predator.pos.x - agent.pos.x, predator.pos.z - agent.pos.z);
        depositPheromone(world, agent.pos.x, agent.pos.z, 'defence', 0.22);
        if (predator.health <= 0) {
          world.predators = world.predators.filter((candidate) => candidate.id !== predator.id);
          world.colony.food += predator.kind === 'beetle' ? 8 : 4;
          const message = `A colônia expulsou um ${predator.kind === 'spider' ? 'aracnídeo' : 'besouro'} da área.`;
          world.colony.lastEvent = message;
          world.events.push(makeEvent(now, 'threat', message));
          this.finishTask(world, agent, task, now);
        }
      }
      return;
    }

    if (task.kind === 'excavate') {
      if (world.colony.soil >= 8 && world.structures.length < 24) {
        world.colony.soil -= 8;
        world.structures.push({
          id: `npc-chamber-${now.toString(36)}`, kind: 'chamber', pos: { x: task.x, y: -7.5, z: task.z },
          rotation: 0, createdAt: now, createdBy: agent.id, level: 1,
        });
        world.colony.storageCapacity = Math.min(260, world.colony.storageCapacity + 14);
        const message = 'Escavadoras ampliaram uma câmara do formigueiro.';
        world.colony.lastEvent = message;
        world.events.push(makeEvent(now, 'build', message));
      }
      this.finishTask(world, agent, task, now);
      return;
    }

    if (task.kind === 'care') {
      agent.mode = 'caring';
      runtime.actionAt = now;
      task.assignedTo = agent.id;
      return;
    }

    if (task.kind === 'patrol') {
      this.finishTask(world, agent, task, now);
    }
  }

  private returnToNest(world: PersistentWorld, agent: AgentState, runtime: AgentRuntime, dt: number, now: number): void {
    const nestGoal = { x: 0, y: -7.5, z: 0 };
    const reached = this.moveTowards(agent, nestGoal, true, agent.role === 'scout' ? 4.1 : 3.1, dt, now, runtime);
    if (!reached) {
      if (!agent.isUnderground && now % 900 < dt * 1000) depositPheromone(world, agent.pos.x, agent.pos.z, 'home', 0.055);
      return;
    }
    if (agent.carrying && agent.carryAmount > 0) {
      this.depositResources(world, agent.carrying, agent.carryAmount);
      agent.carrying = null;
      agent.carryAmount = 0;
    }
    agent.mode = 'idle';
    agent.taskId = null;
    agent.targetId = null;
    runtime.path = [];
    runtime.idleUntil = now + 500 + Math.random() * 1200;
    depositPheromone(world, 0, 0, 'home', 0.28);
  }

  private depositResources(world: PersistentWorld, kind: ResourceKind, amount: number): void {
    if (FOOD_KINDS.has(kind)) world.colony.food = Math.min(world.colony.storageCapacity, world.colony.food + amount);
    else if (kind === 'dew') world.colony.water = Math.min(world.colony.storageCapacity, world.colony.water + amount);
    else if (kind === 'soil') world.colony.soil = Math.min(180, world.colony.soil + amount);
    else world.colony.leaves = Math.min(120, world.colony.leaves + amount);
  }

  private moveTowards(agent: AgentState, goal: Vec3, undergroundGoal: boolean, speed: number, dt: number, now: number, runtime: AgentRuntime, attraction: { x: number; z: number } | null = null): boolean {
    const targetKey = `${Math.round(goal.x * 2)}:${Math.round(goal.z * 2)}:${undergroundGoal ? 1 : 0}`;
    if (agent.isUnderground !== undergroundGoal) {
      const entrance = { x: 0, z: 0 };
      const distanceToExit = flatDistance(agent.pos, entrance);
      if (agent.isUnderground) {
        if (distanceToExit <= 1.25) {
          agent.isUnderground = false;
          agent.pos.x = 0;
          agent.pos.z = 0;
          agent.pos.y = terrainHeight(0, 0);
          runtime.pathKey = '';
          runtime.path = [];
        } else {
          this.stepToward(agent, entrance.x, entrance.z, speed * dt, true);
          return false;
        }
      } else if (distanceToExit <= 2.6) {
        agent.isUnderground = true;
        agent.pos.x = 0;
        agent.pos.z = 0;
        agent.pos.y = -7.5;
        runtime.pathKey = '';
        runtime.path = [];
      } else {
        this.stepToward(agent, entrance.x, entrance.z, speed * dt, false);
        return false;
      }
    }

    const distance = flatDistance(agent.pos, goal);
    const stoppingDistance = undergroundGoal ? 0.75 : 1.15;
    if (distance <= stoppingDistance) {
      agent.pos.x = goal.x;
      agent.pos.z = goal.z;
      agent.pos.y = undergroundGoal ? -7.5 : terrainHeight(goal.x, goal.z);
      return true;
    }

    if (runtime.pathKey !== targetKey || now >= runtime.nextRepathAt || runtime.waypoint >= runtime.path.length) {
      runtime.path = undergroundGoal ? [{ x: goal.x, z: goal.z }] : this.navigation.findPath(agent.pos, goal);
      runtime.waypoint = 0;
      runtime.pathKey = targetKey;
      runtime.nextRepathAt = now + 4_000;
    }

    while (runtime.waypoint < runtime.path.length) {
      const waypoint = runtime.path[runtime.waypoint];
      if (flatDistance(agent.pos, waypoint) < 1.05) runtime.waypoint += 1;
      else break;
    }
    const waypoint = runtime.path[Math.min(runtime.waypoint, runtime.path.length - 1)] ?? goal;
    const dx = waypoint.x - agent.pos.x + (attraction?.x ?? 0) * 0.55;
    const dz = waypoint.z - agent.pos.z + (attraction?.z ?? 0) * 0.55;
    const length = Math.hypot(dx, dz) || 1;
    const step = Math.min(speed * dt, length);
    agent.pos.x += (dx / length) * step;
    agent.pos.z += (dz / length) * step;
    agent.yaw = Math.atan2(dx, dz);
    agent.pos.y = undergroundGoal ? -7.5 : terrainHeight(agent.pos.x, agent.pos.z);
    return flatDistance(agent.pos, goal) <= stoppingDistance;
  }

  private stepToward(agent: AgentState, x: number, z: number, step: number, underground: boolean): void {
    const dx = x - agent.pos.x;
    const dz = z - agent.pos.z;
    const length = Math.hypot(dx, dz) || 1;
    agent.pos.x += dx / length * Math.min(step, length);
    agent.pos.z += dz / length * Math.min(step, length);
    agent.yaw = Math.atan2(dx, dz);
    agent.pos.y = underground ? -7.5 : terrainHeight(agent.pos.x, agent.pos.z);
  }

  private avoidThreats(world: PersistentWorld, agent: AgentState, runtime: AgentRuntime, dt: number, now: number): void {
    if (agent.role === 'soldier' || agent.mode === 'returning') return;
    const nearest = world.predators
      .filter((predator) => predator.health > 0)
      .sort((a, b) => flatDistance(a.pos, agent.pos) - flatDistance(b.pos, agent.pos))[0];
    const distance = nearest ? flatDistance(nearest.pos, agent.pos) : Infinity;
    if (agent.mode !== 'fleeing' && distance >= 3.2) return;
    if (agent.mode === 'fleeing' && (!nearest || distance > 12)) {
      agent.mode = 'idle';
      runtime.idleUntil = now + 1200;
      runtime.path = [];
      return;
    }
    if (!nearest) return;
    depositPheromone(world, agent.pos.x, agent.pos.z, 'danger', 0.5);
    agent.mode = 'fleeing';
    agent.taskId = null;
    agent.targetId = null;
    const dangerX = agent.pos.x - nearest.pos.x;
    const dangerZ = agent.pos.z - nearest.pos.z;
    const length = Math.hypot(dangerX, dangerZ) || 1;
    const fleePoint = { x: Math.max(-70, Math.min(70, agent.pos.x + dangerX / length * 8)), z: Math.max(-70, Math.min(70, agent.pos.z + dangerZ / length * 8)) };
    const reached = this.moveTowards(agent, { ...fleePoint, y: terrainHeight(fleePoint.x, fleePoint.z) }, false, 4, dt, now, runtime);
    if (reached || distance > 12) {
      agent.mode = 'idle';
      runtime.idleUntil = now + 1200;
      runtime.path = [];
    }
  }

  private finishTask(world: PersistentWorld, agent: AgentState, task: ColonyTask, now: number): void {
    task.assignedTo = null;
    world.tasks = world.tasks.filter((candidate) => candidate.id !== task.id);
    agent.taskId = null;
    agent.targetId = null;
    if (agent.mode !== 'returning') agent.mode = 'idle';
    this.getRuntime(agent).idleUntil = now + 350;
  }

  private releaseTask(world: PersistentWorld, agent: AgentState): void {
    if (agent.taskId) {
      const task = world.tasks.find((candidate) => candidate.id === agent.taskId);
      if (task?.assignedTo === agent.id) task.assignedTo = null;
    }
    agent.taskId = null;
    agent.targetId = null;
    if (agent.mode !== 'returning' && agent.mode !== 'fleeing') agent.mode = 'idle';
  }

  private roleCanDo(role: AgentRole, kind: ColonyTaskKind): boolean {
    if (role === 'worker') return kind === 'forage';
    if (role === 'scout') return kind === 'explore' || kind === 'forage';
    if (role === 'soldier') return kind === 'defend' || kind === 'patrol';
    if (role === 'nurse') return kind === 'care';
    return kind === 'excavate';
  }

  private utility(role: AgentRole, task: ColonyTask): number {
    const roleBonus = (role === 'scout' && task.kind === 'explore') || (role === 'soldier' && task.kind === 'defend') ? 6 : 0;
    return task.priority + roleBonus;
  }

  private modeForTask(kind: ColonyTaskKind): AgentState['mode'] {
    if (kind === 'forage') return 'foraging';
    if (kind === 'explore') return 'exploring';
    if (kind === 'defend' || kind === 'patrol') return 'patrolling';
    if (kind === 'care') return 'idle';
    return 'digging';
  }

  private getRuntime(agent: AgentState): AgentRuntime {
    let runtime = this.runtime.get(agent.id);
    if (!runtime) {
      runtime = { path: [], waypoint: 0, pathKey: '', nextRepathAt: 0, actionAt: 0, idleUntil: 0, lastUpdatedAt: 0 };
      this.runtime.set(agent.id, runtime);
    }
    return runtime;
  }
}

function resourceLabel(kind: ResourceKind): string {
  const labels: Record<ResourceKind, string> = {
    seed: 'sementes', berry: 'frutas', sugar: 'néctar', dew: 'gotas de orvalho',
    soil: 'terra fértil', leaf: 'folhas', mushroom: 'cogumelos',
  };
  return labels[kind];
}

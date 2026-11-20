import * as THREE from 'three';
import type { AgentRole, AgentState, GameAction, GameSnapshot, PlayerState, ServerMessage, WorldTime } from '../../../shared/src/types.js';
import { flatDistance, terrainHeight } from '../../../shared/src/world.js';
import { GameSocket } from '../network/GameSocket.js';
import { GameUI } from '../ui/GameUI.js';
import { AntRig } from './AntRig.js';
import { AudioEngine } from './AudioEngine.js';
import { Environment } from './Environment.js';
import { PredatorRig } from './PredatorRig.js';

interface AntVisual {
  rig: AntRig;
  target: THREE.Vector3;
  targetYaw: number;
  moving: boolean;
  carrying: boolean;
  underground: boolean;
  initialized: boolean;
}

interface PredatorVisual {
  rig: PredatorRig;
  target: THREE.Vector3;
  yaw: number;
}

const DEFAULT_WORLD_TIME: WorldTime = { seconds: 120, dayLength: 720, weather: 'clear', weatherSecondsLeft: 120, flood: 0, seasonDay: 1 };

export class Game {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(65, 1, 0.08, 240);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly environment: Environment;
  private readonly entities = new Map<string, AntVisual>();
  private readonly predatorVisuals = new Map<string, PredatorVisual>();
  private readonly keys = new Set<string>();
  private readonly clock = new THREE.Clock();
  private readonly socket: GameSocket;
  private readonly ui: GameUI;
  private readonly audio: AudioEngine;
  private currentSnapshot: GameSnapshot | null = null;
  private selfId = '';
  private self: PlayerState | null = null;
  private cameraMode: 'first' | 'third' | 'top' = 'third';
  private cameraYaw = 0.2;
  private cameraPitch = 0.39;
  private cameraDistance = 6.7;
  private topZoom = 26;
  private sequence = 0;
  private lastInputSentAt = 0;
  private lastInteractionHint = '';
  private lastPheromoneSync = 0;
  private lastUnderground = false;
  private raf = 0;
  private quality: 'low' | 'medium' | 'high' = 'high';
  private fpsFrames = 0;
  private fpsMark = 0;
  private disposed = false;
  private readonly onResize = (): void => this.resize();
  private readonly host: HTMLElement;

  constructor(host: HTMLElement, socket: GameSocket, ui: GameUI, audio: AudioEngine) {
    this.host = host;
    this.socket = socket;
    this.ui = ui;
    this.audio = audio;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance', stencil: false, depth: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'world-canvas';
    this.renderer.domElement.setAttribute('aria-label', 'Mundo 3D de ANT LIFE. Use WASD para caminhar.');
    this.host.replaceChildren(this.renderer.domElement);
    this.environment = new Environment(this.scene, 187_301);
    this.camera.position.set(-13, 8.6, -14);
    this.camera.lookAt(0, 0, 0);
    this.quality = this.readQuality();
    this.setQuality(this.quality);
    this.bindInput();
    this.socket.onMessage((message) => this.handleServerMessage(message));
    this.fpsMark = performance.now();
    this.raf = requestAnimationFrame((time) => this.frame(time));
  }

  setQuality(quality: 'low' | 'medium' | 'high'): void {
    this.quality = quality;
    const pixelRatio = quality === 'high' ? 1.6 : quality === 'medium' ? 1.25 : 0.92;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatio));
    this.renderer.shadowMap.enabled = quality !== 'low';
    this.renderer.shadowMap.type = quality === 'high' ? THREE.PCFSoftShadowMap : THREE.BasicShadowMap;
    this.environment?.setQuality(quality);
    this.resize();
  }

  setCamera(mode: 'first' | 'third' | 'top'): void {
    this.cameraMode = mode;
    if (this.cameraMode === 'first') this.camera.fov = 83;
    else this.camera.fov = mode === 'top' ? 58 : 65;
    this.camera.updateProjectionMatrix();
    this.ui.setCamera(mode);
  }

  perform(action: GameAction): void {
    this.socket.sendAction(action);
  }

  focusWorld(): void {
    void this.audio.start();
    if (document.pointerLockElement !== this.renderer.domElement && this.selfId) {
      void this.renderer.domElement.requestPointerLock?.();
    }
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('blur', this.onBlur);
    this.renderer.domElement.removeEventListener('click', this.onCanvasClick);
    this.renderer.domElement.removeEventListener('wheel', this.onWheel);
    this.renderer.domElement.removeEventListener('contextmenu', this.onContextMenu);
    for (const entity of this.entities.values()) entity.rig.dispose();
    this.environment.dispose();
    this.audio.dispose();
    this.renderer.dispose();
  }

  private bindInput(): void {
    window.addEventListener('resize', this.onResize);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    window.addEventListener('blur', this.onBlur);
    this.renderer.domElement.addEventListener('click', this.onCanvasClick);
    this.renderer.domElement.addEventListener('wheel', this.onWheel, { passive: false });
    this.renderer.domElement.addEventListener('contextmenu', this.onContextMenu);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (isTypingTarget(event.target)) return;
    if (event.code === 'Space' || event.code === 'Tab') event.preventDefault();
    this.keys.add(event.code);
    if (event.repeat) return;
    if (event.code === 'KeyE') this.perform({ type: 'interact' });
    else if (event.code === 'KeyQ') this.perform({ type: 'attack' });
    else if (event.code === 'KeyR') this.perform({ type: 'eat' });
    else if (event.code === 'KeyV') this.perform({ type: 'drink' });
    else if (event.code === 'KeyB') this.toggleBuild();
    else if (event.code === 'KeyM') this.toggleMap();
    else if (event.code === 'Tab') this.ui.setPanel('inventory', true);
    else if (event.code === 'KeyC') this.cycleCamera();
    else if (event.code === 'Digit1') this.setCamera('first');
    else if (event.code === 'Digit2') this.setCamera('third');
    else if (event.code === 'Digit3') this.setCamera('top');
    else if (event.code === 'Escape') this.handleEscape();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => { this.keys.delete(event.code); };
  private readonly onBlur = (): void => { this.keys.clear(); };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (document.pointerLockElement !== this.renderer.domElement || !this.selfId) return;
    const sensitivity = 0.00215;
    this.cameraYaw -= event.movementX * sensitivity;
    this.cameraPitch = THREE.MathUtils.clamp(this.cameraPitch - event.movementY * sensitivity, 0.08, 1.18);
  };

  private readonly onCanvasClick = (): void => {
    if (!this.selfId || this.ui.isModalOpen() || this.ui.isPanelOpen() || this.ui.isBuildOpen()) return;
    void this.audio.start();
    void this.renderer.domElement.requestPointerLock?.();
  };

  private readonly onPointerLockChange = (): void => {
    const captured = document.pointerLockElement === this.renderer.domElement;
    const hint = document.querySelector<HTMLElement>('#first-person-hint');
    hint?.classList.toggle('visible', this.cameraMode === 'first' && !captured && Boolean(this.selfId));
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.selfId) return;
    event.preventDefault();
    if (this.cameraMode === 'top') this.topZoom = THREE.MathUtils.clamp(this.topZoom + event.deltaY * 0.025, 10, 52);
    else this.cameraDistance = THREE.MathUtils.clamp(this.cameraDistance + event.deltaY * 0.006, 3.0, 12.5);
  };

  private readonly onContextMenu = (event: Event): void => event.preventDefault();

  private handleEscape(): void {
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
    if (this.ui.isModalOpen()) this.ui.toggleSettings(false);
    else if (this.ui.isBuildOpen()) this.ui.toggleBuild(false);
    else if (this.ui.isPanelOpen()) this.ui.setPanel('colony', false);
    else this.ui.toggleSettings(true);
  }

  private toggleBuild(): void {
    this.ui.toggleBuild();
    if (this.ui.isBuildOpen() && document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
  }

  private toggleMap(): void {
    if (this.ui.isPanelOpen()) this.ui.setPanel('map', false);
    else this.ui.setPanel('map', true);
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
  }

  private cycleCamera(): void {
    const modes: Array<'first' | 'third' | 'top'> = ['first', 'third', 'top'];
    this.setCamera(modes[(modes.indexOf(this.cameraMode) + 1) % modes.length]);
  }

  private handleServerMessage(message: ServerMessage): void {
    if (message.type === 'joined') {
      this.selfId = message.selfId;
      this.applySnapshot(message.snapshot);
      this.cameraYaw = this.self?.yaw ?? this.cameraYaw;
      this.ui.enterGame(message.selfId, message.resumed);
      void this.audio.start().then(() => this.audio.setWeather(message.snapshot.worldTime.weather));
      return;
    }
    if (message.type === 'snapshot') {
      this.applySnapshot(message.snapshot);
      return;
    }
    if (message.type === 'notice') {
      this.ui.showToast(message.message, message.tone);
      if (message.message.includes('Coletou')) this.audio.play('collect');
      else if (message.message.includes('constru')) this.audio.play('build');
      else if (message.message.includes('atacou') || message.message.includes('mordeu')) this.audio.play('hurt');
      else if (message.message.includes('entrou') || message.message.includes('emergiu')) this.audio.play('enter');
      return;
    }
    if (message.type === 'event') {
      if (message.event.kind === 'threat' || message.event.kind === 'weather') this.audio.play('alert');
      if (message.event.kind === 'build') this.audio.play('build');
      if (message.event.kind === 'discovery') this.audio.play('collect');
      this.ui.showToast(message.event.message, message.event.kind === 'threat' ? 'warning' : 'info');
    }
  }

  private applySnapshot(snapshot: GameSnapshot): void {
    this.currentSnapshot = snapshot;
    this.environment.setSeed(snapshot.seed);
    this.environment.syncResources(snapshot.resources);
    this.environment.syncStructures(snapshot.structures);
    if (performance.now() - this.lastPheromoneSync > 420) {
      this.environment.syncPheromones(snapshot.pheromones);
      this.lastPheromoneSync = performance.now();
    }
    this.self = snapshot.players.find((player) => player.id === this.selfId) ?? null;
    if (this.self) {
      this.environment.setUnderground(this.self.isUnderground);
      if (this.self.isUnderground !== this.lastUnderground) {
        this.lastUnderground = this.self.isUnderground;
        this.camera.position.y = this.self.pos.y + 3.4;
      }
    }
    this.syncAnts(snapshot);
    this.syncPredators(snapshot);
    this.ui.render(snapshot, this.selfId);
    this.audio.setWeather(snapshot.worldTime.weather);
  }

  private syncAnts(snapshot: GameSnapshot): void {
    const seen = new Set<string>();
    for (const player of snapshot.players) {
      const key = `player:${player.id}`;
      seen.add(key);
      const visual = this.getAnt(key, 'worker', 1.05, player.color);
      this.setVisual(visual, player.pos, player.yaw, player.id === this.selfId ? player.isUnderground : player.isUnderground, inventoryTotal(player) > 0);
    }
    for (const agent of snapshot.agents) {
      const key = `agent:${agent.id}`;
      seen.add(key);
      const visual = this.getAnt(key, agent.role, 0.86);
      this.setVisual(visual, agent.pos, agent.yaw, agent.isUnderground, agent.carryAmount > 0);
    }
    for (const [key, visual] of this.entities) {
      if (seen.has(key)) continue;
      this.scene.remove(visual.rig.group);
      visual.rig.dispose();
      this.entities.delete(key);
    }
  }

  private getAnt(key: string, role: AgentRole, scale: number, color?: string): AntVisual {
    let visual = this.entities.get(key);
    if (!visual) {
      const rig = new AntRig(role, scale, color, key);
      this.scene.add(rig.group);
      visual = { rig, target: new THREE.Vector3(), targetYaw: 0, moving: false, carrying: false, underground: false, initialized: false };
      this.entities.set(key, visual);
    }
    return visual;
  }

  private setVisual(visual: AntVisual, pos: PlayerState['pos'] | AgentState['pos'], yaw: number, underground: boolean, carrying: boolean): void {
    const next = new THREE.Vector3(pos.x, pos.y, pos.z);
    if (visual.initialized) visual.moving = next.distanceTo(visual.target) > 0.07;
    else {
      visual.rig.group.position.copy(next);
      visual.initialized = true;
    }
    visual.target.copy(next);
    visual.targetYaw = yaw;
    visual.underground = underground;
    visual.carrying = carrying;
  }

  private syncPredators(snapshot: GameSnapshot): void {
    const seen = new Set<string>();
    for (const predator of snapshot.predators) {
      seen.add(predator.id);
      let visual = this.predatorVisuals.get(predator.id);
      if (!visual) {
        const rig = new PredatorRig(predator.kind);
        this.scene.add(rig.group);
        visual = { rig, target: new THREE.Vector3(predator.pos.x, predator.pos.y, predator.pos.z), yaw: predator.yaw };
        this.predatorVisuals.set(predator.id, visual);
      }
      visual.target.set(predator.pos.x, predator.pos.y, predator.pos.z);
      visual.yaw = predator.yaw;
      visual.rig.group.visible = !this.self?.isUnderground;
    }
    for (const [id, visual] of this.predatorVisuals) {
      if (seen.has(id)) continue;
      this.scene.remove(visual.rig.group);
      this.predatorVisuals.delete(id);
    }
  }

  private frame(now: number): void {
    if (this.disposed) return;
    this.raf = requestAnimationFrame((time) => this.frame(time));
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;
    this.sendInput(now);
    const snapshot = this.currentSnapshot;
    const worldTime = snapshot?.worldTime ?? DEFAULT_WORLD_TIME;
    this.environment.update(elapsed, worldTime);
    if (!this.self) this.updatePreviewCamera(elapsed);
    else this.updateCamera(dt);
    this.updateEntities(dt, elapsed);
    this.updatePredatorVisuals(dt, elapsed);
    this.updateInteractionHint();
    this.renderer.render(this.scene, this.camera);
    this.measureFps(now);
  }

  private sendInput(now: number): void {
    if (!this.selfId || !this.self || now - this.lastInputSentAt < 48) return;
    this.lastInputSentAt = now;
    const blocked = this.ui.isModalOpen() || this.ui.isPanelOpen() || this.ui.isBuildOpen();
    let x = 0;
    let z = 0;
    if (!blocked) {
      x = Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA'));
      z = Number(this.keys.has('KeyS')) - Number(this.keys.has('KeyW'));
    }
    const run = !blocked && this.keys.has('ShiftLeft');
    const jump = !blocked && this.keys.has('Space');
    this.socket.sendMove(++this.sequence, x, z, this.cameraYaw, run, jump);
  }

  private updateCamera(dt: number): void {
    const self = this.self;
    if (!self) return;
    const visual = this.entities.get(`player:${self.id}`);
    const position = visual?.rig.group.position ?? new THREE.Vector3(self.pos.x, self.pos.y, self.pos.z);
    const lookAt = new THREE.Vector3(position.x, position.y + (self.isUnderground ? 0.38 : 0.48), position.z);
    if (this.cameraMode === 'first') {
      const cp = Math.cos(this.cameraPitch * 0.45);
      const sp = Math.sin(this.cameraPitch * 0.45);
      this.camera.position.set(position.x, position.y + 0.66, position.z);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(position.x + Math.sin(this.cameraYaw) * cp, position.y + 0.66 + sp, position.z + Math.cos(this.cameraYaw) * cp);
      return;
    }
    if (this.cameraMode === 'top') {
      this.camera.position.set(position.x, position.y + this.topZoom, position.z);
      this.camera.up.set(-Math.sin(this.cameraYaw), 0, -Math.cos(this.cameraYaw));
      this.camera.lookAt(lookAt);
      return;
    }
    this.camera.up.set(0, 1, 0);
    const horizontal = this.cameraDistance * Math.cos(this.cameraPitch);
    const desired = new THREE.Vector3(
      lookAt.x - Math.sin(this.cameraYaw) * horizontal,
      lookAt.y + this.cameraDistance * Math.sin(this.cameraPitch),
      lookAt.z - Math.cos(this.cameraYaw) * horizontal,
    );
    if (!self.isUnderground) this.environment.resolveCameraPosition(lookAt, desired);
    const blend = 1 - Math.exp(-dt * 10);
    this.camera.position.lerp(desired, blend);
    this.camera.lookAt(lookAt);
  }

  private updatePreviewCamera(time: number): void {
    this.camera.up.set(0, 1, 0);
    const angle = time * 0.055 + 0.18;
    const target = new THREE.Vector3(0, 0.2, 0);
    const desired = new THREE.Vector3(Math.sin(angle) * 19, 8.4 + Math.sin(time * 0.16) * 0.8, Math.cos(angle) * 19);
    this.camera.position.lerp(desired, 0.018);
    this.camera.lookAt(target);
  }

  private updateEntities(dt: number, time: number): void {
    const blend = 1 - Math.exp(-dt * 13);
    for (const [key, visual] of this.entities) {
      const isPlayer = key.startsWith('player:');
      const visible = visual.underground === Boolean(this.self?.isUnderground);
      visual.rig.setVisible(visible && !(isPlayer && key === `player:${this.selfId}` && this.cameraMode === 'first'));
      visual.rig.group.position.lerp(visual.target, blend);
      visual.rig.group.rotation.y = dampAngle(visual.rig.group.rotation.y, visual.targetYaw, blend);
      visual.rig.animate(time, visual.moving, visual.carrying);
    }
  }

  private updatePredatorVisuals(dt: number, time: number): void {
    const blend = 1 - Math.exp(-dt * 10);
    for (const visual of this.predatorVisuals.values()) {
      visual.rig.group.position.lerp(visual.target, blend);
      visual.rig.group.rotation.y = dampAngle(visual.rig.group.rotation.y, visual.yaw, blend);
      visual.rig.animate(time, 0.3);
    }
  }

  private updateInteractionHint(): void {
    if (!this.self || !this.currentSnapshot) return;
    const self = this.self;
    const distanceToNest = flatDistance(self.pos, { x: 0, z: 0 });
    let hint = 'Aproxime-se de um recurso';
    let active = false;
    if (self.isUnderground) {
      if (distanceToNest < 3.2) { hint = 'Sair pela entrada do formigueiro'; active = true; }
      else if (inventoryTotal(self) > 0) { hint = 'Guardar recursos na colônia'; active = true; }
      else { hint = 'Explore as câmaras · B para construir'; }
    } else {
      const node = this.currentSnapshot.resources
        .filter((resource) => resource.amount >= 1)
        .sort((a, b) => flatDistance(a.pos, self.pos) - flatDistance(b.pos, self.pos))[0];
      if (node && flatDistance(node.pos, self.pos) < 2.8) {
        hint = `Coletar ${resourceLabel(node.kind)}`;
        active = true;
      } else if (distanceToNest < 3.2) {
        hint = 'Entrar no formigueiro';
        active = true;
      } else if (Math.hypot(self.pos.x - 22, self.pos.z + 22) < 8.2 && self.thirst < 90) {
        hint = 'Beber da poça';
        active = true;
      } else if (inventoryTotal(self) >= 8) hint = 'Mochila cheia · volte à colônia';
    }
    if (hint !== this.lastInteractionHint) {
      this.ui.setInteractionHint(hint, active);
      this.lastInteractionHint = hint;
    }
  }

  private measureFps(now: number): void {
    this.fpsFrames += 1;
    if (now - this.fpsMark < 2500) return;
    const fps = Math.round(this.fpsFrames * 1000 / (now - this.fpsMark));
    document.documentElement.dataset.fps = String(fps);
    this.fpsFrames = 0;
    this.fpsMark = now;
  }

  private resize(): void {
    if (!this.renderer) return;
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private readQuality(): 'low' | 'medium' | 'high' {
    const value = localStorage.getItem('ant-life-quality');
    return value === 'low' || value === 'medium' ? value : 'high';
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

function dampAngle(current: number, target: number, blend: number): number {
  const difference = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + difference * blend;
}

function inventoryTotal(player: PlayerState): number { return Object.values(player.inventory).reduce((sum, amount) => sum + amount, 0); }

function resourceLabel(kind: keyof PlayerState['inventory']): string {
  return { seed: 'sementes', berry: 'frutas', sugar: 'néctar', dew: 'orvalho', soil: 'terra', leaf: 'folhas', mushroom: 'cogumelos' }[kind];
}

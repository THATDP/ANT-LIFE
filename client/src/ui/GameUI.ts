import type { BuildKind, ColonyTask, GameAction, GameSnapshot, PlayerState, ResourceKind } from '../../../shared/src/types.js';
import { flatDistance } from '../../../shared/src/world.js';

const RESOURCE_INFO: Record<ResourceKind, { title: string; icon: string; color: string }> = {
  seed: { title: 'Sementes', icon: '✳', color: '#e0c184' }, berry: { title: 'Frutas', icon: '●', color: '#e77986' },
  sugar: { title: 'Néctar', icon: '✦', color: '#f2cf78' }, dew: { title: 'Orvalho', icon: '◈', color: '#80cce3' },
  soil: { title: 'Terra', icon: '▰', color: '#b78d62' }, leaf: { title: 'Folhas', icon: '❧', color: '#85b780' },
  mushroom: { title: 'Cogumelos', icon: '◉', color: '#dea786' },
};
const ROLE_LABELS = { worker: 'Operárias', soldier: 'Soldados', scout: 'Exploradoras', digger: 'Escavadoras', nurse: 'Cuidadoras' };
const TASK_LABELS: Record<ColonyTask['kind'], string> = { forage: 'Coleta de recursos', explore: 'Exploração', patrol: 'Patrulha', defend: 'Defesa', care: 'Cuidado da prole', excavate: 'Escavação' };

export interface UIHooks {
  join: (nickname: string, inviteCode: string) => void;
  action: (action: GameAction) => void;
  camera: (mode: 'first' | 'third' | 'top') => void;
  panel: (name: string) => void;
  quality: (quality: 'low' | 'medium' | 'high') => void;
  volume: (master: number, ambience: number, effects: number) => void;
  leave: () => void;
}

export class GameUI {
  private readonly root: HTMLElement;
  private readonly hooks: UIHooks;
  private snapshot: GameSnapshot | null = null;
  private selfId = '';
  private activePanel = 'colony';
  private panelOpen = false;
  private mapLastDraw = 0;
  private panelLastRenderAt = 0;
  private toastId = 0;
  private connected = false;

  constructor(root: HTMLElement, hooks: UIHooks) {
    this.root = root;
    this.hooks = hooks;
    this.root.innerHTML = this.markup();
    this.bindEvents();
    this.restorePreferences();
  }

  setConnection(label: string, tone: 'good' | 'waiting' | 'bad'): void {
    const status = this.root.querySelector<HTMLElement>('#login-connection-label');
    const dot = this.root.querySelector<HTMLElement>('#connection-dot');
    const hudStatus = this.root.querySelector<HTMLElement>('#hud-connection-label');
    const hudDot = this.root.querySelector<HTMLElement>('#hud-connection-dot');
    if (status) status.textContent = label;
    if (dot) dot.dataset.state = tone;
    if (hudStatus) hudStatus.textContent = label;
    if (hudDot) hudDot.dataset.state = tone;
    const header = this.root.querySelector<HTMLElement>('#top-connection');
    if (header) header.dataset.state = tone;
  }

  setConnecting(connecting: boolean): void {
    const button = this.root.querySelector<HTMLButtonElement>('#join-button');
    if (button) {
      button.disabled = connecting;
      button.innerHTML = connecting ? '<span class="spinner"></span> Conectando à colônia' : 'Entrar na colônia <span class="button-arrow">↗</span>';
    }
  }

  setLoginMessage(message: string, tone: 'error' | 'success' | 'info' = 'error'): void {
    const element = this.root.querySelector<HTMLElement>('#login-message');
    if (!element) return;
    element.textContent = message;
    element.dataset.tone = tone;
    element.classList.toggle('visible', Boolean(message));
  }

  enterGame(selfId: string, resumed: boolean): void {
    this.selfId = selfId;
    this.connected = true;
    this.root.querySelector('#login-screen')?.classList.add('is-hidden');
    this.root.querySelector('#hud')?.classList.remove('is-hidden');
    this.root.querySelector('#hud-connection-label')!.textContent = 'Conectado';
    this.root.querySelector<HTMLElement>('#hud-connection-dot')!.dataset.state = 'good';
    this.root.querySelector('#top-connection')?.setAttribute('data-state', 'good');
    this.showToast(resumed ? 'Sessão recuperada. Sua colônia continuou crescendo.' : 'A colônia está viva. Boa exploração!', 'success');
  }

  setDisconnected(): void {
    this.connected = false;
    const dot = this.root.querySelector<HTMLElement>('#hud-connection-dot');
    if (dot) dot.dataset.state = 'bad';
    const label = this.root.querySelector<HTMLElement>('#hud-connection-label');
    if (label) label.textContent = 'Reconectando…';
    const top = this.root.querySelector<HTMLElement>('#top-connection');
    if (top) top.dataset.state = 'bad';
  }

  render(snapshot: GameSnapshot, selfId: string): void {
    this.snapshot = snapshot;
    this.selfId = selfId;
    const self = snapshot.players.find((player) => player.id === selfId);
    if (!self) return;
    this.setBar('health', self.health);
    this.setBar('hunger', self.hunger);
    this.setBar('thirst', self.thirst);
    this.setBar('energy', self.energy);
    this.setText('health-value', `${Math.round(self.health)}%`);
    this.setText('hunger-value', `${Math.round(self.hunger)}%`);
    this.setText('thirst-value', `${Math.round(self.thirst)}%`);
    this.setText('energy-value', `${Math.round(self.energy)}%`);
    this.setText('population-value', snapshot.colony.population.toString());
    this.setText('players-value', `${snapshot.players.length} ${snapshot.players.length === 1 ? 'jogador' : 'jogadores'}`);
    this.setText('nest-name', snapshot.colony.name);
    this.setText('nest-region', self.isUnderground ? 'Câmara principal' : this.regionFor(self.pos.x, self.pos.z));
    this.setText('carry-value', `${inventoryCount(self.inventory)}/8`);
    this.setText('resource-food', formatNumber(snapshot.colony.food));
    this.setText('resource-water', formatNumber(snapshot.colony.water));
    this.setText('resource-soil', formatNumber(snapshot.colony.soil));
    this.setText('resource-leaves', formatNumber(snapshot.colony.leaves));
    this.renderClock(snapshot);
    this.renderObjective(snapshot, self);
    this.renderCarrySlots(self.inventory);
    if (this.panelOpen && Date.now() - this.panelLastRenderAt > 450) {
      this.renderPanel();
      this.panelLastRenderAt = Date.now();
    }
    if (Date.now() - this.mapLastDraw > 320) {
      this.drawMap('#mini-map-canvas', snapshot, self);
      if (this.activePanel === 'map') this.drawMap('#colony-map', snapshot, self);
      this.mapLastDraw = Date.now();
    }
    this.root.querySelector('#death-overlay')?.classList.toggle('visible', self.health <= 0);
    this.root.querySelector('#underground-hint')?.classList.toggle('visible', self.isUnderground);
    this.root.querySelector('#build-menu')?.classList.toggle('is-hidden', !this.root.querySelector('#build-menu')?.classList.contains('is-open'));
  }

  setInteractionHint(text: string, enabled: boolean): void {
    const prompt = this.root.querySelector<HTMLElement>('#interaction-prompt');
    if (!prompt) return;
    prompt.innerHTML = `<span class="keycap">E</span><span>${escapeHtml(text)}</span>`;
    prompt.classList.toggle('available', enabled);
  }

  setCamera(mode: 'first' | 'third' | 'top'): void {
    this.root.querySelectorAll<HTMLElement>('[data-camera]').forEach((button) => {
      button.classList.toggle('selected', button.dataset.camera === mode);
    });
    this.setText('camera-label', mode === 'first' ? '1ª pessoa' : mode === 'third' ? '3ª pessoa' : 'Visão de colônia');
    this.root.querySelector('#first-person-antennas')?.classList.toggle('visible', mode === 'first');
    this.root.querySelector('#first-person-hint')?.classList.toggle('visible', mode === 'first');
  }

  setPanel(name: string, open = true): void {
    this.activePanel = name;
    this.panelOpen = open;
    this.root.querySelector('#side-panel')?.classList.toggle('is-open', open);
    this.root.querySelectorAll<HTMLElement>('[data-panel]').forEach((tab) => tab.classList.toggle('selected', tab.dataset.panel === name));
    if (open) {
      this.renderPanel();
      this.panelLastRenderAt = Date.now();
    }
  }

  toggleBuild(open?: boolean): void {
    const menu = this.root.querySelector<HTMLElement>('#build-menu');
    if (!menu) return;
    const next = open ?? !menu.classList.contains('is-open');
    menu.classList.toggle('is-open', next);
    menu.classList.toggle('is-hidden', !next);
  }

  toggleSettings(open?: boolean): void {
    const modal = this.root.querySelector<HTMLElement>('#settings-modal');
    if (!modal) return;
    const next = open ?? !modal.classList.contains('is-open');
    modal.classList.toggle('is-open', next);
    modal.classList.toggle('is-hidden', !next);
  }

  showToast(message: string, tone: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    const stack = this.root.querySelector<HTMLElement>('#toast-stack');
    if (!stack) return;
    const id = ++this.toastId;
    const toast = document.createElement('div');
    toast.className = `toast toast-${tone}`;
    toast.innerHTML = `<span class="toast-mark">${tone === 'success' ? '✓' : tone === 'warning' ? '!' : tone === 'error' ? '×' : '·'}</span><span>${escapeHtml(message)}</span>`;
    toast.dataset.id = id.toString();
    stack.append(toast);
    requestAnimationFrame(() => toast.classList.add('is-visible'));
    window.setTimeout(() => {
      toast.classList.remove('is-visible');
      window.setTimeout(() => toast.remove(), 280);
    }, 4_000);
  }

  isPanelOpen(): boolean { return this.panelOpen; }
  isModalOpen(): boolean { return Boolean(this.root.querySelector('#settings-modal.is-open')); }
  isBuildOpen(): boolean { return Boolean(this.root.querySelector('#build-menu.is-open')); }
  isConnected(): boolean { return this.connected; }

  private bindEvents(): void {
    this.root.querySelector<HTMLFormElement>('#join-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const nickname = this.root.querySelector<HTMLInputElement>('#nickname')?.value.trim() ?? '';
      const inviteCode = this.root.querySelector<HTMLInputElement>('#invite-code')?.value.trim() ?? '';
      this.setLoginMessage('');
      this.hooks.join(nickname, inviteCode);
    });

    this.root.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action], [data-panel], [data-camera], [data-build], [data-quality], [data-close]');
      if (!target) return;
      const action = target.dataset.action;
      if (action) {
        switch (action) {
          case 'interact': this.hooks.action({ type: 'interact' }); break;
          case 'deposit': this.hooks.action({ type: 'deposit' }); break;
          case 'eat': this.hooks.action({ type: 'eat' }); break;
          case 'drink': this.hooks.action({ type: 'drink' }); break;
          case 'rest': this.hooks.action({ type: 'rest' }); break;
          case 'attack': this.hooks.action({ type: 'attack' }); break;
          case 'toggle-panel': this.setPanel(this.activePanel, !this.panelOpen); break;
          case 'toggle-map': this.setPanel('map', true); break;
          case 'toggle-inventory': this.setPanel('inventory', true); break;
          case 'toggle-settings': this.toggleSettings(); break;
          case 'toggle-build': this.toggleBuild(); break;
          case 'close-panel': this.setPanel(this.activePanel, false); break;
          case 'leave': this.hooks.leave(); break;
          case 'copy-invite': void navigator.clipboard?.writeText(window.location.href).then(() => this.showToast('Link copiado. Compartilhe o código privado separadamente.', 'success')).catch(() => this.showToast('Copie o endereço do navegador e envie junto com o código privado.', 'info')); break;
        }
      }
      if (target.dataset.panel) this.setPanel(target.dataset.panel, true);
      if (target.dataset.camera) {
        const mode = target.dataset.camera as 'first' | 'third' | 'top';
        this.hooks.camera(mode);
      }
      if (target.dataset.build) {
        this.hooks.action({ type: 'build', kind: target.dataset.build as BuildKind });
        this.toggleBuild(false);
      }
      if (target.dataset.quality) {
        const quality = target.dataset.quality as 'low' | 'medium' | 'high';
        this.hooks.quality(quality);
        this.root.querySelectorAll('[data-quality]').forEach((button) => button.classList.toggle('selected', (button as HTMLElement).dataset.quality === quality));
        localStorage.setItem('ant-life-quality', quality);
      }
      if (target.hasAttribute('data-close')) {
        this.toggleSettings(false);
        this.toggleBuild(false);
      }
    });

    this.root.querySelectorAll<HTMLInputElement>('[data-volume]').forEach((input) => {
      input.addEventListener('input', () => this.emitVolumes());
    });
    this.root.querySelector('#settings-modal .modal-backdrop')?.addEventListener('click', () => this.toggleSettings(false));
    this.root.querySelector('#side-panel .panel-backdrop')?.addEventListener('click', () => this.setPanel(this.activePanel, false));
    this.root.querySelector<HTMLInputElement>('#invite-code')?.addEventListener('input', (event) => {
      const input = event.currentTarget as HTMLInputElement;
      input.value = input.value.toUpperCase().replace(/\s/g, '');
    });
  }

  private restorePreferences(): void {
    const savedNickname = localStorage.getItem('ant-life-nickname');
    if (savedNickname) this.root.querySelector<HTMLInputElement>('#nickname')!.value = savedNickname;
    if (import.meta.env.DEV) this.root.querySelector<HTMLInputElement>('#invite-code')!.value = 'ANT-LIFE-LOCAL';
    const quality = (localStorage.getItem('ant-life-quality') ?? 'high') as 'low' | 'medium' | 'high';
    this.root.querySelectorAll<HTMLElement>('[data-quality]').forEach((button) => button.classList.toggle('selected', button.dataset.quality === quality));
    const volumes = JSON.parse(localStorage.getItem('ant-life-volume') ?? '{"master":0.42,"ambience":0.55,"effects":0.7}') as { master: number; ambience: number; effects: number };
    for (const [key, value] of Object.entries(volumes)) {
      const slider = this.root.querySelector<HTMLInputElement>(`[data-volume="${key}"]`);
      if (slider) slider.value = String(value);
    }
  }

  private emitVolumes(): void {
    const master = Number(this.root.querySelector<HTMLInputElement>('[data-volume="master"]')?.value ?? 0.42);
    const ambience = Number(this.root.querySelector<HTMLInputElement>('[data-volume="ambience"]')?.value ?? 0.55);
    const effects = Number(this.root.querySelector<HTMLInputElement>('[data-volume="effects"]')?.value ?? 0.7);
    this.hooks.volume(master, ambience, effects);
    localStorage.setItem('ant-life-volume', JSON.stringify({ master, ambience, effects }));
  }

  private renderClock(snapshot: GameSnapshot): void {
    const phase = (snapshot.worldTime.seconds % snapshot.worldTime.dayLength) / snapshot.worldTime.dayLength;
    const hour = Math.floor(phase * 24);
    const minute = Math.floor((phase * 24 - hour) * 60);
    const daypart = hour < 6 ? 'Noite' : hour < 11 ? 'Manhã' : hour < 17 ? 'Dia' : hour < 20 ? 'Entardecer' : 'Noite';
    const weather = { clear: '☀', mist: '≋', drizzle: '⌁', rain: '☂' }[snapshot.worldTime.weather];
    this.setText('time-label', `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    this.setText('daypart-label', daypart);
    this.setText('weather-icon', weather);
    this.setText('weather-label', { clear: 'Céu limpo', mist: 'Neblina', drizzle: 'Garoa', rain: 'Chuva' }[snapshot.worldTime.weather]);
    this.setText('season-label', `Dia ${snapshot.worldTime.seasonDay}`);
    const flood = this.root.querySelector<HTMLElement>('#flood-indicator');
    if (flood) {
      flood.classList.toggle('visible', snapshot.worldTime.flood > 0.2);
      this.setText('flood-value', `${Math.round(snapshot.worldTime.flood * 100)}%`);
    }
  }

  private renderObjective(snapshot: GameSnapshot, self: PlayerState): void {
    let title = 'A colônia segue em equilíbrio';
    let detail = 'Explore o jardim e descubra recursos.';
    if (inventoryCount(self.inventory) > 0 && (self.isUnderground || flatDistance(self.pos, { x: 0, z: 0 }) < 9)) {
      title = 'Recursos prontos para guardar';
      detail = 'Deposite sua carga na câmara principal.';
    } else if (snapshot.colony.food < 26) {
      title = 'Alimento em baixa';
      detail = 'Sementes e frutas ajudam a colônia a crescer.';
    } else if (snapshot.colony.water < 16) {
      title = 'A colônia precisa de água';
      detail = 'Procure orvalho ou visite a poça.';
    } else if (snapshot.worldTime.flood > 0.44) {
      title = 'A água está subindo';
      detail = 'Proteja a entrada até a chuva passar.';
    } else if (snapshot.predators.some((predator) => flatDistance(predator.pos, { x: 0, z: 0 }) < 20)) {
      title = 'Ameaça no território';
      detail = 'Soldados estão patrulhando a região.';
    } else if (self.isUnderground) {
      title = 'O formigueiro está ativo';
      detail = 'Abra B para construir uma nova câmara.';
    }
    this.setText('objective-title', title);
    this.setText('objective-detail', detail);
  }

  private renderCarrySlots(inventory: PlayerState['inventory']): void {
    const container = this.root.querySelector<HTMLElement>('#carry-slots');
    if (!container) return;
    const entries = (Object.keys(inventory) as ResourceKind[]).filter((kind) => inventory[kind] > 0);
    if (entries.length === 0) {
      container.innerHTML = '<span class="carry-empty">Mochila vazia</span>';
      return;
    }
    container.innerHTML = entries.map((kind) => `<span class="carry-chip"><i style="color:${RESOURCE_INFO[kind].color}">${RESOURCE_INFO[kind].icon}</i>${inventory[kind]}</span>`).join('');
  }

  private renderPanel(): void {
    if (!this.snapshot) return;
    const content = this.root.querySelector<HTMLElement>('#panel-content');
    if (!content) return;
    const { colony, agents, players, resources, structures, predators, tasks, events, discoveries } = this.snapshot;
    const self = players.find((player) => player.id === this.selfId);
    const roleCounts = { worker: 0, soldier: 0, scout: 0, digger: 0, nurse: 0 };
    for (const agent of agents) roleCounts[agent.role] += 1;
    if (this.activePanel === 'colony') {
      const needs = [
        { name: 'Alimento', amount: colony.food, cap: colony.storageCapacity, icon: '✳', tone: '#efbd69' },
        { name: 'Água', amount: colony.water, cap: colony.storageCapacity, icon: '◈', tone: '#82cde1' },
        { name: 'Terra', amount: colony.soil, cap: 180, icon: '▰', tone: '#ba9167' },
        { name: 'Folhas', amount: colony.leaves, cap: 120, icon: '❧', tone: '#8fc07a' },
      ];
      content.innerHTML = `
        <section class="colony-hero"><span class="eyebrow">COLÔNIA · NÍVEL ${Math.max(1, 1 + colony.upgrades.length)}</span><h2>${escapeHtml(colony.name)}</h2><p>${escapeHtml(colony.lastEvent)}</p></section>
        <section class="panel-stat-grid">
          <article class="panel-stat"><span>População</span><strong>${colony.population}</strong><small>formigas vivas</small></article>
          <article class="panel-stat"><span>Rainha</span><strong>${Math.round(colony.queenHealth)}<small>%</small></strong><small>saúde da rainha</small></article>
          <article class="panel-stat"><span>Prole</span><strong>${colony.eggs + colony.larvae + colony.pupae}</strong><small>${colony.eggs} ovos · ${colony.larvae} larvas · ${colony.pupae} pupas</small></article>
          <article class="panel-stat"><span>Descobertas</span><strong>${discoveries.length}</strong><small>pontos mapeados</small></article>
        </section>
        <section class="panel-section"><div class="section-heading"><span>Reservas</span><small>${formatNumber(colony.food + colony.water + colony.soil + colony.leaves)} un.</small></div>
          <div class="storage-list">${needs.map((need) => `<div class="storage-row"><span class="resource-symbol" style="color:${need.tone}">${need.icon}</span><span class="storage-name">${need.name}<small>${formatNumber(need.amount)} / ${need.cap}</small></span><span class="storage-meter"><i style="width:${Math.min(100, need.amount / need.cap * 100)}%;background:${need.tone}"></i></span></div>`).join('')}</div>
        </section>
        <section class="panel-section"><div class="section-heading"><span>Especializações</span><small>${agents.length} ativas</small></div><div class="role-list">${Object.entries(roleCounts).map(([role, count]) => `<div class="role-row"><i class="role-dot role-${role}"></i><span>${ROLE_LABELS[role as keyof typeof ROLE_LABELS]}</span><b>${count}</b></div>`).join('')}</div></section>
        <section class="panel-section"><div class="section-heading"><span>Atividade recente</span><small>últimos eventos</small></div><div class="event-list">${events.slice(-4).reverse().map((event) => `<div class="event-row"><i class="event-mark event-${event.kind}"></i><span>${escapeHtml(event.message)}</span></div>`).join('')}</div></section>
        <div class="panel-footnote">${structures.length} estruturas · ${resources.filter((resource) => resource.amount > 0).length} recursos no jardim · ${predators.length} ameaças conhecidas</div>`;
    } else if (this.activePanel === 'inventory') {
      const inventory = self?.inventory ?? emptyInventory();
      content.innerHTML = `<section class="colony-hero"><span class="eyebrow">FORMIGA · MOCHILA</span><h2>Inventário</h2><p>${inventoryCount(inventory)} de 8 espaços ocupados. Leve a carga de volta ao formigueiro para abastecer a colônia.</p></section>
        <div class="inventory-grid">${(Object.keys(RESOURCE_INFO) as ResourceKind[]).map((kind) => `<article class="inventory-item ${inventory[kind] > 0 ? 'has-item' : ''}"><span style="color:${RESOURCE_INFO[kind].color}">${RESOURCE_INFO[kind].icon}</span><div><b>${RESOURCE_INFO[kind].title}</b><small>${inventory[kind]} carregadas</small></div></article>`).join('')}</div>
        <section class="panel-actions"><button class="panel-action" data-action="eat">Comer <small>consome alimento</small></button><button class="panel-action" data-action="drink">Beber <small>consome água</small></button><button class="panel-action primary" data-action="deposit">Guardar recursos <small>na colônia</small></button></section>`;
    } else if (this.activePanel === 'tasks') {
      const visibleTasks = tasks.filter((task) => task.assignedTo || !['forage'].includes(task.kind)).slice(0, 14);
      content.innerHTML = `<section class="colony-hero"><span class="eyebrow">INTELIGÊNCIA COLETIVA</span><h2>Plano da colônia</h2><p>As tarefas mudam de prioridade conforme os estoques, a prole e as ameaças.</p></section>
        <div class="task-list">${visibleTasks.length ? visibleTasks.map((task) => `<article class="task-card"><span class="task-priority">${Math.round(task.priority)}</span><div><b>${TASK_LABELS[task.kind]}</b><small>${task.assignedTo ? `Em execução · ${agents.find((agent) => agent.id === task.assignedTo)?.role ?? 'colônia'}` : 'Aguardando uma formiga'}</small></div><span class="task-status ${task.assignedTo ? 'active' : ''}">${task.assignedTo ? 'ATIVA' : 'FILA'}</span></article>`).join('') : '<div class="empty-state">Nenhuma tarefa pendente.</div>'}</div>
        <div class="panel-footnote">${agents.filter((agent) => agent.mode !== 'idle').length} formigas executando tarefas neste momento.</div>`;
    } else if (this.activePanel === 'map') {
      content.innerHTML = `<section class="colony-hero map-hero"><span class="eyebrow">CARTOGRAFIA COMPARTILHADA</span><h2>Território conhecido</h2><p>Exploradoras e jogadores atualizam o mapa para toda a colônia.</p></section>
        <canvas id="colony-map" width="520" height="520" aria-label="Mapa do território"></canvas>
        <div class="map-legend"><span><i class="legend-nest"></i>Formigueiro</span><span><i class="legend-food"></i>Recurso</span><span><i class="legend-threat"></i>Ameaça</span><span><i class="legend-player"></i>Jogador</span></div>
        <div class="panel-footnote">${discoveries.length} pontos conhecidos · ${players.length} membros conectados</div>`;
      this.drawMap('#colony-map', this.snapshot, self ?? null);
    } else {
      content.innerHTML = `<section class="colony-hero"><span class="eyebrow">COLABORAÇÃO PRIVADA</span><h2>Equipe da colônia</h2><p>Apenas pessoas com o convite privado podem se juntar a este mundo.</p></section>
        <div class="player-list">${players.map((player) => `<article class="player-row"><span class="player-avatar" style="--player-color:${player.color}">${escapeHtml(player.nickname.slice(0, 1).toUpperCase())}</span><div><b>${escapeHtml(player.nickname)}${player.id === this.selfId ? ' <small>VOCÊ</small>' : ''}</b><span>${player.isUnderground ? 'No formigueiro' : this.regionFor(player.pos.x, player.pos.z)}</span></div><i class="online-dot"></i></article>`).join('')}</div>
        <button class="copy-invite" data-action="copy-invite">↗ <span>Compartilhe o convite privado</span></button>
        <div class="panel-footnote">O código de convite não é salvo nem exibido dentro do jogo.</div>`;
    }
  }


  private drawMap(selector: string, snapshot: GameSnapshot, self: PlayerState | null): void {
    const canvas = this.root.querySelector<HTMLCanvasElement>(selector);
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    const size = Math.min(width, height);
    const scale = size / 156;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#131c19';
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(scale, scale);
    ctx.fillStyle = '#3b4e39';
    ctx.beginPath();
    ctx.arc(0, 0, 74, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200,224,183,.15)';
    ctx.lineWidth = 0.45;
    for (const radius of [20, 40, 60, 74]) {
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(220,231,201,.07)';
    for (let x = -70; x <= 70; x += 10) { ctx.beginPath(); ctx.moveTo(x, -74); ctx.lineTo(x, 74); ctx.stroke(); }
    for (let z = -70; z <= 70; z += 10) { ctx.beginPath(); ctx.moveTo(-74, z); ctx.lineTo(74, z); ctx.stroke(); }

    ctx.fillStyle = 'rgba(115,198,191,.45)';
    ctx.beginPath();
    ctx.arc(22, -22, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(184,235,214,.35)';
    ctx.lineWidth = 0.7;
    ctx.stroke();

    for (const cell of snapshot.pheromones) {
      if (cell.strength < 0.24) continue;
      ctx.globalAlpha = 0.12 + cell.strength * 0.25;
      ctx.fillStyle = { food: '#e9bd69', danger: '#ec7765', home: '#83dfba', explore: '#95cbef', defence: '#d690d4' }[cell.type];
      ctx.beginPath();
      ctx.arc(cell.x, cell.z, 0.68 + cell.strength * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const discovered = new Set(snapshot.discoveries.filter((item) => item.kind === 'resource').map((item) => item.id.replace('resource-', '')));
    for (const resource of snapshot.resources) {
      if (!discovered.has(resource.id) || resource.amount < 1) continue;
      ctx.fillStyle = resource.kind === 'dew' ? '#80d1e5' : '#edc46f';
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.arc(resource.pos.x, resource.pos.z, 0.65, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const discovery of snapshot.discoveries.filter((item) => item.kind === 'threat')) {
      ctx.fillStyle = '#ed7669';
      ctx.beginPath();
      ctx.arc(discovery.x, discovery.z, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const structure of snapshot.structures) {
      ctx.strokeStyle = 'rgba(229,190,132,.62)';
      ctx.lineWidth = 0.38;
      ctx.beginPath();
      ctx.arc(structure.pos.x, structure.pos.z, structure.kind === 'chamber' ? 2 : 0.9, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const player of snapshot.players) {
      ctx.fillStyle = player.id === self?.id ? '#e8ffad' : player.color;
      ctx.beginPath();
      ctx.arc(player.pos.x, player.pos.z, player.id === self?.id ? 1.45 : 1.1, 0, Math.PI * 2);
      ctx.fill();
      if (player.id === self?.id) {
        ctx.save();
        ctx.translate(player.pos.x, player.pos.z);
        ctx.rotate(-player.yaw);
        ctx.strokeStyle = '#f1f9d5';
        ctx.lineWidth = 0.45;
        ctx.beginPath();
        ctx.moveTo(0, -2.4);
        ctx.lineTo(-1.25, 0.7);
        ctx.lineTo(0, 0.2);
        ctx.lineTo(1.25, 0.7);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.fillStyle = '#a9eea8';
    ctx.beginPath();
    ctx.arc(0, 0, 1.75, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#e9e5bc';
    ctx.lineWidth = 0.48;
    ctx.beginPath();
    ctx.arc(0, 0, 3.1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private regionFor(x: number, z: number): string {
    if (Math.hypot(x, z) < 6) return 'Entrada do formigueiro';
    if (Math.hypot(x - 22, z + 22) < 13) return 'Margem úmida';
    if (x < -19 && z > 8) return 'Jardim de pedras';
    if (x < -19 && z < -18) return 'Carvalho antigo';
    if (x > 23 && z > 8) return 'Tronco caído';
    if (z < -20) return 'Prado do norte';
    return 'Campo gramado';
  }

  private setBar(name: string, value: number): void {
    const bar = this.root.querySelector<HTMLElement>(`#${name}-bar`);
    if (!bar) return;
    bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
    bar.classList.toggle('low', value < 26);
  }

  private setText(id: string, value: string): void {
    const element = this.root.querySelector<HTMLElement>(`#${id}`);
    if (element) element.textContent = value;
  }

  private markup(): string {
    return `
      <div id="scene-host" aria-label="Mundo 3D de ANT LIFE"></div>
      <div class="ambient-vignette" aria-hidden="true"></div>
      <div id="first-person-antennas" class="first-person-antennas" aria-hidden="true"><i></i><i></i></div>
      <div id="login-screen" class="login-screen">
        <div class="login-topbar"><a class="brand-lockup" href="#" aria-label="ANT LIFE"><span class="brand-mark">${antMark()}</span><span><b>ANT<span>LIFE</span></b><small>COLÔNIA VIVA · 01</small></span></a><div class="login-status"><i id="connection-dot" data-state="waiting"></i><span id="login-connection-label">Preparando o jardim</span></div></div>
        <div class="login-content"><div class="hero-copy"><span class="eyebrow hero-eyebrow"><i></i> UMA COLÔNIA. UM MUNDO.</span><h1>Pequena no tamanho.<br><em>Gigante em propósito.</em></h1><p>Explore um jardim imenso, encontre seus aliados e ajude uma colônia viva a prosperar.</p><div class="hero-notes"><span><i class="note-icon">✳</i> Mundo compartilhado</span><span><i class="note-icon">◌</i> Progresso persistente</span></div></div>
          <form id="join-form" class="join-card" autocomplete="on"><div class="card-kicker"><span>ACESSO À COLÔNIA</span><span class="private-lock">⌑ PRIVADO</span></div><h2>Seu lugar está<br>esperando.</h2><p>Entre com um convite de alguém da colônia.</p><label for="nickname">NICKNAME <span>2–18 caracteres</span></label><input id="nickname" name="nickname" placeholder="Como vamos te chamar?" maxlength="18" minlength="2" required autocomplete="nickname" />
            <label for="invite-code">CÓDIGO DE CONVITE</label><div class="invite-field"><span>✳</span><input id="invite-code" name="invite" placeholder="Código privado · primeiro acesso" maxlength="64" autocomplete="off" /></div>
            <div id="login-message" class="login-message" role="status"></div><button id="join-button" class="join-button" type="submit">Entrar na colônia <span class="button-arrow">↗</span></button><div class="join-foot"><span>Sem conta. Sem e-mail. Só a colônia.</span><span>v0.1 · navegador</span></div></form>
        </div>
        <div class="login-bottom"><span>UM ECOSSISTEMA EM MOVIMENTO</span><span>GOIÁS · PLANETA TERRA <i>✳</i></span></div>
      </div>

      <div id="hud" class="hud is-hidden">
        <header class="hud-top"><div class="hud-brand"><span class="mini-mark">${antMark()}</span><div><b>ANT LIFE</b><span id="nest-region">Jardim</span></div></div>
          <div class="objective-pill"><span class="objective-symbol">✳</span><div><b id="objective-title">A colônia segue em equilíbrio</b><span id="objective-detail">Explore o jardim e descubra recursos.</span></div><button data-action="toggle-panel" aria-label="Abrir painel da colônia">↗</button></div>
          <div class="hud-right"><div id="top-connection" class="online-status" data-state="good"><i id="hud-connection-dot"></i><span id="hud-connection-label">Conectado</span></div><div class="population-chip"><span>⌂</span><b id="population-value">25</b><small>formigas</small></div><div class="population-chip player-count"><span>◎</span><b id="players-value">1 jogador</b></div><button class="icon-button settings-button" data-action="toggle-settings" aria-label="Configurações">⚙</button></div>
        </header>
        <section class="environment-bar"><span class="time-icon">◷</span><b id="time-label">06:00</b><span class="bar-divider"></span><span id="daypart-label">Manhã</span><span class="weather-chip"><i id="weather-icon">☀</i><span id="weather-label">Céu limpo</span></span><span id="season-label" class="season-chip">Dia 1</span><span id="flood-indicator" class="flood-chip"><i>⌁</i>Água <b id="flood-value">0%</b></span></section>
        <div class="camera-controls"><button data-camera="first" title="Primeira pessoa (1)">I</button><button data-camera="third" class="selected" title="Terceira pessoa (2)">III</button><button data-camera="top" title="Visão superior (3)">⌖</button><span id="camera-label">3ª pessoa</span></div>
        <div class="mini-map-wrap"><div class="mini-map-caption"><span>TERRITÓRIO</span><button data-action="toggle-map" aria-label="Abrir mapa completo">⤢</button></div><canvas id="mini-map-canvas" width="180" height="180" aria-label="Mapa pequeno do território"></canvas><div class="mini-map-bottom"><span><i class="map-legend-self"></i> VOCÊ</span><span id="map-discoveries">MAPA</span></div></div>
        <div class="player-status"><div class="ant-status-heading"><span class="status-avatar">${antMark()}</span><div><b>Exploradora</b><span>Formiga da colônia</span></div><span class="carry-counter"><i>◈</i><b id="carry-value">0/8</b></span></div>
          <div class="vital-row"><span class="vital-icon heart">♥</span><span class="vital-label">Vida</span><span class="vital-track"><i id="health-bar"></i></span><small id="health-value">100%</small></div>
          <div class="vital-row"><span class="vital-icon food">✳</span><span class="vital-label">Fome</span><span class="vital-track"><i id="hunger-bar"></i></span><small id="hunger-value">88%</small></div>
          <div class="vital-row"><span class="vital-icon water">◈</span><span class="vital-label">Sede</span><span class="vital-track"><i id="thirst-bar"></i></span><small id="thirst-value">91%</small></div>
          <div class="vital-row"><span class="vital-icon energy">⌁</span><span class="vital-label">Energia</span><span class="vital-track"><i id="energy-bar"></i></span><small id="energy-value">100%</small></div>
        </div>
        <div class="quick-actions"><button data-action="eat" title="Comer (R)"><span>✳</span><small>COMER</small></button><button data-action="drink" title="Beber (V)"><span>◈</span><small>BEBER</small></button><button data-action="attack" title="Atacar (Q)"><span>⌁</span><small>ATACAR</small></button><button data-action="toggle-build" title="Construir (B)"><span>⌂</span><small>CONSTRUIR</small></button></div>
        <div id="interaction-prompt" class="interaction-prompt"><span class="keycap">E</span><span>Aproxime-se de um recurso</span></div>
        <div class="carry-tray"><div class="tray-heading"><span>CARGA</span><button data-action="deposit">GUARDAR <i>↗</i></button></div><div id="carry-slots"><span class="carry-empty">Mochila vazia</span></div></div>
        <div class="controls-hint"><span><kbd>W A S D</kbd> mover</span><span><kbd>SHIFT</kbd> correr</span><span><kbd>ESPAÇO</kbd> saltar</span><span><kbd>E</kbd> interagir</span><span><kbd>M</kbd> mapa</span></div>
        <div id="underground-hint" class="underground-hint"><span>FORMIGUEIRO</span><button data-action="toggle-build">B · CONSTRUIR</button><button data-action="toggle-panel">↗ · COLÔNIA</button></div>
        <div id="first-person-hint" class="first-person-hint">Clique no jardim para olhar ao redor <span>· Esc libera o cursor</span></div>
        <div id="side-panel" class="side-panel"><button class="panel-backdrop" aria-label="Fechar painel"></button><aside class="panel-sheet"><div class="panel-header"><div><span class="eyebrow">CENTRAL DA COLÔNIA</span><h2>Formigueiro</h2></div><button class="icon-button" data-action="close-panel" aria-label="Fechar">×</button></div><nav class="panel-tabs"><button data-panel="colony" class="selected">Colônia</button><button data-panel="tasks">Tarefas</button><button data-panel="inventory">Inventário</button><button data-panel="map">Mapa</button><button data-panel="players">Equipe</button></nav><div id="panel-content" class="panel-content"></div></aside></div>
        <div id="build-menu" class="build-menu is-hidden"><div class="build-head"><div><span class="eyebrow">EXPANSÃO SUBTERRÂNEA</span><b>Construir</b></div><button data-close class="icon-button">×</button></div><p>Escolha o próximo módulo. A construção é compartilhada com a colônia.</p><button class="build-option" data-build="tunnel"><span class="build-icon">⌁</span><span><b>Túnel</b><small>4 terra · 1 folha</small></span><i>↗</i></button><button class="build-option" data-build="chamber"><span class="build-icon">◉</span><span><b>Câmara</b><small>12 terra · 4 folhas</small></span><i>↗</i></button><button class="build-option" data-build="store"><span class="build-icon">▤</span><span><b>Depósito</b><small>8 terra · 5 folhas · +30 espaço</small></span><i>↗</i></button><button class="build-option" data-build="nursery"><span class="build-icon">❋</span><span><b>Berçário</b><small>10 terra · 6 folhas · +12 espaço</small></span><i>↗</i></button><button class="build-option" data-build="barrier"><span class="build-icon">▥</span><span><b>Barreira</b><small>3 terra · 4 folhas</small></span><i>↗</i></button><div class="build-footnote">Aponte a formiga para o local desejado antes de construir.</div></div>
        <div id="settings-modal" class="settings-modal is-hidden"><div class="modal-backdrop"></div><div class="settings-card"><div class="settings-head"><div><span class="eyebrow">PREFERÊNCIAS</span><h2>Configurações</h2></div><button data-close class="icon-button">×</button></div><section class="setting-section"><span class="setting-title">Qualidade gráfica</span><div class="quality-options"><button data-quality="low"><b>Baixa</b><small>Mais desempenho</small></button><button data-quality="medium"><b>Média</b><small>Equilibrada</small></button><button data-quality="high"><b>Alta</b><small>Mais detalhes</small></button></div></section><section class="setting-section volume-section"><span class="setting-title">Áudio</span><label>Geral <input data-volume="master" type="range" min="0" max="1" step="0.01" /></label><label>Ambiente <input data-volume="ambience" type="range" min="0" max="1" step="0.01" /></label><label>Efeitos <input data-volume="effects" type="range" min="0" max="1" step="0.01" /></label></section><section class="setting-section setting-info"><span>CONTROLES</span><p>WASD mover · Mouse olhar · Shift correr · Espaço pular · E interagir · M mapa · C câmera · Esc cursor</p><p>O progresso da colônia é salvo automaticamente no servidor.</p></section><button class="leave-button" data-action="leave">Sair da colônia</button></div></div>
        <div id="death-overlay" class="death-overlay"><span>✳</span><b>Você caiu na jornada</b><small>A colônia está preparando seu retorno seguro.</small></div>
        <div id="toast-stack" class="toast-stack" aria-live="polite"></div>
      </div>
    `;
  }
}

function antMark(): string {
  return `<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M20 16.5c-2.1 0-3.8 1.5-3.8 3.5s1.7 3.5 3.8 3.5 3.8-1.5 3.8-3.5-1.7-3.5-3.8-3.5Z" fill="currentColor"/><path d="M20 23.8c-3.2 0-5.8 2.1-5.8 4.7 0 2.5 2.6 4.5 5.8 4.5s5.8-2 5.8-4.5c0-2.6-2.6-4.7-5.8-4.7Z" fill="currentColor"/><path d="M20 13.9c2 0 3.5-1.5 3.5-3.3 0-1.9-1.5-3.4-3.5-3.4s-3.5 1.5-3.5 3.4c0 1.8 1.5 3.3 3.5 3.3Z" fill="currentColor"/><path d="m16.5 19-7-4.7m7.4 7.4-7 4m13.6-6.7 7-4.7m-7.4 7.4 7 4M17.2 8.1l-3.8-4m9.4 4 3.8-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
}

function inventoryCount(inventory: PlayerState['inventory']): number { return Object.values(inventory).reduce((sum, value) => sum + value, 0); }
function formatNumber(value: number): string { return Number.isInteger(value) ? value.toString() : value.toFixed(1); }
function emptyInventory(): PlayerState['inventory'] { return { seed: 0, berry: 0, sugar: 0, dew: 0, soil: 0, leaf: 0, mushroom: 0 }; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }

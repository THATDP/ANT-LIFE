import type { GameAction, GameSnapshot, ServerMessage } from '../../../shared/src/types.js';

export interface JoinResult {
  selfId: string;
  resumed: boolean;
  snapshot: GameSnapshot;
}

export class GameSocket {
  private socket: WebSocket | null = null;
  private sessionToken = localStorage.getItem('ant-life-session') ?? '';
  private nickname = localStorage.getItem('ant-life-nickname') ?? '';
  private inviteCode = '';
  private manualClose = false;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1_000;
  private isReconnecting = false;
  private messageListeners = new Set<(message: ServerMessage) => void>();
  private statusListeners = new Set<(connected: boolean, message: string) => void>();

  onMessage(listener: (message: ServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStatus(listener: (connected: boolean, message: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  connect(nickname: string, inviteCode: string): Promise<JoinResult> {
    this.manualClose = false;
    this.nickname = nickname;
    this.inviteCode = inviteCode;
    localStorage.setItem('ant-life-nickname', nickname);
    return this.openAndJoin(false);
  }

  sendMove(seq: number, x: number, z: number, yaw: number, run: boolean, jump: boolean): void {
    this.send({ type: 'move', seq, x, z, yaw, run, jump });
  }

  sendAction(action: GameAction): void {
    this.send({ type: 'action', action });
  }

  disconnect(clearSession = false): void {
    this.manualClose = true;
    this.isReconnecting = false;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close(1000, 'player left');
      this.socket = null;
    }
    if (clearSession) {
      this.sessionToken = '';
      localStorage.removeItem('ant-life-session');
    }
  }

  async checkServer(): Promise<{ game: string; worldName: string; privateInviteRequired: boolean }> {
    const response = await fetch(apiUrl('/api/config'), { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`Servidor indisponível (${response.status}).`);
    return response.json() as Promise<{ game: string; worldName: string; privateInviteRequired: boolean }>;
  }

  private openAndJoin(reconnect: boolean): Promise<JoinResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let joined = false;
      let socket: WebSocket;
      try {
        socket = new WebSocket(webSocketUrl());
      } catch (error) {
        reject(error);
        return;
      }
      this.socket = socket;
      this.notifyStatus(false, reconnect ? 'Reconectando à colônia…' : 'Conectando ao servidor…');
      const settleError = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          type: 'join',
          nickname: this.nickname,
          inviteCode: this.inviteCode,
          ...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
        }));
      });

      socket.addEventListener('message', (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          this.notifyStatus(false, 'O servidor enviou uma mensagem inválida.');
          return;
        }
        if (message.type === 'error' && !joined) {
          settleError(new Error(message.message));
          this.notifyStatus(false, message.message);
          socket.close(1008, 'join rejected');
          return;
        }
        if (message.type === 'joined') {
          joined = true;
          settled = true;
          this.sessionToken = message.sessionToken;
          this.nickname = message.snapshot.players.find((player) => player.id === message.selfId)?.nickname ?? this.nickname;
          localStorage.setItem('ant-life-session', this.sessionToken);
          this.reconnectDelay = 1_000;
          this.isReconnecting = false;
          this.notifyStatus(true, 'Conectado');
          for (const listener of this.messageListeners) listener(message);
          resolve({ selfId: message.selfId, resumed: message.resumed, snapshot: message.snapshot });
          return;
        }
        for (const listener of this.messageListeners) listener(message);
      });

      socket.addEventListener('error', () => {
        this.notifyStatus(false, reconnect ? 'Reconexão pendente…' : 'Falha de conexão. Verifique o servidor.');
        settleError(new Error('Não foi possível conectar ao servidor multiplayer.'));
      });

      socket.addEventListener('close', (event) => {
        if (!settled) settleError(new Error(event.code === 1008 ? 'Acesso recusado.' : 'Conexão encerrada antes de entrar.'));
        if (this.socket === socket) this.socket = null;
        if (joined && !this.manualClose) {
          this.notifyStatus(false, 'Conexão perdida. Tentando recuperar a sessão…');
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.manualClose || this.isReconnecting || this.reconnectTimer !== null) return;
    this.isReconnecting = true;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(20_000, this.reconnectDelay * 1.7);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openAndJoin(true).catch((error: unknown) => {
        this.isReconnecting = false;
        this.notifyStatus(false, error instanceof Error ? error.message : 'Reconexão indisponível.');
        this.scheduleReconnect();
      });
    }, delay);
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private notifyStatus(connected: boolean, message: string): void {
    for (const listener of this.statusListeners) listener(connected, message);
  }
}

function apiUrl(path: string): string {
  const base = serverBaseUrl();
  return `${base}${path}`;
}

function webSocketUrl(): string {
  const url = new URL('/ws', serverBaseUrl());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function serverBaseUrl(): string {
  const configured = import.meta.env.VITE_SERVER_URL?.trim();
  if (configured) {
    const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(configured) ? configured : `https://${configured}`;
    return normalized.replace(/\/$/, '');
  }
  return window.location.origin;
}

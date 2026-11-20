import './styles.css';
import { Game } from './game/Game.js';
import { AudioEngine } from './game/AudioEngine.js';
import { GameSocket } from './network/GameSocket.js';
import { GameUI } from './ui/GameUI.js';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('ANT LIFE app root is missing.');

const socket = new GameSocket();
const audio = new AudioEngine();
let game: Game | null = null;
let hasJoined = false;

const ui = new GameUI(root, {
  join: (nickname, inviteCode) => {
    if (nickname.length < 2 || nickname.length > 18) {
      ui.setLoginMessage('O nickname precisa ter entre 2 e 18 caracteres.');
      return;
    }
    if (!inviteCode && !localStorage.getItem('ant-life-session')) {
      ui.setLoginMessage('Informe o código privado que o proprietário compartilhou com você.');
      return;
    }
    ui.setConnecting(true);
    void audio.start();
    socket.connect(nickname, inviteCode).catch((error: unknown) => {
      ui.setConnecting(false);
      ui.setLoginMessage(error instanceof Error ? error.message : 'Não foi possível entrar na colônia.');
      ui.setConnection('Servidor indisponível', 'bad');
    });
  },
  action: (action) => game?.perform(action),
  camera: (mode) => game?.setCamera(mode),
  panel: () => undefined,
  quality: (quality) => game?.setQuality(quality),
  volume: (master, ambience, effects) => audio.setVolumes(master, ambience, effects),
  leave: () => {
    socket.disconnect(false);
    window.location.reload();
  },
});

try {
  const host = root.querySelector<HTMLElement>('#scene-host');
  if (!host) throw new Error('Não foi possível criar a cena 3D.');
  game = new Game(host, socket, ui, audio);
} catch (error) {
  console.error('[client] 3D initialization failed:', error);
  ui.setLoginMessage('Seu navegador não conseguiu iniciar o WebGL 3D. Tente atualizar o navegador ou ativar a aceleração gráfica.', 'error');
  ui.setConnection('WebGL indisponível', 'bad');
}

socket.onStatus((connected, message) => {
  if (connected) {
    hasJoined = true;
    ui.setConnection('Conectado', 'good');
  } else if (hasJoined) {
    ui.setDisconnected();
  } else {
    ui.setConnection(message, message.toLowerCase().includes('falha') ? 'bad' : 'waiting');
  }
});

void socket.checkServer().then((configuration) => {
  if (!hasJoined) ui.setConnection(`Servidor disponível · ${configuration.worldName}`, 'good');
}).catch(() => {
  if (!hasJoined) ui.setConnection('Aguardando servidor multiplayer', 'waiting');
});

window.addEventListener('pagehide', () => {
  socket.disconnect(false);
  game?.dispose();
}, { once: true });

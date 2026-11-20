import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { serveClientAsset } from './http/staticClient.js';
import { loadConfig, originAllowed } from './config.js';
import { GameServer } from './game/GameServer.js';
import { JsonStore } from './persistence/JsonStore.js';
import { PostgresStore } from './persistence/PostgresStore.js';

const config = loadConfig();
const clientRoot = resolve(process.cwd(), 'dist/client');
const store = config.databaseUrl ? new PostgresStore(config.databaseUrl) : new JsonStore(config.localSavePath);
const game = await GameServer.create(store, config);
const httpServer = createServer((request, response) => handleHttp(request, response));
const socketServer = new WebSocketServer({ noServer: true, maxPayload: 8_192, perMessageDeflate: false });

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const origin = request.headers.origin;
  if (!originAllowed(origin, config)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (game.onlineCount >= 32) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  socketServer.handleUpgrade(request, socket, head, (webSocket) => {
    socketServer.emit('connection', webSocket, request);
  });
});

socketServer.on('connection', (socket) => game.attachSocket(socket));

function handleHttp(request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const origin = request.headers.origin;
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');

  if (url.pathname === '/health' || url.pathname === '/healthz') {
    writeJson(response, 200, { status: 'ok', service: 'ant-life-server', storage: store.mode, connectedPlayers: game.onlineCount, time: new Date().toISOString() });
    return;
  }
  if (origin && !originAllowed(origin, config)) {
    writeJson(response, 403, { error: 'origin_not_allowed' });
    return;
  }
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/config') {
    writeJson(response, 200, {
      game: 'ANT LIFE',
      worldName: game.world.colony.name,
      privateInviteRequired: true,
      protocol: 'websocket-authoritative-v1',
    });
    return;
  }
  if (config.production && (request.method === 'GET' || request.method === 'HEAD') && !url.pathname.startsWith('/api')) {
    if (serveClientAsset(request, response, url, clientRoot)) return;
  }
  writeJson(response, 404, { error: 'not_found' });
}


function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

httpServer.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

httpServer.listen(config.port, config.host, () => {
  game.start();
  console.info(`[server] ANT LIFE multiplayer listening on ${config.host}:${config.port}`);
  console.info(`[server] Private invite required · ${store.mode} persistence · health: /health`);
  if (!config.production) console.info('[server] Development invite: ANT-LIFE-LOCAL');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[server] ${signal} received; saving colony...`);
  socketServer.close();
  await game.stop();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

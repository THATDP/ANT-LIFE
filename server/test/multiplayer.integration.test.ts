import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import type { ClientMessage, ServerMessage } from '../../shared/src/types.js';
import type { ServerConfig } from '../src/config.js';
import { GameServer } from '../src/game/GameServer.js';
import { JsonStore } from '../src/persistence/JsonStore.js';

function waitForMessage(socket: WebSocket, predicate: (message: ServerMessage) => boolean, timeoutMs = 4_000): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', handleMessage);
      reject(new Error('Timed out waiting for multiplayer message.'));
    }, timeoutMs);
    const handleMessage = (raw: WebSocket.RawData): void => {
      let message: ServerMessage;
      try { message = JSON.parse(raw.toString()) as ServerMessage; }
      catch { return; }
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off('message', handleMessage);
      resolve(message);
    };
    socket.on('message', handleMessage);
  });
}

async function openClient(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { origin: 'http://localhost:5173' });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function sendJoin(socket: WebSocket, nickname: string, inviteCode: string, sessionToken?: string): void {
  const message: ClientMessage = { type: 'join', nickname, inviteCode, ...(sessionToken ? { sessionToken } : {}) };
  socket.send(JSON.stringify(message));
}

function sendAction(socket: WebSocket, action: ClientMessage & { type: 'action' }['action']): void {
  socket.send(JSON.stringify({ type: 'action', action }));
}

function sendMove(socket: WebSocket, seq: number, x: number, z: number, yaw: number): void {
  socket.send(JSON.stringify({ type: 'move', seq, x, z, yaw, run: false, jump: false }));
}

test('private colony joins, shares state, validates actions, and restores saved progress', { timeout: 20_000 }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ant-life-test-'));
  const savePath = join(folder, 'world.json');
  const config: ServerConfig = {
    port: 0,
    host: '127.0.0.1',
    production: false,
    inviteCode: 'test-colony-invite',
    sessionSecret: 'integration-session-secret-with-more-than-32-characters',
    allowedOrigins: [],
    localSavePath: savePath,
  };
  const game = await GameServer.create(new JsonStore(savePath), config);
  const socketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  socketServer.on('connection', (socket) => game.attachSocket(socket));
  await new Promise<void>((resolve) => socketServer.once('listening', resolve));
  const address = socketServer.address();
  assert.ok(address && typeof address !== 'string');
  const url = `ws://127.0.0.1:${address.port}/ws`;
  game.start();
  let clients: WebSocket[] = [];
  let restored: GameServer | null = null;
  let gameStopped = false;
  let socketServerClosed = false;

  try {
    const intruder = await openClient(url);
    clients.push(intruder);
    const deniedPromise = waitForMessage(intruder, (message) => message.type === 'error');
    sendJoin(intruder, 'Intruso', 'not-the-code');
    const denied = await deniedPromise;
    assert.equal(denied.type === 'error' ? denied.code : '', 'INVITE_REQUIRED');
    intruder.close();

    const alice = await openClient(url);
    const aliceJoinPromise = waitForMessage(alice, (message) => message.type === 'joined');
    sendJoin(alice, 'Myrmidon', 'test-colony-invite');
    const aliceJoined = await aliceJoinPromise;
    assert.equal(aliceJoined.type, 'joined');
    if (aliceJoined.type !== 'joined') throw new Error('Alice was not authenticated.');
    clients.push(alice);

    const bob = await openClient(url);
    const bobJoinPromise = waitForMessage(bob, (message) => message.type === 'joined');
    sendJoin(bob, 'Forager', 'test-colony-invite');
    const bobJoined = await bobJoinPromise;
    assert.equal(bobJoined.type, 'joined');
    if (bobJoined.type !== 'joined') throw new Error('Bob was not authenticated.');
    clients.push(bob);
    assert.equal(bobJoined.snapshot.players.length, 2, 'both authorized players receive the same world');

    const aliceState = game.world.players[aliceJoined.selfId];
    assert.ok(aliceState);
    const startZ = aliceState.pos.z;
    sendMove(alice, 1, 0, -1, 0);
    await new Promise((resolve) => setTimeout(resolve, 420));
    assert.ok(aliceState.pos.z > startZ + 0.6, 'authoritative movement advances from client input');

    sendMove(alice, 2, 0, 0, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const starterNode = game.world.resources.find((node) => node.id === 'resource-starter-seed');
    assert.ok(starterNode);
    aliceState.pos = { ...starterNode!.pos };
    const collectNotice = waitForMessage(alice, (message) => message.type === 'notice' && message.message.includes('Coletou'));
    sendAction(alice, { type: 'interact' });
    await collectNotice;
    assert.ok(aliceState.inventory.seed > 0, 'resource collection is decided and stored by the server');
    await new Promise((resolve) => setTimeout(resolve, 270));

    aliceState.isUnderground = true;
    aliceState.pos = { x: 0, y: -7.5, z: 0 };
    const foodBeforeDeposit = game.world.colony.food;
    const depositNotice = waitForMessage(alice, (message) => message.type === 'notice' && message.message.includes('armazenados'));
    sendAction(alice, { type: 'deposit' });
    await depositNotice;
    assert.ok(game.world.colony.food > foodBeforeDeposit, 'inventory deposit updates the shared colony stock');
    await new Promise((resolve) => setTimeout(resolve, 270));

    const structureCount = game.world.structures.length;
    const buildNotice = waitForMessage(alice, (message) => message.type === 'notice' && message.message.includes('Construção concluída'));
    sendAction(alice, { type: 'build', kind: 'chamber' });
    await buildNotice;
    assert.equal(game.world.structures.length, structureCount + 1, 'a validated build becomes shared world state');
    const sharedBuild = await waitForMessage(bob, (message) => message.type === 'snapshot' && message.snapshot.structures.length === structureCount + 1);
    assert.equal(sharedBuild.type, 'snapshot');

    alice.close();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const reconnect = await openClient(url);
    clients.push(reconnect);
    const reconnectPromise = waitForMessage(reconnect, (message) => message.type === 'joined');
    sendJoin(reconnect, 'Myrmidon', '', aliceJoined.sessionToken);
    const reconnectMessage = await reconnectPromise;
    assert.equal(reconnectMessage.type, 'joined');
    if (reconnectMessage.type !== 'joined') throw new Error('Reconnect failed.');
    assert.equal(reconnectMessage.resumed, true, 'a signed session resumes without sharing the invite again');
    assert.equal(reconnectMessage.selfId, aliceJoined.selfId);

    bob.close();
    reconnect.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await game.stop();
    gameStopped = true;
    clients = [];
    await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    socketServerClosed = true;

    restored = await GameServer.create(new JsonStore(savePath), config);
    assert.equal(restored.world.structures.length, structureCount + 1, 'built structures survive a server restart');
    assert.ok(restored.world.colony.food > foodBeforeDeposit, 'colony inventory survives a server restart');
  } finally {
    for (const client of clients) if (client.readyState === WebSocket.OPEN) client.close();
    if (!gameStopped) await game.stop();
    if (!socketServerClosed) await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    if (restored) await restored.stop();
    await rm(folder, { recursive: true, force: true });
  }
});

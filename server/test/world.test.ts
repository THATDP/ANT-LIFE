import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceNodes, createWorldProps, mulberry32, terrainHeight } from '../../shared/src/world.js';
import { MAX_OFFLINE_SECONDS, simulateOffline } from '../src/game/offlineSimulation.js';
import { createDefaultWorld } from '../src/game/worldFactory.js';

test('procedural world landmarks and resource distributions are deterministic', () => {
  const firstProps = createWorldProps(42);
  const secondProps = createWorldProps(42);
  const firstNodes = createResourceNodes(42);
  const secondNodes = createResourceNodes(42);
  assert.deepEqual(firstProps, secondProps);
  assert.deepEqual(firstNodes, secondNodes);
  assert.ok(firstProps.some((prop) => prop.id === 'landmark-old-oak'));
  assert.ok(firstNodes.length >= 50);
  assert.equal(terrainHeight(10, 20), terrainHeight(10, 20));
  assert.equal(mulberry32(5)(), mulberry32(5)());
});

test('offline simulation advances bounded ecology and keeps the colony within storage and population limits', () => {
  const now = 1_800_000_000_000;
  const world = createDefaultWorld(now - 10 * 60_000, 17);
  const initialPopulation = world.colony.population;
  const initialTime = world.worldTime.seconds;
  const simulated = simulateOffline(world, now);
  assert.equal(simulated, 600);
  assert.ok(world.worldTime.seconds > initialTime);
  assert.ok(world.lastSimulatedAt === now);
  assert.ok(world.colony.population >= initialPopulation);
  assert.ok(world.colony.population <= 300);
  assert.ok(world.colony.food >= 0 && world.colony.food <= world.colony.storageCapacity);
  assert.ok(world.colony.water >= 0 && world.colony.water <= world.colony.storageCapacity);
  assert.ok(world.events.length > 0);
});

test('offline time is capped to avoid unbounded catch-up work', () => {
  const now = 1_800_000_000_000;
  const world = createDefaultWorld(now - 60 * 24 * 60 * 60_000, 31);
  const simulated = simulateOffline(world, now);
  assert.equal(simulated, MAX_OFFLINE_SECONDS);
  assert.equal(world.lastSimulatedAt, now);
  assert.ok(world.agents.length <= world.colony.population);
});

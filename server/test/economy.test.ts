import assert from 'node:assert/strict';
import test from 'node:test';
import { simulateOffline } from '../src/game/offlineSimulation.js';
import { createDefaultWorld } from '../src/game/worldFactory.js';

test('offline colony economy aggregates distinct stocks without simulating individual resource routes', () => {
  const start = 1_800_000_000_000;
  const world = createDefaultWorld(start, 111);
  const before = { ...world.colony };
  const resourceAmounts = world.resources.map((node) => node.amount);

  // Ten in-game colony hours at 60 game-seconds per hour; no 3D ant steps are needed.
  const simulated = simulateOffline(world, start + 10 * 60_000);
  assert.equal(simulated, 600);
  assert.ok(world.colony.food > before.food, 'foragers contribute food separately');
  assert.ok(world.colony.water > before.water, 'scouts contribute water separately');
  assert.ok(world.colony.soil > before.soil, 'diggers contribute building soil separately');
  assert.ok(world.colony.leaves < before.leaves, 'brood care consumes leaves independently');
  assert.ok(world.resources.every((node, index) => node.amount >= resourceAmounts[index]! && node.amount <= node.maxAmount), 'resource nodes regenerate within their own caps');
  assert.ok(world.colony.food <= world.colony.storageCapacity);
  assert.ok(world.colony.water <= world.colony.storageCapacity);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultWorld } from '../src/game/worldFactory.js';
import { decayPheromones, depositPheromone, pheromoneAttraction, strongestPheromone } from '../src/game/pheromones.js';

test('pheromone trails aggregate, guide nearby ants, and decay over time', () => {
  const world = createDefaultWorld(1_800_000_000_000, 123);
  depositPheromone(world, 8.8, 2.1, 'food', 0.35);
  depositPheromone(world, 8.2, 3.2, 'food', 0.25);
  assert.equal(world.pheromones.length, 1, 'neighboring deposits share a pheromone cell');
  const strongest = strongestPheromone(world, 0, 0, 'food', 20);
  assert.ok(strongest && strongest.strength > 0.5);
  const initialStrength = strongest!.strength;
  const direction = pheromoneAttraction(world, 0, 0, 'food');
  assert.ok(direction && direction.x > 0 && direction.z > 0);
  decayPheromones(world, 120);
  assert.ok((world.pheromones[0]?.strength ?? 0) < initialStrength);
  decayPheromones(world, 900);
  assert.equal(world.pheromones.length, 0);
});

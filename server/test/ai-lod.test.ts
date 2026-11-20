import assert from 'node:assert/strict';
import test from 'node:test';
import { ColonyAI } from '../src/game/antAI.js';
import { createDefaultWorld } from '../src/game/worldFactory.js';

test('ants away from players and threats use a lower-frequency movement update cadence', () => {
  const start = 1_800_000_000_000;
  const world = createDefaultWorld(start, 55);
  const ai = new ColonyAI(world.seed);
  ai.update(world, 0.25, start);
  const agent = world.agents.find((candidate) => candidate.role === 'worker' && candidate.taskId !== null);
  assert.ok(agent);
  const initial = { ...agent!.pos };

  ai.update(world, 0.25, start + 250);
  ai.update(world, 0.25, start + 500);
  assert.deepEqual(agent!.pos, initial, 'a distant agent is not moved on every 250 ms AI pass');

  ai.update(world, 0.25, start + 750);
  assert.notDeepEqual(agent!.pos, initial, 'the agent advances after its lower-frequency interval elapses');
});

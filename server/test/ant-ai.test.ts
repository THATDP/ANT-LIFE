import assert from 'node:assert/strict';
import test from 'node:test';
import { ColonyAI } from '../src/game/antAI.js';
import { createDefaultWorld } from '../src/game/worldFactory.js';

test('colony AI releases assignments when an ant is interrupted by a predator flee', () => {
  const start = 1_800_000_000_000;
  const world = createDefaultWorld(start, 321);
  const ai = new ColonyAI(world.seed);
  ai.update(world, 0.25, start);
  const task = world.tasks.find((candidate) => candidate.assignedTo !== null);
  assert.ok(task?.assignedTo);
  const agent = world.agents.find((candidate) => candidate.id === task?.assignedTo);
  assert.ok(agent);

  // Fleeing cancels the ant's task id; the periodic planner must not strand its old reservation.
  agent!.taskId = null;
  agent!.mode = 'fleeing';
  ai.update(world, 0.25, start + 5_000);
  for (const assigned of world.tasks.filter((candidate) => candidate.assignedTo)) {
    const assignee = world.agents.find((candidate) => candidate.id === assigned.assignedTo);
    assert.ok(assignee, 'a task cannot remain assigned to a removed ant');
    assert.equal(assignee!.taskId, assigned.id, 'the ant and task must agree on assignment ownership');
  }
});

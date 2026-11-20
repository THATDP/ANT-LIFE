import assert from 'node:assert/strict';
import test from 'node:test';
import { NavigationGrid } from '../src/game/navigation.js';

test('colony pathfinding produces a bounded route and surface obstacle checks', () => {
  const navigation = new NavigationGrid(811);
  const path = navigation.findPath({ x: 0, z: 0 }, { x: 33, z: 24 });
  assert.ok(path.length > 0);
  assert.ok(path.length < 100);
  assert.equal(path.at(-1)?.x, 33);
  assert.equal(path.at(-1)?.z, 24);
  assert.equal(navigation.isBlockedPosition(0, 0), false);
  assert.equal(navigation.isBlockedPosition(80, 0), true);
});

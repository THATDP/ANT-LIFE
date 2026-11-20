import type { PersistentWorld } from '../../../shared/src/types.js';
import { addAgent, makeEvent } from './worldFactory.js';

export function simulateColonyHour(world: PersistentWorld, hour: number, now: number): void {
  const population = world.colony.population;
  world.colony.food = Math.max(0, world.colony.food - population * 0.014);
  world.colony.water = Math.max(0, world.colony.water - population * 0.009);
  world.colony.leaves = Math.max(0, world.colony.leaves - world.colony.larvae * 0.02);

  const wellFed = world.colony.food >= 2 && world.colony.water >= 1 && world.colony.queenHealth > 15;
  if (wellFed) {
    if (hour % 6 === 0 && world.colony.eggs < 12) world.colony.eggs += 1;
    if (hour % 10 === 0 && world.colony.eggs > 0) {
      world.colony.eggs -= 1;
      world.colony.larvae += 1;
    }
    if (hour % 14 === 0 && world.colony.larvae > 0) {
      world.colony.larvae -= 1;
      world.colony.pupae += 1;
    }
    const chamberCount = world.structures.filter((structure) => structure.kind === 'chamber' || structure.kind === 'nursery').length;
    const populationLimit = Math.min(300, 24 + chamberCount * 12 + world.colony.upgrades.length * 8);
    if (hour % 18 === 0 && world.colony.pupae > 0 && world.colony.population < populationLimit) {
      world.colony.pupae -= 1;
      world.colony.population += 1;
      addAgent(world);
      const message = 'Uma nova formiga nasceu e se juntou à colônia.';
      world.colony.lastEvent = message;
      world.events.push(makeEvent(now, 'birth', message));
    }
    world.colony.queenHealth = Math.min(100, world.colony.queenHealth + 0.08);
  } else {
    if (hour % 24 === 0 && world.colony.larvae > 0) {
      world.colony.larvae -= 1;
      world.events.push(makeEvent(now, 'colony', 'A falta de alimento custou uma larva.'));
    }
    if (hour % 48 === 0 && world.colony.population > 2) {
      world.colony.population -= 1;
      const lost = world.agents.pop();
      if (lost) world.events.push(makeEvent(now, 'colony', `Uma formiga ${lost.role} não sobreviveu à escassez.`));
    }
    world.colony.queenHealth = Math.max(10, world.colony.queenHealth - 0.15);
  }
  world.events = world.events.slice(-100);
}

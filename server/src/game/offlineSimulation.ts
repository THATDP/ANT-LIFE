import type { PersistentWorld } from '../../../shared/src/types.js';
import { simulateColonyHour } from './colonyEconomy.js';
import { makeEvent } from './worldFactory.js';

export const MAX_OFFLINE_SECONDS = 7 * 24 * 60 * 60;
const COLONY_HOUR_SECONDS = 60;

/** Applies a bounded aggregate simulation while the multiplayer process is asleep. */
export function simulateOffline(world: PersistentWorld, now = Date.now()): number {
  const elapsedRaw = Math.max(0, (now - world.lastSimulatedAt) / 1000);
  const elapsed = Math.min(elapsedRaw, MAX_OFFLINE_SECONDS);
  if (elapsed < 1) {
    world.lastSimulatedAt = now;
    return 0;
  }

  const previousGameTime = world.worldTime.seconds;
  world.worldTime.seconds += elapsed;
  world.worldTime.seasonDay += Math.floor(world.worldTime.seconds / world.worldTime.dayLength) - Math.floor(previousGameTime / world.worldTime.dayLength);
  world.worldTime.weatherSecondsLeft -= elapsed;
  if (world.worldTime.weatherSecondsLeft <= 0) {
    const nextWeather = world.worldTime.weather === 'rain' ? 'clear' : 'drizzle';
    world.worldTime.weather = nextWeather;
    world.worldTime.weatherSecondsLeft = 3 * 60 * 60;
    world.events.push(makeEvent(now, 'weather', `O clima mudou: ${nextWeather === 'clear' ? 'céu aberto' : 'garoa'}.`));
  }
  world.worldTime.flood = world.worldTime.weather === 'rain' ? Math.min(0.7, world.worldTime.flood + elapsed / 86_400) : Math.max(0, world.worldTime.flood - elapsed / 50_000);

  const oldHour = Math.floor(previousGameTime / COLONY_HOUR_SECONDS);
  const newHour = Math.floor(world.worldTime.seconds / COLONY_HOUR_SECONDS);
  const workers = world.agents.filter((agent) => agent.role === 'worker' || agent.role === 'scout').length;
  const scouts = world.agents.filter((agent) => agent.role === 'scout').length;
  for (let hour = oldHour + 1; hour <= newHour; hour += 1) {
    // Offline labor is aggregate: workers forage and scouts collect water without simulating 3D entities.
    world.colony.food = Math.min(world.colony.storageCapacity, world.colony.food + Math.min(1.25, workers * 0.09));
    world.colony.water = Math.min(world.colony.storageCapacity, world.colony.water + Math.min(0.7, scouts * 0.08));
    world.colony.soil = Math.min(180, world.colony.soil + Math.min(0.25, world.agents.filter((agent) => agent.role === 'digger').length * 0.035));
    simulateColonyHour(world, hour, now);
  }

  const hours = elapsed / COLONY_HOUR_SECONDS;
  for (const node of world.resources) {
    if (node.amount < node.maxAmount) node.amount = Math.min(node.maxAmount, node.amount + hours * 0.2);
  }
  world.colony.food = Math.min(world.colony.storageCapacity, world.colony.food);
  world.colony.water = Math.min(world.colony.storageCapacity, world.colony.water);
  world.events = world.events.slice(-100);
  world.lastSimulatedAt = now;
  return elapsed;
}

/// <reference lib="webworker" />
import {
  applyCommand,
  createWorld,
  processPending,
  stepWorld,
} from "../simulation";
import { TIME_SCALE } from "../shared/constants";
import { parseWorld, serializeWorld } from "../persistence";
import type { WorkerInput } from "../shared/types";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let world = createWorld();
let previous = performance.now();
let accumulated = 0;
const publish = () => scope.postMessage({ type: "world", world });
scope.onmessage = (event: MessageEvent<WorkerInput>) => {
  try {
    const input = event.data;
    if (input.type === "load") {
      world = parseWorld(serializeWorld(input.world));
      // Old saved widening orders no longer need to drain, even while paused.
      processPending(world, true);
      world.paused = true;
      previous = performance.now();
      accumulated = 0;
    }
    if (input.type === "command") {
      if (input.command.type === "reset") {
        world = createWorld(input.command.seed);
        previous = performance.now();
        accumulated = 0;
      } else
        scope.postMessage({
          type: "result",
          result: applyCommand(world, input.command),
        });
    }
    publish();
  } catch (error) {
    world.paused = true;
    scope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    publish();
  }
};
setInterval(() => {
  const now = performance.now();
  const elapsed = Math.min(0.25, (now - previous) / 1000);
  previous = now;
  if (!world.paused) {
    try {
      accumulated += elapsed * TIME_SCALE * world.speed;
      const steps = Math.floor(accumulated);
      accumulated -= steps;
      if (steps) stepWorld(world, steps);
      publish();
    } catch (error) {
      world.paused = true;
      scope.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      publish();
    }
  }
}, 100);
publish();

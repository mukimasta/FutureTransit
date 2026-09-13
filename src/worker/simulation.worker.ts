/// <reference lib="webworker" />
import {
  applyCommand,
  createWorld,
  processPending,
  stepWorldAsync,
} from "../simulation";
import { TIME_SCALE } from "../shared/constants";
import { parseWorld, serializeWorld } from "../persistence";
import type { WorkerInput } from "../shared/types";
import { WorldDeltaWriter } from "../shared/world-delta";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let world = createWorld();
let previous = performance.now();
let accumulated = 0;
const writer = new WorldDeltaWriter();
let needsSnapshot = true;
const publish = () => {
  if (needsSnapshot) {
    writer.reset();
    writer.capture(world);
    scope.postMessage({ type: "world", world });
    needsSnapshot = false;
  } else scope.postMessage({ type: "delta", delta: writer.capture(world) });
};
let stepping = false;
const commands: WorkerInput[] = [];
function handleInput(input: WorkerInput) {
  try {
    if (input.type === "load") {
      needsSnapshot = true;
      world = parseWorld(serializeWorld(input.world));
      // Old saved widening orders no longer need to drain, even while paused.
      processPending(world, true);
      world.paused = true;
      previous = performance.now();
      accumulated = 0;
    }
    if (input.type === "command") {
      if (input.command.type === "reset") {
        needsSnapshot = true;
        world = createWorld(input.command.seed);
        previous = performance.now();
        accumulated = 0;
      } else
        scope.postMessage({
          type: "result",
          result: applyCommand(world, input.command),
        });
    }
    if (input.type === "snapshot") needsSnapshot = true;
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
scope.onmessage = (event: MessageEvent<WorkerInput>) => {
  if (stepping) commands.push(event.data);
  else handleInput(event.data);
};
setInterval(async () => {
  if (stepping) return;
  const now = performance.now();
  const elapsed = Math.min(0.25, (now - previous) / 1000);
  previous = now;
  if (!world.paused) {
    stepping = true;
    try {
      accumulated += elapsed * TIME_SCALE * world.speed;
      const steps = Math.floor(accumulated);
      accumulated -= steps;
      if (steps)
        await stepWorldAsync(
          world,
          steps,
          () => new Promise((resolve) => setTimeout(resolve, 0)),
        );
      publish();
    } catch (error) {
      world.paused = true;
      scope.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      publish();
    } finally {
      stepping = false;
      for (const input of commands.splice(0)) handleInput(input);
    }
  }
}, 100);
publish();

import type { World } from "../shared/types";

/** Failures sleep until the available fleet/topology changes or their timer expires.
 * Nothing here owns a reservation or is persisted; importing a save starts fresh. */
export class RetryQueue {
  private stamp = "";
  private failures = new Map<string, number>();
  refresh(world: World): void {
    const stamp = `${world.networkVersion}|${world.pods
      .filter((p) => !p.plan)
      .map((p) => `${p.id}:${p.berthId}`)
      .join(",")}|${world.pendingEdits
      .map((e) => `${e.type}:${e.id}`)
      .join(",")}`;
    if (stamp !== this.stamp) {
      this.stamp = stamp;
      this.failures.clear();
    }
    for (const [key, at] of this.failures)
      if (at <= world.time) this.failures.delete(key);
  }
  ready(key: string, time: number): boolean {
    return (this.failures.get(key) ?? -Infinity) <= time;
  }
  failed(key: string, time: number): void {
    // A bounded fallback also catches time-window openings with no fleet event.
    this.failures.set(key, time + 30);
  }
}

const queues = new WeakMap<World, RetryQueue>();
export function retryQueue(world: World): RetryQueue {
  let queue = queues.get(world);
  if (!queue) {
    queue = new RetryQueue();
    queues.set(world, queue);
  }
  queue.refresh(world);
  return queue;
}

import type { Pod, Reservation, World } from "./types";

type EntityKey = "buildings" | "berths" | "tracks" | "residents";
type Entities = { [K in EntityKey]?: { upsert: World[K]; order: string[] } };
type PodUpdate = Omit<Pod, "plan"> & { plan?: Pod["plan"] };
export interface WorldDelta {
  sequence: number;
  fields: Partial<Omit<World, EntityKey | "pods" | "reservations">>;
  entities: Entities;
  pods?: { upsert: PodUpdate[]; order: string[] };
  reservations?: { order: Int32Array; added: Reservation[] };
}

const entityKeys: EntityKey[] = ["buildings", "berths", "tracks", "residents"];
const reservationKey = (r: Reservation) =>
  `${r.ownerId}\0${r.resource}\0${r.start}\0${r.end}`;

/** Keep the complete authoritative World in the worker. Transmit new plans once,
 * reuse existing reservations by index, and retain unchanged UI object identities.
 * This is lossless: inspectors, exports and autosaves still see the full World. */
export class WorldDeltaWriter {
  private sequence = 0;
  private signatures = new Map<string, string>();
  private plans = new Map<string, Pod["plan"]>();
  private reservations: Reservation[] = [];
  private reservationIndexes = new Map<string, number>();
  private dirty(key: string, value: unknown): boolean {
    const signature = JSON.stringify(value);
    if (this.signatures.get(key) === signature) return false;
    this.signatures.set(key, signature);
    return true;
  }
  reset(): void {
    this.sequence = 0;
    this.signatures.clear();
    this.plans.clear();
    this.reservations = [];
    this.reservationIndexes.clear();
  }
  /** First output is seeded by a normal full snapshot; subsequent ones are deltas. */
  capture(world: World): WorldDelta {
    const delta: WorldDelta = {
      sequence: ++this.sequence,
      fields: {},
      entities: {},
    };
    for (const key of entityKeys) {
      const upsert = world[key].filter((item) =>
        this.dirty(`${key}:${item.id}`, item),
      );
      const order = world[key].map((item) => item.id);
      const reordered = this.dirty(`${key}:order`, order);
      if (upsert.length || reordered)
        (delta.entities as Record<string, unknown>)[key] = { upsert, order };
    }
    const pods: PodUpdate[] = [];
    for (const pod of world.pods) {
      const { plan, ...metadata } = pod;
      const changed = this.dirty(`pods:${pod.id}`, metadata);
      if (!this.plans.has(pod.id) || this.plans.get(pod.id) !== plan) {
        pods.push({ ...metadata, plan });
        this.plans.set(pod.id, plan);
      } else if (changed) pods.push(metadata);
    }
    const podOrder = world.pods.map((p) => p.id);
    const reordered = this.dirty("pods:order", podOrder);
    if (pods.length || reordered)
      delta.pods = { upsert: pods, order: podOrder };
    if (world.reservations !== this.reservations) {
      const added: Reservation[] = [];
      const nextIndexes = new Map<string, number>();
      const order = Int32Array.from(world.reservations, (r, index) => {
        const key = reservationKey(r);
        nextIndexes.set(key, index);
        const previous = this.reservationIndexes.get(key);
        if (previous !== undefined) return previous;
        added.push(r);
        return -added.length;
      });
      delta.reservations = { added, order };
      this.reservations = world.reservations;
      this.reservationIndexes = nextIndexes;
    }
    for (const key of Object.keys(world) as (keyof World)[]) {
      if (
        entityKeys.includes(key as EntityKey) ||
        key === "pods" ||
        key === "reservations"
      )
        continue;
      if (this.dirty(`field:${key}`, world[key]))
        (delta.fields as Record<string, unknown>)[key] = world[key];
    }
    // Entity IDs can grow indefinitely as the player builds/demolishes.
    const live = new Set<string>([
      ...entityKeys.flatMap((key) =>
        world[key].map((item) => `${key}:${item.id}`),
      ),
      ...world.pods.map((p) => `pods:${p.id}`),
    ]);
    for (const key of this.signatures.keys())
      if (
        !key.startsWith("field:") &&
        !key.endsWith(":order") &&
        !live.has(key)
      )
        this.signatures.delete(key);
    const ids = new Set(podOrder);
    for (const id of this.plans.keys()) if (!ids.has(id)) this.plans.delete(id);
    return delta;
  }
}

export function applyWorldDelta(previous: World, delta: WorldDelta): World {
  const world = { ...previous, ...delta.fields };
  for (const key of entityKeys) {
    const update = delta.entities[key];
    if (!update) continue;
    const byId = new Map<string, World[EntityKey][number]>(
      previous[key].map((item) => [item.id, item]),
    );
    for (const item of update.upsert) byId.set(item.id, item);
    (world as unknown as Record<string, unknown>)[key] = update.order.map(
      (id) => {
        const item = byId.get(id);
        if (!item) throw new Error(`Missing ${key} ${id} in delta`);
        return item;
      },
    );
  }
  if (delta.pods) {
    const byId = new Map(previous.pods.map((pod) => [pod.id, pod]));
    for (const update of delta.pods.upsert) {
      const pod = byId.get(update.id);
      if (update.plan === undefined && !pod)
        throw new Error("Missing Pod plan in delta");
      byId.set(update.id, {
        ...update,
        plan: update.plan === undefined ? pod!.plan : update.plan,
      });
    }
    world.pods = delta.pods.order.map((id) => {
      const pod = byId.get(id);
      if (!pod) throw new Error(`Missing Pod ${id} in delta`);
      return pod;
    });
  }
  if (delta.reservations) {
    const { order, added } = delta.reservations;
    world.reservations = Array.from(order, (index) => {
      const reservation =
        index < 0 ? added[-index - 1] : previous.reservations[index];
      if (!reservation) throw new Error("Missing reservation in delta");
      return reservation;
    });
  }
  return world;
}

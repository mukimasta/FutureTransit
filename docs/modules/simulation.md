# Simulation

`src/simulation/index.ts` owns the deterministic game state. The worker should call
`advanceGame(game, integerSeconds)`; the clock belongs outside this module. One real
second normally represents six simulation seconds, multiplied by the snapshot speed.

## Public API

`createGame(seed?)`, `advanceGame`, `applyCommand`, `getSnapshot`, `serializeGame`, and
`deserializeGame` are the complete public surface. Snapshots are freshly constructed
serializable values, so rendering code cannot mutate the game.

## Model and tuning

Buildings begin without a 楼宇接入口. `addPort` costs 90 and places the actual
connection coordinate 24 world units on the selected side; player-built junctions cost
70 and are immediately usable. Buildings can only be route endpoints, while junctions
carry through traffic. `drawTrack` delegates all geometry and split planning to
`src/network`; the simulation validates cash and reservations then applies its whole plan
atomically. Edges use `connectionInfo` cost and time. Each node has 1--3 physical ports
and each edge has 1--3 physical lanes. A reservation holds one resource over a half-open travel
interval plus one second of clearance. A route is stable Dijkstra; the scheduler finds
one departure at which *all* path reservations fit, then commits them atomically.

Pods must reserve an empty journey to the passenger before reserving the customer
journey; they never change location outside a journey. Empty travel costs `0.12` cash
per simulation second (minimum 1); customer revenue equals fare. Demand arrives every
9 seconds after service starts, with an independent all-mode departure count. Pod choice
uses route time and fare; market share is started customer journeys / all-mode departures
(including departures still waiting, never empty repositioning). Expenses are the combined
construction and empty-operation total.
Requests abandon after 170 seconds and the queue is capped at 72. The fixed seeded OD
mix never depends on built links (n1 to c1 is 30% for a reliable first corridor).
`Snapshot.demandFlows` groups genuine generated ODs from the last 300 seconds, and its
waiting count includes both queued customers and assigned customers who have not started.

Builds charge the shared connection cost; pods cost 180, building access ports cost 90,
port upgrades 380 and lanes 480.
Mission rewards (450, 650, 700, 1000, 850, 900) keep a 10-minute expansion session
solvent. Concerts unlock on a repeating 360-second cycle and produce a 90-second arena
demand burst. Growth increments modestly for completed destination service.

The mode-choice RNG and the OD RNG are separate, so fare, availability and dispatch
cannot perturb the future city OD sequence. Saves include both RNG streams, dynamic
node metadata, calendars,
queues, generated OD history and in-flight journeys. Loading rejects malformed
or oversized game state rather than attempting to repair it.

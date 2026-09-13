# Peak-load optimization — MVP v0.0.10

## Reproduce

`node scripts/benchmark-peak.mjs /path/to/save.json 120`

The runner reads, never overwrites, the supplied save. It bundles a temporary Node diagnostic, advances a separate in-memory city, measures simulation separately from lossless worker-message generation/copy/application, and validates the final reconstructed save. It does not measure browser frame rate. Optional `undefined` fields are compared using JSON persistence semantics.

## September 13, 2026 observation

Input: `future-transit-7-1509.json`, city time 461382, 736 residents, 113 Pods, 934 tracks, 262 berths, 29,419 reservations. Baseline commit: `860ec98` (v0.0.9). Baseline included 112 committed Pods and one idle Pod on a parking berth queued for demolition.

For the next 120 city seconds, baseline simulation required ~94,971 ms. The optimized simulation measured ~7,300–8,634 ms across local runs (roughly 11–13×); both completed 11 passenger journeys and ended with 85 unassigned waiting residents. The final reproducible runner reported 8,634 ms, a 1,354 ms worst synchronous step, and 712 ms P95. This does **not** prove identical long-run demand outcomes: bounded failure retries can defer a newly feasible request by up to 30 city seconds, and evacuation now actually occurs. Do not present these figures as a browser FPS multiplier or a guarantee for every city.

Lossless deltas averaged ~622 KB as diagnostic JSON (~18× below the ~11.26 MB full snapshot) and ~3.3 ms to structured-clone versus ~60–100 ms for the full city. The actual reservation index packet is a typed array, not JSON. First load/reset deliberately sends a full snapshot. Generating a delta costs ~8 ms and applying it costs ~0.4 ms in this experiment; these costs must not be hidden when evaluating frame budget.

## Changes and boundaries

- **Evacuation:** a pending berth may be the origin of its occupant's evacuation, but not the target, pickup or dropoff. Pending tracks and other pending facilities are still excluded. Ordinary dispatch does not offer a Pod parked in a pending facility. Evacuation only chooses uncommitted parking. Existing journeys still drain before demolition.
- **Retry events:** failed station/destination requests and failed evacuations sleep. Available fleet, topology or pending-edit changes wake them; a maximum 30-city-second retry interval handles moving planning windows. The queue is ephemeral, bounded by live/expiring requests, and rebuilt after import. It holds no physical resources. Passenger timeout checks precede the retry gate.
- **Geometry:** bounded route/template caches survive clock ticks but invalidate on topology/berth changes. Compiled relative reservation windows are reused; dynamic calendars and final trajectory/reservation validation remain authoritative. Cached windows are read-only. No segment capacity or safety buffer is removed.
- **Cooperative scheduling:** the worker yields between expensive pairing evaluations and simulation steps, without advancing city time merely to skip work. Commands queue until the current step transaction finishes. The synchronous benchmark and cooperative runner retain the same calculation order. A single pairing can still be expensive: the 8 ms yielding threshold is not a hard upper bound on a slice, and published snapshots still wait for a coherent transaction boundary.
- **Transport:** worker sends changed entities, changed Pod plans only once, and reservation reuse indexes. The UI retains a complete city, including all residents, plans and reservations; existing inspectors, JSON exports and local autosaves continue to work. Sequence gaps request a new full snapshot. Unchanged geometry retains identity, helping React memoization.

## Verification / remaining limits

- Focused scheduler, fleet, integration, construction, demolition, motion, persistence and new delta/retry/evacuation tests pass.
- 53 focused tests and the production build passed. A Node worker-thread smoke test executed the actual bundled worker through load, run, incremental frames, queued pause, and snapshot resynchronization: 30 city seconds / 18 delta frames; the reconstructed city matched the authoritative snapshot and passed persistence validation. This is protocol verification, not browser visual QA.
- The peak-save reconstruction passes persistence trajectory validation; full long-run/browser acceptance remains separate.
- Existing `adversarial.test.ts` case “leaves the complete world unchanged when a capacity-breaking edit fails” already fails on unmodified `860ec98`: its fixture removes a platform while retaining one parking bay for one Pod. It assumes the retired spare-turnover rule. This optimization does not change that test or reintroduce the rule.
- A trial hard cap of 12 pairing calls per dispatch reduced computation further but left 14 Pods idle and increased unassigned waiting to 108. It was rejected; do not trade service away to advertise speed.
- Remaining hot spots include expensive individual pairing searches, full metric deltas, main-thread autosave serialization, and SVG/React rendering. No claim of universally smooth 8× operation is made.

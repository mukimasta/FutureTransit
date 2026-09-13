# Peak-load optimization — MVP v0.0.11

## v0.0.11 morning dispatch: proof-based pruning

Input: `future-transit-7-0852.json`, time 525153, 736 residents, 147 Pods (86 idle), 1,012 tracks and 10,898 reservations. Two three-lane tracks are pending demolition. Baseline is `71d3d8d` (v0.0.10).

The earlier instrumented 12-city-second baseline made 3,537 feasible service computations, then rejected 3,492 (98.7%) because they touched pending construction. It made 69,303 departure searches and built 373 calendars. These are pre-change profiling results, not counters collected by the normal benchmark.

For 120 city seconds, baseline simulation took 81,366 ms (worst step 7,585 ms); the new implementation measured 3,535 and 3,633 ms across two local runs, approximately 22–23× faster. Both baseline and optimized completed 13 deliveries. Unassigned waiting at the end improved from 5 to 0; optimized idle Pods: 73. Final optimized worst step was 1,128 ms and P95 was 120 ms. Delta capture/clone/apply averaged 5.21/1.52/0.17 ms and ~323 KB diagnostic JSON. Both runs passed lossless reconstruction and final-save trajectory validation. A cold individual search can still stall simulation for over a second; this is not a browser FPS claim or a guarantee for every network.

### Search contract

- Pair idle Pods with destination stations and sort by optimistic door-to-door arrival: current time + shortest empty travel + boarding + shortest loaded travel + alighting + egress walk. All waiting/conflict costs are nonnegative. Once the next lower bound cannot beat the incumbent actual arrival, all later pairs can be skipped.
- Subtract a candidate station's egress time before passing the exclusive drop-off deadline into `planService`. Route free-flow bounds, per-lane shared-prefix departure floors, terminal-group floors, and departure-window deadlines prune internally. Prune terminal groups **before** constructing their templates. Unknown prefix bounds prove nothing and do not prune. Equal door-to-door arrivals need not replace the caller's incumbent; internal searches retain secondary parking/lane tie handling.
- No fleet-size cap and no first-feasible shortcut. Removed the old cross-Pod failed-ride heuristic and the service detour shortcuts that assumed a failed shortest route ruled out detours or that one winning parking berth was sufficient for every detour.
- Optimality here concerns the scheduler's **supported candidates**, not every possible city route or a globally optimal fleet schedule. Existing route-option generation, single-leg detour combinations, three lane profiles, shortest parking legs, 1,800-second planning window and bounded departure-search iterations remain. Requests are still handled in waiting order; the existing retry policy remains.
- Pending track/node closures enter a cached navigation-only view. Actual trajectories, safety resources, calendar conflicts and atomic commits still use the physical world. Existing plans are untouched. Pending-berth occupants may still evacuate from their own origin, but ordinary service cannot use pending berths. Cancellation/topology changes invalidate the view.
- Build one shared calendar per planning state, then rebuild only resources carrying the queried Pod's own commitments. Other Pods' finite reservations and indefinite terminal holds remain. Clock, fleet-plan/berth, topology, pending edits and reservation changes invalidate dynamic results. A bounded failure uses a distinct cache key and cannot poison an unbounded query. Production reservation-content updates continue to use replacement arrays; in-place length changes are also detected.

### Verification

- `node scripts/audit-service-pruning.mjs`: builds a separate reference bundle with service arrival pruning, prefix floors and incumbent departure cutoffs disabled, enumerating the existing route/terminal/lane candidates. All 48 Pod cases across 24 seeded single/shared-lane and congestion fixtures matched reference feasibility/earliest arrival; cross-Pod incumbent results matched exhaustive evaluation. This is differential testing, not an independent implementation of route generation or reservation safety.
- Added regressions for a completely blocked shortest route with a usable detour, deadline cache isolation, cutoff equality, pending-track exclusion/cancellation, preservation of active plans, own-versus-other calendar occupancy and in-place reservation insertion.
- Full suite: 166 passed, one known pre-existing failure in `adversarial.test.ts` expecting the retired spare-turnover rule (detailed below). No new failures. All 61 focused scheduler/integration/fleet/construction/demolition/motion/persistence/delta tests passed, as did the pruning audit, type checking, GitHub Pages build and local-root build. Local preview output is restored to the root base path.
- The previous `future-transit-7-1509.json` is no longer present at its supplied Downloads path, so its v0.0.11 regression could not be rerun. The afternoon results below are historical v0.0.10 results, not measurements of this release.

## v0.0.10 retained measurement record

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

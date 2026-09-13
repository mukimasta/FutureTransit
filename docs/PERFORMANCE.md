# Peak-load optimization — MVP v0.0.12

## v0.0.12 morning dispatch: stop re-proving the impossible

Input: `future-transit-7-0911.json`, city time 526311, 736 residents, 147 Pods (51 idle), 1,010 tracks, 304 berths (82 platforms, 222 parking) and 20,831 reservations. 467 of the tracks carry three lanes. Baseline is `cb07063` (v0.0.11).

### What the morning was actually spending on

Measured on the baseline: a dispatch pass ran every 3 city seconds and cost ~4,250 ms. It handled **2.8 requests** and made **394 service computations**, of which **3 succeeded**. Every one of the 2,362 failures returned `track-busy`, and every one of the 36,918 departure searches inside them ended by running out of planning window rather than by hitting a held resource: plans on this map run 900–1,350 seconds, leaving 450–900 seconds of slack in the 1,800-second window, and congestion consumed it. The city was not short of Pods — 96 were mid-journey and 51 idle. It was short of room, for a handful of people, and it re-derived that for the whole fleet several times a minute.

Two negative results came first and are recorded because they cost measurement time:

- A fleet-wide feasibility gate on the ride alone (board, loaded run, alight), scanned against a calendar with every idle Pod's own holds removed — a strict subset of every idle Pod's calendar, so anything it refuses none of them can accept. Sound, and it **never fired**: the rides fit; the empty run and the park after them are what did not. Adding the shortest possible parking leg to the bound moved its median from 1,546 to 1,718 seconds against an 1,800-second window, still under. It cost more than it saved (4,517 ms vs 4,174 ms over 60 city seconds) and was removed.
- Gating detours on the resources that held the shortest route up, in either the loose form or the form that only counts blockers on the leg being replaced. Both passed **every** detour: in a jam the blocker set spans the whole route and any other way round avoids some of it.

### Changes

- **Two dispatch waves.** The fleet is asked with shortest routes first. Ways round are offered afterwards, to the three most promising pairings, and only where the direct wave found nothing or found a plan more than 60 seconds worse than free-flow. `planService` takes a route scope (`all`, `direct`, `detours`); `detours` resumes at the second pairing because the first was already priced under a deadline no looser. Detour generation, the three lane profiles and the single-leg-at-a-time rule are unchanged.
- **Candidate quotas.** One request prices at most 12 Pod/station pairings directly plus 3 diverted; one pass prices at most 24 before leaving the rest to the next pass, three city seconds later. Ordering is still by optimistic door-to-door arrival and the queue still runs longest-waiting first, so a deferred request keeps its place. Measured on this save: of 17 direct-wave successes, 11 came from the first pairing, 14 from the first three, and none from beyond the eighth.
- **Terminal cap.** A service weighs the 12 parking berths nearest the drop-off, plus the berth the Pod already occupies. This is what removed the worst individual calls: before it, a single plan could walk all 76 usable bays for 152 searches and 228 templates, 75 ms in one call. Of 23 committed plans, 21 parked at the nearest bay, one at the third and one at the ninth.
- **Reason-aware retry.** A request waiting on a Pod (`no-pod`, `disconnected`) still wakes the moment the idle fleet moves. A request waiting on a corridor or a parking row does not: another Pod parking across the city leaves the jam as it was, and waking every such request on every arrival is what made the baseline re-price the fleet on almost every pass. Those wake on the clock, on the network version and on pending edits. The interval is 20 city seconds plus a per-request spread of up to 20 more, so requests that failed together do not all return in the same pass.
- **Openings keyed by geometry.** What a service owes up to the moment the passenger steps out cannot see past the alighting dwell, so it is now cached on the two legs, the two platforms and the lane instead of on one terminal's segment array — shared across terminals, across both waves, and across every Pod and request that takes the same legs.
- **Calendars read through.** A Pod's calendar is the shared table plus its own differences, rather than a copy of a table with thousands of entries per query.

### Measurements

240 city seconds, `node scripts/benchmark-service.mjs`:

|                                    | v0.0.11                     | v0.0.12                     |
| ---------------------------------- | --------------------------- | --------------------------- |
| simulation                         | 122,994 ms                  | 2,387 ms                    |
| per city second                    | 512.5 ms                    | 9.9 ms                      |
| worst step                         | 5,551 ms                    | 302 ms                      |
| p90 / p99 step                     | 1,896 / 5,360 ms            | 35 / 106 ms                 |
| steps over 66 ms                   | 41 of 240                   | 13 of 240                   |
| journeys completed by Pod          | 26                          | 26                          |
| journeys that fell back to walking | 4                           | 4                           |
| wait mean / p50 / p90 / max        | 283.5 / 305 / 518.8 / 530 s | 283.5 / 305 / 518.8 / 530 s |
| riding at the end                  | 39                          | 39                          |
| unassigned waiting at the end      | 3                           | 4                           |

Every passenger-visible figure but the last two is identical: over four city minutes the quotas and the cap never changed a dispatch decision on this save. The two that differ are one resident and one Pod at the sampling instant.

120 city seconds through `node scripts/benchmark-peak.mjs`: 1,570 ms, worst step 307 ms, P95 81 ms, 12 deliveries, lossless delta reconstruction and final-save trajectory validation both passing.

### What this does and does not claim about 1×

At 1× the worker advances 1.5 city seconds per 100 ms tick, so the sustainable cost is about 60 ms per city second once delta capture (6.1 ms per frame here) is paid. This save now averages 9.9 ms per city second, about a sixth of that. It is not uniform: dispatch runs every 3 city seconds and carries essentially all of the cost, so a dispatch pass of 35–106 ms lands inside one tick every second or two. Loading a jammed save and pressing play still costs one pass of ~300 ms, with every cache cold and every waiting request due at once.

This is a simulation-cost measurement in Node. It is not a browser frame rate, and 8× remains several times over budget on a city this size.

### Reproduce

```
node scripts/benchmark-peak.mjs /path/to/save.json 120     # simulation and worker deltas
node scripts/benchmark-service.mjs /path/to/save.json 240  # what the passengers got
node scripts/audit-service-pruning.mjs                     # differential pruning audit
```

Both runners read the supplied save and never write it. `benchmark-service.mjs` advances a separate in-memory city and reports completed journeys, walking fallbacks and the wait distribution alongside the step timings, so a speed change can be checked against what it cost the passengers.

### Verification

- Full suite: 168 passed, one known pre-existing failure in `adversarial.test.ts` (detailed below) that also fails on unmodified `cb07063`.
- New regressions: the direct and diverted waves together reproduce what one unscoped call produced on a blocked corridor, and a service still plans and commits where the drop-off has far more parking bays than it may weigh.
- `node scripts/audit-service-pruning.mjs` still passes on all 48 Pod cases. Note what it now covers: it rewrites `computeService`, so it certifies that the internal arrival, floor and cutoff pruning is exact **for the candidate set it is given**. The terminal cap and the dispatch quotas sit outside that function and apply to both bundles, so the audit no longer certifies the candidate set is exhaustive. Those are deliberate trades, and the evidence for them is the service comparison above plus the measured win distributions, not a proof.
- Type checking and the production build pass.

## v0.0.11 retained measurement record

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

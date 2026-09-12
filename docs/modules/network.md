# Network planning module

`planTrack(nodes, edges, points)` is a pure planner. It returns the exact nodes
and edges to add, the existing edges to replace, and their cost; it never edits
the snapshot passed to it. The simulation must check cash and live reservations,
then commit the entire plan as one transaction.

Points with `nodeId` snap only to a built building port or existing junction.
Points with `edgeId` project onto that edge and replace it with zero-cost pieces
that retain its level, trips, and proportional travel time. Every ordinary point
becomes a new `jN` junction, charged at `ECONOMY.junctionCost`; every new link
uses `connectionInfo` with its actual endpoint coordinates.

New junctions use the simulation's save-safe bounds: 40 units inside each world
edge and outside the inclusive canal strip `770 <= x <= 900`. The planner
rejects invalid coordinates, water waypoints, building overlaps,
through-building segments, repeated points/links, short segments, unbuilt ports,
and duplicate connections. A crossing of an existing edge only connects when the
user explicitly supplies that edge's `edgeId`; other geometric crossings are
grade-separated and do not create a junction.

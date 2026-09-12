# Free track interaction module

`src/interaction` owns only local drawing intent. It creates no junctions and
sends no game command while the player is clicking. A draft can begin on empty
ground, a built building entrance, an existing junction, or an existing track.

`draftStatus(snapshot, draft)` calls the pure network planner only after the
second point. Its result is used for the on-map ghost and the short cost or
invalid-reason label beside the bottom controls. A point on an existing edge
retains its projected world coordinate and `edgeId`, so the committed command
can split that exact edge. The UI forwards both values from the renderer's edge
callback; it never derives a second coordinate from the browser viewport.

The UI appends a waypoint for every free-map click. Clicking a built building
or junction appends it and commits one `drawTrack` transaction; Enter commits a
two-or-more-point free route. Escape cancels and Backspace removes the last
point without affecting cash. Save, load, reset, and a snapshot that no longer
contains a snapped node or edge clear the draft.

Unported buildings stay selectable while drawing. Their contextual card lets a
player choose north, east, south, or west before issuing `addPort`. An edge's
contextual card can issue `removeEdge`; the simulation remains responsible for
rejecting removal while booked vehicles are using it.

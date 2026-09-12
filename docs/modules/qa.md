# QA boundaries

`tests/adversarial.test.ts` covers the boundaries that ordinary gameplay tests
do not expose: rejected drawings must be atomic; every in-flight segment must
have its matching physical resource reservation; upgraded lanes preserve live
reservations; and malformed local saves must be rejected before entering a live
game.

Save validation treats dynamic junction coordinates as construction data. They
must remain inside the planner's safe world area, stay outside the canal, and
not overlap a building. Fractional coordinates are valid when an edge snap
projects onto a free-form track. Counters must describe a possible service
history so dashboard ratios remain bounded.

Calendar self-audits alone are insufficient: an overlap-free calendar can still
omit a journey booking or point it at a different trip. Validation therefore
must verify both directions of the journey/calendar correspondence. The
one-second clearance retained after a completed journey is a valid exception;
the save/load lifecycle test covers that boundary at every simulation tick.

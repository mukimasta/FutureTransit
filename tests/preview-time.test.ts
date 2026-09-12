import { describe, expect, it } from "vitest";
import { previewPoints } from "../src/network/preview";
import { validateTrackDraft } from "../src/network";
import { createWorld } from "../src/simulation";
import { formatClock } from "../src/shared/selectors";
import { TIME_SCALE } from "../src/shared/constants";

describe("candidate track previews", () => {
  it("previews from the last pinned point without committing the pointer", () => {
    const draft = [{ x: 2, y: 25 }];
    const preview = previewPoints(draft, { x: 6, y: 28 });
    expect(draft).toHaveLength(1);
    expect(preview).toHaveLength(2);
    const w = createWorld();
    expect(validateTrackDraft(w, preview).edges).toHaveLength(4);
    expect(previewPoints(draft, draft[0])).toEqual(draft);
    expect(previewPoints(draft, null)).toEqual(draft);
    expect(previewPoints([], { x: 6, y: 28 })).toEqual([]);
  });
  it("uses the same geometry validation as committed construction", () => {
    const w = createWorld();
    expect(
      validateTrackDraft(w, previewPoints([{ x: 10, y: 18 }], { x: 16, y: 18 }))
        .error,
    ).toBeTruthy();
  });
});
describe("ten-minute presentation clock", () => {
  it("only rounds the display and preserves precise arrival timestamps", () => {
    expect(TIME_SCALE * 30).toBe(600);
    expect(formatClock(599, 10)).toBe("07:00");
    expect(formatClock(600, 10)).toBe("07:10");
    expect(formatClock(599)).toBe("07:09");
    expect(formatClock(17 * 3600, 10)).toBe("00:00");
  });
});

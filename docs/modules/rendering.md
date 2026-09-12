# Rendering module

`src/rendering/index.ts` owns the PixiJS city map. It consumes a serializable `MapState` and only emits pointer intent through `MapCallbacks`; it never changes simulation state or applies game rules.

The renderer draws a deterministic, vector-only paper map from the snapshot. `src/rendering/buildings.ts` owns stable building footprints, semantic tints, and their small silhouettes: sage-teal homes, terracotta offices, blue-lavender universities, and coral leisure venues. Each building gets an off-white window treatment and a subtle offset shadow. Every visible building footprint is one selectable `NodeView`; there are no anonymous decorative building blocks. `buildingBox()` is also used by stage-level picking, so painting changes cannot shift the input bounds. A building has no transit symbol until `portBuilt`; its small entrance marker is drawn exactly at `portX`/`portY`. Dynamic `junction` nodes render as routing dots, and network endpoints always use the snapshot coordinates rather than scenario lookups. Demand arcs come only from `snapshot.demandFlows` OD pairs.

Pods cache their status shape and the ticker updates only their transform. They interpolate between ordinary live snapshots, then snap on a pause, a time rewind, or a large position discontinuity caused by loading/resetting a save.

Controls are direct manipulation: drag the empty map to pan, scroll to zoom around the pointer, click any building footprint or its 12-world-unit track corridor to select it, and click the empty map with its world coordinate. A drag suppresses building and track clicks. The junction tool shows a placement ghost. The build tool renders `MapState.draft` as a free polyline and adds a live ghost segment to the pointer; draft node points resolve to their port coordinates. Track clicks return a closest projected world coordinate for split/snapping. `resetCamera()` restores the fitted city frame and `destroy()` disconnects the observer, wheel listener and Pixi ticker before releasing the canvas.

## 集成修正

指针输入集中在稳定的 stage，通过世界坐标命中楼宇/接入口/轨道。建筑高亮重绘不能销毁按下时的输入目标；轨道选择带回投影点，用于准确分岔。扩容轨道根据 level 增宽，并显示对应的通道线纹。

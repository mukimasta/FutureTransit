# UI module

`src/ui/App.tsx` is the React gameplay shell. It receives a serializable `Snapshot` and forwards every gameplay action to the host through `onCommand`; it never changes simulation state itself.

## Public interface

```ts
App({ snapshot, onCommand, onSave, onLoad, onReset })
```

The map is mounted with `createMapRenderer(host, callbacks)`. The UI sends a `MapState` whenever snapshot, selection, overlay, tool, language, or build origin changes. Renderer callbacks select nodes/edges, begin or continue a build, and supply the hover endpoint used with `connectionInfo()` for cost previews.

## Interaction

- Build: select **Build**, click an origin then a destination. A successful command retains the destination as the next origin, so routes can be chained. `Esc` cancels.
- Buildings are the map's primary objects. An unported building opens its contextual entrance card; the player chooses N/E/S/W and sends `addPort` before it can be connected. The junction tool sends `addJunction` with the map background coordinate.
- `Space` toggles time, `B` enters Build, and `1`, `2`, `3` select 1×, 3×, and 8×. Simulation time is shown from 07:30 using `simTime / 60`; connection travel times are seconds.
- Save/load/reset call the supplied host functions. Reset has a lightweight confirmation because it discards the current local run.
- Map zoom and fit call the renderer directly. All economics, upgrades, service opening, and events issue commands.

## Bilingual behavior

The initial language is Chinese and persists as `future-transit-language` in local storage. The language toggle updates static UI copy, browser title, ARIA labels, toast fallback messages, and all `Localized` scenario/snapshot fields immediately. The contract's `Localized` values remain the source of dynamic names and descriptions.

The map is full-bleed. Mission, event, operation, and time controls are floating layers; detailed operation and save controls stay behind the compact control popover. The selected building or connection is the only persistent detail card.

// Differential audit: enumerate every supported route/terminal/lane profile in
// a separate bundle with service pruning disabled. No production test switches.
import { build } from "esbuild";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "futuretransit-pruning-audit-"));
const source = `
export { planService, commitPlan } from './src/scheduler';
export { createWorld } from './src/simulation';
export { trackResources } from './src/network';
`;
async function bundle(reference) {
  const outfile = join(
    directory,
    reference ? "reference.mjs" : "optimized.mjs",
  );
  await build({
    stdin: { contents: source, resolveDir: root, loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    plugins: reference
      ? [
          {
            name: "exhaustive-service-reference",
            setup(b) {
              b.onLoad({ filter: /\/scheduler\/index\.ts$/ }, (args) => {
                let contents = readFileSync(args.path, "utf8");
                const start = contents.indexOf("function computeService(");
                const end = contents.indexOf(
                  "export function planRelocation",
                  start,
                );
                assert(
                  start >= 0 && end > start,
                  "Service boundaries changed; update audit",
                );
                let service = contents.slice(start, end);
                function replace(pattern, replacement) {
                  assert(
                    pattern.test(service),
                    `Audit replacement missing: ${pattern}`,
                  );
                  service = service.replace(pattern, replacement);
                }
                replace(
                  /const cannotImprove = [\s\S]*?;\n/,
                  "const cannotImprove = () => false;\n",
                );
                replace(/scope.length > 1/, "false");
                replace(
                  /if \(floor === null && bounds.length === 3\)/,
                  "if (false)",
                );
                // Ignore incumbent deadlines inside departure search, too.
                replace(
                  /Math.min\(\s*latestArrival,[\s\S]*?\)\s*-\s*template.dropoffEnd,/,
                  "Infinity,",
                );
                contents =
                  contents.slice(0, start) + service + contents.slice(end);
                return { contents, loader: "ts" };
              });
            },
          },
        ]
      : [],
  });
  return import(pathToFileURL(outfile).href);
}
const optimized = await bundle(false),
  reference = await bundle(true);
function fixture(seed) {
  const w = optimized.createWorld(seed);
  w.time = 0;
  w.pendingEdits = [];
  w.reservations = [];
  w.tracks = [];
  const add = (ax, ay, bx, by) =>
    w.tracks.push({
      id: `${ax},${ay}~${bx},${by}`,
      a: { x: ax, y: ay },
      b: { x: bx, y: by },
      lanes: (seed % 3) + 1,
      paid: 0,
    });
  for (let x = 1; x < 10; x++) {
    add(x, 2, x + 1, 2);
    add(x, 4, x + 1, 4);
  }
  for (const x of [1, 10]) {
    add(x, 2, x, 3);
    add(x, 3, x, 4);
  }
  const berth = (id, kind, x, y, ax, ay) => ({
    id,
    kind,
    point: { x, y },
    access: { x: ax, y: ay },
    side: "south",
    paid: 0,
  });
  w.berths = [
    berth("A", "platform", 0, 2, 1, 2),
    berth("B", "platform", 11, 2, 10, 2),
  ];
  for (const x of [2, 3, 8, 9]) {
    w.berths.push(berth(`P${x}`, "parking", x, 0, x, 1));
    add(x, 1, x, 2);
  }
  w.pods = [2, 3].map((x) => ({
    id: `pod${x}`,
    berthId: `P${x}`,
    parkedSince: 0,
    plan: null,
    trips: 0,
    paid: 0,
  }));
  w.networkVersion++;
  let rng = seed;
  const random = () =>
    (rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < 12; i++) {
    const track = w.tracks[Math.floor(random() * w.tracks.length)];
    const start = Math.floor(random() * 240);
    const end = start + (seed % 7 === 0 ? 10_000 : Math.floor(random() * 400));
    for (const resource of optimized.trackResources(w, track))
      w.reservations.push({ resource, ownerId: `block${i}`, start, end });
  }
  return w;
}
let checked = 0;
for (let seed = 1; seed <= 24; seed++) {
  const w = fixture(seed);
  const a = w.berths[0],
    b = w.berths[1],
    rider = w.residents[0];
  let winner;
  // Enumerate Pods independently in the reference. The optimized calls carry
  // a shrinking incumbent cutoff, as dispatch does.
  const expected = w.pods
    .map((pod) => reference.planService(structuredClone(w), pod, rider, a, b))
    .filter((result) => result.ok)
    .sort((a, b) => a.plan.dropoffEnd - b.plan.dropoffEnd)[0];
  for (const pod of w.pods) {
    const full = optimized.planService(w, pod, rider, a, b);
    const exhaustive = reference.planService(
      structuredClone(w),
      pod,
      rider,
      a,
      b,
    );
    assert.equal(full.ok, exhaustive.ok, `feasibility seed ${seed}`);
    if (full.ok) {
      assert(
        Math.abs(full.plan.dropoffEnd - exhaustive.plan.dropoffEnd) < 1e-7,
        `arrival seed ${seed}`,
      );
      optimized.commitPlan(structuredClone(w), full.plan);
    }
    const result = optimized.planService(
      w,
      pod,
      rider,
      a,
      b,
      winner?.plan.dropoffEnd ?? Infinity,
    );
    if (result.ok) winner = result;
    checked++;
  }
  assert.equal(
    winner?.plan.dropoffEnd,
    expected?.plan.dropoffEnd,
    `fleet winner seed ${seed}`,
  );
}
console.log(
  `Pruning audit passed: ${checked} Pod cases across 24 seeded single/shared-lane networks; exhaustive supported-candidate arrival matches.`,
);

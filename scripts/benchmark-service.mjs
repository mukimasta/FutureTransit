// Service-quality comparison: what a change does to the passengers, not the
// clock. Reads the supplied save, never writes it.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const save = process.argv[2];
const seconds = Number(process.argv[3] ?? 240);
if (!save || !Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
  throw new Error(
    "Usage: node scripts/benchmark-service.mjs /path/to/save.json [1..3600 city seconds]",
  );
const root = fileURLToPath(new URL("../", import.meta.url));
const out = join(
  mkdtempSync(join(tmpdir(), "futuretransit-service-")),
  "runner.mjs",
);
await build({
  stdin: {
    resolveDir: root,
    loader: "ts",
    contents: `
    import { readFileSync } from 'node:fs';
    import { parseWorld } from './src/persistence';
    import { stepWorld } from './src/simulation';
    const world = parseWorld(readFileSync(${JSON.stringify(resolve(save))}, 'utf8'));
    world.paused = false;
    const before = { served: world.metrics.served, walked: world.metrics.walked, wait: world.metrics.totalWait };
    const trips = new Map();
    const samples = [];
    for (let i=0;i<${seconds};i++){
      const t=performance.now(); stepWorld(world,1); samples.push(performance.now()-t);
      for (const trip of world.metrics.recentTrips)
        trips.set(trip.residentId+'@'+trip.startedAt, trip);
    }
    const fresh = [...trips.values()].filter(t => t.endedAt > world.time - ${seconds});
    const pod = fresh.filter(t => t.mode === 'pod');
    const walk = fresh.filter(t => t.mode === 'walk');
    const waits = pod.map(t => t.waited ?? 0).sort((a,b)=>a-b);
    const total = samples.reduce((a,b)=>a+b,0);
    samples.sort((a,b)=>a-b);
    console.log(JSON.stringify({
      citySeconds:${seconds},
      ms:+total.toFixed(0), perCitySecond:+(total/${seconds}).toFixed(1),
      worst:+samples.at(-1).toFixed(0), p90:+samples[Math.floor(samples.length*0.9)].toFixed(0),
      p99:+samples[Math.floor(samples.length*0.99)].toFixed(0), over66:samples.filter(x=>x>66).length,
      servedDelta: world.metrics.served-before.served,
      walkedDelta: world.metrics.walked-before.walked,
      trips: { pod: pod.length, walk: walk.length },
      wait: waits.length ? { mean:+(waits.reduce((a,b)=>a+b,0)/waits.length).toFixed(1), p50:+waits[Math.floor(waits.length/2)].toFixed(1), p90:+waits[Math.floor(waits.length*0.9)].toFixed(1), max:+waits.at(-1).toFixed(1) } : null,
      unassignedWaiting: world.residents.filter(r=>r.status==='waiting'&&!r.journey?.podId).length,
      riding: world.residents.filter(r=>r.status==='riding').length,
      idlePods: world.pods.filter(p=>!p.plan).length,
      cash: Math.round(world.economy.cash),
    },null,2));
  `,
  },
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
});
await import(pathToFileURL(out).href);

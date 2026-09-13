import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const save = process.argv[2];
const seconds = Number(process.argv[3] ?? 120);
if (!save || !Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
  throw new Error(
    "Usage: node scripts/benchmark-peak.mjs /path/to/save.json [1..3600 city seconds]",
  );
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(
  mkdtempSync(join(tmpdir(), "futuretransit-benchmark-")),
  "runner.mjs",
);
await build({
  stdin: {
    resolveDir: root,
    loader: "ts",
    contents: `
    import { readFileSync } from 'node:fs';
    import { isDeepStrictEqual } from 'node:util';
    import { parseWorld, serializeWorld } from './src/persistence';
    import { stepWorld } from './src/simulation';
    import { WorldDeltaWriter, applyWorldDelta } from './src/shared/world-delta';
    const world = parseWorld(readFileSync(${JSON.stringify(resolve(save))}, 'utf8'));
    world.paused = false;
    const writer = new WorldDeltaWriter();writer.capture(world);
    let view = structuredClone(world);
    const samples = [], frames = [];
    const initial = {time:world.time,served:world.metrics.served};
    for(let i=0;i<${seconds};i++) {
      let at=performance.now();stepWorld(world,1);samples.push(performance.now()-at);
      at=performance.now();const delta=writer.capture(world);const capture=performance.now()-at;
      at=performance.now();const packet=structuredClone(delta);const clone=performance.now()-at;
      at=performance.now();view=applyWorldDelta(view,packet);const apply=performance.now()-at;
      frames.push({capture,clone,apply,bytes:JSON.stringify(delta).length});
      if(i%30===29)console.log('City seconds:',i+1);
    }
    // Persistence semantics: absent optional properties and undefined are equivalent.
    const lossless = isDeepStrictEqual(JSON.parse(JSON.stringify(view)),JSON.parse(JSON.stringify(world)));
    if(!lossless)throw new Error('Worker delta lost city data');
    parseWorld(serializeWorld(view));
    samples.sort((a,b)=>a-b);
    console.log(JSON.stringify({citySeconds:${seconds},simulationMs:samples.reduce((a,b)=>a+b,0),
      worstStepMs:samples.at(-1),p95StepMs:samples[Math.floor(samples.length*.95)],
      servedDelta:world.metrics.served-initial.served,
      unassignedWaiting:world.residents.filter(r=>r.status==='waiting'&&!r.journey?.podId).length,
      idlePods:world.pods.filter(p=>!p.plan).length,
      averageFrame:Object.fromEntries(Object.keys(frames[0]).map(k=>[k,frames.reduce((n,f)=>n+f[k],0)/frames.length])),
      lossless,snapshotValidated:true},null,2));
  `,
  },
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
});
await import(pathToFileURL(output).href);

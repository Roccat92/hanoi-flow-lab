import { loadData } from './loadData';
// Engine benchmark: npx tsx scripts/bench.ts  -> results/bench.json
// Fills the network to a target vehicle count (demand x scale, active cap) and measures step time.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { Simulation } from '../src/engine/sim';
const data = loadData();
const targets = (process.argv[2] ?? '1000,3000,5000,10000').split(',').map(Number);
const out: any[] = [];
for (const target of targets) {
  const sim = new Simulation(data, { seed: 1, controller: 'ai', scenario: 'extreme', demandScale: Math.max(1, target / 1500), dt: 0.5, maxVehicles: target });
  const t0 = performance.now(); let steps = 0;
  while (sim.vehicleCount() < target * 0.97 && steps < 14400) { sim.step(); steps++; }
  const fillS = sim.t; const reached = sim.vehicleCount();
  const n = 400; const t1 = performance.now();
  for (let i = 0; i < n; i++) sim.step();
  const ms = (performance.now() - t1) / n;
  const r = { target, reached, measuredAt: sim.vehicleCount(), simTimeToFillS: fillS, msPerStep: +ms.toFixed(3), stepsPerSec: Math.round(1000 / ms), realtimeFactor: +((1000 / ms) * 0.5).toFixed(1), fillWallS: +((t1 - t0) / 1000).toFixed(1) };
  console.log(JSON.stringify(r)); out.push(r);
}
mkdirSync('results', { recursive: true });
writeFileSync('results/bench.json', JSON.stringify({ node: process.version, cpu: (await import('os')).cpus()[0].model, dt: 0.5, results: out }, null, 1));

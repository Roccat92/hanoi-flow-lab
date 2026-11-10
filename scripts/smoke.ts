import { readFileSync } from 'fs';
import { Simulation } from '../src/engine/sim';
const data = JSON.parse(readFileSync('public/data/dongda.json', 'utf8'));
const ctrl = (process.argv[2] ?? 'fixed') as any, sc = (process.argv[3] ?? 'normal') as any, mins = +(process.argv[4] ?? 20);
const sim = new Simulation(data, { seed: 42, controller: ctrl, scenario: sc, demandScale: 1, dt: 0.5 });
sim.checkSafety = true;
const t0 = performance.now();
const n = mins * 60 / 0.5;
for (let i = 0; i < n; i++) { sim.step(); if (i % 600 === 599) { const m = sim.metrics(); console.log(`t=${m.t} act=${m.active} wait=${m.waitingEntry} done=${m.completed} thr=${m.throughputVph.toFixed(0)} spd=${m.avgSpeedKmh.toFixed(1)} delay=${m.avgDelayS.toFixed(0)} stopped=${m.stopped} long=${m.longStopped} viol=${sim.safetyViolations}`); } }
console.log('ms/step', ((performance.now() - t0) / n).toFixed(2), 'signals', sim.sig.size, 'sources', sim.sources.length, 'sinks', sim.sinks.length, 'moves', sim.net.moves.length, 'maxDisp', sim.maxDisp.toFixed(2));

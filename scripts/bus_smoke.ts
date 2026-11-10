import { loadData } from './loadData';
import { Simulation } from '../src/engine/sim';
const data = loadData();
const sc = (process.argv[2] ?? 'morning') as any, min = +(process.argv[3] ?? 20);
const sim = new Simulation(data, { seed: 1, controller: 'ai', scenario: sc, demandScale: 1, dt: 0.5 });
sim.checkSafety = true;
const t0 = Date.now();
while (sim.t < min * 60) sim.step();
const m = sim.metrics();
console.log({ lines: sim.lines.length, stops: sim.stopPts.length, wall: Date.now() - t0, safety: sim.safetyViolations, maxDisp: sim.maxDisp,
  busRuns: m.busRuns, spd: m.busSpeedKmh?.toFixed(1), wait: m.busPaxWaitS?.toFixed(0), boarded: m.busBoarded, bunch: m.busBunching?.toFixed(3), inLane: m.busInLane, hail: m.busHail, missed: sim.busMissed,
  dwell: m.busDwellS?.toFixed(1), unloads: m.truckUnloads, banned: sim.truckBanned, wide: m.wideTurnBlocks, completed: m.completed, delay: m.avgDelayS.toFixed(0), active: m.active });
console.log(sim.events.filter(e => e.kind === 'info').slice(0, 5).map(e => e.text));

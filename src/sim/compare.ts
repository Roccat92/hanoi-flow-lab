import { Simulation } from '../engine/sim';
import { makeController } from '../engine/controllers';
import type { ControllerKind, MapData, Metrics, ScenarioKind, SimConfig } from '../engine/types';
import type { CompareResult } from './protocol';

/** Scientific comparison: identical seed, scenario, demand and duration for every controller. */
export function runComparison(data: MapData, o: { seed: number; scenario: ScenarioKind; minutes: number; demandScale: number; edits?: SimConfig['edits']; chaos?: number; crashes?: SimConfig['crashes'] },
  progress?: (done: number, total: number, label: string) => void, kinds: ControllerKind[] = ['fixed', 'actuated', 'ai']): CompareResult[] {
  const out: CompareResult[] = [];
  const steps = Math.round(o.minutes * 60 / 0.5);
  kinds.forEach((k, ki) => {
    const sim = new Simulation(data, { seed: o.seed, controller: k, scenario: o.scenario, demandScale: o.demandScale, dt: 0.5, edits: o.edits, chaos: o.chaos, crashes: o.crashes });
    sim.checkSafety = true;
    const t0 = performance.now();
    for (let i = 0; i < steps; i++) { sim.step(); if (i % 1200 === 0) progress?.(ki * steps + i, kinds.length * steps, makeController(k).label); }
    const m = sim.metrics() as Metrics & Record<string, number>;
    // vehicles still inside (time in system minus distance/11 m/s, an estimate) or still waiting to enter accumulate delay too: report it so a controller cannot "win" by blocking entries
    let inside = 0; for (const v of sim.allVehicles()) inside += Math.max(0, sim.t - v.tCreate - v.dist / 11);
    let waitQ = 0; for (const s of sim.sources) for (const v of s.queue) waitQ += sim.t - v.tCreate;
    m.unfinishedVehS = Math.round(inside + waitQ);
    m.totalVehHoursLost = Math.round((sim.sumDelay + inside + waitQ) / 3600 * 10) / 10;
    m.switches = [...sim.sig.values()].reduce((a, s) => a + s.switches, 0);
    m.pedConflicts = sim.pedConflicts; m.crashEvents = sim.events.filter(e => e.kind === 'crash').length;
    m.forced = [...sim.sig.values()].reduce((a, s) => a + s.forced, 0);
    out.push({ controller: k, label: makeController(k).label, summary: m, series: sim.series.slice(), wallMs: performance.now() - t0, violations: sim.safetyViolations });
  });
  progress?.(1, 1, 'xong');
  return out;
}

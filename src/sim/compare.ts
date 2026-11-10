import { Simulation } from '../engine/sim';
import { CTRL_LABEL } from '../engine/modes';
import type { ControllerKind, MapData, Metrics, ScenarioKind, SimConfig } from '../engine/types';
import type { CompareResult } from './protocol';

/** Scientific comparison: identical seed, scenario, demand and duration for every controller. */
export function runComparison(data: MapData, o: { seed: number; scenario: ScenarioKind; minutes: number; demandScale: number; edits?: SimConfig['edits']; chaos?: number; crashes?: SimConfig['crashes']; nodeModes?: SimConfig['nodeModes']; bus?: SimConfig['bus']; trucks?: SimConfig['trucks'] },
  progress?: (done: number, total: number, label: string) => void, kinds: ControllerKind[] = ['fixed', 'actuated', 'ai']): CompareResult[] {
  const out: CompareResult[] = [];
  const steps = Math.round(o.minutes * 60 / 0.5);
  kinds.forEach((k, ki) => {
    const sim = new Simulation(data, { seed: o.seed, controller: k, scenario: o.scenario, demandScale: o.demandScale, dt: 0.5, edits: o.edits, chaos: o.chaos, crashes: o.crashes, nodeModes: o.nodeModes, bus: o.bus, trucks: o.trucks });
    sim.checkSafety = true;
    const t0 = performance.now();
    for (let i = 0; i < steps; i++) { sim.step(); if (i % 1200 === 0) progress?.(ki * steps + i, kinds.length * steps, (CTRL_LABEL[k] ?? k)); }
    const m = sim.metrics() as Metrics & Record<string, number>;
    // vehicles still inside (time in system minus distance/11 m/s, an estimate) or still waiting to enter accumulate delay too: report it so a controller cannot "win" by blocking entries
    let inside = 0; for (const v of sim.allVehicles()) inside += Math.max(0, sim.t - v.tCreate - v.dist / 11);
    let waitQ = 0; for (const s of sim.sources) for (const v of s.queue) waitQ += sim.t - v.tCreate;
    for (const l of sim.lines) for (const v of l.queue as { tCreate: number }[]) waitQ += sim.t - v.tCreate;
    m.unfinishedVehS = Math.round(inside + waitQ);
    m.totalVehHoursLost = Math.round((sim.sumDelay + inside + waitQ) / 3600 * 10) / 10;
    m.switches = [...sim.sig.values()].reduce((a, s) => a + s.switches, 0);
    m.pedConflicts = sim.pedConflicts; m.crashEvents = sim.events.filter(e => e.kind === 'crash').length;
    m.forced = [...sim.sig.values()].reduce((a, s) => a + s.forced, 0);
    m.nearMiss = sim.nearMiss; m.hardBrakes = sim.hardBrakes; m.gridlockEvents = sim.gridlockEvents; m.gridlockNodeS = sim.gridlockNodeS;
    const nodes: Record<number, { flow: number; waitS: number; mode: string }> = {};
    for (const nid of sim.sigNodes) nodes[nid] = { flow: sim.nodeFlow[nid], waitS: Math.round(sim.nodeWaitS[nid]), mode: sim.nodeMode.get(nid) ?? '' };
    out.push({ nodes, controller: k, label: (CTRL_LABEL[k] ?? k), summary: m, series: sim.series.slice(), wallMs: performance.now() - t0, violations: sim.safetyViolations });
  });
  progress?.(1, 1, 'xong');
  return out;
}

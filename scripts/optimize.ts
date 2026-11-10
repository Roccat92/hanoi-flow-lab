import { loadData } from './loadData';
// Derive the per-junction control logic by simulation.
// Search space: interpretable policies "signal (AI v2 or actuated) at junctions whose flow >= theta, the rest dark (off) or flashing amber",
// plus the structural "major junctions only" rule. Training: seeds 11,12,13 x morning, evening, incident (30 min).
// Held-out evaluation is separate (scripts/experiments.ts: seeds 1-3, all 7 scenarios).
// Objective J = sum vehicle-hours lost + 0.01 x near-misses (lower is better).
// (An earlier greedy per-junction search, results/optimize_greedy.log, showed single-junction effects below the run-to-run noise, so it was replaced by this low-dimensional search.)
import { writeFileSync, mkdirSync } from 'fs';
import { readFileSync } from 'fs';
import { run1 } from './pool';
import { Network } from '../src/engine/network';
import { isMajor } from '../src/engine/modes';
const TRAIN_SEEDS = [11, 12, 13], TRAIN_SC = ['morning', 'evening', 'incident'], MIN = 30, W_NM = 0.01;
const data = loadData(); const net = new Network(data, {});
async function evalCfg(controller: string, nodeModes?: Record<number, string>) {
  const rs = await Promise.all(TRAIN_SC.flatMap(scenario => TRAIN_SEEDS.map(seed => run1({ scenario, seed, controller, minutes: MIN, nodeModes }))));
  const vehH = rs.reduce((a, r) => a + r.summary.totalVehHoursLost, 0), nm = rs.reduce((a, r) => a + r.summary.nearMiss, 0);
  const per = rs.map(r => r.summary.totalVehHoursLost);
  return { J: vehH + W_NM * nm, vehH, nm, per, rs };
}
const t0 = Date.now();
const KINDS = ['fixed', 'actuated', 'ai', 'nosignal', 'major', 'flash', 'allway'];
const baseP = Object.fromEntries(KINDS.map(k => [k, evalCfg(k)]));
const base: Record<string, any> = {}; for (const k of KINDS) base[k] = await baseP[k];
const nodes = Object.keys(base.ai.rs[0].nodes).map(Number);
// junction flow (veh/h through the junction) measured with AI v2 everywhere, averaged over the training runs
const flow: Record<number, number> = {}, waitH: Record<number, number> = {};
for (const n of nodes) { flow[n] = Math.round(base.ai.rs.reduce((a: number, r: any) => a + r.nodes[n].flow, 0) / base.ai.rs.length * 60 / MIN); waitH[n] = +(base.ai.rs.reduce((a: number, r: any) => a + r.nodes[n].waitS, 0) / base.ai.rs.length / 3600).toFixed(2); }
const fl = nodes.map(n => flow[n]).sort((a, b) => a - b);
const q = (p: number) => fl[Math.min(fl.length - 1, Math.floor(p * fl.length))];
const thetas = [...new Set([0, q(0.25), q(0.5), q(0.65), q(0.75), q(0.85), q(0.95), Infinity])];
const pols: { name: string; modes: Record<number, string>; desc: any }[] = [];
for (const sigM of ['ai', 'actuated']) for (const minor of ['off', 'flash']) for (const th of thetas) {
  const modes: Record<number, string> = {}; for (const n of nodes) modes[n] = flow[n] >= th ? sigM : minor;
  pols.push({ name: `flow>=${th}:${sigM}, else ${minor}`, modes, desc: { rule: 'flow', theta: th, sigM, minor } });
}
for (const sigM of ['ai', 'actuated']) for (const minor of ['off', 'flash']) {
  const modes: Record<number, string> = {}; for (const n of nodes) modes[n] = isMajor(net, net.nodes[n]) ? sigM : minor;
  pols.push({ name: `major:${sigM}, else ${minor}`, modes, desc: { rule: 'major', sigM, minor } });
}
const evs = await Promise.all(pols.map(async p => ({ ...p, e: await evalCfg('ai', p.modes) })));
evs.sort((a, b) => a.e.J - b.e.J);
for (const k of KINDS) console.log('baseline', k.padEnd(9), base[k].J.toFixed(1), 'vehH', base[k].vehH.toFixed(1), 'nm', base[k].nm);
for (const x of evs) console.log(x.name.padEnd(36), x.e.J.toFixed(1), 'vehH', x.e.vehH.toFixed(1), 'nm', x.e.nm, 'signals', Object.values(x.modes).filter(m => m === 'ai' || m === 'actuated').length);
const best = evs[0];
// run-to-run noise: spread of the per-run differences between the best policy and AI-everywhere (paired by seed and scenario)
const diffs = best.e.per.map((v: number, i: number) => v - base.ai.per[i]);
mkdirSync('results', { recursive: true });
writeFileSync('results/optimize.json', JSON.stringify({ trainSeeds: TRAIN_SEEDS, trainScenarios: TRAIN_SC, minutes: MIN, objective: 'sum vehH + 0.01*nearMiss',
  baselines: Object.fromEntries(KINDS.map(k => [k, { J: base[k].J, vehH: base[k].vehH, nm: base[k].nm, per: base[k].per }])),
  policies: evs.map(x => ({ name: x.name, desc: x.desc, J: x.e.J, vehH: x.e.vehH, nm: x.e.nm, per: x.e.per, signals: Object.values(x.modes).filter(m => m === 'ai' || m === 'actuated').length })),
  best: { name: best.name, desc: best.desc, J: best.e.J, vehH: best.e.vehH, nm: best.e.nm, pairedDiffVsAi: diffs }, modes: best.modes, features: Object.fromEntries(nodes.map(n => [n, { flowPerH: flow[n], waitH: waitH[n], major: isMajor(net, net.nodes[n]) }])), log: [{ step: 'start', from: 'policy search' }] }, null, 1));
writeFileSync('src/engine/optimal.ts', `import type { NodeMode } from './types';\n/** per-junction modes found by scripts/optimize.ts: policy "${best.name}" (training seeds ${TRAIN_SEEDS.join(',')}, scenarios ${TRAIN_SC.join(', ')}; objective vehicle-hours lost + 0.01 x near-misses). Generated, do not edit by hand. */\nexport const OPTIMAL_MODES: Record<number, NodeMode> = ${JSON.stringify(best.modes)};\n`);
console.log('best', best.name, 'paired diff vs ai per run', diffs.map((d: number) => d.toFixed(0)).join(' '), ((Date.now() - t0) / 60000).toFixed(1), 'min');

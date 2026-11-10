// Per-junction control optimisation by simulation (coordinate descent with batch acceptance).
// Training: seeds 11,12 x scenarios morning, evening, incident (30 min). Held-out evaluation is separate (scripts/experiments.ts, seeds 1-3, all 7 scenarios).
// Objective J = sum vehicle-hours lost + 0.01 x near-misses (one near-miss "costs" 36 s), lower is better.
import { writeFileSync, mkdirSync } from 'fs';
import { run1 } from './pool';
const TRAIN_SEEDS = [11, 12], TRAIN_SC = ['morning', 'evening', 'incident'], MIN = 30;
const ALTS = ['ai', 'actuated', 'off', 'flash'];
const W_NM = 0.01;
const log: any[] = [];
async function evalCfg(controller: string, nodeModes?: Record<number, string>) {
  const rs = await Promise.all(TRAIN_SC.flatMap(scenario => TRAIN_SEEDS.map(seed => run1({ scenario, seed, controller, minutes: MIN, nodeModes }))));
  const vehH = rs.reduce((a, r) => a + r.summary.totalVehHoursLost, 0), nm = rs.reduce((a, r) => a + r.summary.nearMiss, 0);
  return { J: vehH + W_NM * nm, vehH, nm, rs };
}
const t0 = Date.now();
const base: Record<string, any> = {};
for (const k of ['fixed', 'actuated', 'ai', 'nosignal', 'major', 'flash', 'allway']) base[k] = evalCfg(k);
for (const k in base) base[k] = await base[k];
for (const k in base) console.log('baseline', k, base[k].J.toFixed(1), base[k].vehH.toFixed(1), base[k].nm);
const nodes = Object.keys(base.ai.rs[0].nodes).map(Number);
const bestK = Object.keys(base).sort((a, b) => base[a].J - base[b].J)[0];
let cur: Record<number, string> = {}; for (const n of nodes) cur[n] = base[bestK].rs[0].nodes[n].mode;
let curE = await evalCfg('ai', cur);
console.log('start from', bestK, curE.J.toFixed(1));
log.push({ step: 'start', from: bestK, J: curE.J, modes: { ...cur } });
for (let pass = 1; pass <= 2; pass++) {
  const cands: { n: number; m: string; J: number }[] = [];
  await Promise.all(nodes.flatMap(n => ALTS.filter(m => m !== cur[n]).map(async m => { const e = await evalCfg('ai', { ...cur, [n]: m }); cands.push({ n, m, J: e.J }); })));
  const bestPer = new Map<number, { n: number; m: string; J: number }>();
  for (const c of cands) if (c.J < curE.J && (!bestPer.has(c.n) || c.J < bestPer.get(c.n)!.J)) bestPer.set(c.n, c);
  const pos = [...bestPer.values()].sort((a, b) => a.J - b.J);
  console.log(`pass ${pass}: ${pos.length} improving single changes`, pos.slice(0, 8).map(c => `${c.n}->${c.m} ${(curE.J - c.J).toFixed(1)}`).join(', '), ((Date.now() - t0) / 60000).toFixed(1), 'min');
  log.push({ step: 'pass', pass, J: curE.J, singles: cands.map(c => ({ ...c, gain: curE.J - c.J })) });
  if (!pos.length) break;
  // sequential acceptance in order of single-change gain (interactions and noise make blind batching unreliable)
  let accepted = 0;
  for (const c of pos.slice(0, 10)) {
    const cfg = { ...cur, [c.n]: c.m }; const e = await evalCfg('ai', cfg);
    const ok = e.J < curE.J;
    console.log(`  try ${c.n}->${c.m}: ${e.J.toFixed(1)} vs ${curE.J.toFixed(1)} ${ok ? 'ACCEPT' : 'reject'}`);
    log.push({ step: 'try', pass, n: c.n, m: c.m, J: e.J, prev: curE.J, ok });
    if (ok) { cur = cfg; curE = e; accepted++; }
  }
  if (!accepted) break;
}
// node features from the AI-everywhere training runs (flow and waiting through each junction)
const feat: Record<number, any> = {};
for (const n of nodes) {
  const flows = base.ai.rs.map((r: any) => r.nodes[n].flow), waits = base.ai.rs.map((r: any) => r.nodes[n].waitS);
  feat[n] = { flowPerH: Math.round(flows.reduce((a: number, b: number) => a + b, 0) / flows.length * (60 / MIN)), waitH: +(waits.reduce((a: number, b: number) => a + b, 0) / waits.length / 3600).toFixed(2) };
}
mkdirSync('results', { recursive: true });
writeFileSync('results/optimize.json', JSON.stringify({ trainSeeds: TRAIN_SEEDS, trainScenarios: TRAIN_SC, minutes: MIN, objective: 'sum vehH + 0.01*nearMiss', baselines: Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { J: v.J, vehH: v.vehH, nm: v.nm }])), final: { J: curE.J, vehH: curE.vehH, nm: curE.nm }, modes: cur, features: feat, log }, null, 1));
writeFileSync('src/engine/optimal.ts', `import type { NodeMode } from './types';\n/** per-junction modes found by scripts/optimize.ts (training seeds ${TRAIN_SEEDS.join(',')}, scenarios ${TRAIN_SC.join(', ')}; objective vehicle-hours lost + 0.01 x near-misses). Generated, do not edit by hand. */\nexport const OPTIMAL_MODES: Record<number, NodeMode> = ${JSON.stringify(cur)};\n`);
console.log('done', ((Date.now() - t0) / 60000).toFixed(1), 'min', 'J', curE.J.toFixed(1));

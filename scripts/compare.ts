import { loadData } from './loadData';
// Headless scientific comparison: npx tsx scripts/compare.ts [scenario] [minutes] [seeds,comma] [demandScale]
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { runComparison } from '../src/sim/compare';
const data = loadData();
const scenario = (process.argv[2] ?? 'morning') as any, minutes = +(process.argv[3] ?? 30);
const seeds = (process.argv[4] ?? '1,2,3').split(',').map(Number), demandScale = +(process.argv[5] ?? 1);
const keys = ['avgDelayS', 'avgTravelS', 'completed', 'throughputVph', 'avgSpeedKmh', 'avgStops', 'active', 'waitingEntry', 'totalVehHoursLost', 'pedWaitS', 'switches', 'forced'];
const all: any[] = [];
for (const seed of seeds) {
  const res = runComparison(data, { seed, scenario, minutes, demandScale });
  all.push({ seed, results: res.map(r => ({ controller: r.controller, summary: r.summary, violations: r.violations, wallMs: r.wallMs, series: r.series })) });
  console.log(`seed ${seed} ${scenario} ${minutes}min x${demandScale}`);
  console.log(['controller', ...keys, 'viol'].join('\t'));
  for (const r of res) console.log([r.controller, ...keys.map(k => (+r.summary[k]).toFixed(1)), r.violations].join('\t'));
}
const mean = (c: string, k: string) => all.reduce((a, x) => a + x.results.find((r: any) => r.controller === c).summary[k], 0) / all.length;
console.log(`MEAN over seeds ${seeds.join(',')}`);
for (const c of ['fixed', 'actuated', 'ai']) console.log([c, ...keys.map(k => mean(c, k).toFixed(1))].join('\t'));
mkdirSync('results', { recursive: true });
writeFileSync(`results/compare_${scenario}_${minutes}min_x${demandScale}.json`, JSON.stringify({ scenario, minutes, demandScale, seeds, runs: all.map(x => ({ seed: x.seed, results: x.results.map((r: any) => ({ controller: r.controller, summary: r.summary, violations: r.violations, wallMs: Math.round(r.wallMs) })) })) }, null, 1));

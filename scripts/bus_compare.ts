// Quick bus/truck comparison: npx tsx scripts/bus_compare.ts  -> results/bus_compare.json + results/BUS.md
import { writeFileSync } from 'fs';
import { run1 } from './pool';
const V: { key: string; label: string; controller: string; bus?: any; trucks?: any; nodeModes?: any }[] = [
  { key: 'fixed', label: 'Cố định', controller: 'fixed' },
  { key: 'actuated', label: 'Cảm biến', controller: 'actuated' },
  { key: 'ai', label: 'AI v2', controller: 'ai' },
  { key: 'ai_tsp', label: 'AI v2 + ưu tiên buýt (TSP)', controller: 'ai', bus: { tsp: true } },
  { key: 'major', label: 'Chỉ nút lớn có đèn', controller: 'major' },
  { key: 'optimal', label: 'Tối ưu (nút lớn cảm biến, còn lại tắt)', controller: 'optimal' },
  { key: 'ai_nobehav', label: 'AI v2, KHÔNG mô phỏng buýt tuyến / xe tải đỗ (đối chứng)', controller: 'ai', bus: { lines: false }, trucks: { unloadP: 0, wideTurns: false } },
];
const SC = ['morning', 'evening'], SEEDS = [1, 2, 3];
const keys = ['totalVehHoursLost', 'avgDelayS', 'completed', 'avgSpeedKmh', 'busSpeedKmh', 'busPaxWaitS', 'busBunching', 'busBoarded', 'busInLane', 'busHail', 'truckUnloads', 'wideTurnBlocks', 'nearMiss', 'gridlockEvents'];
(async () => {
  const jobs: Promise<any>[] = [];
  for (const v of V) for (const sc of SC) for (const seed of SEEDS)
    jobs.push(run1({ scenario: sc, seed, controller: v.controller, minutes: 30, bus: v.bus, trucks: v.trucks }).then(r => ({ v: v.key, sc, seed, s: r.summary, violations: r.violations })));
  const res = await Promise.all(jobs);
  const agg: any = {};
  for (const v of V) for (const sc of SC) {
    const rs = res.filter(r => r.v === v.key && r.sc === sc); const o: any = { n: rs.length, violations: rs.reduce((a, r) => a + r.violations, 0) };
    for (const k of keys) o[k] = rs.reduce((a, r) => a + (r.s[k] ?? 0), 0) / rs.length;
    agg[v.key + ':' + sc] = o;
  }
  writeFileSync('results/bus_compare.json', JSON.stringify({ generated: new Date().toISOString(), minutes: 30, seeds: SEEDS, variants: V, agg, runs: res }, null, 1));
  const f = (x: number, d = 0) => x.toFixed(d);
  let md = '# Buses and trucks: quick comparison (TS engine, 30 min, seeds 1-3, mean per run)\n\n';
  for (const sc of SC) {
    md += `## ${sc}\n\n| Variant | veh-h lost | delay/trip s | trips done | bus km/h | pax wait s | bunching % | boarded | in-lane stops | hail stops | truck unloads | wide-turn holds | near-miss | gridlock | signal violations |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const v of V) { const a = agg[v.key + ':' + sc]; md += `| ${v.label} | ${f(a.totalVehHoursLost, 1)} | ${f(a.avgDelayS)} | ${f(a.completed)} | ${f(a.busSpeedKmh, 1)} | ${f(a.busPaxWaitS)} | ${f(a.busBunching * 100, 1)} | ${f(a.busBoarded)} | ${f(a.busInLane, 1)} | ${f(a.busHail, 1)} | ${f(a.truckUnloads, 1)} | ${f(a.wideTurnBlocks)} | ${f(a.nearMiss)} | ${f(a.gridlockEvents, 1)} | ${a.violations} |\n`; }
    md += '\n';
  }
  writeFileSync('results/BUS.md', md); console.log(md);
})();

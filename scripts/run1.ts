import { loadData } from './loadData';
// One headless run, JSON result on stdout: npx tsx scripts/run1.ts '{"scenario":"morning","seed":1,"controller":"ai","minutes":30,"nodeModes":{}}'
import { readFileSync } from 'fs';
import { runComparison } from '../src/sim/compare';
const a = JSON.parse(process.argv[2]);
const data = loadData();
const [r] = runComparison(data, { seed: a.seed, scenario: a.scenario, minutes: a.minutes ?? 30, demandScale: a.demand ?? 1, nodeModes: a.nodeModes }, undefined, [a.controller]);
process.stdout.write(JSON.stringify({ args: a, summary: r.summary, violations: r.violations, nodes: r.nodes, wallMs: Math.round(r.wallMs) }) + '\n');

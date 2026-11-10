// Held-out comparison of every control mode: seeds 1-3 (never used by the optimiser), all 7 scenarios, 30 min, chaos 0.6, default fender-bender schedule.
// Writes results/experiments.json, public/data/experiments.json (read by the app) and results/EXPERIMENTS.md
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { run1 } from './pool';
const KINDS = ['fixed', 'actuated', 'ai', 'nosignal', 'major', 'flash', 'allway', 'optimal'];
const SC = ['normal', 'morning', 'evening', 'extreme', 'incident', 'rain', 'event'];
const SEEDS = (process.argv[2] ?? '1,2,3').split(',').map(Number), MIN = 30;
const VN: Record<string, string> = { normal: 'Bình thường', morning: 'Cao điểm sáng', evening: 'Cao điểm chiều', extreme: 'Tắc cực đoan', incident: 'Sự cố Xã Đàn', rain: 'Mưa lớn', event: 'Sự kiện Gò Đống Đa' };
const LBL: Record<string, string> = { fixed: 'Cố định', actuated: 'Cảm biến', ai: 'AI v2', nosignal: 'Không đèn', major: 'Chỉ nút lớn', flash: 'Vàng nhấp nháy', allway: 'Nhường mọi hướng', optimal: 'Tối ưu (lai)' };
const t0 = Date.now();
const runs = await Promise.all(SC.flatMap(scenario => KINDS.flatMap(controller => SEEDS.map(seed => run1({ scenario, seed, controller, minutes: MIN })))));
const table: any = {}; const raw: any = {};
for (const sc of SC) { table[sc] = {}; raw[sc] = {}; for (const k of KINDS) {
  const rs = runs.filter(r => r.args.scenario === sc && r.args.controller === k); raw[sc][k] = rs.map(r => ({ seed: r.args.seed, summary: r.summary, violations: r.violations }));
  const mean = (f: (r: any) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
  table[sc][k] = { vehH: mean(r => r.summary.totalVehHoursLost), delay: mean(r => r.summary.avgDelayS), completed: mean(r => r.summary.completed), thr: mean(r => r.summary.throughputVph),
    maxQ: mean(r => r.summary.maxQueue), grid: mean(r => r.summary.gridlockEvents), gridS: mean(r => r.summary.gridlockNodeS), nm: mean(r => r.summary.nearMiss), hb: mean(r => r.summary.hardBrakes),
    pedW: mean(r => r.summary.pedWaitS), pedC: rs.reduce((a, r) => a + r.summary.pedConflicts, 0), viol: rs.reduce((a, r) => a + r.violations, 0), crashes: mean(r => r.summary.crashEvents) };
} }
const opt = existsSync('results/optimize.json') ? JSON.parse(readFileSync('results/optimize.json', 'utf8')) : null;
const rules = existsSync('results/rules.json') ? JSON.parse(readFileSync('results/rules.json', 'utf8')) : null;
const out: any = { generated: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', seeds: SEEDS, minutes: MIN, kinds: KINDS, scenarios: SC, table };
if (opt && rules) out.optimal = { modes: opt.modes, names: rules.names, rules: rules.rules, counts: rules.counts, train: `seed ${opt.trainSeeds.join(', ')} x ${opt.trainScenarios.join(', ')}, ${opt.minutes} phút`, objective: 'tổng giờ-xe mất + 0.01 x số lần suýt va chạm' };
out.notes = rules?.notes ?? [];
writeFileSync('results/experiments.json', JSON.stringify({ ...out, raw }, null, 1));
writeFileSync('public/data/experiments.json', JSON.stringify(out));
const f = (x: number, d = 1) => x.toFixed(d);
let md = `# Thí nghiệm chế độ điều khiển (engine TS, ${MIN} phút, seed ${SEEDS.join(', ')}, hỗn loạn 0.6, cùng lịch va quẹt)\n\n## Giờ-xe mất (càng thấp càng tốt, in đậm = tốt nhất)\n\n| Kịch bản | ${KINDS.map(k => LBL[k]).join(' | ')} |\n|---|${KINDS.map(() => '---').join('|')}|\n`;
for (const sc of SC) { const best = Math.min(...KINDS.map(k => table[sc][k].vehH)); md += `| ${VN[sc]} | ${KINDS.map(k => table[sc][k].vehH === best ? `**${f(table[sc][k].vehH)}**` : f(table[sc][k].vehH)).join(' | ')} |\n`; }
const tot = (k: string, m: string) => SC.reduce((a, sc) => a + table[sc][k][m], 0);
md += `| **Tổng 7 kịch bản** | ${KINDS.map(k => f(tot(k, 'vehH'))).join(' | ')} |\n\n## An toàn và phụ (tổng 7 kịch bản, trung bình mỗi seed)\n\n| Chỉ số | ${KINDS.map(k => LBL[k]).join(' | ')} |\n|---|${KINDS.map(() => '---').join('|')}|\n`;
for (const [m, l, d] of [['nm', 'Suýt va chạm (lần)', 0], ['hb', 'Phanh gấp (lần)', 0], ['grid', 'Kẹt cứng nút (lần)', 1], ['gridS', 'Thời gian kẹt cứng (nút-giây)', 0], ['completed', 'Chuyến hoàn thành', 0], ['pedC', 'Xung đột người đi bộ (mọi lượt)', 0], ['viol', 'Vi phạm an toàn tín hiệu (mọi lượt)', 0]] as [string, string, number][])
  md += `| ${l} | ${KINDS.map(k => f(tot(k, m), d)).join(' | ')} |\n`;
md += `| Trễ TB (s, TB 7 kịch bản) | ${KINDS.map(k => f(tot(k, 'delay') / SC.length)).join(' | ')} |\n| Người đi bộ chờ TB (s) | ${KINDS.map(k => f(tot(k, 'pedW') / SC.length)).join(' | ')} |\n| Hàng chờ dài nhất TB (xe) | ${KINDS.map(k => f(tot(k, 'maxQ') / SC.length)).join(' | ')} |\n`;
writeFileSync('results/EXPERIMENTS.md', md);
console.log(md); console.log('wall', ((Date.now() - t0) / 60000).toFixed(1), 'min');

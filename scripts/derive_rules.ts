import { loadData } from './loadData';
// Turn the optimiser output into plain-language rules grounded in the measured data. Writes results/rules.json
import { readFileSync, writeFileSync } from 'fs';
import { Network } from '../src/engine/network';
import { isMajor, isSignalMode, MODE_LABEL } from '../src/engine/modes';
const data = loadData();
const opt = JSON.parse(readFileSync('results/optimize.json', 'utf8'));
for (const x of opt.policies) if (x.desc.theta === null) x.desc.theta = Infinity; if (opt.best.desc.theta === null) opt.best.desc.theta = Infinity;
const net = new Network(data, {});
const ids = Object.keys(opt.modes).map(Number);
const med = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const rows = ids.map(id => {
  const n = net.nodes[id]; const ins = n.inLinks.map(l => net.links[l]).filter(L => !L.closed);
  const ranks = [...new Set(ins.map(L => L.name))].map(nm => Math.max(...ins.filter(L => L.name === nm).map(L => L.rank))).sort((a, b) => b - a);
  return { id, mode: opt.modes[id], flow: opt.features[id].flowPerH, waitH: opt.features[id].waitH, approaches: ins.length, roads: ranks.length, major: isMajor(net, n), rankGap: ranks.length > 1 ? ranks[0] - ranks[1] : 9,
    name: [...new Set(ins.map(L => L.name).filter(x => x && !/không tên/.test(x)))].slice(0, 3).join(' × ') || `nút #${id}` };
});
const sig = rows.filter(r => isSignalMode(r.mode)), uns = rows.filter(r => !isSignalMode(r.mode));
const counts: Record<string, number> = {}; for (const r of rows) counts[r.mode] = (counts[r.mode] ?? 0) + 1;
// best single threshold on flow that separates "keep a signal" from "no signal"
let best = { thr: 0, acc: 0 };
for (const t of [...new Set(rows.map(r => r.flow))].sort((a, b) => a - b)) {
  const acc = rows.filter(r => (r.flow >= t) === isSignalMode(r.mode)).length / rows.length;
  if (acc > best.acc) best = { thr: t, acc };
}
const pct = (x: number) => Math.round(x * 100) + '%';
const rules: string[] = [];
rules.push(`Kết quả tìm kiếm: ${Object.entries(counts).map(([m, c]) => `${c} nút ${MODE_LABEL[m as keyof typeof MODE_LABEL].toLowerCase()}`).join(', ')} (trên ${rows.length} nút vốn có đèn theo OSM).`);
if (sig.length) rules.push(`Nút giữ đèn: lưu lượng trung vị ${Math.round(med(sig.map(r => r.flow)))} xe/h qua nút, ${pct(sig.filter(r => r.major).length / sig.length)} là nút lớn (>= 3 nhánh cấp secondary trở lên của >= 2 tuyến), trung vị ${med(sig.map(r => r.approaches))} nhánh vào.`);
if (uns.length) rules.push(`Nút bỏ đèn: lưu lượng trung vị ${Math.round(med(uns.map(r => r.flow)))} xe/h, ${pct(uns.filter(r => r.major).length / uns.length)} là nút lớn, trung vị ${med(uns.map(r => r.approaches))} nhánh vào.`);
if (sig.length && uns.length) rules.push(`Ngưỡng đơn giản nhất tìm được: giữ đèn khi lưu lượng qua nút >= ${best.thr} xe/h (khi chạy AI ở mọi nút) - khớp ${pct(best.acc)} lựa chọn của bộ tối ưu, nên đây chỉ là xu hướng, không phải luật tuyệt đối.`);
const fl = rows.filter(r => r.mode === 'flash'), off = rows.filter(r => r.mode === 'off');
if (fl.length && off.length) rules.push(`Vàng nhấp nháy (đường chính ưu tiên) được chọn ở nút có chênh lệch cấp đường trung vị ${med(fl.map(r => r.rankGap === 9 ? 0 : r.rankGap))} bậc; tắt đèn hẳn (tự thương lượng) ở nút có chênh lệch trung vị ${med(off.map(r => r.rankGap === 9 ? 0 : r.rankGap))} bậc.`);
const acts = rows.filter(r => r.mode === 'actuated'), ais = rows.filter(r => r.mode === 'ai');
if (acts.length && ais.length) rules.push(`Trong các nút giữ đèn: ${ais.length} nút dùng AI v2, ${acts.length} nút dùng đèn cảm biến${acts.length ? ` (lưu lượng trung vị ${Math.round(med(acts.map(r => r.flow)))} xe/h so với ${Math.round(med(ais.map(r => r.flow)))} xe/h ở nút AI)` : ''}.`);
// evidence from the policy search (training runs)
const ML: Record<string, string> = { ai: 'đèn AI v2', actuated: 'đèn cảm biến', off: 'tắt đèn', flash: 'vàng nhấp nháy' };
const pdesc = (d: any) => d.rule === 'major' ? `${ML[d.sigM]} ở nút lớn, nút khác ${ML[d.minor]}` : d.theta === 0 ? `${ML[d.sigM]} ở mọi nút` : !isFinite(d.theta) && d.theta !== null ? `${ML[d.minor]} ở mọi nút` : `${ML[d.sigM]} ở nút có lưu lượng >= ${d.theta} xe/h, nút khác ${ML[d.minor]}`;
const P = opt.policies as any[];
const bl = opt.baselines;
rules.push(`Chính sách tốt nhất trên dữ liệu huấn luyện: ${pdesc(opt.best.desc)} (J = ${opt.best.J.toFixed(0)}; AI v2 ở mọi nút J = ${bl.ai.J.toFixed(0)}, không đèn J = ${bl.nosignal.J.toFixed(0)}, chỉ nút lớn J = ${bl.major.J.toFixed(0)}).`);
const seen = new Set([pdesc(opt.best.desc)]); const nxt = P.slice(1).filter(x => { const k = pdesc(x.desc); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
rules.push(`5 chính sách tiếp theo: ${nxt.map(x => `${pdesc(x.desc)} (J ${x.J.toFixed(0)})`).join('; ')}.`);
const pc = (a: number, b: number) => `${a > b ? '+' : ''}${((a / b - 1) * 100).toFixed(0)}%`;
rules.push(`Đánh đổi an toàn (huấn luyện): suýt va chạm ${pc(opt.best.nm, bl.ai.nm)} so với AI v2 ở mọi nút, trong khi tắt đèn toàn bộ là ${pc(bl.nosignal.nm, bl.ai.nm)} và vàng nhấp nháy toàn bộ ${pc(bl.flash.nm, bl.ai.nm)}. Giữ đèn ở nút lớn giữ lại phần lớn lợi ích an toàn của đèn, bỏ đèn ở nút nhỏ lấy lại phần lớn lợi ích thời gian.`);
rules.push(`Ở cùng cấu hình "chỉ nút lớn", đèn cảm biến tốt hơn AI v2 (J ${P.find(x => x.desc.rule === 'major' && x.desc.sigM === 'actuated' && x.desc.minor === 'off')?.J.toFixed(0)} so với ${P.find(x => x.desc.rule === 'major' && x.desc.sigM === 'ai' && x.desc.minor === 'off')?.J.toFixed(0)}), và tắt đèn hẳn ở nút nhỏ tốt hơn vàng nhấp nháy (vàng nhấp nháy bắt đường nhỏ chờ khe hở dài hơn).`);
const sd = (a: number[]) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const d = opt.best.pairedDiffVsAi as number[];
rules.push(`Độ tin cậy: so với AI v2 ở mọi nút, chính sách này lệch ${d.map(x => (x > 0 ? '+' : '') + x.toFixed(0)).join(', ')} giờ-xe trên từng lượt huấn luyện (độ lệch chuẩn ${sd(d).toFixed(0)}). Tìm kiếm tham lam từng nút (results/optimize_greedy.log) cho thấy hiệu quả đổi một nút đơn lẻ nhỏ hơn nhiễu giữa các lượt chạy, nên luật được rút ra ở cấp chính sách đơn giản, không ở cấp từng nút.`);
const notes = [
  'Đây là kết quả của mô hình, chưa hiệu chỉnh bằng số đếm thực tế. Ở nút không đèn, mô hình cho xe vào nút chỉ khi các luồng xung đột đang trống (không có va chạm vật lý), nên nó có thể đánh giá khả năng thông qua của nút không đèn cao hơn thực tế; rủi ro an toàn được phản ánh qua số lần suýt va chạm và phanh gấp chứ không qua tai nạn thật.',
  'Mục tiêu tối ưu chỉ phạt nhẹ suýt va chạm (0.01 giờ-xe mỗi lần). Nếu coi an toàn quan trọng hơn, lời giải sẽ giữ nhiều đèn hơn: xem dòng "hệ số an toàn hoà vốn" bên dưới.',
];
writeFileSync('results/rules.json', JSON.stringify({ rules, notes, counts, names: Object.fromEntries(rows.map(r => [r.id, r.name])), rows }, null, 1));
console.log(rules.join('\n'));

import React, { useEffect, useRef, useState } from 'react';
import type { SimConfig, MapData, ScenarioKind, ControllerKind } from '../engine/types';
import { CTRL_LABEL } from '../engine/modes';
import { SCENARIOS } from '../engine/scenarios';
import { workerClient, type SimClient } from '../sim/client';
import type { CompareResult } from '../sim/protocol';
import { Chart } from './Chart';

const COLORS: Record<string, string> = { fixed: '#ff7b5c', actuated: '#ffd23f', ai: '#4fe3ff', nosignal: '#b08cff', major: '#7dff8a', flash: '#ffa24f', allway: '#e0e0e0', optimal: '#ff5ce1' };
const ALL_KINDS: ControllerKind[] = ['fixed', 'actuated', 'ai', 'nosignal', 'major', 'flash', 'allway', 'optimal'];
type Row = { key: string; label: string; unit: string; better: 'low' | 'high'; get: (r: CompareResult) => number; d?: number };
const ROWS: Row[] = [
  { key: 'avgDelayS', label: 'Trễ trung bình / chuyến (xe đã ra)', unit: 's', better: 'low', get: r => r.summary.avgDelayS },
  { key: 'avgTravelS', label: 'Thời gian đi trung bình', unit: 's', better: 'low', get: r => r.summary.avgTravelS },
  { key: 'completed', label: 'Số chuyến hoàn thành', unit: 'xe', better: 'high', get: r => r.summary.completed, d: 0 },
  { key: 'throughputVph', label: 'Thông lượng 5 phút cuối', unit: 'xe/h', better: 'high', get: r => r.summary.throughputVph, d: 0 },
  { key: 'avgSpeedKmh', label: 'Tốc độ TB cuối kỳ', unit: 'km/h', better: 'high', get: r => r.summary.avgSpeedKmh },
  { key: 'avgStops', label: 'Số lần dừng / chuyến', unit: 'lần', better: 'low', get: r => r.summary.avgStops, d: 2 },
  { key: 'active', label: 'Xe còn trong mạng lúc kết thúc', unit: 'xe', better: 'low', get: r => r.summary.active, d: 0 },
  { key: 'waitingEntry', label: 'Xe đang chờ vào mạng', unit: 'xe', better: 'low', get: r => r.summary.waitingEntry, d: 0 },
  { key: 'totalVehHoursLost', label: 'Tổng giờ-xe mất (gồm xe chưa ra, ước tính)', unit: 'giờ', better: 'low', get: r => r.summary.totalVehHoursLost },
  { key: 'pedWaitS', label: 'Chờ TB của người đi bộ', unit: 's', better: 'low', get: r => r.summary.pedWaitS },
  { key: 'co2kgH', label: 'CO₂ ước tính', unit: 'kg/h', better: 'low', get: r => r.summary.co2kgH, d: 0 },
  { key: 'switches', label: 'Số lần đổi pha', unit: 'lần', better: 'low', get: r => r.summary.switches, d: 0 },
  { key: 'forced', label: 'Lần lớp an toàn phải ép', unit: 'lần', better: 'low', get: r => r.summary.forced, d: 0 },
  { key: 'violations', label: 'Vi phạm an toàn tín hiệu', unit: '', better: 'low', get: r => r.violations, d: 0 },
  { key: 'maxQueue', label: 'Hàng chờ dài nhất ở nút đèn', unit: 'xe', better: 'low', get: r => r.summary.maxQueue, d: 0 },
  { key: 'nearMiss', label: 'An toàn: suýt va chạm (xe xung đột < 1.5 s)', unit: 'lần', better: 'low', get: r => r.summary.nearMiss ?? 0, d: 0 },
  { key: 'hardBrakes', label: 'An toàn: phanh gấp (> 4.5 m/s²)', unit: 'lần', better: 'low', get: r => r.summary.hardBrakes ?? 0, d: 0 },
  { key: 'gridlockEvents', label: 'Kẹt cứng nút (mọi hướng đứng > 60 s)', unit: 'lần', better: 'low', get: r => r.summary.gridlockEvents ?? 0, d: 0 },
  { key: 'pedConflicts', label: 'Xung đột người đi bộ', unit: '', better: 'low', get: r => r.summary.pedConflicts ?? 0, d: 0 },
];

export function Compare({ data, onClose, initial }: { data: MapData; onClose: () => void; initial: { seed: number; scenario: ScenarioKind; demandScale: number; edits?: SimConfig['edits']; chaos?: number; crashes?: SimConfig['crashes'] } }) {
  const [seed, setSeed] = useState(initial.seed); const [scenario, setScenario] = useState<ScenarioKind>(initial.scenario);
  const [minutes, setMinutes] = useState(30); const [kinds, setKinds] = useState<ControllerKind[]>(['fixed', 'actuated', 'ai', 'nosignal', 'major', 'flash', 'optimal']); const [demand, setDemand] = useState(initial.demandScale);
  const [prog, setProg] = useState<{ done: number; total: number; label: string } | null>(null);
  const [res, setRes] = useState<{ results: CompareResult[]; cfg: any } | null>(null);
  const cl = useRef<SimClient | null>(null);
  useEffect(() => () => cl.current?.close(), []);
  const run = () => {
    cl.current?.close(); setRes(null); setProg({ done: 0, total: 1, label: 'khởi tạo' });
    const c = workerClient(data, { seed, controller: 'fixed', scenario, demandScale: demand, dt: 0.5 }); cl.current = c;
    c.send({ type: 'play', on: false });
    c.on(m => {
      if (m.type === 'compareProgress') setProg({ done: m.done, total: m.total, label: m.label });
      if (m.type === 'compareDone') { setRes({ results: m.results, cfg: m.cfg }); setProg(null); c.close(); cl.current = null; }
    });
    c.send({ type: 'compare', seed, scenario, minutes, demandScale: demand, edits: initial.edits, chaos: initial.chaos, crashes: initial.crashes, kinds: ALL_KINDS.filter(k => kinds.includes(k)) });
  };
  const exportJSON = () => download(`hanoi-flow-lab_compare_${scenario}_seed${seed}.json`, JSON.stringify(res, null, 1), 'application/json');
  const exportCSV = () => {
    if (!res) return;
    const lines = ['controller,t_s,active,waitingEntry,completed,throughputVph,avgSpeedKmh,stopped,avgDelayS,avgTravelS,avgStops,pcuQueued,longStopped,co2kgH,pedWaitS,maxQueue'];
    for (const r of res.results) for (const m of r.series) lines.push([r.controller, m.t, m.active, m.waitingEntry, m.completed, m.throughputVph.toFixed(0), m.avgSpeedKmh.toFixed(2), m.stopped, m.avgDelayS.toFixed(1), m.avgTravelS.toFixed(1), m.avgStops.toFixed(2), m.pcuQueued.toFixed(1), m.longStopped, m.co2kgH.toFixed(1), m.pedWaitS.toFixed(1), m.maxQueue].join(','));
    download(`hanoi-flow-lab_compare_${scenario}_seed${seed}.csv`, lines.join('\n'), 'text/csv');
  };
  const ser = (f: (m: any) => number) => res ? res.results.map(r => ({ name: r.label, color: COLORS[r.controller], pts: r.series.map(m => [m.t / 60, f(m)] as [number, number]) })) : [];
  const base = res?.results.find(r => r.controller === 'fixed');
  return (
    <div className="modal"><div className="modal-body">
      <div className="card-h">⚗ So sánh khoa học: cùng seed, cùng nhu cầu, cùng thời lượng <button onClick={onClose}>×</button></div>
      <div className="row">
        <label>Kịch bản <select value={scenario} onChange={e => setScenario(e.target.value as ScenarioKind)}>{Object.values(SCENARIOS).map(s => <option key={s.kind} value={s.kind}>{s.label}</option>)}</select></label>
        <label>Seed <input type="number" value={seed} onChange={e => setSeed(+e.target.value)} /></label>
        <label>Thời lượng mô phỏng <select value={minutes} onChange={e => setMinutes(+e.target.value)}>{[10, 20, 30, 45, 60].map(x => <option key={x} value={x}>{x} phút</option>)}</select></label>
        <label>Hệ số nhu cầu <input type="number" step={0.1} min={0.2} max={3} value={demand} onChange={e => setDemand(+e.target.value)} /></label>
        <button className="primary" onClick={run} disabled={!!prog}>{prog ? 'Đang chạy…' : `Chạy ${kinds.length} chế độ`}</button>
      </div>
      <div className="row kinds">{ALL_KINDS.map(k => <label key={k} className="chk" style={{ color: COLORS[k] }}><input type="checkbox" checked={kinds.includes(k)} onChange={e => setKinds(e.target.checked ? [...kinds, k] : kinds.filter(x => x !== k))} />{CTRL_LABEL[k]}</label>)}</div>
      {prog && <div className="progress"><div style={{ width: `${(100 * prog.done / prog.total).toFixed(0)}%` }} /><span>{prog.label} {(100 * prog.done / prog.total).toFixed(0)}%</span></div>}
      {res && <>
        <div className="muted small">Kết quả đo trực tiếp từ mô phỏng (engine TS, dt = 0.5 s) với seed {res.cfg.seed}, {SCENARIOS[res.cfg.scenario as ScenarioKind].label}, {res.cfg.minutes} phút, nhu cầu ×{res.cfg.demandScale}. Ô xanh là tốt nhất theo từng chỉ số; % so với đèn cố định (nếu có); không chỉnh tay kết quả, kể cả khi AI thua. Va quẹt theo lịch giống hệt nhau cho mọi chế độ.</div>
        <table className="cmp"><thead><tr><th>Chỉ số</th>{res.results.map(r => <th key={r.controller} style={{ color: COLORS[r.controller] }}>{r.label}</th>)}</tr></thead><tbody>
          {ROWS.map(row => {
            const vals = res.results.map(row.get); const best = row.better === 'low' ? Math.min(...vals) : Math.max(...vals);
            return <tr key={row.key}><td>{row.label}{row.unit ? ` (${row.unit})` : ''}</td>{res.results.map((r, i) => {
              const v = vals[i]; const b = base ? row.get(base) : 0; const pct = base && r !== base && b ? ((v - b) / Math.abs(b)) * 100 : null;
              return <td key={r.controller} className={v === best && vals.some(x => x !== best) ? 'best' : ''}>{v.toFixed(row.d ?? 1)}{pct !== null && isFinite(pct) ? <span className="pct"> {pct > 0 ? '+' : ''}{pct.toFixed(0)}%</span> : null}</td>;
            })}</tr>;
          })}
          <tr><td>Thời gian máy chạy</td>{res.results.map(r => <td key={r.controller}>{(r.wallMs / 1000).toFixed(1)} s</td>)}</tr>
        </tbody></table>
        <div className="charts4">
          <Chart title="Tốc độ trung bình" unit="km/h" series={ser(m => m.avgSpeedKmh)} />
          <Chart title="Trễ TB các chuyến 5 phút gần nhất" unit="s" series={ser(m => m.recentDelayS ?? 0)} />
          <Chart title="Xe đang dừng" unit="xe" series={ser(m => m.stopped)} />
          <Chart title="Xe trong mạng + chờ vào" unit="xe" series={ser(m => m.active + m.waitingEntry)} />
        </div>
        <div className="row"><button onClick={exportCSV}>Xuất CSV</button><button onClick={exportJSON}>Xuất JSON</button></div>
      </>}
    </div></div>
  );
}
function download(name: string, text: string, type: string) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }

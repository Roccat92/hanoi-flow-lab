import React, { useEffect, useState } from 'react';
import { CTRL_LABEL, MODE_LABEL } from '../engine/modes';
import { SCENARIOS } from '../engine/scenarios';
import type { ControllerKind, NodeMode, ScenarioKind } from '../engine/types';

type Cell = { vehH: number; delay: number; completed: number; thr: number; maxQ: number; grid: number; nm: number; hb: number; pedW: number; pedC: number; viol: number };
export interface Experiments {
  generated: string; seeds: number[]; minutes: number; kinds: ControllerKind[]; scenarios: ScenarioKind[];
  table: Record<string, Record<string, Cell>>;
  optimal?: { modes: Record<number, NodeMode>; names: Record<number, string>; rules: string[]; train: string; objective: string; counts: Record<string, number> };
  notes?: string[];
}
const METRICS: [keyof Cell, string, number][] = [['vehH', 'Giờ-xe mất', 1], ['delay', 'Trễ TB (s)', 1], ['completed', 'Chuyến xong', 0], ['thr', 'Thông lượng (xe/h)', 0], ['maxQ', 'Hàng chờ max', 0], ['grid', 'Kẹt cứng nút', 1], ['nm', 'Suýt va chạm', 0], ['hb', 'Phanh gấp', 0], ['pedW', 'Người đi bộ chờ (s)', 1], ['pedC', 'Xung đột người đi bộ', 0]];
const HIGH = new Set(['completed', 'thr']);

export function Results({ onClose, onUse }: { onClose: () => void; onUse: (k: ControllerKind) => void }) {
  const [d, setD] = useState<Experiments | null>(null); const [err, setErr] = useState(''); const [met, setMet] = useState<keyof Cell>('vehH');
  useEffect(() => { fetch(import.meta.env.BASE_URL + 'data/experiments.json').then(r => r.json()).then(setD).catch(e => setErr(String(e))); }, []);
  return (
    <div className="modal"><div className="modal-body">
      <div className="card-h">📑 Kết quả thí nghiệm: có đèn, không đèn, vàng nhấp nháy và cấu hình tối ưu <button onClick={onClose}>×</button></div>
      {err && <div className="warnbox">Không tải được kết quả: {err}</div>}
      {d && <>
        <div className="muted small">Engine TS, {d.minutes} phút, trung bình seed {d.seeds.join(', ')} (seed kiểm tra, không dùng khi tối ưu), hỗn loạn 0.6, cùng lịch va quẹt cho mọi chế độ. Sinh lúc {d.generated}. Ô xanh = tốt nhất trong hàng.</div>
        <div className="row">{METRICS.map(([k, l]) => <button key={k} className={met === k ? 'on' : ''} onClick={() => setMet(k)}>{l}</button>)}</div>
        <table className="cmp"><thead><tr><th>Kịch bản</th>{d.kinds.map(k => <th key={k}>{CTRL_LABEL[k]}</th>)}</tr></thead><tbody>
          {d.scenarios.map(sc => { const row = d.table[sc]; const vals = d.kinds.map(k => row[k]?.[met] ?? NaN); const best = HIGH.has(met) ? Math.max(...vals) : Math.min(...vals);
            return <tr key={sc}><td>{SCENARIOS[sc].label}</td>{d.kinds.map((k, i) => <td key={k} className={vals[i] === best ? 'best' : ''}>{isFinite(vals[i]) ? vals[i].toFixed(METRICS.find(m => m[0] === met)![2]) : '-'}</td>)}</tr>; })}
        </tbody></table>
        {d.optimal && <div className="card">
          <div className="card-h">🧠 Cấu hình tối ưu (lai từng nút) <button className="primary" onClick={() => onUse('optimal')}>Chạy cấu hình này</button></div>
          <div className="muted small">Tìm bằng mô phỏng: {d.optimal.train}. Mục tiêu: {d.optimal.objective}. Kết quả bảng trên là trên seed kiểm tra.</div>
          <div className="small">{Object.entries(d.optimal.counts).map(([m, c]) => `${MODE_LABEL[m as NodeMode]}: ${c} nút`).join(' · ')}</div>
          <ul className="small">{d.optimal.rules.map((r, i) => <li key={i}>{r}</li>)}</ul>
          <details><summary className="small">Chế độ từng nút</summary><div className="small">{Object.entries(d.optimal.modes).map(([n, m]) => <div key={n}>#{n} {d.optimal!.names[+n]}: {MODE_LABEL[m]}</div>)}</div></details>
        </div>}
        {d.notes && <ul className="muted small">{d.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      </>}
    </div></div>
  );
}

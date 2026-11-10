import React, { useEffect, useRef, useState } from 'react';
import type { CrashCfg, Edits, NodeMode } from '../engine/types';
import { MODE_LABEL } from '../engine/modes';
import type { LinkInfo, NodeInfo } from '../sim/protocol';

const KEY = 'hanoi-flow-lab:scenarios';
const TURN: Record<string, string> = { L: 'rẽ trái', T: 'đi thẳng', R: 'rẽ phải', U: 'quay đầu', '-': 'không có' };
const CLS: Record<string, string> = { primary: 'đường chính', secondary: 'đường cấp 2', tertiary: 'đường cấp 3', residential: 'đường nội khu', alley: 'ngõ/ngách', trunk: 'trục chính', unclassified: 'chưa phân loại' };
const INF: Record<string, string> = { lanes: 'số làn', speed: 'tốc độ', oneway: 'hai chiều' };

interface Props {
  edits: Edits; onApply: (e: Edits) => void;
  node: NodeInfo | null; link: LinkInfo | null; nodeOsmSignal?: boolean;
  zones: { node: number; w: number; name: string }[];
  pickMode: 'node' | 'link'; setPickMode: (m: 'node' | 'link') => void;
  chaos: number; setChaos: (x: number) => void; crashes: CrashCfg; setCrashes: (c: CrashCfg) => void;
  onClose: () => void; moveFrom: number | null; setMoveFrom: (n: number | null) => void;
}

/** Map editor: every change is stored as an override on top of the OSM network and used by later runs and comparisons. */
export function Editor(p: Props) {
  const [d, setD] = useState<Edits>(p.edits); const file = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState<string[]>(() => Object.keys(load()));
  const [name, setName] = useState(p.edits.name ?? 'Kịch bản của tôi');
  useEffect(() => setD(p.edits), [JSON.stringify(p.edits)]);
  const n = p.node, L = p.link;
  const ne = n ? d.nodes?.[n.id] ?? {} : {};
  const le = L ? d.links?.[L.id] ?? {} : {};
  const setNode = (id: number, v: Partial<NonNullable<Edits['nodes']>[number]>) => setD(x => ({ ...x, nodes: { ...(x.nodes ?? {}), [id]: { ...(x.nodes?.[id] ?? {}), ...v } } }));
  const setLink = (id: number, v: Partial<NonNullable<Edits['links']>[number]>) => setD(x => ({ ...x, links: { ...(x.links ?? {}), [id]: { ...(x.links?.[id] ?? {}), ...v } } }));
  const bans = new Set(d.bans ?? []);
  const toggleBan = (k: string) => setD(x => { const b = new Set(x.bans ?? []); if (b.has(k)) b.delete(k); else b.add(k); return { ...x, bans: [...b] }; });
  const count = Object.keys(d.nodes ?? {}).length + Object.keys(d.links ?? {}).length + (d.bans?.length ?? 0) + Object.keys(d.zones ?? {}).length;
  const dirty = JSON.stringify(d) !== JSON.stringify(p.edits);
  const sigNow = n ? (ne.signal ?? n.signal) : false;

  // moving a signal: the next picked junction receives it
  useEffect(() => {
    if (p.moveFrom !== null && n && n.id !== p.moveFrom) {
      const from = p.moveFrom;
      setD(x => ({ ...x, nodes: { ...(x.nodes ?? {}), [from]: { ...(x.nodes?.[from] ?? {}), signal: false }, [n.id]: { ...(x.nodes?.[n.id] ?? {}), signal: true } } }));
      p.setMoveFrom(null);
    }
  }, [n?.id]);

  return (
    <div className="card editor">
      <div className="card-h">🛠 Chỉnh sửa bản đồ <button onClick={p.onClose}>×</button></div>
      <div className="row">
        <button className={p.pickMode === 'node' ? 'on' : ''} onClick={() => p.setPickMode('node')}>Chọn nút giao</button>
        <button className={p.pickMode === 'link' ? 'on' : ''} onClick={() => p.setPickMode('link')}>Chọn đoạn đường</button>
      </div>
      {p.moveFrom !== null && <div className="warnbox">Đang di chuyển đèn từ nút #{p.moveFrom}: bấm nút giao đích trên bản đồ.</div>}
      {p.pickMode === 'node' && !n && <div className="muted small">Bấm vào một nút giao trên bản đồ.</div>}
      {p.pickMode === 'node' && n && <div className="sect">
        <b>Nút #{n.id}: {n.name || 'không tên'}</b>
        <div className="small muted">OSM: {p.nodeOsmSignal ? 'có đèn (highway=traffic_signals)' : 'không có đèn'} · pha đèn <span className="inf">suy luận</span> từ hướng các nhánh</div>
        <div className="row">
          <span>Đèn tín hiệu: <b>{sigNow ? 'có' : 'không'}</b></span>
          <button onClick={() => setNode(n.id, { signal: !sigNow })}>{sigNow ? 'Gỡ đèn' : 'Thêm đèn'}</button>
          {sigNow && <button onClick={() => p.setMoveFrom(n.id)}>Di chuyển đèn…</button>}
        </div>
        {sigNow && <div className="row"><label title="Ghi đè chế độ điều khiển của toàn mạng cho riêng nút này">Chế độ nút <select value={ne.mode ?? ''} onChange={e => setNode(n.id, { mode: (e.target.value || undefined) as NodeMode | undefined })}>
          <option value="">theo chế độ toàn mạng</option>{(Object.keys(MODE_LABEL) as NodeMode[]).map(k => <option key={k} value={k}>{MODE_LABEL[k]}</option>)}</select></label></div>}
        {sigNow && <>
          <div className="row"><label>Chu kỳ (s) <input type="number" min={40} max={180} value={ne.cycle ?? 90} onChange={e => setNode(n.id, { cycle: +e.target.value, splits: undefined })} /></label>
            <label>Lệch pha (s) <input type="number" min={0} max={120} value={ne.offset ?? 0} onChange={e => setNode(n.id, { offset: +e.target.value })} /></label></div>
          <div className="row">Xanh từng pha (s):
            {(n.phases.length ? n.phases : [{ label: 'pha 1' }, { label: 'pha 2' }] as any[]).map((ph: any, i: number) =>
              <label key={i} title={ph.label}>{i + 1} <input type="number" min={8} max={120} value={ne.splits?.[i] ?? n.fixedSplits?.[i] ?? 30} onChange={e => { const sp = [...(ne.splits ?? n.fixedSplits ?? n.phases.map(() => 30))]; sp[i] = +e.target.value; setNode(n.id, { splits: sp }); }} /></label>)}
          </div>
          <div className="small muted">Chu kỳ/xanh/lệch pha dùng cho điều khiển Cố định. Cảm biến và AI tự quyết định nhưng vẫn theo lớp an toàn (xanh tối thiểu 8 s, vàng 3 s, đỏ toàn phần 2 s, đỏ tối đa 120 s).</div>
        </>}
        {d.nodes?.[n.id] && <button onClick={() => setD(x => { const nn = { ...(x.nodes ?? {}) }; delete nn[n.id]; return { ...x, nodes: nn }; })}>Bỏ thay đổi nút này</button>}
      </div>}
      {p.pickMode === 'link' && !L && <div className="muted small">Bấm vào một đoạn đường trên bản đồ.</div>}
      {p.pickMode === 'link' && L && <div className="sect">
        <b>{L.name}</b> <span className="muted">({CLS[L.cls] ?? L.cls}, #{L.id}, {L.lenM.toFixed(0)} m)</span>
        {L.inf.length > 0 && <div className="small">Dữ liệu <span className="inf">suy luận</span> (OSM không gắn thẻ): {L.inf.map(k => INF[k] ?? k).join(', ')}</div>}
        <div className="row"><label>Số làn <input type="number" min={1} max={6} value={le.lanes ?? L.lanes} onChange={e => setLink(L.id, { lanes: +e.target.value })} /></label>
          <label>Tốc độ (km/h) <input type="number" min={5} max={80} value={le.speed ?? L.speedKmh} onChange={e => setLink(L.id, { speed: +e.target.value })} /></label></div>
        <div className="row">
          <label className="chk"><input type="checkbox" checked={!!le.closed} onChange={e => setLink(L.id, { closed: e.target.checked })} />Cấm đường tạm thời (chiều này)</label>
          {L.twin >= 0 && <label className="chk"><input type="checkbox" checked={!!d.links?.[L.twin]?.closed} onChange={e => setLink(L.twin, { closed: e.target.checked })} />Đổi thành một chiều (cấm chiều ngược)</label>}
        </div>
        <div className="small">Hướng rẽ ở cuối đoạn:</div>
        {L.outMoves.filter(m => m.outL !== L.twin || m.id >= 0).map(m => { const k = L.id + '_' + m.outL; const allowed = !bans.has(k) && (m.id >= 0 || bans.has(k)); return <label key={k} className="chk"><input type="checkbox" checked={allowed} disabled={m.id < 0 && !bans.has(k)} onChange={() => toggleBan(k)} />{TURN[m.turn] ?? m.turn} → {m.to}</label>; })}
        {(d.links?.[L.id]) && <button onClick={() => setD(x => { const nl = { ...(x.links ?? {}) }; delete nl[L.id]; return { ...x, links: nl }; })}>Bỏ thay đổi đoạn này</button>}
      </div>}
      <details className="sect"><summary>Nhu cầu theo vùng OD ({p.zones.length} khu dân cư <span className="inf">suy luận</span> từ ngõ cụt OSM)</summary>
        <div className="zones">{p.zones.slice().sort((a, b) => b.w - a.w).map(z => <label key={z.node} className="zone"><span title={`nút #${z.node}`}>{z.name || '#' + z.node}</span><input type="range" min={0} max={3} step={0.1} value={d.zones?.[z.node] ?? 1} onChange={e => setD(x => ({ ...x, zones: { ...(x.zones ?? {}), [z.node]: +e.target.value } }))} /><span>×{(d.zones?.[z.node] ?? 1).toFixed(1)}</span></label>)}</div>
      </details>
      <div className="sect">
        <label className="zone"><span>Mức độ hỗn loạn</span><input type="range" min={0} max={1} step={0.05} value={p.chaos} onChange={e => p.setChaos(+e.target.value)} /><span>{Math.round(p.chaos * 100)}%</span></label>
        <label className="zone"><span>Vi phạm luật</span><input type="range" min={0} max={3} step={0.1} value={d.violations ?? 1} onChange={e => setD(x => ({ ...x, violations: +e.target.value }))} /><span>×{(d.violations ?? 1).toFixed(1)}</span></label>
        <label className="chk"><input type="checkbox" checked={p.crashes.on} onChange={e => p.setCrashes({ ...p.crashes, on: e.target.checked })} />Va quẹt ngẫu nhiên (có seed)</label>
        {p.crashes.on && <div className="row"><label>Số vụ/giờ <input type="number" step={0.5} min={0} max={20} value={p.crashes.perHour} onChange={e => p.setCrashes({ ...p.crashes, perHour: +e.target.value })} /></label>
          <label>Đứng cãi (phút) <input type="number" min={1} max={90} value={p.crashes.minMin} onChange={e => p.setCrashes({ ...p.crashes, minMin: +e.target.value })} />-<input type="number" min={1} max={120} value={p.crashes.maxMin} onChange={e => p.setCrashes({ ...p.crashes, maxMin: Math.max(p.crashes.minMin, +e.target.value) })} /></label>
          <label className="chk"><input type="checkbox" checked={p.crashes.crowd} onChange={e => p.setCrashes({ ...p.crashes, crowd: e.target.checked })} />người xem</label></div>}
      </div>
      <div className="row">
        <button className="primary" disabled={!dirty} onClick={() => p.onApply({ ...d, name })}>✔ Áp dụng & chạy lại</button>
        <span className="muted small">{count} thay đổi{dirty ? ' (chưa áp dụng)' : ''}</span>
      </div>
      <div className="row">
        <input value={name} onChange={e => setName(e.target.value)} style={{ width: 150 }} />
        <button onClick={() => { const all = load(); all[name] = { ...d, name }; localStorage.setItem(KEY, JSON.stringify(all)); setSaved(Object.keys(all)); }}>💾 Lưu</button>
        {saved.length > 0 && <select value="" onChange={e => { const x = load()[e.target.value]; if (x) { setD(x); setName(e.target.value); } }}><option value="">Tải…</option>{saved.map(k => <option key={k} value={k}>{k}</option>)}</select>}
      </div>
      <div className="row">
        <button onClick={() => { const b = new Blob([JSON.stringify({ format: 'hanoi-flow-lab/edits@1', ...d, name }, null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name.replace(/\s+/g, '_') + '.json'; a.click(); }}>⬇ Xuất JSON</button>
        <button onClick={() => file.current?.click()}>⬆ Nhập JSON</button>
        <input ref={file} type="file" accept="application/json" style={{ display: 'none' }} onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { const x = JSON.parse(await f.text()); delete x.format; setD(x); if (x.name) setName(x.name); } catch { alert('File JSON không hợp lệ'); } }} />
        <button onClick={() => { setD({}); p.onApply({}); }}>↺ Khôi phục Hà Nội mặc định</button>
      </div>
    </div>
  );
}
function load(): Record<string, Edits> { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; } }

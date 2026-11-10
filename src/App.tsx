import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ControllerKind, MapData, Metrics, ScenarioKind, SimConfig, DecisionLog } from './engine/types';
import { SCENARIOS } from './engine/scenarios';
import { SimPanel, type SimPanelHandle } from './ui/SimPanel';
import { Inspector, fmtT } from './ui/Inspector';
import { Chart, fmtN } from './ui/Chart';
import { Compare } from './ui/Compare';
import type { Layers } from './render/MapView';
import type { FromWorker, NodeInfo, Snapshot, VehInfo } from './sim/protocol';

const Q = new URLSearchParams(location.search);
const CTRL: Record<ControllerKind, string> = { fixed: 'Cố định thời gian', actuated: 'Cảm biến (actuated)', ai: 'AI điều phối' };
const SPEEDS = [1, 2, 4, 8, 16, 64];

export default function App() {
  const [data, setData] = useState<MapData | null>(null);
  const [err, setErr] = useState('');
  const [cfg, setCfg] = useState<SimConfig>({ seed: +(Q.get('seed') ?? 42), controller: (Q.get('controller') as ControllerKind) ?? 'ai', scenario: (Q.get('scenario') as ScenarioKind) ?? 'morning', demandScale: +(Q.get('demand') ?? 1), dt: 0.5, ...(Q.get('cap') ? { maxVehicles: +Q.get('cap')! } : {}) });
  const [layers, setLayers] = useState<Layers>({ heat: Q.get('layer') === 'heat', density: Q.get('layer') === 'density', signals: true, ai: true, night: Q.get('night') === '1', light: Q.get('quality') === 'low' });
  const [playing, setPlaying] = useState(true); const [speed, setSpeed] = useState(+(Q.get('speed') ?? 4));
  const [split, setSplit] = useState(Q.get('view') === 'split'); const [splitB, setSplitB] = useState<ControllerKind>('fixed');
  const [showCmp, setShowCmp] = useState(Q.get('compare') === '1');
  const [snapM, setSnapM] = useState<Metrics | null>(null); const [snapB, setSnapB] = useState<Metrics | null>(null);
  const [hist, setHist] = useState<Metrics[]>([]); const [histB, setHistB] = useState<Metrics[]>([]);
  const [info, setInfo] = useState<{ engine: string; sps: number; n: number; fps: number }>({ engine: '', sps: 0, n: 0, fps: 0 });
  const [decs, setDecs] = useState<DecisionLog[]>([]);
  const [node, setNode] = useState<NodeInfo | null>(null); const [veh, setVeh] = useState<VehInfo | null>(null);
  const sel = useRef<{ k: 'veh' | 'node'; id: number } | null>(null);
  const A = useRef<SimPanelHandle>(null); const B = useRef<SimPanelHandle>(null);
  const backend = Q.get('backend');
  const cfgKey = JSON.stringify(cfg);
  const cfgB = useMemo(() => ({ ...cfg, controller: splitB }), [cfgKey, splitB]);

  useEffect(() => {
    fetch(import.meta.env.BASE_URL + 'data/dongda.json').then(r => r.json()).then(setData).catch(e => setErr(String(e)));
  }, []);
  useEffect(() => { setHist([]); setHistB([]); setDecs([]); }, [cfgKey, splitB, split]);
  // poll inspector
  useEffect(() => {
    const t = setInterval(() => {
      const s = sel.current; if (!s) return;
      A.current?.send(s.k === 'veh' ? { type: 'inspectVeh', id: s.id } : { type: 'inspectNode', id: s.id });
    }, 500);
    return () => clearInterval(t);
  }, []);

  const onSnapA = (s: Snapshot) => {
    if (s.metrics) {
      const m = s.metrics; setSnapM(m);
      setHist(h => (h.length && h[h.length - 1].t > m.t) ? [m] : (h.length && m.t - h[h.length - 1].t < 5 ? h : [...h.slice(-720), m]));
      setInfo({ engine: s.engine, sps: s.stepsPerSec, n: s.n, fps: A.current?.fps() ?? 0 });
      if (s.decisions?.length) setDecs(d => [...s.decisions!.slice().reverse(), ...d].slice(0, 80));
    }
  };
  const onSnapB = (s: Snapshot) => { if (s.metrics) { const m = s.metrics; setSnapB(m); setHistB(h => (h.length && h[h.length - 1].t > m.t) ? [m] : (h.length && m.t - h[h.length - 1].t < 5 ? h : [...h.slice(-720), m])); } };
  const onMsgA = (m: FromWorker) => { if (m.type === 'node') { setNode(m.info); setVeh(null); } if (m.type === 'veh') { if (m.info) { setVeh(m.info); setNode(null); } else { setVeh(null); sel.current = null; } } };
  const onPick = (k: 'veh' | 'node', id: number) => { sel.current = { k, id }; A.current?.send(k === 'veh' ? { type: 'inspectVeh', id } : { type: 'inspectNode', id }); };

  if (err) return <div className="loading">Không tải được dữ liệu bản đồ: {err}</div>;
  if (!data) return <div className="loading">Đang tải mạng lưới đường Đống Đa từ OpenStreetMap…</div>;
  const sc = SCENARIOS[cfg.scenario];
  const m = snapM;
  const ser = (h: Metrics[], f: (m: Metrics) => number) => h.map(x => [x.t / 60, f(x)] as [number, number]);

  return (
    <div className={'app' + (layers.night ? ' night' : '')}>
      <header>
        <div className="logo">HANOI<span>FLOW</span>LAB</div>
        <label>Kịch bản <select value={cfg.scenario} onChange={e => setCfg({ ...cfg, scenario: e.target.value as ScenarioKind })}>{Object.values(SCENARIOS).map(s => <option key={s.kind} value={s.kind}>{s.label}</option>)}</select></label>
        <label>{split ? 'Bên trái' : 'Điều khiển'} <select value={cfg.controller} onChange={e => setCfg({ ...cfg, controller: e.target.value as ControllerKind })}>{Object.entries(CTRL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        {split && <label>Bên phải <select value={splitB} onChange={e => setSplitB(e.target.value as ControllerKind)}>{Object.entries(CTRL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
        <label>Seed <input type="number" value={cfg.seed} onChange={e => setCfg({ ...cfg, seed: +e.target.value })} /></label>
        <label>Nhu cầu ×<input type="number" step={0.1} min={0.2} max={4} value={cfg.demandScale} onChange={e => setCfg({ ...cfg, demandScale: Math.max(0.1, +e.target.value) })} /></label>
        <button onClick={() => setPlaying(!playing)}>{playing ? '❚❚ Dừng' : '▶ Chạy'}</button>
        <div className="speeds">{SPEEDS.map(x => <button key={x} className={speed === x ? 'on' : ''} onClick={() => setSpeed(x)}>{x === 64 ? 'Max' : x + '×'}</button>)}</div>
        <button onClick={() => setCfg({ ...cfg })}>↺ Chạy lại</button>
        <button className={split ? 'on' : ''} onClick={() => setSplit(!split)}>⇆ Chia đôi</button>
        <button className="primary" onClick={() => setShowCmp(true)}>⚗ So sánh</button>
      </header>
      <div className="layers">
        {([['heat', 'Nhiệt tốc độ'], ['density', 'Mật độ'], ['signals', 'Đèn tín hiệu'], ['ai', 'Quyết định AI'], ['night', 'Ban đêm'], ['light', 'Chế độ nhẹ']] as [keyof Layers, string][]).map(([k, l]) =>
          <label key={k} className="chk"><input type="checkbox" checked={layers[k]} onChange={e => { const n = { ...layers, [k]: e.target.checked }; if (k === 'heat' && e.target.checked) n.density = false; if (k === 'density' && e.target.checked) n.heat = false; setLayers(n); }} />{l}</label>)}
        <span className="engine" title="Engine đang chạy">⚙ {backend ? 'SUMO (backend): ' + backend : info.engine}</span>
        <span className="perf">{info.n} xe · {info.sps.toFixed(0)} bước/s · {info.fps.toFixed(0)} FPS</span>
      </div>
      <main className={split ? 'split' : ''}>
        <aside className="left">
          <div className="card">
            <div className="card-h">📊 {CTRL[cfg.controller]} · {sc.label}</div>
            <div className="muted small">{sc.desc}</div>
            <div className="kpis">
              <K l="Thời gian" v={m ? fmtT(m.t) : '-'} />
              <K l="Xe trong mạng" v={m ? m.active : '-'} />
              <K l="Chờ vào mạng" v={m ? m.waitingEntry : '-'} warn={!!m && m.waitingEntry > 200} />
              <K l="Đã ra khỏi mạng" v={m ? m.completed : '-'} />
              <K l="Tốc độ TB" v={m ? m.avgSpeedKmh.toFixed(1) + ' km/h' : '-'} />
              <K l="Thông lượng" v={m ? fmtN(m.throughputVph) + ' xe/h' : '-'} />
              <K l="Trễ TB/chuyến" v={m ? m.avgDelayS.toFixed(0) + ' s' : '-'} />
              <K l="Đang dừng" v={m ? m.stopped : '-'} />
              <K l="Dừng > 2 phút" v={m ? m.longStopped : '-'} warn={!!m && m.longStopped > 50} />
              <K l="Hàng chờ dài nhất" v={m ? m.maxQueue + ' xe' : '-'} />
              <K l="Chờ người đi bộ" v={m ? m.pedWaitS.toFixed(0) + ' s' : '-'} />
              <K l="CO₂ ước tính" v={m ? fmtN(m.co2kgH) + ' kg/h' : '-'} />
            </div>
            {split && snapB && <div className="muted small">Bên phải ({CTRL[splitB]}): {snapB.active} xe · {snapB.avgSpeedKmh.toFixed(1)} km/h · trễ {snapB.avgDelayS.toFixed(0)} s · ra {snapB.completed} · chờ vào {snapB.waitingEntry}</div>}
          </div>
          <div className="card">
            <Chart title="Tốc độ trung bình" unit="km/h" series={[{ name: CTRL[cfg.controller], color: '#4fe3ff', pts: ser(hist, x => x.avgSpeedKmh) }, ...(split ? [{ name: CTRL[splitB], color: '#ff7b5c', pts: ser(histB, x => x.avgSpeedKmh) }] : [])]} />
            <Chart title="Xe đang dừng" unit="xe" series={[{ name: CTRL[cfg.controller], color: '#ffd23f', pts: ser(hist, x => x.stopped) }, ...(split ? [{ name: CTRL[splitB], color: '#ff7b5c', pts: ser(histB, x => x.stopped) }] : [])]} />
            <Chart title="Thông lượng (5 phút gần nhất)" unit="xe/h" series={[{ name: CTRL[cfg.controller], color: '#7dff8a', pts: ser(hist, x => x.throughputVph) }, ...(split ? [{ name: CTRL[splitB], color: '#ff7b5c', pts: ser(histB, x => x.throughputVph) }] : [])]} />
          </div>
        </aside>
        <section className="maps">
          <SimPanel ref={A} data={data} cfg={cfg} cfgKey={cfgKey} layers={layers} playing={playing} speed={speed} backend={backend} label={split ? CTRL[cfg.controller] : undefined} onSnap={onSnapA} onMsg={onMsgA} onPick={onPick} />
          {split && <SimPanel ref={B} data={data} cfg={cfgB} cfgKey={JSON.stringify(cfgB)} layers={layers} playing={playing} speed={speed} label={CTRL[splitB]} onSnap={onSnapB} />}
          <div className="legend-map">
            {layers.heat && <span><i style={{ background: '#2ecc71' }} />nhanh <i style={{ background: '#f1c40f' }} />chậm <i style={{ background: '#e74c3c' }} />tắc</span>}
            {layers.density && <span><i style={{ background: '#3498db' }} />thưa <i style={{ background: '#e67e22' }} />đông <i style={{ background: '#8e2de2' }} />kẹt cứng</span>}
            <span><b>🛵</b> xe máy · ô tô · buýt xanh/vàng · tải</span>
          </div>
        </section>
        <aside className="right">
          <Inspector node={node} veh={veh} onClose={() => { sel.current = null; setNode(null); setVeh(null); }} />
          <div className="card log">
            <div className="card-h">🧠 Nhật ký quyết định tín hiệu</div>
            {decs.length === 0 && <div className="muted small">Chưa có quyết định đổi pha.</div>}
            {decs.slice(0, 40).map((d, i) => <div key={i} className={'dec ' + d.kind} onClick={() => onPick('node', d.node)}><span className="t">{fmtT(d.t)}</span> <b>#{d.node}</b> {d.text}</div>)}
          </div>
        </aside>
      </main>
      <footer>Bản đồ: {data.meta.attribution} · Khu vực: {data.meta.area} · {data.meta.counts.nodes} nút, {data.meta.counts.links} đoạn đường, {data.meta.counts.signals} nút đèn · Mô phỏng phục vụ nghiên cứu, không phải số liệu đo thực tế.</footer>
      {showCmp && <Compare data={data} onClose={() => setShowCmp(false)} initial={{ seed: cfg.seed, scenario: cfg.scenario, demandScale: cfg.demandScale }} />}
    </div>
  );
}
function K({ l, v, warn }: { l: string; v: React.ReactNode; warn?: boolean }) { return <div className={'kpi' + (warn ? ' warn' : '')}><div className="kv">{v}</div><div className="kl">{l}</div></div>; }

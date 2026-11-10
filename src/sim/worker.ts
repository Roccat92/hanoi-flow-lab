/// <reference lib="webworker" />
import { Simulation } from '../engine/sim';
import { VTYPES } from '../engine/scenarios';
import { AiCoordinated, FixedTime } from '../engine/controllers';
import type { MapData, SimConfig, Metrics } from '../engine/types';
import { VSTRIDE, type FromWorker, type ToWorker, type NodeInfo, type SignalSnap, type CompareResult } from './protocol';
import { runComparison } from './compare';

let data: MapData; let sim: Simulation; let cfg: SimConfig;
let playing = true; let speed = 1; let light = false;
let lastMetricsT = -1; let decIdx = 0; let stepsDone = 0; let stepsT0 = performance.now(); let sps = 0;
const ENGINE = 'TS Web Worker (IDM + sublane, độ trung thực thấp hơn SUMO)';
const post = (m: FromWorker, tr?: Transferable[]) => (self as any).postMessage(m, tr ?? []);
const pose = { x: 0, y: 0, h: 0 };

function start(c: SimConfig) {
  cfg = c; sim = new Simulation(data, c); lastMetricsT = -1; decIdx = 0;
  post({ type: 'ready', engine: ENGINE, signals: sim.sig.size, links: sim.net.links.length, nodes: sim.net.nodes.length, moves: sim.net.moves.length });
}

function snapshot() {
  const vs = sim.allVehicles();
  const arr = new Float32Array(vs.length * VSTRIDE);
  let k = 0;
  for (const v of vs) {
    sim.pose(v, pose);
    const vmax = v.mv >= 0 ? sim.net.links[sim.net.moves[v.mv].outL].vmax : sim.net.links[v.link].vmax;
    arr[k++] = pose.x; arr[k++] = pose.y; arr[k++] = pose.h; arr[k++] = v.type; arr[k++] = Math.min(1, v.v / vmax); arr[k++] = v.id; arr[k++] = v.v < 0.5 ? 1 : 0;
  }
  const signals: SignalSnap[] = [];
  for (const [id, st] of sim.sig) {
    const n = sim.net.nodes[id];
    signals.push({ id, phase: st.phase, stage: st.stage, t: st.tStage, colors: n.moves.map(m => sim.sigColor(m)).join('') });
  }
  const snap: any = { t: sim.t, n: vs.length, veh: arr, signals, stepsPerSec: sps, engine: ENGINE };
  const tr: Transferable[] = [arr.buffer];
  if (Math.floor(sim.t) !== lastMetricsT) {
    lastMetricsT = Math.floor(sim.t);
    snap.metrics = sim.metrics();
    const ls = new Float32Array(sim.net.links.length), lo = new Float32Array(sim.net.links.length);
    for (const L of sim.net.links) { ls[L.id] = sim.linkSpeed[L.id] / L.vmax; lo[L.id] = sim.occupancy(L.id); }
    snap.linkSpeed = ls; snap.linkOcc = lo; tr.push(ls.buffer, lo.buffer);
    if (sim.log.length < decIdx) decIdx = 0;
    snap.decisions = sim.log.slice(Math.max(decIdx, sim.log.length - 60)); decIdx = sim.log.length;
    snap.incident = sim.incidentLink >= 0 ? { link: sim.incidentLink, s: sim.net.links[sim.incidentLink].len * 0.55, on: !!sim.incidentObs } : null;
  }
  post({ type: 'snap', snap }, tr);
}

let acc = 0; let lastTick = performance.now();
function loop() {
  const now = performance.now(); const real = Math.min(0.1, (now - lastTick) / 1000); lastTick = now;
  if (sim && playing) {
    if (speed >= 64) { // max: run as fast as possible within a 25 ms budget
      const t0 = performance.now(); while (performance.now() - t0 < 25) { sim.step(); stepsDone++; }
    } else {
      acc += real * speed;
      let guard = 0; const t0 = performance.now();
      while (acc >= cfg.dt && guard++ < 400 && performance.now() - t0 < 30) { sim.step(); acc -= cfg.dt; stepsDone++; }
      if (acc > 1) acc = 0; // cannot keep up: drop backlog (sim time slows down, never skips physics)
    }
  }
  if (now - stepsT0 > 1000) { sps = stepsDone * 1000 / (now - stepsT0); stepsDone = 0; stepsT0 = now; }
  if (sim) snapshot();
  setTimeout(loop, light ? 66 : 33);
}

function nodeInfo(id: number): NodeInfo {
  const n = sim.net.nodes[id]; const st = sim.sig.get(id); const obs = sim.getObs(id);
  const ai = new AiCoordinated();
  const approaches = n.inLinks.map(li => {
    const L = sim.net.links[li]; const list = sim.linkV[li];
    let q = 0, sv = 0; for (const v of list) { if (v.obstacle) continue; sv += v.v; if (v.v < 1) q++; }
    return { link: li, name: L.name, queue: q, vehicles: list.length, speedKmh: list.length ? sv / list.length * 3.6 : L.vmax * 3.6 };
  });
  return {
    id, name: n.name, signal: n.signal,
    phases: n.phases.map(p => ({ label: p.label, inLinks: p.inLinks.map(l => sim.net.links[l].name), prot: p.protected.size, perm: p.permissive.size, pedOnly: p.pedOnly })),
    state: st ? { phase: st.phase, stage: st.stage, tStage: st.tStage, minGreen: st.minGreen, switches: st.switches, forced: st.forced, lastReason: st.lastReason, pedWaiting: st.pedQ.map(q => q.length) } : undefined,
    obs: obs?.map(o => ({ queuePcu: o.queuePcu, queueN: o.queueN, arrPcu: o.arrPcu, upArrPcu: o.upArrPcu, outOcc: o.outOcc, maxWait: o.maxWait, pressure: ai.pressure(o) })),
    approaches, log: sim.log.filter(d => d.node === id).slice(-12).reverse(),
    fixedSplits: sim.ctrl instanceof FixedTime ? sim.ctrl.getSplits(id) : undefined,
  };
}

function vehInfo(id: number) {
  const v = sim.allVehicles().find(x => x.id === id); if (!v) return null;
  const L = sim.net.links[v.mv >= 0 ? sim.net.moves[v.mv].inL : v.link];
  const route: string[] = []; let c = v.mv >= 0 ? sim.net.moves[v.mv].outL : v.link; const tab = sim.tables.get(v.dest)!; let g = 0;
  while (c >= 0 && g++ < 40) { const nm = sim.net.links[c].name; if (route[route.length - 1] !== nm) route.push(nm); if (c === v.dest) break; c = tab.next[c]; }
  const vmaxL = sim.net.links[v.link];
  return { id: v.id, type: VTYPES[v.type].name, speedKmh: v.v * 3.6, link: L.name, next: v.next >= 0 ? sim.net.links[v.next].name : 'Điểm đến', dest: sim.net.links[v.dest].name,
    travelS: sim.t - v.tCreate, ffS: v.ff, stops: v.stops, waitS: v.waitTotal, lat: v.lat / vmaxL.width, inJunction: v.mv >= 0, route };
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'init') { data = m.data; start(m.cfg); loop(); }
  else if (m.type === 'reset') start(m.cfg);
  else if (m.type === 'play') playing = m.on;
  else if (m.type === 'speed') speed = m.x;
  else if (m.type === 'light') light = m.on;
  else if (m.type === 'inspectNode') post({ type: 'node', info: nodeInfo(m.id) });
  else if (m.type === 'inspectVeh') post({ type: 'veh', info: vehInfo(m.id) });
  else if (m.type === 'series') post({ type: 'series', series: sim.series.slice() as Metrics[] });
  else if (m.type === 'compare') {
    const results: CompareResult[] = runComparison(data, m, (done, total, label) => post({ type: 'compareProgress', done, total, label }));
    post({ type: 'compareDone', results, cfg: { seed: m.seed, scenario: m.scenario, minutes: m.minutes, demandScale: m.demandScale } });
  }
};

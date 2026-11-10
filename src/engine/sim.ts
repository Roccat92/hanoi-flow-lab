import { Network, cubicAt, type Link, type Movement, type Node } from './network';
import { Router, type RouteTable } from './routing';
import { Rng } from './rng';
import { SCENARIOS, VTYPES, type Scenario } from './scenarios';
import { makeController, FixedTime, SAFETY, type Controller, type PhaseObs, type SignalState } from './controllers';
import type { DecisionLog, MapData, Metrics, SimConfig, VType } from './types';

export class Veh {
  id = 0; type: VType = 0; len = 0; w = 0; a = 0; b = 0; T = 0; s0 = 0; v0f = 1; pcu = 1;
  link = -1; mv = -1; s = 0; v = 0; acc = 0; lat = 0; latT = 0; latFrac = 0.5;
  dest = -1; next = -1; tCreate = 0; tEnter = 0; ff = 0; stops = 0; stopped = false; stopT = 0; waitTotal = 0;
  committed = false; resMv = -1; lcT = 0; obstacle = false; lim = Infinity; dist = 0;
  gx0 = 0; gy0 = 0; gh0 = 0; gx3 = 0; gy3 = 0; gh3 = 0; // movement geometry
}

interface Source { link: number; rate: number; nextT: number; queue: Veh[]; west: boolean }
const ZONE = 14;
const MAXLEN = 18; // longest body (incident obstacle); used to bound leader scans // metres at link entry used for spill-back (don't block the box) checks
const tmp = { x: 0, y: 0, h: 0 };

export class Simulation {
  net: Network; router: Router; rng: Rng; sc: Scenario; ctrl: Controller;
  t = 0; step_ = 0; nextId = 1;
  linkV: Veh[][]; mvV: Veh[][];
  tailOcc: Float64Array; linkSpeed: Float64Array; linkPcu: Float64Array;
  sinks!: number[]; sinkW!: number[]; tables = new Map<number, RouteTable>(); ffTables = new Map<number, RouteTable>();
  sources: Source[] = []; sig = new Map<number, SignalState>(); pedMin = new Map<number, number[]>();
  moveOf = new Map<number, number>(); goCache: Int32Array; goStamp: Int32Array; resv: Int32Array;
  log: DecisionLog[] = []; series: Metrics[] = [];
  done: { tt: number; delay: number; stops: number; t: number }[] = [];
  spawned = 0; completed = 0; sumDelay = 0; sumTT = 0; sumStops = 0; co2g = 0; pedWaitSum = 0; pedServed = 0;
  incidentLink = -1; incidentObs: Veh | null = null; eventNode = -1; eventLinks: number[] = [];
  safetyViolations = 0; checkSafety = false; maxDisp = 0;
  private lastObs = new Map<number, PhaseObs[]>();

  constructor(data: MapData, public cfg: SimConfig) {
    this.net = new Network(data); this.router = new Router(this.net); this.rng = new Rng(cfg.seed);
    this.sc = SCENARIOS[cfg.scenario]; this.ctrl = makeController(cfg.controller);
    const nL = this.net.links.length, nM = this.net.moves.length;
    this.linkV = Array.from({ length: nL }, () => []); this.mvV = Array.from({ length: nM }, () => []);
    this.tailOcc = new Float64Array(nL); this.linkSpeed = new Float64Array(nL); this.linkPcu = new Float64Array(nL);
    this.goCache = new Int32Array(nM); this.goStamp = new Int32Array(nM).fill(-1); this.resv = new Int32Array(nM);
    for (const m of this.net.moves) this.moveOf.set(m.inL * 65536 + m.outL, m.id);
    for (const L of this.net.links) this.linkSpeed[L.id] = L.vmax;
    this.setupEvent(); this.setupSinks(); this.setupSignals(); this.setupSources(); this.setupIncident();
  }

  // ---------------------------------------------------------------- setup
  private setupEvent() {
    if (!this.sc.event) return;
    // Gò Đống Đa (Tây Sơn / Đặng Tiến Đông) ~ 21.0147N 105.8237E
    const [lat0, lon0] = this.net.data.meta.origin;
    const x = (105.8237 - lon0) * Math.cos(lat0 * Math.PI / 180) * 111320, y = -(21.0147 - lat0) * 110540;
    let best = -1, bd = Infinity;
    for (const n of this.net.nodes) { if (n.boundary || n.inLinks.length === 0) continue; const d = Math.hypot(n.x - x, n.y - y); if (d < bd) { bd = d; best = n.id; } }
    this.eventNode = best; this.eventLinks = this.net.nodes[best].inLinks.slice();
  }
  private setupSinks() {
    const bias = this.sc.inboundBias;
    this.sinks = [...this.net.sinks, ...this.eventLinks];
    this.sinkW = this.sinks.map(l => {
      const L = this.net.links[l];
      if (this.eventLinks.includes(l)) return 0; // event trips are drawn separately
      const east = this.net.nodes[L.to].x > 0;
      return L.rank * L.lanes * (east ? bias : 1 / bias);
    });
    const ff = new Float64Array(this.net.links.length);
    for (const L of this.net.links) ff[L.id] = L.len / L.vmax;
    for (const d of this.sinks) {
      this.ffTables.set(d, this.router.tableTo(d, ff, m => this.net.moves[m].len / this.net.links[this.net.moves[m].outL].vmax));
    }
    this.refreshRoutes();
  }
  refreshRoutes() {
    const cost = new Float64Array(this.net.links.length);
    for (const L of this.net.links) cost[L.id] = L.len / Math.max(1, Math.min(L.vmax, this.linkSpeed[L.id]));
    const turn = (mi: number) => { const m = this.net.moves[mi]; const n = this.net.nodes[m.node]; return (n.signal ? 12 : 2) + (m.turn === 'L' ? 6 : m.turn === 'U' ? 20 : 0); };
    for (const d of this.sinks) this.tables.set(d, this.router.tableTo(d, cost, turn));
  }
  private setupSignals() {
    for (const n of this.net.nodes) {
      if (!n.signal) continue;
      const pm = n.phases.map((p, i) => {
        // pedestrians walking parallel to phase i cross the roads of the other phases
        let w = 0; n.phases.forEach((q, j) => { if (j !== i) for (const l of q.inLinks) w = Math.max(w, this.net.links[l].width); });
        if (p.pedOnly) for (const l of n.inLinks) w = Math.max(w, this.net.links[l].width);
        return Math.ceil(5 + (2 * w) / 1.2);
      });
      this.pedMin.set(n.id, pm);
      this.sig.set(n.id, { phase: 0, stage: 'G', tStage: 0, next: 0, lastEnd: n.phases.map(() => 0), minGreen: SAFETY.MIN_GREEN, pedQ: n.phases.map(() => []), switches: 0, lastReason: '', lastDecisionT: 0, forced: 0 });
      if (this.ctrl instanceof FixedTime) {
        const w = n.phases.map(p => p.pedOnly ? 0.2 : p.inLinks.reduce((a, l) => a + this.net.links[l].lanes * this.net.links[l].rank, 0));
        this.ctrl.setSplits(n, w, pm);
      }
    }
  }
  private setupSources() {
    const bias = this.sc.inboundBias;
    const src = this.net.sources.map(l => { const L = this.net.links[l]; const west = this.net.nodes[L.from].x <= 0; return { l, w: L.rank * L.lanes * (west ? bias : 1 / bias), west }; });
    const tot = src.reduce((a, s) => a + s.w, 0);
    const vph = this.sc.demandVph * this.cfg.demandScale;
    for (const s of src) {
      const rate = vph * s.w / tot / 3600;
      this.sources.push({ link: s.l, rate, nextT: this.rng.exp(rate), queue: [], west: s.west });
    }
  }
  private setupIncident() {
    if (!this.sc.incident) return;
    let best = -1, bl = 0;
    for (const L of this.net.links) if (L.name.includes('Xã Đàn') && !L.twoWay && L.len > bl) { bl = L.len; best = L.id; }
    if (best < 0) for (const L of this.net.links) if (L.cls === 'primary' && L.len > bl) { bl = L.len; best = L.id; }
    this.incidentLink = best;
  }

  // ---------------------------------------------------------------- vehicles
  private makeVeh(type: VType, src: number): Veh {
    const p = VTYPES[type]; const v = new Veh(); const sc = this.sc; const r = this.rng;
    v.id = this.nextId++; v.type = type; v.len = p.len; v.w = p.w; v.a = p.a * sc.accelFactor * r.range(0.85, 1.15);
    v.b = p.b; v.T = p.T * sc.headwayFactor * r.range(0.85, 1.2); v.s0 = p.s0; v.v0f = p.vf * sc.speedFactor * r.range(0.88, 1.1); v.pcu = p.pcu;
    v.tCreate = this.t;
    // destination
    let dest = -1;
    for (let tries = 0; tries < 12 && dest < 0; tries++) {
      let d: number;
      if (this.eventLinks.length && r.next() < 3000 / (this.sc.demandVph * this.cfg.demandScale)) d = this.eventLinks[Math.floor(r.next() * this.eventLinks.length)];
      else d = r.pick(this.sinks, this.sinkW);
      const ft = this.ffTables.get(d)!;
      if (!isFinite(ft.cost[src]) || this.net.links[d].to === this.net.links[src].from) continue;
      if (ft.cost[src] < 40) continue; // too short a trip
      dest = d; v.ff = ft.cost[src];
    }
    if (dest < 0) { dest = this.sinks.find(d => isFinite(this.ffTables.get(d)!.cost[src]) && d !== src) ?? src; v.ff = this.ffTables.get(dest)!.cost[src]; }
    v.dest = dest;
    return v;
  }
  private spawnRate(): number { return 1; }

  private trySpawn(s: Source) {
    // generate arrivals (Poisson) into the entry queue; vehicles are never dropped
    while (s.nextT <= this.t) {
      const r = this.rng.next(); const mix = this.sc.mix;
      const type: VType = r < mix[0] ? 0 : r < mix[0] + mix[1] ? 1 : r < mix[0] + mix[1] + mix[2] ? 2 : 3;
      s.queue.push(this.makeVeh(type, s.link)); this.spawned++;
      s.nextT += this.rng.exp(s.rate * this.spawnRate());
    }
    const cap = this.cfg.maxVehicles ?? Infinity;
    const L = this.net.links[s.link]; const list = this.linkV[s.link];
    let guard = 0;
    while (s.queue.length && guard++ < 4 && this.activeCount < cap) {
      const v = s.queue[0];
      const cand = v.type === 0 ? [0.2, 0.5, 0.8, 0.35, 0.65, 0.1, 0.9] : laneCenters(L);
      let placed = false;
      for (const c of cand) {
        const lat = v.type === 0 ? clampLat(L, v, c * L.width) : c;
        const front = v.len + 0.2;
        let ok = true;
        for (let i = list.length - 1; i >= 0; i--) { const o = list[i]; if (o.s - MAXLEN > front + 3 + o.v * 0.8) break; if (o.s - o.len < front + 3 + o.v * 0.8 && overlapLat(o, lat, v.w, 0.25)) { ok = false; break; } }
        if (ok) for (const mi of L.inMoves) for (const o of this.mvV[mi]) if (overlapLat(o, lat, v.w, 0.25)) { ok = false; break; }
        if (ok) { v.lat = v.latT = lat; v.s = front; v.link = s.link; placed = true; break; }
      }
      if (!placed) break;
      s.queue.shift();
      v.v = Math.min(L.vmax * v.v0f * 0.5, 6); v.tEnter = this.t; v.next = this.nextLinkOf(v, s.link);
      list.push(v); this.activeCount++;
    }
  }
  activeCount = 0;

  private nextLinkOf(v: Veh, link: number) {
    if (link === v.dest) return -1;
    const t = this.tables.get(v.dest)!;
    let n = t.next[link];
    if (n < 0) { const ft = this.ffTables.get(v.dest)!; n = ft.next[link]; }
    if (n < 0) { const L = this.net.links[link]; n = L.outMoves.length ? this.net.moves[L.outMoves[0]].outL : -1; }
    return n;
  }
  /** lateral position a vehicle will take on the exit link of movement m (cars snap to lane centres) */
  mapLat(v: Veh, m: Movement) {
    const inL = this.net.links[m.inL], out = this.net.links[m.outL];
    const lat = clampLat(out, v, Math.min(0.95, Math.max(0.05, v.lat / inL.width)) * out.width);
    if (v.type === 0) return lat;
    const lanes = laneCenters(out); return lanes[nearestIdx(lanes, lat)];
  }
  private moveFor(v: Veh) { return v.next < 0 ? -1 : (this.moveOf.get(v.link * 65536 + v.next) ?? -1); }

  // ---------------------------------------------------------------- signals
  sigColor(mi: number): 'G' | 'g' | 'Y' | 'R' | 'N' {
    const m = this.net.moves[mi]; const st = this.sig.get(m.node); if (!st) return 'N';
    const ph = this.net.nodes[m.node].phases[st.phase];
    const inPh = ph.protected.has(mi) ? 'G' : ph.permissive.has(mi) ? 'g' : '';
    if (!inPh) return 'R';
    if (st.stage === 'G') return inPh as 'G' | 'g';
    if (st.stage === 'Y') return 'Y';
    return 'R';
  }

  private updateSignals(dt: number) {
    const tick = Math.abs(this.t - Math.round(this.t)) < dt / 2; // once per second
    for (const [nid, st] of this.sig) {
      const n = this.net.nodes[nid];
      st.tStage += dt;
      // pedestrians
      const pr = this.sc.pedRate / 3600;
      for (let p = 0; p < n.phases.length; p++) if (this.rng.next() < pr * dt) st.pedQ[p].push(this.t);
      if (st.stage === 'Y' && st.tStage >= SAFETY.YELLOW) { st.stage = 'R'; st.tStage = 0; }
      else if (st.stage === 'R' && st.tStage >= SAFETY.ALL_RED) {
        st.lastEnd[st.phase] = this.t; st.phase = st.next; st.stage = 'G'; st.tStage = 0; st.switches++;
        const q = st.pedQ[st.phase];
        const pm = this.pedMin.get(nid)![st.phase];
        st.minGreen = Math.max(SAFETY.MIN_GREEN, q.length ? pm : 0, n.phases[st.phase].pedOnly ? pm : 0);
        for (const a of q) { this.pedWaitSum += this.t - a; this.pedServed++; }
        q.length = 0;
      } else if (st.stage === 'G' && tick && st.tStage >= st.minGreen) {
        const obs = this.observe(n, st); this.lastObs.set(nid, obs);
        let d = this.ctrl.decide(n, st, obs, this.t);
        let kind: DecisionLog['kind'] = 'switch';
        // safety layer: max green and anti-starvation override the controller
        for (let p = 0; p < obs.length; p++) {
          if (p !== st.phase && obs[p].demand && this.t - st.lastEnd[p] > SAFETY.MAX_RED + st.tStage * 0 && st.tStage >= st.minGreen && (!d || d.switchTo !== p)) {
            const waitP = this.t - Math.max(st.lastEnd[p], 0);
            if (waitP > SAFETY.MAX_RED) { d = { switchTo: p, text: `An toàn: pha ${p + 1} đã đỏ ${Math.round(waitP)}s > ${SAFETY.MAX_RED}s (chống bỏ đói), buộc chuyển`, values: { red: waitP } }; kind = 'force'; st.forced++; break; }
          }
        }
        if (!d && st.tStage >= SAFETY.MAX_GREEN) {
          const p = obs.findIndex((o, i) => i !== st.phase && o.demand);
          if (p >= 0) { d = { switchTo: p, text: `An toàn: đạt xanh tối đa ${SAFETY.MAX_GREEN}s`, values: { green: st.tStage } }; kind = 'force'; st.forced++; }
        }
        if (d && d.switchTo !== st.phase) {
          st.next = d.switchTo; st.stage = 'Y'; st.tStage = 0; st.lastReason = d.text; st.lastDecisionT = this.t;
          this.log.push({ t: this.t, node: nid, from: st.phase, to: d.switchTo, kind, text: d.text, values: d.values });
          if (this.log.length > 4000) this.log.splice(0, 1000);
        }
      }
    }
  }

  observe(n: Node, st: SignalState): PhaseObs[] {
    const H = 12;
    return n.phases.map((ph, pi) => {
      const o: PhaseObs = { queuePcu: 0, queueN: 0, arrPcu: 0, upArrPcu: 0, outOcc: 0, maxWait: 0, gapS: 99, pedWaiting: st.pedQ[pi].length, pedOldest: st.pedQ[pi].length ? this.t - st.pedQ[pi][0] : 0, demand: false, motos: 0, cars: 0, buses: 0 };
      for (const li of ph.inLinks) {
        const L = this.net.links[li];
        for (const v of this.linkV[li]) {
          if (v.obstacle) continue;
          const d = L.stopS - v.s;
          if (d > 150 || d < -1) continue;
          const w = v.type === 2 ? 3 : v.pcu; // bus priority weight
          if (v.v < 1.5) {
            o.queuePcu += w; o.queueN++; o.maxWait = Math.max(o.maxWait, v.stopT);
            if (v.type === 0) o.motos++; else if (v.type === 2) o.buses++; else o.cars++;
          } else {
            const eta = d / v.v; if (eta <= H) o.arrPcu += w; if (d < 40) o.gapS = Math.min(o.gapS, eta);
          }
        }
        // platoons released upstream (coordination signal)
        for (const mi of L.inMoves) {
          const U = this.net.links[this.net.moves[mi].inL];
          for (const v of this.linkV[U.id]) { if (v.next !== li || v.v < 2) continue; const eta = (U.stopS - v.s) / v.v + L.stopS / L.vmax; if (eta <= H) o.upArrPcu += v.pcu; }
          for (const v of this.mvV[mi]) { const eta = L.stopS / L.vmax; if (eta <= H) o.upArrPcu += v.pcu; }
        }
      }
      let occ = 0, cnt = 0;
      for (const mi of ph.moves) { const ol = this.net.moves[mi].outL; occ += this.occupancy(ol); cnt++; }
      o.outOcc = cnt ? occ / cnt : 0;
      o.demand = o.queueN > 0 || o.arrPcu > 0 || o.pedWaiting > 0;
      return o;
    });
  }
  occupancy(l: number) { const L = this.net.links[l]; return Math.min(1.5, this.linkPcu[l] / Math.max(1, (L.len * L.lanes) / 6.5)); }

  // ---------------------------------------------------------------- movement permission
  /** may a vehicle start movement mi now? (signal + yield + box + spill-back) */
  private canGo(mi: number, v: Veh): boolean {
    const m = this.net.moves[mi]; const col = this.sigColor(mi);
    if (col === 'R' || col === 'Y') return false;
    if (this.goStamp[mi] !== this.step_) {
      this.goStamp[mi] = this.step_;
      this.goCache[mi] = this.boxClear(m) && this.yieldOk(m, col) ? 1 : 0;
    }
    if (!this.goCache[mi]) {
      // deadlock breaker at uncontrolled/permissive conflicts: after 25 s waiting, only the box rule applies
      if (!(v.stopT > 25 && col !== 'G' && this.boxClear(m))) return false;
    }
    return this.spaceOk(m, v);
  }
  /** don't block the box: enter only if the exit has room for this vehicle in its lateral band */
  private spaceOk(m: Movement, v: Veh) {
    const out = this.net.links[m.outL];
    const lat = this.mapLat(v, m);
    // the start of the movement itself must be free in my band
    for (const o of this.mvV[m.id]) if (o.s - o.len < 0.6 && Math.abs(o.lat - lat) < (o.w + v.w) / 2 + 0.1) return false;
    let room = Infinity;
    const list = this.linkV[m.outL];
    for (let j = list.length - 1; j >= 0; j--) {
      const o = list[j]; const back = o.s - o.len - out.startS;
      if (back - MAXLEN > Math.min(room, v.len + 40)) break;
      if (back < room && overlapLat(o, lat, v.w, 0.1)) room = back;
    }
    if (room === Infinity) room = 1000; // nobody in my band at the exit: a long vehicle may extend over a short link
    for (const o of this.mvV[m.id]) if (Math.abs(o.lat - lat) < (o.w + v.w) / 2 + 0.1) room -= o.len + 0.5;
    return room >= v.len + 0.8;
  }
  private boxClear(m: Movement) { for (const c of m.conflicts) if (this.mvV[c].length || this.resv[c]) return false; return true; }
  /** a committed vehicle reserves its movement: conflicting movements cannot be granted until it has crossed */
  private reserve(v: Veh, mi: number) {
    v.committed = true; v.resMv = mi; this.resv[mi]++;
    for (const c of this.net.moves[mi].conflicts) { this.goStamp[c] = this.step_; this.goCache[c] = 0; }
  }
  release(v: Veh) { if (v.resMv >= 0) { this.resv[v.resMv]--; v.resMv = -1; } v.committed = false; }
  private yieldOk(m: Movement, col: string) {
    const L = this.net.links[m.inL];
    for (const c of m.conflicts) {
      const cm = this.net.moves[c];
      let prior: boolean;
      if (col === 'g') prior = this.sigColor(c) === 'G';
      else if (col === 'N') prior = this.net.links[cm.inL].rank > L.rank;
      else prior = false;
      if (!prior) continue;
      const CL = this.net.links[cm.inL]; const list = this.linkV[cm.inL];
      for (let i = 0, k = 0; i < list.length && k < 8; i++) {
        const o = list[i]; if (o.obstacle) continue; k++;
        const d = CL.stopS - o.s; if (d > 60) break;
        if (o.next !== cm.outL) continue;
        if (d / Math.max(o.v, 0.8) < 3.0) return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- main step
  step() {
    const dt = this.cfg.dt; this.step_++;
    for (const s of this.sources) this.trySpawn(s);
    this.incidentUpdate();
    this.updateSignals(dt);
    this.computeTails();
    // 1) lateral behaviour (first, so car-following below sees the new lateral positions)
    for (let li = 0; li < this.linkV.length; li++) { const list = this.linkV[li]; const L = this.net.links[li]; for (let i = 0; i < list.length; i++) this.lateral(list, i, L, dt); }
    // 2) accelerations (front to back on links, then movements)
    for (let li = 0; li < this.linkV.length; li++) {
      const list = this.linkV[li]; const L = this.net.links[li];
      for (let i = 0; i < list.length; i++) this.accelOnLink(list, i, L);
    }
    for (let mi = 0; mi < this.mvV.length; mi++) {
      const list = this.mvV[mi]; const m = this.net.moves[mi];
      for (let i = 0; i < list.length; i++) this.accelInMove(list, i, m);
    }
    // 3) integrate + transitions
    this.integrate(dt);
    this.t = Math.round((this.t + dt) * 1000) / 1000;
    if (this.step_ % Math.round(1 / dt) === 0) this.linkStats();
    if (this.step_ % Math.round(10 / dt) === 0) this.series.push(this.metrics());
    if (this.step_ % Math.round(60 / dt) === 0) this.refreshRoutes();
    if (this.checkSafety) this.verifySafety();
  }

  private computeTails() {
    this.tailOcc.fill(0);
    for (let li = 0; li < this.linkV.length; li++) {
      const L = this.net.links[li]; const list = this.linkV[li];
      for (let i = list.length - 1; i >= 0; i--) { const v = list[i]; if (v.s - v.len > L.startS + ZONE) break; this.tailOcc[li] += (v.len + 1) * (v.w + 0.4); }
    }
    for (let mi = 0; mi < this.mvV.length; mi++) { const ol = this.net.moves[mi].outL; for (const v of this.mvV[mi]) this.tailOcc[ol] += (v.len + 1) * (v.w + 0.4); }
  }

  private idm(v: Veh, vmax: number, gap: number, vl: number) {
    const v0 = Math.max(1, vmax * v.v0f);
    const ss = v.s0 + Math.max(0, v.v * v.T + (v.v * (v.v - vl)) / (2 * Math.sqrt(v.a * v.b)));
    const g = Math.max(gap, 0.05);
    let a = v.a * (1 - Math.pow(v.v / v0, 4) - (ss / g) * (ss / g));
    if (a < -9) a = -9;
    return a;
  }

  /** vehicle ahead whose lateral span overlaps (lat, w) and whose rear is closest (lists are sorted by front position) */
  private leaderIn(list: Veh[], i: number, s: number, lat: number, w: number, maxD: number): Veh | null {
    let best: Veh | null = null, bb = Infinity;
    for (let j = i - 1; j >= 0; j--) {
      const o = list[j];
      if (o.s - MAXLEN > bb || o.s - MAXLEN - s > maxD) break;
      const back = o.s - o.len;
      if (back < bb && back - s <= maxD && overlapLat(o, lat, w, 0.2)) { best = o; bb = back; }
    }
    return best;
  }
  private tailOf(list: Veh[], lat: number, w: number, maxS: number): Veh | null {
    let best: Veh | null = null, bb = Infinity;
    for (let j = list.length - 1; j >= 0; j--) {
      const o = list[j];
      if (o.s - MAXLEN > Math.min(bb, maxS)) break;
      const back = o.s - o.len;
      if (back < bb && back <= maxS && overlapLat(o, lat, w, 0.2)) { best = o; bb = back; }
    }
    return best;
  }

  private accelOnLink(list: Veh[], i: number, L: Link) {
    const v = list[i]; if (v.obstacle) { v.acc = 0; v.lim = 0; return; }
    const vmax = L.vmax * (this.incidentObs && L.id === this.incidentLink ? 0.6 : 1);
    const ld = this.leaderIn(list, i, v.s, v.lat, v.w, 80);
    let gap = Infinity, vl = 0;
    if (ld) { gap = ld.s - ld.len - v.s; vl = ld.v; }
    if (v.next < 0) { // destination link: drive off the end
      const end = (this.eventLinks.includes(L.id) ? L.stopS : L.len + 30) - v.s;
      if (this.eventLinks.includes(L.id) && end < gap) { gap = end + 1.5; vl = 0; }
    } else if (!ld || ld.s - ld.len > L.stopS) {
      const d = L.stopS - v.s;
      if (d < 70) {
        const mi = this.moveFor(v);
        let go = false;
        if (mi >= 0) {
          const col = this.sigColor(mi);
          const canStop = d > (v.v * v.v) / (2 * 4.0) + 0.5;
          const commitDist = (v.v * v.v) / (2 * 2.5) + 3;
          if (v.committed) {
            // keep a reservation unless the light turned amber/red and we can still stop comfortably
            if (col === 'G' || col === 'g' || col === 'N' || !canStop) go = true;
            else this.release(v);
          } else if (col !== 'Y' && col !== 'R') {
            go = this.canGo(mi, v);
            if (go && d < commitDist) this.reserve(v, mi);
          }
        }
        if (!go) { if (d < gap) { gap = d + 0.3; vl = 0; } }
        else {
          const m = this.net.moves[mi]; const ml = this.mvV[mi];
          const ml2 = this.mapLat(v, m);
          const t = this.tailOf(ml, ml2, v.w, 30);
          if (t) { const g2 = d + t.s - t.len; if (g2 < gap) { gap = g2; vl = t.v; } }
          else {
            const out = this.net.links[m.outL];
            const ot = this.tailOf(this.linkV[m.outL], ml2, v.w, out.startS + 30);
            if (ot) { const g2 = d + m.len + ot.s - ot.len - out.startS; if (g2 < gap) { gap = g2; vl = ot.v; } }
          }
        }
      }
    }
    v.acc = this.idm(v, vmax, gap, vl);
    v.lim = gap - 0.1;
  }

  private accelInMove(list: Veh[], i: number, m: Movement) {
    const v = list[i];
    const out = this.net.links[m.outL];
    const ld = this.leaderIn(list, i, v.s, v.lat, v.w, 40);
    let gap = Infinity, vl = 0;
    if (ld) { gap = ld.s - ld.len - v.s; vl = ld.v; }
    else {
      const ot = this.tailOf(this.linkV[m.outL], v.lat, v.w, out.startS + 30);
      if (ot) { gap = m.len - v.s + ot.s - ot.len - out.startS; vl = ot.v; }
    }
    const vmax = Math.min(out.vmax, m.turn === 'T' ? out.vmax : 6.5);
    v.acc = this.idm(v, vmax, gap, vl);
    v.lim = gap - 0.1;
  }

  /** sublane lateral behaviour: motorbikes filter through gaps, cars change lanes; both pre-position for turns */
  private lateral(list: Veh[], i: number, L: Link, dt: number) {
    const v = list[i]; if (v.obstacle) return;
    const turnLat = this.turnBand(v, L);
    if (v.type === 0) {
      if ((this.step_ + v.id) % 2 === 0) {
        let best = v.latT, bs = -Infinity;
        for (const dl of [-1.2, -0.6, 0, 0.6, 1.2]) {
          const c = clampLat(L, v, v.lat + dl);
          const ld = this.leaderIn(list, i, v.s, c, v.w, 40);
          let g = ld ? Math.min(40, ld.s - ld.len - v.s) + (ld.v - v.v) * 0.5 : 40;
          g -= Math.abs(c - v.lat) * 1.5;
          if (turnLat >= 0) g -= Math.abs(c - turnLat) * 1.2;
          else g -= Math.abs(c - L.width * 0.7) * 0.15; // keep right when cruising
          if (g > bs + 0.01 && this.lateralSafe(list, i, v, c)) { bs = g; best = c; }
        }
        v.latT = best;
      }
    } else if (this.t >= v.lcT) {
      v.lcT = this.t + 2;
      const lanes = laneCenters(L); const cur = nearestIdx(lanes, v.lat);
      let target = cur;
      if (turnLat >= 0) target = nearestIdx(lanes, turnLat);
      else {
        const gCur = this.frontGap(list, i, v, lanes[cur]);
        for (const k of [cur - 1, cur + 1]) {
          if (k < 0 || k >= lanes.length) continue;
          if (this.frontGap(list, i, v, lanes[k]) > gCur + 12) target = k;
        }
      }
      if (target !== cur) {
        const step = target > cur ? cur + 1 : cur - 1;
        if (this.lateralSafe(list, i, v, lanes[step])) v.latT = lanes[step];
      }
    }
    // move toward target at limited lateral speed, re-checking side clearance
    const dl = v.latT - v.lat;
    if (Math.abs(dl) > 0.01) {
      const vlat = v.type === 0 ? 1.2 : 0.8;
      const nl = v.lat + Math.sign(dl) * Math.min(Math.abs(dl), vlat * dt);
      if (this.lateralSafe(list, i, v, nl)) v.lat = nl; else v.latT = v.lat;
    }
  }
  private frontGap(list: Veh[], i: number, v: Veh, lat: number) { const ld = this.leaderIn(list, i, v.s, lat, v.w, 60); return ld ? ld.s - ld.len - v.s : 60; }
  private turnBand(v: Veh, L: Link) {
    if (v.next < 0 || L.stopS - v.s > 70) return -1;
    const mi = this.moveFor(v); if (mi < 0) return -1;
    const t = this.net.moves[mi].turn;
    if (t === 'T') return -1;
    return t === 'R' ? L.width - v.w / 2 - 0.3 : v.w / 2 + 0.3;
  }
  /** no vehicle alongside would overlap if v were at lateral position c (incl. follower safety gap) */
  private lateralSafe(list: Veh[], i: number, v: Veh, c: number) {
    const lo = Math.min(v.lat, c), hi = Math.max(v.lat, c);
    for (let j = i - 1; j >= 0; j--) {
      const o = list[j]; if (o.s > v.s + MAXLEN + 2) break; if (o.s - o.len > v.s + 0.5 + v.v * 0.3) continue;
      if (sweepOverlap(o, lo, hi, v.w)) return false;
    }
    for (let j = i + 1; j < list.length; j++) {
      const o = list[j]; if (o.s < v.s - v.len - 1 - o.v * 0.6) break;
      if (sweepOverlap(o, lo, hi, v.w)) return false;
    }
    // vehicles about to enter this link from the junction behind
    if (v.s - v.len < this.net.links[v.link].startS + 4) {
      for (const mi of this.net.links[v.link].inMoves) for (const o of this.mvV[mi]) if (sweepOverlap(o, lo, hi, v.w)) return false;
    }
    return true;
  }

  private integrate(dt: number) {
    const transfersMv: [Veh, number][] = []; const transfersLink: [Veh, number, Movement][] = []; const exits: Veh[] = [];
    for (let li = 0; li < this.linkV.length; li++) {
      const list = this.linkV[li]; const L = this.net.links[li];
      for (const v of list) {
        if (v.obstacle) continue;
        this.advance(v, dt);
        if (v.next < 0) {
          const endS = this.eventLinks.includes(li) ? L.stopS : L.len;
          if (v.s >= endS - 0.6) exits.push(v);
        } else if (v.s >= L.stopS && v.committed) {
          const mi = this.moveFor(v); if (mi >= 0) transfersMv.push([v, mi]);
        } else if (v.s > L.stopS) { v.s = L.stopS; v.v = 0; }
      }
    }
    for (let mi = 0; mi < this.mvV.length; mi++) {
      const m = this.net.moves[mi];
      for (const v of this.mvV[mi]) { this.advance(v, dt); if (v.s >= m.len) transfersLink.push([v, m.outL, m]); }
    }
    for (const v of exits) { removeFrom(this.linkV[v.link], v); this.finish(v); }
    for (const [v, mi] of transfersMv) {
      const L = this.net.links[v.link]; const m = this.net.moves[mi];
      const over = v.s - L.stopS;
      // two vehicles released in the same step may map onto the same exit band: the later one waits at the line
      const olat = this.mapLat(v, m);
      if (this.mvV[mi].some(o => Math.abs(o.lat - olat) < (o.w + v.w) / 2 + 0.05 && o.s - o.len < over + 0.1)) { v.s = L.stopS; v.v = Math.min(v.v, 1); continue; }
      removeFrom(this.linkV[v.link], v);
      v.latFrac = Math.min(0.95, Math.max(0.05, v.lat / L.width));
      this.net.pointAt(L, L.stopS, this.net.offsetOf(L, v.lat), tmp); v.gx0 = tmp.x; v.gy0 = tmp.y; v.gh0 = tmp.h;
      const out = this.net.links[m.outL];
      const ol = this.mapLat(v, m);
      this.net.pointAt(out, out.startS, this.net.offsetOf(out, ol), tmp); v.gx3 = tmp.x; v.gy3 = tmp.y; v.gh3 = tmp.h;
      v.lat = v.latT = ol; // from here on the lateral position is expressed in the exit link frame
      this.release(v); v.mv = mi; v.s = over; this.mvV[mi].push(v);
    }
    for (const [v, ol, m] of transfersLink) {
      const over = v.s - m.len;
      removeFrom(this.mvV[m.id], v);
      const out = this.net.links[ol];
      v.mv = -1; v.link = ol; v.s = out.startS + over;
      v.next = this.nextLinkOf(v, ol);
      this.linkV[ol].push(v);
    }
    for (const list of this.linkV) sortDesc(list);
    for (const list of this.mvV) sortDesc(list);
  }

  private advance(v: Veh, dt: number) {
    let nv = v.v + v.acc * dt; if (nv < 0) nv = 0;
    let ds = (v.v + nv) * 0.5 * dt;
    if (v.acc * dt < -v.v) ds = v.v * v.v / (2 * -v.acc); // stops within step
    if (ds > v.lim) { ds = Math.max(0, v.lim); nv = Math.min(nv, ds / dt); }
    if (ds > this.maxDisp) this.maxDisp = ds;
    v.s += ds; v.v = nv; v.dist += ds;
    const st = v.v < 0.5;
    if (st) { if (!v.stopped) { v.stopped = true; v.stops++; } v.stopT += dt; v.waitTotal += dt; }
    else if (v.v > 2) { v.stopped = false; v.stopT = 0; }
    this.co2g += VTYPES[v.type].co2 * ds / 1000 * (1 + Math.max(0, v.acc) * 0.25) + (st ? VTYPES[v.type].co2 * 0.0025 * dt : 0);
  }

  private finish(v: Veh) {
    this.activeCount--; this.completed++;
    const tt = this.t - v.tCreate; const delay = Math.max(0, tt - v.ff);
    this.sumTT += tt; this.sumDelay += delay; this.sumStops += v.stops;
    this.done.push({ tt, delay, stops: v.stops, t: this.t });
    if (this.done.length > 50000) this.done.splice(0, 10000);
  }

  private incidentUpdate() {
    if (this.incidentLink < 0) return;
    const on = this.t >= 300 && this.t < 1500;
    const L = this.net.links[this.incidentLink]; const list = this.linkV[this.incidentLink];
    if (on && !this.incidentObs) {
      const o = new Veh(); o.obstacle = true; o.id = -1; o.len = 18; o.w = L.width * 0.66; o.s = L.len * 0.55; o.lat = o.w / 2; o.latT = o.lat; o.link = L.id;
      // only place once the spot is clear
      if (!list.some(v => v.s > o.s - o.len - 2 && v.s - v.len < o.s + 2 && overlapLat(v, o.lat, o.w, 0))) { this.incidentObs = o; list.push(o); sortDesc(list); }
    } else if (!on && this.incidentObs) { removeFrom(list, this.incidentObs); this.incidentObs = null; }
  }

  private linkStats() {
    for (let li = 0; li < this.linkV.length; li++) {
      const list = this.linkV[li]; let sv = 0, n = 0, pcu = 0;
      for (const v of list) { if (v.obstacle) continue; sv += v.v; n++; pcu += v.pcu; }
      this.linkPcu[li] = pcu;
      const L = this.net.links[li];
      const obs = n ? sv / n : L.vmax;
      this.linkSpeed[li] = this.linkSpeed[li] * 0.8 + obs * 0.2;
    }
  }

  // ---------------------------------------------------------------- metrics / checks
  metrics(): Metrics {
    let sv = 0, n = 0, stopped = 0, longS = 0, pcuQ = 0, maxQ = 0;
    const forEach = (v: Veh) => { if (v.obstacle) return; n++; sv += v.v; if (v.v < 0.5) { stopped++; pcuQ += v.pcu; if (v.stopT > 120) longS++; } };
    for (const l of this.linkV) for (const v of l) forEach(v);
    for (const l of this.mvV) for (const v of l) forEach(v);
    for (const [nid] of this.sig) { const nd = this.net.nodes[nid]; for (const li of nd.inLinks) { let q = 0; for (const v of this.linkV[li]) if (v.v < 1 && !v.obstacle) q++; maxQ = Math.max(maxQ, q); } }
    let wait = 0; for (const s of this.sources) wait += s.queue.length;
    const recent = this.done.filter(d => d.t > this.t - 300);
    const win = Math.min(300, Math.max(this.t, 1));
    let rd = 0, rt = 0, rs = 0; for (const d of recent) { rd += d.delay; rt += d.tt; rs += d.stops; }
    return {
      t: this.t, active: n, waitingEntry: wait, spawned: this.spawned, completed: this.completed,
      throughputVph: recent.length * 3600 / win, avgSpeedKmh: n ? sv / n * 3.6 : 0, stopped,
      avgDelayS: this.completed ? this.sumDelay / this.completed : 0, avgTravelS: this.completed ? this.sumTT / this.completed : 0,
      avgStops: this.completed ? this.sumStops / this.completed : 0, pcuQueued: pcuQ, longStopped: longS,
      co2kgH: this.t > 0 ? this.co2g / 1000 / (this.t / 3600) : 0, pedWaitS: this.pedServed ? this.pedWaitSum / this.pedServed : 0, maxQueue: maxQ,
      ...(recent.length ? { recentDelayS: rd / recent.length, recentTravelS: rt / recent.length, recentStops: rs / recent.length } : {}),
    } as Metrics;
  }

  /** debug invariant checks used by tests */
  verifySafety() {
    for (const [nid, st] of this.sig) {
      const n = this.net.nodes[nid];
      const greens = n.moves.filter(m => { const c = this.sigColor(m); return c === 'G' || c === 'g'; });
      const prot = greens.filter(m => this.sigColor(m) === 'G');
      for (let i = 0; i < prot.length; i++) for (let j = i + 1; j < prot.length; j++) if (this.net.moves[prot[i]].conflicts.has(prot[j])) this.safetyViolations++;
      // greens must all belong to the current phase
      const ph = n.phases[st.phase];
      for (const m of greens) if (!ph.moves.includes(m)) this.safetyViolations++;
      if (st.stage === 'G' && st.tStage > SAFETY.MAX_GREEN + 1.5 && n.phases.some((_, p) => p !== st.phase && this.lastObs.get(nid)?.[p]?.demand)) this.safetyViolations++;
    }
  }

  vehicleCount() { return this.activeCount; }
  allVehicles(): Veh[] { const out: Veh[] = []; for (const l of this.linkV) for (const v of l) if (!v.obstacle) out.push(v); for (const l of this.mvV) for (const v of l) out.push(v); return out; }

  /** world pose of a vehicle */
  pose(v: Veh, out: { x: number; y: number; h: number }) {
    if (v.mv >= 0) { const m = this.net.moves[v.mv]; return cubicAt(v.gx0, v.gy0, v.gh0, v.gx3, v.gy3, v.gh3, Math.min(1, v.s / m.len), out); }
    const L = this.net.links[v.link];
    return this.net.pointAt(L, v.s - v.len / 2, this.net.offsetOf(L, v.lat), out);
  }
  signalState(nid: number) { return this.sig.get(nid); }
  getObs(nid: number) { return this.lastObs.get(nid); }
}

// ---------------------------------------------------------------- helpers
function overlapLat(o: Veh, lat: number, w: number, margin: number) { return Math.abs(o.lat - lat) < (o.w + w) / 2 + margin; }
function sweepOverlap(o: Veh, lo: number, hi: number, w: number) { return o.lat + o.w / 2 + 0.15 > lo - w / 2 && o.lat - o.w / 2 - 0.15 < hi + w / 2; }
function clampLat(L: Link, v: Veh, lat: number) { const m = v.w / 2 + 0.15; return Math.min(L.width - m, Math.max(m, lat)); }
const laneCache = new Map<number, number[]>();
function laneCenters(L: Link) { let c = laneCache.get(L.id * 1000 + L.lanes); if (!c) { c = []; const lw = L.width / L.lanes; for (let i = 0; i < L.lanes; i++) c.push(lw * (i + 0.5)); laneCache.set(L.id * 1000 + L.lanes, c); } return c; }
function nearestIdx(a: number[], x: number) { let b = 0; for (let i = 1; i < a.length; i++) if (Math.abs(a[i] - x) < Math.abs(a[b] - x)) b = i; return b; }
function removeFrom(list: Veh[], v: Veh) { const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); }
function sortDesc(list: Veh[]) { for (let i = 1; i < list.length; i++) { const x = list[i]; let j = i - 1; while (j >= 0 && (list[j].s < x.s || (list[j].s === x.s && list[j].id > x.id))) { list[j + 1] = list[j]; j--; } list[j + 1] = x; } }

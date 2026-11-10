import { Network, cubicAt, type Link, type Movement, type Node } from './network';
import { Router, type RouteTable } from './routing';
import { Rng } from './rng';
import { SCENARIOS, VTYPES, fullMix, LOCAL_MIX, LOCAL_SHARE, type Scenario } from './scenarios';
import { makeController, FixedTime, SAFETY, type Controller, type PhaseObs, type SignalState } from './controllers';
import { DEFAULT_CRASH, type CrashCfg, type DecisionLog, type MapData, type Metrics, type SimConfig, type SimEvent, type VType } from './types';

export class Veh {
  id = 0; type: VType = 0; len = 0; w = 0; a = 0; b = 0; T = 0; s0 = 0; v0f = 1; pcu = 1;
  link = -1; mv = -1; s = 0; v = 0; acc = 0; lat = 0; latT = 0; latFrac = 0.5;
  dest = -1; next = -1; tCreate = 0; tEnter = 0; ff = 0; stops = 0; stopped = false; stopT = 0; waitTotal = 0;
  committed = false; resMv = -1; lcT = 0; obstacle = false; lim = Infinity; dist = 0;
  frozen = -1; // id of the modelled fender-bender this vehicle is stuck in
  tw = false; cls = 1; vcap = 99; local = false; dwellUntil = -1; servedStop = -1; rude = 0; violated = false;
  gx0 = 0; gy0 = 0; gh0 = 0; gx3 = 0; gy3 = 0; gh3 = 0; // movement geometry
}

interface Source { link: number; rate: number; nextT: number; queue: Veh[]; west: boolean; local: boolean; zone: number }
export interface Zone { node: number; w: number; src: number; sink: number }
export interface Walker { u: number; sp: number; dir: number; t0: number; walking: boolean; c: number }
/** a zebra crossing over link `link` (and its opposite-direction twin) at s = sL (sT on the twin) */
export interface Zebra {
  id: number; link: number; twin: number; sL: number; sT: number; node: number; phases: number[]; len: number;
  ax: number; ay: number; bx: number; by: number; walkers: Walker[]; blocks: number[]; osm: boolean;
}
export interface Crash { id: number; link: number; a: Veh; b: Veh; t0: number; t1: number; x: number; y: number; h: number; side: number; crowd: number; name: string }
export interface BusStop { link: number; s: number; name: string; id: number }
const ZONE = 14;
const MAXLEN = 18; // longest body (incident obstacle); used to bound leader scans // metres at link entry used for spill-back (don't block the box) checks
const tmp = { x: 0, y: 0, h: 0 };

export class Simulation {
  net: Network; router: Router; rng: Rng; sc: Scenario; ctrl: Controller;
  t = 0; step_ = 0; nextId = 1;
  linkV: Veh[][]; mvV: Veh[][];
  tailOcc: Float64Array; linkSpeed: Float64Array; linkPcu: Float64Array;
  sinks!: number[]; sinkW!: number[]; tables = new Map<number, RouteTable>(); ffTables = new Map<number, RouteTable>();
  zebras: Zebra[] = []; zebraBlock: Int32Array; zebrasOnLink = new Map<number, Zebra[]>(); stopsOnLink = new Map<number, BusStop[]>(); busStops: BusStop[] = [];
  pedCrossed = 0; pedConflicts = 0; busDwellSum = 0; busDwells = 0;
  zones: Zone[] = []; zoneW: number[] = []; parkEnd: Uint8Array; localTrips = 0; violations = 0;
  private costs: Float64Array[] = []; private ffCosts: Float64Array[] = [];
  sources: Source[] = []; sig = new Map<number, SignalState>(); pedMin = new Map<number, number[]>();
  moveOf = new Map<number, number>(); gapCache: Float64Array; goCache: Int32Array; goStamp: Int32Array; resv: Int32Array;
  log: DecisionLog[] = []; series: Metrics[] = [];
  done: { tt: number; delay: number; stops: number; t: number }[] = [];
  spawned = 0; completed = 0; sumDelay = 0; sumTT = 0; sumStops = 0; co2g = 0; pedWaitSum = 0; pedServed = 0;
  incidentLink = -1; incidentObs: Veh | null = null; eventNode = -1; eventLinks: number[] = [];
  crashes: Crash[] = []; crashCfg: CrashCfg; events: SimEvent[] = []; private crashRng: Rng; private nextCrashT = Infinity; private crashLink = -1; private crashSeq = 0; private crashPlanT = 0;
  safetyViolations = 0; checkSafety = false; maxDisp = 0; chaos = 0.6;
  private lastObs = new Map<number, PhaseObs[]>();

  constructor(data: MapData, public cfg: SimConfig) {
    this.crashCfg = { ...DEFAULT_CRASH, ...(cfg.crashes ?? {}) };
    // separate stream: crash times/places do not depend on the controller or on traffic
    this.crashRng = new Rng((cfg.seed * 7919 + 17) >>> 0);
    this.net = new Network(data, cfg.edits ?? {}); this.router = new Router(this.net); this.rng = new Rng(cfg.seed);
    this.sc = SCENARIOS[cfg.scenario]; this.mix = fullMix(this.sc.mix); this.chaos = Math.max(0, Math.min(1, cfg.chaos ?? cfg.edits?.chaos ?? 0.6)); this.ctrl = makeController(cfg.controller);
    const nL = this.net.links.length, nM = this.net.moves.length;
    this.linkV = Array.from({ length: nL }, () => []); this.mvV = Array.from({ length: nM }, () => []);
    this.tailOcc = new Float64Array(nL); this.linkSpeed = new Float64Array(nL); this.linkPcu = new Float64Array(nL);
    this.parkEnd = new Uint8Array(nL);
    this.zebraBlock = new Int32Array(nM); this.gapCache = new Float64Array(nM);
    this.goCache = new Int32Array(nM); this.goStamp = new Int32Array(nM).fill(-1); this.resv = new Int32Array(nM);
    for (const m of this.net.moves) this.moveOf.set(m.inL * 65536 + m.outL, m.id);
    for (const L of this.net.links) this.linkSpeed[L.id] = L.vmax;
    this.setupEvent(); this.setupZones(); this.setupSinks(); this.setupSignals(); this.setupZebras(); this.setupBusStops(); this.setupSources(); this.setupIncident(); this.scheduleCrash();
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
  /** inferred local OD zones: households along pruned dead-end ngõ, aggregated per 300 m cell */
  private setupZones() {
    const CELL = 300; const cells = new Map<string, { best: Node; w: number }>();
    for (const n of this.net.nodes) {
      if (n.hh < 40 || n.boundary) continue;
      const k = Math.floor(n.x / CELL) + '_' + Math.floor(n.y / CELL);
      const c = cells.get(k); if (!c) { cells.set(k, { best: n, w: n.hh }); continue; }
      c.w += n.hh; if (n.hh > c.best.hh) c.best = n;
    }
    const pickL = (ids: number[], moves: (L: Link) => number[]) => {
      const ok = ids.filter(l => !this.net.links[l].closed && moves(this.net.links[l]).length);
      ok.sort((a, b) => (+this.net.links[b].alley - +this.net.links[a].alley) || a - b);
      return ok.length ? ok[0] : -1;
    };
    for (const c of cells.values()) {
      const n = c.best; const mult = this.cfg.edits?.zones?.[n.id] ?? 1; if (mult <= 0) continue;
      const src = pickL(n.outLinks, L => L.outMoves), sink = pickL(n.inLinks, L => L.inMoves);
      if (src < 0 || sink < 0) continue;
      this.zones.push({ node: n.id, w: c.w * mult, src, sink });
    }
    this.zoneW = this.zones.map(z => z.w);
    for (const z of this.zones) this.parkEnd[z.sink] = 1;
  }
  private setupSinks() {
    const bias = this.sc.inboundBias;
    this.sinks = this.net.sinks.filter(l => this.net.links[l].inMoves.length);
    this.sinkW = this.sinks.map(l => {
      const L = this.net.links[l];
      const east = this.net.nodes[L.to].x > 0;
      return Math.max(0.3, L.rank) * L.lanes * (east ? bias : 1 / bias);
    });
    for (const l of this.eventLinks) this.parkEnd[l] = 1;
    // per-class free-flow link costs: 0 two-wheelers, 1 cars (ngõ discouraged, too-narrow ngõ forbidden), 2 heavy (main roads only)
    for (let c = 0; c < 3; c++) this.ffCosts.push(this.classCost(c, L => L.len / L.vmax));
    this.refreshRoutes();
  }
  private classCost(c: number, base: (L: Link) => number) {
    const cost = new Float64Array(this.net.links.length);
    for (const L of this.net.links) {
      let k = base(L);
      if (L.alley) { if (c === 2 || (c === 1 && !L.carOk)) k = Infinity; else if (c === 1) k *= 3; }
      cost[L.id] = k;
    }
    return cost;
  }
  private turnCost(mi: number, ff: boolean) {
    const m = this.net.moves[mi]; const n = this.net.nodes[m.node];
    const fromAlley = this.net.links[m.inL].alley && !this.net.links[m.outL].alley ? 4 : 0; // ngõ exit friction
    if (ff) return m.len / this.net.links[m.outL].vmax + fromAlley;
    return (n.signal ? 12 : 2) + (m.turn === 'L' ? 6 : m.turn === 'U' ? 20 : 0) + fromAlley;
  }
  private tcFF?: Float64Array; private tcDyn?: Float64Array;
  ffTable(d: number, c: number) {
    const k = d * 3 + c; let t = this.ffTables.get(k);
    if (!t) { this.tcFF ??= Float64Array.from(this.net.moves, (_, i) => this.turnCost(i, true)); t = this.router.tableTo(d, this.ffCosts[c], this.tcFF); this.ffTables.set(k, t); }
    return t;
  }
  table(d: number, c: number) {
    const k = d * 3 + c; let t = this.tables.get(k);
    if (!t) { this.tcDyn ??= Float64Array.from(this.net.moves, (_, i) => this.turnCost(i, false)); t = this.router.tableTo(d, this.costs[c], this.tcDyn); this.tables.set(k, t); }
    return t;
  }
  refreshRoutes() {
    this.costs = [0, 1, 2].map(c => this.classCost(c, L => L.len / Math.max(1, Math.min(L.vmax, this.linkSpeed[L.id]))));
    const keys = [...this.tables.keys()].sort((a, b) => a - b);
    this.tcDyn ??= Float64Array.from(this.net.moves, (_, i) => this.turnCost(i, false));
    for (const k of keys) this.tables.set(k, this.router.tableTo(Math.floor(k / 3), this.costs[k % 3], this.tcDyn));
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
        const ne = this.cfg.edits?.nodes?.[n.id];
        if (ne?.splits?.length) this.ctrl.setExact(n, ne.splits, pm);
        else this.ctrl.setSplits(n, w, pm, ne?.cycle ?? 90);
        if (ne?.offset) this.sig.get(n.id)!.tStage = -Math.abs(ne.offset); // green-wave offset: delays the first switch
      }
    }
  }
  private setupZebras() {
    const tmp2 = { x: 0, y: 0, h: 0 };
    const add = (L: Link, sL: number, node: number, phases: number[], osm: boolean) => {
      const T = L.twin >= 0 && !this.net.links[L.twin].closed ? this.net.links[L.twin] : null;
      const lo = T ? -(T.width + 0.3) - 1.2 : -L.width / 2 - 1.2, hi = T ? L.width + 0.3 + 1.2 : L.width / 2 + 1.2;
      this.net.pointAt(L, sL, lo, tmp2); const ax = tmp2.x, ay = tmp2.y;
      this.net.pointAt(L, sL, hi, tmp2);
      const z: Zebra = { id: this.zebras.length, link: L.id, twin: T ? T.id : -1, sL, sT: T ? T.len - sL : -1, node, phases, len: hi - lo, ax, ay, bx: tmp2.x, by: tmp2.y, walkers: [], blocks: [], osm };
      if (node >= 0) z.blocks = [...L.outMoves, ...(T ? T.inMoves : [])];
      this.zebras.push(z);
      for (const l of [L.id, z.twin]) if (l >= 0) { const a = this.zebrasOnLink.get(l) ?? []; a.push(z); this.zebrasOnLink.set(l, a); }
      return z;
    };
    // at signalised junctions: one zebra per approach, just past the stop line; served by phases in which that approach is red
    const done = new Set<number>();
    for (const [nid] of this.sig) {
      const n = this.net.nodes[nid];
      for (const li of n.inLinks) {
        const L = this.net.links[li]; if (L.closed || !L.outMoves.length || L.alley) continue;
        const ph = n.phases.map((p, i) => (p.pedOnly || !p.inLinks.includes(li)) ? i : -1).filter(i => i >= 0);
        if (!ph.length) continue;
        add(L, Math.min(L.len - 0.3, L.stopS + 2.0), nid, ph, false); done.add(li); if (L.twin >= 0) done.add(L.twin);
      }
    }
    // mid-block / unsignalised zebras mapped in OSM (highway=crossing): pedestrians wait for a gap, vehicles then yield
    for (const c of this.net.data.crossings ?? []) {
      const L = this.net.links[c.link]; if (!L || L.closed || done.has(L.id)) continue;
      // only crossings with room for approaching traffic to stop (>= 40 m from the upstream junction, both directions)
      if (c.s < L.startS + 40 || c.s > L.stopS - 5) continue;
      if (L.twin >= 0) { const T = this.net.links[L.twin]; const sT = T.len - c.s; if (sT < T.startS + 40 || sT > T.stopS - 5) continue; }
      const near = (this.zebrasOnLink.get(L.id) ?? []).some(z => Math.abs((z.link === L.id ? z.sL : z.sT) - c.s) < 15);
      if (near) continue;
      add(L, c.s, -1, [], true);
    }
  }
  private setupBusStops() {
    for (const b of this.net.data.busStops ?? []) {
      const L = this.net.links[b.link]; if (!L || L.closed || b.s > L.stopS - 6) continue;
      const st: BusStop = { link: b.link, s: b.s, name: b.name, id: this.busStops.length };
      this.busStops.push(st); const a = this.stopsOnLink.get(b.link) ?? []; a.push(st); a.sort((x, y) => x.s - y.s); this.stopsOnLink.set(b.link, a);
    }
  }
  /** pedestrians: arrivals, waiting for a safe start, walking; zebras block the vehicle movements they cross */
  private updatePeds(dt: number) {
    const pr = this.sc.pedRate / 3600;
    for (const z of this.zebras) {
      const st = z.node >= 0 ? this.sig.get(z.node)! : null;
      if (this.rng.next() < (z.osm ? pr * 0.5 : pr) * dt) {
        const w: Walker = { u: 0, sp: this.rng.range(1.0, 1.5), dir: this.rng.next() < 0.5 ? 1 : -1, t0: this.t, walking: false, c: Math.floor(this.rng.next() * 6) };
        z.walkers.push(w);
        if (st) { const p = z.phases[0]; st.pedQ[p].push(this.t); (w as any).q = p; }
      }
      let anyWalking = false;
      for (let i = z.walkers.length - 1; i >= 0; i--) {
        const w = z.walkers[i];
        if (w.walking) {
          w.u += w.sp * dt / z.len;
          if (w.u >= 1) { z.walkers.splice(i, 1); this.pedCrossed++; continue; }
          anyWalking = true;
        }
      }
      const waiting = z.walkers.some(w => !w.walking);
      if (waiting) {
        let may: boolean;
        if (st) {
          // walk only during a serving green, with enough guaranteed green left to finish crossing
          const need = z.len / 1.0;
          may = st.stage === 'G' && z.phases.includes(st.phase) && st.tStage + need <= Math.max(st.minGreen, (this.ctrl instanceof FixedTime ? (this.ctrl.getSplits(z.node)?.[st.phase] ?? 0) : 0)) + 2 && this.zebraClear(z);
        } else may = this.zebraGap(z);
        if (may) for (const w of z.walkers) if (!w.walking) { w.walking = true; this.pedWaitSum += this.t - w.t0; this.pedServed++; anyWalking = true; }
      }
      const was = (z as any).active === true;
      if (anyWalking !== was) {
        (z as any).active = anyWalking;
        for (const mi of z.blocks) { this.zebraBlock[mi] += anyWalking ? 1 : -1; this.goStamp[mi] = -1; }
      }
    }
  }
  /** signalised zebra may start: nothing occupies or has reserved the movements it crosses, and the strip is empty */
  private zebraClear(z: Zebra) {
    for (const mi of z.blocks) if (this.mvV[mi].length || this.resv[mi]) return false;
    return this.stripEmpty(z.link, z.sL, 1.0) && (z.twin < 0 || this.stripEmpty(z.twin, z.sT, 1.0));
  }
  private stripEmpty(l: number, sz: number, h: number) {
    for (const v of this.linkV[l]) if (v.s > sz - h && v.s - v.len < sz + h) return false;
    return true;
  }
  /** unsignalised zebra: a gap in which every approaching vehicle can stop comfortably */
  private zebraGap(z: Zebra) {
    for (const [l, sz] of [[z.link, z.sL], [z.twin, z.sT]]) {
      if (l < 0) continue;
      for (const mi of this.net.links[l].inMoves) if (this.mvV[mi].length) return false;
      for (const v of this.linkV[l]) {
        if (v.s - v.len > sz + 1.5) continue; // already past
        if (v.s > sz - 2.5) return false; // on the strip
        if (sz - 2.5 - v.s < (v.v * v.v) / (2 * 3.0) + 2) return false; // cannot stop comfortably
      }
    }
    return true;
  }
  /** how far two-wheelers creep past the stop line at red (stops short of the signal crosswalk) */
  creepOf(L: Link) { return Math.max(0, Math.min(0.9 * this.chaos, L.len - L.stopS - 3.2)); }
  private zebraAhead(L: Link, s: number) { // nearest active unsignalised zebra ahead on this link
    const zs = this.zebrasOnLink.get(L.id); if (!zs) return Infinity;
    let best = Infinity;
    for (const z of zs) { if (z.node >= 0 || !(z as any).active) continue; const sz = z.link === L.id ? z.sL : z.sT; if (sz - 2.5 >= s - 0.01 && sz < best) best = sz; }
    return best;
  }
  private setupSources() {
    const bias = this.sc.inboundBias;
    const src = this.net.sources.filter(l => this.net.links[l].outMoves.length).map(l => { const L = this.net.links[l]; const west = this.net.nodes[L.from].x <= 0; return { l, w: Math.max(0.3, L.rank) * L.lanes * (west ? bias : 1 / bias), west }; });
    const tot = src.reduce((a, s) => a + s.w, 0);
    const vph = this.sc.demandVph * this.cfg.demandScale;
    const share = this.zones.length ? LOCAL_SHARE : 0;
    for (const s of src) {
      const rate = vph * (1 - share) * s.w / tot / 3600;
      this.sources.push({ link: s.l, rate, nextT: this.rng.exp(rate), queue: [], west: s.west, local: false, zone: -1 });
    }
    const zt = this.zoneW.reduce((a, b) => a + b, 0);
    this.zones.forEach((z, i) => {
      const rate = vph * share * z.w / zt / 3600;
      this.sources.push({ link: z.src, rate, nextT: this.rng.exp(rate), queue: [], west: this.net.nodes[z.node].x <= 0, local: true, zone: i });
    });
  }
  private scheduleCrash() {
    const c = this.crashCfg; if (!c.on || c.perHour <= 0) { this.nextCrashT = Infinity; return; }
    this.crashPlanT += this.crashRng.exp(c.perHour / 3600); this.nextCrashT = this.crashPlanT; // planned times: independent of when the previous crash happened
    const cand = this.net.links.filter(L => !L.alley && !L.closed && L.stopS - L.startS > 40);
    this.crashLink = cand.length ? this.crashRng.pick(cand.map(L => L.id), cand.map(L => L.len * L.rank)) : -1;
    (this as any).crashDur = this.crashRng.range(c.minMin, c.maxMin) * 60;
    (this as any).crashCrowd = c.crowd ? 2 + Math.floor(this.crashRng.next() * 5) : 0;
  }
  /** at the scheduled time, the first suitable pair of close vehicles on (or nearest to) the drawn link collide lightly */
  private crashUpdate() {
    for (let i = this.crashes.length - 1; i >= 0; i--) {
      const k = this.crashes[i];
      if (this.t >= k.t1) {
        k.a.frozen = -1; k.b.frozen = -1; this.crashes.splice(i, 1);
        this.events.push({ t: this.t, kind: 'crashEnd', text: `Hai xe va quẹt tại ${k.name} đã thỏa thuận xong, tiếp tục hành trình (đứng ${Math.round((k.t1 - k.t0) / 60)} phút)`, x: k.x, y: k.y });
      }
    }
    if (this.t < this.nextCrashT || this.crashLink < 0) return;
    if (this.t > this.nextCrashT + 300) { this.events.push({ t: this.t, kind: 'info', text: 'Lượt va quẹt dự kiến bị bỏ qua: không có hai xe đủ gần trên đoạn đường đã chọn' }); this.scheduleCrash(); return; }
    // search the drawn link first, then links sharing its name
    const L0 = this.net.links[this.crashLink];
    const mid = L0.pts[Math.floor(L0.pts.length / 2)];
    const near = this.net.links.filter(L => L.id !== L0.id && !L.alley && !L.closed && Math.hypot(L.pts[0][0] - mid[0], L.pts[0][1] - mid[1]) < 400);
    near.sort((a, b) => Math.hypot(a.pts[0][0] - mid[0], a.pts[0][1] - mid[1]) - Math.hypot(b.pts[0][0] - mid[0], b.pts[0][1] - mid[1]) || a.id - b.id);
    const links = [L0, ...near];
    for (const L of links) {
      const list = this.linkV[L.id];
      for (let i = 1; i < list.length; i++) {
        const b = list[i]; if (b.obstacle || b.frozen >= 0 || b.v > 10 || b.type === 2) continue;
        for (let j = i - 1; j >= 0 && j >= i - 6; j--) {
          const a = list[j]; if (a.obstacle || a.frozen >= 0 || a.type === 2) continue;
          const gap = a.s - a.len - b.s;
          if (gap < 0 || gap > 3.5 || !overlapLat(a, b.lat, b.w, 0.4)) continue;
          if (a.s > L.stopS - 12 || b.s - b.len < L.startS + 3) continue;
          // ok: a light touch between a (hit from behind / side-swiped) and b
          const dur = (this as any).crashDur as number;
          if (a.committed) this.release(a); if (b.committed) this.release(b);
          const id = ++this.crashSeq; a.frozen = id; b.frozen = id; a.v = b.v = 0; a.acc = b.acc = 0;
          const p = { x: 0, y: 0, h: 0 }; this.net.pointAt(L, a.s - a.len, this.net.offsetOf(L, a.lat), p);
          const crowd = (this as any).crashCrowd as number;
          const side = a.lat > L.width / 2 ? 1 : -1;
          const k: Crash = { id, link: L.id, a, b, t0: this.t, t1: this.t + dur, x: p.x, y: p.y, h: p.h, side, crowd, name: L.name };
          this.crashes.push(k);
          const nm = (v: Veh) => VTYPES[v.type].name.toLowerCase();
          this.events.push({ t: this.t, kind: 'crash', text: `Va quẹt tại ${L.name}: ${nm(b)} chạm ${nm(a)}, 2 xe đứng lại cãi nhau${crowd ? `, ${crowd} người xúm vào xem` : ''} (dự kiến ~${Math.round(dur / 60)} phút)`, x: p.x, y: p.y });
          if (this.events.length > 500) this.events.splice(0, 100);
          this.scheduleCrash();
          return;
        }
      }
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
  private makeVeh(type: VType, src: number, zone: number): Veh {
    const L0 = this.net.links[src];
    if (VTYPES[type].heavy && !L0.heavyOk) type = 1;
    if (!VTYPES[type].tw && !L0.carOk) type = 0;
    const p = VTYPES[type]; const v = new Veh(); const sc = this.sc; const r = this.rng;
    v.id = this.nextId++; v.type = type; v.len = p.len; v.w = p.w; v.a = p.a * sc.accelFactor * r.range(0.85, 1.15);
    v.b = p.b; v.T = p.T * sc.headwayFactor * r.range(0.85, 1.2); v.s0 = p.s0; v.v0f = p.vf * sc.speedFactor * r.range(0.88, 1.1); v.pcu = p.pcu;
    if (p.tw) { v.T *= 1 - 0.35 * this.chaos; v.s0 *= 1 - 0.4 * this.chaos; }
    v.tw = p.tw; v.cls = p.tw ? 0 : p.heavy ? 2 : 1; v.vcap = p.vcap * (type === 4 ? r.range(0.8, 1.15) : 1); v.local = zone >= 0;
    // propensity to break rules (two-wheelers, taxis); scaled by the editor setting
    const vm = this.cfg.edits?.violations ?? 1;
    v.rude = (p.tw && type === 0 ? (r.next() < 0.12 ? 1 : 0) : type === 5 ? (r.next() < 0.05 ? 1 : 0) : 0) * vm;
    v.tCreate = this.t;
    // destination: boundary exits, local zones, or the event venue
    let dest = -1; const c = v.cls;
    const zoneP = c === 2 ? 0 : zone >= 0 ? 0.3 : 0.25;
    for (let tries = 0; tries < 12 && dest < 0; tries++) {
      let d: number;
      if (this.eventLinks.length && c !== 2 && r.next() < 3000 / (this.sc.demandVph * this.cfg.demandScale)) d = this.eventLinks[Math.floor(r.next() * this.eventLinks.length)];
      else if (this.zones.length && r.next() < zoneP) { const zi = r.pick(this.zones.map((_, i) => i), this.zoneW); if (zi === zone) continue; d = this.zones[zi].sink; }
      else d = r.pick(this.sinks, this.sinkW);
      const ft = this.ffTable(d, c);
      if (!isFinite(ft.cost[src]) || this.net.links[d].to === this.net.links[src].from) continue;
      if (ft.cost[src] < 40) continue; // too short a trip
      dest = d; v.ff = ft.cost[src];
    }
    if (dest < 0) { dest = this.sinks.find(d => d !== src && isFinite(this.ffTable(d, c).cost[src])) ?? src; v.ff = this.ffTable(dest, c).cost[src]; if (!isFinite(v.ff)) v.ff = 0; }
    v.dest = dest;
    if (zone >= 0 || this.zones.some(z => z.sink === dest)) this.localTrips++;
    return v;
  }
  private spawnRate(): number { return 1; }

  private trySpawn(s: Source) {
    // generate arrivals (Poisson) into the entry queue; vehicles are never dropped
    while (s.nextT <= this.t) {
      const mix = s.local ? LOCAL_MIX : this.mix;
      const type = this.rng.pick(MIXIDX, mix) as VType;
      s.queue.push(this.makeVeh(type, s.link, s.zone)); this.spawned++;
      s.nextT += this.rng.exp(s.rate * this.spawnRate());
    }
    const cap = this.cfg.maxVehicles ?? Infinity;
    const L = this.net.links[s.link]; const list = this.linkV[s.link];
    let guard = 0;
    while (s.queue.length && guard++ < 4 && this.activeCount < cap) {
      const v = s.queue[0];
      const cand = v.tw ? [0.2, 0.5, 0.8, 0.35, 0.65, 0.1, 0.9] : laneCenters(L);
      let placed = false;
      for (const c of cand) {
        const lat = v.tw ? clampLat(L, v, c * L.width) : c;
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
  private mix: number[] = [];

  private nextLinkOf(v: Veh, link: number) {
    if (link === v.dest) return -1;
    const t = this.table(v.dest, v.cls);
    let n = t.next[link];
    if (n < 0) { const ft = this.ffTable(v.dest, v.cls); n = ft.next[link]; }
    if (n < 0) { const L = this.net.links[link]; n = L.outMoves.length ? this.net.moves[L.outMoves[0]].outL : -1; }
    return n;
  }
  /** lateral position a vehicle will take on the exit link of movement m (cars snap to lane centres) */
  mapLat(v: Veh, m: Movement) {
    const inL = this.net.links[m.inL], out = this.net.links[m.outL];
    const lat = clampLat(out, v, Math.min(0.95, Math.max(0.05, v.lat / inL.width)) * out.width);
    if (v.tw) return lat;
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
      if (st.stage === 'Y' && st.tStage >= SAFETY.YELLOW) { st.stage = 'R'; st.tStage = 0; }
      else if (st.stage === 'R' && st.tStage >= SAFETY.ALL_RED) {
        st.lastEnd[st.phase] = this.t; st.phase = st.next; st.stage = 'G'; st.tStage = 0; st.switches++;
        const q = st.pedQ[st.phase];
        const pm = this.pedMin.get(nid)![st.phase];
        st.minGreen = Math.max(SAFETY.MIN_GREEN, q.length ? pm : 0, n.phases[st.phase].pedOnly ? pm : 0);
        q.length = 0; // waiting pedestrians step off once their zebra is clear (updatePeds)
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
          if (d > 150 || d < -2) continue;
          const w = v.type === 2 ? 3 : v.pcu; // bus priority weight
          if (v.v < 1.5) {
            o.queuePcu += w; o.queueN++; o.maxWait = Math.max(o.maxWait, v.stopT);
            if (v.tw) o.motos++; else if (v.type === 2) o.buses++; else o.cars++;
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
    if (this.zebraBlock[mi]) return false; // pedestrians on the crosswalk
    if (this.goStamp[mi] !== this.step_) {
      this.goStamp[mi] = this.step_;
      const box = this.boxClear(m);
      this.gapCache[mi] = box ? this.yieldGap(m, col, false) : -1;
      this.goCache[mi] = box ? 1 : 0;
    }
    // gap acceptance: permissive left turns (motorbikes accept ~2.5 s, cars 4.5 s), ngõ exits 4 s, else 3 s
    const agg = v.tw ? 1 - 0.35 * this.chaos : v.type === 5 ? 1 - 0.15 * this.chaos : 1; // honk-and-go gap acceptance
    const need = (m.turn === 'L' && col === 'g' ? (v.tw ? 2.5 : 4.5) : this.net.links[m.inL].alley ? 4.0 : 3.0) * agg;
    if (!(this.goCache[mi] && this.gapCache[mi] >= need)) {
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
  /** smallest time gap (s) of a prioritised conflicting vehicle approaching this movement; all=true treats every conflict as prioritised */
  private yieldGap(m: Movement, col: string, all: boolean) {
    const L = this.net.links[m.inL]; let gap = Infinity;
    for (const c of m.conflicts) {
      const cm = this.net.moves[c];
      let prior: boolean;
      if (all) prior = true;
      else if (col === 'g') prior = this.sigColor(c) === 'G';
      else if (col === 'N') prior = this.net.links[cm.inL].rank > L.rank;
      else prior = false;
      if (!prior) continue;
      const CL = this.net.links[cm.inL]; const list = this.linkV[cm.inL];
      for (let i = 0, k = 0; i < list.length && k < 8; i++) {
        const o = list[i]; if (o.obstacle) continue; k++;
        const d = CL.stopS - o.s; if (d > 60) break;
        if (o.next !== cm.outL) continue;
        if (all && this.sigColor(c) !== 'G' && this.sigColor(c) !== 'g' && o.v < 1) continue; // stopped at their red
        gap = Math.min(gap, d / Math.max(o.v, 0.8));
      }
    }
    return gap;
  }
  /** a rule breaker may cross on red only when no conflict exists at all: empty box, no reservation, no pedestrian, no approaching prioritised vehicle */
  private violateOk(mi: number, v: Veh) {
    const m = this.net.moves[mi];
    if (this.zebraBlock[mi] || !this.boxClear(m)) return false;
    if (this.yieldGap(m, 'R', true) < 6) return false;
    return this.spaceOk(m, v);
  }

  // ---------------------------------------------------------------- main step
  step() {
    const dt = this.cfg.dt; this.step_++;
    for (const s of this.sources) this.trySpawn(s);
    this.incidentUpdate();
    this.crashUpdate();
    this.updateSignals(dt);
    this.updatePeds(dt);
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
    const v0 = Math.max(1, Math.min(vmax * v.v0f, v.vcap));
    const ss = v.s0 + Math.max(0, v.v * v.T + (v.v * (v.v - vl)) / (2 * Math.sqrt(v.a * v.b)));
    const g = Math.max(gap, 0.05);
    let a = v.a * (1 - Math.pow(v.v / v0, 4) - (ss / g) * (ss / g));
    if (a < -9) a = -9;
    return a;
  }

  /** vehicle ahead whose lateral span overlaps (lat, w) and whose rear is closest (lists are sorted by front position) */
  private leaderIn(list: Veh[], i: number, s: number, lat: number, w: number, maxD: number, margin = 0.2): Veh | null {
    let best: Veh | null = null, bb = Infinity;
    for (let j = i - 1; j >= 0; j--) {
      const o = list[j];
      if (o.s - MAXLEN > bb || o.s - MAXLEN - s > maxD) break;
      const back = o.s - o.len;
      if (back < bb && back - s <= maxD && overlapLat(o, lat, w, margin)) { best = o; bb = back; }
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
    const v = list[i]; if (v.obstacle || v.frozen >= 0) { v.acc = 0; v.lim = 0; v.v = 0; return; }
    const vmax = L.vmax * (this.incidentObs && L.id === this.incidentLink ? 0.6 : 1);
    const ld = this.leaderIn(list, i, v.s, v.lat, v.w, 80, v.tw ? 0.2 - 0.12 * this.chaos : 0.2);
    let gap = Infinity, vl = 0;
    if (ld) { gap = ld.s - ld.len - v.s; vl = ld.v; }
    if (v.next < 0) { // destination link: drive off the end (or park at the end: event venue, ngõ zone)
      const park = this.parkEnd[L.id] === 1;
      const end = (park ? L.stopS : L.len + 30) - v.s;
      if (park && end < gap) { gap = end + 1.5; vl = 0; }
    } else if (!ld || ld.s - ld.len > L.stopS) {
      const d = L.stopS - v.s;
      if (d < 70) {
        const mi = this.moveFor(v);
        let go = false; let col: string = 'N';
        if (mi >= 0) {
          col = this.sigColor(mi);
          const canStop = d > (v.v * v.v) / (2 * 4.0) + 0.5;
          const commitDist = (v.v * v.v) / (2 * 2.5) + 3;
          if (v.committed) {
            // keep a reservation unless the light turned amber/red and we can still stop comfortably
            if (col === 'G' || col === 'g' || col === 'N' || !canStop) go = true;
            else this.release(v);
          } else if (col !== 'Y' && col !== 'R') {
            go = this.canGo(mi, v);
            if (go && d < commitDist) this.reserve(v, mi);
          } else if (col === 'R' && v.rude > 0 && d < 2.5 && v.v < 1 && v.stopT > 4 && this.rng.next() < 0.01 * v.rude * (0.3 + this.chaos) && this.violateOk(mi, v)) {
            go = true; this.reserve(v, mi); v.violated = true; this.violations++; // red-light running, only into an empty, conflict-free junction
          }
        }
        // at a red light cars and buses keep behind the line while motorbikes creep up to it (and fill the space in front)
        const red = col === 'R' || col === 'Y';
        const back = !go && !v.tw && red ? 1.8 * (1 - 0.5 * this.chaos) : 0;
        const creep = !go && v.tw && red ? this.creepOf(L) : 0;
        if (!go) { if (d - back + creep < gap) { gap = Math.max(0, d - back + creep) + 0.3; vl = 0; } }
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
    // unsignalised zebra with pedestrians on it
    const zs = this.zebraAhead(L, v.s);
    if (zs < Infinity) { const g2 = zs - 2.5 - v.s; if (g2 < gap) { gap = Math.max(0, g2) + 0.05; vl = 0; } }
    // buses serve stops: pull in, dwell, block the kerb side
    if (v.type === 2) {
      const stops = this.stopsOnLink.get(L.id);
      if (stops) for (const bs of stops) {
        if (bs.s < v.s - 0.5 || v.servedStop === bs.id + L.id * 1000) continue;
        const d = bs.s - v.s;
        if (v.dwellUntil < 0 && d < 1.0 + v.s0 && v.v < 0.4) { v.dwellUntil = this.t + this.rng.range(10, 30); }
        if (v.dwellUntil >= 0) {
          if (this.t >= v.dwellUntil) { this.busDwellSum += 0; this.busDwells++; v.servedStop = bs.id + L.id * 1000; v.dwellUntil = -1; }
          else { gap = 0.05; vl = 0; this.busDwellSum += this.cfg.dt; }
        } else if (d + v.s0 + 0.3 < gap) { gap = d + v.s0 + 0.3; vl = 0; }
        break;
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
    const vmax = Math.min(out.vmax, m.turn === 'T' ? out.vmax : 6.5, this.net.links[m.inL].alley ? 4 : 99);
    v.acc = this.idm(v, vmax, gap, vl);
    v.lim = gap - 0.1;
  }

  /** sublane lateral behaviour: motorbikes filter through gaps, cars change lanes; both pre-position for turns */
  private lateral(list: Veh[], i: number, L: Link, dt: number) {
    const v = list[i]; if (v.obstacle || v.frozen >= 0) return;
    const turnLat = this.turnBand(v, L);
    if (v.tw) {
      if ((this.step_ + v.id) % 2 === 0) {
        let best = v.latT, bs = -Infinity;
        const k = 0.7 + 0.7 * this.chaos, mg = 0.2 - 0.12 * this.chaos;
        // in jams two-wheelers spill onto the road edge / sidewalk edge (kerb side only)
        const spill = v.v < 3 ? 0.9 * this.chaos : 0;
        for (const dl of LAT_CANDS) {
          const c = Math.min(L.width - v.w / 2 - 0.15 + spill, Math.max(v.w / 2 + 0.15, v.lat + dl * k));
          const ld = this.leaderIn(list, i, v.s, c, v.w, 40, mg);
          let g = ld ? Math.min(40, ld.s - ld.len - v.s) + (ld.v - v.v) * 0.5 : 40;
          g -= Math.abs(c - v.lat) * 1.5;
          if (turnLat >= 0) g -= Math.abs(c - turnLat) * 1.2;
          else g -= v.type === 4 ? Math.abs(c - L.width * 0.88) * 0.6 : Math.abs(c - L.width * 0.7) * 0.15; // keep right when cruising (bicycles hug the kerb)
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
        // chaotic mixed traffic: slow cars nudge sideways into any half-gap between motorbikes
        if (target === cur && this.chaos > 0 && v.v < 4) {
          const m0 = v.w / 2 + 0.15;
          for (const dl of [-0.6, 0.6]) {
            const c = Math.min(L.width - m0, Math.max(m0, v.lat + dl * this.chaos));
            if (Math.abs(c - v.lat) > 0.05 && this.frontGap(list, i, v, c) > gCur + 3 && this.lateralSafe(list, i, v, c)) { v.latT = c; break; }
          }
          return this.moveLat(list, i, v, dt);
        }
      }
      if (target !== cur) {
        const step = target > cur ? cur + 1 : cur - 1;
        if (this.lateralSafe(list, i, v, lanes[step])) v.latT = lanes[step];
      }
    }
    this.moveLat(list, i, v, dt);
  }
  /** move toward the lateral target at limited lateral speed, re-checking side clearance */
  private moveLat(list: Veh[], i: number, v: Veh, dt: number) {
    const dl = v.latT - v.lat;
    if (Math.abs(dl) > 0.01) {
      const vlat = v.type === 0 ? 1.2 + 1.0 * this.chaos : v.type === 4 ? 0.6 : 0.5 + 0.4 * this.chaos;
      const nl = v.lat + Math.sign(dl) * Math.min(Math.abs(dl), vlat * dt);
      if (this.lateralSafe(list, i, v, nl)) v.lat = nl; else v.latT = v.lat;
    }
  }
  private frontGap(list: Veh[], i: number, v: Veh, lat: number) { const ld = this.leaderIn(list, i, v.s, lat, v.w, 60); return ld ? ld.s - ld.len - v.s : 60; }
  private turnBand(v: Veh, L: Link) {
    if (v.type === 2) { const st = this.stopsOnLink.get(L.id); if (st && st.some(b => b.s > v.s && b.s - v.s < 80 && v.servedStop !== b.id + L.id * 1000)) return L.width - v.w / 2 - 0.3; }
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
          const endS = this.parkEnd[li] ? L.stopS : L.len;
          if (v.s >= endS - 0.6) exits.push(v);
        } else if (v.s >= L.stopS && v.committed) {
          const mi = this.moveFor(v); if (mi >= 0) transfersMv.push([v, mi]);
        } else if (v.s > L.stopS + (v.tw ? this.creepOf(L) : 0)) { v.s = L.stopS + (v.tw ? this.creepOf(L) : 0); v.v = 0; }
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
      if (this.mvV[mi].some(o => Math.abs(o.lat - olat) < (o.w + v.w) / 2 + 0.05 && o.s - o.len < over + 0.1)) { v.v = 0; continue; } // wait at the line (never moved backwards)
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
      violations: this.violations, localTrips: this.localTrips, pedCrossed: this.pedCrossed, busDwellS: this.busDwells ? this.busDwellSum / this.busDwells : 0,
      ...(recent.length ? { recentDelayS: rd / recent.length, recentTravelS: rt / recent.length, recentStops: rs / recent.length } : {}),
    } as Metrics;
  }

  /** debug invariant checks used by tests */
  verifySafety() {
    for (const z of this.zebras) {
      if (!z.walkers.some(w => w.walking)) continue;
      if (!this.stripEmpty(z.link, z.sL, 0.6) || (z.twin >= 0 && !this.stripEmpty(z.twin, z.sT, 0.6))) this.pedConflicts++;
      for (const mi of z.blocks) if (this.mvV[mi].length) {
        // a vehicle inside a blocked movement is only a conflict if it actually overlaps the crosswalk position
        const m = this.net.moves[mi];
        for (const o of this.mvV[mi]) { const atStart = z.link === m.inL ? o.s - o.len < 1.8 : o.s > m.len - 1.8; if (atStart) { this.pedConflicts++; break; } }
      }
    }
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
const MIXIDX = [0, 1, 2, 3, 4, 5, 6, 7];
const LAT_CANDS = [-1.6, -0.9, -0.4, 0, 0.4, 0.9, 1.6];
function overlapLat(o: Veh, lat: number, w: number, margin: number) { return Math.abs(o.lat - lat) < (o.w + w) / 2 + margin; }
function sweepOverlap(o: Veh, lo: number, hi: number, w: number) { return o.lat + o.w / 2 + 0.15 > lo - w / 2 && o.lat - o.w / 2 - 0.15 < hi + w / 2; }
function clampLat(L: Link, v: Veh, lat: number) { const m = v.w / 2 + 0.15; return Math.min(L.width - m, Math.max(m, lat)); }
const laneCache = new Map<number, number[]>();
function laneCenters(L: Link) { let c = laneCache.get(L.id * 1000 + L.lanes); if (!c) { c = []; const lw = L.width / L.lanes; for (let i = 0; i < L.lanes; i++) c.push(lw * (i + 0.5)); laneCache.set(L.id * 1000 + L.lanes, c); } return c; }
function nearestIdx(a: number[], x: number) { let b = 0; for (let i = 1; i < a.length; i++) if (Math.abs(a[i] - x) < Math.abs(a[b] - x)) b = i; return b; }
function removeFrom(list: Veh[], v: Veh) { const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); }
function sortDesc(list: Veh[]) { for (let i = 1; i < list.length; i++) { const x = list[i]; let j = i - 1; while (j >= 0 && (list[j].s < x.s || (list[j].s === x.s && list[j].id > x.id))) { list[j + 1] = list[j]; j--; } list[j + 1] = x; } }

import type { Edits, MapData } from './types';

export const LANE_W = 3.2;
const RANK: Record<string, number> = { trunk: 5, primary: 4, secondary: 3, tertiary: 2, unclassified: 1, residential: 1, alley: 0 };

export interface Link {
  id: number; from: number; to: number; pts: [number, number][]; cum: number[]; len: number;
  lanes: number; width: number; vmax: number; name: string; cls: string; rank: number; twoWay: boolean;
  stopS: number; startS: number; headIn: number; headOut: number;
  outMoves: number[]; inMoves: number[];
  closed: boolean; alley: boolean; carOk: boolean; heavyOk: boolean; twin: number; inf: string[];
}
export type Turn = 'L' | 'T' | 'R' | 'U';
export interface Movement {
  id: number; node: number; inL: number; outL: number; turn: Turn; len: number;
  conflicts: Set<number>; samples: [number, number][]; latFrac: number;
}
export interface Phase { moves: number[]; protected: Set<number>; permissive: Set<number>; inLinks: number[]; label: string; pedOnly: boolean }
export interface Node {
  id: number; x: number; y: number; signal: boolean; boundary: boolean; radius: number;
  inLinks: number[]; outLinks: number[]; moves: number[]; phases: Phase[]; name: string; deg: number; hh: number; osmSignal: boolean;
}

export function angDiff(a: number, b: number) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }

export class Network {
  links: Link[] = []; nodes: Node[] = []; moves: Movement[] = [];
  sources: number[] = []; sinks: number[] = []; // link ids
  bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  constructor(public data: MapData, public edits: Edits = {}) {
    const und = new Map<number, Set<number>>();
    for (const n of data.nodes) {
      const ne = edits.nodes?.[n.id];
      this.nodes.push({ id: n.id, x: n.x, y: n.y, signal: ne?.signal ?? n.signal, osmSignal: n.signal, boundary: n.boundary, radius: 0, inLinks: [], outLinks: [], moves: [], phases: [], name: '', deg: 0, hh: n.hh ?? 0 });
      und.set(n.id, new Set());
    }
    const pairs = new Set<string>();
    for (const l of data.links) pairs.add(l.from + '_' + l.to + '_' + (l as any).way);
    for (const ml of data.links) {
      const pts = ml.pts.map(p => [p[0], p[1]] as [number, number]);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const len = cum[cum.length - 1];
      const n = pts.length;
      const twoWay = pairs.has(ml.to + '_' + ml.from + '_' + (ml as any).way);
      const le = edits.links?.[ml.id];
      const alley = ml.cls === 'alley';
      const lanes = Math.max(1, Math.min(6, le?.lanes ?? ml.lanes));
      // ngõ: one narrow lane per direction (2.3 m each way, 3 m if one-way); main roads 3.2 m per lane
      const width = alley ? (twoWay ? 2.3 : 3.0) * lanes : Math.max(lanes * LANE_W, 3.6);
      const L: Link = {
        id: ml.id, from: ml.from, to: ml.to, pts, cum, len, lanes,
        width, vmax: (le?.speed ?? ml.speed) / 3.6, name: ml.name || (alley ? 'Ngõ không tên' : 'Đường không tên'), cls: ml.cls,
        rank: RANK[ml.cls] ?? 1, twoWay, stopS: len, startS: 0,
        closed: !!le?.closed, alley, carOk: width >= 2.2, heavyOk: !alley, twin: -1, inf: ml.inf ?? [],
        headOut: Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]),
        headIn: Math.atan2(pts[n - 1][1] - pts[n - 2][1], pts[n - 1][0] - pts[n - 2][0]),
        outMoves: [], inMoves: [],
      };
      this.links.push(L);
      this.nodes[ml.from].outLinks.push(L.id);
      this.nodes[ml.to].inLinks.push(L.id);
      und.get(ml.from)!.add(ml.to); und.get(ml.to)!.add(ml.from);
    }
    const byPair = new Map<string, number>();
    for (const L of this.links) byPair.set(L.from + '_' + L.to, L.id);
    for (const L of this.links) L.twin = byPair.get(L.to + '_' + L.from) ?? -1;
    for (const nd of this.nodes) {
      nd.deg = und.get(nd.id)!.size;
      let maxW = 0;
      for (const l of [...nd.inLinks, ...nd.outLinks]) maxW = Math.max(maxW, this.links[l].width);
      // junction box: signalised nodes keep room for the stop line, motorbike creep zone and crosswalk outside the crossing paths
      nd.radius = nd.deg <= 2 ? 1.0 : nd.signal ? Math.min(20, maxW + 3.5) : Math.min(14, Math.max(3.5, 1.2 + maxW * 0.8));
      const names = new Map<string, number>();
      for (const l of [...nd.inLinks]) { const L = this.links[l]; names.set(L.name, Math.max(names.get(L.name) ?? 0, L.rank)); }
      nd.name = [...names.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0].replace(/^(Phố|Đường) /, '')).slice(0, 2).join(' × ');
    }
    for (const L of this.links) {
      let a = this.nodes[L.from].radius, b = this.nodes[L.to].radius;
      const room = L.len - 4;
      if (a + b > room) { const k = Math.max(0, room) / (a + b); a *= k; b *= k; }
      L.startS = a; L.stopS = L.len - b;
    }
    this.buildMoves();
    this.buildPhases();
    for (const nd of this.nodes) {
      if (!nd.boundary) continue;
      for (const l of nd.outLinks) if (!this.links[l].closed) this.sources.push(l);
      for (const l of nd.inLinks) if (!this.links[l].closed) this.sinks.push(l);
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
    this.bounds = { minX, minY, maxX, maxY };
  }

  /** World point at distance s along link, offset to the right by `off` metres. */
  pointAt(L: Link, s: number, off: number, out: { x: number; y: number; h: number }) {
    const cum = L.cum; const n = cum.length;
    if (s <= 0) s = 0; if (s >= L.len) s = L.len;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const p = L.pts[lo], q = L.pts[hi];
    const seg = cum[hi] - cum[lo] || 1;
    const u = (s - cum[lo]) / seg;
    const dx = (q[0] - p[0]) / seg, dy = (q[1] - p[1]) / seg;
    out.x = p[0] + (q[0] - p[0]) * u - dy * off;
    out.y = p[1] + (q[1] - p[1]) * u + dx * off;
    out.h = Math.atan2(dy, dx);
    return out;
  }
  /** lateral position (0 = centre-line side, width = kerb) -> right offset from the polyline */
  offsetOf(L: Link, lat: number) { return L.twoWay ? lat + 0.3 : lat - L.width / 2; }

  private buildMoves() {
    const tmp = { x: 0, y: 0, h: 0 };
    const bans = new Set(this.edits.bans ?? []);
    for (const nd of this.nodes) {
      for (const li of nd.inLinks) {
        const inL = this.links[li];
        if (inL.closed) continue;
        const cands: { o: number; turn: Turn; a: number }[] = [];
        for (const lo of nd.outLinks) {
          const outL = this.links[lo];
          if (outL.closed || bans.has(li + '_' + lo)) continue;
          const a = angDiff(inL.headIn, outL.headOut);
          let turn: Turn = Math.abs(a) < 0.6 ? 'T' : a > 0 ? 'R' : 'L';
          if (Math.abs(a) > 2.6 || outL.to === inL.from) turn = 'U';
          cands.push({ o: lo, turn, a });
        }
        const nonU = cands.filter(c => c.turn !== 'U');
        const use = nonU.length ? nonU : cands; // U-turn only where nothing else is possible
        for (const c of use) {
          const outL = this.links[c.o];
          const latFrac = c.turn === 'L' || c.turn === 'U' ? 0.2 : c.turn === 'R' ? 0.8 : 0.5;
          const P0 = this.pointAt(inL, inL.stopS, this.offsetOf(inL, inL.width * latFrac), tmp); const p0 = [P0.x, P0.y];
          const P3 = this.pointAt(outL, outL.startS, this.offsetOf(outL, outL.width * latFrac), tmp); const p3 = [P3.x, P3.y];
          const samples = cubic(p0[0], p0[1], inL.headIn, p3[0], p3[1], outL.headOut, 10);
          let len = 0; for (let i = 1; i < samples.length; i++) len += Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]);
          const m: Movement = { id: this.moves.length, node: nd.id, inL: li, outL: c.o, turn: c.turn, len: Math.max(1, len), conflicts: new Set(), samples, latFrac };
          this.moves.push(m); nd.moves.push(m.id); inL.outMoves.push(m.id); outL.inMoves.push(m.id);
        }
      }
      // conflicts: different in-links and (same out-link, or crossing paths)
      for (let i = 0; i < nd.moves.length; i++) for (let j = i + 1; j < nd.moves.length; j++) {
        const a = this.moves[nd.moves[i]], b = this.moves[nd.moves[j]];
        if (a.inL === b.inL) continue;
        if (a.outL === b.outL || polyCross(a.samples, b.samples)) { a.conflicts.add(b.id); b.conflicts.add(a.id); }
      }
    }
  }

  private buildPhases() {
    for (const nd of this.nodes) {
      const live = nd.inLinks.filter(l => this.links[l].outMoves.length);
      if (!nd.signal || live.length < 1 || nd.boundary) { nd.signal = false; continue; }
      const ins = live.map(l => this.links[l]);
      const ref = [...ins].sort((a, b) => b.rank * b.lanes - a.rank * a.lanes)[0];
      const axis = (h: number) => { let d = Math.abs(angDiff(ref.headIn, h)); if (d > Math.PI / 2) d = Math.PI - d; return d < Math.PI / 4 ? 0 : 1; };
      const groups: number[][] = [[], []];
      for (const L of ins) groups[axis(L.headIn)].push(L.id);
      const mk = (inLinks: number[], label: string, pedOnly: boolean): Phase => {
        const moves = inLinks.flatMap(l => this.links[l].outMoves);
        const order = [...moves].sort((a, b) => prio(this.moves[a].turn) - prio(this.moves[b].turn) || a - b);
        const prot = new Set<number>(), perm = new Set<number>();
        for (const m of order) {
          let ok = true; for (const p of prot) if (this.moves[m].conflicts.has(p)) { ok = false; break; }
          (ok ? prot : perm).add(m);
        }
        return { moves, protected: prot, permissive: perm, inLinks, label, pedOnly };
      };
      const nm = (g: number[]) => { const s = [...new Set(g.map(l => this.links[l].name.replace(/^(Phố|Đường) /, '')))]; return s.slice(0, 2).join('/'); };
      if (groups[1].length === 0) {
        nd.phases = [mk(groups[0], nm(groups[0]), false), { moves: [], protected: new Set(), permissive: new Set(), inLinks: [], label: 'Người đi bộ', pedOnly: true }];
      } else {
        nd.phases = [mk(groups[0], nm(groups[0]), false), mk(groups[1], nm(groups[1]), false)];
      }
    }
  }
}

function prio(t: Turn) { return t === 'T' ? 0 : t === 'R' ? 1 : t === 'L' ? 2 : 3; }

function cubic(x0: number, y0: number, h0: number, x3: number, y3: number, h3: number, n: number): [number, number][] {
  const d = Math.hypot(x3 - x0, y3 - y0) * 0.45;
  const x1 = x0 + Math.cos(h0) * d, y1 = y0 + Math.sin(h0) * d;
  const x2 = x3 - Math.cos(h3) * d, y2 = y3 - Math.sin(h3) * d;
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, v = 1 - u;
    out.push([v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3, v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3]);
  }
  return out;
}
export function cubicAt(x0: number, y0: number, h0: number, x3: number, y3: number, h3: number, u: number, out: { x: number; y: number; h: number }) {
  const d = Math.hypot(x3 - x0, y3 - y0) * 0.45;
  const x1 = x0 + Math.cos(h0) * d, y1 = y0 + Math.sin(h0) * d;
  const x2 = x3 - Math.cos(h3) * d, y2 = y3 - Math.sin(h3) * d;
  const v = 1 - u;
  out.x = v * v * v * x0 + 3 * v * v * u * x1 + 3 * v * u * u * x2 + u * u * u * x3;
  out.y = v * v * v * y0 + 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u * y3;
  const dx = 3 * v * v * (x1 - x0) + 6 * v * u * (x2 - x1) + 3 * u * u * (x3 - x2);
  const dy = 3 * v * v * (y1 - y0) + 6 * v * u * (y2 - y1) + 3 * u * u * (y3 - y2);
  out.h = Math.atan2(dy, dx);
  return out;
}
function segX(a: number[], b: number[], c: number[], d: number[]) {
  const d1 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d2 = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
  const d3 = (d[0] - c[0]) * (a[1] - c[1]) - (d[1] - c[1]) * (a[0] - c[0]);
  const d4 = (d[0] - c[0]) * (b[1] - c[1]) - (d[1] - c[1]) * (b[0] - c[0]);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
function polyCross(p: [number, number][], q: [number, number][]) {
  for (let i = 1; i < p.length; i++) for (let j = 1; j < q.length; j++) if (segX(p[i - 1], p[i], q[j - 1], q[j])) return true;
  // near-touching paths (within 1.2 m) also conflict
  for (let i = 0; i < p.length; i += 2) for (let j = 0; j < q.length; j += 2) if (Math.hypot(p[i][0] - q[j][0], p[i][1] - q[j][1]) < 1.2) return true;
  return false;
}

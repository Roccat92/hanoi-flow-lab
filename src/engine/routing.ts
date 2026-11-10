import type { Network } from './network';

/**
 * Destination-based routing tables. For each destination link we run Dijkstra on the
 * reversed movement graph, giving for every link the next link on the cheapest path
 * (next-hop) and the remaining cost. Vehicles only store their destination, so tables
 * can be refreshed with live travel times (dynamic re-routing) deterministically.
 */
export interface RouteTable { dest: number; next: Int32Array; cost: Float64Array }

export class Router {
  // CSR of movements arriving into each link (reverse graph): for link u, entries [off[u], off[u+1])
  private off: Int32Array; private mIn: Int32Array; private mId: Int32Array;
  private heap: Heap;
  constructor(public net: Network) {
    const n = net.links.length; this.off = new Int32Array(n + 1);
    for (const L of net.links) this.off[L.id + 1] = L.inMoves.length;
    for (let i = 0; i < n; i++) this.off[i + 1] += this.off[i];
    this.mIn = new Int32Array(this.off[n]); this.mId = new Int32Array(this.off[n]);
    for (const L of net.links) { let k = this.off[L.id]; for (const mi of L.inMoves) { this.mIn[k] = net.moves[mi].inL; this.mId[k] = mi; k++; } }
    this.heap = new Heap(Math.max(16, this.off[n] + n));
  }

  /** turnCost: per-movement cost (array indexed by movement id, or a function) */
  tableTo(dest: number, linkCost: Float64Array, turnCost: Float64Array | ((m: number) => number)): RouteTable {
    const n = this.net.links.length;
    let tc: Float64Array;
    if (typeof turnCost === 'function') { tc = new Float64Array(this.net.moves.length); for (let i = 0; i < tc.length; i++) tc[i] = turnCost(i); } else tc = turnCost;
    const cost = new Float64Array(n).fill(Infinity), next = new Int32Array(n).fill(-1);
    cost[dest] = linkCost[dest];
    const h = this.heap; h.clear(); h.push(cost[dest], dest);
    const off = this.off, mIn = this.mIn, mId = this.mId;
    while (h.size) {
      const d = h.topK(), u = h.pop();
      if (d > cost[u]) continue;
      for (let k = off[u], e = off[u + 1]; k < e; k++) {
        const w = mIn[k];
        const nd = d + tc[mId[k]] + linkCost[w];
        if (nd < cost[w] - 1e-9) { cost[w] = nd; next[w] = u; h.push(nd, w); }
      }
    }
    return { dest, next, cost };
  }

  /** follow next-hops from src to the table's destination */
  path(t: RouteTable, src: number): number[] | null {
    const out = [src]; let c = src; let guard = 0;
    while (c !== t.dest) { c = t.next[c]; if (c < 0 || guard++ > 5000) return null; out.push(c); }
    return out;
  }

  /** verify each consecutive pair is connected by an allowed movement */
  isValid(route: number[]) {
    for (let i = 1; i < route.length; i++) {
      const L = this.net.links[route[i - 1]];
      if (!L.outMoves.some(m => this.net.moves[m].outL === route[i])) return false;
    }
    return true;
  }
}

/** binary min-heap on typed arrays; ties broken by value (deterministic) */
class Heap {
  k: Float64Array; v: Int32Array; size = 0;
  constructor(cap: number) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); }
  clear() { this.size = 0; }
  topK() { return this.k[0]; }
  private grow() { const k = new Float64Array(this.k.length * 2); k.set(this.k); const v = new Int32Array(this.v.length * 2); v.set(this.v); this.k = k; this.v = v; }
  push(key: number, val: number) {
    if (this.size === this.k.length) this.grow();
    const a = this.k, b = this.v; let i = this.size++;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p] < key || (a[p] === key && b[p] <= val)) break; a[i] = a[p]; b[i] = b[p]; i = p; }
    a[i] = key; b[i] = val;
  }
  pop(): number {
    const a = this.k, b = this.v; const top = b[0];
    const n = --this.size; if (n === 0) return top;
    const key = a[n], val = b[n]; let i = 0;
    for (;;) {
      const l = 2 * i + 1; if (l >= n) break;
      let m = l; const r = l + 1;
      if (r < n && (a[r] < a[l] || (a[r] === a[l] && b[r] < b[l]))) m = r;
      if (a[m] > key || (a[m] === key && b[m] >= val)) break;
      a[i] = a[m]; b[i] = b[m]; i = m;
    }
    a[i] = key; b[i] = val;
    return top;
  }
}

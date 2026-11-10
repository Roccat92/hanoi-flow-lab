import type { Network } from './network';

/**
 * Destination-based routing tables. For each destination link we run Dijkstra on the
 * reversed movement graph, giving for every link the next link on the cheapest path
 * (next-hop) and the remaining cost. Vehicles only store their destination, so tables
 * can be refreshed with live travel times (dynamic re-routing) deterministically.
 */
export interface RouteTable { dest: number; next: Int32Array; cost: Float64Array }

export class Router {
  constructor(public net: Network) {}

  tableTo(dest: number, linkCost: Float64Array, turnCost: (m: number) => number): RouteTable {
    const n = this.net.links.length;
    const cost = new Float64Array(n).fill(Infinity), next = new Int32Array(n).fill(-1);
    cost[dest] = linkCost[dest];
    const heap = new MinHeap(); heap.push(cost[dest], dest);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > cost[u]) continue;
      for (const mi of this.net.links[u].inMoves) { // movements arriving into u: m.inL -> u
        const m = this.net.moves[mi];
        const nd = d + turnCost(mi) + linkCost[m.inL];
        if (nd < cost[m.inL] - 1e-9) { cost[m.inL] = nd; next[m.inL] = u; heap.push(nd, m.inL); }
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

class MinHeap {
  k: number[] = []; v: number[] = [];
  get size() { return this.k.length; }
  push(k: number, v: number) {
    const a = this.k, b = this.v; a.push(k); b.push(v); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p] < a[i] || (a[p] === a[i] && b[p] <= b[i])) break; [a[p], a[i]] = [a[i], a[p]]; [b[p], b[i]] = [b[i], b[p]]; i = p; }
  }
  pop(): [number, number] {
    const a = this.k, b = this.v; const top: [number, number] = [a[0], b[0]];
    const lk = a.pop()!, lv = b.pop()!;
    if (a.length) {
      a[0] = lk; b[0] = lv; let i = 0;
      const less = (x: number, y: number) => a[x] < a[y] || (a[x] === a[y] && b[x] < b[y]);
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && less(l, m)) m = l; if (r < a.length && less(r, m)) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; [b[m], b[i]] = [b[i], b[m]]; i = m;
      }
    }
    return top;
  }
}

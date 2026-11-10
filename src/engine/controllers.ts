import type { ControllerKind } from './types';
import type { Node } from './network';

export interface PhaseObs {
  queuePcu: number; queueN: number; arrPcu: number; upArrPcu: number; outOcc: number;
  maxWait: number; gapS: number; pedWaiting: number; pedOldest: number; demand: boolean;
  motos: number; cars: number; buses: number;
}
export interface SignalState {
  phase: number; stage: 'G' | 'Y' | 'R'; tStage: number; next: number; lastEnd: number[];
  minGreen: number; pedQ: number[][]; // arrival times of waiting pedestrians per phase
  switches: number; lastReason: string; lastDecisionT: number; forced: number;
}
export interface Decision { switchTo: number; text: string; values: Record<string, number> }
export interface Controller { kind: ControllerKind; label: string; decide(node: Node, st: SignalState, obs: PhaseObs[], t: number): Decision | null }

export const SAFETY = { MIN_GREEN: 8, MAX_GREEN: 90, YELLOW: 3, ALL_RED: 2, MAX_RED: 120 };

const fmt = (x: number, d = 1) => x.toFixed(d);
function nextWithDemand(st: SignalState, obs: PhaseObs[]) {
  for (let k = 1; k <= obs.length; k++) { const p = (st.phase + k) % obs.length; if (p !== st.phase && obs[p].demand) return p; }
  return -1;
}

/** Fixed-time plan: 2-phase cycle, splits proportional to approach lanes (design flow). */
export class FixedTime implements Controller {
  kind: ControllerKind = 'fixed'; label = 'Cố định thời gian';
  private splits = new Map<number, number[]>();
  constructor(private cycle = 90) {}
  setSplits(node: Node, w: number[], pedMin: number[]) {
    const lost = node.phases.length * (SAFETY.YELLOW + SAFETY.ALL_RED);
    const tot = w.reduce((a, b) => a + b, 0) || 1;
    this.splits.set(node.id, w.map((x, i) => Math.max(node.phases[i].pedOnly ? pedMin[i] : 15, Math.round((this.cycle - lost) * x / tot))));
  }
  getSplits(id: number) { return this.splits.get(id); }
  decide(node: Node, st: SignalState): Decision | null {
    const sp = this.splits.get(node.id)!;
    if (st.tStage >= sp[st.phase]) {
      const to = (st.phase + 1) % node.phases.length;
      return { switchTo: to, text: `Hết thời gian xanh cố định ${sp[st.phase]}s của pha ${st.phase + 1}, chuyển theo chu kỳ ${this.cycle}s`, values: { green: st.tStage, split: sp[st.phase] } };
    }
    return null;
  }
}

/** Vehicle-actuated: min green, extend while vehicles keep arriving (gap 3 s), max 60 s, skip empty phases. */
export class Actuated implements Controller {
  kind: ControllerKind = 'actuated'; label = 'Cảm biến (actuated)';
  gap = 3; maxG = 60;
  decide(_node: Node, st: SignalState, obs: PhaseObs[]): Decision | null {
    const to = nextWithDemand(st, obs);
    if (to < 0) return null; // nobody waiting elsewhere -> rest in current green
    const cur = obs[st.phase];
    if (st.tStage >= this.maxG) return { switchTo: to, text: `Đạt xanh tối đa ${this.maxG}s, pha ${to + 1} có ${obs[to].queueN} xe chờ`, values: { green: st.tStage, queueOther: obs[to].queueN } };
    if (cur.gapS > this.gap && cur.queueN === 0) return { switchTo: to, text: `Gap-out: không có xe tới vạch trong ${this.gap}s (khoảng trống ${fmt(Math.min(cur.gapS, 99))}s), pha ${to + 1} có ${obs[to].queueN} xe chờ`, values: { gap: cur.gapS, queueOther: obs[to].queueN } };
    return null;
  }
}

/**
 * AI coordinated: weighted max-pressure with short-horizon prediction.
 * pressure(p) = sum over approaches of (queuePCU + 0.6 * predicted arrivals in H s incl. platoons
 * released by upstream signals) * (1 - downstream occupancy) + fairness term on longest wait.
 * Switch only when the best other phase beats the current one by a switching cost (lost time).
 */
export class AiCoordinated implements Controller {
  kind: ControllerKind = 'ai'; label = 'AI điều phối (max-pressure + dự báo)';
  H = 12; switchCost = 1.5; maxG = 60; gap = 2.5;
  pressure(o: PhaseObs) { return (o.queuePcu + 0.6 * (o.arrPcu + o.upArrPcu)) * (1 - 0.8 * Math.min(1, o.outOcc)) + 0.04 * o.maxWait + 0.05 * o.pedOldest; }
  decide(node: Node, st: SignalState, obs: PhaseObs[]): Decision | null {
    const P = obs.map(o => this.pressure(o));
    const cur = P[st.phase];
    let best = -1, bp = -Infinity;
    for (let i = 0; i < P.length; i++) if (i !== st.phase && obs[i].demand && P[i] > bp) { bp = P[i]; best = i; }
    if (best < 0) return null; // nobody waiting elsewhere: keep green
    const c = obs[st.phase], b = obs[best];
    const vals = { pCur: +fmt(cur, 2), pBest: +fmt(bp, 2), qCur: +fmt(c.queuePcu), qBest: +fmt(b.queuePcu), arrCur: +fmt(c.arrPcu + c.upArrPcu), arrBest: +fmt(b.arrPcu + b.upArrPcu), outOccCur: +fmt(c.outOcc, 2), waitBest: Math.round(b.maxWait), green: Math.round(st.tStage) };
    const name = (i: number) => node.phases[i].label || `pha ${i + 1}`;
    const why = () => {
      const w: string[] = [];
      if (b.queueN) w.push(`${b.queueN} xe đang chờ (${b.motos} xe máy, ${b.cars} ô tô${b.buses ? `, ${b.buses} buýt` : ''})`);
      if (b.upArrPcu > 0.5) w.push(`dự báo ${fmt(b.upArrPcu)} PCU từ nút trên tới trong ${this.H}s`);
      if (b.maxWait > 30) w.push(`xe chờ lâu nhất ${Math.round(b.maxWait)}s`);
      if (b.pedWaiting) w.push(`${b.pedWaiting} người đi bộ chờ`);
      return w.join('; ');
    };
    if (c.queueN === 0 && c.gapS > this.gap && c.upArrPcu < 0.5)
      return { switchTo: best, text: `Pha hiện tại hết xe (không có xe tới vạch trong ${this.gap}s, không có đoàn xe từ nút trên), chuyển sang ${name(best)}: ${why()}`, values: vals };
    if (c.outOcc > 0.85 && c.queuePcu > 0)
      return { switchTo: best, text: `Đường ra của pha hiện tại đã đầy ${Math.round(c.outOcc * 100)}% (tràn ngược), xả xanh cho ${name(best)} để tránh chẹn nút`, values: vals };
    if (st.tStage >= this.maxG)
      return { switchTo: best, text: `Giới hạn xanh ${this.maxG}s: chuyển sang ${name(best)} (áp lực ${fmt(bp)} so với ${fmt(cur)})`, values: vals };
    if (bp > cur + this.switchCost)
      return { switchTo: best, text: `Chuyển sang ${name(best)}: áp lực ${fmt(bp)} > ${fmt(cur)} + ${this.switchCost} (chi phí chuyển pha). ${why()}. Pha hiện tại còn ${fmt(c.queuePcu)} PCU chờ, ${fmt(c.arrPcu + c.upArrPcu)} PCU sắp tới`, values: vals };
    return null;
  }
}

export function makeController(kind: ControllerKind): Controller {
  return kind === 'fixed' ? new FixedTime() : kind === 'actuated' ? new Actuated() : new AiCoordinated();
}

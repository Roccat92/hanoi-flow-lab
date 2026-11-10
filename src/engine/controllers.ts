import type { ControllerKind } from './types';
import type { Node } from './network';

export interface PhaseObs {
  queuePcu: number; queueN: number; arrPcu: number; upArrPcu: number; outOcc: number;
  maxWait: number; gapS: number; pedWaiting: number; pedOldest: number; demand: boolean;
  motos: number; cars: number; buses: number;
  /** network-aware terms */
  outFreePcu: number;   // free storage on the phase's exit links (pcu), min over exits actually used
  outQueuePcu: number;  // queued pcu on those exits (downstream queue, max-pressure "minus" term)
  satPcuS: number;      // saturation flow of the phase (pcu/s), from approach lanes
  platoonEta: number;   // seconds until the next platoon released by an upstream signal reaches the stop line
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
  cycles = new Map<number, number>();
  setSplits(node: Node, w: number[], pedMin: number[], cycle = this.cycle) {
    const lost = node.phases.length * (SAFETY.YELLOW + SAFETY.ALL_RED);
    const tot = w.reduce((a, b) => a + b, 0) || 1;
    this.cycles.set(node.id, cycle);
    this.splits.set(node.id, w.map((x, i) => Math.max(node.phases[i].pedOnly ? pedMin[i] : 15, Math.round((cycle - lost) * x / tot))));
  }
  /** editor: exact green times per phase (seconds), clamped to the safety minimum */
  setExact(node: Node, g: number[], pedMin: number[]) {
    const sp = node.phases.map((p, i) => Math.max(SAFETY.MIN_GREEN, p.pedOnly ? pedMin[i] : 0, Math.round(g[i] ?? 20)));
    this.splits.set(node.id, sp); this.cycles.set(node.id, sp.reduce((a, b) => a + b, 0) + node.phases.length * (SAFETY.YELLOW + SAFETY.ALL_RED));
  }
  getSplits(id: number) { return this.splits.get(id); }
  decide(node: Node, st: SignalState): Decision | null {
    const sp = this.splits.get(node.id)!;
    if (st.tStage >= sp[st.phase]) {
      const to = (st.phase + 1) % node.phases.length;
      return { switchTo: to, text: `Hết thời gian xanh cố định ${sp[st.phase]}s của pha ${st.phase + 1}, chuyển theo chu kỳ ${this.cycles.get(node.id) ?? this.cycle}s`, values: { green: st.tStage, split: sp[st.phase] } };
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
 * AI coordinated (v2): network-aware weighted max-pressure with short-horizon prediction.
 * For each phase it predicts the vehicles it could actually discharge in the next H seconds:
 *   served = min(queue + arrivals (incl. platoons released upstream), saturation * H, free downstream storage)
 * and weights it against the downstream queue (max-pressure), the longest wait (anti-starvation,
 * quadratic), waiting pedestrians and bus priority. It extends the current green when a platoon from
 * the upstream signal is about to arrive (green wave), never feeds an exit that is spilling back, and
 * switches only when the gain beats the lost time of a phase change (yellow + all-red).
 */
export class AiCoordinated implements Controller {
  kind: ControllerKind = 'ai'; label = 'AI điều phối (max-pressure mạng lưới + dự báo)';
  // tuned on seed 4 only (morning + evening); reported comparisons use seeds 1-3
  H = 12; maxG = 90; gap = 2.5; lost = SAFETY.YELLOW + SAFETY.ALL_RED; kCost = 2.5; minEff = 0;
  served(o: PhaseObs) {
    const want = o.queuePcu + 0.7 * o.arrPcu + 0.5 * o.upArrPcu;
    return Math.max(0, Math.min(want, o.satPcuS * this.H, Math.max(0, o.outFreePcu)));
  }
  pressure(o: PhaseObs) {
    const w = this.served(o);
    const down = 0.35 * Math.min(o.outQueuePcu, o.queuePcu + o.arrPcu); // max-pressure: discount if exits already queue
    const wait = (o.maxWait / 60) ** 2 * 3;                              // anti-starvation, grows quadratically
    return w - down + wait + 0.06 * o.pedOldest;
  }
  decide(node: Node, st: SignalState, obs: PhaseObs[]): Decision | null {
    const P = obs.map(o => this.pressure(o));
    const cur = P[st.phase];
    let best = -1, bp = -Infinity;
    for (let i = 0; i < P.length; i++) if (i !== st.phase && obs[i].demand && P[i] > bp) { bp = P[i]; best = i; }
    if (best < 0) return null; // nobody waiting elsewhere: keep green
    const c = obs[st.phase], b = obs[best];
    // cost of switching: flow the current phase would lose during yellow + all-red, minimum 1
    const switchCost = Math.max(1, Math.min(c.queuePcu + c.arrPcu, c.satPcuS * this.lost) * this.kCost);
    const vals = { pCur: +fmt(cur, 2), pBest: +fmt(bp, 2), qCur: +fmt(c.queuePcu), qBest: +fmt(b.queuePcu), arrCur: +fmt(c.arrPcu + c.upArrPcu), arrBest: +fmt(b.arrPcu + b.upArrPcu), outFreeCur: +fmt(c.outFreePcu), outFreeBest: +fmt(b.outFreePcu), waitBest: Math.round(b.maxWait), green: Math.round(st.tStage), platoon: +fmt(Math.min(99, c.platoonEta)) };
    const name = (i: number) => node.phases[i].label || `pha ${i + 1}`;
    const why = () => {
      const w: string[] = [];
      if (b.queueN) w.push(`${b.queueN} xe đang chờ (${b.motos} xe máy/xe đạp, ${b.cars} ô tô${b.buses ? `, ${b.buses} buýt` : ''})`);
      if (b.upArrPcu > 0.5) w.push(`dự báo ${fmt(b.upArrPcu)} PCU từ nút trên tới trong ${this.H}s`);
      if (b.maxWait > 30) w.push(`xe chờ lâu nhất ${Math.round(b.maxWait)}s`);
      if (b.pedWaiting) w.push(`${b.pedWaiting} người đi bộ chờ`);
      w.push(`đường ra còn chỗ ${fmt(b.outFreePcu)} PCU`);
      return w.join('; ');
    };
    if (c.outFreePcu < 1 && c.queuePcu > 0 && b.outFreePcu > 2)
      return { switchTo: best, text: `Đường ra của pha hiện tại hết chỗ (còn ${fmt(Math.max(0, c.outFreePcu))} PCU, tràn ngược): xanh tiếp chỉ làm chẹn nút, chuyển sang ${name(best)}: ${why()}`, values: vals };
    // green wave: a platoon from the upstream signal arrives within a few seconds and the exit can take it
    const platoonSoon = c.platoonEta < 6 && c.upArrPcu > 1 && c.outFreePcu > c.upArrPcu && st.tStage < this.maxG - 6 && b.maxWait < 90;
    if (c.queueN === 0 && c.gapS > this.gap && !platoonSoon)
      return { switchTo: best, text: `Pha hiện tại hết xe (không có xe tới vạch trong ${this.gap}s, không có đoàn xe từ nút trên sắp tới), chuyển sang ${name(best)}: ${why()}`, values: vals };
    if (st.tStage >= this.maxG)
      return { switchTo: best, text: `Giới hạn xanh ${this.maxG}s: chuyển sang ${name(best)} (áp lực ${fmt(bp)} so với ${fmt(cur)})`, values: vals };
    if (platoonSoon) return null; // hold for the arriving platoon (logged via the inspector values)
    if (bp > cur + switchCost && st.tStage >= this.minEff)
      return { switchTo: best, text: `Chuyển sang ${name(best)}: lượng xe xả được dự báo ${fmt(this.served(b))} PCU, áp lực ${fmt(bp)} > ${fmt(cur)} + ${fmt(switchCost)} (mất ${this.lost}s vàng + đỏ toàn phần). ${why()}. Pha hiện tại còn ${fmt(c.queuePcu)} PCU chờ, ${fmt(c.arrPcu + c.upArrPcu)} PCU sắp tới, đường ra còn ${fmt(c.outFreePcu)} PCU`, values: vals };
    return null;
  }
}

export function makeController(kind: ControllerKind): Controller {
  return kind === 'fixed' ? new FixedTime() : kind === 'actuated' ? new Actuated() : new AiCoordinated();
}

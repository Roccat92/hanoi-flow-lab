/** Buses on fixed lines and freight trucks: data types and small stochastic helpers.
 *  Line geometry/stops come from OSM route=bus relations (public/data/bus_lines.json, see scripts/import_bus_lines.py). */
import type { Rng } from './rng';
import type { ScenarioKind } from './types';

export interface BusLineData {
  rel: number; ref: string; name: string; from: string; to: string; colour: string;
  headwayMin: [number, number]; headwayInferred: boolean; operator: string;
  links: number[]; lenM: number; coverage: number; stops: { link: number; s: number; name: string; osm: number }[];
}
export interface BusLinesFile { source: string; attribution: string; lines: BusLineData[] }

/** a running line inside the simulation (path validated against the edited network) */
export interface Line {
  idx: number; ref: string; name: string; colour: string; inferred: boolean;
  path: number[]; stops: { link: number; s: number; sid: number; pi: number }[];
  headwayS: number; nextT: number; queue: unknown[]; lastDep: Float64Array; runs: number;
}
/** a physical stop (shared by every line calling there); passengers wait per line */
export interface StopPt {
  id: number; link: number; s: number; name: string; lines: number[];
  wait: number[][];      // arrival times of waiting passengers, per entry of `lines`
  nextArr: number[];     // next arrival time per line
  rate: number[];        // passengers / s per line
  boardingUntil: number; // animation: someone is boarding until t
}

export const BUS_CAP = 80;
/** peak scenarios use the short end of the OSM interval tag, others the long end */
export const PEAK: Record<ScenarioKind, boolean> = { normal: false, morning: true, evening: true, extreme: true, incident: false, rain: false, event: false };
/** passengers arriving per hour at a stop, per line, by scenario (assumption; no ridership data for Hanoi stops is public) */
export const PAX_PER_H: Record<ScenarioKind, number> = { normal: 14, morning: 30, evening: 28, extreme: 32, incident: 14, rain: 20, event: 22 };

export function binom(r: Rng, n: number, p: number) { let k = 0; for (let i = 0; i < n; i++) if (r.next() < p) k++; return k; }
/** dwell (s): door open/close + boarding (2.0 s/pax, one door, cash/card mix) or alighting (1.4 s/pax), whichever is longer */
export function dwellTime(r: Rng, board: number, alight: number, inLane: boolean) {
  const base = 6 + Math.max(2.0 * board, 1.4 * alight);
  return Math.min(120, base * r.range(0.85, 1.2) + (inLane ? 0 : 2)); // kerb stops take a little longer to pull in/out
}

/** truck kinds (type 3 is split into these) */
export const TRUCK_KINDS = [
  { key: 'delivery', name: 'Xe tải giao hàng', len: 6.2, w: 2.1, a: 0.9, share: 0.55, cargo: ['Hàng tạp hoá', 'Nước đóng chai', 'Bia', 'Hàng thương mại điện tử', 'Gas', 'Rau quả'] },
  { key: 'heavy', name: 'Xe tải nặng', len: 9.5, w: 2.5, a: 0.6, share: 0.25, cargo: ['Vật liệu xây dựng', 'Thép', 'Container', 'Máy móc'] },
  { key: 'construction', name: 'Xe ben công trình', len: 8.0, w: 2.5, a: 0.6, share: 0.12, cargo: ['Cát', 'Đất', 'Xi măng', 'Phế thải xây dựng'] },
  { key: 'garbage', name: 'Xe rác', len: 7.5, w: 2.4, a: 0.7, share: 0.08, cargo: ['Rác sinh hoạt'] },
] as const;
export const TRUCK_LABEL = TRUCK_KINDS.map(k => k.name);

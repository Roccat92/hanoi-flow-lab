import type { DecisionLog, MapData, Metrics, SimConfig, SimEvent } from '../engine/types';

export const VSTRIDE = 7; // x, y, heading, type, speedFrac, id, flags (1 stopped, 2 honking, 4 ran a red, 8 in a fender-bender)
export const PSTRIDE = 4; // pedestrian x, y, colour, walking
export interface SignalSnap { id: number; phase: number; stage: 'G' | 'Y' | 'R'; t: number; colors: string } // one char per movement of the node
export interface Snapshot {
  t: number; n: number; veh: Float32Array; signals: SignalSnap[];
  metrics?: Metrics; linkSpeed?: Float32Array; linkOcc?: Float32Array; decisions?: DecisionLog[];
  incident?: { link: number; s: number; on: boolean } | null; stepsPerSec: number; engine: string;
  peds?: Float32Array; np?: number;
  crashes?: { id: number; x: number; y: number; h: number; crowd: number; side: number; t0: number; t1: number }[];
  events?: SimEvent[];
}
export interface NodeInfo {
  id: number; name: string; signal: boolean; phases: { label: string; inLinks: string[]; prot: number; perm: number; pedOnly: boolean }[];
  state?: { phase: number; stage: string; tStage: number; minGreen: number; switches: number; forced: number; lastReason: string; pedWaiting: number[] };
  obs?: { queuePcu: number; queueN: number; arrPcu: number; upArrPcu: number; outOcc: number; maxWait: number; pressure?: number }[];
  approaches: { link: number; name: string; queue: number; vehicles: number; speedKmh: number }[];
  log: DecisionLog[]; fixedSplits?: number[];
}
export interface LinkInfo { id: number; name: string; cls: string; lanes: number; speedKmh: number; lenM: number; twoWay: boolean; closed: boolean; inf: string[]; vehicles: number; meanKmh: number; occ: number; outMoves: { id: number; to: string; turn: string; outL: number }[]; twin: number }
export interface VehInfo { id: number; type: string; speedKmh: number; link: string; next: string; dest: string; travelS: number; ffS: number; stops: number; waitS: number; lat: number; inJunction: boolean; route: string[] }
export interface CompareResult { controller: string; label: string; summary: Metrics & Record<string, number>; series: Metrics[]; wallMs: number; violations: number }

export type ToWorker =
  | { type: 'init'; data: MapData; cfg: SimConfig }
  | { type: 'reset'; cfg: SimConfig }
  | { type: 'play'; on: boolean }
  | { type: 'speed'; x: number }
  | { type: 'light'; on: boolean }
  | { type: 'inspectNode'; id: number }
  | { type: 'inspectVeh'; id: number }
  | { type: 'compare'; seed: number; scenario: SimConfig['scenario']; minutes: number; demandScale: number; edits?: SimConfig['edits']; chaos?: number; crashes?: SimConfig['crashes'] }
  | { type: 'series' }
  | { type: 'inspectLink'; id: number };

export type FromWorker =
  | { type: 'ready'; engine: string; signals: number; links: number; nodes: number; moves: number; zones?: { node: number; w: number; name: string }[]; zebras?: number; busStops?: number }
  | { type: 'snap'; snap: Snapshot }
  | { type: 'node'; info: NodeInfo }
  | { type: 'veh'; info: VehInfo | null }
  | { type: 'series'; series: Metrics[] }
  | { type: 'link'; info: LinkInfo }
  | { type: 'compareProgress'; done: number; total: number; label: string }
  | { type: 'compareDone'; results: CompareResult[]; cfg: { seed: number; scenario: string; minutes: number; demandScale: number } };

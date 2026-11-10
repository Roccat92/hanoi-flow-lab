import type { ScenarioKind } from './types';
import raw from './scenarios.json';

export interface Scenario {
  kind: ScenarioKind; label: string; desc: string;
  demandVph: number;            // total vehicles/hour entering the network
  mix: [number, number, number, number]; // motorbike, car, bus, truck shares
  speedFactor: number;          // desired speed multiplier (rain)
  headwayFactor: number;        // IDM time headway multiplier (rain)
  accelFactor: number;
  pedRate: number;              // pedestrian calls per crosswalk per hour
  inboundBias: number;          // >1: more trips from outer boundary -> centre (east) side
  incident: boolean;            // lane blockage on a major link
  event: boolean;               // extra demand to Gò Đống Đa
}

// Shared with the SUMO backend (backend/server.py reads the same JSON)
export const SCENARIOS = raw as unknown as Record<ScenarioKind, Scenario>;

export const VTYPES = [
  // len, width, accel, decel, T, s0, vfac, pcu, co2 g/km (rough urban averages)
  { name: 'Xe máy', len: 1.9, w: 0.8, a: 2.2, b: 3.5, T: 0.9, s0: 0.8, vf: 1.05, pcu: 0.3, co2: 60 },
  { name: 'Ô tô', len: 4.5, w: 1.8, a: 1.6, b: 3.0, T: 1.3, s0: 2.0, vf: 1.0, pcu: 1.0, co2: 180 },
  { name: 'Xe buýt', len: 11.0, w: 2.5, a: 1.0, b: 2.5, T: 1.6, s0: 2.5, vf: 0.85, pcu: 2.5, co2: 900 },
  { name: 'Xe tải', len: 7.5, w: 2.3, a: 1.0, b: 2.5, T: 1.6, s0: 2.5, vf: 0.85, pcu: 2.0, co2: 600 },
] as const;

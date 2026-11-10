export interface MapNode { id: number; x: number; y: number; lat: number; lon: number; signal: boolean; boundary: boolean; osm: number[] }
export interface MapLink { id: number; from: number; to: number; pts: [number, number][]; len: number; lanes: number; speed: number; name: string; cls: string; way: number }
export interface MapData {
  meta: { area: string; bbox: number[]; origin: number[]; attribution: string; source: string; generated: string; counts: Record<string, number> };
  nodes: MapNode[]; links: MapLink[]; buildings: { p: number[]; l: number }[];
}

export type ControllerKind = 'fixed' | 'actuated' | 'ai';
export type ScenarioKind = 'normal' | 'morning' | 'evening' | 'extreme' | 'incident' | 'rain' | 'event';
export type VType = 0 | 1 | 2 | 3; // 0 motorbike, 1 car, 2 bus, 3 truck

export interface SimConfig {
  seed: number;
  controller: ControllerKind;
  scenario: ScenarioKind;
  demandScale: number; // multiplies scenario demand
  dt: number;
  maxVehicles?: number; // safety cap on active vehicles (spawns wait in entry queues beyond it)
}

export interface Metrics {
  t: number;
  active: number;
  waitingEntry: number;
  spawned: number;
  completed: number;
  throughputVph: number; // completed trips per hour over the last 5 min
  avgSpeedKmh: number;
  stopped: number;
  avgDelayS: number; // completed trips: travel time minus free-flow time (incl. entry wait)
  avgTravelS: number;
  avgStops: number;
  pcuQueued: number;
  longStopped: number; // stopped > 120 s
  co2kgH: number; // rough estimate
  pedWaitS: number;
  maxQueue: number;
}

export interface DecisionLog { t: number; node: number; from: number; to: number; kind: 'switch' | 'hold' | 'force'; text: string; values: Record<string, number> }

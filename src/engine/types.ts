export interface MapNode { id: number; x: number; y: number; lat: number; lon: number; signal: boolean; boundary: boolean; osm: number[]; hh?: number /* metres of pruned dead-end ngõ frontage (inferred local demand) */ }
export interface MapLink { id: number; from: number; to: number; pts: [number, number][]; len: number; lanes: number; speed: number; name: string; cls: string; way: number; inf?: string[] /* attributes inferred from defaults, not tagged in OSM */ }
export interface MapData {
  meta: { area: string; bbox: number[]; origin: number[]; attribution: string; source: string; generated: string; counts: Record<string, number> };
  nodes: MapNode[]; links: MapLink[]; buildings: { p: number[]; l: number }[];
  busStops?: { link: number; s: number; name: string; osm: number }[];
  crossings?: { link: number; s: number; signal: boolean; osm: number }[];
  /** fixed bus lines (merged in from public/data/bus_lines.json) */
  busLines?: import('./transit').BusLineData[];
}

export type ControllerKind = 'fixed' | 'actuated' | 'ai' | 'nosignal' | 'major' | 'flash' | 'allway' | 'optimal';
/** how one (originally signalised) junction is run: a signal controller, dark (Vietnamese negotiation), flashing amber (priority-road rule), all-way yield */
export type NodeMode = 'fixed' | 'actuated' | 'ai' | 'off' | 'flash' | 'allway';
export type ScenarioKind = 'normal' | 'morning' | 'evening' | 'extreme' | 'incident' | 'rain' | 'event';
export type VType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; // 0 motorbike, 1 car, 2 bus, 3 truck, 4 bicycle, 5 taxi, 6 van, 7 SUV

/** User edits from the map editor. Applied on top of the OSM network before every run. */
export interface Edits {
  name?: string;
  nodes?: Record<number, { signal?: boolean; cycle?: number; splits?: number[]; offset?: number; mode?: NodeMode }>;
  links?: Record<number, { lanes?: number; speed?: number; closed?: boolean }>;
  bans?: string[]; // "inLink_outLink" movements forbidden (turn bans)
  zones?: Record<number, number>; // zone representative node -> demand multiplier
  violations?: number; // multiplier on rule-violation propensity (0 = none)
  chaos?: number;
}

export interface SimConfig {
  seed: number;
  controller: ControllerKind;
  scenario: ScenarioKind;
  demandScale: number; // multiplies scenario demand
  dt: number;
  maxVehicles?: number; // safety cap on active vehicles (spawns wait in entry queues beyond it)
  edits?: Edits;
  chaos?: number; // 0 orderly .. 1 very chaotic (mức độ hỗn loạn); default 0.6
  crashes?: CrashCfg;
  /** per-junction control overrides (node id -> mode); used by the optimiser and the 'optimal' preset */
  nodeModes?: Record<number, NodeMode>;
  bus?: BusCfg;
  trucks?: TruckCfg;
}
/** buses: fixed OSM lines replace the generic bus share of the mix */
export interface BusCfg {
  lines: boolean;     // run fixed lines (else generic buses from the mix, old behaviour)
  hailP: number;      // probability per link entered that a passenger waves the bus down outside a stop
  paxScale: number;   // multiplies passenger arrival rates
  tsp: boolean;       // transit signal priority in the AI controller
}
export const DEFAULT_BUS: BusCfg = { lines: true, hailP: 0.04, paxScale: 1, tsp: false };
/** trucks: kinds, peak-hour ban, double-parked deliveries */
export interface TruckCfg {
  peakBan: boolean;   // ASSUMPTION: heavy and construction trucks are kept out of the inner city in the morning / evening peaks (Hanoi rule simplified)
  unloadP: number;    // probability per link entered that a delivery truck double-parks to unload (max one stop per trip)
  unloadMin: [number, number]; // unloading duration range, minutes
  wideTurns: boolean; // turning buses / trucks swing into the adjacent lane and block other movements from the same approach
}
export const DEFAULT_TRUCK: TruckCfg = { peakBan: true, unloadP: 0.06, unloadMin: [2, 8], wideTurns: true };
/** modelled minor collisions ("va quẹt"): scheduled from a separate seeded stream, identical for every controller */
export interface CrashCfg { on: boolean; perHour: number; minMin: number; maxMin: number; crowd: boolean }
export const DEFAULT_CRASH: CrashCfg = { on: true, perHour: 1.0, minMin: 20, maxMin: 40, crowd: true };
export interface SimEvent { t: number; kind: 'crash' | 'crashEnd' | 'incident' | 'info'; text: string; x?: number; y?: number }

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
  violations?: number; // red-light / box rule violations committed (never with a conflict present)
  busDwellS?: number;
  pedCrossed?: number;
  localTrips?: number;
  nearMiss?: number;      // junction entries with a moving conflicting vehicle < 1.5 s from arriving (post-encroachment proxy)
  hardBrakes?: number;    // decelerations harder than 4.5 m/s^2 from > 2 m/s
  gridlockEvents?: number; // junction episodes where every occupied approach has stood still > 60 s
  gridlockNodeS?: number;
  busRuns?: number;        // line buses that entered
  busSpeedKmh?: number;    // average speed of line buses incl. dwell (km/h)
  busPaxWaitS?: number;    // average wait of boarded passengers (s)
  busBoarded?: number;
  busBunching?: number;    // share of departures at a stop < 25 % of the scheduled headway after the previous bus of the same line
  busInLane?: number;      // stops made in the travel lane (kerb occupied)
  busHail?: number;        // stops outside official stops (passenger waving)
  truckUnloads?: number;   // double-parked deliveries started
  wideTurnBlocks?: number; // vehicles held back by a turning bus / truck swinging wide
}

export interface DecisionLog { t: number; node: number; from: number; to: number; kind: 'switch' | 'hold' | 'force'; text: string; values: Record<string, number> }

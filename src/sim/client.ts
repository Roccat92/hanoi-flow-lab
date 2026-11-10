import type { MapData, SimConfig } from '../engine/types';
import type { FromWorker, ToWorker } from './protocol';

/** Same message interface for the in-browser TS engine (Web Worker) and the SUMO backend (WebSocket). */
export interface SimClient { send(m: ToWorker): void; on(fn: (m: FromWorker) => void): void; close(): void; kind: 'worker' | 'sumo' }

export function workerClient(data: MapData, cfg: SimConfig): SimClient {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const fns: ((m: FromWorker) => void)[] = [];
  w.onmessage = e => fns.forEach(f => f(e.data));
  w.postMessage({ type: 'init', data, cfg } satisfies ToWorker);
  return { kind: 'worker', send: m => w.postMessage(m), on: f => { fns.push(f); }, close: () => w.terminate() };
}

/** SUMO backend: python backend/server.py streams the same snapshot messages as JSON. */
export function sumoClient(url: string, cfg: SimConfig): SimClient {
  const ws = new WebSocket(url);
  const fns: ((m: FromWorker) => void)[] = []; const queue: ToWorker[] = [];
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'init', cfg })); queue.splice(0).forEach(m => ws.send(JSON.stringify(m))); };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'snap') { m.snap.veh = new Float32Array(m.snap.veh); if (m.snap.linkSpeed) { m.snap.linkSpeed = new Float32Array(m.snap.linkSpeed); m.snap.linkOcc = new Float32Array(m.snap.linkOcc); } }
    fns.forEach(f => f(m));
  };
  return {
    kind: 'sumo', send: m => { if (m.type === 'init') return; if (ws.readyState === 1) ws.send(JSON.stringify(m)); else queue.push(m); },
    on: f => { fns.push(f); }, close: () => ws.close(),
  };
}

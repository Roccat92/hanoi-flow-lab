import React, { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import type { MapData, SimConfig } from '../engine/types';
import { MapView, type Layers } from '../render/MapView';
import { sumoClient, workerClient, type SimClient } from '../sim/client';
import type { FromWorker, Snapshot } from '../sim/protocol';

export interface SimPanelHandle { send: SimClient['send']; focus(x: number, y: number): void; fit(): void; fps(): number }
interface Props {
  data: MapData; cfg: SimConfig; cfgKey: string; layers: Layers; playing: boolean; speed: number; backend?: string | null; label?: string;
  onSnap?: (s: Snapshot) => void; onMsg?: (m: FromWorker) => void; onPick?: (k: 'veh' | 'node', id: number) => void;
}

export const SimPanel = forwardRef<SimPanelHandle, Props>(function SimPanel(p, ref) {
  const el = useRef<HTMLDivElement>(null); const view = useRef<MapView | null>(null); const client = useRef<SimClient | null>(null);
  const cb = useRef(p); cb.current = p;
  useImperativeHandle(ref, () => ({
    send: m => client.current?.send(m), focus: (x, y) => view.current?.focus(x, y), fit: () => view.current?.fit(), fps: () => view.current?.fps ?? 0,
  }));
  useEffect(() => {
    const v = new MapView(p.data, p.layers); view.current = v; let alive = true;
    v.onPick = (k, id) => cb.current.onPick?.(k, id);
    v.mount(el.current!).then(() => {
      if (!alive) { v.destroy(); return; }
      const c = p.backend ? sumoClient(p.backend, p.cfg) : workerClient(p.data, p.cfg); client.current = c;
      c.on(m => { if (m.type === 'snap') { v.update(m.snap); cb.current.onSnap?.(m.snap); } cb.current.onMsg?.(m); });
      c.send({ type: 'play', on: cb.current.playing }); c.send({ type: 'speed', x: cb.current.speed }); c.send({ type: 'light', on: cb.current.layers.light });
    });
    return () => { alive = false; client.current?.close(); client.current = null; if (v.ready) v.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.data, p.backend]);
  useEffect(() => { if (client.current) { client.current.send({ type: 'reset', cfg: p.cfg }); if (view.current) view.current.decisions = []; } }, [p.cfgKey]);
  useEffect(() => { client.current?.send({ type: 'play', on: p.playing }); }, [p.playing]);
  useEffect(() => { client.current?.send({ type: 'speed', x: p.speed }); }, [p.speed]);
  useEffect(() => { view.current?.setLayers(p.layers); client.current?.send({ type: 'light', on: p.layers.light }); }, [p.layers]);
  return <div className="simpanel">{p.label && <div className="panel-label">{p.label}</div>}<div className="pixi" ref={el} /></div>;
});

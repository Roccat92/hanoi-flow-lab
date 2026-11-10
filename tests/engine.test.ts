import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { Simulation } from '../src/engine/sim';
import { Network } from '../src/engine/network';
import { Router } from '../src/engine/routing';
import { SAFETY } from '../src/engine/controllers';
import type { MapData, ControllerKind } from '../src/engine/types';

const data: MapData = JSON.parse(readFileSync('public/data/dongda.json', 'utf8'));
const run = (controller: ControllerKind, steps: number, seed = 7, scenario: any = 'morning') => {
  const sim = new Simulation(data, { seed, controller, scenario, demandScale: 1, dt: 0.5 });
  sim.checkSafety = true;
  for (let i = 0; i < steps; i++) sim.step();
  return sim;
};

describe('map data', () => {
  it('is real OSM data for Dong Da with attribution', () => {
    expect(data.meta.attribution).toContain('OpenStreetMap');
    expect(data.nodes.length).toBeGreaterThan(100);
    expect(data.nodes.every(n => n.osm.length > 0)).toBe(true);
    const names = new Set(data.links.map(l => l.name));
    for (const s of ['Phố Xã Đàn', 'Phố Tây Sơn', 'Phố Thái Hà', 'Phố Ô Chợ Dừa']) expect(names.has(s)).toBe(true);
  });
});

describe('routing', () => {
  const net = new Network(data); const router = new Router(net);
  it('every source reaches most sinks through allowed movements only', () => {
    const cost = new Float64Array(net.links.length); for (const L of net.links) cost[L.id] = L.len / L.vmax;
    let ok = 0, total = 0;
    for (const d of net.sinks) {
      const t = router.tableTo(d, cost, () => 1);
      for (const s of net.sources) {
        if (net.links[s].from === net.links[d].to) continue;
        total++;
        const p = router.path(t, s);
        if (p) { expect(router.isValid(p)).toBe(true); expect(p[0]).toBe(s); expect(p[p.length - 1]).toBe(d); ok++; }
      }
    }
    // some OD pairs are impossible on the real one-way network (no U-turns): report, require a large majority
    expect(ok / total).toBeGreaterThan(0.8);
  });
  it('rejects a route with a non-existent turn', () => {
    const L = net.links[0];
    const bad = net.links.find(x => x.from !== L.to)!;
    expect(router.isValid([L.id, bad.id])).toBe(false);
  });
});

describe('signal safety', () => {
  for (const c of ['fixed', 'actuated', 'ai'] as ControllerKind[]) {
    it(`${c}: no conflicting protected greens, yellow + all-red between phases, min green`, () => {
      const sim = new Simulation(data, { seed: 3, controller: c, scenario: 'morning', demandScale: 1, dt: 0.5 });
      sim.checkSafety = true;
      const prev = new Map<number, { phase: number; stage: string; tStage: number }>();
      let transitions = 0;
      for (let i = 0; i < 2400; i++) {
        sim.step();
        for (const [id, st] of sim.sig) {
          const p = prev.get(id);
          if (p && p.stage !== st.stage) {
            transitions++;
            if (p.stage === 'G') { expect(st.stage).toBe('Y'); expect(p.tStage + 0.5).toBeGreaterThanOrEqual(SAFETY.MIN_GREEN); }
            if (p.stage === 'Y') { expect(st.stage).toBe('R'); expect(p.tStage + 0.5).toBeGreaterThanOrEqual(SAFETY.YELLOW); }
            if (p.stage === 'R') { expect(st.stage).toBe('G'); expect(p.tStage + 0.5).toBeGreaterThanOrEqual(SAFETY.ALL_RED); }
          }
          prev.set(id, { phase: st.phase, stage: st.stage, tStage: st.tStage });
        }
      }
      expect(transitions).toBeGreaterThan(100);
      expect(sim.safetyViolations).toBe(0); // includes: max green exceeded while another phase had demand
    });
  }
  it('protected movements inside each phase never conflict (static check)', () => {
    const net = new Network(data);
    for (const n of net.nodes) for (const ph of n.phases) {
      const prot = [...ph.protected];
      for (let i = 0; i < prot.length; i++) for (let j = i + 1; j < prot.length; j++) expect(net.moves[prot[i]].conflicts.has(prot[j])).toBe(false);
    }
  });
  it('anti-starvation: every phase with demand gets green within MAX_RED + one cycle', () => {
    const sim = run('ai', 3600, 11);
    for (const [, st] of sim.sig) for (let p = 0; p < st.lastEnd.length; p++) {
      if (p === st.phase) continue;
      const waited = sim.t - st.lastEnd[p];
      expect(waited).toBeLessThan(SAFETY.MAX_RED + SAFETY.MAX_GREEN + SAFETY.YELLOW + SAFETY.ALL_RED + 5);
    }
  });
});

describe('reproducibility', () => {
  it('same seed + config gives identical results', () => {
    const a = run('ai', 1200, 5), b = run('ai', 1200, 5);
    expect(JSON.stringify(a.metrics())).toBe(JSON.stringify(b.metrics()));
    const pa = a.allVehicles().map(v => [v.id, v.s.toFixed(6), v.lat.toFixed(6)]).join();
    const pb = b.allVehicles().map(v => [v.id, v.s.toFixed(6), v.lat.toFixed(6)]).join();
    expect(pa).toBe(pb);
  });
  it('different seeds give different demand', () => {
    expect(run('fixed', 600, 1).spawned).not.toBe(run('fixed', 600, 2).spawned);
  });
});

describe('vehicle physics', () => {
  for (const chaos of [0.6, 1]) it(`chaos ${chaos}: no overlap between laterally overlapping vehicles on a link, no teleport, no vehicle lost`, () => {
    const sim = new Simulation(data, { seed: 9, controller: 'actuated', scenario: 'evening', demandScale: 1, dt: 0.5, chaos });
    const lastPos = new Map<number, { x: number; y: number }>(); const pose = { x: 0, y: 0, h: 0 };
    let overlaps = 0, checks = 0, jumps = 0;
    for (let i = 0; i < 2400; i++) {
      sim.step();
      if (i % 20 === 0) {
        for (const list of sim.linkV) {
          for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length && b < a + 40; b++) {
            const A = list[a], B = list[b]; checks++;
            if (Math.abs(A.lat - B.lat) < (A.w + B.w) / 2 - 0.05 && A.s - A.len < B.s - 0.05) overlaps++;
          }
        }
        for (const v of sim.allVehicles()) {
          sim.pose(v, pose); const p = lastPos.get(v.id);
          if (p && Math.hypot(pose.x - p.x, pose.y - p.y) > 20 * 10 + 30) jumps++;
          lastPos.set(v.id, { x: pose.x, y: pose.y });
        }
      }
      // conservation: every created vehicle is waiting, inside or completed
      if (i % 200 === 0) {
        let waiting = 0; for (const s of sim.sources) waiting += s.queue.length;
        expect(waiting + sim.vehicleCount() + sim.completed).toBe(sim.spawned);
      }
    }
    expect(checks).toBeGreaterThan(1000);
    expect(overlaps).toBe(0);
    expect(jumps).toBe(0);
    expect(sim.maxDisp).toBeLessThan(60 / 3.6 * 1.3 * 0.5 + 0.01); // per-step displacement bounded by max speed
    expect(sim.completed).toBeGreaterThan(500);
  });
  it('motorbikes use the lateral space (sublane filtering)', () => {
    const sim = run('fixed', 1200, 4);
    const lats = new Set<number>();
    for (const v of sim.allVehicles()) if (v.type === 0 && v.mv < 0) lats.add(Math.round((v.lat / sim.net.links[v.link].width) * 10));
    expect(lats.size).toBeGreaterThan(6);
  });
});

describe('scenarios change real parameters', () => {
  it('rain lowers average speed vs normal at similar demand', () => {
    const n = new Simulation(data, { seed: 2, controller: 'fixed', scenario: 'normal', demandScale: 9000 / 7000, dt: 0.5 });
    const r = new Simulation(data, { seed: 2, controller: 'fixed', scenario: 'rain', demandScale: 1, dt: 0.5 });
    for (let i = 0; i < 1800; i++) { n.step(); r.step(); }
    expect(r.metrics().avgSpeedKmh).toBeLessThan(n.metrics().avgSpeedKmh);
  });
  it('incident places a blocking obstacle on Xa Dan during the incident window', () => {
    const sim = run('fixed', 800, 1, 'incident');
    expect(sim.incidentLink).toBeGreaterThanOrEqual(0);
    expect(sim.net.links[sim.incidentLink].name).toContain('Xã Đàn');
    expect(sim.incidentObs).not.toBeNull();
  });
});

describe('realism', () => {
  it('pedestrians cross on zebras and never share the crosswalk with a vehicle', () => {
    const sim = run('ai', 2400, 3, 'normal');
    expect(sim.zebras.length).toBeGreaterThan(50);
    expect(sim.pedCrossed).toBeGreaterThan(200);
    expect(sim.pedConflicts).toBe(0);
    expect(sim.safetyViolations).toBe(0);
  });
  it('bicycles (~2%) ride slowly and keep to the kerb side; vans, taxis and SUVs exist', () => {
    const sim = run('fixed', 1800, 5, 'normal');
    const vs = sim.allVehicles(); const bikes = vs.filter(v => v.type === 4);
    expect(bikes.length).toBeGreaterThan(3);
    expect(bikes.length / vs.length).toBeLessThan(0.08);
    for (const b of bikes) expect(b.v).toBeLessThanOrEqual(4.5 * 1.15 + 0.01);
    for (const t of [5, 6, 7]) expect(vs.some(v => v.type === t)).toBe(true);
  });
  it('ngõ: heavy vehicles never use alleys, motorbikes do, local zones generate trips', () => {
    const sim = run('fixed', 2400, 6, 'normal');
    expect(sim.zones.length).toBeGreaterThan(20);
    let heavyOnAlley = 0, twOnAlley = 0;
    for (let i = 0; i < 600; i++) {
      sim.step();
      if (i % 30) continue;
      for (const L of sim.net.links) if (L.alley) for (const v of sim.linkV[L.id]) { if (v.type === 2 || v.type === 3) heavyOnAlley++; if (v.tw) twOnAlley++; }
    }
    expect(heavyOnAlley).toBe(0);
    expect(twOnAlley).toBeGreaterThan(50);
    expect(sim.localTrips).toBeGreaterThan(300);
  });
  it('buses dwell at OSM bus stops', () => {
    const sim = run('fixed', 2400, 2, 'normal');
    expect(sim.busStops.length).toBeGreaterThan(10);
    expect(sim.busDwells).toBeGreaterThan(3);
  });
  it('rule violations happen only into conflict-free junctions and are counted; zero when disabled', () => {
    const a = run('fixed', 2400, 8, 'evening');
    expect(a.violations).toBeGreaterThan(0);
    expect(a.safetyViolations).toBe(0);
    const b = new Simulation(data, { seed: 8, controller: 'fixed', scenario: 'evening', demandScale: 1, dt: 0.5, edits: { violations: 0 } });
    for (let i = 0; i < 2400; i++) b.step();
    expect(b.violations).toBe(0);
  });
  it('modelled fender-benders: same time and place for every controller, vehicles resume afterwards', () => {
    const cr = { on: true, perHour: 6, minMin: 2, maxMin: 3, crowd: true };
    const sims = (['fixed', 'ai'] as const).map(c => { const s = new Simulation(data, { seed: 11, controller: c, scenario: 'normal', demandScale: 1, dt: 0.5, crashes: cr }); for (let i = 0; i < 3600; i++) s.step(); return s; });
    const ev = sims.map(s => s.events.filter(e => e.kind === 'crash'));
    expect(ev[0].length).toBeGreaterThan(1);
    expect(ev[1].length).toBeGreaterThan(1);
    // the drawn schedule (time to within the search window, road name) is identical
    expect(ev[0][0].text.split(':')[0]).toBe(ev[1][0].text.split(':')[0]);
    expect(Math.abs(ev[0][0].t - ev[1][0].t)).toBeLessThan(121);
    expect(sims[0].events.some(e => e.kind === 'crashEnd')).toBe(true);
    const off = new Simulation(data, { seed: 11, controller: 'fixed', scenario: 'normal', demandScale: 1, dt: 0.5, crashes: { ...cr, on: false } });
    for (let i = 0; i < 1200; i++) off.step();
    expect(off.events.filter(e => e.kind === 'crash').length).toBe(0);
  });
});

describe('map editor overrides', () => {
  const main = () => { const net = new Network(data); return net.links.filter(L => L.cls === 'primary' && L.len > 100 && !net.nodes[L.from].boundary && !net.nodes[L.to].boundary)[0]; };
  it('a closed link carries no traffic and has no movements', () => {
    const L = main();
    const sim = new Simulation(data, { seed: 1, controller: 'fixed', scenario: 'normal', demandScale: 1, dt: 0.5, edits: { links: { [L.id]: { closed: true } } } });
    expect(sim.net.links[L.id].inMoves.length + sim.net.links[L.id].outMoves.length).toBe(0);
    let seen = 0; for (let i = 0; i < 1200; i++) { sim.step(); seen += sim.linkV[L.id].length; }
    expect(seen).toBe(0);
  });
  it('turn bans remove the movement; lanes and speed overrides apply', () => {
    const net0 = new Network(data); const m = net0.moves.find(x => x.turn === 'L' && net0.nodes[x.node].signal)!;
    const L = main();
    const net = new Network(data, { bans: [m.inL + '_' + m.outL], links: { [L.id]: { lanes: 4, speed: 20 } } });
    expect(net.moves.some(x => x.inL === m.inL && x.outL === m.outL)).toBe(false);
    expect(net.links[L.id].lanes).toBe(4);
    expect(net.links[L.id].vmax).toBeCloseTo(20 / 3.6);
  });
  it('removing / adding a signal changes the controlled junction set', () => {
    const net0 = new Network(data); const sig = net0.nodes.find(n => n.signal)!; const un = net0.nodes.find(n => !n.signal && !n.boundary && n.inLinks.length >= 3 && n.inLinks.every(l => !net0.links[l].alley))!;
    const sim = new Simulation(data, { seed: 1, controller: 'ai', scenario: 'normal', demandScale: 1, dt: 0.5, edits: { nodes: { [sig.id]: { signal: false }, [un.id]: { signal: true } } } });
    expect(sim.sig.has(sig.id)).toBe(false);
    expect(sim.sig.has(un.id)).toBe(true);
    sim.checkSafety = true; for (let i = 0; i < 1200; i++) sim.step();
    expect(sim.safetyViolations).toBe(0);
  });
  it('fixed-time cycle and splits from the editor are used', () => {
    const net0 = new Network(data); const sig = net0.nodes.find(n => n.signal && n.phases.length === 2)!;
    const sim = new Simulation(data, { seed: 1, controller: 'fixed', scenario: 'normal', demandScale: 1, dt: 0.5, edits: { nodes: { [sig.id]: { cycle: 60, splits: [30, 20] } } } });
    expect((sim.ctrl as any).getSplits(sig.id)).toEqual([30, 20]);
  });
  it('zone demand multiplier 0 removes that zone', () => {
    const a = new Simulation(data, { seed: 1, controller: 'fixed', scenario: 'normal', demandScale: 1, dt: 0.5 });
    const z = a.zones[0].node;
    const b = new Simulation(data, { seed: 1, controller: 'fixed', scenario: 'normal', demandScale: 1, dt: 0.5, edits: { zones: { [z]: 0 } } });
    expect(b.zones.length).toBe(a.zones.length - 1);
  });
});

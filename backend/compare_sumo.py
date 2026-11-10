#!/usr/bin/env python3
"""Headless SUMO comparison with identical seed and demand for fixed / actuated / ai.
   python backend/compare_sumo.py morning 30 1,2,3  -> results/sumo_compare_<scenario>_<min>min.json"""
import json, os, sys, time
from simcore import SumoSim, HERE

def main():
    scenario = sys.argv[1] if len(sys.argv) > 1 else 'morning'; minutes = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    seeds = [int(s) for s in (sys.argv[3] if len(sys.argv) > 3 else '1').split(',')]
    scale = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
    kinds = (sys.argv[5] if len(sys.argv) > 5 else 'fixed,actuated,ai').split(',')
    runs = []
    for seed in seeds:
        res = []
        for c in kinds:
            t0 = time.time()
            sim = SumoSim({'seed': seed, 'controller': c, 'scenario': scenario, 'demandScale': scale, 'minutes': minutes}, label=f'cmp_{c}_{seed}')
            for _ in range(int(minutes * 60 / sim.dt)): sim.step()
            m = sim.metrics(); m['trips'] = sim.n_trips; m['switches'] = sum(a.switches for a in sim.ai); m['wallS'] = round(time.time() - t0, 1)
            sim.close(); res.append({'controller': c, 'summary': m})
            print(seed, c, {k: round(v, 1) if isinstance(v, float) else v for k, v in m.items() if k in ('active', 'completed', 'throughputVph', 'avgSpeedKmh', 'avgDelayS', 'avgTravelS', 'stopped', 'waitingEntry', 'wallS')}, flush=True)
        runs.append({'seed': seed, 'results': res})
    os.makedirs(os.path.join(HERE, '..', 'results'), exist_ok=True)
    out = os.path.join(HERE, '..', 'results', f'sumo_compare_{scenario}_{minutes}min_x{scale}' + ('' if kinds == ['fixed', 'actuated', 'ai'] else '_' + '-'.join(kinds)) + '.json')
    json.dump({'engine': 'SUMO', 'scenario': scenario, 'minutes': minutes, 'seeds': seeds, 'demandScale': scale, 'runs': runs}, open(out, 'w'), indent=1, ensure_ascii=False)
    print('wrote', out)

if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""SUMO backend for HANOI FLOW LAB. Streams the same snapshot messages as the TS Web Worker.
   python backend/server.py  ->  open the app with ?backend=ws://localhost:8765/ws"""
import asyncio, json, time, itertools
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn
from simcore import SumoSim

app = FastAPI(title='HANOI FLOW LAB SUMO backend')
ENGINE = 'SUMO (TraCI, sublane 0.8 m) - engine chuẩn'
counter = itertools.count()

@app.get('/health')
def health():
    return {'ok': True, 'engine': ENGINE}

@app.websocket('/ws')
async def ws(sock: WebSocket):
    await sock.accept()
    st = {'sim': None, 'playing': True, 'speed': 1.0, 'cfg': None}
    def start(cfg):
        if st['sim']: st['sim'].close()
        st['cfg'] = cfg; st['sim'] = SumoSim(cfg, label=f'ws{next(counter)}')
    async def reader():
        while True:
            m = json.loads(await sock.receive_text())
            if m['type'] in ('init', 'reset'):
                start(m['cfg'])
                await sock.send_text(json.dumps({'type': 'ready', 'engine': ENGINE, 'signals': len(st['sim'].ai), 'links': 0, 'nodes': 0, 'moves': 0}))
            elif m['type'] == 'play': st['playing'] = m['on']
            elif m['type'] == 'speed': st['speed'] = float(m['x'])
            elif m['type'] in ('inspectNode', 'inspectVeh'):
                await sock.send_text(json.dumps({'type': 'veh', 'info': None}))
    async def runner():
        last = time.perf_counter(); acc = 0.0; steps = 0; t0 = last; sps = 0.0; last_metric = -1
        while True:
            await asyncio.sleep(0.066)
            sim = st['sim']
            if not sim: continue
            now = time.perf_counter(); real = min(0.2, now - last); last = now
            if st['playing']:
                acc += real * min(st['speed'], 32)
                budget = time.perf_counter()
                while acc >= sim.dt and time.perf_counter() - budget < 0.05:
                    sim.step(); acc -= sim.dt; steps += 1
                if acc > 1: acc = 0
            if now - t0 > 1: sps = steps / (now - t0); steps = 0; t0 = now
            snap = {'t': sim.t, 'n': 0, 'veh': sim.snapshot(), 'signals': [], 'stepsPerSec': sps, 'engine': ENGINE}
            snap['n'] = len(snap['veh']) // 7
            if int(sim.t) != last_metric:
                last_metric = int(sim.t); snap['metrics'] = sim.metrics()
                snap['decisions'] = [{'t': d['t'], 'node': -1, 'from': d['from'], 'to': d['to'], 'kind': 'switch', 'text': f"SUMO TLS {d['tls']}: pha {d['from']} -> {d['to']} (áp lực {d['pBest']} > {d['pCur']})", 'values': {}} for a in sim.ai for d in a.log[-2:] if d['t'] > sim.t - 1]
            await sock.send_text(json.dumps({'type': 'snap', 'snap': snap}))
    try:
        await asyncio.gather(reader(), runner())
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if st['sim']: st['sim'].close()

if __name__ == '__main__':
    uvicorn.run(app, host='0.0.0.0', port=8765)

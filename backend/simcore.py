"""SUMO-based authoritative engine for HANOI FLOW LAB (TraCI).
Same scenarios (src/engine/scenarios.json), same three controllers, same metric names as the TS engine."""
import json, math, os, random, sys
import sumo
import sumolib, traci

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
SCEN = json.load(open(os.path.join(ROOT, 'src', 'engine', 'scenarios.json'), encoding='utf-8'))
MAP = json.load(open(os.path.join(ROOT, 'public', 'data', 'dongda.json'), encoding='utf-8'))
LAT0, LON0 = MAP['meta']['origin']
KX = math.cos(math.radians(LAT0)) * 111320.0; KY = 110540.0
VT = [  # id, vClass, length, width, accel, decel, tau, minGap, speedFactor, pcu, latAlign
    ('moto', 'motorcycle', 1.9, 0.8, 2.2, 3.5, 0.9, 0.8, 1.05, 0.3),
    ('car', 'passenger', 4.5, 1.8, 1.6, 3.0, 1.3, 2.0, 1.0, 1.0),
    ('bus', 'bus', 11.0, 2.5, 1.0, 2.5, 1.6, 2.5, 0.85, 2.5),
    ('truck', 'truck', 7.5, 2.3, 1.0, 2.5, 1.6, 2.5, 0.85, 2.0)]
TYPE_IDX = {v[0]: i for i, v in enumerate(VT)}
MIN_GREEN, MAX_GREEN_AI, YELLOW, ALL_RED, MAX_RED = 8, 90, 3, 2, 120
H_PRED, K_COST, GAP = 12, 2.5, 2.5  # same constants as AiCoordinated v2 in src/engine/controllers.ts


def net_path(controller):
    return os.path.join(HERE, 'sumo', f"dongda_{'actuated' if controller == 'actuated' else 'static'}.net.xml")


def write_demand(net, sc, seed, minutes, demand_scale, path):
    rnd = random.Random(seed)
    edges = [e for e in net.getEdges() if e.allows('passenger') and e.getFunction() != 'internal']
    bx = net.getBoundary(); cx = (bx[0] + bx[2]) / 2
    rank = {'highway.trunk': 5, 'highway.primary': 4, 'highway.secondary': 3, 'highway.tertiary': 2}
    def w(e):
        return rank.get(e.getType(), 1) * e.getLaneNumber()
    src = [e for e in edges if not [x for x in e.getIncoming() if x.getFromNode() != e.getToNode()]]
    dst = [e for e in edges if not [x for x in e.getOutgoing() if x.getToNode() != e.getFromNode()]]
    bias = sc['inboundBias']
    sw = [w(e) * (bias if e.getFromNode().getCoord()[0] <= cx else 1 / bias) for e in src]
    dw = [w(e) * (bias if e.getToNode().getCoord()[0] > cx else 1 / bias) for e in dst]
    ev = []
    if sc['event']:
        x, y = net.convertLonLat2XY(105.8237, 21.0147)
        ev = sorted(edges, key=lambda e: min(math.dist((x, y), p) for p in e.getShape()))[:2]
    vph = sc['demandVph'] * demand_scale; T = minutes * 60
    lines = ['<routes>']
    for (tid, vcls, L, W, a, b, tau, mg, sf, pcu) in VT:
        lat = 'arbitrary' if tid == 'moto' else 'center'
        lines.append(f'<vType id="{tid}" vClass="{vcls}" length="{L}" width="{W}" accel="{a * sc["accelFactor"]}" decel="{b}" tau="{tau * sc["headwayFactor"]}" minGap="{mg}" '
                     f'speedFactor="{sf * sc["speedFactor"]}" speedDev="0.1" carFollowModel="IDM" latAlignment="{lat}" maxSpeedLat="{1.2 if tid == "moto" else 0.8}" lcSublane="{2 if tid == "moto" else 1}" lcPushy="{0.6 if tid == "moto" else 0.1}" minGapLat="{0.3 if tid == "moto" else 0.5}"/>')
    t = 0.0; n = 0; mix = sc['mix']
    while True:
        t += rnd.expovariate(vph / 3600.0)
        if t >= T: break
        r = rnd.random(); ti = 0 if r < mix[0] else 1 if r < mix[0] + mix[1] else 2 if r < mix[0] + mix[1] + mix[2] else 3
        o = rnd.choices(src, sw)[0]
        if ev and rnd.random() < 3000 / vph: d = rnd.choice(ev)
        else: d = rnd.choices(dst, dw)[0]
        if d.getToNode() == o.getFromNode(): continue
        lines.append(f'<trip id="v{n}" type="{VT[ti][0]}" depart="{t:.2f}" from="{o.getID()}" to="{d.getID()}" departLane="best" departSpeed="max"/>'); n += 1
    lines.append('</routes>')
    open(path, 'w').write('\n'.join(lines))
    return n


class AiTls:
    """Network-aware weighted max-pressure + prediction on SUMO's own green phases (same rule as AiCoordinated v2 in the TS engine):
    served = min(queue + 0.7 arrivals, saturation * H, free downstream storage) - 0.35 downstream queue + (maxWait/60)^2 * 3,
    switch when gain > lost flow of yellow + all-red, never feed a spilling-back exit, anti-starvation after 120 s."""
    def __init__(self, tid):
        self.id = tid
        logic = traci.trafficlight.getAllProgramLogics(tid)[0]
        self.states = [p.state for p in logic.phases]
        self.greens = [i for i, s in enumerate(self.states) if ('G' in s or 'g' in s) and 'y' not in s.lower()]
        links = traci.trafficlight.getControlledLinks(tid)
        self.links = [l[0] if l else None for l in links]
        self.cur = self.greens[0] if self.greens else 0; self.stage = 'G'; self.t = 0.0; self.next = self.cur
        self.last_end = {g: 0.0 for g in self.greens}; self.switches = 0; self.log = []; self.last_obs = {}
        traci.trafficlight.setRedYellowGreenState(tid, self.states[self.cur])

    def obs(self, g):
        s = self.states[g]; q = arr = 0.0; seen_in = set(); seen_out = set(); maxwait = 0.0; free = 99.0; outq = 0.0; nq = 0
        for k, ch in enumerate(s):
            if ch not in 'Gg' or not self.links[k]: continue
            lin, lout, _ = self.links[k]
            if lin not in seen_in:
                seen_in.add(lin)
                for vid in traci.lane.getLastStepVehicleIDs(lin):
                    pc = VT[TYPE_IDX.get(traci.vehicle.getTypeID(vid), 1)][9]
                    if traci.vehicle.getSpeed(vid) < 1.5: q += pc; nq += 1; maxwait = max(maxwait, traci.vehicle.getWaitingTime(vid))
                    else:
                        d = traci.lane.getLength(lin) - traci.vehicle.getLanePosition(vid)
                        if d / max(traci.vehicle.getSpeed(vid), 0.1) <= H_PRED: arr += pc
            if lout not in seen_out:
                seen_out.add(lout)
                cap = max(1.0, traci.lane.getLength(lout) / 6.5 * 1.6); pcu = 0.0; lq = 0.0
                for vid in traci.lane.getLastStepVehicleIDs(lout):
                    pc = VT[TYPE_IDX.get(traci.vehicle.getTypeID(vid), 1)][9]; pcu += pc
                    if traci.vehicle.getSpeed(vid) < 1: lq += pc
                free = min(free, cap - pcu); outq += lq
        sat = 0.55 * len(seen_in)
        return {'q': q, 'n': nq, 'arr': arr, 'free': free, 'outq': outq, 'wait': maxwait, 'sat': sat}

    def pressure(self, o):
        served = max(0.0, min(o['q'] + 0.7 * o['arr'], o['sat'] * H_PRED, max(0.0, o['free'])))
        return served - 0.35 * min(o['outq'], o['q'] + o['arr']) + (o['wait'] / 60) ** 2 * 3

    def step(self, t, dt):
        self.t += dt
        if not self.greens: return
        if self.stage == 'Y' and self.t >= YELLOW:
            self.stage = 'R'; self.t = 0; traci.trafficlight.setRedYellowGreenState(self.id, 'r' * len(self.states[0]))
        elif self.stage == 'R' and self.t >= ALL_RED:
            self.last_end[self.cur] = t; self.cur = self.next; self.stage = 'G'; self.t = 0; self.switches += 1
            traci.trafficlight.setRedYellowGreenState(self.id, self.states[self.cur])
        elif self.stage == 'G' and self.t >= MIN_GREEN and abs(t - round(t)) < 1e-6:
            O = {g: self.obs(g) for g in self.greens}; P = {g: self.pressure(O[g]) for g in self.greens}
            self.last_obs = {g: (O[g], P[g]) for g in self.greens}
            others = [g for g in self.greens if g != self.cur and (O[g]['q'] > 0 or O[g]['arr'] > 0)]
            if not others: return
            best = max(others, key=lambda g: P[g]); c = O[self.cur]; b = O[best]
            cost = max(1.0, min(c['q'] + c['arr'], c['sat'] * (YELLOW + ALL_RED)) * K_COST)
            starving = [g for g in others if t - self.last_end[g] > MAX_RED]
            go = None; why = ''
            if starving: go = starving[0]; why = f'an toàn: pha {go} đỏ quá {MAX_RED}s'
            elif c['free'] < 1 and c['q'] > 0 and b['free'] > 2: go = best; why = 'đường ra hết chỗ (tràn ngược)'
            elif c['n'] == 0 and c['arr'] == 0: go = best; why = 'pha hiện tại hết xe'
            elif self.t >= MAX_GREEN_AI: go = best; why = f'xanh tối đa {MAX_GREEN_AI}s'
            elif P[best] > P[self.cur] + cost: go = best; why = f'áp lực {P[best]:.1f} > {P[self.cur]:.1f} + {cost:.1f}'
            if go is not None and go != self.cur:
                self.next = go; self.stage = 'Y'; self.t = 0
                ystate = ''.join('y' if c_ in 'Gg' and self.states[go][k] not in 'Gg' else (c_ if c_ in 'Gg' else 'r') for k, c_ in enumerate(self.states[self.cur]))
                traci.trafficlight.setRedYellowGreenState(self.id, ystate)
                self.log.append({'t': t, 'tls': self.id, 'from': self.cur, 'to': go, 'pCur': round(P[self.cur], 2), 'pBest': round(P[go], 2), 'why': why,
                                 'q': round(b['q'], 1), 'free': round(b['free'], 1)})
                if len(self.log) > 300: del self.log[:100]


class SumoSim:
    def __init__(self, cfg, label='hfl', gui=False):
        self.cfg = cfg; self.sc = SCEN[cfg.get('scenario', 'morning')]; self.ctrl = cfg.get('controller', 'ai')
        self.dt = 0.5; self.minutes = cfg.get('minutes', 120); self.label = label
        self.netfile = net_path(self.ctrl)
        if not os.path.exists(self.netfile):
            raise SystemExit(f'missing {self.netfile}: run python backend/build_net.py first')
        self.net = sumolib.net.readNet(self.netfile)
        os.makedirs(os.path.join(HERE, 'sumo', 'tmp'), exist_ok=True)
        self.routes = os.path.join(HERE, 'sumo', 'tmp', f'{label}_{cfg.get("seed", 42)}_{self.sc["kind"]}.rou.xml')
        self.n_trips = write_demand(self.net, self.sc, cfg.get('seed', 42), self.minutes, cfg.get('demandScale', 1.0), self.routes)
        self.fit_affine()
        binary = os.path.join(sumo.SUMO_HOME, 'bin', 'sumo-gui' if gui else 'sumo')
        traci.start([binary, '-n', self.netfile, '-r', self.routes, '--step-length', str(self.dt), '--lateral-resolution', '0.8',
                     '--seed', str(cfg.get('seed', 42)), '--time-to-teleport', '-1', '--no-step-log', 'true', '--no-warnings', 'true',
                     '--ignore-route-errors', 'true', '--collision.action', 'warn', '--device.rerouting.probability', '1', '--device.rerouting.period', '60'], label=label)
        self.conn = traci.getConnection(label); traci.switch(label)
        self.ai = [AiTls(t) for t in traci.trafficlight.getIDList()] if self.ctrl == 'ai' else []
        self.ai_by = {a.id: a for a in self.ai}
        self.build_signal_map()
        self.t = 0.0; self.completed = 0; self.timeloss = {}; self.depart = {}; self.done = []; self.sum_delay = 0.0; self.sum_tt = 0.0
        self.series = []; self.incident_lanes = []; self.inc_on = False
        if self.sc['incident']:
            cand = [e for e in self.net.getEdges() if 'Xã Đàn' in (e.getName() or '') and e.getLaneNumber() >= 2]
            if cand:
                e = max(cand, key=lambda e: e.getLength()); k = max(1, round(e.getLaneNumber() * 2 / 3))
                self.incident_lanes = [l.getID() for l in e.getLanes()[:k]]

    def fit_affine(self):
        b = self.net.getBoundary(); pts = [(b[0], b[1]), (b[2], b[1]), (b[0], b[3]), (b[2], b[3])]
        rows = []
        for x, y in pts:
            lon, lat = self.net.convertXY2LonLat(x, y)
            rows.append((x, y, (lon - LON0) * KX, -(lat - LAT0) * KY))
        # solve X = a x + b y + c (least squares via normal equations, 4 points)
        import itertools
        def solve(idx):
            A = [[r[0], r[1], 1.0] for r in rows]; Y = [r[idx] for r in rows]
            AT = list(zip(*A)); M = [[sum(a * b for a, b in zip(r1, r2)) for r2 in AT] for r1 in AT]; v = [sum(a * y for a, y in zip(r, Y)) for r in AT]
            # Cramer 3x3
            def det(m): return m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1]) - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0]) + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0])
            D = det(M); out = []
            for i in range(3):
                Mi = [row[:] for row in M]
                for r in range(3): Mi[r][i] = v[r]
                out.append(det(Mi) / D)
            return out
        self.ax = solve(2); self.ay = solve(3)

    def to_web(self, x, y):
        return self.ax[0] * x + self.ax[1] * y + self.ax[2], self.ay[0] * x + self.ay[1] * y + self.ay[2]

    def step(self):
        traci.switch(self.label)
        if self.incident_lanes:
            on = 300 <= self.t < 1500
            if on != self.inc_on:
                for l in self.incident_lanes: traci.lane.setDisallowed(l, ['all'] if on else [])
                self.inc_on = on
        traci.simulationStep()
        self.t = traci.simulation.getTime()
        for a in self.ai: a.step(self.t, self.dt)
        for vid in traci.simulation.getDepartedIDList(): self.depart[vid] = self.t
        for vid in traci.simulation.getArrivedIDList():
            tt = self.t - self.depart.pop(vid, self.t); d = self.timeloss.pop(vid, 0.0)
            self.completed += 1; self.sum_tt += tt; self.sum_delay += d; self.done.append((self.t, d, tt))
        if abs(self.t % 5) < 1e-6:
            for vid in traci.vehicle.getIDList(): self.timeloss[vid] = traci.vehicle.getTimeLoss(vid)
        if abs(self.t % 10) < 1e-6: self.series.append(self.metrics())

    def metrics(self):
        ids = traci.vehicle.getIDList(); sp = [traci.vehicle.getSpeed(v) for v in ids]
        recent = [d for d in self.done if d[0] > self.t - 300]; win = min(300, max(self.t, 1))
        pending = traci.simulation.getMinExpectedNumber() - len(ids)
        return {'t': self.t, 'active': len(ids), 'waitingEntry': max(0, len(traci.simulation.getPendingVehicles()) if hasattr(traci.simulation, 'getPendingVehicles') else pending),
                'spawned': self.completed + len(ids), 'completed': self.completed, 'throughputVph': len(recent) * 3600 / win,
                'avgSpeedKmh': (sum(sp) / len(sp) * 3.6) if sp else 0, 'stopped': sum(1 for s in sp if s < 0.5),
                'avgDelayS': self.sum_delay / self.completed if self.completed else 0, 'avgTravelS': self.sum_tt / self.completed if self.completed else 0,
                'avgStops': 0, 'pcuQueued': 0, 'longStopped': 0, 'co2kgH': 0, 'pedWaitS': 0, 'maxQueue': 0,
                'recentDelayS': (sum(d[1] for d in recent) / len(recent)) if recent else 0}

    def snapshot(self):
        traci.switch(self.label)
        ids = traci.vehicle.getIDList(); veh = []
        for v in ids:
            x, y = traci.vehicle.getPosition(v); X, Y = self.to_web(x, y)
            ang = math.radians(90 - traci.vehicle.getAngle(v)); h = -ang  # SUMO angle: 0 = north, clockwise; web y points down
            s = traci.vehicle.getSpeed(v); vm = max(1.0, traci.vehicle.getAllowedSpeed(v))
            veh += [X, Y, h, TYPE_IDX.get(traci.vehicle.getTypeID(v), 1), min(1, s / vm), int(v[1:]) if v[1:].isdigit() else 0, 1 if s < 0.5 else 0]
        return veh

    # ------------------------------------------------------------ TS map <-> SUMO TLS mapping (signal layer + inspector)
    def build_signal_map(self):
        """For every TS movement at a TS signal node find the SUMO controlled link with matching in/out headings."""
        nodes = MAP['nodes']; links = MAP['links']
        inl = {}; outl = {}
        for L in links: inl.setdefault(L['to'], []).append(L); outl.setdefault(L['from'], []).append(L)
        def head(p, q): return math.atan2(q[1] - p[1], q[0] - p[0])
        self._dbg = []
        def back(P, dist=15.0):
            acc = 0.0
            for i in range(1, len(P)):
                acc += math.dist(P[i - 1], P[i])
                if acc >= dist: return P[i]
            return P[-1]
        def ad(a, b):
            d = abs(a - b) % (2 * math.pi); return min(d, 2 * math.pi - d)
        self.sig_map = {}   # ts node id -> (tls id, [(ts inL, ts outL, sumo link index)], tls centre)
        tls_ids = traci.trafficlight.getIDList()
        cl = {}
        for tid in tls_ids:
            pts = []
            for k, l in enumerate(traci.trafficlight.getControlledLinks(tid)):
                if not l: continue
                lin, lout, _ = l[0]
                shp = [self.to_web(*q) for q in traci.lane.getShape(lin)]; osh = [self.to_web(*q) for q in traci.lane.getShape(lout)]
                b = shp[-1]; a = back(shp[::-1]); c = osh[0]; d = back(osh)
                pts.append((k, b, head(a, b), head(c, d)))
            if pts: cl[tid] = pts
        self._cl = cl
        for n in nodes:
            if not n['signal']: continue
            best = None
            for tid, pts in cl.items():
                dmin = min(math.dist((n['x'], n['y']), p[1]) for p in pts)
                if dmin < 70 and (best is None or dmin < best[0]): best = (dmin, tid)
            if not best: continue
            tid = best[1]; mv = []
            near = [(t2, p) for t2, ps in cl.items() for p in ps if math.dist((n['x'], n['y']), p[1]) < 90]
            for L in inl.get(n['id'], []):
                hin = head(back(L['pts'][::-1]), L['pts'][-1])
                for O in outl.get(n['id'], []):
                    hout = head(O['pts'][0], back(O['pts']))
                    sc = [(ad(hin, p[2]) + ad(hout, p[3]) + math.dist(L['pts'][-1], p[1]) / 120, t2, p[0]) for t2, p in near]
                    s0 = min(sc) if sc else None
                    self._dbg.append(s0[0] if s0 else 9)
                    if s0 and s0[0] < 1.0: mv.append((L['id'], O['id'], s0[1], s0[2]))
            self.sig_map[n['id']] = (tid, mv)

    CH = {'G': 'G', 'g': 'g', 'y': 'Y', 'Y': 'Y', 'r': 'R', 'R': 'R', 's': 'R', 'u': 'Y', 'o': 'N', 'O': 'N'}
    def signals(self, ts_moves):
        """ts_moves: {ts node id: [(inL, outL), ...]} in the TS movement order used by the renderer"""
        traci.switch(self.label); out = []; states = {}
        for nid, (tid, mv) in self.sig_map.items():
            def stt(t_):
                if t_ not in states: states[t_] = traci.trafficlight.getRedYellowGreenState(t_)
                return states[t_]
            idx = {(a, b): (t_, k) for a, b, t_, k in mv}
            byin = {}
            for (a, b), (t_, k) in idx.items(): byin.setdefault(a, []).append(self.CH.get(stt(t_)[k], 'R') if k < len(stt(t_)) else 'R')
            def col(m):
                if m in idx:
                    t_, k = idx[m]; st_ = stt(t_); return self.CH.get(st_[k], 'R') if k < len(st_) else 'R'
                c = byin.get(m[0])   # movement SUMO does not control separately: take the approach's most restrictive colour
                return min(c, key=lambda x: 'RYgG'.index(x) if x in 'RYgG' else 0) if c else 'R'
            cols = ''.join(col(m) for m in ts_moves.get(nid, []))
            st = stt(tid)
            a = self.ai_by.get(tid)
            stage = a.stage if a else ('Y' if 'y' in st.lower() else 'G')
            if a: phase = a.greens.index(a.cur) if a.cur in a.greens else 0
            else:
                ph = traci.trafficlight.getPhase(tid); gl = self._greens(tid); phase = gl.index(ph) if ph in gl else max([i for i, g in enumerate(gl) if g < ph] or [0])
            out.append({'id': nid, 'phase': phase, 'stage': stage, 't': a.t if a else 0, 'colors': cols})
        return out

    def _greens(self, tid):
        if not hasattr(self, '_gcache'): self._gcache = {}
        if tid not in self._gcache:
            logic = traci.trafficlight.getAllProgramLogics(tid)[0]
            self._gcache[tid] = [i for i, p in enumerate(logic.phases) if ('G' in p.state or 'g' in p.state) and 'y' not in p.state.lower()]
        return self._gcache[tid]

    def node_info(self, nid, ts_name):
        traci.switch(self.label)
        if nid not in self.sig_map:
            return {'id': nid, 'name': ts_name, 'signal': False, 'phases': [], 'approaches': [], 'log': [], 'engineNote': 'SUMO: nút này không có đèn trong mạng SUMO (netconvert gộp/loại đèn khác TS).'}
        tid, _ = self.sig_map[nid]; a = self.ai_by.get(tid)
        logic = traci.trafficlight.getAllProgramLogics(tid)[0]
        greens = [i for i, p in enumerate(logic.phases) if ('G' in p.state or 'g' in p.state) and 'y' not in p.state.lower()]
        lanes = list(dict.fromkeys(traci.trafficlight.getControlledLanes(tid)))
        edges = {}
        for ln in lanes:
            e = traci.lane.getEdgeID(ln); d = edges.setdefault(e, {'veh': 0, 'halt': 0, 'sp': []})
            ids = traci.lane.getLastStepVehicleIDs(ln); d['veh'] += len(ids); d['halt'] += traci.lane.getLastStepHaltingNumber(ln)
            d['sp'] += [traci.vehicle.getSpeed(v) for v in ids]
        def ename(e):
            try: return self.net.getEdge(e).getName() or e
            except Exception: return e
        appr = [{'link': -1, 'name': ename(e), 'queue': d['halt'], 'vehicles': d['veh'], 'speedKmh': (sum(d['sp']) / len(d['sp']) * 3.6) if d['sp'] else 0} for e, d in edges.items()]
        cur = traci.trafficlight.getPhase(tid)
        obs = None
        if a and a.last_obs:
            obs = [{'queuePcu': o['q'], 'queueN': o['n'], 'arrPcu': o['arr'], 'upArrPcu': 0, 'outOcc': 0 if o['free'] >= 99 else max(0, 1 - o['free'] / 20), 'maxWait': o['wait'], 'pressure': p} for g, (o, p) in a.last_obs.items()]
        state = {'phase': (a.greens.index(a.cur) if a else (greens.index(cur) if cur in greens else max([i for i, g in enumerate(greens) if g < cur] or [0]))), 'stage': a.stage if a else ('Y' if 'y' in logic.phases[cur].state.lower() else 'G'),
                 'tStage': a.t if a else traci.trafficlight.getSpentDuration(tid) if hasattr(traci.trafficlight, 'getSpentDuration') else 0,
                 'minGreen': MIN_GREEN, 'switches': a.switches if a else 0, 'forced': 0,
                 'lastReason': (a.log[-1]['why'] if a and a.log else f'SUMO {self.ctrl}: chương trình {traci.trafficlight.getProgram(tid)}'), 'pedWaiting': [0] * len(greens)}
        log = [{'t': d['t'], 'node': nid, 'from': d['from'], 'to': d['to'], 'kind': 'switch', 'text': f"SUMO TLS {tid}: {d['why']} -> pha {d['to']}", 'values': {}} for d in (a.log[-12:][::-1] if a else [])]
        return {'id': nid, 'name': ts_name, 'signal': True,
                'phases': [{'label': f'SUMO pha {i} ({logic.phases[i].state[:12]}…)', 'inLinks': [], 'prot': logic.phases[i].state.count('G'), 'perm': logic.phases[i].state.count('g'), 'pedOnly': False} for i in greens],
                'state': state, 'obs': obs, 'approaches': appr, 'log': log,
                'fixedSplits': [int(logic.phases[i].duration) for i in greens] if self.ctrl == 'fixed' else None}

    def veh_info(self, num):
        traci.switch(self.label); vid = f'v{num}'
        if vid not in traci.vehicle.getIDList(): return None
        def ename(e):
            try: return self.net.getEdge(e).getName() or e
            except Exception: return e
        route = traci.vehicle.getRoute(vid); ri = traci.vehicle.getRouteIndex(vid); rem = []
        for e in route[max(0, ri):]:
            nm = ename(e)
            if not rem or rem[-1] != nm: rem.append(nm)
        road = traci.vehicle.getRoadID(vid); w = traci.lane.getWidth(traci.vehicle.getLaneID(vid)) if not road.startswith(':') else 3.2
        names = {'moto': 'Xe máy', 'car': 'Ô tô', 'bus': 'Xe buýt', 'truck': 'Xe tải'}
        return {'id': num, 'type': names.get(traci.vehicle.getTypeID(vid), traci.vehicle.getTypeID(vid)), 'speedKmh': traci.vehicle.getSpeed(vid) * 3.6,
                'link': ename(road) if not road.startswith(':') else 'trong nút giao', 'next': rem[1] if len(rem) > 1 else 'Điểm đến', 'dest': ename(route[-1]),
                'travelS': self.t - self.depart.get(vid, self.t), 'ffS': max(0.0, self.t - self.depart.get(vid, self.t) - traci.vehicle.getTimeLoss(vid)), 'stops': 0,
                'waitS': traci.vehicle.getAccumulatedWaitingTime(vid), 'lat': 0.5 + traci.vehicle.getLateralLanePosition(vid) / max(1, w), 'inJunction': road.startswith(':'), 'route': rem[:12]}

    def close(self):
        try: traci.switch(self.label); traci.close()
        except Exception: pass

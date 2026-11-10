#!/usr/bin/env python3
"""Real Hanoi bus lines (OSM route=bus relations, PTv2) mapped onto the simulation network.
Reads the OSM API 0.6 tiles cached in data/raw/tile_*.osm (they contain every relation touching the area) and public/data/dongda.json,
writes public/data/bus_lines.json. Headways come from the relation's `interval` tag; missing ones are marked inferred.
Data (c) OpenStreetMap contributors, ODbL 1.0."""
import glob, heapq, json, math, os, re, sys
import xml.etree.ElementTree as ET
ROOT = os.path.join(os.path.dirname(__file__), '..')
data = json.load(open(os.path.join(ROOT, 'public', 'data', 'dongda.json'), encoding='utf-8'))
S, W, N, E = data['meta']['bbox']; LAT0, LON0 = data['meta']['origin']
KX = math.cos(math.radians(LAT0)) * 111320.0; KY = 110540.0
proj = lambda lat, lon: ((lon - LON0) * KX, -(lat - LAT0) * KY)
rels, ncoord, ntags = {}, {}, {}
for f in sorted(glob.glob(os.path.join(ROOT, 'data', 'raw', 'tile_*.osm'))):
    root = ET.parse(f).getroot()
    for n in root.iter('node'):
        ncoord[int(n.get('id'))] = (float(n.get('lat')), float(n.get('lon')))
        t = {x.get('k'): x.get('v') for x in n.iter('tag')}
        if t: ntags[int(n.get('id'))] = t
    for r in root.iter('relation'):
        t = {x.get('k'): x.get('v') for x in r.iter('tag')}
        if t.get('route') != 'bus': continue
        rels[int(r.get('id'))] = (t, [(m.get('type'), int(m.get('ref')), m.get('role') or '') for m in r.iter('member')])
links = data['links']; out_of = {}
for L in links: out_of.setdefault(L['from'], []).append(L)
by_way = {}
for L in links: by_way.setdefault(L['way'], []).append(L)

def seg_proj(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]; l2 = dx * dx + dy * dy or 1e-9
    u = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    q = (a[0] + u * dx, a[1] + u * dy); return math.dist(p, q), u * math.sqrt(l2)

def project(p, L):
    best, acc, bs = 1e9, 0.0, 0.0
    pts = L['pts']
    for i in range(1, len(pts)):
        d, s = seg_proj(p, pts[i - 1], pts[i])
        if d < best: best, bs = d, acc + s
        acc += math.dist(pts[i - 1], pts[i])
    return best, bs * L['len'] / max(acc, 1e-6)

def route(starts, ends, wayidx):
    ends = {L['id'] for L in ends}; best = None
    for st in starts:
        dist = {st['id']: 0.0}; prev = {}; pq = [(0.0, st['id'])]; got = None
        while pq:
            d, lid = heapq.heappop(pq)
            if d > dist.get(lid, 1e18): continue
            if lid in ends: got = lid; break
            L = links[lid]
            for O in out_of.get(L['to'], []):
                if O['to'] == L['from'] and len(out_of[L['to']]) > 1: continue  # no U-turns
                c = O['len'] * (1 if O['way'] in wayidx else 25)
                if d + c < dist.get(O['id'], 1e18): dist[O['id']] = d + c; prev[O['id']] = lid; heapq.heappush(pq, (d + c, O['id']))
        if got is None: continue
        path = [got]
        while path[-1] != st['id']: path.append(prev[path[-1]])
        path.reverse()
        seq = [wayidx[links[l]['way']] for l in path if links[l]['way'] in wayidx]
        desc = sum(1 for a, b in zip(seq, seq[1:]) if b < a)
        score = (desc, dist[got])
        if best is None or score < best[0]: best = (score, path)
    return best[1] if best else None

lines = []; skipped = []
for rid, (t, mem) in sorted(rels.items(), key=lambda x: (x[1][0].get('ref', ''), x[0])):
    ref = t.get('ref', '?')
    if ref.endswith('CT'): skipped.append((ref, 'weekend variant')); continue
    ways = [r for ty, r, _ in mem if ty == 'way']
    wayidx = {}
    for i, w in enumerate(ways): wayidx.setdefault(w, i)
    present = [w for w in ways if w in by_way]
    if len(present) < 3: skipped.append((ref, 'too few ways in area')); continue
    path = route(by_way[present[0]], by_way[present[-1]], wayidx)
    if not path: skipped.append((ref, 'no path')); continue
    tot = sum(links[l]['len'] for l in path); on = sum(links[l]['len'] for l in path if links[l]['way'] in wayidx)
    if on / tot < 0.75: skipped.append((ref, f'path matches relation only {on / tot:.0%}')); continue
    # stops: platform / stop members projected onto the path, kept in path order
    cum = [0.0]
    for l in path: cum.append(cum[-1] + links[l]['len'])
    stops = []
    for ty, r, role in mem:
        if ty != 'node' or not (role.startswith('platform') or role.startswith('stop')) or r not in ncoord: continue
        p = proj(*ncoord[r]); best = None
        for k, l in enumerate(path):
            d, s = project(p, links[l])
            if d < 30 and (best is None or d < best[0]): best = (d, k, s)
        if not best: continue
        _, k, s = best; L = links[path[k]]
        s = min(max(s, 12.0), L['len'] - 12.0) if L['len'] > 30 else L['len'] * 0.5
        pos = cum[k] + s
        if stops and pos <= stops[-1]['pos'] + 25: continue  # duplicate stop/platform pair or out of order
        stops.append({'link': path[k], 's': round(s, 1), 'name': ntags.get(r, {}).get('name', ''), 'osm': r, 'pos': pos})
    iv = re.findall(r'(\d+):(\d+)', t.get('interval', ''))
    hw = [int(h) * 60 + int(m) for h, m in iv][:2]
    if len(hw) == 1: hw = hw * 2
    lines.append({'rel': rid, 'ref': ref, 'name': t.get('name', ''), 'from': t.get('from', ''), 'to': t.get('to', ''), 'colour': t.get('colour', ''),
                  'headwayMin': hw if hw else [15, 20], 'headwayInferred': not hw, 'operator': t.get('operator', ''),
                  'links': path, 'lenM': round(tot), 'coverage': round(on / tot, 2), 'stops': [{k: v for k, v in s.items() if k != 'pos'} for s in stops]})
json.dump({'source': 'OpenStreetMap route=bus relations (PTv2), via OSM API 0.6 tiles', 'attribution': '(c) OpenStreetMap contributors, ODbL 1.0',
           'lines': lines, 'skipped': skipped}, open(os.path.join(ROOT, 'public', 'data', 'bus_lines.json'), 'w', encoding='utf-8'), ensure_ascii=False)
print(len(lines), 'lines', len(skipped), 'skipped')
for L in lines: print(L['ref'], L['name'][:40], 'links', len(L['links']), 'len', L['lenM'], 'cov', L['coverage'], 'stops', len(L['stops']), 'hw', L['headwayMin'], 'inf' if L['headwayInferred'] else '')

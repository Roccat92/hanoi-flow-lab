#!/usr/bin/env python3
"""Import a real OpenStreetMap road network for an area of Dong Da, Hanoi.

Data: (c) OpenStreetMap contributors, ODbL 1.0 - https://www.openstreetmap.org/copyright

Steps:
  1. Download raw OSM data (Overpass mirrors first, then the OSM API 0.6 /map
     endpoint in small tiles). Raw tiles are cached in data/raw/.
  2. Keep drivable highways + traffic signal nodes + building footprints.
  3. Write data/raw/dongda_roads.osm (roads only) for SUMO netconvert.
  4. Build a simplified directed graph (junction clusters merged, ways split at
     junctions, clipped to the bbox) and write public/data/dongda.json.

Usage: python3 scripts/import_osm.py [--offline]
"""
import json, math, os, sys, time, urllib.request, urllib.parse
import xml.etree.ElementTree as ET
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'raw')
OUT = os.path.join(ROOT, 'public', 'data', 'dongda.json')

# Area: O Cho Dua - Xa Dan - Tay Son - Thai Ha - Hoang Cau (Dong Da district)
S, W, N, E = 21.004, 105.814, 21.024, 105.838
TILE = 0.008

KEEP = {'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
        'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service'}
CLS_RANK = {'alley': 0, 'trunk': 5, 'primary': 4, 'secondary': 3, 'tertiary': 2, 'unclassified': 1, 'residential': 1}
DEF_SPEED = {'alley': 15, 'trunk': 60, 'primary': 50, 'secondary': 40, 'tertiary': 40, 'unclassified': 30, 'residential': 30}
DEF_LANES_DIR = {'alley': 1, 'trunk': 3, 'primary': 2, 'secondary': 2, 'tertiary': 1, 'unclassified': 1, 'residential': 1}
ALLEY_PREFIX = ('ngõ', 'ngách', 'hẻm', 'kiệt')
MERGE_DIST = 25.0   # metres: junction nodes closer than this (and linked) are merged
SIGNAL_SNAP = 35.0  # metres: traffic_signals node -> junction cluster

OVERPASS = ['https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter',
            'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
            'https://overpass.private.coffee/api/interpreter']


def fetch(url, data=None, timeout=90):
    req = urllib.request.Request(url, data=data, headers={'User-Agent': 'hanoi-flow-lab/1.0 (github.com/Roccat92/hanoi-flow-lab)'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def download():
    os.makedirs(RAW, exist_ok=True)
    files = []
    q = f'[out:xml][timeout:120];(way["highway"]({S},{W},{N},{E});way["building"]({S},{W},{N},{E});node["highway"="traffic_signals"]({S},{W},{N},{E});node["highway"="bus_stop"]({S},{W},{N},{E});node["public_transport"="platform"]({S},{W},{N},{E});node["highway"="crossing"]({S},{W},{N},{E}););(._;>;);out body;'
    cache = os.path.join(RAW, 'overpass_v2.osm')
    if os.path.exists(cache):
        return [cache]
    tiles = []
    lat = S
    while lat < N - 1e-9:
        lon = W
        while lon < E - 1e-9:
            tiles.append((round(lon, 4), round(lat, 4), round(min(lon + TILE, E), 4), round(min(lat + TILE, N), 4)))
            lon += TILE
        lat += TILE
    cached = [os.path.join(RAW, 'tile_%s_%s_%s_%s.osm' % t) for t in tiles]
    if all(os.path.exists(c) for c in cached):
        return cached
    if '--offline' not in sys.argv:
        for url in OVERPASS:
            try:
                print('Overpass:', url)
                body = fetch(url, urllib.parse.urlencode({'data': q}).encode(), timeout=150)
                if b'<osm' in body[:500]:
                    open(cache, 'wb').write(body)
                    return [cache]
            except Exception as e:  # noqa
                print('  failed:', e)
        print('Overpass unavailable, using OSM API 0.6 /map in tiles')
        for t, c in zip(tiles, cached):
            if os.path.exists(c):
                continue
            url = 'https://api.openstreetmap.org/api/0.6/map?bbox=%s,%s,%s,%s' % t
            print('  tile', t)
            open(c, 'wb').write(fetch(url))
            time.sleep(1)
        return cached
    raise SystemExit('no cached data and --offline given')


def parse(files):
    nodes, ways = {}, {}
    for f in files:
        for ev, el in ET.iterparse(f):
            if el.tag == 'node':
                tags = {t.get('k'): t.get('v') for t in el.findall('tag')}
                nodes[el.get('id')] = (float(el.get('lat')), float(el.get('lon')), tags)
                el.clear()
            elif el.tag == 'way':
                tags = {t.get('k'): t.get('v') for t in el.findall('tag')}
                refs = [nd.get('ref') for nd in el.findall('nd')]
                ways[el.get('id')] = (refs, tags)
                el.clear()
    return nodes, ways


LAT0, LON0 = (S + N) / 2, (W + E) / 2
KX = math.cos(math.radians(LAT0)) * 111320.0
KY = 110540.0


def proj(lat, lon):
    return ((lon - LON0) * KX, -(lat - LAT0) * KY)


def inside(lat, lon):
    return S <= lat <= N and W <= lon <= E


def is_road(tags):
    h = tags.get('highway')
    if h not in KEEP:
        return False
    if tags.get('area') == 'yes' or tags.get('access') in ('private', 'no'):
        return False
    if h == 'service' and tags.get('service', 'alley') != 'alley':
        return False  # keep ngõ (service=alley / untagged), drop driveways and parking aisles
    return True


def road_class(tags):
    h = tags['highway'].replace('_link', '')
    if h in ('living_street', 'service'):
        return 'alley'
    if h == 'residential':
        name = (tags.get('name') or '').strip().lower()
        if not name or name.startswith(ALLEY_PREFIX):
            return 'alley'  # ngõ / ngách / unnamed lanes: narrow, motorbike-heavy, slow
    return h
    return True


def write_sumo_osm(nodes, ways, road_ids):
    used = set()
    for wid in road_ids:
        used.update(ways[wid][0])
    path = os.path.join(RAW, 'dongda_roads.osm')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="hanoi-flow-lab">\n')
        f.write('<!-- (c) OpenStreetMap contributors, ODbL 1.0 -->\n')
        f.write(f'<bounds minlat="{S}" minlon="{W}" maxlat="{N}" maxlon="{E}"/>\n')
        for nid in sorted(used, key=int):
            if nid not in nodes:
                continue
            lat, lon, tags = nodes[nid]
            if tags:
                f.write(f'<node id="{nid}" lat="{lat}" lon="{lon}">')
                for k, v in tags.items():
                    f.write('<tag k=%s v=%s/>' % (json.dumps(k), json.dumps(v)))
                f.write('</node>\n')
            else:
                f.write(f'<node id="{nid}" lat="{lat}" lon="{lon}"/>\n')
        for wid in sorted(road_ids, key=int):
            refs, tags = ways[wid]
            f.write(f'<way id="{wid}">')
            for r in refs:
                if r in nodes:
                    f.write(f'<nd ref="{r}"/>')
            for k, v in tags.items():
                f.write('<tag k=%s v=%s/>' % (json.dumps(k, ensure_ascii=False), json.dumps(v, ensure_ascii=False)))
            f.write('</way>\n')
        f.write('</osm>\n')
    print('wrote', path)


def lanes_of(tags, oneway):
    h = road_class(tags)
    try:
        total = int(float(tags.get('lanes', '').split(';')[0]))
    except ValueError:
        total = 0
    if total <= 0:
        d = DEF_LANES_DIR.get(h, 1)
        if '_link' in tags['highway']:
            d = 1
        return d, d
    if oneway:
        return total, 0
    fw = tags.get('lanes:forward'); bw = tags.get('lanes:backward')
    if fw and bw:
        try:
            return int(fw), int(bw)
        except ValueError:
            pass
    return max(1, total // 2), max(1, total - total // 2)


def speed_of(tags):
    h = road_class(tags)
    try:
        return float(tags.get('maxspeed', '').split()[0])
    except (ValueError, IndexError):
        return DEF_SPEED.get(h, 30)


def build(nodes, ways):
    road_ids = [w for w, (refs, tags) in ways.items() if is_road(tags)]
    write_sumo_osm(nodes, ways, road_ids)
    # clip ways to bbox: split into runs of consecutive inside nodes
    runs = []
    for wid in road_ids:
        refs, tags = ways[wid]
        cur = []
        for r in refs:
            if r in nodes and inside(nodes[r][0], nodes[r][1]):
                cur.append(r)
            else:
                if len(cur) >= 2:
                    runs.append((wid, cur))
                cur = []
        if len(cur) >= 2:
            runs.append((wid, cur))
    use = defaultdict(int)
    for wid, refs in runs:
        for i, r in enumerate(refs):
            use[r] += 2 if i in (0, len(refs) - 1) else 1
    is_junc = {r for r, c in use.items() if c >= 2}
    for wid, refs in runs:
        is_junc.add(refs[0]); is_junc.add(refs[-1])
    xy = {r: proj(nodes[r][0], nodes[r][1]) for r in use}

    # raw segments between junction nodes
    segs = []
    for wid, refs in runs:
        start = 0
        for i in range(1, len(refs)):
            if refs[i] in is_junc:
                segs.append((wid, refs[start:i + 1]))
                start = i

    def seglen(rs):
        return sum(math.dist(xy[rs[i]], xy[rs[i + 1]]) for i in range(len(rs) - 1))

    # union-find: merge junction nodes joined by short segments (complex junctions, dual carriageways)
    parent = {r: r for r in is_junc}

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for wid, rs in segs:
        a, b = rs[0], rs[-1]
        deg_ok = use[a] >= 3 and use[b] >= 3  # both are real intersections
        if a != b and deg_ok and road_class(ways[wid][1]) != 'alley' and seglen(rs) < MERGE_DIST:
            pa, pb = find(a), find(b)
            if pa != pb:
                parent[pa] = pb
    clusters = defaultdict(list)
    for r in is_junc:
        clusters[find(r)].append(r)
    cid = {}
    cnodes = []
    for k, members in clusters.items():
        x = sum(xy[m][0] for m in members) / len(members)
        y = sum(xy[m][1] for m in members) / len(members)
        lat = sum(nodes[m][0] for m in members) / len(members)
        lon = sum(nodes[m][1] for m in members) / len(members)
        for m in members:
            cid[m] = len(cnodes)
        cnodes.append({'x': round(x, 2), 'y': round(y, 2), 'lat': round(lat, 7), 'lon': round(lon, 7), 'osm': [int(m) for m in members]})

    links = []
    for wid, rs in segs:
        a, b = cid[rs[0]], cid[rs[-1]]
        if a == b:
            continue  # internal to a merged junction
        refs, tags = ways[wid]
        pts = [list(cnodes[a][k] for k in ('x', 'y'))] + [[round(xy[r][0], 2), round(xy[r][1], 2)] for r in rs[1:-1]] + [list(cnodes[b][k] for k in ('x', 'y'))]
        ow = tags.get('oneway')
        oneway = ow in ('yes', '1', 'true', '-1') or tags.get('junction') == 'roundabout'
        rev = ow == '-1'
        fw, bw = lanes_of(tags, oneway)
        sp = speed_of(tags)
        inf = [k for k, t in (('lanes', 'lanes'), ('speed', 'maxspeed')) if t not in tags]
        if not oneway and 'oneway' not in tags:
            inf.append('oneway')
        base = {'name': tags.get('name', ''), 'cls': road_class(tags), 'speed': sp, 'way': int(wid), 'inf': inf}
        if rev:
            links.append(dict(base, frm=b, to=a, pts=pts[::-1], lanes=fw))
        else:
            links.append(dict(base, frm=a, to=b, pts=pts, lanes=fw))
            if not oneway:
                links.append(dict(base, frm=b, to=a, pts=pts[::-1], lanes=bw))

    # dedupe parallel duplicates (same from/to/way)
    seen = set(); uniq = []
    for l in links:
        k = (l['frm'], l['to'], l['way'])
        if k in seen:
            continue
        seen.add(k); uniq.append(l)
    links = uniq

    # prune dead-end ngõ/ngách trees: their length becomes household demand ("hh", metres of
    # alley frontage) at the node where the tree joins the through network (inferred OD zones)
    hh = defaultdict(float)
    while True:
        und = defaultdict(set); inc = defaultdict(list)
        for i, l in enumerate(links):
            und[l['frm']].add(l['to']); und[l['to']].add(l['frm'])
            inc[l['frm']].append(i); inc[l['to']].append(i)
        kill = set()
        for v, nb in und.items():
            if len(nb) == 1 and all(links[i]['cls'] == 'alley' for i in inc[v]):
                u = next(iter(nb))
                if u in kill:
                    continue
                seg = max(sum(math.dist(links[i]['pts'][k], links[i]['pts'][k + 1]) for k in range(len(links[i]['pts']) - 1)) for i in inc[v])
                hh[u] += seg + hh.pop(v, 0.0)
                kill.add(v)
        if not kill:
            break
        links = [l for l in links if l['frm'] not in kill and l['to'] not in kill]

    # collapse degree-2 alley chain nodes (pure geometry) to keep the routing graph small
    changed = True
    while changed:
        changed = False
        und = defaultdict(set); inc = defaultdict(list)
        for i, l in enumerate(links):
            und[l['frm']].add(l['to']); und[l['to']].add(l['frm'])
            inc[l['frm']].append(i); inc[l['to']].append(i)
        pairs = {(l['frm'], l['to']) for l in links}
        dead = set(); new_links = []; touched = set()
        for v, nb in und.items():
            if len(nb) != 2 or hh.get(v) or v in touched:
                continue
            ls = [links[i] for i in inc[v]]
            if any(l['cls'] != 'alley' for l in ls) or any(i in dead for i in inc[v]):
                continue
            a, b = sorted(nb)
            if a in touched or b in touched or (a, b) in pairs or (b, a) in pairs:
                continue
            def find_l(f, t):
                for i in inc[v]:
                    if links[i]['frm'] == f and links[i]['to'] == t:
                        return i
                return None
            ok = True; made = []
            for f, t in ((a, b), (b, a)):
                i1, i2 = find_l(f, v), find_l(v, t)
                if (i1 is None) != (i2 is None):
                    ok = False; break
                if i1 is not None:
                    made.append((i1, i2))
            if not ok or not made:
                continue
            w = min(links[i]['way'] for i in inc[v])
            for i1, i2 in made:
                l1, l2 = links[i1], links[i2]
                new_links.append(dict(l1, to=l2['to'], pts=l1['pts'] + l2['pts'][1:], way=w,
                                      name=l1['name'] or l2['name'], lanes=min(l1['lanes'], l2['lanes']), speed=min(l1['speed'], l2['speed'])))
                dead.add(i1); dead.add(i2)
            touched.update((v, a, b)); changed = True
        links = [l for i, l in enumerate(links) if i not in dead] + new_links

    # boundary nodes: endpoints whose original way continued outside the bbox
    boundary = set()
    for wid, rs in runs:
        refs = ways[wid][0]
        for end in (rs[0], rs[-1]):
            idx = refs.index(end)
            nb = [refs[j] for j in (idx - 1, idx + 1) if 0 <= j < len(refs)]
            if ways[wid][1].get('highway') not in ('residential', 'living_street', 'service') or road_class(ways[wid][1]) != 'alley':
                if any(n in nodes and not inside(nodes[n][0], nodes[n][1]) for n in nb):
                    boundary.add(cid[end])

    # dead ends close to the bbox edge are also network entries/exits
    und = defaultdict(set)
    for l in links:
        und[l['frm']].add(l['to']); und[l['to']].add(l['frm'])
    xmin, ymax = proj(S, W); xmax, ymin = proj(N, E)
    for v, nb in und.items():
        if len(nb) == 1 and not all(l['cls'] == 'alley' for l in links if l['frm'] == v or l['to'] == v):
            x, y = cnodes[v]['x'], cnodes[v]['y']
            if min(x - xmin, xmax - x, y - ymin, ymax - y) < 90:
                boundary.add(v)

    # keep the largest strongly connected component (Kosaraju)
    out = defaultdict(list); inn = defaultdict(list)
    for l in links:
        out[l['frm']].append(l['to']); inn[l['to']].append(l['frm'])
    order, vis = [], set()
    for s in range(len(cnodes)):
        if s in vis:
            continue
        stack = [(s, iter(out[s]))]; vis.add(s)
        while stack:
            v, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                stack.pop(); order.append(v)
            elif nxt not in vis:
                vis.add(nxt); stack.append((nxt, iter(out[nxt])))
    comp = {}
    for s in reversed(order):
        if s in comp:
            continue
        c = s; st = [s]; comp[s] = c
        while st:
            v = st.pop()
            for u in inn[v]:
                if u not in comp:
                    comp[u] = c; st.append(u)
    sizes = defaultdict(int)
    for v, c in comp.items():
        sizes[c] += 1
    big = max(sizes, key=sizes.get)
    core = {v for v in range(len(cnodes)) if comp.get(v) == big}
    # boundary entry/exit points of one-way carriageways are not strongly connected by
    # themselves: keep pure sources whose links feed the core and pure sinks fed by it
    extra = set()
    for v in boundary:
        if v in core:
            continue
        if out[v] and not inn[v] and all(u in core for u in out[v]):
            extra.add(v)
        elif inn[v] and not out[v] and all(u in core for u in inn[v]):
            extra.add(v)
    keepn = sorted(core | extra)
    remap = {v: i for i, v in enumerate(keepn)}
    links = [l for l in links if l['frm'] in remap and l['to'] in remap]

    # traffic signals -> nearest cluster
    sig_nodes = [r for r, (lat, lon, t) in nodes.items() if t.get('highway') == 'traffic_signals' and inside(lat, lon)]
    signal = set()
    deg = defaultdict(set)
    for l in links:
        if l['cls'] != 'alley':
            deg[l['frm']].add(l['to']); deg[l['to']].add(l['frm'])
    for r in sig_nodes:
        p = proj(nodes[r][0], nodes[r][1])
        best, bd = None, SIGNAL_SNAP
        for v in keepn:
            if len(deg[v]) < 3:
                continue
            d = math.dist(p, (cnodes[v]['x'], cnodes[v]['y']))
            if d < bd:
                best, bd = v, d
        if best is not None:
            signal.add(best)

    out_nodes = []
    for v in keepn:
        n = cnodes[v]
        out_nodes.append({'id': remap[v], 'x': n['x'], 'y': n['y'], 'lat': n['lat'], 'lon': n['lon'],
                          'signal': v in signal, 'boundary': v in boundary, 'osm': n['osm'][:6],
                          'hh': round(hh.get(v, 0.0))})
    out_links = []
    for i, l in enumerate(links):
        L = sum(math.dist(l['pts'][k], l['pts'][k + 1]) for k in range(len(l['pts']) - 1))
        out_links.append({'id': i, 'from': remap[l['frm']], 'to': remap[l['to']], 'pts': l['pts'], 'len': round(L, 2),
                          'lanes': max(1, int(l['lanes'])), 'speed': l['speed'], 'name': l['name'], 'cls': l['cls'], 'way': l['way'], 'inf': l.get('inf', [])})

    # bus stops and zebra crossings snapped onto links (s along link, side of road)
    def project(p, l):
        best = (1e9, 0, 0)
        acc = 0.0
        for k in range(len(l['pts']) - 1):
            a, b = l['pts'][k], l['pts'][k + 1]
            dx, dy = b[0] - a[0], b[1] - a[1]; L2 = dx * dx + dy * dy or 1
            u = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
            qx, qy = a[0] + u * dx, a[1] + u * dy; d = math.dist(p, (qx, qy))
            side = (dx * (p[1] - a[1]) - dy * (p[0] - a[0]))  # >0: right of travel direction (y down)
            if d < best[0]:
                best = (d, acc + u * math.sqrt(L2), side)
            acc += math.sqrt(L2)
        return best
    stops = []
    for r, (lat, lon, t) in nodes.items():
        if not inside(lat, lon) or not (t.get('highway') == 'bus_stop' or (t.get('public_transport') == 'platform' and t.get('bus') == 'yes')):
            continue
        p = proj(lat, lon); cand = []
        for l in out_links:
            if l['cls'] == 'alley':
                continue
            d, sv, side = project(p, l)
            if d < 30 and side >= 0 and 15 < sv < l['len'] - 20:
                cand.append((d, l['id'], sv))
        if cand:
            d, lid, sv = min(cand)
            if not any(st['link'] == lid and abs(st['s'] - sv) < 30 for st in stops):
                stops.append({'link': lid, 's': round(sv, 1), 'name': t.get('name', 'Điểm dừng xe buýt'), 'osm': int(r)})
    crossings = []
    for r, (lat, lon, t) in nodes.items():
        if not inside(lat, lon) or t.get('highway') != 'crossing':
            continue
        p = proj(lat, lon)
        for l in out_links:
            d, sv, side = project(p, l)
            if d < 9 and 4 < sv < l['len'] - 4 and l['cls'] != 'alley':
                crossings.append({'link': l['id'], 's': round(sv, 1), 'signal': t.get('crossing') == 'traffic_signals', 'osm': int(r)})

    # buildings (visual only), simplified
    blds = []
    for wid, (refs, tags) in ways.items():
        if 'building' not in tags or len(refs) < 4:
            continue
        pts = [proj(nodes[r][0], nodes[r][1]) for r in refs if r in nodes]
        if not pts or not all(inside(nodes[r][0], nodes[r][1]) for r in refs if r in nodes):
            continue
        flat = []
        for x, y in pts[:-1]:
            flat += [round(x, 1), round(y, 1)]
        h = 0
        try:
            h = int(float(tags.get('building:levels', '0')))
        except ValueError:
            pass
        blds.append({'p': flat, 'l': h})

    data = {
        'meta': {
            'area': 'Đống Đa, Hà Nội (Ô Chợ Dừa - Xã Đàn - Tây Sơn - Thái Hà - Hoàng Cầu)',
            'bbox': [S, W, N, E], 'origin': [LAT0, LON0],
            'attribution': '© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)',
            'source': 'OpenStreetMap (OSM API 0.6 / Overpass)', 'generated': time.strftime('%Y-%m-%d'),
            'filters': 'trunk/primary/secondary/tertiary/unclassified/residential + ngõ/ngách/living_street as cls=alley (15 km/h, 1 lane)',
            'counts': {'nodes': len(out_nodes), 'links': len(out_links), 'signals': sum(n['signal'] for n in out_nodes),
                       'boundary': sum(n['boundary'] for n in out_nodes), 'buildings': len(blds),
                       'signal_nodes_osm': len(sig_nodes), 'bus_stops': len(stops), 'crossings': len(crossings),
                       'alley_links': sum(1 for l in out_links if l['cls'] == 'alley'), 'zones': sum(1 for n in out_nodes if n['hh'] >= 40), 'hh_m': round(sum(n['hh'] for n in out_nodes))},
        },
        'nodes': out_nodes, 'links': out_links, 'buildings': blds, 'busStops': stops, 'crossings': crossings,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    print(json.dumps(data['meta']['counts']))
    print('wrote', OUT, os.path.getsize(OUT) // 1024, 'KB')


if __name__ == '__main__':
    build(*parse(download()))

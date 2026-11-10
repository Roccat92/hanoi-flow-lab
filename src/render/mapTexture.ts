import type { MapData } from '../engine/types';
import type { Network, Link } from '../engine/network';

/**
 * Rasterises the real OSM network into crisp pixel art. The same painter draws the whole map at
 * 1 px/m (overview) and, when zoomed in, 128 m tiles at 6 px/m with sidewalks, kerbs, lane dashes,
 * double centre lines, stop lines, zebras (OSM crossings + signal approaches), turn arrows from the
 * real movements, bus stop boxes, street trees and building shading. Colours are snapped to a palette.
 */
export const PX = 1;
export const TILE = 128, TILE_PX = 6;

const DAY = { ground: '#c9c2a6', ground2: '#bdb596', bld: ['#b5654b', '#a0533f', '#c98b5c', '#8f8a7e', '#d6c7a1', '#7d6f63'], bldShade: '#5b4636', roof: '#e0d3b0', sidewalk: '#b3ad9c', kerb: '#8a8577', road: '#4a4a52', road2: '#55555d', alley: '#8d8a82', mark: '#e8e4d0', center: '#e3b53c', cross: '#efece0', tree: '#5d8a3e', tree2: '#46702f', bus: '#f2c94c', shelter: '#3b6fd8' };
const NIGHT = { ground: '#1b1d2b', ground2: '#171926', bld: ['#2a2635', '#262233', '#2f2a3a', '#24232c', '#302b38', '#221f2a'], bldShade: '#111018', roof: '#3a3446', sidewalk: '#2c2c38', kerb: '#22222c', road: '#15151c', road2: '#1a1a22', alley: '#2a2a30', mark: '#6e6b60', center: '#7a6326', cross: '#77746a', tree: '#1d2b1d', tree2: '#172317', bus: '#7a6326', shelter: '#22335c' };

type Pal = typeof DAY;
interface Box { minX: number; minY: number; maxX: number; maxY: number }

const bboxCache = new WeakMap<Network, Box[]>();
function linkBoxes(net: Network) {
  let b = bboxCache.get(net);
  if (!b) {
    b = net.links.map(L => { let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; for (const p of L.pts) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); } return { minX: minX - 20, minY: minY - 20, maxX: maxX + 20, maxY: maxY + 20 }; });
    bboxCache.set(net, b);
  }
  return b;
}
const hit = (a: Box, b: Box) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

export function mapBounds(net: Network) {
  const b = net.bounds; const pad = 40;
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

/** whole map at 1 px/m */
export function buildMapCanvas(data: MapData, net: Network, night: boolean, _light: boolean) {
  const B = mapBounds(net);
  const W = Math.ceil(B.maxX - B.minX), H = Math.ceil(B.maxY - B.minY);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  paint(cv.getContext('2d')!, data, net, night, 1, B.minX, B.minY, W, H, false);
  return { canvas: cv, minX: B.minX, minY: B.minY, W, H };
}
/** one detail tile (tx, ty in tile units) */
export function buildTile(data: MapData, net: Network, night: boolean, tx: number, ty: number) {
  const n = TILE * TILE_PX; const cv = document.createElement('canvas'); cv.width = n; cv.height = n;
  paint(cv.getContext('2d')!, data, net, night, TILE_PX, tx * TILE, ty * TILE, n, n, true);
  return cv;
}

function paint(g: CanvasRenderingContext2D, data: MapData, net: Network, night: boolean, px: number, ox: number, oy: number, W: number, H: number, detail: boolean) {
  const P: Pal = night ? NIGHT : DAY;
  const view: Box = { minX: ox, minY: oy, maxX: ox + W / px, maxY: oy + H / px };
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = P.ground; g.fillRect(0, 0, W, H);
  // dithered ground (world-anchored so tiles match)
  g.fillStyle = P.ground2;
  const cell = 3; for (let wy = Math.floor(view.minY / cell) * cell; wy < view.maxY; wy += cell) for (let wx = Math.floor(view.minX / cell) * cell; wx < view.maxX; wx += cell) { const h = hash(wx, wy); if (h % 10 === 0) g.fillRect((wx - ox) * px, (wy - oy) * px, Math.max(1, px * 0.5), Math.max(1, px * 0.5)); }
  g.setTransform(px, 0, 0, px, -ox * px, -oy * px);
  const u = 1 / px; // one screen pixel in metres
  // buildings
  for (const b of data.buildings) {
    const p = b.p; if (p.length < 6) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < p.length; i += 2) { minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]); minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]); }
    if (!hit({ minX, minY, maxX, maxY }, view)) continue;
    let h = 0; for (let i = 0; i < p.length; i++) h = (h * 31 + Math.round(p[i])) | 0;
    poly(g, p, 1, 1.6); g.fillStyle = P.bldShade; g.fill();
    poly(g, p, 0, 0); g.fillStyle = P.bld[Math.abs(h) % P.bld.length]; g.fill();
    if (detail) { g.strokeStyle = P.bldShade; g.lineWidth = 0.25; g.stroke(); if (Math.abs(h) % 4 === 0) { g.fillStyle = P.roof; g.fillRect((minX + maxX) / 2 - 1, (minY + maxY) / 2 - 1, 2, 2); } }
    if (night && Math.abs(h) % 3 === 0) { g.fillStyle = Math.abs(h) % 2 ? '#f2c95b' : '#e8a94a'; for (let k = 0; k < 3; k++) g.fillRect(p[0] + 2 + k * 3, p[1] + 2, Math.max(u, 0.8), Math.max(u, 0.8)); }
  }
  const boxes = linkBoxes(net);
  const links = net.links.filter(L => hit(boxes[L.id], view));
  const tmp = { x: 0, y: 0, h: 0 };
  const strip = (L: Link, off: number, w: number) => { offPath(g, L.pts, off); g.lineWidth = w; g.stroke(); };
  const kerbOff = (L: Link) => L.twoWay ? L.width + 0.6 : L.width / 2; // right edge
  const centre = (L: Link) => L.twoWay ? (L.width + 0.6) / 2 : 0;
  g.lineCap = 'round'; g.lineJoin = 'round';
  // sidewalks (main roads), then asphalt, then junction boxes
  for (const L of links) {
    if (L.alley) continue;
    g.strokeStyle = P.kerb; strip(L, kerbOff(L) + 1.3, 2.9);
    g.strokeStyle = P.sidewalk; strip(L, kerbOff(L) + 1.4, 2.5);
    if (!L.twoWay && L.twin < 0) { g.strokeStyle = P.kerb; strip(L, -L.width / 2 - 1.3, 2.9); g.strokeStyle = P.sidewalk; strip(L, -L.width / 2 - 1.4, 2.5); }
  }
  for (const L of [...links].sort((a, b) => +b.alley - +a.alley)) {
    g.strokeStyle = L.alley ? P.alley : L.rank >= 4 ? P.road : P.road2;
    strip(L, centre(L), L.twoWay ? L.width + 0.6 : L.width);
  }
  for (const n of net.nodes) {
    if (n.deg < 3 || n.x < view.minX - 25 || n.x > view.maxX + 25 || n.y < view.minY - 25 || n.y > view.maxY + 25) continue;
    const ls = [...n.inLinks, ...n.outLinks].map(l => net.links[l]); const main = ls.some(L => !L.alley);
    g.fillStyle = main ? P.road2 : P.alley; g.beginPath(); g.arc(n.x, n.y, Math.max(2, n.radius * 0.9), 0, Math.PI * 2); g.fill();
  }
  // street trees along main-road sidewalks
  if (detail) for (const L of links) {
    if (L.alley || L.rank < 2) continue;
    for (let s = L.startS + 4; s < L.stopS - 4; s += 9) {
      if (hash(Math.round(s), L.id) % 3 === 0) continue;
      net.pointAt(L, s, kerbOff(L) + 1.6, tmp);
      g.fillStyle = P.tree2; g.beginPath(); g.arc(tmp.x + 0.3, tmp.y + 0.3, 1.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = P.tree; g.beginPath(); g.arc(tmp.x, tmp.y, 1.3, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#7fb04f'; g.fillRect(tmp.x - 0.6, tmp.y - 0.6, 0.5, 0.5);
    }
  } else {
    let seed = 99; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    g.fillStyle = P.tree; for (let i = 0; i < (W * H) / 1400; i++) { const x = view.minX + rnd() * (view.maxX - view.minX), y = view.minY + rnd() * (view.maxY - view.minY); g.fillRect(x, y, 2, 2); }
  }
  // markings
  g.lineCap = 'butt';
  const seg = (L: Link, s0: number, s1: number, off: number, w: number) => {
    g.beginPath(); net.pointAt(L, s0, off, tmp); g.moveTo(tmp.x, tmp.y);
    for (let s = s0 + 2; s < s1; s += 2) { net.pointAt(L, s, off, tmp); g.lineTo(tmp.x, tmp.y); }
    net.pointAt(L, s1, off, tmp); g.lineTo(tmp.x, tmp.y); g.lineWidth = w; g.stroke();
  };
  for (const L of links) {
    if (L.alley) continue;
    const a = L.startS + 1, b = L.stopS - 0.5; if (b - a < 2) continue;
    if (L.twoWay) { g.strokeStyle = P.center; seg(L, a, b, detail ? 0.15 : 0.3, detail ? 0.15 : 1); }
    if (detail) {
      g.strokeStyle = P.mark;
      for (let k = 1; k < L.lanes; k++) { const off = net.offsetOf(L, (L.width * k) / L.lanes); for (let s = a; s < b - 12; s += 9) seg(L, s, Math.min(s + 3, b), off, 0.15); }
      // edge line
      seg(L, a, b, net.offsetOf(L, L.width - 0.25), 0.12);
    } else if (L.lanes > 1) {
      g.strokeStyle = P.mark;
      for (let k = 1; k < L.lanes; k++) { const off = net.offsetOf(L, (L.width * k) / L.lanes); for (let s = a; s < b - 12; s += 8) seg(L, s, Math.min(s + 3, b), off, 1); }
    }
  }
  // stop lines + turn arrows on signal approaches
  g.fillStyle = P.cross; g.strokeStyle = P.cross;
  for (const L of links) {
    const n = net.nodes[L.to]; if (!n.signal || L.alley || !L.outMoves.length) continue;
    g.lineWidth = detail ? 0.4 : 1;
    net.pointAt(L, L.stopS, net.offsetOf(L, 0), tmp); const x0 = tmp.x, y0 = tmp.y;
    net.pointAt(L, L.stopS, net.offsetOf(L, L.width), tmp); g.beginPath(); g.moveTo(x0, y0); g.lineTo(tmp.x, tmp.y); g.stroke();
    if (detail) {
      const turns = new Set(L.outMoves.map(m => net.moves[m].turn));
      for (let k = 0; k < L.lanes; k++) {
        const lat = (L.width * (k + 0.5)) / L.lanes; const set: string[] = [];
        if (k === 0 && turns.has('L')) set.push('L'); if (k === L.lanes - 1 && turns.has('R')) set.push('R'); if (turns.has('T') || !set.length) set.push('T');
        arrow(g, net, L, Math.max(L.startS + 2, L.stopS - 9), net.offsetOf(L, lat), set, P.mark, tmp);
      }
    }
  }
  // zebra crossings: signal approaches and OSM highway=crossing
  const zebra = (L: Link, s: number, span0: number, span1: number) => {
    g.fillStyle = P.cross;
    const step = detail ? 1.0 : 1.5, wid = detail ? 0.5 : 1;
    for (let o = span0; o < span1; o += step) {
      net.pointAt(L, s - 1.5, o, tmp); const ax = tmp.x, ay = tmp.y; net.pointAt(L, s + 1.5, o, tmp);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(tmp.x, tmp.y); g.lineWidth = wid; g.strokeStyle = P.cross; g.stroke();
    }
  };
  const span = (L: Link): [number, number] => L.twoWay ? [-(L.twin >= 0 ? net.links[L.twin].width : L.width) - 0.3, L.width + 0.3] : [-L.width / 2, L.width / 2];
  for (const L of links) {
    const n = net.nodes[L.to]; if (!n.signal || L.alley || !L.outMoves.length) continue;
    const s = Math.min(L.len - 0.3, L.stopS + 2.0); const [a, b] = span(L); zebra(L, s, a + 0.3, b);
  }
  for (const c of data.crossings ?? []) {
    const L = net.links[c.link]; if (!L || !hit(boxes[L.id], view) || L.alley) continue;
    if (L.twin >= 0 && L.twin < L.id && (data.crossings ?? []).some(o => o.link === L.twin && o.osm === c.osm)) continue;
    const [a, b] = span(L); zebra(L, c.s, a + 0.3, b);
  }
  // bus stops: yellow kerb box + shelter on the sidewalk
  for (const bs of data.busStops ?? []) {
    const L = net.links[bs.link]; if (!L || !hit(boxes[L.id], view)) continue;
    g.strokeStyle = P.bus; g.lineWidth = detail ? 0.25 : 1;
    const k = net.offsetOf(L, L.width - 0.2), k2 = net.offsetOf(L, L.width - 2.8);
    seg(L, bs.s - 12, bs.s + 2, k, detail ? 0.25 : 1); if (detail) { seg(L, bs.s - 12, bs.s + 2, k2, 0.25); for (let s = bs.s - 12; s < bs.s + 2; s += 2) { net.pointAt(L, s, k, tmp); const ax = tmp.x, ay = tmp.y; net.pointAt(L, s + 1.5, k2, tmp); g.beginPath(); g.moveTo(ax, ay); g.lineTo(tmp.x, tmp.y); g.stroke(); } }
    net.pointAt(L, bs.s - 5, kerbOff(L) + 1.6, tmp);
    g.fillStyle = P.shelter; g.fillRect(tmp.x - 1.5, tmp.y - 1.5, 3, 3); g.fillStyle = P.bus; g.fillRect(tmp.x - 0.5, tmp.y - 0.5, 1, 1);
  }
  // street lamps at night
  if (night) {
    for (const L of links) {
      if (L.alley || L.cls === 'residential') continue;
      for (let s = L.startS + 5; s < L.stopS; s += 35) {
        net.pointAt(L, s, kerbOff(L) + 0.8, tmp);
        const gr = g.createRadialGradient(tmp.x, tmp.y, 0, tmp.x, tmp.y, 9);
        gr.addColorStop(0, 'rgba(255,200,110,0.35)'); gr.addColorStop(1, 'rgba(255,200,110,0)');
        g.fillStyle = gr; g.fillRect(tmp.x - 9, tmp.y - 9, 18, 18);
        g.fillStyle = '#ffe2a0'; g.fillRect(tmp.x - 0.4, tmp.y - 0.4, 0.8, 0.8);
      }
    }
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  quantize(g, W, H, night);
}

function arrow(g: CanvasRenderingContext2D, net: Network, L: Link, s: number, off: number, set: string[], col: string, tmp: { x: number; y: number; h: number }) {
  net.pointAt(L, s, off, tmp); const { x, y, h } = tmp;
  g.save(); g.translate(x, y); g.rotate(h); g.fillStyle = col; g.strokeStyle = col; g.lineWidth = 0.3;
  // shaft along +x (travel direction)
  g.beginPath(); g.moveTo(-2.5, 0); g.lineTo(0.6, 0); g.stroke();
  for (const t of set) {
    if (t === 'T') { g.beginPath(); g.moveTo(1.8, 0); g.lineTo(0.4, -0.6); g.lineTo(0.4, 0.6); g.closePath(); g.fill(); g.beginPath(); g.moveTo(0.4, 0); g.lineTo(0.6, 0); g.stroke(); }
    else { const sg = t === 'R' ? 1 : -1; g.beginPath(); g.moveTo(0.4, 0); g.lineTo(0.4, sg * 1.0); g.stroke(); g.beginPath(); g.moveTo(0.4, sg * 2.0); g.lineTo(-0.3, sg * 0.9); g.lineTo(1.1, sg * 0.9); g.closePath(); g.fill(); }
  }
  g.restore();
}
function poly(g: CanvasRenderingContext2D, p: number[], dx: number, dy: number) { g.beginPath(); g.moveTo(p[0] + dx, p[1] + dy); for (let i = 2; i < p.length; i += 2) g.lineTo(p[i] + dx, p[i + 1] + dy); g.closePath(); }
function offPath(g: CanvasRenderingContext2D, pts: [number, number][], off: number) {
  g.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1;
    const x = pts[i][0] - (dy / d) * off, y = pts[i][1] + (dx / d) * off;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
}
function hash(a: number, b: number) { let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0; h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0; return h ^ (h >>> 15); }

/** snap anti-aliased edge pixels to the nearest palette colour (crisp pixel-art) */
function quantize(g: CanvasRenderingContext2D, W: number, H: number, night: boolean) {
  const P = night ? NIGHT : DAY;
  const hex = [P.ground, P.ground2, ...P.bld, P.bldShade, P.roof, P.sidewalk, P.kerb, P.road, P.road2, P.alley, P.mark, P.center, P.cross, P.tree, P.tree2, '#7fb04f', P.bus, P.shelter, ...(night ? ['#f2c95b', '#e8a94a', '#ffe2a0', '#3a3022', '#5a4628', '#2b2620'] : [])];
  const pal = hex.map(h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
  const img = g.getImageData(0, 0, W, H); const d = img.data;
  const cache = new Map<number, number>();
  for (let i = 0; i < d.length; i += 4) {
    const key = ((d[i] >> 2) << 12) | ((d[i + 1] >> 2) << 6) | (d[i + 2] >> 2);
    let best = cache.get(key);
    if (best === undefined) {
      let bd = Infinity; best = 0;
      for (let k = 0; k < pal.length; k++) { const p = pal[k]; const e = (p[0] - d[i]) ** 2 + (p[1] - d[i + 1]) ** 2 + (p[2] - d[i + 2]) ** 2; if (e < bd) { bd = e; best = k; } }
      if (night && bd > 1800) best = -1; // keep lamp glow gradients
      cache.set(key, best);
    }
    if (best >= 0) { const p = pal[best]; d[i] = p[0]; d[i + 1] = p[1]; d[i + 2] = p[2]; }
  }
  g.putImageData(img, 0, 0);
}

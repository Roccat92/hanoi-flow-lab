import type { MapData } from '../engine/types';

/** Rasterises the real OSM map into a pixel-art canvas at PX pixels per metre, then snaps colours to a palette. */
export const PX = 1; // 1 px = 1 m

const DAY = { ground: '#c9c2a6', ground2: '#bdb596', bld: ['#b5654b', '#a0533f', '#c98b5c', '#8f8a7e', '#d6c7a1', '#7d6f63'], bldShade: '#5b4636', sidewalk: '#a39e8f', road: '#4a4a52', road2: '#55555d', mark: '#e8e4d0', center: '#e3b53c', cross: '#e8e4d0', tree: '#5d8a3e', tree2: '#46702f' };
const NIGHT = { ground: '#1b1d2b', ground2: '#171926', bld: ['#2a2635', '#262233', '#2f2a3a', '#24232c', '#302b38', '#221f2a'], bldShade: '#111018', sidewalk: '#2c2c38', road: '#15151c', road2: '#1a1a22', mark: '#6e6b60', center: '#7a6326', cross: '#6e6b60', tree: '#1d2b1d', tree2: '#172317' };

export function buildMapCanvas(data: MapData, night: boolean, light: boolean) {
  const P = night ? NIGHT : DAY;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of data.nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
  const pad = 40; minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const W = Math.ceil((maxX - minX) * PX), H = Math.ceil((maxY - minY) * PX);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  const X = (x: number) => Math.round((x - minX) * PX), Y = (y: number) => Math.round((y - minY) * PX);
  g.fillStyle = P.ground; g.fillRect(0, 0, W, H);
  // dithered ground texture
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  g.fillStyle = P.ground2;
  for (let i = 0; i < (W * H) / 30; i++) g.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * H), 1, 1);
  // buildings with pixel shading
  if (!light || true) {
    for (const b of data.buildings) {
      const p = b.p; if (p.length < 6) continue;
      let h = 0; for (let i = 0; i < p.length; i++) h = (h * 31 + Math.round(p[i])) | 0;
      g.beginPath(); g.moveTo(X(p[0]) + 1, Y(p[1]) + 2);
      for (let i = 2; i < p.length; i += 2) g.lineTo(X(p[i]) + 1, Y(p[i + 1]) + 2);
      g.closePath(); g.fillStyle = P.bldShade; g.fill();
      g.beginPath(); g.moveTo(X(p[0]), Y(p[1]));
      for (let i = 2; i < p.length; i += 2) g.lineTo(X(p[i]), Y(p[i + 1]));
      g.closePath(); g.fillStyle = P.bld[Math.abs(h) % P.bld.length]; g.fill();
      if (night && Math.abs(h) % 3 === 0) { // lit windows
        g.fillStyle = Math.abs(h) % 2 ? '#f2c95b' : '#e8a94a';
        const cx = X(p[0]), cy = Y(p[1]);
        for (let k = 0; k < 3; k++) g.fillRect(cx + 2 + k * 3, cy + 2, 1, 1);
      }
    }
  }
  // trees scattered on empty ground (deterministic)
  seed = 99;
  g.fillStyle = P.tree;
  for (let i = 0; i < (W * H) / 900; i++) { const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H); g.fillRect(x, y, 2, 2); g.fillStyle = P.tree2; g.fillRect(x + 1, y + 1, 1, 1); g.fillStyle = P.tree; }
  // roads: sidewalk, asphalt, markings
  const two = new Set<string>(); for (const l of data.links) two.add(l.from + '_' + l.to + '_' + l.way);
  const drawn = new Set<string>();
  const roadW = (l: any) => { const tw = two.has(l.to + '_' + l.from + '_' + l.way); return { tw, w: Math.max(l.lanes * 3.2, 3.6) * (tw ? 2 : 1) + (tw ? 0.6 : 0) }; };
  const path = (pts: number[][], off: number) => {
    g.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1;
      const x = pts[i][0] - (dy / d) * off, y = pts[i][1] + (dx / d) * off;
      if (i === 0) g.moveTo(X(x), Y(y)); else g.lineTo(X(x), Y(y));
    }
  };
  g.lineCap = 'round'; g.lineJoin = 'round';
  const roadsOrdered = [...data.links].sort((a, b) => a.lanes - b.lanes);
  for (const pass of [0, 1]) for (const l of roadsOrdered) {
    const { tw, w } = roadW(l);
    const key = tw ? [Math.min(l.from, l.to), Math.max(l.from, l.to), l.way].join('_') : 'o' + l.id;
    if (pass === 1 && drawn.has(key)) continue;
    const off = tw ? (Math.max(l.lanes * 3.2, 3.6) + 0.6) / 2 : 0; // two-way link polyline is the centre line
    path(l.pts, tw ? 0 : off * 0);
    if (pass === 0) { g.strokeStyle = P.sidewalk; g.lineWidth = (w + 3) * PX; g.stroke(); }
    else { g.strokeStyle = l.cls === 'primary' || l.cls === 'trunk' ? P.road : P.road2; g.lineWidth = w * PX; g.stroke(); drawn.add(key); }
  }
  // lane markings
  g.lineCap = 'butt';
  for (const l of data.links) {
    const { tw } = roadW(l); const lw = Math.max(l.lanes * 3.2, 3.6) / l.lanes;
    if (tw && l.from < l.to) { path(l.pts, 0); g.setLineDash([]); g.strokeStyle = P.center; g.lineWidth = 1; g.stroke(); }
    for (let k = 1; k < l.lanes; k++) {
      const off = tw ? 0.3 + lw * k : -Math.max(l.lanes * 3.2, 3.6) / 2 + lw * k;
      path(l.pts, off); g.setLineDash([3 * PX, 4 * PX]); g.strokeStyle = P.mark; g.lineWidth = 1; g.stroke();
    }
  }
  g.setLineDash([]);
  // zebra crossings at signalised nodes
  g.fillStyle = P.cross;
  for (const n of data.nodes) {
    if (!n.signal) continue;
    for (const l of data.links) {
      if (l.to !== n.id) continue;
      const pts = l.pts; const a = pts[pts.length - 2], b = pts[pts.length - 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1; const ux = dx / d, uy = dy / d;
      const back = Math.min(16, l.len * 0.3);
      const w = Math.max(l.lanes * 3.2, 3.6);
      for (let k = 0; k < w; k += 1.5) {
        const off = roadW(l).tw ? k + 0.3 : k - w / 2;
        const cx = b[0] - ux * back - uy * off, cy = b[1] - uy * back + ux * off;
        g.fillRect(X(cx - ux * 1.5), Y(cy - uy * 1.5), 1, 1); g.fillRect(X(cx), Y(cy), 1, 1); g.fillRect(X(cx + ux * 1.5), Y(cy + uy * 1.5), 1, 1);
      }
    }
  }
  // street lamps glow at night
  if (night) {
    seed = 5;
    for (const l of data.links) {
      if (l.cls === 'residential') continue;
      for (let s = 0; s < l.pts.length - 1; s++) {
        const a = l.pts[s], b = l.pts[s + 1]; const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let u = 0; u < d; u += 35) {
          const x = a[0] + (b[0] - a[0]) * u / d, y = a[1] + (b[1] - a[1]) * u / d;
          const gr = g.createRadialGradient(X(x), Y(y), 0, X(x), Y(y), 9);
          gr.addColorStop(0, 'rgba(255,200,110,0.35)'); gr.addColorStop(1, 'rgba(255,200,110,0)');
          g.fillStyle = gr; g.fillRect(X(x) - 9, Y(y) - 9, 18, 18);
          g.fillStyle = '#ffe2a0'; g.fillRect(X(x), Y(y), 1, 1);
        }
      }
    }
  }
  quantize(g, W, H, night);
  return { canvas: cv, minX, minY, W, H };
}

/** snap anti-aliased edge pixels to the nearest colour already present in a small palette (crisp pixel-art) */
function quantize(g: CanvasRenderingContext2D, W: number, H: number, night: boolean) {
  const P = night ? NIGHT : DAY;
  const hex = [P.ground, P.ground2, ...P.bld, P.bldShade, P.sidewalk, P.road, P.road2, P.mark, P.center, P.tree, P.tree2, ...(night ? ['#f2c95b', '#e8a94a', '#ffe2a0', '#3a3022', '#5a4628', '#2b2620'] : [])];
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

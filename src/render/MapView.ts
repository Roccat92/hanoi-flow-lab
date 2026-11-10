import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { MapData, DecisionLog, Edits } from '../engine/types';
import { Network } from '../engine/network';
import { buildMapCanvas, buildTile, TILE, TILE_PX } from './mapTexture';
import { makeTextures, type VehTextures } from './sprites';
import { VSTRIDE, PSTRIDE, type Snapshot } from '../sim/protocol';

export interface Layers { heat: boolean; density: boolean; signals: boolean; ai: boolean; night: boolean; light: boolean; editor?: boolean; zones?: { node: number; w: number }[] }
export type PickKind = 'veh' | 'node' | 'link';
const VDIM = [[0.8, 1.9], [1.8, 4.5], [2.5, 11], [2.3, 7.5], [0.6, 1.75], [1.75, 4.4], [1.95, 5.2], [1.9, 4.8]];

export class MapView {
  app = new Application(); world = new Container(); mapSprite = new Sprite(); overlay = new Graphics(); sigG = new Graphics();
  vehLayer = new Container(); glowLayer = new Container(); labelLayer = new Container(); selG = new Graphics();
  tileLayer = new Container(); pedLayer = new Container(); fxG = new Graphics(); editG = new Graphics(); crashLayer = new Container();
  peds: Sprite[] = []; tiles = new Map<string, Sprite>(); crashSprites: Sprite[] = []; crashTexts: Text[] = []; pickMode: 'auto' | 'node' | 'link' = 'auto'; edits: Edits = {};
  tex!: VehTextures; sprites: Sprite[] = []; glows: Sprite[] = []; labels: Text[] = [];
  net: Network; layers: Layers; mapCache = new Map<string, Texture>(); origin = { x: 0, y: 0 };
  lastSnap: Snapshot | null = null; decisions: DecisionLog[] = []; selected: { kind: PickKind; id: number } | null = null;
  onPick?: (kind: PickKind, id: number) => void; ready = false; private dragging = false; private moved = 0; private last = { x: 0, y: 0 };
  fps = 0; private frames = 0; private fpsT = performance.now();

  constructor(public data: MapData, layers: Layers, edits: Edits = {}) { this.edits = edits; this.net = new Network(data, edits); this.layers = { ...layers }; }
  /** editor changed the network: rebuild geometry, map raster and detail tiles */
  setEdits(e: Edits) {
    this.edits = e; this.net = new Network(this.data, e);
    for (const t of this.mapCache.values()) t.destroy(true); this.mapCache.clear();
    for (const sp of this.tiles.values()) { sp.texture.destroy(true); sp.destroy(); } this.tiles.clear();
    if (this.ready) { this.setMap(); this.drawOverlay(); }
  }

  async mount(el: HTMLElement) {
    await this.app.init({ resizeTo: el, background: '#c9c2a6', antialias: false, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true, preference: 'webgl' });
    el.appendChild(this.app.canvas);
    this.app.canvas.style.imageRendering = 'pixelated';
    this.tex = makeTextures();
    this.world.addChild(this.mapSprite, this.tileLayer, this.overlay, this.editG, this.sigG, this.pedLayer, this.glowLayer, this.vehLayer, this.fxG, this.crashLayer, this.selG, this.labelLayer);
    this.app.stage.addChild(this.world);
    this.setMap();
    this.fit();
    this.bindInput();
    this.app.ticker.add(() => this.frame());
    this.ready = true;
    (window as any).__views = [...((window as any).__views ?? []).filter((x: MapView) => x.ready), this];
    // used by the screenshot script: screen position of the busiest signalised junction
    (window as any).__pickSignal = () => {
      const r = this.app.canvas.getBoundingClientRect(); let best: any = null, bs = -1;
      for (const n of this.net.nodes) { if (!n.signal) continue; const sx = r.left + this.world.x + n.x * this.world.scale.x, sy = r.top + this.world.y + n.y * this.world.scale.y; if (sx < r.left + 50 || sy < r.top + 50 || sx > r.right - 50 || sy > r.bottom - 50) continue; const sc = n.inLinks.length * 10 - Math.hypot(sx - (r.left + r.width / 2), sy - (r.top + r.height / 2)) / 20; if (sc > bs) { bs = sc; best = { x: sx, y: sy }; } }
      return best;
    };
  }
  destroy() { try { this.app.destroy(true, { children: true }); } catch { /* ignore */ } }

  private setMap() {
    const key = (this.layers.night ? 'n' : 'd');
    let t = this.mapCache.get(key);
    for (const sp of this.tiles.values()) { sp.texture.destroy(true); sp.destroy(); } this.tiles.clear();
    const built = buildMapCanvas(this.data, this.net, this.layers.night, this.layers.light);
    if (!t) { t = Texture.from(built.canvas); t.source.scaleMode = 'nearest'; this.mapCache.set(key, t); }
    this.origin = { x: built.minX, y: built.minY };
    this.mapSprite.texture = t; this.mapSprite.position.set(built.minX, built.minY); this.mapSprite.scale.set(1);
    this.app.renderer.background.color = this.layers.night ? 0x1b1d2b : 0xc9c2a6;
  }
  setLayers(l: Layers) {
    const nightChanged = l.night !== this.layers.night;
    this.pickMode = l.editor ? this.pickMode : 'auto';
    this.layers = { ...l };
    if (nightChanged && this.ready) this.setMap();
    if (this.ready) { this.drawOverlay(); this.drawEditor(); }
  }
  fit() {
    const b = this.net.bounds; const w = this.app.screen.width, h = this.app.screen.height;
    const z = Math.min(w / (b.maxX - b.minX + 80), h / (b.maxY - b.minY + 80));
    this.world.scale.set(z); this.world.position.set(w / 2 - ((b.minX + b.maxX) / 2) * z, h / 2 - ((b.minY + b.maxY) / 2) * z);
  }
  focus(x: number, y: number, z = 4) { const w = this.app.screen.width, h = this.app.screen.height; this.world.scale.set(z); this.world.position.set(w / 2 - x * z, h / 2 - y * z); }

  private bindInput() {
    const c = this.app.canvas;
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const r = c.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
      const z0 = this.world.scale.x; const z = Math.min(12, Math.max(0.15, z0 * Math.pow(1.0015, -e.deltaY)));
      const wx = (mx - this.world.x) / z0, wy = (my - this.world.y) / z0;
      this.world.scale.set(z); this.world.position.set(mx - wx * z, my - wy * z);
    }, { passive: false });
    c.addEventListener('pointerdown', e => { this.dragging = true; this.moved = 0; this.last = { x: e.clientX, y: e.clientY }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => {
      if (!this.dragging) return;
      const dx = e.clientX - this.last.x, dy = e.clientY - this.last.y; this.moved += Math.abs(dx) + Math.abs(dy);
      this.world.position.set(this.world.x + dx, this.world.y + dy); this.last = { x: e.clientX, y: e.clientY };
    });
    c.addEventListener('pointerup', e => {
      this.dragging = false;
      if (this.moved < 5) { const r = c.getBoundingClientRect(); this.pick((e.clientX - r.left - this.world.x) / this.world.scale.x, (e.clientY - r.top - this.world.y) / this.world.scale.y); }
    });
  }
  private pick(wx: number, wy: number) {
    const s = this.lastSnap; const z = this.world.scale.x;
    if (s && this.pickMode === 'auto') {
      let best = -1, bd = Math.max(2.5, 10 / z);
      for (let i = 0; i < s.n; i++) { const d = Math.hypot(s.veh[i * VSTRIDE] - wx, s.veh[i * VSTRIDE + 1] - wy); if (d < bd) { bd = d; best = s.veh[i * VSTRIDE + 5]; } }
      if (best >= 0) { this.selected = { kind: 'veh', id: best }; this.onPick?.('veh', best); return; }
    }
    if (this.pickMode === 'link') {
      let bl = -1, bd = Math.max(12, 14 / z); const p = { x: 0, y: 0, h: 0 };
      for (const L of this.net.links) {
        for (let s = 0; s <= L.len; s += 3) { this.net.pointAt(L, s, this.net.offsetOf(L, L.width / 2), p); const d = Math.hypot(p.x - wx, p.y - wy); if (d < bd) { bd = d; bl = L.id; } }
      }
      if (bl >= 0) { this.selected = { kind: 'link', id: bl }; this.onPick?.('link', bl); }
      return;
    }
    let bn = -1, bd = Math.max(30, 30 / z);
    for (const n of this.net.nodes) { const d = Math.hypot(n.x - wx, n.y - wy); const w = n.signal ? d * 0.6 : d; if (w < bd && n.deg >= 2) { bd = w; bn = n.id; } }
    if (bn >= 0) { this.selected = { kind: 'node', id: bn }; this.onPick?.('node', bn); }
  }

  update(s: Snapshot) {
    this.lastSnap = s;
    if (s.decisions) { this.decisions.push(...s.decisions); if (this.decisions.length > 300) this.decisions.splice(0, this.decisions.length - 300); }
    if (s.linkSpeed) { this.linkSpeed = s.linkSpeed; this.linkOcc = s.linkOcc!; this.incident = s.incident ?? null; this.drawOverlay(); }
    this.drawSignals(s);
    this.drawVehicles(s);
    this.drawPeds(s);
    this.drawCrashes(s);
    this.drawLabels(s.t);
  }
  linkSpeed: Float32Array | null = null; linkOcc: Float32Array | null = null; incident: Snapshot['incident'] = null;

  private drawOverlay() {
    const g = this.overlay; g.clear();
    const L = this.layers;
    if ((L.heat || L.density) && this.linkSpeed) {
      for (const l of this.net.links) {
        let col: number, a = 0.75;
        if (L.heat) { const r = this.linkSpeed[l.id]; col = r > 0.75 ? 0x2ecc71 : r > 0.5 ? 0xb8e04a : r > 0.3 ? 0xf1c40f : r > 0.15 ? 0xe67e22 : 0xe74c3c; }
        else { const o = this.linkOcc![l.id]; if (o < 0.03) continue; col = o > 0.8 ? 0x8e2de2 : o > 0.5 ? 0xc0392b : o > 0.25 ? 0xe67e22 : 0x3498db; a = 0.4 + Math.min(0.5, o * 0.5); }
        const off = l.twoWay ? l.width / 2 + 0.3 : 0;
        const pts = l.pts;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
          const dx = q[0] - o[0], dy = q[1] - o[1], d = Math.hypot(dx, dy) || 1;
          const x = p[0] - dy / d * off, y = p[1] + dx / d * off;
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke({ width: Math.max(2.4, l.width * 0.7), color: col, alpha: a, cap: 'butt' });
      }
    }
    if (this.incident?.on) {
      const Lk = this.net.links[this.incident.link]; const p = { x: 0, y: 0, h: 0 };
      this.net.pointAt(Lk, this.incident.s - 9, this.net.offsetOf(Lk, Lk.width * 0.33), p);
      g.circle(p.x, p.y, 14).stroke({ width: 2, color: 0xff3b30, alpha: 0.9 });
      g.poly([p.x, p.y - 7, p.x + 6, p.y + 5, p.x - 6, p.y + 5]).fill({ color: 0xff3b30 });
    }
  }

  private drawSignals(s: Snapshot) {
    const g = this.sigG; g.clear();
    if (!this.layers.signals) return;
    const p = { x: 0, y: 0, h: 0 };
    for (const sg of s.signals) {
      const n = this.net.nodes[sg.id];
      const byIn = new Map<number, string>();
      n.moves.forEach((mi, k) => { const c = sg.colors[k]; const m = this.net.moves[mi]; const prev = byIn.get(m.inL) ?? 'R'; const rank = (x: string) => 'RYgG'.indexOf(x); if (rank(c) > rank(prev)) byIn.set(m.inL, c); else if (!byIn.has(m.inL)) byIn.set(m.inL, c); });
      for (const [li, c] of byIn) {
        const L = this.net.links[li];
        this.net.pointAt(L, L.stopS, this.net.offsetOf(L, L.width + 0.8), p);
        const col = c === 'G' ? 0x2bff6a : c === 'g' ? 0xa8ff60 : c === 'Y' ? 0xffd23f : 0xff3b30;
        g.rect(p.x - 1.2, p.y - 1.2, 2.4, 2.4).fill({ color: 0x111111 });
        g.rect(p.x - 0.8, p.y - 0.8, 1.6, 1.6).fill({ color: col });
        if (this.layers.night) g.circle(p.x, p.y, 3).fill({ color: col, alpha: 0.25 });
        // stop line
        const a = { x: 0, y: 0, h: 0 }, b = { x: 0, y: 0, h: 0 };
        this.net.pointAt(L, L.stopS, this.net.offsetOf(L, 0), a); this.net.pointAt(L, L.stopS, this.net.offsetOf(L, L.width), b);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 0.6, color: c === 'R' || c === 'Y' ? 0xffffff : 0xdddddd, alpha: 0.8 });
      }
    }
  }

  private drawVehicles(s: Snapshot) {
    const z = this.world.scale.x; const tiny = z < 0.9; const night = this.layers.night && !this.layers.light;
    while (this.sprites.length < s.n) { const sp = new Sprite(); sp.anchor.set(0.5); this.vehLayer.addChild(sp); this.sprites.push(sp); }
    for (let i = 0; i < this.sprites.length; i++) this.sprites[i].visible = i < s.n;
    if (night) while (this.glows.length < s.n) { const gl = new Sprite(this.tex.glow); gl.anchor.set(0.5, 1); gl.blendMode = 'add'; this.glowLayer.addChild(gl); this.glows.push(gl); }
    for (let i = 0; i < this.glows.length; i++) this.glows[i].visible = night && i < s.n;
    const v = s.veh;
    for (let i = 0; i < s.n; i++) {
      const o = i * VSTRIDE; const type = v[o + 3] | 0; const id = v[o + 5] | 0; const sp = this.sprites[i];
      if (tiny) { // zoomed out: 1 pixel dots coloured by speed
        sp.texture = this.tex.dot; const r = v[o + 4];
        sp.tint = r > 0.6 ? 0x2ecc71 : r > 0.3 ? 0xf1c40f : r > 0.08 ? 0xe67e22 : 0xff3b30;
        sp.width = sp.height = Math.max(1.6, 2.2 / z); sp.rotation = 0;
      } else {
        const set = this.tex.byType[type] ?? this.tex.car;
        sp.texture = set[id % set.length]; sp.tint = 0xffffff;
        sp.width = VDIM[type][0]; sp.height = VDIM[type][1]; sp.rotation = v[o + 2] + Math.PI / 2;
      }
      sp.position.set(v[o], v[o + 1]);
      if (night) { const gl = this.glows[i]; gl.position.set(v[o] + Math.cos(v[o + 2]) * VDIM[type][1] / 2, v[o + 1] + Math.sin(v[o + 2]) * VDIM[type][1] / 2); gl.rotation = v[o + 2] + Math.PI / 2; const two = type === 0 || type === 4; gl.width = two ? 2.5 : 4; gl.height = two ? 5 : 9; gl.visible = type !== 4 || false; }
    }
    // honking (aggressive two-wheelers / taxis), red-light runners, fender-bender vehicles
    const fx = this.fxG; fx.clear();
    if (z >= 2.2) for (let i = 0; i < s.n; i++) {
      const o = i * VSTRIDE; const f = v[o + 6] | 0; if (!(f & 14)) continue;
      const x = v[o], y = v[o + 1], h = v[o + 2], L = VDIM[v[o + 3] | 0][1] / 2 + 0.4;
      const fxp = x + Math.cos(h) * L, fyp = y + Math.sin(h) * L;
      if (f & 2) { for (const r of [0.6, 1.1]) { fx.arc(fxp, fyp, r, h - 0.7, h + 0.7); fx.stroke({ width: 0.15, color: 0xffe14d, alpha: 0.95 }); } }
      if (f & 4) fx.circle(x, y, 1.4).stroke({ width: 0.2, color: 0xff3b30 });
      if (f & 8) fx.circle(x, y, 1.6).stroke({ width: 0.25, color: 0xff8c00 });
    }
    // selection ring
    this.selG.clear();
    if (this.selected?.kind === 'veh') {
      for (let i = 0; i < s.n; i++) if ((v[i * VSTRIDE + 5] | 0) === this.selected.id) { this.selG.circle(v[i * VSTRIDE], v[i * VSTRIDE + 1], Math.max(4, 8 / z)).stroke({ width: Math.max(0.6, 2 / z), color: 0x00e5ff }); break; }
    } else if (this.selected?.kind === 'node') {
      const n = this.net.nodes[this.selected.id]; this.selG.circle(n.x, n.y, n.radius + 10).stroke({ width: Math.max(0.8, 2 / z), color: 0x00e5ff });
    } else if (this.selected?.kind === 'link') {
      const L = this.net.links[this.selected.id]; const p = { x: 0, y: 0, h: 0 };
      for (let s = 0; s <= L.len; s += 2) { this.net.pointAt(L, s, this.net.offsetOf(L, L.width / 2), p); if (s === 0) this.selG.moveTo(p.x, p.y); else this.selG.lineTo(p.x, p.y); }
      this.selG.stroke({ width: Math.max(1, L.width * 0.5), color: 0x00e5ff, alpha: 0.6 });
    }
  }

  /** crisp high-resolution detail tiles when zoomed in close (built lazily, LRU-cached) */
  private updateTiles() {
    const z = this.world.scale.x; const on = z >= 2.2 && !this.layers.light;
    this.tileLayer.visible = on; if (!on) return;
    const w = this.app.screen.width, h = this.app.screen.height;
    const x0 = -this.world.x / z, y0 = -this.world.y / z, x1 = x0 + w / z, y1 = y0 + h / z;
    const nk = this.layers.night ? 'n' : 'd'; let built = 0;
    const want = new Set<string>();
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) {
      const key = nk + tx + '_' + ty; want.add(key);
      let sp = this.tiles.get(key);
      if (!sp) {
        if (built++ >= 2) continue; // spread tile rendering over frames
        const cv = buildTile(this.data, this.net, this.layers.night, tx, ty);
        const t = Texture.from(cv); t.source.scaleMode = 'nearest';
        sp = new Sprite(t); sp.position.set(tx * TILE, ty * TILE); sp.scale.set(1 / TILE_PX);
        this.tileLayer.addChild(sp); this.tiles.set(key, sp);
      } else { this.tiles.delete(key); this.tiles.set(key, sp); } // LRU touch
      sp.visible = true;
    }
    for (const [k, sp] of this.tiles) if (!want.has(k)) sp.visible = false;
    while (this.tiles.size > 36) { const [k, sp] = this.tiles.entries().next().value as [string, Sprite]; if (want.has(k)) break; this.tiles.delete(k); sp.texture.destroy(true); sp.destroy(); }
  }

  private drawPeds(s: Snapshot) {
    const z = this.world.scale.x; const n = s.np ?? 0; const show = z >= 1.2;
    while (this.peds.length < n) { const sp = new Sprite(); sp.anchor.set(0.5); this.pedLayer.addChild(sp); this.peds.push(sp); }
    for (let i = 0; i < this.peds.length; i++) this.peds[i].visible = show && i < n;
    if (!show || !s.peds) return;
    for (let i = 0; i < n; i++) {
      const o = i * PSTRIDE; const sp = this.peds[i];
      sp.texture = this.tex.ped[(s.peds[o + 2] | 0) % this.tex.ped.length];
      sp.width = 0.8; sp.height = 1.1; sp.position.set(s.peds[o], s.peds[o + 1]);
      // walking legs: tiny bob
      sp.rotation = s.peds[o + 3] ? Math.sin(s.t * 6 + i) * 0.25 : 0;
    }
  }

  /** modelled fender-benders: two drivers arguing next to their vehicles, onlookers, a warning bubble */
  private drawCrashes(s: Snapshot) {
    const cs = s.crashes ?? []; const z = this.world.scale.x;
    let k = 0, kt = 0;
    const spr = () => { let sp = this.crashSprites[k]; if (!sp) { sp = new Sprite(); sp.anchor.set(0.5); this.crashLayer.addChild(sp); this.crashSprites.push(sp); } sp.visible = true; k++; return sp; };
    for (const c of cs) {
      const nx = -Math.sin(c.h), ny = Math.cos(c.h); // right-hand normal
      const side = c.side; const close = z >= 1.5;
      if (close) {
        // two drivers facing each other, gesturing
        for (let d = 0; d < 2; d++) {
          const sp = spr(); sp.texture = this.tex.ped[d === 0 ? 0 : 1]; sp.width = 0.6; sp.height = 0.8;
          const wob = Math.sin(s.t * 8 + d * 2) * 0.12;
          sp.position.set(c.x + nx * side * 1.6 + Math.cos(c.h) * (d ? 0.5 : -0.5) + wob, c.y + ny * side * 1.6 + Math.sin(c.h) * (d ? 0.5 : -0.5)); sp.rotation = 0;
        }
        for (let j = 0; j < c.crowd; j++) {
          const a = (j / Math.max(1, c.crowd)) * Math.PI - Math.PI / 2; const r = 3.2 + (j % 2) * 0.7;
          const sp = spr(); sp.texture = this.tex.ped[(j + 2) % this.tex.ped.length]; sp.width = 0.55; sp.height = 0.75;
          sp.position.set(c.x + nx * side * (1.8 + Math.cos(a) * r * 0.5) + Math.cos(c.h) * Math.sin(a) * r, c.y + ny * side * (1.8 + Math.cos(a) * r * 0.5) + Math.sin(c.h) * Math.sin(a) * r); sp.rotation = 0;
        }
      }
      let tx = this.crashTexts[kt];
      if (!tx) { tx = new Text({ text: '', style: { fontFamily: 'monospace', fontSize: 22, fill: 0xffffff, stroke: { color: 0x7a0000, width: 5 }, fontWeight: 'bold' } }); tx.resolution = 2; tx.anchor.set(0.5, 1); this.crashLayer.addChild(tx); this.crashTexts.push(tx); }
      const left = Math.max(0, Math.ceil((c.t1 - s.t) / 60));
      tx.text = close ? `💥 Va quẹt! cãi nhau (${left}′)` : '💥'; tx.visible = true;
      tx.scale.set((close ? 0.45 : 0.9) / z); tx.position.set(c.x + nx * side * 1.6, c.y + ny * side * 1.6 - 1.2);
      kt++;
    }
    for (; k < this.crashSprites.length; k++) this.crashSprites[k].visible = false;
    for (; kt < this.crashTexts.length; kt++) this.crashTexts[kt].visible = false;
  }

  /** editor overlay: closed links, zones, edited junctions */
  drawEditor() {
    const g = this.editG; g.clear(); if (!this.layers.editor) return;
    const p = { x: 0, y: 0, h: 0 };
    for (const L of this.net.links) {
      if (!L.closed) continue;
      for (let s = 2; s < L.len - 2; s += 6) { this.net.pointAt(L, s, this.net.offsetOf(L, L.width / 2), p); g.moveTo(p.x - 1.2, p.y - 1.2).lineTo(p.x + 1.2, p.y + 1.2).moveTo(p.x + 1.2, p.y - 1.2).lineTo(p.x - 1.2, p.y + 1.2); }
      g.stroke({ width: 0.8, color: 0xff3b30 });
    }
    for (const [id, e] of Object.entries(this.edits.nodes ?? {})) { const n = this.net.nodes[+id]; if (!n) continue; g.circle(n.x, n.y, n.radius + 4).stroke({ width: 1.2, color: e.signal === false ? 0xff3b30 : 0xffd23f }); }
    for (const z of this.layers.zones ?? []) { const n = this.net.nodes[z.node]; g.circle(n.x, n.y, 6 + Math.sqrt(z.w) * 0.25).fill({ color: 0xb45cc8, alpha: 0.28 }).stroke({ width: 0.8, color: 0xb45cc8 }); }
  }

  private drawLabels(t: number) {
    const show = this.layers.ai;
    const recent = new Map<number, DecisionLog>();
    if (show) for (const d of this.decisions) if (t - d.t < 15) recent.set(d.node, d);
    let k = 0; const z = this.world.scale.x;
    for (const [nid, d] of recent) {
      let tx = this.labels[k];
      if (!tx) { tx = new Text({ text: '', style: { fontFamily: 'monospace', fontSize: 22, fill: 0xffffff, stroke: { color: 0x000000, width: 4 }, fontWeight: 'bold' } }); tx.resolution = 2; this.labelLayer.addChild(tx); this.labels.push(tx); }
      const n = this.net.nodes[nid];
      const short = d.kind === 'force' ? `⚠ ép pha ${d.to + 1}` : `→ pha ${d.to + 1}` + (d.values.pBest !== undefined ? ` (${d.values.pBest}>${d.values.pCur})` : '');
      tx.text = short; tx.visible = true; tx.style.fill = d.kind === 'force' ? 0xffb020 : 0x7df9ff;
      tx.scale.set(0.5 / z); tx.position.set(n.x + 8, n.y - 14); tx.alpha = Math.max(0.3, 1 - (t - d.t) / 15);
      k++;
    }
    for (; k < this.labels.length; k++) this.labels[k].visible = false;
  }

  private frame() {
    this.updateTiles();
    this.frames++; const now = performance.now();
    if (now - this.fpsT > 1000) { this.fps = this.frames * 1000 / (now - this.fpsT); this.frames = 0; this.fpsT = now; }
  }
}

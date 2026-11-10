import { Texture } from 'pixi.js';

/** Hand-made pixel sprites (nose pointing up). Each char is one pixel. */
const PAL: Record<string, string> = { k: '#1b1b1f', d: '#3a3a42', w: '#f4f1e6', y: '#f2c94c', r: '#d64541', b: '#3b6fd8', g: '#43a047', o: '#ef8a2e', p: '#b45cc8', c: '#5ec8d8', s: '#e8b48a', h: '#ffe9a8', l: '#9fd3ff', '.': '' };
const MOTO = ['.h.', 'kXk', 'XsX', 'XXX', '.k.', '.k.'];
const CAR = ['.hXXh.', 'XXXXXX', 'XllllX', 'XXXXXX', 'XXXXXX', 'XXXXXX', 'XXXXXX', 'XXXXXX', 'XllllX', 'XXXXXX', 'rXXXXr', '.dddd.'];
const BUS = ['hXXXXXXh', 'XllllllX', 'XXXXXXXX', ...Array.from({ length: 22 }, (_, i) => (i % 3 === 0 ? 'lXXXXXXl' : 'XXXXXXXX')), 'XXXXXXXX', 'rddddddr'];
const BIKE = ['.k.', '.X.', '.s.', '.X.', '.k.'];
const TAXI = ['.hXXh.', 'XXXXXX', 'XllllX', 'XXXXXX', 'XXwwXX', 'XXXXXX', 'XXXXXX', 'XXXXXX', 'XllllX', 'XXXXXX', 'rXXXXr', '.dddd.'];
const VAN = ['.hXXXXh', 'XXXXXXX', 'XlllllX', 'XXXXXXX', ...Array.from({ length: 9 }, () => 'XXXXXXX'), 'XlllllX', 'rXXXXXr'];
const SUV = ['.hXXXh.', 'XXXXXXX', 'XlllllX', 'XXXXXXX', 'XdXXXdX', 'XXXXXXX', 'XXXXXXX', 'XdXXXdX', 'XXXXXXX', 'XlllllX', 'XXXXXXX', 'rdddddr'];
const PED = ['s', 'X'];
const TRUCK = ['hXXXXXh', 'XlllllX', 'XXXXXXX', 'ddddddd', ...Array.from({ length: 14 }, () => 'wwwwwww'), 'wwwwwww', 'rdddddr'];

function make(rows: string[], body: string) {
  const h = rows.length, w = rows[0].length;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d')!;
  rows.forEach((row, y) => [...row].forEach((ch, x) => { const col = ch === 'X' ? body : PAL[ch]; if (col) { g.fillStyle = col; g.fillRect(x, y, 1, 1); } }));
  const t = Texture.from(cv); t.source.scaleMode = 'nearest'; return t;
}

export interface VehTextures { moto: Texture[]; car: Texture[]; bus: Texture[]; truck: Texture[]; bike: Texture[]; taxi: Texture[]; van: Texture[]; suv: Texture[]; ped: Texture[]; glow: Texture; dot: Texture; byType: Texture[][] }
export function makeTextures(): VehTextures {
  const glowCv = document.createElement('canvas'); glowCv.width = 16; glowCv.height = 24;
  const g = glowCv.getContext('2d')!; const gr = g.createLinearGradient(0, 24, 0, 0); gr.addColorStop(0, 'rgba(255,240,180,0.55)'); gr.addColorStop(1, 'rgba(255,240,180,0)');
  g.fillStyle = gr; g.beginPath(); g.moveTo(6, 24); g.lineTo(10, 24); g.lineTo(16, 0); g.lineTo(0, 0); g.closePath(); g.fill();
  const glow = Texture.from(glowCv);
  const dotCv = document.createElement('canvas'); dotCv.width = 1; dotCv.height = 1; const dg = dotCv.getContext('2d')!; dg.fillStyle = '#fff'; dg.fillRect(0, 0, 1, 1);
  const dot = Texture.from(dotCv); dot.source.scaleMode = 'nearest';
  const T = {
    bike: ['#2c3e50', '#16a085', '#8e44ad'].map(c => make(BIKE, c)),
    taxi: [make(TAXI, '#2ecc71'), make(TAXI, '#f4f1e6'), make(TAXI, '#f2c94c')], // Mai Linh green, white, yellow
    van: ['#f4f1e6', '#95a5a6', '#34495e'].map(c => make(VAN, c)),
    suv: ['#1b1b1f', '#7f8c8d', '#8c2f2f', '#f4f1e6'].map(c => make(SUV, c)),
    ped: ['#d64541', '#3b6fd8', '#f2c94c', '#43a047', '#f4f1e6', '#b45cc8'].map(c => make(PED, c)),
  };
  const base = {
    moto: ['#d64541', '#3b6fd8', '#43a047', '#ef8a2e', '#b45cc8', '#5ec8d8', '#f2c94c', '#e8e4d0'].map(c => make(MOTO, c)),
    car: ['#e8e4d0', '#c0392b', '#2c3e50', '#7f8c8d', '#2980b9', '#d4ac0d'].map(c => make(CAR, c)),
    bus: [make(BUS, '#2e9e57'), make(BUS, '#e0a526')],
    truck: [make(TRUCK, '#3d6fb0'), make(TRUCK, '#a6402f')],
  };
  return { ...base, ...T, glow, dot, byType: [base.moto, base.car, base.bus, base.truck, T.bike, T.taxi, T.van, T.suv] };
}

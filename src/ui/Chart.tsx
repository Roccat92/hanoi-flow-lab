import React from 'react';

export interface SeriesDef { name: string; color: string; pts: [number, number][] }
export function Chart({ series, title, unit, height = 90, xLabel = 'phút' }: { series: SeriesDef[]; title: string; unit?: string; height?: number; xLabel?: string }) {
  const W = 300, H = height, P = 26;
  let xmax = 1, ymax = 0;
  for (const s of series) for (const [x, y] of s.pts) { xmax = Math.max(xmax, x); ymax = Math.max(ymax, y); }
  ymax = ymax <= 0 ? 1 : niceMax(ymax);
  const X = (x: number) => P + (x / xmax) * (W - P - 6), Y = (y: number) => H - 14 - (y / ymax) * (H - 24);
  return (
    <div className="chart">
      <div className="chart-title">{title}{unit ? <span className="unit"> ({unit})</span> : null}</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} shapeRendering="crispEdges">
        <line x1={P} y1={H - 14} x2={W - 6} y2={H - 14} stroke="#555" />
        <line x1={P} y1={8} x2={P} y2={H - 14} stroke="#555" />
        <text x={2} y={12} fill="#999" fontSize="9">{fmtN(ymax)}</text>
        <text x={2} y={H - 14} fill="#999" fontSize="9">0</text>
        <text x={W - 40} y={H - 2} fill="#999" fontSize="9">{xmax.toFixed(0)} {xLabel}</text>
        {series.map(s => <polyline key={s.name} fill="none" stroke={s.color} strokeWidth={1.5} shapeRendering="geometricPrecision" points={s.pts.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ')} />)}
      </svg>
      {series.length > 1 && <div className="legend">{series.map(s => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}</div>}
    </div>
  );
}
function niceMax(v: number) { const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
export function fmtN(v: number) { return v >= 10000 ? (v / 1000).toFixed(0) + 'k' : v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v >= 100 ? v.toFixed(0) : v.toFixed(1); }

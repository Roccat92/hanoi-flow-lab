import React from 'react';
import type { NodeInfo, VehInfo } from '../sim/protocol';

const stageName: Record<string, string> = { G: 'Xanh', Y: 'Vàng', R: 'Đỏ toàn phần' };
export function Inspector({ node, veh, onClose }: { node: NodeInfo | null; veh: VehInfo | null; onClose: () => void }) {
  if (veh) return (
    <div className="card inspector">
      <div className="card-h">🛵 Phương tiện #{veh.id} <button onClick={onClose}>×</button></div>
      <table><tbody>
        <tr><td>Loại</td><td>{veh.type}</td></tr>
        <tr><td>Tốc độ</td><td>{veh.speedKmh.toFixed(1)} km/h</td></tr>
        <tr><td>Đang ở</td><td>{veh.inJunction ? 'trong nút giao, từ ' : ''}{veh.link}</td></tr>
        <tr><td>Tiếp theo</td><td>{veh.next}</td></tr>
        <tr><td>Điểm đến</td><td>{veh.dest}</td></tr>
        <tr><td>Thời gian đi</td><td>{veh.travelS.toFixed(0)} s (tự do ≈ {veh.ffS.toFixed(0)} s)</td></tr>
        <tr><td>Số lần dừng</td><td>{veh.stops}</td></tr>
        <tr><td>Tổng thời gian dừng</td><td>{veh.waitS.toFixed(0)} s</td></tr>
        <tr><td>Vị trí ngang</td><td>{(veh.lat * 100).toFixed(0)}% bề rộng (0 = tim đường)</td></tr>
      </tbody></table>
      <div className="route">Lộ trình còn lại: {veh.route.join(' → ')}</div>
    </div>
  );
  if (!node) return <div className="card inspector muted">Bấm vào một nút giao hoặc phương tiện trên bản đồ để xem chi tiết.</div>;
  return (
    <div className="card inspector">
      <div className="card-h">{node.signal ? '🚦' : '✚'} Nút #{node.id}: {node.name || 'không tên'} <button onClick={onClose}>×</button></div>
      {node.state ? <div className="sigstate">Pha {node.state.phase + 1} · <b className={'st-' + node.state.stage}>{stageName[node.state.stage]}</b> {node.state.tStage.toFixed(0)}s · xanh tối thiểu {node.state.minGreen}s · {node.state.switches} lần đổi pha{node.state.forced ? ` · ${node.state.forced} lần ép an toàn` : ''}</div> : <div className="muted">Nút không đèn: ưu tiên theo cấp đường, xe phải nhường và không được vào nút khi nút chưa trống.</div>}
      {node.phases.length > 0 && <table className="phases"><thead><tr><th>Pha</th><th>Hướng</th><th>Hàng chờ</th><th>Sắp tới</th><th>Áp lực AI</th><th>Ra đầy</th></tr></thead><tbody>
        {node.phases.map((p, i) => { const o = node.obs?.[i]; return <tr key={i} className={node.state?.phase === i ? 'cur' : ''}><td>{i + 1}{node.fixedSplits ? ` (${node.fixedSplits[i]}s)` : ''}</td><td>{p.pedOnly ? 'Người đi bộ' : p.label}<span className="muted"> {p.prot} ưu tiên/{p.perm} nhường</span></td><td>{o ? `${o.queueN} xe (${o.queuePcu.toFixed(1)} PCU)` : '-'}</td><td>{o ? (o.arrPcu + o.upArrPcu).toFixed(1) : '-'}</td><td>{o?.pressure?.toFixed(1) ?? '-'}</td><td>{o ? Math.round(o.outOcc * 100) + '%' : '-'}</td></tr>; })}
      </tbody></table>}
      <table className="phases"><thead><tr><th>Nhánh vào</th><th>Xe</th><th>Đang dừng</th><th>Tốc độ</th></tr></thead><tbody>
        {node.approaches.map(a => <tr key={a.link}><td>{a.name}</td><td>{a.vehicles}</td><td>{a.queue}</td><td>{a.speedKmh.toFixed(0)} km/h</td></tr>)}
      </tbody></table>
      {node.state?.lastReason && <div className="reason">Quyết định gần nhất: {node.state.lastReason}</div>}
      {node.log.length > 0 && <div className="nodelog">{node.log.map((d, i) => <div key={i}><span className="t">{fmtT(d.t)}</span> {d.text}</div>)}</div>}
    </div>
  );
}
export function fmtT(t: number) { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${s.toString().padStart(2, '0')}`; }

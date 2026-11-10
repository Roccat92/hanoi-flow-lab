import type { ControllerKind, NodeMode } from './types';
import type { Network, Node } from './network';
import { OPTIMAL_MODES } from './optimal';

export const CTRL_LABEL: Record<ControllerKind, string> = {
  fixed: 'Cố định thời gian',
  actuated: 'Cảm biến (actuated)',
  ai: 'AI điều phối (max-pressure mạng lưới + dự báo)',
  nosignal: 'Không đèn (tự thương lượng)',
  major: 'Chỉ đèn nút lớn (AI), nút nhỏ tắt đèn',
  flash: 'Đèn vàng nhấp nháy (đường chính ưu tiên)',
  allway: 'Nhường tất cả các hướng (kiểu vòng xuyến)',
  optimal: 'Cấu hình tối ưu (lai từng nút)',
};
export const MODE_LABEL: Record<NodeMode, string> = {
  fixed: 'Đèn cố định', actuated: 'Đèn cảm biến', ai: 'Đèn AI', off: 'Tắt đèn', flash: 'Vàng nhấp nháy', allway: 'Nhường mọi hướng',
};
export const SIGNAL_MODES: NodeMode[] = ['fixed', 'actuated', 'ai'];
export const isSignalMode = (m: NodeMode) => m === 'fixed' || m === 'actuated' || m === 'ai';

/** a "major" junction: at least 3 approaches of secondary class or above, belonging to at least 2 different named roads */
export function isMajor(net: Network, n: Node) {
  const big = n.inLinks.map(l => net.links[l]).filter(L => L.rank >= 3 && !L.closed);
  return big.length >= 3 && new Set(big.map(L => L.name)).size >= 2;
}

/** control mode of a (physically signalised) junction under a network-wide controller kind; per-node overrides win */
export function modeFor(kind: ControllerKind, net: Network, n: Node, overrides?: Record<number, NodeMode>, editMode?: NodeMode): NodeMode {
  if (editMode) return editMode;
  if (overrides && overrides[n.id]) return overrides[n.id];
  switch (kind) {
    case 'fixed': case 'actuated': case 'ai': return kind;
    case 'nosignal': return 'off';
    case 'flash': return 'flash';
    case 'allway': return 'allway';
    case 'major': return isMajor(net, n) ? 'ai' : 'off';
    case 'optimal': return OPTIMAL_MODES[n.id] ?? 'ai';
  }
}

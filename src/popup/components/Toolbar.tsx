/**
 * The persistent bottom bar.
 *
 * Replay and revert stay reachable from every tab: after tweaking a setting or
 * disabling a snapshot the natural next action is "apply it again now", and
 * making the user walk back to the Record tab for that would be hostile.
 */

import type { ReplayStats } from '@/shared/types';

import { IconCheck, IconChevron, IconWarning } from './Icons';

export interface ToolbarProps {
  /** null until the content script has answered once */
  stats: ReplayStats | null;
  /** true when the page has no content script — both actions are pointless */
  disabled: boolean;
  onReplay: () => void;
  onRevert: () => void;
}

/** [Áp dụng lại] [Hoàn tác] plus a compact applied/unmatched/ambiguous strip. */
export function Toolbar({ stats, disabled, onReplay, onRevert }: ToolbarProps) {
  const applied = stats?.applied ?? 0;
  const unmatched = stats?.unmatched ?? 0;
  const ambiguous = stats?.ambiguous ?? 0;

  return (
    <div className="toolbar">
      <button
        type="button"
        className="btn primary"
        disabled={disabled}
        title="Chạy lại toàn bộ snapshot đang bật trên trang này"
        onClick={onReplay}
      >
        <IconChevron size={12} />
        <span>Áp dụng lại</span>
      </button>
      <button
        type="button"
        className="btn"
        disabled={disabled}
        title="Trả trang về trạng thái trước khi áp dụng"
        onClick={onRevert}
      >
        Hoàn tác
      </button>

      <div
        className="toolbar-stats"
        title={
          stats
            ? `${applied} áp dụng · ${unmatched} chưa khớp · ${ambiguous} mơ hồ · ${stats.runs} lượt · ${Math.round(stats.durationMs)}ms`
            : 'Chưa có lượt áp dụng nào'
        }
      >
        <IconCheck size={11} className="stat-ok" />
        <span className="stat-ok">{applied}</span>
        <span className="sep">/</span>
        <span className="stat-warn">{unmatched}</span>
        <span className="sep">/</span>
        <span className={ambiguous > 0 ? 'stat-bad' : ''}>{ambiguous}</span>
        {ambiguous > 0 ? <IconWarning size={11} className="stat-bad" /> : null}
      </div>
    </div>
  );
}

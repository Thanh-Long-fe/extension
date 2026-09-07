/**
 * A list of changes, used both for the pending buffer on the Record tab and
 * for the frozen changes inside a saved snapshot — the only difference is
 * whether a `onLocate` handler is supplied.
 */

import type { ApplyStatus, Change } from '@/shared/types';

import { ChangeRow } from './ChangeRow';
import { EmptyState } from './EmptyState';

export interface ChangeListProps {
  changes: Change[];
  onToggle: (changeId: string, enabled: boolean) => void;
  onDelete: (changeId: string) => void;
  onLocate?: (changeId: string) => void;
  emptyTitle: string;
  emptyHint?: string;
  /** changeId -> kết quả lượt áp dụng gần nhất; bỏ trống thì dòng không hiện trạng thái */
  statuses?: ReadonlyMap<string, ApplyStatus>;
}

/** Render every change, or a single empty state when there are none. */
export function ChangeList({
  changes,
  onToggle,
  onDelete,
  onLocate,
  emptyTitle,
  emptyHint,
  statuses,
}: ChangeListProps) {
  if (changes.length === 0) {
    return <EmptyState title={emptyTitle} hint={emptyHint} />;
  }

  return (
    <div className="rows">
      {changes.map((change) => (
        <ChangeRow
          key={change.id}
          change={change}
          onToggle={onToggle}
          onDelete={onDelete}
          onLocate={onLocate}
          status={statuses?.get(change.id)}
        />
      ))}
    </div>
  );
}

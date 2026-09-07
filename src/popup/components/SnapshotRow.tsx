/**
 * One saved snapshot.
 *
 * Rename is inline-on-double-click rather than a modal because renaming is the
 * most common edit and a modal for it would be four clicks. Delete asks for
 * confirmation inline for the opposite reason: it is irreversible.
 */

import { useEffect, useRef, useState } from 'react';

import type { ActiveSnapshotState, Snapshot } from '@/shared/types';

import { ChangeList } from './ChangeList';
import { IconChevron, IconTrash } from './Icons';

export interface SnapshotRowProps {
  snapshot: Snapshot;
  /** live counters, present only while this snapshot is active on the page */
  active?: ActiveSnapshotState;
  /** true when the snapshot's pattern matches the tab's current URL */
  matchesUrl: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onToggleChange: (snapshotId: string, changeId: string, enabled: boolean) => void;
  onDeleteChange: (snapshotId: string, changeId: string) => void;
}

/** Collapsible snapshot card with switch, inline rename and change list. */
export function SnapshotRow({
  snapshot,
  active,
  matchesUrl,
  onToggle,
  onRename,
  onDelete,
  onToggleChange,
  onDeleteChange,
}: SnapshotRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(snapshot.name);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const beginRename = () => {
    setDraft(snapshot.name);
    setRenaming(true);
  };

  const commitRename = () => {
    setRenaming(false);
    const next = draft.trim();
    if (next && next !== snapshot.name) onRename(snapshot.id, next);
  };

  const cardClass = [
    'snap',
    matchesUrl ? 'matching' : '',
    snapshot.enabled ? '' : 'disabled',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cardClass}>
      <div className="snap-head">
        <button
          type="button"
          role="switch"
          aria-checked={snapshot.enabled}
          className={snapshot.enabled ? 'switch on' : 'switch'}
          title={snapshot.enabled ? 'Đang bật' : 'Đang tắt'}
          onClick={() => onToggle(snapshot.id, !snapshot.enabled)}
        >
          <span className="switch-knob" />
        </button>

        <div className="snap-main">
          {renaming ? (
            <input
              ref={inputRef}
              className="input"
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenaming(false);
              }}
            />
          ) : (
            <span
              className="snap-name"
              title="Bấm đúp để đổi tên"
              onDoubleClick={beginRename}
            >
              {snapshot.name}
            </span>
          )}

          <div className="snap-sub">
            <span className="chip">{snapshot.matchMode}</span>
            <span className="pattern" title={snapshot.urlPattern}>
              {snapshot.urlPattern}
            </span>
            {matchesUrl ? <span className="chip live">khớp</span> : null}
          </div>
        </div>

        <button
          type="button"
          className="icon-btn"
          aria-expanded={expanded}
          title={expanded ? 'Thu gọn' : `Xem ${snapshot.changes.length} thay đổi`}
          onClick={() => setExpanded((v) => !v)}
        >
          <IconChevron size={13} className={expanded ? 'chev open' : 'chev'} />
        </button>
        <button
          type="button"
          className="icon-btn danger"
          title="Xoá snapshot"
          onClick={() => setConfirming(true)}
        >
          <IconTrash size={13} />
        </button>
      </div>

      <div className="snap-stats">
        <span>{snapshot.changes.length} thay đổi</span>
        {active ? (
          <>
            <span className="stat-ok">{active.applied} đã áp dụng</span>
            <span className="stat-warn">{active.unmatched} chưa khớp</span>
            {active.ambiguous > 0 ? (
              <span className="stat-bad">{active.ambiguous} mơ hồ</span>
            ) : null}
          </>
        ) : null}
      </div>

      {confirming ? (
        <div className="confirm">
          <span>Xoá vĩnh viễn snapshot này?</span>
          <span className="spacer" />
          <button type="button" className="btn tiny" onClick={() => setConfirming(false)}>
            Huỷ
          </button>
          <button
            type="button"
            className="btn tiny danger"
            onClick={() => {
              setConfirming(false);
              onDelete(snapshot.id);
            }}
          >
            Xoá
          </button>
        </div>
      ) : null}

      {expanded ? (
        <div className="snap-changes">
          <ChangeList
            changes={snapshot.changes}
            onToggle={(changeId, enabled) => onToggleChange(snapshot.id, changeId, enabled)}
            onDelete={(changeId) => onDeleteChange(snapshot.id, changeId)}
            emptyTitle="Snapshot này chưa có thay đổi nào"
          />
        </div>
      ) : null}
    </div>
  );
}

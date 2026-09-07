/**
 * The Snapshots tab.
 *
 * Scoped to the active tab's origin: a global list would be unusable on a site
 * where a user keeps dozens of per-page snapshots, and cross-origin snapshots
 * can never apply here anyway. Import/export live here because they are the
 * only way to move snapshots between profiles.
 */

import { useRef } from 'react';

import type { ActiveSnapshotState, Snapshot } from '@/shared/types';

import { EmptyState } from './EmptyState';
import { IconDownload, IconSave, IconUpload } from './Icons';
import { SnapshotRow } from './SnapshotRow';

export interface SnapshotListProps {
  snapshots: Snapshot[];
  /** snapshots whose pattern matches the tab's current URL */
  matching: Snapshot[];
  /** live per-snapshot counters reported by the content script */
  activeSnapshots: ActiveSnapshotState[];
  onToggle: (id: string, enabled: boolean) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onToggleChange: (snapshotId: string, changeId: string, enabled: boolean) => void;
  onDeleteChange: (snapshotId: string, changeId: string) => void;
  onExport: () => void;
  onImport: (file: File) => void;
}

/** Header actions plus one `SnapshotRow` per stored snapshot for this origin. */
export function SnapshotList({
  snapshots,
  matching,
  activeSnapshots,
  onToggle,
  onRename,
  onDelete,
  onToggleChange,
  onDeleteChange,
  onExport,
  onImport,
}: SnapshotListProps) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const matchingIds = new Set(matching.map((s) => s.id));

  return (
    <div className="pane">
      <div className="list-head">
        <h3>Snapshot cho trang này ({snapshots.length})</h3>
        <button
          type="button"
          className="btn tiny"
          title="Xuất ra file .json"
          disabled={snapshots.length === 0}
          onClick={onExport}
        >
          <IconDownload size={12} />
          <span>Xuất</span>
        </button>
        <button
          type="button"
          className="btn tiny"
          title="Nhập từ file .json"
          onClick={() => fileRef.current?.click()}
        >
          <IconUpload size={12} />
          <span>Nhập</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (file) onImport(file);
          }}
        />
      </div>

      {snapshots.length === 0 ? (
        <EmptyState
          icon={<IconSave size={22} />}
          title="Chưa có snapshot nào cho tên miền này"
          hint="Ghi vài thay đổi ở tab Record rồi bấm Lưu Snapshot, hoặc nhập từ file .json đã xuất trước đó."
        />
      ) : (
        <div className="rows">
          {snapshots.map((snapshot) => (
            <SnapshotRow
              key={snapshot.id}
              snapshot={snapshot}
              active={activeSnapshots.find((a) => a.id === snapshot.id)}
              matchesUrl={matchingIds.has(snapshot.id)}
              onToggle={onToggle}
              onRename={onRename}
              onDelete={onDelete}
              onToggleChange={onToggleChange}
              onDeleteChange={onDeleteChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}

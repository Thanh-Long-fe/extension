/**
 * The Record tab.
 *
 * The whole capture loop lives in the content script, so this panel only has
 * to make the current mode unmistakable (a pulsing red dot beats any label)
 * and expose the buffer of pending changes for triage before they are
 * committed into a snapshot.
 */

import { useMemo } from 'react';

import type { ApplyReport, ApplyStatus, PendingChange } from '@/shared/types';

import { ChangeList } from './ChangeList';
import { EmptyState } from './EmptyState';
import { IconRecord, IconSave, IconStop, IconTrash } from './Icons';

export interface RecordPanelProps {
  recording: boolean;
  pending: PendingChange[];
  /** raw mutation records the recorder threw away as app noise */
  filteredOut: number;
  /** bao nhiêu thay đổi được khôi phục từ bản nháp sau lần tải trang này */
  restoredCount: number;
  /** lần cuối bản nháp được ghi xuống storage, null khi chưa ghi lần nào */
  draftSavedAt: number | null;
  /** cơ chế tự lưu / tự khôi phục có đang bật không */
  autoDraft: boolean;
  /** kết quả lượt áp dụng gần nhất, để mỗi dòng tự nói nó đang ở trạng thái nào */
  reports: ApplyReport[];
  /** false when the page has no content script */
  connected: boolean;
  onStart: () => void;
  onStop: () => void;
  onClear: () => void;
  onToggle: (changeId: string, enabled: boolean) => void;
  onDelete: (changeId: string) => void;
  onSetAll: (enabled: boolean) => void;
  onLocate: (changeId: string) => void;
  /** opens the save dialog; the dialog itself lives in `App` */
  onRequestSave: () => void;
}

/**
 * Dòng trạng thái bản nháp.
 *
 * Đây là thứ trả lời câu hỏi "sửa xong F5 có mất không?" ngay trong giao diện,
 * nên nó phải nói rõ một trong ba tình huống: cơ chế đang tắt, chưa có gì để
 * lưu, hay đã lưu lúc mấy giờ.
 */
function draftLabel(autoDraft: boolean, savedAt: number | null, pendingCount: number): string {
  if (!autoDraft) return '⚠ Tự lưu bản nháp đang TẮT — F5 sẽ mất thay đổi chưa lưu';
  if (pendingCount === 0) return 'Tự lưu bản nháp: đang bật — F5 sẽ không mất thay đổi';
  if (savedAt === null) return 'Tự lưu bản nháp: đang bật, sắp lưu…';
  const time = new Date(savedAt).toLocaleTimeString();
  return `Đã lưu nháp lúc ${time} — F5 sẽ tự áp lại`;
}

/** Record / stop, the pending-change counters and the pending change list. */
export function RecordPanel({
  recording,
  pending,
  filteredOut,
  restoredCount,
  draftSavedAt,
  autoDraft,
  reports,
  connected,
  onStart,
  onStop,
  onClear,
  onToggle,
  onDelete,
  onSetAll,
  onLocate,
  onRequestSave,
}: RecordPanelProps) {
  const enabledCount = pending.reduce((n, c) => (c.enabled ? n + 1 : n), 0);
  const nothingEnabled = enabledCount === 0;

  // Popup poll lại state mỗi 700ms nên mảng `reports` là object mới mỗi lượt;
  // dựng Map trong useMemo để không phải dựng lại khi chỉ có state khác đổi.
  const statuses = useMemo(() => {
    const map = new Map<string, ApplyStatus>();
    for (const report of reports) map.set(report.changeId, report.status);
    return map;
  }, [reports]);

  // Đếm riêng số thay đổi ĐANG BẬT mà không tìm thấy phần tử. Đây là con số
  // giải thích tình huống khó chịu nhất: danh sách có đủ, nhưng trang không đổi
  // gì cả — vì fingerprint không còn khớp với DOM hiện tại.
  const missing = pending.reduce((n, change) => {
    if (!change.enabled) return n;
    const status = statuses.get(change.id);
    return status === 'unmatched' || status === 'ambiguous' || status === 'failed' ? n + 1 : n;
  }, 0);

  if (!connected) {
    return (
      <div className="pane">
        <EmptyState
          icon={<IconRecord size={22} />}
          title="Không kết nối được với trang này"
          hint="Mở lại trang (F5) để bắt đầu. Các trang chrome://, Chrome Web Store và tab đã mở trước khi cài tiện ích sẽ không chạy được."
        />
      </div>
    );
  }

  return (
    <div className="pane">
      <button
        type="button"
        className={recording ? 'record-btn recording' : 'record-btn'}
        onClick={recording ? onStop : onStart}
      >
        {recording ? (
          <>
            <span className="rec-dot pulse" />
            <span>Đang ghi — bấm để dừng</span>
            <IconStop size={13} />
          </>
        ) : (
          <>
            <IconRecord size={13} />
            <span>Bắt đầu ghi thay đổi</span>
          </>
        )}
      </button>

      <div className="meta">
        <span>
          Thay đổi phát hiện: <strong>{pending.length}</strong>
        </span>
        <span>·</span>
        <span title="Số mutation bị loại vì trông giống app tự render">
          đã lọc <strong>{filteredOut}</strong> nhiễu từ app
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="linkish"
          disabled={pending.length === 0}
          onClick={() => onSetAll(true)}
        >
          Chọn tất cả
        </button>
        <button
          type="button"
          className="linkish"
          disabled={nothingEnabled}
          onClick={() => onSetAll(false)}
        >
          Bỏ chọn
        </button>
      </div>

      <div className="meta">
        {restoredCount > 0 ? (
          <span title="Những thay đổi này còn lại từ trước khi trang tải lại và đã được áp lại lên DOM">
            ↺ khôi phục <strong>{restoredCount}</strong> sau khi tải lại
          </span>
        ) : (
          <span>{draftLabel(autoDraft, draftSavedAt, pending.length)}</span>
        )}
        {missing > 0 ? (
          <>
            <span className="spacer" />
            <span
              className="warn"
              title="Các thay đổi này đã ghi được nhưng chưa áp lên trang vì không tìm lại được phần tử"
            >
              ⚠ <strong>{missing}</strong> chưa lên trang
            </span>
          </>
        ) : null}
      </div>

      <ChangeList
        changes={pending}
        onToggle={onToggle}
        onDelete={onDelete}
        onLocate={onLocate}
        emptyTitle={recording ? 'Chưa ghi được thay đổi nào' : 'Chưa có thay đổi nào'}
        emptyHint={
          recording
            ? 'Mở DevTools và sửa DOM: đổi chữ, sửa style inline, bật/tắt class, ẩn hoặc xoá node.'
            : 'Bấm "Bắt đầu ghi", rồi sửa DOM trong DevTools. Mọi chỉnh sửa sẽ hiện ở đây.'
        }
        statuses={statuses}
      />

      <div className="pane-footer">
        <button
          type="button"
          className="btn primary"
          disabled={nothingEnabled}
          onClick={onRequestSave}
        >
          <IconSave size={13} />
          <span>Lưu Snapshot{enabledCount > 0 ? ` (${enabledCount})` : ''}</span>
        </button>
        <button
          type="button"
          className="btn danger shrink"
          disabled={nothingEnabled}
          onClick={onClear}
        >
          <IconTrash size={13} />
          <span>Xoá hết</span>
        </button>
      </div>
    </div>
  );
}

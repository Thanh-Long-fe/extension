/**
 * One recorded change.
 *
 * The row never inspects the change's variant fields: the recorder already
 * flattened everything a human needs into `targetLabel` / `oldSummary` /
 * `newSummary`, which keeps this component immune to future ChangeType
 * additions.
 */

import type { ApplyStatus, Change, ChangeType } from '@/shared/types';

import { IconTarget, IconTrash, IconWarning } from './Icons';

const TYPE_LABEL: Record<ChangeType, string> = {
  text: 'text',
  style: 'style',
  class: 'class',
  attribute: 'attr',
  visibility: 'hidden',
  remove: 'removed',
  insert: 'inserted',
};

/** Short badge text for a change type, e.g. `attribute` -> `attr`. */
export function changeTypeLabel(type: ChangeType): string {
  return TYPE_LABEL[type];
}

/** Bucket a 0..1 recorder confidence into the three pip colours. */
function pipClass(confidence: number): string {
  if (confidence >= 0.75) return 'pip high';
  if (confidence >= 0.45) return 'pip mid';
  return 'pip low';
}

/**
 * Thay đổi này hiện đang ở trạng thái nào TRÊN TRANG.
 *
 * Đây là thứ trả lời câu "sao sửa rồi mà không thấy gì": `unmatched` nghĩa là
 * không tìm ra phần tử (fingerprint không còn khớp với trang), khác hẳn với
 * `skipped` (bạn tự tắt) hay `failed` (áp vào thì lỗi). Không có ba chữ này
 * thì mọi thất bại đều trông giống nhau và chỉ còn cách ngồi đoán.
 *
 * `applied` và `unchanged` gộp làm một: sau lượt áp đầu tiên thì mọi thay đổi
 * thành công đều báo `unchanged` mãi mãi, tách ra chỉ làm người đọc hoang mang.
 */
const STATUS_TEXT: Record<ApplyStatus, string> = {
  applied: 'đang áp dụng',
  unchanged: 'đang áp dụng',
  unmatched: 'chưa tìm thấy phần tử',
  ambiguous: 'nhiều phần tử giống nhau',
  failed: 'áp dụng lỗi',
  skipped: 'đang tắt',
};

/** Chỉ tô đỏ/vàng những trạng thái mà user cần để mắt tới. */
const STATUS_TONE: Record<ApplyStatus, string> = {
  applied: 'ok',
  unchanged: 'ok',
  unmatched: 'warn',
  ambiguous: 'warn',
  failed: 'bad',
  skipped: 'muted',
};

export interface ChangeRowProps {
  change: Change;
  onToggle: (changeId: string, enabled: boolean) => void;
  onDelete: (changeId: string) => void;
  /** omitted for saved snapshots viewed on a page where locating makes no sense */
  onLocate?: (changeId: string) => void;
  /** kết quả lượt áp dụng gần nhất; bỏ trống khi trang chưa chạy lượt nào */
  status?: ApplyStatus;
}

/** A checkbox + type badge + target label + old→new summary + row actions. */
export function ChangeRow({ change, onToggle, onDelete, onLocate, status }: ChangeRowProps) {
  const suspicious = change.source === 'app';
  // 'skipped' đã thể hiện bằng ô tick và lớp `off` rồi, nhắc lại thành thừa.
  const showStatus = status !== undefined && status !== 'skipped';
  const percent = Math.round(change.confidence * 100);
  const className = [
    'row',
    suspicious ? 'dim' : '',
    change.enabled ? '' : 'off',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <input
        type="checkbox"
        className="row-check"
        checked={change.enabled}
        aria-label={`Bật thay đổi ${change.label}`}
        onChange={(e) => onToggle(change.id, e.currentTarget.checked)}
      />

      <div className="row-body">
        <div className="row-head">
          <span className={`badge ${change.type}`}>{TYPE_LABEL[change.type]}</span>
          <span className="row-label" title={change.targetLabel}>
            {change.targetLabel || 'phần tử không tên'}
          </span>
          <span className={pipClass(change.confidence)} title={`Độ tin cậy ${percent}%`} />
        </div>

        {showStatus ? (
          <div className={`row-status ${STATUS_TONE[status]}`}>{STATUS_TEXT[status]}</div>
        ) : null}

        <div className="row-diff" title={`${change.oldSummary} → ${change.newSummary}`}>
          {change.oldSummary ? <span className="old">{change.oldSummary}</span> : null}
          <span className="arrow">→</span>
          <span className="new">{change.newSummary || '∅'}</span>
        </div>

        {suspicious ? (
          <div className="row-hint">
            <IconWarning size={10} />
            <span>có thể là app render, không phải bạn sửa</span>
          </div>
        ) : null}
      </div>

      <div className="row-actions">
        {onLocate ? (
          <button
            type="button"
            className="icon-btn"
            title="Tô sáng phần tử trên trang"
            onClick={() => onLocate(change.id)}
          >
            <IconTarget size={13} />
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn danger"
          title="Xoá thay đổi này"
          onClick={() => onDelete(change.id)}
        >
          <IconTrash size={13} />
        </button>
      </div>
    </div>
  );
}

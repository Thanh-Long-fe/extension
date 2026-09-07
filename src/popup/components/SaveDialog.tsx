/**
 * "Save snapshot" modal.
 *
 * The two decisions that matter are the URL pattern and the match mode, and
 * users get them wrong when asked cold — so both are pre-filled from the live
 * URL via `suggestPattern`, and the pattern is only left alone once the user
 * has actually edited it (`touched`), otherwise switching mode re-suggests.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { Snapshot, UrlMatchMode } from '@/shared/types';
import { pathOf, suggestPattern } from '@/shared/url-match';

import type { SaveSnapshotInput } from '../hooks/useController';

const MODES: ReadonlyArray<{ value: UrlMatchMode; label: string; hint: string }> = [
  { value: 'origin', label: 'origin', hint: 'Áp dụng cho mọi trang cùng tên miền.' },
  { value: 'path', label: 'path', hint: 'So khớp theo đường dẫn, bỏ qua query string.' },
  { value: 'url', label: 'url', hint: 'So khớp cả đường dẫn lẫn query string.' },
];

/** Build a readable default name from the page title, falling back to the path. */
function defaultName(pageTitle: string, url: string): string {
  const title = pageTitle.trim();
  if (title) return title.length > 60 ? `${title.slice(0, 59)}…` : title;
  const path = pathOf(url);
  return path && path !== '/' ? path : 'Snapshot';
}

export interface SaveDialogProps {
  /** current tab URL, used for the pattern suggestion */
  url: string;
  pageTitle: string;
  /** how many pending changes will be committed */
  count: number;
  /** every snapshot for this origin, offered as append targets */
  snapshots: Snapshot[];
  onCancel: () => void;
  onSave: (input: SaveSnapshotInput) => void;
}

/** Name / pattern / match-mode form, with an "append to existing" shortcut. */
export function SaveDialog({
  url,
  pageTitle,
  count,
  snapshots,
  onCancel,
  onSave,
}: SaveDialogProps) {
  const [name, setName] = useState(() => defaultName(pageTitle, url));
  const [mode, setMode] = useState<UrlMatchMode>('path');
  const [pattern, setPattern] = useState(() => suggestPattern(url, 'path'));
  const [touched, setTouched] = useState(false);
  const [targetId, setTargetId] = useState('');
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.select();
  }, []);

  /* Re-suggest the pattern whenever the mode changes, unless it was hand-edited. */
  useEffect(() => {
    if (!touched) setPattern(suggestPattern(url, mode));
  }, [mode, url, touched]);

  const target = useMemo(
    () => snapshots.find((s) => s.id === targetId) ?? null,
    [snapshots, targetId],
  );

  const appending = target !== null;
  const effectiveName = target ? target.name : name;
  const effectivePattern = target ? target.urlPattern : pattern;
  const effectiveMode = target ? target.matchMode : mode;
  const valid = effectiveName.trim().length > 0 && effectivePattern.trim().length > 0;

  const submit = () => {
    if (!valid) return;
    onSave({
      name: effectiveName.trim(),
      urlPattern: effectivePattern.trim(),
      matchMode: effectiveMode,
      snapshotId: target ? target.id : undefined,
    });
  };

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Lưu snapshot"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
        }}
      >
        <h2>Lưu snapshot</h2>
        <p className="dialog-sub">
          {count} thay đổi đang bật sẽ được lưu và tự áp dụng lại khi URL khớp.
        </p>

        <div className="field">
          <label htmlFor="dm-append">Thêm vào snapshot có sẵn</label>
          <select
            id="dm-append"
            className="select"
            value={targetId}
            onChange={(e) => setTargetId(e.currentTarget.value)}
          >
            <option value="">— Tạo snapshot mới —</option>
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.changes.length})
              </option>
            ))}
          </select>
          <p className="hint">
            {appending
              ? 'Các thay đổi sẽ được nối vào snapshot này; tên và pattern giữ nguyên.'
              : 'Để trống nếu muốn tạo một snapshot riêng cho trang này.'}
          </p>
        </div>

        <div className="field">
          <label htmlFor="dm-name">Tên</label>
          <input
            id="dm-name"
            ref={nameRef}
            className="input"
            type="text"
            value={effectiveName}
            disabled={appending}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="dm-pattern">Mẫu URL</label>
          <input
            id="dm-pattern"
            className="input mono"
            type="text"
            spellCheck={false}
            value={effectivePattern}
            disabled={appending}
            onChange={(e) => {
              setTouched(true);
              setPattern(e.currentTarget.value);
            }}
          />
          <p className="hint">
            <code>*</code> khớp mọi ký tự, <code>?</code> khớp đúng một ký tự.
          </p>
        </div>

        <div className="field">
          <span id="dm-mode-label" className="field-label">
            Chế độ khớp
          </span>
          <div className="seg" role="group" aria-labelledby="dm-mode-label">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                className={effectiveMode === m.value ? 'active' : ''}
                disabled={appending}
                onClick={() => {
                  setMode(m.value);
                  setTouched(false);
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="hint">{MODES.find((m) => m.value === effectiveMode)?.hint}</p>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Huỷ
          </button>
          <button type="button" className="btn primary" disabled={!valid} onClick={submit}>
            {appending ? 'Thêm vào' : 'Lưu'}
          </button>
        </div>
      </div>
    </div>
  );
}

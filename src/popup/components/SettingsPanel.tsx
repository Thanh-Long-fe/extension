/**
 * The Settings tab.
 *
 * Every control writes through immediately — there is no Save button, because
 * a popup can be dismissed by clicking anywhere and a pending edit would be
 * silently lost. Numeric and slider inputs keep a local draft so that a
 * round-trip to storage never fights the user's keystrokes or drag.
 */

import { useEffect, useState } from 'react';

import type { LogLevel, RecordFilter, Settings } from '@/shared/types';

type NumKey = 'guardDebounceMs' | 'initialDelayMs' | 'matchTimeoutMs';

interface NumSpec {
  key: NumKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
}

const NUMBERS: readonly NumSpec[] = [
  {
    key: 'guardDebounceMs',
    label: 'Guard debounce (ms)',
    hint: 'Gộp các lần app render trong khoảng này rồi mới áp dụng lại một lần.',
    min: 0,
    max: 5000,
    step: 10,
  },
  {
    key: 'initialDelayMs',
    label: 'Độ trễ lần đầu (ms)',
    hint: 'Chờ bấy nhiêu sau khi DOM sẵn sàng rồi mới chạy lượt áp dụng đầu tiên.',
    min: 0,
    max: 10000,
    step: 50,
  },
  {
    key: 'matchTimeoutMs',
    label: 'Thời gian thử khớp (ms)',
    hint: 'Tiếp tục thử tìm lại các phần tử chưa khớp trong tối đa bấy nhiêu lâu.',
    min: 0,
    max: 120000,
    step: 500,
  },
];

const RECORD_FILTERS: ReadonlyArray<{ value: RecordFilter; label: string }> = [
  { value: 'all', label: 'Tất cả — không lọc' },
  { value: 'likely', label: 'Vừa phải — bỏ nhiễu rõ ràng' },
  { value: 'strict', label: 'Chặt — chỉ giữ thay đổi chắc chắn của bạn' },
];

const LOG_LEVELS: ReadonlyArray<{ value: LogLevel; label: string }> = [
  { value: 'silent', label: 'Tắt' },
  { value: 'error', label: 'Chỉ lỗi' },
  { value: 'info', label: 'Thông tin' },
  { value: 'debug', label: 'Gỡ lỗi (rất nhiều log)' },
];

function isRecordFilter(value: string): value is RecordFilter {
  return value === 'all' || value === 'likely' || value === 'strict';
}

function isLogLevel(value: string): value is LogLevel {
  return value === 'silent' || value === 'error' || value === 'info' || value === 'debug';
}

export interface SettingsPanelProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

/** Switches, numbers, sliders and selects for every field of `Settings`. */
export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const [nums, setNums] = useState<Record<NumKey, string>>(() => ({
    guardDebounceMs: String(settings.guardDebounceMs),
    initialDelayMs: String(settings.initialDelayMs),
    matchTimeoutMs: String(settings.matchTimeoutMs),
  }));
  const [threshold, setThreshold] = useState(settings.matchThreshold);
  const [margin, setMargin] = useState(settings.matchMargin);

  useEffect(() => {
    setNums({
      guardDebounceMs: String(settings.guardDebounceMs),
      initialDelayMs: String(settings.initialDelayMs),
      matchTimeoutMs: String(settings.matchTimeoutMs),
    });
  }, [settings.guardDebounceMs, settings.initialDelayMs, settings.matchTimeoutMs]);

  useEffect(() => {
    setThreshold(settings.matchThreshold);
  }, [settings.matchThreshold]);

  useEffect(() => {
    setMargin(settings.matchMargin);
  }, [settings.matchMargin]);

  const editNumber = (spec: NumSpec, raw: string) => {
    setNums((prev) => ({ ...prev, [spec.key]: raw }));
    if (raw.trim() === '') return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(spec.max, Math.max(spec.min, Math.round(parsed)));
    if (clamped === settings[spec.key]) return;
    const patch: Partial<Settings> = {};
    patch[spec.key] = clamped;
    onChange(patch);
  };

  return (
    <div className="pane">
      <section className="settings-group">
        <h3>Áp dụng lại</h3>

        <div className="setting">
          <div className="setting-head">
            <span className="setting-name">Guard chống re-render</span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.guard}
              className={settings.guard ? 'switch on' : 'switch'}
              onClick={() => onChange({ guard: !settings.guard })}
            >
              <span className="switch-knob" />
            </button>
          </div>
          <p className="hint">
            Theo dõi DOM và tự áp dụng lại khi ứng dụng render đè lên thay đổi của bạn.
          </p>
        </div>

        <div className="setting">
          <div className="setting-head">
            <span className="setting-name">Hiện số trên biểu tượng</span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.showBadge}
              className={settings.showBadge ? 'switch on' : 'switch'}
              onClick={() => onChange({ showBadge: !settings.showBadge })}
            >
              <span className="switch-knob" />
            </button>
          </div>
          <p className="hint">Hiển thị số thay đổi đã áp dụng ngay trên icon tiện ích.</p>
        </div>

        {NUMBERS.map((spec) => (
          <div className="setting" key={spec.key}>
            <div className="setting-row">
              <span className="setting-name">{spec.label}</span>
              <input
                className="input num"
                type="number"
                min={spec.min}
                max={spec.max}
                step={spec.step}
                value={nums[spec.key]}
                onChange={(e) => editNumber(spec, e.currentTarget.value)}
              />
            </div>
            <p className="hint">{spec.hint}</p>
          </div>
        ))}
      </section>

      <section className="settings-group">
        <h3>Độ nhạy khi dò phần tử</h3>

        <div className="setting">
          <div className="setting-head">
            <span className="setting-name">Ngưỡng khớp</span>
            <span className="setting-value">{threshold.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={threshold}
            onChange={(e) => {
              const next = Number(e.currentTarget.value);
              setThreshold(next);
              onChange({ matchThreshold: next });
            }}
          />
          <p className="hint">
            Điểm tối thiểu để coi một phần tử là “đúng phần tử cũ”. Cao thì an toàn nhưng dễ bỏ
            sót; thấp thì dễ áp nhầm.
          </p>
        </div>

        <div className="setting">
          <div className="setting-head">
            <span className="setting-name">Khoảng cách an toàn</span>
            <span className="setting-value">{margin.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={margin}
            onChange={(e) => {
              const next = Number(e.currentTarget.value);
              setMargin(next);
              onChange({ matchMargin: next });
            }}
          />
          <p className="hint">
            Ứng viên tốt nhất phải hơn ứng viên nhì ít nhất bấy nhiêu điểm, nếu không sẽ bị coi là
            mơ hồ và bỏ qua.
          </p>
        </div>
      </section>

      <section className="settings-group">
        <h3>Bản nháp — chống mất khi F5</h3>

        <div className="setting">
          <div className="setting-head">
            <span className="setting-name">Tự lưu &amp; khôi phục thay đổi chưa lưu</span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.autoDraft}
              className={settings.autoDraft ? 'switch on' : 'switch'}
              onClick={() => onChange({ autoDraft: !settings.autoDraft })}
            >
              <span className="switch-knob" />
            </button>
          </div>
          <p className="hint">
            Mọi thay đổi vừa ghi được lưu tạm theo tab. Khi F5 hoặc trang tự tải lại, chúng được
            áp lại lên DOM nên bạn không mất công sửa. Bản nháp tự mất khi đóng tab hoặc thoát
            trình duyệt — muốn giữ lâu dài thì bấm “Lưu Snapshot”.
          </p>
        </div>

        <div className="setting">
          <div className="setting-head">
            <span className="setting-name">Chỉ áp lại thay đổi do bạn sửa</span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.draftDevtoolsOnly}
              disabled={!settings.autoDraft}
              className={settings.draftDevtoolsOnly ? 'switch on' : 'switch'}
              onClick={() => onChange({ draftDevtoolsOnly: !settings.draftDevtoolsOnly })}
            >
              <span className="switch-knob" />
            </button>
          </div>
          <p className="hint">
            Chỉ tự áp lại những thay đổi mà tiện ích đủ chắc là do bạn sửa trong DevTools. Các
            thay đổi điểm tin cậy thấp vẫn hiện trong danh sách để bạn tự quyết, nhưng không tự
            động áp lên trang.
          </p>
        </div>
      </section>

      <section className="settings-group">
        <h3>Ghi &amp; nhật ký</h3>

        <div className="setting">
          <div className="setting-row">
            <span className="setting-name">Mức lọc khi ghi</span>
          </div>
          <select
            className="select"
            value={settings.recordFilter}
            onChange={(e) => {
              const value = e.currentTarget.value;
              if (isRecordFilter(value)) onChange({ recordFilter: value });
            }}
          >
            {RECORD_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="hint">
            Quyết định mức độ mạnh tay khi loại bỏ các thay đổi do chính trang tự sinh ra.
          </p>
        </div>

        <div className="setting">
          <div className="setting-row">
            <span className="setting-name">Mức log</span>
          </div>
          <select
            className="select"
            value={settings.logLevel}
            onChange={(e) => {
              const value = e.currentTarget.value;
              if (isLogLevel(value)) onChange({ logLevel: value });
            }}
          >
            {LOG_LEVELS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="hint">Độ chi tiết của log in ra Console của trang và của tiện ích.</p>
        </div>
      </section>
    </div>
  );
}

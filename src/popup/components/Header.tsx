/**
 * Popup header: identity, liveness and the master kill switch.
 *
 * The status dot is the fastest way for a user to tell "the extension is not
 * working" from "this page has no content script", so it is bound to the real
 * connection state rather than to `settings.enabled`.
 */

export interface HeaderProps {
  /** e.g. "https://adsmanager.facebook.com" */
  origin: string;
  /** pathname of the active tab */
  path: string;
  /** true when the content script answered the last poll */
  connected: boolean;
  /** mirrors `settings.enabled` */
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
}

/** Extension name + current location + the master enable switch. */
export function Header({ origin, path, connected, enabled, onToggleEnabled }: HeaderProps) {
  const host = origin.replace(/^https?:\/\//, '') || 'không xác định';
  const location = `${host}${path && path !== '/' ? path : ''}`;

  return (
    <header className="header">
      <div className="header-id">
        <div className="header-title">
          <span
            className={connected ? 'dot live' : 'dot'}
            title={connected ? 'Đã kết nối với trang' : 'Chưa kết nối với trang'}
          />
          <span>DOM Modifier</span>
        </div>
        <span className="header-url" title={origin + path}>
          {location}
        </span>
      </div>

      <label className="sr-only" htmlFor="dm-master">
        Bật tiện ích
      </label>
      <button
        id="dm-master"
        type="button"
        role="switch"
        aria-checked={enabled}
        className={enabled ? 'switch on' : 'switch'}
        title={enabled ? 'Đang bật — bấm để tắt toàn bộ' : 'Đang tắt — bấm để bật'}
        onClick={() => onToggleEnabled(!enabled)}
      >
        <span className="switch-knob" />
      </button>
    </header>
  );
}

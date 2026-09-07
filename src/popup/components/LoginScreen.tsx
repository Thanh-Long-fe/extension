/**
 * Màn đăng nhập — hiện khi chưa có phiên hợp lệ.
 *
 * `notice` là lý do bị đẩy về đây (hết hạn, bị gỡ thiết bị…), khác với `error`
 * là lỗi của chính lần bấm đăng nhập vừa rồi.
 */

import { useState, type FormEvent } from 'react';

interface Props {
  notice: string | null;
  onSignIn: (email: string, password: string) => Promise<string | null>;
}

export function LoginScreen({ notice, onSignIn }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const reason = await onSignIn(email.trim(), password);
    setBusy(false);
    if (reason) setError(reason);
  }

  return (
    <div className="auth-screen">
      <div className="auth-brand">
        <span className="auth-logo">DM</span>
        <div>
          <h1>DOM Modifier</h1>
          <p>Đăng nhập để sử dụng</p>
        </div>
      </div>

      {notice ? <div className="auth-notice">{notice}</div> : null}

      <form className="auth-form" onSubmit={handleSubmit}>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            autoFocus
          />
        </label>

        <label>
          Mật khẩu
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error ? <div className="auth-error">{error}</div> : null}

        <button type="submit" className="auth-submit" disabled={busy}>
          {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </button>
      </form>

      <p className="auth-foot">
        Mỗi tài khoản chỉ dùng được trên một thiết bị. Cần đổi máy? Liên hệ quản trị viên.
      </p>
    </div>
  );
}

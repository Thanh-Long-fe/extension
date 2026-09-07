/**
 * Bọc quanh App: chỉ cho vào khi có phiên hợp lệ.
 *
 * Ba trạng thái khớp vòng đời trong useAuth: đang kiểm tra -> hoặc màn đăng
 * nhập, hoặc App kèm một thanh tài khoản mảnh có nút đăng xuất.
 */

import { App } from '../App';
import { useAuth } from '../hooks/useAuth';
import { LoginScreen } from './LoginScreen';

export function AuthGate() {
  const { state, signIn, signOut } = useAuth();

  if (state.status === 'checking') {
    return <div className="auth-loading">Đang kiểm tra phiên…</div>;
  }

  if (state.status === 'anonymous') {
    return <LoginScreen notice={state.notice} onSignIn={signIn} />;
  }

  return (
    <div className="auth-wrap">
      <div className="auth-bar">
        <span className="auth-bar-dot" title="Đã đăng nhập" />
        <span className="auth-bar-email">{state.user.email}</span>
        <button type="button" className="auth-bar-signout" onClick={() => void signOut()}>
          Đăng xuất
        </button>
      </div>
      <div className="auth-app-slot">
        <App />
      </div>
    </div>
  );
}

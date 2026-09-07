/**
 * Cổng đăng nhập của popup.
 *
 * Vòng đời một lần mở popup:
 *   1. Đọc phiên đã lưu. Không có -> hiện màn đăng nhập.
 *   2. Có phiên -> GỌI /api/auth/me để backend phán quyết (không tự tin vào
 *      token đang lưu: tài khoản có thể vừa bị khóa / hết hạn / gỡ thiết bị).
 *   3. /me OK -> vào app. /me từ chối -> xóa phiên, hiện màn đăng nhập kèm lý do.
 *
 * Popup bị hủy mỗi lần đóng, nên bước kiểm tra này chạy lại mỗi lần mở — đúng
 * như yêu cầu "mở lên là check xem còn hợp lệ không".
 */

import { useCallback, useEffect, useState } from 'react';

import { fetchMe, login as apiLogin } from '@/auth/auth-api';
import { clearSession, getSession } from '@/auth/session-store';
import type { AuthErrorCode, SessionUser } from '@/auth/types';

type AuthState =
  | { status: 'checking' }
  | { status: 'anonymous'; notice: string | null }
  | { status: 'authed'; user: SessionUser };

export interface UseAuth {
  state: AuthState;
  /** Trả về lý do thất bại để form hiển thị, hoặc null nếu thành công. */
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
}

/** Lý do nào thì nên xóa hẳn phiên (khác với chỉ gõ sai mật khẩu lần này). */
function shouldDropSession(code: AuthErrorCode): boolean {
  return (
    code === 'account_inactive' ||
    code === 'account_expired' ||
    code === 'device_mismatch' ||
    code === 'user_not_found' ||
    code === 'invalid_credentials' // token hết hạn cũng rơi vào đây
  );
}

export function useAuth(): UseAuth {
  const [state, setState] = useState<AuthState>({ status: 'checking' });

  const verify = useCallback(async () => {
    const session = await getSession();
    if (!session) {
      setState({ status: 'anonymous', notice: null });
      return;
    }

    const result = await fetchMe(session.accessToken);

    if (result.ok) {
      setState({ status: 'authed', user: result.user });
      return;
    }

    // Mất mạng thì GIỮ phiên lại, chỉ báo không vào được — đừng bắt đăng nhập lại
    // chỉ vì rớt Wi-Fi. Các lý do còn lại là tài khoản/thiết bị thật sự hết hiệu lực.
    if (result.code === 'network_error') {
      setState({ status: 'anonymous', notice: result.reason });
      return;
    }

    if (shouldDropSession(result.code)) {
      await clearSession();
    }
    setState({ status: 'anonymous', notice: result.reason });
  }, []);

  useEffect(() => {
    void verify();
  }, [verify]);

  const signIn = useCallback(async (email: string, password: string): Promise<string | null> => {
    const outcome = await apiLogin(email, password);
    if (outcome.ok) {
      setState({ status: 'authed', user: outcome.session.user });
      return null;
    }
    return outcome.reason;
  }, []);

  const signOut = useCallback(async () => {
    await clearSession();
    setState({ status: 'anonymous', notice: null });
  }, []);

  return { state, signIn, signOut };
}

/**
 * Gọi API đăng nhập từ popup.
 *
 * fetch được thẳng từ trang extension vì manifest có host_permissions
 * ["<all_urls>"] — Chrome bỏ qua CORS cho các host đó. Không cần đưa origin
 * chrome-extension:// vào cấu hình CORS của backend.
 *
 * Toàn bộ hàm ở đây KHÔNG ném ra ngoài: mọi kết cục — kể cả mất mạng — đều trả
 * về một AuthOutcome để UI xử lý bằng một nhánh switch duy nhất.
 */

import { API_BASE_URL } from './constants';
import type { AuthErrorCode, AuthOutcome, LoginResponse, SessionUser } from './types';
import { getStoredDeviceId, saveSession } from './session-store';

/** ProblemDetails (RFC 7807) + trường "code" backend thêm vào. */
interface ProblemDetails {
  title?: string;
  detail?: string;
  code?: string;
}

/** Các mã lỗi backend trả (UserSessionErrorCodes) đều nằm trong AuthErrorCode. */
function toErrorCode(raw: string | undefined): AuthErrorCode {
  switch (raw) {
    case 'invalid_credentials':
    case 'user_not_found':
    case 'account_inactive':
    case 'account_expired':
    case 'device_mismatch':
      return raw;
    default:
      return 'unknown';
  }
}

async function readProblem(response: Response): Promise<ProblemDetails> {
  try {
    return (await response.json()) as ProblemDetails;
  } catch {
    return {};
  }
}

/**
 * Đăng nhập. Tự đính deviceId đã lưu (nếu có) để backend nhận ra máy cũ khi
 * token trước đã hết hạn. Lần đầu tiên deviceId là null -> backend cấp mới.
 */
export async function login(email: string, password: string): Promise<AuthOutcome> {
  const deviceId = await getStoredDeviceId();

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, deviceId }),
    });
  } catch {
    return {
      ok: false,
      code: 'network_error',
      reason: `Không kết nối được tới máy chủ (${API_BASE_URL}). Kiểm tra API đã chạy chưa.`,
    };
  }

  if (!response.ok) {
    const problem = await readProblem(response);
    return {
      ok: false,
      code: toErrorCode(problem.code),
      reason: problem.detail ?? problem.title ?? `Đăng nhập thất bại (lỗi ${response.status}).`,
    };
  }

  const data = (await response.json()) as LoginResponse;
  const session = {
    accessToken: data.accessToken,
    expiresAt: data.expiresAt,
    deviceId: data.deviceId,
    user: data.user,
  };
  await saveSession(session);

  return { ok: true, session };
}

/**
 * Hỏi backend phiên hiện tại còn dùng được không. Backend đọc trạng thái mới
 * nhất từ DB nên đây là chỗ bắt được: tài khoản bị khóa, hết hạn, bị admin gỡ
 * thiết bị, hoặc thiết bị khác đã chiếm chỗ.
 *
 * @returns SessionUser mới nếu hợp lệ; ngược lại là lý do bị từ chối.
 */
export async function fetchMe(
  accessToken: string,
): Promise<{ ok: true; user: SessionUser } | { ok: false; code: AuthErrorCode; reason: string }> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return {
      ok: false,
      code: 'network_error',
      reason: `Không kết nối được tới máy chủ (${API_BASE_URL}).`,
    };
  }

  if (response.ok) {
    return { ok: true, user: (await response.json()) as SessionUser };
  }

  // 401: token sai/hết hạn. 403/409: tài khoản hoặc thiết bị không còn hợp lệ.
  const problem = await readProblem(response);
  const code = response.status === 401 ? 'invalid_credentials' : toErrorCode(problem.code);
  return {
    ok: false,
    code,
    reason: problem.detail ?? problem.title ?? 'Phiên đăng nhập không còn hợp lệ.',
  };
}

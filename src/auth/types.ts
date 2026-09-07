/**
 * Kiểu dữ liệu của phần đăng nhập. Các field phản hồi khớp DTO ở backend
 * (MyApi/Features/Auth/UserAuthDtos.cs).
 */

/** Thông tin tài khoản backend trả về, dùng để hiển thị. */
export interface SessionUser {
  id: string;
  email: string;
  role: string;
  expiredAt: string;
  isActive: boolean;
  deviceBoundAt: string | null;
}

/**
 * Phiên lưu trong chrome.storage.local.
 *
 * deviceId được giữ lại RIÊNG khỏi token: token hết hạn thì bỏ đi, nhưng deviceId
 * phải sống tiếp để lần đăng nhập sau chứng minh "vẫn là cái máy cũ". Mất deviceId
 * (gỡ cài / xóa storage) = bị coi là máy mới, phải nhờ admin gỡ thiết bị.
 */
export interface StoredSession {
  accessToken: string;
  /** ISO UTC. */
  expiresAt: string;
  deviceId: string;
  user: SessionUser;
}

/** Phản hồi của POST /api/auth/login. */
export interface LoginResponse {
  accessToken: string;
  expiresAt: string;
  deviceId: string;
  user: SessionUser;
}

/**
 * Kết quả một lần đăng nhập hoặc kiểm tra phiên, đã dịch sang thứ UI cần biết.
 *  - ok: cho vào.
 *  - reason: câu hiển thị cho người dùng.
 *  - code: mã máy đọc (khớp UserSessionErrorCodes ở backend), để quyết định
 *    có nên xóa phiên đang lưu hay chỉ cho nhập lại mật khẩu.
 */
export type AuthOutcome =
  | { ok: true; session: StoredSession }
  | { ok: false; reason: string; code: AuthErrorCode };

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'user_not_found'
  | 'account_inactive'
  | 'account_expired'
  | 'device_mismatch'
  | 'network_error'
  | 'unknown';

/**
 * Đọc/ghi phiên trong chrome.storage.local.
 *
 * Chỉ nơi này chạm tới storage của phiên, để mọi thay đổi hình dạng dữ liệu
 * gói gọn một chỗ. deviceId cố ý được giữ lại khi xóa phiên (xem clearSession).
 */

import { SESSION_STORAGE_KEY, TOKEN_EXPIRY_SKEW_MINUTES } from './constants';
import type { StoredSession } from './types';

/** Bộ nhớ tách riêng cho deviceId, sống lâu hơn token. */
const DEVICE_ID_KEY = 'dm_device_id';

export async function getSession(): Promise<StoredSession | null> {
  try {
    const result = await chrome.storage.local.get(SESSION_STORAGE_KEY);
    const session = result[SESSION_STORAGE_KEY] as StoredSession | undefined;
    return session ?? null;
  } catch {
    return null;
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  await chrome.storage.local.set({
    [SESSION_STORAGE_KEY]: session,
    // Lưu song song để clearSession xóa token nhưng vẫn nhớ máy.
    [DEVICE_ID_KEY]: session.deviceId,
  });
}

/**
 * Xóa phiên (token + thông tin user) nhưng GIỮ deviceId.
 *
 * Đăng xuất hay hết hạn không có nghĩa là đổi máy — lần đăng nhập sau vẫn phải
 * nhận ra đây là thiết bị cũ, nếu không mỗi lần token hết hạn user lại bị đá vì
 * "thiết bị khác". Xóa hẳn deviceId chỉ xảy ra khi gỡ cài extension.
 */
export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(SESSION_STORAGE_KEY);
}

/** deviceId đã lưu, để gửi kèm khi đăng nhập lại. null nếu chưa từng đăng nhập. */
export async function getStoredDeviceId(): Promise<string | null> {
  try {
    const result = await chrome.storage.local.get(DEVICE_ID_KEY);
    return (result[DEVICE_ID_KEY] as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Token còn hạn không, tính cả một khoảng đệm.
 *
 * Kiểm ở client CHỈ để đỡ gọi một request chắc chắn hỏng. Backend mới là nơi
 * quyết định — hạn nằm trong token và đã được ký.
 */
export function isTokenFresh(session: StoredSession): boolean {
  const expiresMs = new Date(session.expiresAt).getTime();
  const skewMs = TOKEN_EXPIRY_SKEW_MINUTES * 60_000;
  return Number.isFinite(expiresMs) && expiresMs - skewMs > Date.now();
}

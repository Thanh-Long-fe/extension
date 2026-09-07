/**
 * Cấu hình phần đăng nhập của extension.
 *
 * Extension gọi thẳng API từ popup được vì manifest đã có
 * host_permissions ["<all_urls>"] — Chrome cấp quyền cross-origin nên CORS của
 * backend không áp cho các origin chrome-extension://. Vì vậy không cần thêm
 * origin của extension vào Cors:AllowedOrigins ở backend.
 */

/**
 * Địa chỉ backend. Đổi ở ĐÚNG một chỗ này rồi `npm run build` lại là xong.
 *
 * Đang trỏ tạm tới server qua IP thuần, HTTP, không cổng (tức cổng 80) —
 * nên API trên server phải lắng nghe ở cổng 80 (ví dụ map -p 80:8080). Nếu API
 * vẫn ở 8080 thì đổi thành 'http://165.99.14.219:8080'.
 *  - Local docker:  http://localhost:8080
 *  - Local dotnet:  http://localhost:5133
 */
export const API_BASE_URL = 'http://165.99.14.219';

/**
 * Khóa lưu phiên trong chrome.storage.local.
 *
 * Dùng storage.local chứ không phải sessionStorage: phiên phải sống qua lần
 * đóng/mở popup và qua khởi động lại trình duyệt. storage.local chỉ extension
 * này đọc được — trang web không chạm tới được, khác hẳn cookie hay localStorage
 * của một tab.
 */
export const SESSION_STORAGE_KEY = 'dm_auth_session';

/** Số phút trước khi token hết hạn thì đã coi là cần đăng nhập lại. */
export const TOKEN_EXPIRY_SKEW_MINUTES = 1;

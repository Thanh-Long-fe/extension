# Kiến trúc DOM Modifier

Tài liệu này để đọc CẠNH code, không phải đọc thay code. Mục tiêu: sau 15 phút
bạn biết mở file nào khi có thứ gì đó hỏng.

---

## 1. Toàn bộ dự án trong một câu

> Ghi nhớ những gì bạn sửa trong DevTools, rồi tự sửa lại y như vậy sau mỗi lần
> trang tải lại.

Nghe đơn giản, nhưng có một chỗ khó khiến toàn bộ phần còn lại phức tạp theo:

**Sau khi F5, cái node bạn đã sửa KHÔNG CÒN TỒN TẠI nữa.** Trình duyệt dựng một
cây DOM hoàn toàn mới. Không có id nào để bám, và trên các trang như Facebook thì
class cũng bị băm (`x108nfp6`) và đổi giữa các lần deploy.

Nên bài toán thật không phải "lưu lại thay đổi", mà là:

> Làm sao nhận ra "vẫn là cái node đó" trong một cây DOM hoàn toàn mới?

Đó là lý do tồn tại của `fingerprint.ts` và `element-matcher.ts` — hai file khó
nhất trong dự án.

---

## 2. Hai kiểu dữ liệu cần hiểu (bắt đầu từ đây)

Cả dự án xoay quanh đúng hai thứ trong `src/shared/types.ts`.

### `Change` — MỘT lần sửa

Không lưu cả cục HTML. Chỉ lưu đúng phần đã đổi:

```ts
{
  type: 'text',            // sửa chữ
  value: '600050',         // giá trị MỚI
  oldValue: '55000',       // giá trị GỐC của trang
  textNodeIndex: 0,        // mảnh chữ thứ mấy trong element
  target: { ... },         // ElementFingerprint — xem dưới
  enabled: true,           // user có tick không
  confidence: 0.9,         // độ chắc "do người sửa" (0..1)
  source: 'devtools',      // 'devtools' | 'app'
}
```

Có 7 loại `type`: `text`, `attribute`, `style`, `class`, `visibility`, `remove`,
`insert`. Mỗi loại thêm vài trường riêng, nhưng khung chung là `BaseChange`.

**Vì sao lưu diff chứ không lưu HTML:** lưu HTML thì lúc áp lại phải ghi đè cả
khối, đè luôn lên phần app vừa render — đánh nhau với React và thua. Lưu diff thì
chỉ động vào đúng một ô, phần còn lại của trang không bị đụng tới.

### `ElementFingerprint` — "cái node đó trông như thế nào"

Đây là phần khó hiểu nhất, nên nói kỹ.

Không có một dấu hiệu nào đủ tin cậy, nên ta chụp **hàng chục dấu hiệu yếu** rồi
để matcher cân chúng lại với nhau:

```ts
{
  tag: 'span',                  // tên thẻ
  id, testId, ariaLabel, ...    // dấu hiệu MẠNH (thường không có)
  ownText: '55000',             // chữ của riêng element
  text: '55000',                // chữ của cả cây con
  semanticClasses: [],          // class do người đặt tên
  volatileClasses: ['x108nfp6'],// class do máy sinh
  path: 'body>div:2>span:0',    // đường đi từ gốc
  ancestors: [ ... ],           // 6 đời cha ông gần nhất
  childIndex, tagIndex, depth,  // vị trí trong đám anh em
  rect,                         // toạ độ (chỉ dùng phá thế hoà)
}
```

**Cặp trường dễ gây bối rối nhất — `ownText` và `ownTextAlt`:**

Sửa chữ làm chính element đổi danh tính, mà nó lại tồn tại ở HAI trạng thái tại
hai thời điểm khác nhau:

| Thời điểm | Trang hiển thị |
|---|---|
| Vừa sửa tay xong | `600050` |
| Sau F5, trang render lại | `55000` |
| Sau khi ta áp lại | `600050` |
| React render đè | `55000` |

Chọn nhớ một bên là chắc chắn hỏng ở nửa còn lại. Nên `ownText` giữ chữ **gốc**,
`ownTextAlt` giữ chữ **mới**, và matcher chấp nhận cả hai.

---

## 3. Luồng chạy

### Khi bạn sửa trong DevTools

```
DevTools sửa DOM
  → MutationObserver bắt được          observer.ts
  → đoán "người sửa hay app render?"   recorder.ts   (phần đoán mò)
  → dựng Change + Fingerprint          fingerprint.ts
  → cất vào buffer trong RAM           recorder.ts
  → tự lưu sau 350ms                   index.ts → background → storage
```

### Khi bạn F5

```
document_start
  → đọc bản nháp ĐỒNG BỘ từ sessionStorage    index.ts (bản gương)
  → nạp vào replayer ngay, không chờ ai
React dựng ra element
  → MutationObserver thấy
  → vá NGAY trong microtask, trước khi trình duyệt vẽ
  → tìm lại element                            element-matcher.ts
  → ghi giá trị mới vào                        replayer.ts
React render đè lên
  → guard phát hiện, áp lại                    index.ts (onSettled)
```

---

## 4. Mỗi file làm gì

### Phần lõi (`src/content/` — chạy trong trang web)

| File | Việc | Đụng vào khi nào |
|---|---|---|
| `index.ts` | **Nhạc trưởng.** Nối mọi thứ, quản timing, bản nháp, guard | Đổi thời điểm áp, sửa logic bản nháp, thêm lệnh mới cho popup |
| `recorder.ts` | Mutation thô → `Change`. Đoán người-hay-app | Ghi sót, ghi nhầm đồ app, hoặc muốn ghi thêm loại sửa mới |
| `element-matcher.ts` | Tìm lại element trong DOM mới | Áp nhầm element, hoặc không tìm ra element |
| `replayer.ts` | Áp `Change` lên DOM, nhớ cách hoàn tác | Tìm đúng element rồi mà ghi sai chỗ / không ghi được |
| `fingerprint.ts` | Chụp danh tính element | Muốn thêm dấu hiệu nhận dạng mới |
| `observer.ts` | Một MutationObserver dùng chung + cơ chế "nín" | Gần như không bao giờ. Đụng vào là dễ tạo vòng lặp vô tận |
| `style-manager.ts` | Thẻ `<style>` riêng để thắng inline style của React | Sửa style không ăn |
| `dom-utils.ts` | Hàm tiện ích DOM, không có logic nghiệp vụ | Cần thêm một hàm dùng chung |
| `spa.ts` | Phát hiện đổi route mà không reload | Trang đổi route mà extension không nhận ra |
| `highlight.ts` | Viền phát sáng khi bấm nút ngắm | Sửa giao diện phần tô sáng |

### Phần còn lại

| Thư mục | Việc |
|---|---|
| `src/shared/` | Kiểu dữ liệu, hằng số, giao thức message. **Bắt đầu đọc từ đây** |
| `src/background/` | Service worker — nơi DUY NHẤT ghi được xuống storage |
| `src/storage/` | Đọc/ghi `chrome.storage`, kiểm tra dữ liệu hỏng |
| `src/popup/` | Giao diện React. Dumb components, mọi logic nằm ở `useController` |

---

## 5. Hỏng chỗ nào mở file nào

| Triệu chứng | Mở |
|---|---|
| Sửa mà không ghi lại được | `recorder.ts` → mấy hàm `classify*` |
| Ghi nhầm cả đồ app tự render | `recorder.ts` → `classify*`, chỉnh `HUMAN_BATCH_MAX` |
| Ghi được nhưng F5 vẫn mất | `index.ts` khối bản nháp + `snapshot-storage.ts` |
| F5 xong áp nhầm element | `element-matcher.ts` + `fingerprint.ts` |
| Áp đúng element nhưng sai chỗ | `replayer.ts` → `pickTextNode` |
| Áp được rồi nhưng React xoá mất | `index.ts` → `onSettled` (guard) |
| Style áp không ăn | `style-manager.ts` |
| Trang nhấp nháy | `recorder.ts` → `isAppOverwrite` / `isUndone` |
| Popup trống, báo mất kết nối | `messages.ts` + `service-worker.ts` |

---

## 6. Ba quyết định trông kỳ quặc nhưng có lý do

### Vì sao dùng `<style>` riêng thay vì `el.style`?

React ghi đè **toàn bộ** thuộc tính `style` của node ở mỗi lượt render. Ghi inline
là bị xoá sau một khung hình. Một rule trong stylesheet riêng thì nằm ngoài
element, không bị đụng tới, và mang `!important` nên vẫn thắng inline style.

### Vì sao "nín" (suppress) lại phải vét hàng đợi?

Callback của MutationObserver chạy trong microtask **sau** phần việc đồng bộ. Nên
một cờ boolean sẽ trở lại `false` trước khi callback chạy, và những lần ghi của
chính ta trông y hệt hoạt động của trang → recorder ghi lại chính mình → vòng lặp
vô tận. Cách thoát duy nhất là tự vét sạch hàng đợi bằng `takeRecords()`.

### Vì sao mọi hằng số đều là số lẻ khó hiểu?

`HUMAN_BATCH_MAX = 4`, `INTERACTION_QUIET_MS = 400`, `matchThreshold = 0.55`...

Vì **không có đáp án đúng**. Không tồn tại API nào của trình duyệt nói "người vừa
sửa node này trong DevTools". Toàn bộ `recorder.ts` là phỏng đoán đã hiệu chỉnh.
Những con số này là kết quả thử nghiệm, không phải chân lý — chỉnh được, và nên
chỉnh khi gặp trang cư xử khác.

---

## 7. Nếu chỉ đọc được 3 file

1. **`src/shared/types.ts`** — bản đồ dữ liệu. Không hiểu file này thì mọi file
   khác đều vô nghĩa.
2. **`src/content/index.ts`** — đọc phần comment đầu file. Nó nói rõ ba thứ mà
   file này sở hữu và không ai khác sở hữu.
3. **`src/content/recorder.ts`** — đọc comment đầu file. Nó giải thích vì sao cả
   file chỉ là phỏng đoán.

Ba file trên đủ để hiểu bộ khung. `element-matcher.ts` để dành khi nào thật sự
cần đụng vào nó.

---

## 8. Điều nên biết

Toàn bộ code chạy trên trang của người khác, trang đó có thể thù địch hoặc chỉ
đơn giản là kỳ lạ. Nên bạn sẽ thấy khắp nơi:

- `try/catch` bọc gần như mọi thứ — một trang làm hàm của ta nổ không được phép
  giết cả extension
- không hàm public nào được ném lỗi ra ngoài
- không bao giờ giả định một node còn sống

Trông thừa thãi, nhưng bỏ đi thì extension chết lặng trên đúng những trang khó —
mà đó lại chính là những trang nó sinh ra để phục vụ.

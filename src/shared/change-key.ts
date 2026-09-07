/**
 * Định danh "hai thay đổi này là CÙNG một lần sửa".
 *
 * Cần dùng ở ba chỗ khác nhau nên phải nằm chung một nơi, nếu không chúng sẽ
 * trôi khỏi nhau và cùng một lần sửa sẽ bị đếm thành hai:
 *   - storage, khi gộp change mới vào snapshot đã có (`appendChanges`);
 *   - recorder, để gộp các change khôi phục từ bản nháp với lần sửa tiếp theo
 *     của user lên đúng element đó sau khi F5;
 *   - mọi chỗ cần so hai change mà không có element sống trong tay.
 *
 * Chỉ băm những trường SỐNG SÓT qua một lần render lại: class và toạ độ đổi
 * mỗi lượt React commit, nếu đưa vào thì cùng một lần sửa lại trông như sửa
 * mới và snapshot sẽ phình vô hạn.
 */

import { hashString } from './id';
import type { Change, ElementFingerprint } from './types';

/**
 * Ký tự ngăn cách giữa các trường khi băm.
 *
 * Không bao giờ xuất hiện trong HTML hay CSS selector, nên "ab" + "c" không thể
 * băm ra cùng chuỗi với "a" + "bc".
 */
const SEP = '';

/** Băm gọn phần định danh ổn định của element mà change trỏ tới. */
export function fingerprintIdentity(fp: ElementFingerprint): string {
  return hashString(
    [
      fp.tag,
      fp.id ?? '',
      fp.testId ?? '',
      fp.ariaLabel ?? '',
      fp.role ?? '',
      fp.ownText ?? '',
      // BẮT BUỘC phải có `anchorSelector`. `path` là đường đi TƯƠNG ĐỐI với
      // anchor, nên hai node ở hai vùng khác nhau của trang hoàn toàn có thể
      // mang CÙNG một path. Ví dụ kinh điển: bảng mà mỗi <tr> có id riêng — khi
      // đó anchor của mỗi ô chính là dòng của nó, và path của ô thứ hai ở MỌI
      // dòng đều là 'td:1'.
      //
      // Thiếu nó thì hai lần sửa ở hai dòng khác nhau băm ra CÙNG một khoá, và
      // `Recorder.restore` bỏ im lặng cái thứ hai: user sửa hai ô, chỉ một ô
      // được áp lại, ô kia biến mất khỏi cả bản nháp lẫn storage.
      fp.anchorSelector ?? '',
      fp.path,
    ].join(SEP),
  );
}

/**
 * "Ô" nào trên element đang bị sửa: tên attribute / thuộc tính CSS / vị trí text
 * node. Hai thuộc tính style là hai thay đổi; hai lần ghi vào cùng thuộc tính là
 * một. Insert thì kèm cả vị trí và nội dung, vì hai lần chèn khác nhau vào cùng
 * một chỗ là hai thay đổi hợp lệ chứ không phải sửa lại.
 */
export function changeDiscriminator(change: Change): string {
  switch (change.type) {
    case 'text':
      return String(change.textNodeIndex);
    case 'attribute':
      return change.attribute;
    case 'style':
      return change.property;
    case 'insert':
      return `${change.position}:${hashString(change.html)}`;
    default:
      return '';
  }
}

/** Khoá đầy đủ: element nào + loại sửa gì + ô nào. */
export function changeKey(change: Change): string {
  return `${fingerprintIdentity(change.target)}|${change.type}|${changeDiscriminator(change)}`;
}

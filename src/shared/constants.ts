/** Tunables shared by recorder, matcher and replayer. */

export const EXTENSION_VERSION = '0.1.0';

/* ------------------------------ fingerprints ------------------------------ */

/** How many ancestors get captured in a fingerprint. */
export const ANCESTOR_DEPTH = 6;

/** Normalised text longer than this is truncated in fingerprints. */
export const TEXT_FINGERPRINT_MAX = 120;

/** Ancestor text is truncated harder — it is only a coarse locality hint. */
export const ANCESTOR_TEXT_MAX = 60;

/** Attributes treated as strong identity signals, in priority order. */
export const TEST_ID_ATTRS = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-cy',
  'data-qa',
  'data-automation-id',
] as const;

/** Attributes captured verbatim into the fingerprint. */
export const IDENTITY_ATTRS = [
  'role',
  'aria-label',
  'name',
  'type',
  'placeholder',
  'alt',
  'title',
  'href',
  'src',
  'for',
  'value',
] as const;

/** Never recorded, never replayed — either ours or pure noise. */
export const IGNORED_ATTRS = new Set([
  'data-dm-id',
  'data-dm-hidden',
  'data-dm-inserted',
  'data-dm-highlight',
]);

/** Attribute names whose values churn on every render in common frameworks. */
export const VOLATILE_ATTRS = new Set([
  'style', // handled separately as StyleChange
  'aria-activedescendant',
  'aria-owns',
  'aria-controls',
  'aria-describedby',
  'data-reactid',
  'data-react-checksum',
  'data-visualcompletion',
  'data-thumb',
  'data-focus-visible-added',
]);

/* --------------------------- generated-name filter ------------------------- */

/**
 * Patterns for class names / ids that a build tool or CSS-in-JS runtime made up.
 * Matching tokens are dropped from fingerprints because they change between
 * deploys (and, on Facebook, between sessions).
 */
export const GENERATED_NAME_PATTERNS: RegExp[] = [
  /^x[0-9a-z]{4,}$/, // Facebook atomic CSS: x1abc2de
  /^css-[0-9a-z]+$/i, // emotion / styled-components
  /^sc-[0-9a-zA-Z]{5,}$/, // styled-components
  /^jsx-\d+$/, // styled-jsx
  /^_[0-9a-zA-Z]{5,}$/, // various hashed prefixes
  /^[a-zA-Z][\w-]*__[0-9a-zA-Z]{5,}$/, // CSS modules: Button__a1b2c3
  /^[a-zA-Z][\w-]*--[0-9a-f]{6,}$/, // BEM-ish with a hash tail
  /^[a-zA-Z][\w-]*_[0-9a-z]{5,}$/, // Button_a1b2c
  /^ng-tns-c\d+/, // Angular
  /^[0-9a-f]{8,}$/i, // bare hash
  /^v-[0-9a-f]{6,}$/, // Vue scoped
];

/** A token is also considered generated when it is long and looks like entropy. */
export const GENERATED_ENTROPY_MIN_LENGTH = 12;

/**
 * Số class băm giữ lại cho một element / một tổ tiên.
 *
 * Có trần vì atomic CSS sinh ra rất nhiều: một node Facebook đội 30+ token là
 * chuyện thường, nhân với 6 tổ tiên là mỗi fingerprint phình lên vài KB — mà
 * bản nháp thì phải nằm gọn trong hạn mức của `chrome.storage.session`.
 * Danh sách đã sắp xếp nên phần giữ lại là tất định.
 */
export const MAX_VOLATILE_CLASSES = 12;
export const MAX_ANCESTOR_VOLATILE_CLASSES = 6;

/**
 * Điểm cộng tối đa từ việc khớp class băm, cộng SAU khi đã chuẩn hoá điểm.
 *
 * Cố tình lớn hơn `matchMargin` mặc định (0.06) để phá được thế hoà giữa hai
 * ứng viên giống hệt nhau, nhưng vẫn nhỏ để không lấn át các tín hiệu thật.
 * Vì là cộng thêm chứ không nằm trong mẫu số, class băm đã đổi sau một lần
 * deploy chỉ đơn giản là không cộng gì — không kéo tụt ai xuống dưới ngưỡng.
 */
export const VOLATILE_CLASS_BOOST = 0.1;

/**
 * Hệ số phạt khi element không có danh tính nào ngoài CHỮ, mà chữ lại chỉ gần
 * giống chứ không khớp tuyệt đối.
 *
 * 0.6 được chọn để một ứng viên "gần giống" tụt từ khoảng 0.89 xuống ~0.53 —
 * rơi xuống DƯỚI `matchThreshold` mặc định (0.55), tức là bị loại hẳn thay vì
 * thắng. Còn ứng viên khớp tuyệt đối thì không bị đụng tới, nên khoảng cách
 * giữa hai bên nới rộng ra và `matchMargin` cũng dễ thoả hơn.
 */
export const TEXT_ONLY_FUZZY_PENALTY = 0.6;

/**
 * Chênh lệch tối thiểu về VỊ TRÍ để phá thế hoà giữa hai ứng viên sát điểm.
 *
 * Dùng cho đúng cảnh hai node giống hệt nhau về nội dung (hai ô cùng chữ trong
 * một bảng): mọi tín hiệu khác đều trùng khít, chỉ còn đường đi và thứ tự trong
 * đám anh em là phân biệt được. Ngưỡng đặt vừa phải — đủ để bỏ qua sai số làm
 * tròn, nhưng không cần cao vì hai node ở hai chỗ khác nhau thì chỉ số vị trí
 * của chúng lệch nhau rõ rệt chứ không lệch chút xíu.
 */
export const STRUCTURAL_TIEBREAK_MARGIN = 0.15;

/* -------------------------------- matching -------------------------------- */

/** Hard cap on candidates scored per fingerprint, to keep replay cheap. */
export const MAX_CANDIDATES = 240;

/** Weight table for the candidate scorer. Scores are normalised by the sum of
 *  the weights that were actually *available* in the fingerprint. */
export const MATCH_WEIGHTS = {
  tag: 14,
  id: 30,
  testId: 26,
  ariaLabel: 16,
  role: 8,
  name: 8,
  type: 5,
  placeholder: 6,
  alt: 5,
  title: 5,
  href: 10,
  src: 6,
  ownText: 20,
  text: 14,
  textLen: 4,
  semanticClasses: 12,
  attrKeys: 5,
  childTagSignature: 6,
  ancestors: 18,
  path: 10,
  childIndex: 4,
  depth: 4,
  rect: 4,
} as const;

/** Penalty applied when the candidate's tag differs from the fingerprint's. */
export const TAG_MISMATCH_PENALTY = 0.45;

/* --------------------------------- replay --------------------------------- */

/** Attribute stamped on elements we style, so our CSS rules can target them. */
export const DM_ID_ATTR = 'data-dm-id';
export const DM_HIDDEN_ATTR = 'data-dm-hidden';
export const DM_INSERTED_ATTR = 'data-dm-inserted';
export const DM_HIGHLIGHT_ATTR = 'data-dm-highlight';

/** id of the <style> element the replayer owns. */
export const DM_STYLE_ELEMENT_ID = '__dom_modifier_styles__';

/** Backoff schedule (ms) for changes that have not matched yet after a load. */
export const RETRY_SCHEDULE_MS = [0, 150, 400, 900, 1800, 3200, 5000, 8000, 12000];

/**
 * Làn nhanh: khi còn change chưa khớp mà trang vừa THÊM node, replay sau đúng
 * một khung hình thay vì ngồi chờ debounce của guard.
 *
 * Vì sao cần: đường bình thường (element hiện ra -> đợi DOM "lặng" 120ms, trang
 * bận thì lên trần 1000ms -> mới replay) làm thay đổi hiện lên chậm sau nội
 * dung khoảng nửa giây — đủ để mắt người thấy con số cũ nhấp nháy rồi mới đổi.
 * Cái debounce đó sinh ra cho việc CANH GIỮ (đừng đánh nhau với app từng nhịp
 * render); còn lúc đang SĂN TÌM element thì mỗi mili-giây chờ là một mili-giây
 * user nhìn thấy giá trị chưa sửa.
 */
export const FAST_RETRY_MS = 16;

/**
 * Khoảng cách tối thiểu giữa hai lượt làn nhanh. Trang render như bão (Facebook
 * lúc hydrate) mà lượt nào cũng quét matcher thì tự mình làm nghẽn trang; giữ
 * sàn 50ms nghĩa là tệ nhất vẫn ~20 lượt dò/giây — quá đủ để cảm giác là "ngay
 * lập tức", mà chi phí thì có trần.
 */
export const FAST_RETRY_MIN_GAP_MS = 50;

/**
 * Số node element thêm vào trong một quãng render đủ để coi là "app vừa dựng
 * một mảng giao diện", chứ không phải nhích một chữ.
 *
 * Đây là tín hiệu thay cho việc đếm giờ: không có mốc "trang đã load xong" nào
 * tồn tại trên SPA, nhưng "trang vừa dựng thêm một mảng UI" thì quan sát được,
 * và đó chính là lúc đáng đi tìm lại những element chưa khớp.
 */
export const SUBSTANTIAL_RENDER_NODES = 12;

/**
 * Số lần tối đa được mở lại cửa sổ tìm kiếm cho một change chưa khớp.
 *
 * Không phải để tiết kiệm CPU (một lượt dò chỉ chấm tối đa MAX_CANDIDATES ứng
 * viên), mà để một change trỏ vào element đã biến mất vĩnh viễn không bám theo
 * trang mãi mãi. Đặt cao vì trang cuộn vô hạn render rất nhiều lần một cách
 * hoàn toàn hợp lệ.
 */
export const MAX_MATCH_RENEWALS = 100;

/* -------------------------------- recording -------------------------------- */

/**
 * A mutation batch larger than this is almost certainly a framework render,
 * not a human editing one node in DevTools.
 */
export const HUMAN_BATCH_MAX = 4;

/** Mutations arriving within this window of a real page interaction are suspect. */
export const INTERACTION_QUIET_MS = 400;

/** Confidence assigned to each recorder verdict. */
export const CONFIDENCE = {
  human: 0.9,
  likely: 0.65,
  uncertain: 0.4,
  app: 0.15,
} as const;

/** Confidence floor per filter level. */
export const RECORD_FILTER_FLOOR = {
  all: 0,
  likely: 0.35,
  strict: 0.8,
} as const;

/* ------------------------------- bản nháp ---------------------------------- */

/**
 * Gộp các lần ghi bản nháp trong khoảng này thành một lượt.
 *
 * Kéo thanh chọn màu trong DevTools sinh hàng chục change mỗi giây; không gộp
 * thì mỗi lần kéo là một message tới service worker và một lượt ghi storage.
 * Đủ ngắn để một cú F5 ngay sau khi sửa vẫn kịp lưu.
 */
export const DRAFT_SAVE_DEBOUNCE_MS = 350;

/** Số route tối đa giữ trong bản nháp của một tab (SPA đi qua lại nhiều trang). */
export const MAX_DRAFT_ROUTES = 8;

/** Số change tối đa giữ cho mỗi route trong bản nháp. */
export const MAX_DRAFT_CHANGES = 200;

/**
 * Trần dung lượng cho bản nháp của một tab, tính bằng ký tự JSON.
 *
 * `chrome.storage.session` mặc định chỉ có 10MB cho TOÀN BỘ extension, mà một
 * InsertChange có thể tới 8KB. Trần này giữ cho một tab lỡ tay không nuốt hết
 * hạn mức của các tab khác.
 */
export const MAX_DRAFT_BYTES = 512 * 1024;

/* --------------------------------- misc ----------------------------------- */

/** Popup polls the content script at this interval while it is open. */
export const POPUP_POLL_MS = 700;

/** Max pending changes kept in memory before the oldest are dropped. */
export const MAX_PENDING = 500;

/** Elements we never fingerprint or touch. */
export const SKIPPED_TAGS = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template']);

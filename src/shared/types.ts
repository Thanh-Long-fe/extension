/**
 * Shared data model for the whole extension.
 *
 * Everything persisted in chrome.storage and everything crossing the
 * popup <-> background <-> content-script boundary is defined here.
 * All of it must stay structured-clone / JSON safe: no DOM nodes, no functions,
 * no Map/Set, no undefined-only fields that matter.
 */

export const SCHEMA_VERSION = 1;

/* ========================================================================== */
/* Element fingerprint                                                        */
/* ========================================================================== */

/**
 * A compact description of one ancestor, used to re-locate an element even
 * when its own attributes changed.
 */
export interface AncestorFingerprint {
  tag: string;
  /** Only kept when it looks stable (not a hashed/generated id). */
  id?: string;
  role?: string;
  ariaLabel?: string;
  /** data-testid / data-test-id / data-test / data-cy / data-qa */
  testId?: string;
  /** class tokens that survived the "looks generated" filter */
  semanticClasses: string[];
  /** class tokens do máy sinh — chỉ dùng làm điểm cộng, xem `ElementFingerprint` */
  volatileClasses?: string[];
  /** normalised textContent, truncated */
  text?: string;
  /** index among element siblings */
  childIndex: number;
  /** index among same-tag element siblings */
  tagIndex: number;
}

/**
 * The identity of a single element, captured at record time and used at
 * replay time to find "the same" element in a freshly rendered DOM.
 *
 * Deliberately redundant: any single signal may break, the matcher scores
 * all of them together.
 */
export interface ElementFingerprint {
  v: 1;
  /** lowercase tagName, e.g. "button" */
  tag: string;

  /* --- strong, near-unique signals --- */
  id?: string;
  testId?: string;
  role?: string;
  ariaLabel?: string;
  /** aria-labelledby resolved to text, when present */
  ariaLabelledByText?: string;
  name?: string;
  type?: string;
  placeholder?: string;
  alt?: string;
  title?: string;
  /** href/src reduced to pathname + search (origin stripped) */
  href?: string;
  src?: string;

  /* --- medium signals --- */
  /** class tokens that do NOT look machine-generated */
  semanticClasses: string[];
  /**
   * Class tokens TRÔNG NHƯ do máy sinh (`x108nfp6`, `css-1a2b3c`, …).
   *
   * Không sống qua một lần deploy nên không bao giờ được làm tín hiệu chính —
   * nhưng trong phạm vi một phiên (đúng vòng đời của bản nháp) thì hoàn toàn ổn
   * định. Với node kiểu `<span class="x108nfp6">55000</span>`, không có chúng
   * thì element chẳng còn danh tính nào ngoài chữ, mà chữ lại là thứ vừa bị
   * sửa. Matcher dùng chúng làm ĐIỂM CỘNG sau chuẩn hoá, không bao giờ trừ.
   */
  volatileClasses?: string[];
  /** how many class tokens the element had in total (incl. generated ones) */
  classCount: number;
  /** sorted names of attributes present (values excluded), generated ones filtered */
  attrKeys: string[];

  /* --- content signals --- */
  /** text from direct child text nodes only, normalised */
  ownText?: string;
  /** full textContent, normalised + truncated to TEXT_FINGERPRINT_MAX */
  text?: string;
  /** length of the untruncated normalised textContent */
  textLen: number;

  /**
   * Biến thể text của element ở trạng thái CÒN LẠI, chỉ có với `TextChange`.
   *
   * Sửa chữ của một element làm chính nó đổi danh tính, mà element đó lại tồn
   * tại ở HAI trạng thái vào hai thời điểm khác nhau:
   *   - vừa tải trang xong, hoặc vừa bị React render đè -> chữ GỐC;
   *   - ngay sau khi user sửa tay, hoặc sau khi replayer áp xong -> chữ MỚI.
   *
   * Matcher phải bắt được cả hai, nếu không thì hoặc là hỏng lúc F5, hoặc là
   * hỏng ngay lúc đang sửa. Trường chính giữ chữ GỐC (đó là thứ trang sạch hiển
   * thị, và cũng là nhãn dễ hiểu nhất cho user), mấy trường `*Alt` này giữ chữ
   * MỚI. Việc chấm điểm lấy giá trị tốt hơn trong hai bên.
   */
  ownTextAlt?: string;
  textAlt?: string;
  textLenAlt?: number;

  /* --- structural signals --- */
  childIndex: number;
  tagIndex: number;
  depth: number;
  /** child element tags joined, e.g. "span,span,svg" */
  childTagSignature: string;
  /** nearest-first, capped at ANCESTOR_DEPTH */
  ancestors: AncestorFingerprint[];
  /**
   * Structural path from document root (or from `anchorSelector` when present),
   * e.g. "body>div:2>div:0>button:1" where :n is tagIndex.
   */
  path: string;
  /** A CSS selector for a stable ancestor that scopes the search, when one exists. */
  anchorSelector?: string;

  /* --- weak signal --- */
  /** viewport-independent box, used only as a tie-breaker */
  rect?: { x: number; y: number; w: number; h: number };
}

/* ========================================================================== */
/* Changes                                                                    */
/* ========================================================================== */

export type ChangeType =
  | 'text'
  | 'attribute'
  | 'style'
  | 'class'
  | 'visibility'
  | 'remove'
  | 'insert';

/** Where a recorded change came from. */
export type ChangeSource = 'devtools' | 'app' | 'manual';

export interface BaseChange {
  id: string;
  type: ChangeType;
  /** identity of the element this change applies to */
  target: ElementFingerprint;
  /** short human label for the element, e.g. `button "Create"` */
  targetLabel: string;
  /** short human label for the change, e.g. `text -> "My Campaign"` */
  label: string;
  /** previous value, for the UI only */
  oldSummary: string;
  /** new value, for the UI only */
  newSummary: string;
  createdAt: number;
  /** included when saving / replaying */
  enabled: boolean;
  /** recorder's 0..1 estimate that a human (not the app) made this change */
  confidence: number;
  source: ChangeSource;
}

export interface TextChange extends BaseChange {
  type: 'text';
  value: string;
  oldValue: string;
  /** index of the text node among the target's child *text* nodes */
  textNodeIndex: number;
}

export interface AttributeChange extends BaseChange {
  type: 'attribute';
  attribute: string;
  /** null means "remove this attribute" */
  value: string | null;
  oldValue: string | null;
}

export interface StyleChange extends BaseChange {
  type: 'style';
  /** kebab-case CSS property, e.g. "background-color" */
  property: string;
  /** empty string means "remove this declaration" */
  value: string;
  priority: 'important' | '';
  oldValue: string;
}

/**
 * Class edits are stored as a *delta*, not as the full class attribute:
 * frameworks rewrite `class` constantly, so replaying a whole value fights
 * the framework, while adding/removing tokens composes with it.
 */
export interface ClassChange extends BaseChange {
  type: 'class';
  added: string[];
  removed: string[];
}

export interface VisibilityChange extends BaseChange {
  type: 'visibility';
  hidden: boolean;
}

export interface RemoveChange extends BaseChange {
  type: 'remove';
  /** true = detach the node; false = display:none (safer with React) */
  hard: boolean;
}

export type InsertPosition = 'before' | 'after' | 'firstChild' | 'lastChild';

export interface InsertChange extends BaseChange {
  type: 'insert';
  /** serialised outerHTML of the inserted subtree (sanitised on apply) */
  html: string;
  position: InsertPosition;
}

export type Change =
  | TextChange
  | AttributeChange
  | StyleChange
  | ClassChange
  | VisibilityChange
  | RemoveChange
  | InsertChange;

/** A change recorded in this session but not yet committed to a snapshot. */
export type PendingChange = Change;

/* ========================================================================== */
/* Bản nháp (draft)                                                           */
/* ========================================================================== */

/**
 * Các thay đổi đã ghi nhưng CHƯA được commit vào snapshot, của đúng một route.
 *
 * Đây là mắt xích giúp "sửa trong DevTools rồi F5 mà không mất": buffer pending
 * của Recorder vốn chỉ nằm trong RAM, nên mỗi lần nó đổi ta ghi luôn xuống
 * `chrome.storage.session` để lần tải trang sau nạp lại và replay lên DOM.
 */
export interface DraftEntry {
  /** URL đầy đủ lúc ghi — chỉ để hiển thị và chẩn đoán. */
  url: string;
  updatedAt: number;
  changes: Change[];
}

/**
 * Toàn bộ bản nháp của MỘT tab, tách theo route.
 *
 * Tách theo route vì SPA đổi URL mà không reload: nếu gộp chung, các sửa đổi ở
 * route cũ sẽ bị lần autosave của route mới ghi đè mất.
 */
export interface DraftRecord {
  v: 1;
  /** khoá = origin + pathname (xem `routeKeyOf` trong url-match.ts) */
  routes: Record<string, DraftEntry>;
}

/* ========================================================================== */
/* Snapshots                                                                  */
/* ========================================================================== */

export type UrlMatchMode = 'origin' | 'path' | 'url';

export interface Snapshot {
  id: string;
  name: string;
  /** e.g. "https://adsmanager.facebook.com" */
  origin: string;
  /**
   * Glob pattern matched according to `matchMode`.
   * `*` matches any run of characters, `?` matches one. Everything else literal.
   */
  urlPattern: string;
  matchMode: UrlMatchMode;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
  changes: Change[];
}

/* ========================================================================== */
/* Settings                                                                   */
/* ========================================================================== */

export type LogLevel = 'silent' | 'error' | 'info' | 'debug';

/**
 * How aggressively the recorder filters mutations that were probably produced
 * by the page itself rather than by a human in DevTools.
 */
export type RecordFilter = 'all' | 'likely' | 'strict';

export interface Settings {
  /** master on/off for replaying */
  enabled: boolean;
  /** keep re-applying changes when the app re-renders over them */
  guard: boolean;
  /** debounce window for the guard's re-apply, ms */
  guardDebounceMs: number;
  /** wait this long after DOM-ready before the first replay, ms */
  initialDelayMs: number;
  /** how long to keep retrying changes that have not matched yet, ms */
  matchTimeoutMs: number;
  /** minimum normalised score (0..1) for the matcher to accept an element */
  matchThreshold: number;
  /** minimum gap between best and runner-up score, else the match is "ambiguous" */
  matchMargin: number;
  recordFilter: RecordFilter;
  /**
   * Tự lưu các thay đổi chưa commit xuống bản nháp, rồi tự khôi phục + áp lại
   * chúng sau khi F5 / reload. Đây là công tắc của toàn bộ cơ chế draft.
   */
  autoDraft: boolean;
  /**
   * Chỉ áp lại tự động những thay đổi mà recorder tin là do người sửa
   * (`source === 'devtools'`). Tắt đi thì mọi thay đổi đang bật đều được áp lại,
   * kể cả loại điểm tin cậy thấp — dễ đánh nhau với app hơn.
   */
  draftDevtoolsOnly: boolean;
  /** show the number of applied changes on the toolbar badge */
  showBadge: boolean;
  logLevel: LogLevel;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  guard: true,
  guardDebounceMs: 120,
  // 0 chứ không phải 300: chờ thêm sau DOM-ready chỉ làm giá trị cũ hiện ra
  // lâu hơn trước mắt user. Một lượt replay trượt (trang chưa render gì) rẻ
  // hơn nhiều so với nửa giây nhìn thấy con số chưa sửa; lịch retry và làn
  // nhanh theo mutation sẽ bắt kịp ngay khi element thật sự xuất hiện.
  initialDelayMs: 0,
  matchTimeoutMs: 15000,
  matchThreshold: 0.55,
  matchMargin: 0.06,
  recordFilter: 'likely',
  autoDraft: true,
  draftDevtoolsOnly: true,
  showBadge: true,
  logLevel: 'error',
};

/* ========================================================================== */
/* Matching                                                                   */
/* ========================================================================== */

export type MatchStrategy =
  | 'cache'
  | 'id'
  | 'testid'
  | 'unique-attr'
  | 'anchored'
  | 'text'
  | 'scored'
  | 'path'
  | 'none';

/** Result of resolving a fingerprint against the live DOM. Not serialisable. */
export interface MatchResult {
  element: Element | null;
  /** 0..1 */
  score: number;
  /** 0..1, score of the second-best candidate (0 when there was none) */
  runnerUpScore: number;
  candidatesConsidered: number;
  strategy: MatchStrategy;
  /** best candidate cleared the threshold but did not beat the runner-up by `matchMargin` */
  ambiguous: boolean;
}

/** Per-change outcome of one replay pass. Serialisable (for the popup). */
export type ApplyStatus = 'applied' | 'unchanged' | 'unmatched' | 'ambiguous' | 'failed' | 'skipped';

export interface ApplyReport {
  changeId: string;
  status: ApplyStatus;
  score: number;
  strategy: MatchStrategy;
  error?: string;
}

export interface ReplayStats {
  applied: number;
  unchanged: number;
  unmatched: number;
  ambiguous: number;
  failed: number;
  skipped: number;
  durationMs: number;
  /** how many replay passes have run since the last navigation */
  runs: number;
}

export const EMPTY_REPLAY_STATS: ReplayStats = {
  applied: 0,
  unchanged: 0,
  unmatched: 0,
  ambiguous: 0,
  failed: 0,
  skipped: 0,
  durationMs: 0,
  runs: 0,
};

/* ========================================================================== */
/* Content-script state (what the popup renders)                              */
/* ========================================================================== */

export interface ActiveSnapshotState {
  id: string;
  name: string;
  urlPattern: string;
  matchMode: UrlMatchMode;
  enabled: boolean;
  total: number;
  applied: number;
  unmatched: number;
  ambiguous: number;
}

export interface ContentState {
  version: string;
  url: string;
  origin: string;
  path: string;
  /** master switch, mirrors Settings.enabled */
  enabled: boolean;
  recording: boolean;
  /** recorded-but-unsaved changes, newest last */
  pending: PendingChange[];
  /** how many raw mutation records were seen and discarded as app noise */
  filteredOut: number;
  /** số thay đổi được khôi phục từ bản nháp trong lần tải trang này */
  restoredCount: number;
  /** lần cuối bản nháp được ghi xuống storage, null khi chưa ghi lần nào */
  draftSavedAt: number | null;
  activeSnapshots: ActiveSnapshotState[];
  lastReplayAt: number | null;
  stats: ReplayStats;
  reports: ApplyReport[];
}

/* ========================================================================== */
/* Storage shape                                                              */
/* ========================================================================== */

export interface StorageShape {
  schemaVersion: number;
  snapshots: Record<string, Snapshot>;
  settings: Settings;
}

export interface ExportBundle {
  kind: 'dom-modifier-export';
  schemaVersion: number;
  exportedAt: number;
  snapshots: Snapshot[];
}

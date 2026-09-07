/**
 * The recorder: raw `MutationRecord`s in, semantic `Change`s out.
 *
 * Why this file is mostly heuristics
 * ----------------------------------
 * There is no browser API that says "a human just edited this node in the
 * DevTools Elements panel". DevTools edits arrive through the exact same
 * MutationObserver channel as React's own re-renders, so the recorder has to
 * *guess*. Every rule below is a guess, tuned for the target site class
 * (React SPAs with hashed atomic class names that re-render constantly):
 *
 *   1. Size. A human changes one node. A framework commit touches dozens.
 *      More than HUMAN_BATCH_MAX records in one batch  ->  it is the app.
 *   2. Silence. This is by far the strongest signal available. A person
 *      poking at the Styles pane is *not* clicking/typing/scrolling the page,
 *      so anything landing within INTERACTION_QUIET_MS of a real interaction
 *      is capped at CONFIDENCE.uncertain.
 *   3. Shape. An inline `style` write in a small quiet batch is the DevTools
 *      Styles pane, near enough always. Attribute/text edits on an element
 *      that already existed are almost as good. Node insertions are the
 *      weakest signal, because that is exactly what rendering looks like.
 *
 * Everything here runs on hostile third-party pages, so no public method is
 * allowed to throw and no DOM node is ever assumed to still be alive.
 */

import { fingerprintIdentity } from '@/shared/change-key';
import {
  ANCESTOR_DEPTH,
  ANCESTOR_TEXT_MAX,
  CONFIDENCE,
  HUMAN_BATCH_MAX,
  IGNORED_ATTRS,
  INTERACTION_QUIET_MS,
  MAX_PENDING,
  RECORD_FILTER_FLOOR,
  TEXT_FINGERPRINT_MAX,
  VOLATILE_ATTRS,
} from '@/shared/constants';
import { uid } from '@/shared/id';
import { log } from '@/shared/logger';
import type {
  AttributeChange,
  BaseChange,
  Change,
  ChangeSource,
  ClassChange,
  ElementFingerprint,
  InsertChange,
  InsertPosition,
  RecordFilter,
  RemoveChange,
  StyleChange,
  TextChange,
} from '@/shared/types';
import {
  isElement,
  isGeneratedName,
  isOurNode,
  isSkippedElement,
  isTextNode,
  normalizeText,
  textNodeIndexOf,
  textNodesOf,
  truncate,
} from './dom-utils';
import { describeFingerprint, fingerprintAncestor, fingerprintElement } from './fingerprint';

/* ========================================================================== */
/* Local tunables                                                             */
/* ========================================================================== */

/** Popup rows are one line; longer values are elided. */
const SUMMARY_MAX = 60;

/** Serialised subtrees bigger than this are rendering noise, not a paste. */
const MAX_INSERT_HTML = 8 * 1024;

/** Bound on the sibling walk used to place a node that was already detached. */
const SIBLING_SCAN_MAX = 500;

/**
 * Số ký tự tối đa đọc từ cây con của một tổ tiên, khớp với `ancestorText` trong
 * fingerprint.ts — quét nhiều hơn cũng vô ích vì kết quả bị cắt còn 60 ký tự.
 */
const ANCESTOR_TEXT_SCAN_MAX = 512;

/** Reused for batches with no removals, so the common case allocates nothing. */
const NO_MOVED_NODES: ReadonlySet<Element> = new Set<Element>();

/* ========================================================================== */
/* Options                                                                    */
/* ========================================================================== */

/**
 * Wiring supplied by the content orchestrator. The recorder deliberately owns
 * no observer and no messaging of its own so it stays unit-testable and so a
 * single shared MutationObserver can feed the recorder, the guard and the
 * replayer from one callback.
 */
export interface RecorderOptions {
  onChange: (change: Change, isNew: boolean) => void;
  /**
   * Một change RỜI KHỎI buffer.
   *
   * Bắt buộc phải có, không phải tuỳ chọn: change biến mất theo ba đường mà
   * người gọi không nhìn thấy — user sửa rồi sửa về như cũ (`isUndone`), buffer
   * đầy phải bỏ cái cũ nhất (`trim`), popup xoá một dòng. Nếu không báo ra thì
   * replayer vẫn giữ change đó và tiếp tục áp giá trị đã bị hoàn tác đè lên
   * trang, còn bản nháp trên storage thì hồi sinh nó sau lần F5 kế tiếp.
   */
  onRemoved: (changeId: string) => void;
  filter: RecordFilter;
}

/* ========================================================================== */
/* Internal helpers                                                           */
/* ========================================================================== */

/** One parsed inline declaration. */
interface StyleDecl {
  value: string;
  priority: 'important' | '';
}

/** Per-batch facts every classification rule keys off. */
interface BatchContext {
  /** number of records in the batch */
  size: number;
  /** batch is small enough to plausibly be one hand edit */
  small: boolean;
  /** no real user interaction with the page in the last INTERACTION_QUIET_MS */
  quiet: boolean;
}

/** A change is "from DevTools" once we are at least `likely` sure of it. */
function sourceFor(confidence: number): ChangeSource {
  return confidence >= CONFIDENCE.likely ? 'devtools' : 'app';
}

/** Split a raw `class` attribute value into tokens. */
function classTokens(value: string | null): Set<string> {
  const out = new Set<string>();
  if (!value) return out;
  for (const token of value.split(/\s+/)) {
    if (token) out.add(token);
  }
  return out;
}

/**
 * Attribute equality that ignores whitespace churn, so a re-render that
 * rewrites `class="a  b"` as `class="a b"` is not recorded as an edit.
 */
function sameAttrValue(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return normalizeText(a) === normalizeText(b);
}

/**
 * A fingerprint built from an already-detached node can end up with nothing
 * but a tag name, which the matcher could never resolve. Reject those instead
 * of storing a change that is guaranteed to fail at replay time.
 */
function isUsableFingerprint(fp: ElementFingerprint): boolean {
  return Boolean(
    fp.id ||
      fp.testId ||
      fp.ariaLabel ||
      fp.ownText ||
      fp.text ||
      fp.semanticClasses.length > 0 ||
      fp.ancestors.length > 0,
  );
}

/** Cheap tag sniff for insert labels only — never used as identity. */
function tagFromHtml(html: string): string {
  const m = /^\s*<\s*([a-zA-Z][\w:-]*)/.exec(html);
  const tag = m ? m[1] : undefined;
  return tag ? tag.toLowerCase() : 'node';
}

/** `describeFingerprint` touches a lot of optional fields; never let it throw. */
function safeDescribe(fp: ElementFingerprint): string {
  try {
    return describeFingerprint(fp);
  } catch {
    return fp.tag;
  }
}

/**
 * "Ô" nào đang bị sửa, theo cách nhìn của RECORDER.
 *
 * Cố ý khác `changeDiscriminator` của `@/shared/change-key` ở chỗ insert: bên đó
 * băm cả HTML, vì với một snapshot thì hai lần chèn nội dung khác nhau vào cùng
 * một chỗ là hai thay đổi hợp lệ. Còn ở đây thì ngược lại — user bấm "Edit as
 * HTML" hai lần trên cùng một node phải ra MỘT thay đổi; băm HTML vào khoá sẽ
 * biến nó thành hai, và lượt replay sau sẽ chèn ra hai node.
 */
function recorderDiscriminator(change: Change): string {
  switch (change.type) {
    case 'attribute':
      return change.attribute;
    case 'style':
      return change.property;
    case 'text':
      return String(change.textNodeIndex);
    default:
      return '';
  }
}

/**
 * Khoá dedup theo ELEMENT SỐNG. Mạnh nhất khi node còn trong tài liệu, vì nó
 * dựa trên chính identity của node (WeakMap) nên miễn nhiễm với việc framework
 * viết lại class/attribute liên tục.
 */
function elementDedupKey(elementKey: string, change: Change): string {
  return `el:${elementKey}|${change.type}|${recorderDiscriminator(change)}`;
}

/**
 * Khoá dedup theo FINGERPRINT. Dùng cho change khôi phục từ bản nháp: sau F5
 * chúng chưa gắn với node nào, nên chỉ còn fingerprint để nhận ra "đây vẫn là
 * lần sửa đó". Tiền tố khác nhau nên hai không gian khoá không bao giờ đụng.
 */
function fingerprintDedupKey(change: Change): string {
  return `fp:${fingerprintIdentity(change.target)}|${change.type}|${recorderDiscriminator(change)}`;
}

/**
 * Text của element như TRƯỚC khi một text node con của nó bị sửa.
 *
 * VÌ SAO CẦN: fingerprint được chụp bên trong callback của MutationObserver,
 * tức là SAU khi user đã sửa xong. Nên nó ghi nhớ element bằng đúng nội dung
 * MỚI — trong khi lần tải trang kế tiếp, matcher lại gặp element mang nội dung
 * CŨ do trang tự render ra.
 *
 * Với một `<span>` chỉ có chữ (không id, không testid, class thì bị băm) thì
 * text CHÍNH LÀ danh tính của nó. Hậu quả là hỏng kép: `element-matcher` gom
 * ứng viên bằng cách tìm đúng chuỗi `ownText`/`text` trên trang, nên element
 * không lọt nổi vào danh sách ứng viên; và kể cả có lọt thì ba tín hiệu nặng
 * nhất (ownText 20đ, text 14đ, textLen 4đ) đều trỏ sai.
 *
 * Nói cách khác: fingerprint phải mô tả element ở trạng thái GỐC của trang,
 * vì đó mới là thứ matcher gặp khi trang vừa tải xong.
 */
function textBeforeEdit(el: Element, index: number, oldData: string): { own: string; full: string } {
  let own = '';
  let full = '';
  let textIndex = 0;
  for (let node = el.firstChild; node; node = node.nextSibling) {
    if (isTextNode(node)) {
      // Đúng text node vừa bị sửa thì thay bằng nội dung cũ của nó.
      const data = textIndex === index ? oldData : (node.nodeValue ?? '');
      own += data;
      full += data;
      textIndex++;
    } else {
      full += node.textContent ?? '';
    }
  }
  return { own: normalizeText(own), full: normalizeText(full) };
}

/**
 * Text của cả cây con dưới `root`, nhưng thay nội dung của đúng một text node.
 *
 * Dùng để lùi `text` của các TỔ TIÊN về trạng thái trước khi sửa. Không lùi thì
 * `ancestors[0].text` vẫn mang chữ MỚI, mà tổ tiên là tín hiệu nặng thứ hai
 * (18đ, chỉ sau ownText 20đ) — với một wrapper bó sát kiểu `<div><span>55000
 * </span></div>` thì text của tổ tiên đúng bằng text của con, nên sai một chỗ
 * là sai cả hai.
 *
 * Có trần ký tự vì hàm này chạy trong callback của MutationObserver, và tổ tiên
 * gần `<body>` thì cây con là cả trang. `ancestorText` cũng chỉ đọc 512 ký tự
 * đầu rồi cắt còn 60, nên quét thêm cũng không đổi được kết quả.
 */
function subtreeTextWith(root: Element, target: Text, replacement: string, cap: number): string {
  let out = '';
  const walk = (node: Node): void => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (out.length >= cap) return;
      if (isTextNode(n)) out += n === target ? replacement : (n.nodeValue ?? '');
      else if (isElement(n)) walk(n);
    }
  };
  try {
    walk(root);
  } catch {
    /* cây con nửa vời trong lúc render: phần lấy được vẫn dùng tốt */
  }
  return out;
}

/**
 * Element anh/chị em gần nhất theo một hướng, bỏ qua text node và comment.
 * Trả về node đã rời khỏi tài liệu thì vô dụng, nên chỉ nhận node còn kết nối.
 */
function nearestElementSibling(from: Node | null, dir: 'previous' | 'next'): Element | null {
  let node: Node | null = from;
  let scanned = 0;
  while (node && scanned < SIBLING_SCAN_MAX) {
    if (isElement(node) && node.isConnected) return node;
    node = dir === 'previous' ? node.previousSibling : node.nextSibling;
    scanned++;
  }
  return null;
}

/**
 * True when the pending change no longer represents an edit — the user typed
 * something and then typed the original back, or added and removed the same
 * class. Such a change must disappear rather than replay a no-op.
 */
function isUndone(change: Change): boolean {
  switch (change.type) {
    case 'text':
      return change.value === change.oldValue;
    case 'attribute':
      return change.value === change.oldValue;
    case 'style':
      return change.value === change.oldValue;
    case 'class':
      return change.added.length === 0 && change.removed.length === 0;
    default:
      return false;
  }
}

/**
 * Human-readable strings for the popup, derived purely from the change itself
 * so they can be recomputed after every coalescing update.
 */
function summarize(change: Change): { label: string; oldSummary: string; newSummary: string } {
  switch (change.type) {
    case 'text': {
      const oldSummary = truncate(normalizeText(change.oldValue), SUMMARY_MAX);
      const newSummary = truncate(normalizeText(change.value), SUMMARY_MAX);
      return { label: `text → "${newSummary}"`, oldSummary, newSummary };
    }
    case 'attribute': {
      const oldSummary =
        change.oldValue === null ? '(absent)' : truncate(normalizeText(change.oldValue), SUMMARY_MAX);
      const newSummary =
        change.value === null ? '(removed)' : truncate(normalizeText(change.value), SUMMARY_MAX);
      const label =
        change.value === null ? `remove @${change.attribute}` : `@${change.attribute} = "${newSummary}"`;
      return { label, oldSummary, newSummary };
    }
    case 'style': {
      const oldSummary = change.oldValue === '' ? '(unset)' : truncate(change.oldValue, SUMMARY_MAX);
      const withPriority = change.priority ? `${change.value} !important` : change.value;
      const newSummary = change.value === '' ? '(unset)' : truncate(withPriority, SUMMARY_MAX);
      const label =
        change.value === '' ? `unset ${change.property}` : `${change.property}: ${newSummary}`;
      return { label, oldSummary, newSummary };
    }
    case 'class': {
      const parts = [
        ...change.added.map((t) => `+${t}`),
        ...change.removed.map((t) => `-${t}`),
      ];
      return {
        label: `class ${truncate(parts.join(' '), SUMMARY_MAX)}`,
        oldSummary: truncate(change.removed.join(' '), SUMMARY_MAX) || '(none)',
        newSummary: truncate(change.added.join(' '), SUMMARY_MAX) || '(none)',
      };
    }
    case 'visibility': {
      return {
        label: change.hidden ? 'hide element' : 'show element',
        oldSummary: change.hidden ? 'visible' : 'hidden',
        newSummary: change.hidden ? 'hidden' : 'visible',
      };
    }
    case 'remove': {
      const what = change.target.ownText || change.target.text || change.target.tag;
      return {
        label: `remove ${change.target.tag}`,
        oldSummary: truncate(what, SUMMARY_MAX),
        newSummary: change.hard ? 'detached' : 'hidden',
      };
    }
    case 'insert': {
      return {
        label: `insert <${tagFromHtml(change.html)}>`,
        oldSummary: '(absent)',
        newSummary: truncate(normalizeText(change.html), SUMMARY_MAX),
      };
    }
  }
}

/** Fill in the three display strings from the change's own data. */
function relabel(change: Change): Change {
  const parts = summarize(change);
  change.label = parts.label;
  change.oldSummary = parts.oldSummary;
  change.newSummary = parts.newSummary;
  return change;
}

/* ========================================================================== */
/* Recorder                                                                   */
/* ========================================================================== */

/**
 * Buffers the human-looking DOM edits seen since `start()`.
 *
 * It is fed by the orchestrator's shared MutationObserver (`ingest`) and by the
 * orchestrator's capture-phase input listeners (`noteInteraction`); it never
 * subscribes to anything itself.
 */
export class Recorder {
  private readonly onChange: (change: Change, isNew: boolean) => void;
  private readonly onRemoved: (changeId: string) => void;
  private filter: RecordFilter;

  private isRecording = false;
  /** performance.now() of the last real pointer/key/wheel event on the page. */
  private lastInteractionAt = -Infinity;
  private droppedRecords = 0;
  /** Bao nhiêu change được nạp lại từ bản nháp trong lần tải trang này. */
  private restoredChanges = 0;

  /** pending changes, oldest first (the popup renders newest last) */
  private readonly order: Change[] = [];
  /** dedup key -> the live change object in `order` */
  private readonly byKey = new Map<string, Change>();
  /** change id -> dedup key, so removals can keep both maps in sync */
  private readonly keyOf = new Map<string, string>();

  /**
   * Stable local identity per touched element. A WeakMap keyed by the node
   * itself survives class/attribute churn (unlike any selector) and lets a
   * detached node keep its key, which is what makes "37 changes" mean 37 edits.
   */
  private readonly elementKeys = new WeakMap<Element, string>();
  /** every element we have ever seen a mutation for — the "existed already" set */
  private readonly knownElements = new WeakSet<Element>();
  /** elements we recorded an InsertChange for, so re-inserts still coalesce */
  private readonly insertedElements = new WeakSet<Element>();

  /** Detached scratch element used to parse inline style text properly. */
  private styleProbe: HTMLElement | null = null;

  constructor(options: RecorderOptions) {
    this.onChange = options.onChange;
    this.onRemoved = options.onRemoved;
    this.filter = options.filter;
  }

  /* ------------------------------ lifecycle ------------------------------ */

  /**
   * Arms the recorder. Deliberately does NOT create a MutationObserver: the
   * orchestrator owns one shared observer for the whole content script and
   * hands batches to `ingest`.
   */
  start(): void {
    this.isRecording = true;
    // The user just clicked something (the popup button, the toolbar icon), so
    // treat the next INTERACTION_QUIET_MS as noisy rather than as DevTools.
    this.lastInteractionAt = this.now();
    this.droppedRecords = 0;
    log.info('recorder: started, filter =', this.filter);
  }

  stop(): void {
    this.isRecording = false;
    this.lastInteractionAt = this.now();
    log.info('recorder: stopped,', this.order.length, 'pending');
  }

  get recording(): boolean {
    return this.isRecording;
  }

  /**
   * Changes the confidence floor for *future* records only. Already-buffered
   * changes are left alone on purpose: the user may have curated them, and
   * silently deleting rows when a dropdown moves is hostile.
   */
  setFilter(filter: RecordFilter): void {
    this.filter = filter;
  }

  /**
   * Called from capture-phase pointerdown/keydown/wheel listeners. The single
   * most valuable input this class gets: it is how we know the page is being
   * *used* rather than *edited*.
   */
  noteInteraction(): void {
    this.lastInteractionAt = this.now();
  }

  get filteredOut(): number {
    return this.droppedRecords;
  }

  get restoredCount(): number {
    return this.restoredChanges;
  }

  /* ------------------------------ bản nháp ------------------------------- */

  /**
   * Nạp lại các thay đổi chưa lưu còn sót từ lần tải trang trước.
   *
   * Cố tình KHÔNG phụ thuộc vào cờ recording: người dùng có thể đã bấm dừng ghi
   * rồi mới F5, nhưng những gì họ sửa vẫn là công sức của họ và phải quay lại.
   *
   * Chúng được cất dưới khoá fingerprint chứ không phải khoá element, vì lúc
   * này chưa có node nào để gắn vào — `push()` và `adopt()` sẽ chuyển chúng
   * sang khoá element ngay khi tìm được node thật.
   */
  restore(changes: readonly Change[]): number {
    if (!Array.isArray(changes) || changes.length === 0) return 0;
    let added = 0;
    for (const change of changes) {
      try {
        if (!change?.id || !change.target) continue;
        // Đã có sẵn trong buffer (ví dụ bị gọi restore hai lần): đừng nhân đôi.
        if (this.keyOf.has(change.id)) continue;
        const key = fingerprintDedupKey(change);
        if (this.byKey.has(key)) continue;
        this.byKey.set(key, change);
        this.keyOf.set(change.id, key);
        this.order.push(change);
        added++;
      } catch (e) {
        log.error('recorder: không khôi phục được một thay đổi', e);
      }
    }
    if (added > 0) {
      // Popup hiển thị cũ nhất trước; một mutation có thể đã lọt vào buffer
      // trước khi bootstrap trả lời, nên sắp lại cho đúng thứ tự thời gian.
      this.order.sort((a, b) => a.createdAt - b.createdAt);
      this.restoredChanges += added;
      this.trim();
      log.info('recorder: khôi phục', added, 'thay đổi từ bản nháp');
    }
    return added;
  }

  /**
   * Gắn một change đã khôi phục vào element mà replayer vừa tìm ra.
   *
   * Nếu không làm bước này, lần sửa tiếp theo của user lên đúng element đó sẽ
   * sinh ra một change THỨ HAI thay vì gộp vào change cũ, và trang sẽ có hai
   * thay đổi đánh nhau trên cùng một ô.
   */
  adopt(changeId: string, element: Element): boolean {
    try {
      const current = this.keyOf.get(changeId);
      if (current === undefined) return false;
      // Đã nằm dưới khoá element rồi: không còn gì để làm, nhưng đây là THÀNH
      // CÔNG chứ không phải thất bại — phía gọi dựa vào giá trị trả về để biết
      // có được gỡ khỏi hàng chờ hay không.
      if (!current.startsWith('fp:')) return true;
      const change = this.byKey.get(current);
      if (!change || change.id !== changeId) return false;

      const next = elementDedupKey(this.keyFor(element), change);
      const occupant = this.byKey.get(next);
      if (occupant && occupant !== change) {
        // Ô này đã có change khác chiếm: để nguyên dưới khoá fingerprint còn
        // hơn là ghi đè và làm mất một thay đổi của user.
        log.debug('recorder: bỏ qua adopt, ô đã có change khác', changeId);
        return false;
      }

      this.byKey.delete(current);
      this.byKey.set(next, change);
      this.keyOf.set(changeId, next);
      return true;
    } catch (e) {
      log.error('recorder: adopt thất bại', changeId, e);
      return false;
    }
  }

  /* -------------------------------- ingest ------------------------------- */

  /** Feed one native MutationObserver batch; ignored when not recording. */
  ingest(records: MutationRecord[]): void {
    if (!this.isRecording || records.length === 0) return;
    try {
      const ctx: BatchContext = {
        size: records.length,
        small: records.length <= HUMAN_BATCH_MAX,
        quiet: this.now() - this.lastInteractionAt > INTERACTION_QUIET_MS,
      };
      log.debug('recorder: batch', ctx.size, ctx.quiet ? 'quiet' : 'noisy');
      const moved = this.collectRemovedElements(records);
      for (const record of records) {
        try {
          this.ingestOne(record, ctx, moved);
        } catch (e) {
          this.droppedRecords++;
          log.error('recorder: record failed', e);
        }
      }
    } catch (e) {
      log.error('recorder: ingest failed', e);
    }
  }

  /**
   * Nodes removed anywhere in this batch. A node that is removed and re-added
   * inside one batch is a framework *move*, never a human insertion.
   */
  private collectRemovedElements(records: MutationRecord[]): ReadonlySet<Element> {
    let set: Set<Element> | null = null;
    for (const record of records) {
      if (record.type !== 'childList' || record.removedNodes.length === 0) continue;
      for (const node of record.removedNodes) {
        if (!isElement(node)) continue;
        set ??= new Set<Element>();
        set.add(node);
      }
    }
    return set ?? NO_MOVED_NODES;
  }

  private ingestOne(record: MutationRecord, ctx: BatchContext, moved: ReadonlySet<Element>): void {
    switch (record.type) {
      case 'attributes':
        this.ingestAttribute(record, ctx);
        return;
      case 'characterData':
        this.ingestCharacterData(record, ctx);
        return;
      case 'childList':
        this.ingestChildList(record, ctx, moved);
        return;
      default:
        this.droppedRecords++;
    }
  }

  /* ---------------------------- classification --------------------------- */

  /**
   * Confidence for an attribute/characterData record. Heuristic:
   * oversized batch => app; noisy batch => capped at `uncertain`; a live
   * element in a small quiet batch => `human`.
   */
  private classifyMutation(ctx: BatchContext, alive: boolean, isInlineStyle: boolean): number {
    if (!ctx.small) return CONFIDENCE.app;
    const cap = ctx.quiet ? 1 : CONFIDENCE.uncertain;
    // The Styles pane writes inline styles and essentially nothing else does
    // during a quiet moment, so `style` keeps the human score even when the
    // element is mid-teardown.
    const base = isInlineStyle || alive ? CONFIDENCE.human : CONFIDENCE.uncertain;
    return Math.min(base, cap);
  }

  /**
   * Removing exactly one node while the page is idle looks like "Delete element".
   *
   * Cùng lý do với `classifyAddition`: xoá đúng một node lúc trang im lặng đạt
   * mức `human`, nếu không thì `safeToAutoApply` sẽ chẳng bao giờ áp lại được
   * một lần xoá nào.
   */
  private classifyRemoval(ctx: BatchContext, count: number): number {
    if (!ctx.small || count > 1) return CONFIDENCE.app;
    return ctx.quiet ? CONFIDENCE.human : CONFIDENCE.uncertain;
  }

  /**
   * Insertions are what rendering *is*, so they only score when quiet and tiny.
   *
   * Đúng MỘT node được thêm vào lúc trang hoàn toàn im lặng thì được chấm mức
   * `human`: đó là hình dạng của một cú "Edit as HTML" hay dán node trong
   * DevTools, còn framework thì gần như không bao giờ commit đúng một node lẻ
   * trong lúc không có gì khác xảy ra. Ranh giới này có ý nghĩa thật chứ không
   * phải trang trí: `safeToAutoApply` chỉ tự động chèn lại khi đạt mức `human`,
   * nên nếu ở đây trần là `likely` thì insert sẽ KHÔNG BAO GIỜ được áp lại.
   */
  private classifyAddition(ctx: BatchContext, count: number): number {
    if (!ctx.small || count > HUMAN_BATCH_MAX) return CONFIDENCE.app;
    if (!ctx.quiet) return CONFIDENCE.app;
    return count === 1 ? CONFIDENCE.human : CONFIDENCE.likely;
  }

  private get floor(): number {
    return RECORD_FILTER_FLOOR[this.filter];
  }

  /* ------------------------------ attributes ----------------------------- */

  private ingestAttribute(record: MutationRecord, ctx: BatchContext): void {
    const el = record.target;
    const name = record.attributeName;
    if (!name || !isElement(el) || this.isOffLimits(el)) {
      this.droppedRecords++;
      return;
    }

    if (name === 'style') {
      this.ingestStyle(record, ctx, el);
      return;
    }

    // Our own bookkeeping attributes and the framework's churn attributes are
    // never edits worth replaying.
    if (IGNORED_ATTRS.has(name) || VOLATILE_ATTRS.has(name) || name.startsWith('data-dm-')) {
      this.droppedRecords++;
      return;
    }

    const value = el.getAttribute(name);
    if (sameAttrValue(record.oldValue, value)) {
      this.droppedRecords++;
      return;
    }

    const confidence = this.classifyMutation(ctx, el.isConnected, false);
    if (confidence < this.floor) {
      this.droppedRecords++;
      return;
    }

    if (name === 'class') {
      this.ingestClass(record, el, confidence, value);
      return;
    }

    const fp = this.fingerprintLive(el);
    if (!fp) {
      this.droppedRecords++;
      return;
    }

    const change: AttributeChange = {
      ...this.base(fp, confidence),
      type: 'attribute',
      attribute: name,
      value,
      oldValue: record.oldValue,
    };
    this.push(el, relabel(change));
  }

  /**
   * Class edits are stored as a token delta, and machine-generated tokens are
   * dropped from both sides: replaying `x1abc2de` is meaningless the moment
   * the site redeploys, and fighting the framework over its own atomic classes
   * only produces flicker.
   */
  private ingestClass(
    record: MutationRecord,
    el: Element,
    confidence: number,
    value: string | null,
  ): void {
    const before = classTokens(record.oldValue);
    const after = classTokens(value);

    const added: string[] = [];
    for (const token of after) {
      if (!before.has(token) && !isGeneratedName(token)) added.push(token);
    }
    const removed: string[] = [];
    for (const token of before) {
      if (!after.has(token) && !isGeneratedName(token)) removed.push(token);
    }
    if (added.length === 0 && removed.length === 0) {
      this.droppedRecords++;
      return;
    }

    const fp = this.fingerprintLive(el);
    if (!fp) {
      this.droppedRecords++;
      return;
    }

    const change: ClassChange = { ...this.base(fp, confidence), type: 'class', added, removed };
    this.push(el, relabel(change));
  }

  /**
   * Inline style is diffed *per property* so a DevTools edit that sets two
   * declarations shows up in the popup as two independently toggleable rows.
   */
  private ingestStyle(record: MutationRecord, ctx: BatchContext, el: Element): void {
    const confidence = this.classifyMutation(ctx, el.isConnected, true);
    if (confidence < this.floor) {
      this.droppedRecords++;
      return;
    }

    const before = this.parseStyle(record.oldValue);
    const after = this.parseStyle(el.getAttribute('style'));

    const props = new Set<string>(before.keys());
    for (const prop of after.keys()) props.add(prop);
    if (props.size === 0) {
      this.droppedRecords++;
      return;
    }

    let fp: ElementFingerprint | null = null;
    let emitted = 0;

    for (const prop of props) {
      const from = before.get(prop);
      const to = after.get(prop);
      const oldValue = from ? from.value : '';
      const value = to ? to.value : '';
      const priority: 'important' | '' = to ? to.priority : '';
      // Removed declarations become value '' — that is how the replayer is told
      // to drop the property rather than to write an empty one.
      if (value === oldValue && (from ? from.priority : '') === priority) continue;

      fp ??= this.fingerprintLive(el);
      if (!fp) break;

      const change: StyleChange = {
        ...this.base(fp, confidence),
        type: 'style',
        property: prop,
        value,
        priority,
        oldValue,
      };
      this.push(el, relabel(change));
      emitted++;
    }

    if (emitted === 0) this.droppedRecords++;
  }

  /**
   * Parse an inline style string with a real CSSStyleDeclaration rather than a
   * regex, so shorthands expand exactly the way the browser expands them on
   * both sides of the diff and `!important` survives.
   */
  private parseStyle(cssText: string | null): Map<string, StyleDecl> {
    const out = new Map<string, StyleDecl>();
    const probe = this.probe();
    if (!probe) return out;
    try {
      probe.style.cssText = cssText ?? '';
      for (let i = 0; i < probe.style.length; i++) {
        const prop = probe.style.item(i);
        if (!prop) continue;
        out.set(prop, {
          value: probe.style.getPropertyValue(prop),
          priority: probe.style.getPropertyPriority(prop) === 'important' ? 'important' : '',
        });
      }
    } catch (e) {
      log.error('recorder: could not parse inline style', e);
    } finally {
      try {
        probe.style.cssText = '';
      } catch {
        /* the probe is detached; nothing can observe this */
      }
    }
    return out;
  }

  private probe(): HTMLElement | null {
    if (this.styleProbe) return this.styleProbe;
    try {
      // Detached, never inserted: parsing here produces no mutation records.
      this.styleProbe = document.createElement('div');
    } catch (e) {
      log.error('recorder: no style probe', e);
      this.styleProbe = null;
    }
    return this.styleProbe;
  }

  /* --------------------------- character data ---------------------------- */

  private ingestCharacterData(record: MutationRecord, ctx: BatchContext): void {
    const node = record.target;
    if (!isTextNode(node)) {
      this.droppedRecords++;
      return;
    }
    const parent = node.parentElement;
    if (!parent || this.isOffLimits(parent) || isOurNode(node)) {
      this.droppedRecords++;
      return;
    }

    const value = node.data;
    const oldValue = record.oldValue ?? '';
    if (normalizeText(value) === normalizeText(oldValue)) {
      this.droppedRecords++;
      return;
    }

    const confidence = this.classifyMutation(ctx, parent.isConnected, false);
    if (confidence < this.floor) {
      this.droppedRecords++;
      return;
    }

    // The change is anchored to the parent element (text nodes have no
    // identity of their own), plus the index of this text node among its
    // siblings so a multi-text-node element stays addressable.
    const textNodeIndex = textNodeIndexOf(parent, node);
    if (textNodeIndex < 0) {
      this.droppedRecords++;
      return;
    }

    const fp = this.fingerprintLive(parent);
    if (!fp) {
      this.droppedRecords++;
      return;
    }
    // Bắt buộc: fingerprint vừa chụp đang mang nội dung MỚI. Không lùi về nội
    // dung cũ thì lần tải trang sau sẽ không bao giờ tìm lại được element này.
    this.rewindTextFields(fp, parent, textNodeIndex, oldValue);

    const change: TextChange = {
      ...this.base(fp, confidence),
      type: 'text',
      value,
      oldValue,
      textNodeIndex,
    };
    this.push(parent, relabel(change));
  }

  /**
   * Đưa các trường text của fingerprint về trạng thái trước khi user sửa.
   *
   * Chỉ đụng vào ba trường suy ra từ nội dung; mọi tín hiệu khác (id, testid,
   * class, cấu trúc, tổ tiên) vẫn là ảnh chụp hiện tại vì chúng không bị lần
   * sửa này làm sai lệch.
   */
  private rewindTextFields(
    fp: ElementFingerprint,
    el: Element,
    index: number,
    oldData: string,
  ): void {
    try {
      const before = textBeforeEdit(el, index, oldData);

      // Trạng thái SAU khi sửa — chính là thứ `fingerprintElement` vừa chụp.
      // Phải giữ lại: ngay lúc này trang đang hiển thị nó, nên nếu vứt đi thì
      // guard và nút "tô sáng phần tử" mất dấu element ngay trong lúc user còn
      // đang sửa dở.
      const afterOwn = fp.ownText;
      const afterText = fp.text;
      const afterLen = fp.textLen;

      if (before.own) fp.ownText = truncate(before.own, TEXT_FINGERPRINT_MAX);
      else delete fp.ownText;
      // textLen cố ý là độ dài KHÔNG cắt, đúng như `fingerprintElement` làm.
      fp.textLen = before.full.length;
      if (before.full) fp.text = truncate(before.full, TEXT_FINGERPRINT_MAX);
      else delete fp.text;

      if (afterOwn && afterOwn !== fp.ownText) fp.ownTextAlt = afterOwn;
      else delete fp.ownTextAlt;
      if (afterText && afterText !== fp.text) fp.textAlt = afterText;
      else delete fp.textAlt;
      if (afterLen !== fp.textLen) fp.textLenAlt = afterLen;
      else delete fp.textLenAlt;

      this.rewindAncestorText(fp, el, index, oldData);
    } catch (e) {
      log.error('recorder: không lùi được text của fingerprint', e);
    }
  }

  /** Lùi `text` của từng tổ tiên về trạng thái trước khi sửa, cùng lý do như trên. */
  private rewindAncestorText(
    fp: ElementFingerprint,
    el: Element,
    index: number,
    oldData: string,
  ): void {
    if (fp.ancestors.length === 0) return;
    try {
      const target = textNodesOf(el)[index];
      if (!target) return;
      let cur: Element | null = el.parentElement;
      for (let i = 0; i < fp.ancestors.length && cur; i++) {
        const ancestor = fp.ancestors[i];
        // Tổ tiên không giữ text thì cũng không có gì để lùi.
        if (ancestor.text) {
          const raw = subtreeTextWith(cur, target, oldData, ANCESTOR_TEXT_SCAN_MAX);
          const before = truncate(normalizeText(raw), ANCESTOR_TEXT_MAX);
          if (before) ancestor.text = before;
          else delete ancestor.text;
        }
        cur = cur.parentElement;
      }
    } catch (e) {
      log.error('recorder: không lùi được text của tổ tiên', e);
    }
  }

  /* ------------------------------- childList ----------------------------- */

  private ingestChildList(
    record: MutationRecord,
    ctx: BatchContext,
    moved: ReadonlySet<Element>,
  ): void {
    const parent = isElement(record.target) ? record.target : null;
    let handled = false;

    if (record.removedNodes.length > 0) {
      // Một record vừa bớt vừa thêm là một lần THAY THẾ (DevTools "Edit as
      // HTML", hay framework đổi node), không phải một lần xoá. Ghi nó thành
      // RemoveChange là tự bắn vào chân: lượt replay sau sẽ chèn node mới vào
      // rồi lập tức ẩn chính nó đi, vì fingerprint của node cũ và node mới gần
      // như y hệt nhau.
      if (record.addedNodes.length === 0) {
        this.ingestRemovals(record, ctx, parent);
      } else {
        this.droppedRecords += record.removedNodes.length;
      }
      handled = true;
    }
    if (record.addedNodes.length > 0) {
      this.ingestAdditions(record, ctx, parent, moved);
      handled = true;
    }
    if (!handled) this.droppedRecords++;
  }

  private ingestRemovals(record: MutationRecord, ctx: BatchContext, parent: Element | null): void {
    const confidence = this.classifyRemoval(ctx, record.removedNodes.length);
    if (confidence < this.floor) {
      this.droppedRecords++;
      return;
    }

    for (const node of record.removedNodes) {
      if (!isElement(node)) continue;
      // Mark it known so a later re-add reads as a framework move, not a paste.
      this.knownElements.add(node);
      if (this.isOffLimits(node)) {
        this.droppedRecords++;
        continue;
      }

      const fp = this.fingerprintDetached(node, record, parent);
      if (!fp) {
        this.droppedRecords++;
        continue;
      }

      // hard: false — under React, detaching a node it still owns invites
      // "failed to execute removeChild" crashes and gets undone on the next
      // commit anyway. display:none composes with the framework instead.
      const change: RemoveChange = { ...this.base(fp, confidence), type: 'remove', hard: false };
      this.push(node, relabel(change));
    }
  }

  private ingestAdditions(
    record: MutationRecord,
    ctx: BatchContext,
    parent: Element | null,
    moved: ReadonlySet<Element>,
  ): void {
    const confidence = this.classifyAddition(ctx, record.addedNodes.length);
    if (confidence < this.floor || !parent) {
      this.droppedRecords++;
      return;
    }
    if (this.isOffLimits(parent)) {
      this.droppedRecords++;
      return;
    }

    const fresh: Element[] = [];
    for (const node of record.addedNodes) {
      if (!isElement(node)) continue;
      if (this.isOffLimits(node) || moved.has(node) || this.previouslyContained(node)) {
        this.droppedRecords++;
        continue;
      }
      fresh.push(node);
    }
    if (fresh.length === 0) return;

    const anchor = this.insertAnchorFor(record, parent);
    if (!anchor.fingerprint) {
      this.droppedRecords += fresh.length;
      return;
    }

    // Chèn nhiều node cùng lúc vào sau MỘT mốc thì thứ tự sẽ bị đảo (mỗi lần
    // chèn đẩy node trước đó lùi ra sau), nên duyệt ngược lại để kết quả cuối
    // cùng đúng thứ tự. 'before'/'lastChild' thì duyệt xuôi mới đúng.
    const ordered = anchor.position === 'after' ? fresh.slice().reverse() : fresh;

    for (const node of ordered) {
      let html: string;
      try {
        html = node.outerHTML;
      } catch (e) {
        log.error('recorder: could not serialise inserted node', e);
        this.droppedRecords++;
        continue;
      }
      if (!html || html.length > MAX_INSERT_HTML) {
        this.droppedRecords++;
        continue;
      }

      this.knownElements.add(node);
      this.insertedElements.add(node);

      const change: InsertChange = {
        ...this.base(anchor.fingerprint, confidence),
        type: 'insert',
        html,
        position: anchor.position,
      };
      this.push(node, relabel(change));
    }
  }

  /**
   * Mốc để chèn lại node này về sau.
   *
   * Điểm mấu chốt: `Replayer.applyInsert` hiểu 'before'/'after' là tương đối
   * với CHÍNH element mà change trỏ tới, còn 'firstChild'/'lastChild' là tương
   * đối với element đó xem như cha. Nên nếu muốn ghi 'after' thì fingerprint
   * phải là của node anh/chị em, không phải của node cha — ghi nhầm là node sẽ
   * mọc ra ngoài container.
   *
   * Neo vào sibling được ưu tiên vì nó giữ đúng vị trí trong danh sách; không
   * có sibling dùng được thì lùi về cha, chấp nhận mất vị trí chính xác nhưng
   * vẫn đúng container.
   */
  private insertAnchorFor(
    record: MutationRecord,
    parent: Element,
  ): { fingerprint: ElementFingerprint | null; position: InsertPosition } {
    const prev = nearestElementSibling(record.previousSibling, 'previous');
    if (prev && !this.isOffLimits(prev)) {
      const fp = this.fingerprintLive(prev);
      if (fp && isUsableFingerprint(fp)) return { fingerprint: fp, position: 'after' };
    }

    const next = nearestElementSibling(record.nextSibling, 'next');
    if (next && !this.isOffLimits(next)) {
      const fp = this.fingerprintLive(next);
      if (fp && isUsableFingerprint(fp)) return { fingerprint: fp, position: 'before' };
    }

    return {
      fingerprint: this.fingerprintLive(parent),
      position: record.previousSibling ? 'lastChild' : 'firstChild',
    };
  }

  /**
   * Heuristic "this node is new to the page". We cannot diff against a full
   * snapshot of a Facebook-sized DOM, so we approximate: a node we have never
   * seen a mutation for is treated as new, unless we ourselves recorded it as
   * an insertion (in which case a repeat must coalesce, not be skipped).
   */
  private previouslyContained(el: Element): boolean {
    return this.knownElements.has(el) && !this.insertedElements.has(el);
  }

  /* ----------------------------- fingerprints ---------------------------- */

  /** Fingerprint an attached element, swallowing anything the page throws. */
  private fingerprintLive(el: Element): ElementFingerprint | null {
    try {
      return fingerprintElement(el);
    } catch (e) {
      log.error('recorder: fingerprint failed', e);
      return null;
    }
  }

  /**
   * Fingerprint a node that has already lost its parent.
   *
   * `fingerprintElement` can still read the node's own identity (tag, id,
   * text, classes), but every structural field would describe a detached
   * fragment. The MutationRecord still knows where the node used to live, so
   * the structural half is rebuilt from `record.target` plus the recorded
   * siblings.
   */
  private fingerprintDetached(
    node: Element,
    record: MutationRecord,
    parent: Element | null,
  ): ElementFingerprint | null {
    const fp = this.fingerprintLive(node);
    if (!fp) return null;

    if (parent) {
      const parentFp = this.fingerprintLive(parent);
      if (parentFp) {
        const { childIndex, tagIndex } = this.positionAtRemoval(node, record);
        fp.childIndex = childIndex;
        fp.tagIndex = tagIndex;
        fp.depth = parentFp.depth + 1;
        try {
          fp.ancestors = [fingerprintAncestor(parent), ...parentFp.ancestors].slice(
            0,
            ANCESTOR_DEPTH,
          );
        } catch {
          fp.ancestors = parentFp.ancestors;
        }
        fp.path = parentFp.path ? `${parentFp.path}>${fp.tag}:${tagIndex}` : `${fp.tag}:${tagIndex}`;
        if (parentFp.anchorSelector) fp.anchorSelector = parentFp.anchorSelector;
      }
    }

    // A detached node's box is 0×0; keeping it would poison the tie-breaker.
    delete fp.rect;

    return isUsableFingerprint(fp) ? fp : null;
  }

  /** Where the removed node sat, counted from the siblings the record captured. */
  private positionAtRemoval(
    node: Element,
    record: MutationRecord,
  ): { childIndex: number; tagIndex: number } {
    let childIndex = 0;
    let tagIndex = 0;
    try {
      let sibling: Node | null = record.previousSibling;
      let scanned = 0;
      while (sibling && scanned < SIBLING_SCAN_MAX) {
        if (isElement(sibling)) {
          childIndex++;
          if (sibling.tagName === node.tagName) tagIndex++;
        }
        sibling = sibling.previousSibling;
        scanned++;
      }
    } catch (e) {
      log.error('recorder: sibling scan failed', e);
    }
    return { childIndex, tagIndex };
  }

  /* ------------------------------ coalescing ----------------------------- */

  /**
   * Insert or merge a change.
   *
   * The dedup key is `elementKey|type|discriminator`. A repeat updates the
   * existing row in place — same id, same createdAt, same original oldValue —
   * so a user dragging a colour picker produces one change, not two hundred.
   */
  private push(element: Element, fresh: Change): void {
    const key = elementDedupKey(this.keyFor(element), fresh);
    let prev = this.byKey.get(key);

    if (!prev) {
      // Có thể đây là lần sửa TIẾP THEO lên một change vừa khôi phục từ bản
      // nháp: nó chưa gắn với node nào nên còn nằm dưới khoá fingerprint. Tìm
      // thấy thì chuyển ngay sang khoá element — từ giờ đã có node thật, khoá
      // này ổn định hơn fingerprint (vốn đổi theo từng lần render lại).
      const restoredKey = fingerprintDedupKey(fresh);
      const restored = this.byKey.get(restoredKey);
      if (restored) {
        this.byKey.delete(restoredKey);
        this.byKey.set(key, restored);
        this.keyOf.set(restored.id, key);
        prev = restored;
      }
    }

    if (!prev) {
      this.byKey.set(key, fresh);
      this.keyOf.set(fresh.id, key);
      this.order.push(fresh);
      this.trim();
      this.notify(fresh, true);
      return;
    }

    if (this.isAppOverwrite(prev, fresh)) {
      // Đừng đụng gì vào change của user. Guard sẽ áp lại ở lượt settle kế tiếp.
      this.droppedRecords++;
      return;
    }

    this.mergeInto(prev, fresh);

    if (isUndone(prev)) {
      // The user put it back. Drop the row silently; hosts see it disappear on
      // their next getPending() poll rather than through a misleading callback.
      this.deleteAt(prev.id);
      log.debug('recorder: change undone, dropped', prev.id);
      return;
    }

    relabel(prev);
    // Only re-fingerprint while the element is still in the document: a
    // fingerprint taken from a detached node is strictly worse than the one we
    // already captured.
    if (element.isConnected) {
      const fp = this.fingerprintLive(element);
      if (fp) {
        // `prev.oldValue` là nội dung GỐC của trang (mergeInto chỉ cập nhật
        // `value`, không đụng `oldValue`), nên kể cả sau mười lần sửa liên tiếp
        // thì fingerprint vẫn mô tả element như lúc trang mới tải.
        if (prev.type === 'text') {
          this.rewindTextFields(fp, element, prev.textNodeIndex, prev.oldValue);
        }
        prev.target = fp;
        prev.targetLabel = safeDescribe(fp);
      }
    }
    this.notify(prev, false);
  }

  /**
   * Lần ghi này là APP RENDER ĐÈ lên change của user, chứ không phải user sửa tiếp?
   *
   * ĐÂY LÀ CHỐT CHẶN QUAN TRỌNG NHẤT CỦA CẢ FILE. Không có nó thì kịch bản sau
   * xảy ra và huỷ sạch công của user chỉ trong vài trăm mili-giây:
   *
   *   1. user sửa "55000" -> "600050", ta ghi lại TextChange
   *   2. React re-render, ghi "55000" đè lên
   *   3. recorder thấy characterData {oldValue:"600050", value:"55000"}
   *   4. nó GỘP vào chính change ở bước 1 -> value trở lại "55000"
   *   5. `isUndone` thấy value === oldValue -> XOÁ HẲN change
   *   6. `onRemoved` bắn -> xoá luôn khỏi bản nháp trong storage
   *
   * Tức là chỉ một lượt render của trang là thay đổi của user bốc hơi vĩnh viễn,
   * kể cả sau khi F5. Mà chống lại đúng lượt render đó lại là lý do guard tồn tại.
   *
   * Hai luật, chỉ cần dính một là chặn:
   *   a. Ghi bị chấm là 'app' thì không bao giờ được sửa một change 'devtools'.
   *   b. Ghi đưa giá trị về đúng trạng thái GỐC của trang. Đó là dấu vân tay
   *      kinh điển của re-render — không phải ngẫu nhiên mà nó trùng khít với
   *      giá trị trang có trước khi user động vào.
   *
   * Đánh đổi có chủ ý: user tự gõ lại đúng giá trị cũ sẽ KHÔNG còn tự động xoá
   * dòng đó nữa, họ phải bấm nút xoá trong popup. Mất một thao tác tiện tay thì
   * rẻ hơn nhiều so với âm thầm nuốt mất công sức của người ta.
   */
  private isAppOverwrite(prev: Change, fresh: Change): boolean {
    if (prev.source === 'devtools' && fresh.source !== 'devtools') return true;

    switch (prev.type) {
      case 'text':
        return fresh.type === 'text' && fresh.value === prev.oldValue;
      case 'attribute':
        return fresh.type === 'attribute' && fresh.value === prev.oldValue;
      case 'style':
        return fresh.type === 'style' && fresh.value === prev.oldValue;
      default:
        return false;
    }
  }

  /** Fold the newer observation into the existing change, in place. */
  private mergeInto(prev: Change, fresh: Change): void {
    prev.confidence = Math.max(prev.confidence, fresh.confidence);
    prev.source = sourceFor(prev.confidence);

    if (prev.type === 'text' && fresh.type === 'text') {
      prev.value = fresh.value;
    } else if (prev.type === 'attribute' && fresh.type === 'attribute') {
      prev.value = fresh.value;
    } else if (prev.type === 'style' && fresh.type === 'style') {
      prev.value = fresh.value;
      prev.priority = fresh.priority;
    } else if (prev.type === 'class' && fresh.type === 'class') {
      // Class deltas accumulate rather than replace: the second record's
      // oldValue is the state *after* the first edit, so replacing would lose
      // the first token the user added.
      const added = new Set(prev.added.filter((t) => !fresh.removed.includes(t)));
      for (const token of fresh.added) added.add(token);
      const removed = new Set(prev.removed.filter((t) => !fresh.added.includes(t)));
      for (const token of fresh.removed) removed.add(token);
      prev.added = [...added];
      prev.removed = [...removed];
    } else if (prev.type === 'insert' && fresh.type === 'insert') {
      prev.html = fresh.html;
      prev.position = fresh.position;
    } else if (prev.type === 'remove' && fresh.type === 'remove') {
      prev.hard = fresh.hard;
    }
  }

  private keyFor(el: Element): string {
    let key = this.elementKeys.get(el);
    if (!key) {
      key = uid('e');
      this.elementKeys.set(el, key);
    }
    this.knownElements.add(el);
    return key;
  }

  private base(fp: ElementFingerprint, confidence: number): Omit<BaseChange, 'type'> {
    return {
      id: uid('c'),
      target: fp,
      targetLabel: safeDescribe(fp),
      label: '',
      oldSummary: '',
      newSummary: '',
      createdAt: Date.now(),
      enabled: true,
      confidence,
      source: sourceFor(confidence),
    };
  }

  /** The host callback runs page-adjacent code; never let it break recording. */
  private notify(change: Change, isNew: boolean): void {
    try {
      this.onChange(change, isNew);
    } catch (e) {
      log.error('recorder: onChange handler threw', e);
    }
  }

  /** Cùng lý do như `notify`: callback của host không được phép giết recorder. */
  private notifyRemoved(changeId: string): void {
    try {
      this.onRemoved(changeId);
    } catch (e) {
      log.error('recorder: onRemoved handler threw', e);
    }
  }

  private trim(): void {
    while (this.order.length > MAX_PENDING) {
      const oldest = this.order.shift();
      if (!oldest) break;
      const key = this.keyOf.get(oldest.id);
      if (key !== undefined) this.byKey.delete(key);
      this.keyOf.delete(oldest.id);
      log.debug('recorder: pending buffer full, dropped', oldest.id);
      this.notifyRemoved(oldest.id);
    }
  }

  private deleteAt(changeId: string): boolean {
    const key = this.keyOf.get(changeId);
    if (key !== undefined) this.byKey.delete(key);
    this.keyOf.delete(changeId);
    const index = this.order.findIndex((c) => c.id === changeId);
    if (index < 0) return false;
    this.order.splice(index, 1);
    // Mọi đường xoá đều chạy qua đây, nên báo ở đây là báo đủ.
    this.notifyRemoved(changeId);
    return true;
  }

  /* -------------------------------- buffer ------------------------------- */

  /** Snapshot of the pending buffer, oldest first. */
  getPending(): Change[] {
    return this.order.slice();
  }

  setEnabled(changeId: string, enabled: boolean): boolean {
    const change = this.order.find((c) => c.id === changeId);
    if (!change) return false;
    change.enabled = enabled;
    return true;
  }

  setAllEnabled(enabled: boolean): void {
    for (const change of this.order) change.enabled = enabled;
  }

  remove(changeId: string): boolean {
    return this.deleteAt(changeId);
  }

  /** Wipes the buffer and the noise counter; the recording flag is untouched. */
  clear(): void {
    this.order.length = 0;
    this.byKey.clear();
    this.keyOf.clear();
    this.droppedRecords = 0;
    this.restoredChanges = 0;
  }

  /**
   * The enabled subset, deep-cloned so the caller can hand it to
   * chrome.storage without the recorder later mutating what was persisted.
   */
  takeEnabled(): Change[] {
    const out: Change[] = [];
    for (const change of this.order) {
      if (!change.enabled) continue;
      const copy = this.clone(change);
      if (copy) out.push(copy);
    }
    return out;
  }

  private clone(change: Change): Change | null {
    try {
      return structuredClone(change);
    } catch {
      try {
        return JSON.parse(JSON.stringify(change)) as Change;
      } catch (e) {
        log.error('recorder: could not clone change', e);
        return null;
      }
    }
  }

  /* -------------------------------- misc --------------------------------- */

  /** Our own UI, and inert tags nothing useful can be recorded on. */
  private isOffLimits(el: Element): boolean {
    try {
      return isOurNode(el) || isSkippedElement(el);
    } catch {
      return true;
    }
  }

  private now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }
}

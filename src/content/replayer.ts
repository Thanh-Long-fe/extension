/**
 * The replay engine.
 *
 * Given a set of recorded changes, it re-locates each change's element in the
 * live DOM (via the fuzzy matcher, never a CSS selector — the target sites use
 * hashed atomic class names that differ between deploys and sessions) and
 * re-applies the edit. It is designed to be called *constantly*: on DOM ready,
 * on a retry schedule while the app is still hydrating, and from the mutation
 * guard whenever the framework renders over one of our edits.
 *
 * The single most important property here is that a pass which changes nothing
 * must touch nothing. Every `apply*` method first checks whether the desired
 * value is already in place and returns `false` without a DOM write; otherwise
 * the guard would observe its own mutations and spin forever.
 */

import {
  DM_HIDDEN_ATTR,
  DM_ID_ATTR,
  DM_INSERTED_ATTR,
  DM_STYLE_ELEMENT_ID,
  IGNORED_ATTRS,
  MAX_MATCH_RENEWALS,
} from '@/shared/constants';
import { log } from '@/shared/logger';
import type {
  ApplyReport,
  ApplyStatus,
  AttributeChange,
  Change,
  ClassChange,
  InsertChange,
  MatchStrategy,
  ReplayStats,
  Settings,
  StyleChange,
  TextChange,
} from '@/shared/types';
import { DEFAULT_SETTINGS, EMPTY_REPLAY_STATS } from '@/shared/types';
import { elementLabel, normalizeText, textNodesOf } from './dom-utils';
import { findElement, invalidateCache, primeCache } from './element-matcher';
import type { StyleManager } from './style-manager';

/* ========================================================================== */
/* Tunables local to the replayer                                             */
/* ========================================================================== */

/** A change that throws this many times is almost certainly broken, not unlucky. */
const MAX_FAILURES = 3;

/**
 * How often we re-scan the DOM for a hard-removed element. Once the node is
 * detached the desired state is "absent", so the only reason to look again is
 * that the framework re-mounted a copy — worth checking, but not on every
 * guard tick, because it costs a full candidate scan.
 */
const RESCAN_DETACHED_MS = 500;

/** Tags that must never survive into the page from a recorded insert. */
const FORBIDDEN_INSERT_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'link',
  // Not required by the spec but equally capable of hijacking the document.
  'base',
  'meta',
  'frame',
  'frameset',
]);

/** Attributes whose value is a URL and therefore a script-execution vector. */
const URL_ATTRS = new Set([
  'href',
  'src',
  'xlink:href',
  'action',
  'formaction',
  'data',
  'poster',
  'background',
  'ping',
  'srcset',
]);

/** Schemes that execute code when navigated to. */
const DANGEROUS_SCHEMES = ['javascript:', 'vbscript:', 'data:text/html'];

/** A class token that `classList` will accept (no whitespace, non-empty). */
const CLASS_TOKEN_RE = /^\S+$/;

/* ========================================================================== */
/* Public types                                                               */
/* ========================================================================== */

/**
 * A change plus the snapshot it came from. The replayer never reads storage
 * itself; the content controller resolves which snapshots match the current
 * URL and hands the flattened list over, keeping the snapshot id for reporting.
 */
export interface PreparedChange {
  change: Change;
  snapshotId: string;
}

/** Everything one `run()` produced, ready to be forwarded to the popup. */
export interface ReplayOutcome {
  stats: ReplayStats;
  reports: ApplyReport[];
}

/* ========================================================================== */
/* Internal state                                                             */
/* ========================================================================== */

interface ChangeRecord {
  item: PreparedChange;
  status: ApplyStatus;
  /**
   * Weak on purpose: a bound element that the framework threw away must be
   * collectable, and `deref()` returning undefined is exactly the signal that
   * we need to re-match.
   */
  element: WeakRef<Element> | null;
  /** True while `element` was a live, matched binding (used to detect loss). */
  bound: boolean;
  /** Hard removes only: we have already detached the node at least once. */
  detached: boolean;
  /** Text node we created ourselves, so we never create a second one. */
  createdText: WeakRef<Text> | null;
  score: number;
  strategy: MatchStrategy;
  attempts: number;
  failures: number;
  /** When this change started looking for its element; drives the timeout. */
  firstSeenAt: number;
  /** Số lần cửa sổ tìm kiếm đã được mở lại vì trang render thêm nội dung. */
  renewals: number;
  /** Last time the matcher ran for this change. */
  lastMatchAt: number;
  error?: string;
  /** Undo closure captured at the moment we last wrote to the DOM. */
  restore?: () => void;
}

/** Does `el` carry `token` in the space-separated attribute `attr`? */
function hasToken(el: Element, attr: string, token: string): boolean {
  const raw = el.getAttribute(attr);
  if (!raw) return false;
  for (const t of raw.split(/\s+/)) if (t === token) return true;
  return false;
}

/** Message text for anything a hostile page may throw at us. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Direct child of `parent` that we inserted for `changeId`, if any. */
function findInsertedChild(parent: Node, changeId: string): Element | null {
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n instanceof Element && n.getAttribute(DM_INSERTED_ATTR) === changeId) return n;
  }
  return null;
}

/* ========================================================================== */
/* Replayer                                                                   */
/* ========================================================================== */

/**
 * Stateful, long-lived, one per frame. Owns the binding between recorded
 * changes and live elements plus every undo closure, which is why reverting is
 * possible at all: the recorded `oldValue` is only a UI summary, whereas the
 * value we captured the instant before writing is what the page actually had.
 */
export class Replayer {
  private readonly styles: StyleManager;

  private settings: Settings = DEFAULT_SETTINGS;

  private records = new Map<string, ChangeRecord>();

  /**
   * Mọi element từng được một change bám vào.
   *
   * Cho làn nhanh một phép hỏi O(1): "mutation này có chạm vào element đang
   * được vá không?" — để vá lại NGAY trong microtask, trước khi trình duyệt vẽ
   * giá trị mà app vừa ghi đè. WeakSet không xoá được từng phần tử, nhưng một
   * mục cũ chỉ gây thừa một lượt replay vô hại, còn element chết thì GC tự dọn.
   */
  private boundEls = new WeakSet<Element>();

  /**
   * element -> id của change đang CHIẾM nó.
   *
   * Một element chỉ thuộc về đúng một change. Không có sổ này thì hai change trỏ
   * vào hai node giống hệt nhau — hai ô cùng chữ trong một bảng — sẽ dò hoàn
   * toàn độc lập, cùng chấm ứng viên điểm cao nhất, rồi cùng ghi vào MỘT ô; ô
   * còn lại không bao giờ được ai nhận, nên sửa hai ô mà chỉ thấy một ô đổi.
   *
   * WeakMap: node bị trang vứt đi thì mục tương ứng tự biến mất theo.
   */
  private ownerOf = new WeakMap<Element, string>();

  private runCount = 0;

  private running = false;

  private stats: ReplayStats = { ...EMPTY_REPLAY_STATS };

  private reports: ApplyReport[] = [];

  private lastOutcome: ReplayOutcome = { stats: { ...EMPTY_REPLAY_STATS }, reports: [] };

  constructor(styles: StyleManager) {
    this.styles = styles;
  }

  /** Thresholds, margins and the match timeout all come from user settings. */
  setSettings(settings: Settings): void {
    this.settings = settings;
  }

  /**
   * Replace the change set. Applied state and the match cache are reset so the
   * next pass re-resolves everything against the current DOM, but the undo
   * closures of changes that survive the swap are carried over — otherwise a
   * settings refresh would silently make the page un-revertable.
   */
  load(items: PreparedChange[]): void {
    try {
      const previous = this.records;
      const next = new Map<string, ChangeRecord>();
      const now = Date.now();

      for (const item of items) {
        const id = item.change.id;
        if (!id || next.has(id)) continue;
        const old = previous.get(id);
        next.set(id, {
          item,
          status: item.change.enabled ? 'unmatched' : 'skipped',
          element: null,
          bound: false,
          detached: old?.detached ?? false,
          createdText: old?.createdText ?? null,
          score: 0,
          strategy: 'none',
          attempts: 0,
          failures: 0,
          firstSeenAt: now,
          // Mang theo hạn ngạch cũ: `load()` bị gọi rất thường xuyên trong lúc
          // user đang sửa, nên nếu reset thì hạn ngạch thành vô hạn.
          renewals: old?.renewals ?? 0,
          lastMatchAt: 0,
          restore: old?.restore,
        });
      }

      // Changes that vanished from the set must stop affecting the page.
      for (const [id, rec] of previous) {
        if (next.has(id)) continue;
        try {
          rec.restore?.();
        } catch (e) {
          log.error('Replayer.load: cleanup failed', id, e);
        }
        // Change đã rời tập thì phải nhả element nó đang giữ, nếu không ô đó bị
        // khoá và change còn lại không bao giờ nhận được.
        this.releaseRecord(rec);
        this.styles.clearChange(id);
      }

      this.records = next;
      invalidateCache();
      this.styles.flush();
    } catch (e) {
      log.error('Replayer.load failed', e);
    }
  }

  /**
   * Cập nhật TẠI CHỖ giá trị mong muốn của một change đang được replay.
   *
   * Dùng khi user sửa tiếp một thay đổi mà replayer đang giữ (rất hay xảy ra
   * với bản nháp: sau F5 replayer áp lại giá trị cũ, rồi user chỉnh tiếp trong
   * DevTools). Nếu không đồng bộ ngược như thế này, guard sẽ thấy DOM "lệch"
   * so với giá trị nó nhớ và ghi đè lại giá trị CŨ lên đúng thứ user vừa gõ.
   *
   * Cố tình không đụng `rec.element`/`rec.bound`: node vẫn là node đó, huỷ
   * binding chỉ tổ bắt matcher quét lại toàn trang. Cũng không đụng
   * `rec.restore`, để `revert()` vẫn trả về đúng giá trị gốc của trang.
   */
  patchChange(change: Change): boolean {
    const rec = this.records.get(change.id);
    if (!rec) return false;
    rec.item = { ...rec.item, change };
    rec.failures = 0;
    rec.error = undefined;
    // 'unchanged' chứ không phải 'applied': lượt chạy sau sẽ tự so lại và ghi
    // nếu cần. Riêng style thì phải xoá khai báo cũ, vì StyleManager gom theo
    // changeId và thuộc tính cũ sẽ nằm lì lại trong stylesheet.
    if (change.type === 'style') {
      try {
        this.styles.clearChange(change.id);
      } catch (e) {
        log.error('Replayer.patchChange: không xoá được rule cũ', change.id, e);
      }
    }
    rec.status = change.enabled ? 'unchanged' : 'skipped';
    return true;
  }

  /**
   * Resolve and apply everything that is not already satisfied.
   *
   * Cheap when the page is stable (bound elements are re-checked by identity,
   * not re-matched) and re-entrancy safe, because the guard can fire while a
   * pass is still writing.
   */
  run(): ReplayOutcome {
    if (this.running) return this.lastOutcome;
    this.running = true;

    const started = performance.now();
    const stats: ReplayStats = { ...EMPTY_REPLAY_STATS };
    const reports: ApplyReport[] = [];

    try {
      const now = Date.now();
      for (const rec of this.records.values()) {
        try {
          this.step(rec, now);
        } catch (e) {
          rec.failures += 1;
          rec.status = 'failed';
          rec.error = errorMessage(e);
          log.error('Replayer: change failed', rec.item.change.id, e);
        }

        const report: ApplyReport = {
          changeId: rec.item.change.id,
          status: rec.status,
          score: rec.score,
          strategy: rec.strategy,
        };
        if (rec.status === 'failed' && rec.error) report.error = rec.error;
        reports.push(report);
        stats[rec.status] += 1;
      }
    } catch (e) {
      log.error('Replayer.run failed', e);
    } finally {
      // Exactly one stylesheet write per pass, even if the loop blew up:
      // verify() re-attaches the node (and re-flushes) when the page tore it
      // out from under us, flush() is a no-op when nothing changed.
      try {
        if (document.getElementById(DM_STYLE_ELEMENT_ID)) this.styles.flush();
        else this.styles.verify();
      } catch (e) {
        log.error('Replayer: style flush failed', e);
      }
      this.running = false;
    }

    this.runCount += 1;
    stats.runs = this.runCount;
    stats.durationMs = performance.now() - started;

    this.stats = stats;
    this.reports = reports;
    this.lastOutcome = { stats, reports };
    return this.lastOutcome;
  }

  /**
   * Undo every applied change in reverse order, restoring the values captured
   * at apply time (reverse order matters: a hard remove nested inside another
   * change's subtree has to go back before its container is touched).
   */
  revert(): void {
    const recs = Array.from(this.records.values());
    for (let i = recs.length - 1; i >= 0; i--) {
      const rec = recs[i];
      try {
        rec.restore?.();
      } catch (e) {
        log.error('Replayer.revert: restore failed', rec.item.change.id, e);
      }
      rec.restore = undefined;
      // Nhả TRƯỚC khi bỏ WeakRef, nếu không mất luôn đường tìm lại element.
      this.releaseRecord(rec);
      rec.element = null;
      rec.bound = false;
      rec.detached = false;
      rec.createdText = null;
      rec.score = 0;
      rec.strategy = 'none';
      rec.attempts = 0;
      rec.failures = 0;
      rec.error = undefined;
      rec.firstSeenAt = Date.now();
      rec.renewals = 0;
      rec.status = rec.item.change.enabled ? 'unmatched' : 'skipped';
      invalidateCache(rec.item.change.id);
    }

    this.styles.clear();
    this.styles.flush();
    this.stripOurAttributes();

    const stats: ReplayStats = { ...EMPTY_REPLAY_STATS };
    const reports: ApplyReport[] = [];
    for (const rec of this.records.values()) {
      reports.push({ changeId: rec.item.change.id, status: rec.status, score: 0, strategy: 'none' });
      stats[rec.status] += 1;
    }
    stats.runs = this.runCount;
    this.stats = stats;
    this.reports = reports;
    this.lastOutcome = { stats, reports };
  }

  /**
   * Forget everything. Used on SPA navigation, where both the DOM and the set
   * of matching snapshots are about to be different and no binding, cache
   * entry or undo closure from the old route is meaningful any more.
   */
  reset(): void {
    this.records.clear();
    this.boundEls = new WeakSet<Element>();
    // Sổ chủ sở hữu cũng phải bỏ hẳn: cây DOM sắp khác, mọi quyền sở hữu cũ
    // đều vô nghĩa và giữ lại chỉ tổ chặn nhầm.
    this.ownerOf = new WeakMap<Element, string>();
    invalidateCache();
    this.styles.clear();
    this.styles.flush();
    this.runCount = 0;
    this.stats = { ...EMPTY_REPLAY_STATS };
    this.reports = [];
    this.lastOutcome = { stats: { ...EMPTY_REPLAY_STATS }, reports: [] };
  }

  /**
   * Mở lại cửa sổ tìm kiếm cho những change chưa khớp được.
   *
   * VÌ SAO CẦN: `matchTimeoutMs` đếm theo đồng hồ tường, và trên SPA thì cái
   * đồng hồ đó đo nhầm thứ. Element có thể xuất hiện ở giây thứ 20 vì mạng
   * chậm, hoặc hai phút sau khi user bấm mở một modal, hoặc chỉ tồn tại sau khi
   * cuộn xuống đủ xa. Bỏ cuộc sau đúng 15 giây là bỏ cuộc trước cả khi trang
   * kịp dựng ra thứ ta đang tìm.
   *
   * Nên thay vì hỏi "đã bao nhiêu giây rồi", ta hỏi "trang đã render thêm bao
   * nhiêu lần mà vẫn không thấy". Orchestrator gọi hàm này mỗi khi quan sát
   * được một lượt render đáng kể; ý nghĩa của timeout đổi từ "hết giờ" thành
   * "đã soi qua chừng ấy lượt trang dựng lại mà vẫn không có".
   *
   * Trả về số change được mở lại, để phía gọi biết có đáng chạy replay không.
   */
  renewMatchWindow(): number {
    const now = Date.now();
    let renewed = 0;
    for (const rec of this.records.values()) {
      if (!rec.item.change.enabled) continue;
      // Đang có element sống, hoặc đã yên vị rồi: không có gì để tìm lại.
      if (rec.bound) continue;
      if (rec.status === 'applied' || rec.status === 'unchanged') continue;
      // Change cứ ném lỗi thì mở lại cũng vô ích.
      if (rec.status === 'failed' && rec.failures >= MAX_FAILURES) continue;
      if (rec.renewals >= MAX_MATCH_RENEWALS) continue;
      rec.renewals += 1;
      rec.firstSeenAt = now;
      renewed++;
    }
    return renewed;
  }

  /**
   * Có change nào ĐÃ áp thành công mà element của nó vừa bị gỡ khỏi tài liệu?
   *
   * `hasUnresolved` không thấy được ca này: status vẫn là 'applied'/'unchanged'
   * cho tới lượt step() kế tiếp, trong khi node thì React đã vứt đi và dựng
   * bản mới rồi. Làn nhanh cần biết điều đó NGAY trong batch mutation — vì nếu
   * đợi guard debounce thì bản mới (mang giá trị gốc) đã kịp lên màn hình một
   * nhịp, đúng cú nháy đang phải diệt.
   *
   * Rẻ: chỉ deref WeakRef + đọc isConnected, không quét DOM.
   */
  hasLostBinding(): boolean {
    for (const rec of this.records.values()) {
      if (!rec.item.change.enabled || !rec.bound) continue;
      const el = rec.element?.deref();
      if (!el || !el.isConnected) return true;
    }
    return false;
  }

  /**
   * True while an enabled change still has no confident match and its match
   * window has not expired. The retry loop polls on this, so it going false is
   * what finally lets the page settle.
   */
  hasUnresolved(): boolean {
    const now = Date.now();
    for (const rec of this.records.values()) {
      if (!rec.item.change.enabled) continue;
      if (rec.status !== 'unmatched' && rec.status !== 'ambiguous') continue;
      if (now - rec.firstSeenAt < this.settings.matchTimeoutMs) return true;
    }
    return false;
  }

  /** Stats of the most recent pass (a copy: it crosses the message boundary). */
  getStats(): ReplayStats {
    return { ...this.stats };
  }

  /** Per-change outcomes of the most recent pass (copies, as above). */
  getReports(): ApplyReport[] {
    return this.reports.map((r) => ({ ...r }));
  }

  /** The element a change is currently bound to, for the popup's highlight. */
  elementFor(changeId: string): Element | null {
    const rec = this.records.get(changeId);
    const el = rec?.element?.deref() ?? null;
    return el && el.isConnected ? el : null;
  }

  /* ---------------------------------------------------------------------- */
  /* One change, one pass                                                    */
  /* ---------------------------------------------------------------------- */

  private step(rec: ChangeRecord, now: number): void {
    const change = rec.item.change;

    if (!change.enabled) {
      // Toggling a change off in the popup has to take effect on the page, not
      // just in the report, so undo it once and then leave it alone.
      if (rec.restore) {
        try {
          rec.restore();
        } catch (e) {
          log.error('Replayer: undo of disabled change failed', change.id, e);
        }
        rec.restore = undefined;
        rec.createdText = null;
        rec.detached = false;
        this.styles.clearChange(change.id);
      }
      rec.status = 'skipped';
      return;
    }
    // A change that keeps throwing is parked rather than retried forever.
    if (rec.status === 'failed' && rec.failures >= MAX_FAILURES) return;

    const hardRemove = change.type === 'remove' && change.hard;
    let el = this.boundElement(rec);

    if (!el && rec.bound) {
      // The framework replaced the node we owned. Drop the cache entry and give
      // the change a fresh match window — this is a re-render, not a failure to
      // ever find the element, so the original timeout must not apply.
      rec.bound = false;
      rec.firstSeenAt = now;
      invalidateCache(change.id);
    }

    if (!el) {
      if (hardRemove && rec.detached) {
        // Desired state (absent) already holds; only look for a re-mounted copy
        // now and then, since that costs a full candidate scan.
        if (now - rec.lastMatchAt < RESCAN_DETACHED_MS) {
          rec.status = 'unchanged';
          return;
        }
      } else if (
        rec.attempts > 0 &&
        (rec.status === 'unmatched' || rec.status === 'ambiguous') &&
        now - rec.firstSeenAt >= this.settings.matchTimeoutMs
      ) {
        // Match window expired: stop burning cycles, keep the status so the UI
        // can show it and hasUnresolved() can stop the retry loop.
        return;
      }

      el = this.resolve(rec, now);
      if (!el) {
        if (hardRemove && rec.detached && rec.status === 'unmatched') {
          // Nothing to remove because we already removed it.
          rec.status = 'unchanged';
        }
        return;
      }
    }

    const changed = this.applyChange(rec, el);
    rec.error = undefined;
    rec.status = changed ? 'applied' : 'unchanged';
    if (changed) log.debug('applied', change.type, change.id, elementLabel(el));
  }

  /** The live element a record is bound to, or null when it is gone. */
  private boundElement(rec: ChangeRecord): Element | null {
    const el = rec.element?.deref() ?? null;
    if (!el || !el.isConnected) {
      // Node chết hoặc bị gỡ khỏi tài liệu: NHẢ quyền sở hữu ngay. Giữ lại là
      // khoá vĩnh viễn một chỗ mà không change nào còn dùng — và nếu trang gắn
      // lại đúng node đó thì không ai được phép nhận nó nữa.
      if (el) this.releaseOwnership(el, rec.item.change.id);
      return null;
    }
    return el;
  }

  /** Nhả quyền sở hữu một element, nhưng chỉ khi nó đúng là của change này. */
  private releaseOwnership(el: Element, changeId: string): void {
    if (this.ownerOf.get(el) === changeId) this.ownerOf.delete(el);
  }

  /** Nhả element mà một record đang giữ, dùng khi record thôi bám vào nó. */
  private releaseRecord(rec: ChangeRecord): void {
    const el = rec.element?.deref();
    if (el) this.releaseOwnership(el, rec.item.change.id);
  }

  /**
   * Run the fuzzy matcher and bind the result. Ambiguity is treated as failure
   * to match: applying an edit to the wrong element is far worse than applying
   * nothing, and the DOM may still be settling, so we simply try again later.
   */
  private resolve(rec: ChangeRecord, now: number): Element | null {
    const change = rec.item.change;
    rec.attempts += 1;
    rec.lastMatchAt = now;

    const result = findElement(change.target, {
      threshold: this.settings.matchThreshold,
      margin: this.settings.matchMargin,
      cacheKey: change.id,
      // Chỉ loại element đang thuộc về change KHÁC. Element của chính mình thì
      // vẫn phải nhận lại được, nếu không mỗi lượt dò lại là một lần tự đá mình
      // ra khỏi chỗ vừa chiếm.
      taken: (el) => {
        const owner = this.ownerOf.get(el);
        return owner !== undefined && owner !== change.id;
      },
    });

    rec.score = result.score;
    rec.strategy = result.strategy;

    if (result.ambiguous) {
      rec.status = 'ambiguous';
      return null;
    }
    if (!result.element) {
      rec.status = 'unmatched';
      return null;
    }

    // Chốt cuối cho sửa chữ: element này có thật sự đang chứa giá trị CŨ (trang
    // vừa render lại) hay giá trị MỚI (ta đã áp rồi) không?
    //
    // Điểm số chỉ nói "trông giống", còn đây là bằng chứng. Không có chốt này
    // thì một element chấm điểm cao nhưng nội dung chẳng liên quan vẫn được
    // nhận, rồi ta ghi đè lên chữ của trang ở một chỗ hoàn toàn khác — hỏng dữ
    // liệu người ta mà không ai biết. Chưa khớp thì coi như chưa tìm thấy và
    // thử lại ở lượt sau, lúc trang đã dựng xong phần còn lại.
    if (change.type === 'text' && !this.pickTextNode(result.element, change, true)) {
      rec.status = 'unmatched';
      log.debug('Replayer: bỏ qua ứng viên vì không mang giá trị cũ', change.id);
      return null;
    }

    rec.element = new WeakRef(result.element);
    rec.bound = true;
    this.boundEls.add(result.element);
    this.ownerOf.set(result.element, change.id);
    primeCache(change.id, result.element);
    return result.element;
  }

  /**
   * Node này có phải (hoặc nằm ngay dưới) một element đang được change bám vào?
   *
   * Nhận cả text node vì mutation kiểu characterData trỏ thẳng vào text node,
   * trong khi thứ ta bám là element cha của nó.
   */
  ownsTarget(node: Node | null): boolean {
    if (!node) return false;
    try {
      const el: Element | null =
        node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      return el !== null && this.boundEls.has(el);
    } catch {
      return false;
    }
  }

  /** Dispatch to the per-type applier. Returns true when the DOM was written. */
  private applyChange(rec: ChangeRecord, el: Element): boolean {
    const change = rec.item.change;
    switch (change.type) {
      case 'text':
        return this.applyText(rec, el, change);
      case 'attribute':
        return this.applyAttribute(rec, el, change);
      case 'style':
        return this.applyStyle(rec, el, change);
      case 'class':
        return this.applyClass(rec, el, change);
      case 'visibility':
        return change.hidden ? this.applyHide(rec, el, change.id) : this.applyShow(rec, el, change.id);
      case 'remove':
        return change.hard ? this.applyHardRemove(rec, el) : this.applyHide(rec, el, change.id);
      case 'insert':
        return this.applyInsert(rec, el, change);
      default:
        return false;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Appliers                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Edit one text node rather than `textContent`, so sibling elements inside a
   * label ("Spend " + <b>$12</b>) survive the edit.
   */
  private applyText(rec: ChangeRecord, el: Element, change: TextChange): boolean {
    // A text node we appended ourselves on an earlier pass. Re-using it is what
    // stops us from stapling a fresh empty node onto the element every pass
    // when the value is blank (an empty node may not come back from
    // textNodesOf), and it is also how revert() knows to delete rather than
    // restore.
    const owned = rec.createdText?.deref() ?? null;
    const ours = owned && owned.isConnected && owned.parentNode === el ? owned : null;

    let node: Text | null = this.pickTextNode(el, change) ?? ours;

    if (!node) {
      if (!change.value) {
        // Desired state is "no text", and there is no text node. Nothing to do.
        return false;
      }
      if (el.firstElementChild) {
        // Appending text to a container that renders element children would put
        // the string in an arbitrary place; refuse instead of guessing.
        throw new Error('target has element children and no text node to edit');
      }
      node = el.ownerDocument.createTextNode('');
      el.appendChild(node);
      rec.createdText = new WeakRef(node);
    }

    const target = node;
    if (target.data === change.value) return false;

    const previousData = target.data;
    const created = target === (rec.createdText?.deref() ?? null);
    target.data = change.value;
    rec.restore = created
      ? () => {
          target.parentNode?.removeChild(target);
        }
      : () => {
          target.data = previousData;
        };
    return true;
  }

  /**
   * Chọn ĐÚNG text node để ghi vào.
   *
   * Trước đây chỗ này chỉ có `nodes[textNodeIndex] ?? nodes[0]`, và đó là nguồn
   * gốc của kiểu sai khó chịu nhất: áp đúng element nhưng ghi vào NHẦM mảnh chữ.
   * Chỉ số vị trí không ổn định vì hai lý do độc lập nhau:
   *
   *   - text node chỉ chứa khoảng trắng cũng chiếm một ô trong không gian chỉ
   *     số. Framework thêm/bớt một node whitespace là mọi chỉ số phía sau lệch.
   *   - re-render có thể gộp/tách text node liền kề (innerHTML, normalize),
   *     làm chỉ số vượt phạm vi. Lúc đó `?? nodes[0]` âm thầm ghi đè vào mảnh
   *     chữ ĐẦU TIÊN — thường là một nhãn hoàn toàn khác.
   *
   * Nên bây giờ NỘI DUNG là bằng chứng chính, chỉ số chỉ là gợi ý. So khớp qua
   * `normalizeText` để nbsp/xuống dòng/khoảng trắng thừa không làm trượt.
   *
   * Chấp nhận cả `oldValue` (trang vừa render lại, chưa áp) lẫn `value` (ta đã
   * áp rồi, đang chạy lại để xác nhận) — cùng một node ở hai thời điểm.
   */
  private pickTextNode(el: Element, change: TextChange, requireContent = false): Text | null {
    const nodes = textNodesOf(el);
    if (nodes.length === 0) return null;

    const same = (data: string, want: string): boolean =>
      normalizeText(data) === normalizeText(want);
    const looksRight = (n: Text): boolean =>
      same(n.data, change.oldValue) || same(n.data, change.value);

    // 1. Chỉ số trỏ đúng node mang nội dung mong đợi — chắc chắn nhất.
    const byIndex = nodes[change.textNodeIndex];
    if (byIndex && looksRight(byIndex)) return byIndex;

    // 2. Chỉ số đã lệch: đi tìm theo nội dung. Chỉ nhận khi có DUY NHẤT một
    //    node khớp — hai node cùng nội dung thì không có cách nào biết node nào
    //    là node user đã sửa, và đoán bừa chính là thứ ta đang muốn diệt.
    const matched = nodes.filter(looksRight);
    if (matched.length === 1) return matched[0];
    if (matched.length > 1) {
      // Nhiều node khớp: ưu tiên node ở đúng chỉ số nếu nó nằm trong nhóm đó.
      if (byIndex && matched.includes(byIndex)) return byIndex;
      return null;
    }

    // Từ đây trở xuống không còn bằng chứng NỘI DUNG nào nữa, chỉ còn vị trí.
    // `requireContent` là lúc ta đang XÁC MINH xem có đúng element không, và
    // khi đó vị trí là không đủ: chấp nhận bừa nghĩa là ghi đè lên chữ của
    // trang ở một chỗ hoàn toàn khác.
    if (requireContent) return null;

    // 3. Không node nào mang nội dung mong đợi. Chỉ số còn hợp lệ thì vẫn dùng
    //    (trang có thể đã đổi chữ vì lý do khác), nhưng KHÔNG rơi về nodes[0].
    if (byIndex) return byIndex;

    // 4. Element chỉ có đúng một mảnh chữ — không có gì để nhầm.
    if (nodes.length === 1) return nodes[0];

    // 5. Nhiều mảnh chữ mà không mảnh nào khớp và chỉ số thì vượt phạm vi:
    //    thà không ghi gì còn hơn ghi vào chỗ sai.
    return null;
  }

  /** Set or remove one attribute, never one of ours. */
  private applyAttribute(rec: ChangeRecord, el: Element, change: AttributeChange): boolean {
    const name = change.attribute.trim();
    if (!name) return false;
    if (IGNORED_ATTRS.has(name.toLowerCase())) {
      // Our own bookkeeping attributes; replaying them would corrupt state.
      return false;
    }

    const current = el.getAttribute(name);

    if (change.value === null) {
      if (current === null) return false;
      el.removeAttribute(name);
      rec.restore = () => el.setAttribute(name, current);
      return true;
    }

    if (current === change.value) return false;
    el.setAttribute(name, change.value);
    rec.restore =
      current === null ? () => el.removeAttribute(name) : () => el.setAttribute(name, current);
    return true;
  }

  /**
   * Style changes go through the stylesheet, never `el.style`.
   *
   * The recorded `priority` is deliberately ignored and every declaration is
   * written as `!important`: we are competing with the framework's *inline*
   * style attribute, which outranks any normal rule in our sheet, so a
   * non-important replay of a non-important edit would simply never show up.
   */
  private applyStyle(rec: ChangeRecord, el: Element, change: StyleChange): boolean {
    const id = change.id;
    const before = this.styles.ruleTextFor(id);
    const wasTagged = hasToken(el, DM_ID_ATTR, id);

    if (change.value === '') {
      // "Removed the declaration in DevTools": stop declaring it. We must not
      // write a reset value, because the property's original value comes from
      // the page's own cascade and is not ours to guess.
      this.styles.removeDeclaration(id, change.property);
      const cleared = this.styles.ruleTextFor(id);
      if (wasTagged) this.styles.untag(el, id);
      const changedByClear = wasTagged || before !== cleared;
      if (changedByClear) rec.restore = this.styleRestore(el, id);
      return changedByClear;
    }

    this.styles.tag(el, id);
    this.styles.setDeclaration(id, change.property, change.value, true);
    const after = this.styles.ruleTextFor(id);
    const changed = !wasTagged || before !== after;
    if (changed) rec.restore = this.styleRestore(el, id);
    return changed;
  }

  /** Undo closure shared by the style and hide appliers. */
  private styleRestore(el: Element, changeId: string): () => void {
    return () => {
      this.styles.clearChange(changeId);
      this.styles.untag(el, changeId);
    };
  }

  /**
   * Class edits are applied as a delta so they compose with whatever the
   * framework just wrote, instead of clobbering its atomic class soup.
   */
  private applyClass(rec: ChangeRecord, el: Element, change: ClassChange): boolean {
    const added = change.added.filter((t) => CLASS_TOKEN_RE.test(t) && !el.classList.contains(t));
    const removed = change.removed.filter((t) => CLASS_TOKEN_RE.test(t) && el.classList.contains(t));
    if (added.length === 0 && removed.length === 0) return false;

    if (added.length > 0) el.classList.add(...added);
    if (removed.length > 0) el.classList.remove(...removed);

    rec.restore = () => {
      if (added.length > 0) el.classList.remove(...added);
      if (removed.length > 0) el.classList.add(...removed);
    };
    return true;
  }

  /**
   * Hiding is a stylesheet rule plus a marker attribute, never a DOM removal:
   * the node stays where React expects it, so reconciliation keeps working and
   * the edit survives re-renders that would otherwise re-mount a removed node.
   */
  private applyHide(rec: ChangeRecord, el: Element, changeId: string): boolean {
    const ruleBefore = this.styles.ruleTextFor(changeId);
    const tagged = hasToken(el, DM_ID_ATTR, changeId);
    const marked = el.hasAttribute(DM_HIDDEN_ATTR);

    if (tagged && marked && ruleBefore !== '') return false;

    this.styles.tag(el, changeId);
    this.styles.setDeclaration(changeId, 'display', 'none', true);
    if (!marked) el.setAttribute(DM_HIDDEN_ATTR, '1');

    const undoStyle = this.styleRestore(el, changeId);
    rec.restore = () => {
      undoStyle();
      el.removeAttribute(DM_HIDDEN_ATTR);
    };
    return true;
  }

  /**
   * The inverse of applyHide, for a visibility change recorded as `hidden:
   * false`. We only undo hiding — ours, or the HTML `hidden` attribute — and
   * never invent a `display` value, because the element's intended display
   * comes from the page's cascade and forcing e.g. `block` would break layout.
   */
  private applyShow(rec: ChangeRecord, el: Element, changeId: string): boolean {
    let changed = false;

    if (this.styles.ruleTextFor(changeId) !== '') {
      this.styles.clearChange(changeId);
      changed = true;
    }
    if (hasToken(el, DM_ID_ATTR, changeId)) {
      this.styles.untag(el, changeId);
      changed = true;
    }
    if (el.hasAttribute(DM_HIDDEN_ATTR)) {
      el.removeAttribute(DM_HIDDEN_ATTR);
      changed = true;
    }

    const previousHidden = el.getAttribute('hidden');
    if (previousHidden !== null) {
      el.removeAttribute('hidden');
      rec.restore = () => el.setAttribute('hidden', previousHidden);
      changed = true;
    }
    return changed;
  }

  /**
   * Detach the node, remembering where it lived.
   *
   * WARNING: this is the dangerous one. React keeps host-node references in its
   * fiber tree, so removing a node it still owns can make a later render throw
   * (`NotFoundError` from removeChild/insertBefore) or resurrect the node on the
   * next reconciliation. `hard: false` (display:none) is the safe default and
   * this path should only run when the user explicitly asked for a real delete.
   */
  private applyHardRemove(rec: ChangeRecord, el: Element): boolean {
    const parent = el.parentNode;
    if (!parent) return false;

    const next = el.nextSibling;
    parent.removeChild(el);

    rec.detached = true;
    rec.bound = false;
    // Node đã bị gỡ khỏi trang: nhả nó ra. Giữ WeakRef để `restore` còn gắn lại
    // được, nhưng quyền sở hữu thì phải trả để change khác dùng lại chỗ đó.
    this.releaseOwnership(el, rec.item.change.id);
    rec.element = new WeakRef(el);

    // Compose, do not replace: if the framework re-mounted a copy we removed it
    // too, and revert() has to put every one of them back.
    const previous = rec.restore;
    rec.restore = () => {
      try {
        const anchor = next && next.parentNode === parent ? next : null;
        parent.insertBefore(el, anchor);
      } catch (e) {
        log.error('Replayer: could not re-attach removed node', e);
      }
      previous?.();
    };
    return true;
  }

  /**
   * Insert sanitised markup relative to the target. Idempotent by looking for
   * our own stamp among the parent's children first, because `run()` fires many
   * times a second and must not staple a copy in on every pass.
   */
  private applyInsert(rec: ChangeRecord, el: Element, change: InsertChange): boolean {
    const before = change.position === 'before' || change.position === 'after';
    const parent: Node | null = before ? el.parentNode : el;
    if (!parent) throw new Error('insert target has no parent');

    if (findInsertedChild(parent, change.id)) return false;

    const fragment = this.buildInsertFragment(change);
    if (!fragment || !fragment.firstChild) return false;

    const nodes: ChildNode[] = Array.from(fragment.childNodes);

    switch (change.position) {
      case 'before':
        parent.insertBefore(fragment, el);
        break;
      case 'after':
        parent.insertBefore(fragment, el.nextSibling);
        break;
      case 'firstChild':
        el.insertBefore(fragment, el.firstChild);
        break;
      case 'lastChild':
        el.appendChild(fragment);
        break;
      default:
        return false;
    }

    rec.restore = () => {
      for (const n of nodes) n.parentNode?.removeChild(n);
    };
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Parse recorded HTML inertly (a <template> never runs scripts or fetches
   * sub-resources), sanitise it, then stamp every root so we recognise it later
   * and the recorder never fingerprints our own markup back into a change.
   */
  private buildInsertFragment(change: InsertChange): DocumentFragment | null {
    const html = change.html;
    if (typeof html !== 'string' || html.trim() === '') return null;

    const template = document.createElement('template');
    template.innerHTML = html;
    const fragment = template.content;
    this.sanitizeFragment(fragment);
    if (!fragment.firstChild) return null;

    const roots = Array.from(fragment.children);
    if (roots.length === 0) {
      // Text-only insert: wrap it so the idempotency check has something to
      // find. Without a stamped element we would re-insert on every pass.
      const wrapper = document.createElement('span');
      while (fragment.firstChild) wrapper.appendChild(fragment.firstChild);
      wrapper.setAttribute(DM_INSERTED_ATTR, change.id);
      fragment.appendChild(wrapper);
    } else {
      for (const root of roots) root.setAttribute(DM_INSERTED_ATTR, change.id);
    }
    return fragment;
  }

  /**
   * Strip everything that can execute. Recorded HTML is user data, but it round
   * trips through storage and an import file, so it is treated as untrusted.
   */
  private sanitizeFragment(fragment: DocumentFragment): void {
    const elements = fragment.querySelectorAll('*');
    for (const node of elements) {
      if (FORBIDDEN_INSERT_TAGS.has(node.tagName.toLowerCase())) {
        node.remove();
        continue;
      }
      for (const name of node.getAttributeNames()) {
        const lower = name.toLowerCase();
        if (lower.startsWith('on') || lower === 'srcdoc') {
          node.removeAttribute(name);
          continue;
        }
        if (!URL_ATTRS.has(lower)) continue;
        // Browsers ignore whitespace inside a URL scheme, so `java\nscript:`
        // would slip past a naive prefix test.
        const value = (node.getAttribute(name) ?? '').replace(/[\s\0]/g, '').toLowerCase();
        if (DANGEROUS_SCHEMES.some((scheme) => value.startsWith(scheme))) {
          node.removeAttribute(name);
        }
      }
    }
  }

  /** Remove every marker attribute we own from the document (revert only). */
  private stripOurAttributes(): void {
    try {
      const nodes = document.querySelectorAll(`[${DM_ID_ATTR}],[${DM_HIDDEN_ATTR}]`);
      for (const node of nodes) {
        node.removeAttribute(DM_ID_ATTR);
        node.removeAttribute(DM_HIDDEN_ATTR);
      }
      // DM_INSERTED_ATTR is intentionally left alone: it marks our <style>
      // node, and inserted content is removed by its own restore closure.
    } catch (e) {
      log.error('Replayer: could not strip marker attributes', e);
    }
  }
}

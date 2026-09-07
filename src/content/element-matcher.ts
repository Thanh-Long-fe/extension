/**
 * Element matcher — resolves a recorded {@link ElementFingerprint} against the
 * live DOM.
 *
 * WHY this is fuzzy instead of a selector lookup: the target pages (Facebook
 * Ads Manager and friends) ship atomic, hashed class names, re-render whole
 * subtrees on every keystroke, and reorder siblings freely. A CSS selector
 * captured at record time is dead within seconds. So we keep a redundant
 * fingerprint and score *every* plausible candidate on all of its signals at
 * once: whichever signals survived the re-render carry the match.
 *
 * The file is deliberately defensive — it runs inside hostile third-party
 * pages, on every re-render, for every recorded change. Nothing here may throw,
 * and nothing here may be slow.
 */

import type {
  AncestorFingerprint,
  ElementFingerprint,
  MatchResult,
  MatchStrategy,
} from '@/shared/types';
import {
  ANCESTOR_TEXT_MAX,
  MATCH_WEIGHTS,
  MAX_CANDIDATES,
  TAG_MISMATCH_PENALTY,
  TEST_ID_ATTRS,
  TEXT_FINGERPRINT_MAX,
  VOLATILE_CLASS_BOOST,
} from '@/shared/constants';
import { log } from '@/shared/logger';
import {
  attrKeysOf,
  childTagSignature,
  cssEscape,
  elementChildIndex,
  elementDepth,
  fullText,
  isElement,
  isOurNode,
  isSkippedElement,
  jaccard,
  normalizeText,
  normalizeUrlAttr,
  ownText,
  safeRect,
  semanticClassTokens,
  similarity,
  truncate,
  volatileClassTokens,
} from './dom-utils';
import { structuralPath } from './fingerprint';

/* ========================================================================== */
/* Public types                                                               */
/* ========================================================================== */

/** Knobs for one lookup. Mirrors the relevant half of {@link Settings}. */
export interface MatchOptions {
  /** Settings.matchThreshold, 0..1 — minimum normalised score to accept. */
  threshold: number;
  /** Settings.matchMargin — required gap over the runner-up, else "ambiguous". */
  margin: number;
  /** Search scope, defaults to `document`. */
  root?: ParentNode;
  /** Usually the Change.id; enables the WeakRef fast path across re-renders. */
  cacheKey?: string;
}

/* ========================================================================== */
/* Internal types & tunables                                                  */
/* ========================================================================== */

/** A scope is always both a query root and a real node (for TreeWalker/text). */
type Scope = ParentNode & Node;

/** Which generator produced a candidate — used only to label the strategy. */
type Source = 'tag' | 'text' | 'attr' | 'path';

/** Lazily-filled per-element derivations, shared by every candidate in a call. */
interface Derived {
  tag: string;
  semantic?: string[];
  volatile?: string[];
  attrKeys?: string[];
  own?: string;
  text?: string;
  textTrunc?: string;
  sig?: string;
  labelled?: string;
  path?: string;
}

/** Everything scoring needs that outlives a single candidate. */
interface ScoreContext {
  derived: Map<Element, Derived>;
  /** Live element for `fp.anchorSelector`, so paths are compared like-for-like. */
  anchor: Element | null;
  anchorResolved: boolean;
}

interface GenState {
  seen: Set<Element>;
  /** Candidates whose tag equals `fp.tag` — always scored first. */
  sameTag: Element[];
  /** Candidates with a different tag — a last resort (see TAG_MISMATCH_PENALTY). */
  otherTag: Element[];
  total: number;
  src: Record<Source, number>;
}

interface PathStep {
  tag: string;
  index: number;
}

/** Soft wall-clock budget for scoring one fingerprint. Safety valve, not a goal. */
const SCORE_BUDGET_MS = 12;

/** Text nodes examined per text-generator pass before we give up walking. */
const MAX_TEXT_NODES = 3000;

/** Candidates a single generator may contribute, so one cannot starve the rest. */
const PER_TEXT_LIMIT = 80;
const PER_SELECTOR_LIMIT = 40;

/** How many ancestors of a matching text node are offered as candidates. */
const TEXT_ANCESTOR_LEVELS = 3;

/** Upper bound on cached elements, so a long-lived tab cannot leak Map entries. */
const MAX_CACHE_ENTRIES = 2000;

const W = MATCH_WEIGHTS;

const SAFE_TAG_RE = /^[a-z][a-z0-9-]*$/;
const UNSAFE_ATTR_VALUE_RE = /[\r\n\f]/;

/* ========================================================================== */
/* Cache                                                                      */
/* ========================================================================== */

/**
 * cacheKey -> last accepted element. WeakRef so a detached React subtree can be
 * collected; the guard loop leans on this to stay allocation- and query-free
 * when nothing actually changed.
 */
const cache = new Map<string, WeakRef<Element>>();

/**
 * Drop one cached element (or all of them). Call after navigation, after the
 * user edits a change, and whenever a replay pass ends in a mismatch — a stale
 * WeakRef silently pins the wrong node otherwise.
 */
export function invalidateCache(cacheKey?: string): void {
  if (cacheKey === undefined) cache.clear();
  else cache.delete(cacheKey);
}

/**
 * Seed the cache from outside the matcher — the recorder already knows which
 * element a change belongs to, so the first replay pass can skip the search.
 */
export function primeCache(cacheKey: string, el: Element): void {
  try {
    if (!cacheKey) return;
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(cacheKey, new WeakRef(el));
  } catch (err) {
    log.error('primeCache failed', err);
  }
}

/* ========================================================================== */
/* Small helpers                                                              */
/* ========================================================================== */

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/** `tagName.toLowerCase()`, matching how fingerprints store the tag. */
function tagOf(el: Element): string {
  return el.tagName.toLowerCase();
}

/** similarity() with the degenerate cases pinned down, so callers can't get NaN. */
function sim(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  try {
    return clamp01(similarity(a, b));
  } catch {
    return 0;
  }
}

function jac(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  try {
    return clamp01(jaccard(a, b));
  } catch {
    return 0;
  }
}

/** Text signals: fuzzy, with a nudge when one string wholly contains the other. */
function textScore(want: string, got: string): number {
  if (!want) return got ? 0 : 1;
  if (!got) return 0;
  if (want === got) return 1;
  let s = sim(want, got);
  if (want.length >= 3 && got.length >= 3 && (got.includes(want) || want.includes(got))) {
    s = Math.min(1, s + 0.15);
  }
  return s;
}

/** Positional signals degrade gracefully: siblings shift by one all the time. */
function indexScore(a: number, b: number): number {
  const d = Math.abs(a - b);
  if (d === 0) return 1;
  if (d === 1) return 0.6;
  if (d === 2) return 0.3;
  return 0;
}

function testIdOf(el: Element): string | null {
  for (const name of TEST_ID_ATTRS) {
    const v = el.getAttribute(name);
    if (v) return v;
  }
  return null;
}

/** Quote a value for use inside `[attr="…"]`; null when it cannot be expressed. */
function attrSelector(tagSel: string, attr: string, value: string, op = '='): string | null {
  if (!value || UNSAFE_ATTR_VALUE_RE.test(value)) return null;
  return `${tagSel}[${attr}${op}"${value.replace(/["\\]/g, '\\$&')}"]`;
}

function safeTagSelector(tag: string): string {
  return SAFE_TAG_RE.test(tag) ? tag : '';
}

/** The document a scope belongs to — never `document` from another frame. */
function docOf(scope: Scope): Document {
  if (scope.nodeType === Node.DOCUMENT_NODE) return scope as Document;
  return scope.ownerDocument ?? document;
}

function queryAll(scope: Scope, selector: string): Element[] {
  try {
    return Array.from(scope.querySelectorAll(selector));
  } catch (err) {
    log.debug('bad selector', selector, err);
    return [];
  }
}

/* ========================================================================== */
/* Derivations (cached per findElement call)                                  */
/* ========================================================================== */

function makeContext(anchor: Element | null, anchorResolved: boolean): ScoreContext {
  return { derived: new Map<Element, Derived>(), anchor, anchorResolved };
}

function derivedOf(el: Element, ctx: ScoreContext): Derived {
  let d = ctx.derived.get(el);
  if (d === undefined) {
    d = { tag: tagOf(el) };
    ctx.derived.set(el, d);
  }
  return d;
}

// The spreads below are deliberate: they cost one small array per candidate but
// keep us independent of whether dom-utils hands back a shared or frozen array.
function semanticOf(el: Element, ctx: ScoreContext): string[] {
  const d = derivedOf(el, ctx);
  return (d.semantic ??= [...semanticClassTokens(el)]);
}

function volatileOf(el: Element, ctx: ScoreContext): string[] {
  const d = derivedOf(el, ctx);
  return (d.volatile ??= [...volatileClassTokens(el)]);
}

/**
 * Điểm cộng từ chuỗi class băm CHA > CON, 0..1.
 *
 * Vì sao cần: với `<span class="x108nfp6">55000</span>` thì mọi tín hiệu khác
 * đều vô dụng — không id, không testid, class "thật" thì rỗng, và chữ chính là
 * thứ user vừa sửa. Nhưng cái chuỗi atomic class từ cha xuống con thì trong một
 * phiên làm việc lại rất đặc trưng, đủ để tách hai node mà mọi thứ khác giống
 * hệt nhau.
 *
 * Cha được tính nhẹ hơn con: nhiều node anh em dùng chung y hệt class của cha,
 * nên phần phân biệt thật nằm ở chính node đó.
 *
 * Trả về 0 khi fingerprint không có class băm nào — không có nghĩa là "không
 * khớp", mà là "không có gì để nói", nên hàm gọi chỉ cộng chứ không trừ.
 */
function volatileChainBonus(fp: ElementFingerprint, el: Element, ctx: ScoreContext): number {
  let num = 0;
  let den = 0;

  const own = fp.volatileClasses;
  if (own && own.length > 0) {
    num += 2 * jac(own, volatileOf(el, ctx));
    den += 2;
  }

  // Chỉ hai tầng cha gần nhất: lên cao hơn thì mọi ứng viên đều chung tổ tiên,
  // cộng vào chỉ làm loãng chứ không phân biệt thêm được gì.
  let cur: Element | null = el.parentElement;
  for (let i = 0; i < 2 && i < fp.ancestors.length; i++) {
    const want = fp.ancestors[i].volatileClasses;
    if (want && want.length > 0) {
      const weight = 1 / (1 + i);
      num += weight * (cur ? jac(want, volatileOf(cur, ctx)) : 0);
      den += weight;
    }
    cur = cur ? cur.parentElement : null;
  }

  return den > 0 ? num / den : 0;
}

function attrKeysCached(el: Element, ctx: ScoreContext): string[] {
  const d = derivedOf(el, ctx);
  return (d.attrKeys ??= [...attrKeysOf(el)]);
}

/**
 * Độ giống nhau giữa hai độ dài text, 0..1. Sàn 20 ký tự để chênh vài ký tự
 * trên một chuỗi ngắn không bị chấm thành hoàn toàn khác nhau.
 */
function lengthScore(got: number, want: number): number {
  return 1 - Math.min(1, Math.abs(got - want) / Math.max(want, 20));
}

function ownTextOf(el: Element, ctx: ScoreContext): string {
  const d = derivedOf(el, ctx);
  return (d.own ??= normalizeText(ownText(el)));
}

function fullTextOf(el: Element, ctx: ScoreContext): string {
  const d = derivedOf(el, ctx);
  return (d.text ??= fullText(el));
}

function truncTextOf(el: Element, ctx: ScoreContext): string {
  const d = derivedOf(el, ctx);
  return (d.textTrunc ??= truncate(fullTextOf(el, ctx), TEXT_FINGERPRINT_MAX));
}

function sigOf(el: Element, ctx: ScoreContext): string {
  const d = derivedOf(el, ctx);
  return (d.sig ??= childTagSignature(el));
}

function pathOf(el: Element, ctx: ScoreContext): string {
  const d = derivedOf(el, ctx);
  let path = d.path;
  if (path === undefined) {
    path = ctx.anchor ? structuralPath(el, ctx.anchor) : structuralPath(el);
    d.path = path;
  }
  return path;
}

/** `aria-labelledby` resolved to text — the accessible name often outlives the label attr. */
function labelledTextOf(el: Element, ctx: ScoreContext): string {
  const d = derivedOf(el, ctx);
  if (d.labelled !== undefined) return d.labelled;
  let out = '';
  try {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const parts: string[] = [];
      for (const id of ids.split(/\s+/)) {
        if (!id) continue;
        const ref = el.ownerDocument.getElementById(id);
        if (ref) parts.push(normalizeText(ref.textContent ?? ''));
      }
      out = normalizeText(parts.join(' '));
    }
  } catch {
    out = '';
  }
  d.labelled = out;
  return out;
}

/* ========================================================================== */
/* Scoring                                                                    */
/* ========================================================================== */

/**
 * Score one ancestor level. Kept separate (and cheap) because the ancestor
 * chain is the single most stable signal on a React page: an element's own
 * classes and text may be rewritten, but "third button inside the dialog whose
 * heading says X" survives.
 */
function ancestorScore(afp: AncestorFingerprint, el: Element | null, ctx: ScoreContext): number {
  if (!el) return 0;
  let num = 0;
  let den = 0;

  den += 3;
  if (tagOf(el) === afp.tag) num += 3;

  if (afp.id) {
    den += 4;
    if (el.id === afp.id) num += 4;
  }
  if (afp.testId) {
    den += 4;
    if (testIdOf(el) === afp.testId) num += 4;
  }
  if (afp.role) {
    den += 2;
    if (el.getAttribute('role') === afp.role) num += 2;
  }
  if (afp.ariaLabel) {
    den += 3;
    num += 3 * sim(afp.ariaLabel, el.getAttribute('aria-label') ?? '');
  }
  if (afp.semanticClasses.length > 0) {
    den += 2;
    num += 2 * jac(afp.semanticClasses, semanticOf(el, ctx));
  }
  if (afp.text) {
    den += 2;
    num += 2 * textScore(afp.text, truncate(fullTextOf(el, ctx), ANCESTOR_TEXT_MAX));
  }

  return den > 0 ? num / den : 0;
}

/** Longest common *suffix* of two structural paths, as a ratio of the longer one. */
function pathSuffixRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const left = a.split('>');
  const right = b.split('>');
  let i = left.length - 1;
  let j = right.length - 1;
  let common = 0;
  while (i >= 0 && j >= 0 && left[i] === right[j]) {
    common++;
    i--;
    j--;
  }
  const longest = Math.max(left.length, right.length);
  return longest > 0 ? common / longest : 0;
}

/** Geometry is only ever a tie-breaker: layout shifts, but not usually by much. */
function rectScore(fp: ElementFingerprint, el: Element): number {
  const want = fp.rect;
  if (!want) return 0;
  const got = safeRect(el);
  if (!got) return 0;
  const dx = want.x + want.w / 2 - (got.x + got.w / 2);
  const dy = want.y + want.h / 2 - (got.y + got.h / 2);
  const dist = Math.sqrt(dx * dx + dy * dy);
  const distScore = 1 / (1 + dist / 200);
  const wScore = Math.min(want.w, got.w) / Math.max(want.w, got.w, 1);
  const hScore = Math.min(want.h, got.h) / Math.max(want.h, got.h, 1);
  return clamp01(distScore * 0.5 + wScore * 0.25 + hScore * 0.25);
}

function scoreWith(fp: ElementFingerprint, el: Element, ctx: ScoreContext): number {
  try {
    const d = derivedOf(el, ctx);
    const tagMatch = d.tag === fp.tag;

    let num = 0;
    let den = 0;
    const add = (weight: number, signal: number): void => {
      num += weight * clamp01(signal);
      den += weight;
    };

    /* --- identity ------------------------------------------------------- */
    add(W.tag, tagMatch ? 1 : 0);

    if (fp.id) add(W.id, el.id === fp.id ? 1 : 0);
    if (fp.testId) add(W.testId, testIdOf(el) === fp.testId ? 1 : 0);
    if (fp.role) add(W.role, el.getAttribute('role') === fp.role ? 1 : 0);

    if (fp.ariaLabel || fp.ariaLabelledByText) {
      const gotLabel = el.getAttribute('aria-label') ?? '';
      const gotLabelled = labelledTextOf(el, ctx);
      let best = 0;
      for (const want of [fp.ariaLabel, fp.ariaLabelledByText]) {
        if (!want) continue;
        for (const got of [gotLabel, gotLabelled]) {
          if (!got) continue;
          best = Math.max(best, got === want ? 1 : sim(want, got));
        }
      }
      add(W.ariaLabel, best);
    }

    if (fp.name) add(W.name, el.getAttribute('name') === fp.name ? 1 : 0);
    if (fp.type) add(W.type, el.getAttribute('type') === fp.type ? 1 : 0);

    // Text-ish attributes degrade to a similarity score; copy edits are common.
    if (fp.placeholder) {
      const got = el.getAttribute('placeholder') ?? '';
      add(W.placeholder, got === fp.placeholder ? 1 : sim(fp.placeholder, got));
    }
    if (fp.alt) {
      const got = el.getAttribute('alt') ?? '';
      add(W.alt, got === fp.alt ? 1 : sim(fp.alt, got));
    }
    if (fp.title) {
      const got = el.getAttribute('title') ?? '';
      add(W.title, got === fp.title ? 1 : sim(fp.title, got));
    }

    if (fp.href) {
      const raw = el.getAttribute('href');
      const got = raw ? normalizeUrlAttr(raw) : '';
      add(W.href, got === fp.href ? 1 : 0);
    }
    if (fp.src) {
      const raw = el.getAttribute('src');
      const got = raw ? normalizeUrlAttr(raw) : '';
      add(W.src, got === fp.src ? 1 : 0);
    }

    /* --- content -------------------------------------------------------- */
    // Lấy điểm TỐT HƠN giữa hai trạng thái: một element vừa bị sửa chữ tồn tại
    // ở cả hai (chữ gốc lúc trang mới tải hoặc vừa bị render đè, chữ mới ngay
    // sau khi sửa hoặc sau khi replayer áp xong). Chỉ so với một bên là chắc
    // chắn hỏng ở thời điểm còn lại. Xem `ownTextAlt` trong types.ts.
    // Điều kiện phải xét CẢ hai biến thể: sửa một element từ rỗng thành có chữ
    // sẽ cho ownText = '' và ownTextAlt = 'chữ mới'. Nếu chỉ gác bằng `fp.ownText`
    // thì cả nhánh bị bỏ qua và mất trắng 34/92 trọng số — đúng lúc đang cần nó
    // nhất, vì element đó chẳng còn tín hiệu nào khác.
    if (fp.ownText || fp.ownTextAlt) {
      const live = ownTextOf(el, ctx);
      let best = fp.ownText ? textScore(fp.ownText, live) : 0;
      if (fp.ownTextAlt) best = Math.max(best, textScore(fp.ownTextAlt, live));
      add(W.ownText, best);
    }
    if (fp.text || fp.textAlt) {
      const live = truncTextOf(el, ctx);
      let best = fp.text ? textScore(fp.text, live) : 0;
      if (fp.textAlt) best = Math.max(best, textScore(fp.textAlt, live));
      add(W.text, best);
    }

    const gotLen = fullTextOf(el, ctx).length;
    const lenScore =
      fp.textLenAlt === undefined
        ? lengthScore(gotLen, fp.textLen)
        : Math.max(lengthScore(gotLen, fp.textLen), lengthScore(gotLen, fp.textLenAlt));
    add(W.textLen, lenScore);

    /* --- classes & attributes ------------------------------------------- */
    if (fp.semanticClasses.length > 0) {
      add(W.semanticClasses, jac(fp.semanticClasses, semanticOf(el, ctx)));
    } else if (fp.classCount === 0) {
      // The element genuinely had no classes; gaining some is weak counter-
      // evidence, not proof of a different element.
      add(W.semanticClasses, el.classList.length === 0 ? 1 : 0.35);
    }
    // else: the fingerprint was 100% atomic/hashed CSS (Facebook). Scoring
    // jaccard against an empty set would punish every candidate equally and
    // just dilute the useful signals, so the signal is skipped entirely.

    if (fp.attrKeys.length > 0) add(W.attrKeys, jac(fp.attrKeys, attrKeysCached(el, ctx)));

    /* --- structure ------------------------------------------------------ */
    const gotSig = sigOf(el, ctx);
    if (fp.childTagSignature || gotSig) {
      let sigScore = 0;
      if (fp.childTagSignature === gotSig) sigScore = 1;
      else if (fp.childTagSignature && gotSig) sigScore = sim(fp.childTagSignature, gotSig);
      add(W.childTagSignature, sigScore);
    }

    if (fp.ancestors.length > 0) {
      let aNum = 0;
      let aDen = 0;
      let cur: Element | null = el.parentElement;
      for (let i = 0; i < fp.ancestors.length; i++) {
        const weight = 1 / (1 + i);
        aDen += weight;
        // A missing ancestor scores 0 on purpose: a shallower position in the
        // tree is a real difference, not missing information.
        aNum += weight * ancestorScore(fp.ancestors[i], cur, ctx);
        cur = cur ? cur.parentElement : null;
      }
      add(W.ancestors, aDen > 0 ? aNum / aDen : 0);
    }

    if (fp.path) add(W.path, pathSuffixRatio(fp.path, pathOf(el, ctx)));

    add(W.childIndex, indexScore(fp.childIndex, elementChildIndex(el)));
    add(W.depth, indexScore(fp.depth, elementDepth(el)));

    if (fp.rect) add(W.rect, rectScore(fp, el));

    if (den <= 0) return 0;
    let score = num / den;
    if (!tagMatch) score *= 1 - TAG_MISMATCH_PENALTY;
    // Cộng SAU khi chuẩn hoá, cố ý không nằm trong mẫu số: class băm đã đổi sau
    // một lần deploy thì chỉ đơn giản là không cộng gì, chứ không kéo mọi ứng
    // viên tụt xuống dưới `matchThreshold`.
    //
    // Cộng theo PHẦN DƯ CÒN LẠI chứ không cộng thẳng rồi clamp: cộng thẳng thì
    // hai ứng viên điểm cao đều bị ép về 1.0, khoảng cách giữa chúng bị bóp lại
    // dưới `matchMargin`, và một cú khớp lẽ ra hoàn hảo lại bị coi là "mơ hồ"
    // rồi bỏ qua. Nói cách khác, cách cộng cũ tự tay biến điểm cộng thành hình
    // phạt đúng ở những ca nó nên giúp nhất.
    const bonus = clamp01(volatileChainBonus(fp, el, ctx));
    score += (1 - score) * VOLATILE_CLASS_BOOST * bonus;
    return clamp01(score);
  } catch (err) {
    log.error('scoreCandidate failed', err);
    return 0;
  }
}

/**
 * Normalised 0..1 confidence that `el` is the element `fp` was taken from.
 *
 * Exported for the debug overlay and for callers that already hold a candidate
 * (the guard re-checks its cached element with this before touching it).
 */
export function scoreCandidate(fp: ElementFingerprint, el: Element): number {
  const ctx = makeContext(null, false);
  ensureAnchor(fp, el.ownerDocument ?? document, ctx);
  return scoreWith(fp, el, ctx);
}

/* ========================================================================== */
/* Anchor & path helpers                                                      */
/* ========================================================================== */

function ensureAnchor(fp: ElementFingerprint, scope: Scope, ctx: ScoreContext): Element | null {
  if (ctx.anchorResolved) return ctx.anchor;
  ctx.anchorResolved = true;
  ctx.anchor = null;
  if (fp.anchorSelector) {
    try {
      const found = scope.querySelector(fp.anchorSelector);
      if (found && !isOurNode(found)) ctx.anchor = found;
    } catch (err) {
      log.debug('anchor selector failed', fp.anchorSelector, err);
    }
  }
  return ctx.anchor;
}

function parsePath(path: string): PathStep[] {
  const steps: PathStep[] = [];
  for (const raw of path.split('>')) {
    const step = raw.trim();
    if (!step) continue;
    const colon = step.lastIndexOf(':');
    if (colon < 0) {
      steps.push({ tag: step, index: 0 });
      continue;
    }
    const parsed = Number.parseInt(step.slice(colon + 1), 10);
    steps.push({
      tag: step.slice(0, colon),
      index: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
    });
  }
  return steps;
}

function nthOfTag(parent: Element, tag: string, index: number): Element | null {
  if (index < 0) return null;
  let seen = 0;
  const kids = parent.children;
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i];
    if (tagOf(kid) !== tag) continue;
    if (seen === index) return kid;
    seen++;
  }
  return null;
}

/** Replay a structural path from `base`, optionally nudging the final index. */
function walkPath(base: Element, steps: PathStep[], lastDelta: number): Element | null {
  let cur: Element | null = base;
  for (let i = 0; i < steps.length; i++) {
    if (!cur) return null;
    const step = steps[i];
    const index = i === steps.length - 1 ? step.index + lastDelta : step.index;
    cur = nthOfTag(cur, step.tag, index);
  }
  return cur;
}

/* ========================================================================== */
/* Candidate generation                                                       */
/* ========================================================================== */

function newState(): GenState {
  return {
    seen: new Set<Element>(),
    sameTag: [],
    otherTag: [],
    total: 0,
    src: { tag: 0, text: 0, attr: 0, path: 0 },
  };
}

function pushCandidate(
  state: GenState,
  fp: ElementFingerprint,
  node: Node | null | undefined,
  src: Source,
): boolean {
  if (state.total >= MAX_CANDIDATES) return false;
  if (!node || !isElement(node)) return true;
  if (state.seen.has(node)) return true;
  try {
    if (isSkippedElement(node) || isOurNode(node)) return true;
  } catch {
    return true;
  }
  state.seen.add(node);
  state.total++;
  state.src[src]++;
  if (tagOf(node) === fp.tag) state.sameTag.push(node);
  else state.otherTag.push(node);
  return state.total < MAX_CANDIDATES;
}

/**
 * The scope's own text, used as a prefilter. The raw form is checked first
 * because it is free (native concatenation); the normalised form is only built
 * when the raw check fails, since normalising a 200KB page string on every
 * lookup would dwarf the search itself.
 */
interface Haystack {
  raw: string;
  norm?: string;
}

function haystackHas(hay: Haystack, want: string): boolean {
  if (hay.raw.includes(want)) return true;
  hay.norm ??= normalizeText(hay.raw);
  return hay.norm.includes(want);
}

/** Elements around text nodes that carry (part of) the fingerprint's text. */
function collectByText(
  state: GenState,
  fp: ElementFingerprint,
  scope: Scope,
  want: string,
  haystack: Haystack,
): void {
  if (!want) return;
  // Cheap prefilter: if the whole scope no longer contains the string, no text
  // node inside it can, and the walk cannot possibly pay off.
  if (!haystackHas(haystack, want)) return;

  let walker: TreeWalker;
  try {
    walker = docOf(scope).createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  } catch (err) {
    log.debug('text walker failed', err);
    return;
  }

  let scanned = 0;
  let added = 0;
  let node = walker.nextNode();
  while (node) {
    if (++scanned > MAX_TEXT_NODES || added >= PER_TEXT_LIMIT) break;
    const raw = node.nodeValue;
    if (raw && raw.trim().length > 0) {
      const value = normalizeText(raw);
      let levels = 0;
      if (value === want || value.includes(want)) {
        levels = TEXT_ANCESTOR_LEVELS - 1;
      } else if (value.length >= 4 && want.startsWith(value)) {
        // The fingerprint text was stitched together from several text nodes,
        // so the element we want is an ancestor of this first fragment.
        levels = TEXT_ANCESTOR_LEVELS;
      }
      if (levels > 0) {
        let cur: Element | null = node.parentElement;
        for (let i = 0; i <= levels && cur; i++) {
          added++;
          if (!pushCandidate(state, fp, cur, 'text')) return;
          cur = cur.parentElement;
        }
      }
    }
    node = walker.nextNode();
  }
}

function collectByAttrs(state: GenState, fp: ElementFingerprint, scope: Scope): void {
  const tagSel = safeTagSelector(fp.tag);
  const pairs: Array<[attr: string, value: string, needTag: boolean]> = [];
  if (fp.ariaLabel) pairs.push(['aria-label', fp.ariaLabel, false]);
  if (fp.name) pairs.push(['name', fp.name, false]);
  if (fp.placeholder) pairs.push(['placeholder', fp.placeholder, false]);
  if (fp.alt) pairs.push(['alt', fp.alt, false]);
  if (fp.title) pairs.push(['title', fp.title, false]);
  // role/type alone select hundreds of nodes, so they are always tag-qualified.
  if (fp.role) pairs.push(['role', fp.role, true]);
  if (fp.type) pairs.push(['type', fp.type, true]);

  for (const [attr, value, needTag] of pairs) {
    const selector = attrSelector(needTag ? tagSel : '', attr, value);
    if (!selector) continue;
    const found = queryAll(scope, selector);
    const limit = Math.min(found.length, PER_SELECTOR_LIMIT);
    for (let i = 0; i < limit; i++) {
      if (!pushCandidate(state, fp, found[i], 'attr')) return;
    }
  }
}

function collectByPath(
  state: GenState,
  fp: ElementFingerprint,
  anchor: Element | null,
  scope: Scope,
): void {
  const steps = parsePath(fp.path);
  if (steps.length === 0) return;

  const bases: Element[] = [];
  if (anchor) bases.push(anchor);
  const docEl = docOf(scope).documentElement;
  if (docEl && !bases.includes(docEl)) bases.push(docEl);

  for (const base of bases) {
    for (const delta of [0, -1, 1]) {
      if (!pushCandidate(state, fp, walkPath(base, steps, delta), 'path')) return;
    }
    // The recorded path may or may not repeat the base element as its first
    // step ("html>body>…" vs "body>…"); try both readings.
    if (steps.length > 1 && steps[0].tag === tagOf(base)) {
      const rest = steps.slice(1);
      for (const delta of [0, -1, 1]) {
        if (!pushCandidate(state, fp, walkPath(base, rest, delta), 'path')) return;
      }
    }
  }
}

/**
 * Generators run cheapest/most-selective first, because MAX_CANDIDATES is a
 * hard budget: a `div` tag sweep on a Facebook page would otherwise consume it
 * before the precise generators ever run.
 */
function generate(state: GenState, fp: ElementFingerprint, scope: Scope, anchor: Element | null): void {
  collectByPath(state, fp, anchor, scope);
  if (state.total >= MAX_CANDIDATES) return;

  collectByAttrs(state, fp, scope);
  if (state.total >= MAX_CANDIDATES) return;

  // Phải quét theo CẢ hai trạng thái text. Đây mới là chỗ chí mạng: chấm điểm
  // giỏi tới đâu cũng vô nghĩa nếu element không lọt nổi vào danh sách ứng viên
  // — mà một element vừa bị sửa chữ thì trên trang đang mang chữ mới, còn sau
  // khi F5 lại mang chữ gốc. Chỉ quét một bên là mù hẳn ở thời điểm còn lại.
  const wants: string[] = [];
  for (const candidate of [fp.ownText, fp.text, fp.ownTextAlt, fp.textAlt]) {
    if (candidate && !wants.includes(candidate)) wants.push(candidate);
  }
  if (wants.length > 0) {
    const haystack: Haystack = { raw: '' };
    try {
      // `Document.textContent` theo chuẩn DOM là **null**, không phải chuỗi rỗng.
      // Mà scope mặc định CHÍNH LÀ document (findElement không được truyền root),
      // nên `?? ''` biến prefilter thành "không bao giờ khớp" và giết luôn toàn
      // bộ generator theo text — đúng cái generator mà những element chỉ có chữ
      // làm danh tính phải sống nhờ vào. Phải lùi về documentElement.
      const host: Node | null =
        scope.nodeType === Node.DOCUMENT_NODE ? (scope as Document).documentElement : scope;
      haystack.raw = host?.textContent ?? '';
    } catch {
      haystack.raw = '';
    }
    for (const want of wants) {
      if (state.total >= MAX_CANDIDATES) break;
      collectByText(state, fp, scope, want, haystack);
    }
  }
  if (state.total >= MAX_CANDIDATES) return;

  const tagSel = safeTagSelector(fp.tag);
  if (tagSel) {
    const found = queryAll(scope, tagSel);
    for (let i = 0; i < found.length; i++) {
      if (!pushCandidate(state, fp, found[i], 'tag')) return;
    }
  }
}

/* ========================================================================== */
/* Ranking                                                                    */
/* ========================================================================== */

interface Ranking {
  best: Element | null;
  bestScore: number;
  runnerUp: number;
  scored: number;
}

function rank(
  fp: ElementFingerprint,
  pool: Element[],
  ctx: ScoreContext,
  startedAt: number,
  seed: Ranking,
): Ranking {
  let { best, bestScore, runnerUp, scored } = seed;
  for (let i = 0; i < pool.length; i++) {
    const el = pool[i];
    // Cheap bail-out: a tag mismatch can never beat an already-excellent
    // same-tag candidate, so stop paying for the walk.
    if (bestScore > 0.9 && derivedOf(el, ctx).tag !== fp.tag) break;
    const score = scoreWith(fp, el, ctx);
    scored++;
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = el;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
    if ((i & 15) === 15 && performance.now() - startedAt > SCORE_BUDGET_MS) {
      log.debug('match scoring budget exhausted', { scored, pool: pool.length });
      break;
    }
  }
  return { best, bestScore, runnerUp, scored };
}

/**
 * Label the route the winner came from — diagnostics only, the popup shows it.
 * A single-source search is labelled by that source (it says something real
 * about why the element was found); anything broader falls back to how the
 * search was scoped.
 */
function strategyFor(state: GenState, usedAnchor: boolean): MatchStrategy {
  const contributing = (['tag', 'text', 'attr', 'path'] as const).filter((k) => state.src[k] > 0);
  if (contributing.length === 1) {
    if (contributing[0] === 'text') return 'text';
    if (contributing[0] === 'path') return 'path';
  }
  return usedAnchor ? 'anchored' : 'scored';
}

function emptyResult(): MatchResult {
  return {
    element: null,
    score: 0,
    runnerUpScore: 0,
    candidatesConsidered: 0,
    strategy: 'none',
    ambiguous: false,
  };
}

/* ========================================================================== */
/* Entry point                                                                */
/* ========================================================================== */

/**
 * Resolve a fingerprint against the current DOM.
 *
 * Order of business: cached element, deterministic ids, then a scored search
 * over a deduplicated candidate union. Every deterministic shortcut is verified
 * with the full scorer before it is trusted — an `id` that got reused by the
 * app is worse than no shortcut at all.
 */
export function findElement(fp: ElementFingerprint, opts: MatchOptions): MatchResult {
  const startedAt = performance.now();
  try {
    const scope: Scope = (opts.root ?? document) as Scope;
    const threshold = clamp01(opts.threshold);
    const margin = Number.isFinite(opts.margin) ? Math.max(0, opts.margin) : 0;
    const ctx = makeContext(null, false);
    // Resolved before anything is scored: `fp.path` is relative to the anchor,
    // so the cache probe and the deterministic shortcuts have to be judged in
    // exactly the same frame of reference as the scored search, or the same
    // element would score differently depending on which route found it.
    const anchor = ensureAnchor(fp, scope, ctx);

    /* --- 1. cache fast path --------------------------------------------- */
    if (opts.cacheKey) {
      const ref = cache.get(opts.cacheKey);
      const cached = ref ? ref.deref() : undefined;
      if (cached && cached.isConnected) {
        const score = scoreWith(fp, cached, ctx);
        if (score >= threshold) {
          return {
            element: cached,
            score,
            runnerUpScore: 0,
            candidatesConsidered: 1,
            strategy: 'cache',
            ambiguous: false,
          };
        }
      }
      if (ref) cache.delete(opts.cacheKey);
    }

    const accept = (el: Element, score: number, strategy: MatchStrategy): MatchResult => {
      if (opts.cacheKey) primeCache(opts.cacheKey, el);
      return {
        element: el,
        score,
        runnerUpScore: 0,
        candidatesConsidered: 1,
        strategy,
        ambiguous: false,
      };
    };

    /** A shortcut is only worth taking when the full scorer agrees with it. */
    const verify = (el: Element | null | undefined): number => {
      if (!el) return -1;
      try {
        if (tagOf(el) !== fp.tag) return -1;
        if (isSkippedElement(el) || isOurNode(el)) return -1;
      } catch {
        return -1;
      }
      const score = scoreWith(fp, el, ctx);
      return score >= threshold ? score : -1;
    };

    const tagSel = safeTagSelector(fp.tag);

    /* --- 2a. id --------------------------------------------------------- */
    if (fp.id) {
      try {
        const byId =
          scope.nodeType === Node.DOCUMENT_NODE
            ? (scope as Document).getElementById(fp.id)
            : scope.querySelector(`#${cssEscape(fp.id)}`);
        const score = verify(byId);
        if (score >= 0 && byId) return accept(byId, score, 'id');
      } catch (err) {
        log.debug('id fast path failed', err);
      }
    }

    /* --- 2b. test id ---------------------------------------------------- */
    if (fp.testId) {
      for (const name of TEST_ID_ATTRS) {
        const selector = attrSelector('', name, fp.testId);
        if (!selector) continue;
        const found = queryAll(scope, selector);
        if (found.length !== 1) continue;
        const el = found[0];
        const score = verify(el);
        if (score >= 0) return accept(el, score, 'testid');
      }
    }

    /* --- 2c. unique attribute combination -------------------------------- */
    {
      const combos: Array<string | null> = [];
      if (fp.role && fp.ariaLabel) {
        const rolePart = attrSelector(tagSel, 'role', fp.role);
        const labelPart = attrSelector('', 'aria-label', fp.ariaLabel);
        combos.push(rolePart && labelPart ? rolePart + labelPart : null);
      }
      if (fp.ariaLabel) combos.push(attrSelector(tagSel, 'aria-label', fp.ariaLabel));
      if (fp.name) combos.push(attrSelector(tagSel, 'name', fp.name));
      if (fp.placeholder) combos.push(attrSelector(tagSel, 'placeholder', fp.placeholder));
      if (fp.href) {
        combos.push(attrSelector(tagSel, 'href', fp.href));
        // fp.href is origin-stripped, so the live attribute may be absolute.
        combos.push(attrSelector(tagSel, 'href', fp.href, '$='));
      }
      if (fp.src) combos.push(attrSelector(tagSel, 'src', fp.src, '$='));
      if (fp.title) combos.push(attrSelector(tagSel, 'title', fp.title));
      if (fp.alt) combos.push(attrSelector(tagSel, 'alt', fp.alt));

      for (const selector of combos) {
        if (!selector) continue;
        const found = queryAll(scope, selector);
        if (found.length !== 1) continue;
        const el = found[0];
        const score = verify(el);
        if (score >= 0) return accept(el, score, 'unique-attr');
      }
    }

    /* --- 3. candidate generation ---------------------------------------- */
    let usedAnchor = false;
    let state = newState();

    if (anchor) {
      generate(state, fp, anchor, anchor);
      usedAnchor = state.total > 0;
    }
    if (state.total === 0) {
      // Anchor gone (or empty): it was only ever a scoping hint, never a
      // requirement, so fall back to the full search scope. ctx.anchor stays
      // put so `fp.path` and `structuralPath()` keep the same frame of
      // reference.
      state = newState();
      generate(state, fp, scope, anchor);
    }

    if (state.total === 0) return emptyResult();

    /* --- 4./5. score & rank --------------------------------------------- */
    let ranking: Ranking = { best: null, bestScore: 0, runnerUp: 0, scored: 0 };
    ranking = rank(fp, state.sameTag, ctx, startedAt, ranking);
    if (ranking.bestScore < threshold && state.otherTag.length > 0) {
      ranking = rank(fp, state.otherTag, ctx, startedAt, ranking);
    }

    const { best, bestScore, runnerUp, scored } = ranking;
    const strategy = strategyFor(state, usedAnchor);

    if (!best || bestScore < threshold) {
      return {
        element: null,
        score: bestScore,
        runnerUpScore: runnerUp,
        candidatesConsidered: scored,
        strategy: 'none',
        ambiguous: false,
      };
    }

    const ambiguous = bestScore - runnerUp < margin;

    /* --- 6. remember it -------------------------------------------------- */
    if (opts.cacheKey && !ambiguous) primeCache(opts.cacheKey, best);

    return {
      element: best,
      score: bestScore,
      runnerUpScore: runnerUp,
      candidatesConsidered: scored,
      strategy,
      ambiguous,
    };
  } catch (err) {
    log.error('findElement failed', err);
    return emptyResult();
  }
}

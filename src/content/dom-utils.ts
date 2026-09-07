/**
 * Low-level DOM helpers shared by the recorder, the matcher and the replayer.
 *
 * Every function in here runs on hostile third-party pages, often from inside a
 * MutationObserver hot path. Two consequences drive the style below:
 *  - nothing may throw (a torn-down node, a cross-origin quirk or an exotic
 *    element must degrade to a neutral value, never break the caller's loop);
 *  - allocation is avoided wherever a sibling walk or an index loop will do.
 */

import {
  DM_HIGHLIGHT_ATTR,
  DM_INSERTED_ATTR,
  DM_STYLE_ELEMENT_ID,
  GENERATED_ENTROPY_MIN_LENGTH,
  GENERATED_NAME_PATTERNS,
  IGNORED_ATTRS,
  SKIPPED_TAGS,
  TEST_ID_ATTRS,
  VOLATILE_ATTRS,
} from '@/shared/constants';
import { log } from '@/shared/logger';

/* -------------------------------------------------------------------------- */
/* Node predicates                                                            */
/* -------------------------------------------------------------------------- */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Guard used everywhere instead of `instanceof Element`, which breaks across frames. */
export function isElement(n: Node | null | undefined): n is Element {
  return !!n && n.nodeType === ELEMENT_NODE;
}

/** Guard used everywhere instead of `instanceof Text`, which breaks across frames. */
export function isTextNode(n: Node | null | undefined): n is Text {
  return !!n && n.nodeType === TEXT_NODE;
}

/* -------------------------------------------------------------------------- */
/* Text normalisation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Invisible characters that frameworks and i18n layers sprinkle into text:
 * soft hyphen, zero-width space/non-joiner/joiner, the bidi marks, word joiner
 * and BOM. They are *removed* rather than turned into spaces, because a
 * zero-width space sitting inside a word would otherwise split it in two.
 */
const ZERO_WIDTH_RE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;
const WHITESPACE_RE = /\s+/g;

/**
 * Canonical form for any text we compare across renders: zero-width noise gone,
 * every whitespace run collapsed to a single space (JS `\s` already covers the
 * nbsp at \u00a0), trimmed. Record time and replay time must agree exactly, so
 * this is the single choke point both sides go through.
 */
export function normalizeText(s: string | null | undefined): string {
  if (!s) return '';
  try {
    return s.replace(ZERO_WIDTH_RE, '').replace(WHITESPACE_RE, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Length-capped text with an ellipsis. Deterministic, so truncated values can
 * still be compared for equality between a recording and a replay.
 */
export function truncate(s: string, max: number): string {
  if (!s || max <= 0) return '';
  if (s.length <= max) return s;
  if (max === 1) return '\u2026';
  return `${s.slice(0, max - 1)}\u2026`;
}

/* -------------------------------------------------------------------------- */
/* Generated-name detection                                                   */
/* -------------------------------------------------------------------------- */

const SEPARATOR_RE = /[-_]+/;
const DIGIT_RE = /\d/;
const LOWER_RE = /[a-z]/;
const UPPER_RE = /[A-Z]/;
const HEX_ONLY_RE = /^[0-9a-f]+$/;
const HEX_LETTER_RE = /[a-f]/;

/**
 * A `-`/`_` separated segment that reads as a build hash rather than a word.
 * Only applied to *trailing* segments, so authored prefixes ("breakpoint",
 * "col") are never judged and tokens like `data-v-1a2b3c` still get caught.
 */
function segmentLooksHashed(seg: string): boolean {
  if (seg.length < 6) return false;
  if (!DIGIT_RE.test(seg)) return false;
  // a1B2c3D4 - nobody hand-writes camelCase with digits inside one segment.
  if (LOWER_RE.test(seg) && UPPER_RE.test(seg)) return true;
  // 1a2b3c - a bare hex run carrying both digits and hex letters.
  return HEX_ONLY_RE.test(seg) && HEX_LETTER_RE.test(seg);
}

/**
 * Entropy fallback for long, separator-free tokens that no pattern matched.
 * A digit is always required: without it, honest names like "backgroundimage"
 * score a high distinct-character ratio and would be thrown away.
 */
function looksHighEntropy(token: string): boolean {
  if (token.length < GENERATED_ENTROPY_MIN_LENGTH) return false;
  if (!DIGIT_RE.test(token)) return false;
  if (LOWER_RE.test(token) && UPPER_RE.test(token)) return true;
  return new Set(token).size / token.length >= 0.85;
}

/**
 * True when a class/id token was made up by a build tool or CSS-in-JS runtime.
 * Such tokens change between deploys (on Facebook, between sessions), so they
 * are stripped from fingerprints - keeping them would make every replay fail
 * the next time the site ships.
 */
export function isGeneratedName(token: string): boolean {
  if (!token) return false;
  try {
    for (let i = 0; i < GENERATED_NAME_PATTERNS.length; i++) {
      const re = GENERATED_NAME_PATTERNS[i];
      re.lastIndex = 0;
      if (re.test(token)) return true;
    }
    if (SEPARATOR_RE.test(token)) {
      const segments = token.split(SEPARATOR_RE);
      for (let i = 1; i < segments.length; i++) {
        if (segmentLooksHashed(segments[i])) return true;
      }
      return false;
    }
    return looksHighEntropy(token);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Classes and attributes                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every class token on an element, in source order.
 * Goes through `classList` first and falls back to the raw attribute so SVG
 * elements work too (their `className` is an SVGAnimatedString, not a string).
 */
export function allClassTokens(el: Element): string[] {
  try {
    const list = el.classList;
    if (list && list.length > 0) {
      const out: string[] = [];
      for (let i = 0; i < list.length; i++) {
        const token = list[i];
        if (token) out.push(token);
      }
      return out;
    }
    const raw = el.getAttribute('class');
    if (!raw) return [];
    return raw.split(WHITESPACE_RE).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The class tokens worth remembering: hashed/atomic ones removed, deduped and
 * sorted so two captures of the same element compare equal regardless of the
 * order the framework happened to emit them in.
 */
export function semanticClassTokens(el: Element): string[] {
  const tokens = allClassTokens(el);
  if (tokens.length === 0) return [];
  const kept = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!isGeneratedName(token)) kept.add(token);
  }
  return [...kept].sort();
}

/**
 * Đúng phần bù của `semanticClassTokens`: các token BỊ coi là do máy sinh.
 *
 * Vì sao vẫn giữ dù `fingerprint` chủ động vứt chúng khỏi `semanticClasses`:
 * với một node như `<span class="x108nfp6">55000</span>` — không id, không
 * testid, không aria-label — thì vứt hết class đi là node đó chẳng còn danh
 * tính nào ngoài chữ, mà chữ lại chính là thứ user vừa sửa.
 *
 * Class băm KHÔNG sống qua một lần deploy, nên tuyệt đối không được dùng làm
 * tín hiệu chính. Nhưng trong phạm vi một phiên làm việc — đúng vòng đời của
 * bản nháp — chúng hoàn toàn ổn định, và đủ để phân biệt hai node mà mọi tín
 * hiệu khác đều giống hệt nhau. Nên chúng được dùng như điểm CỘNG THÊM, không
 * bao giờ trừ điểm: khớp thì phá được thế hoà, đổi rồi thì coi như không có.
 */
export function volatileClassTokens(el: Element): string[] {
  const tokens = allClassTokens(el);
  if (tokens.length === 0) return [];
  const kept = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (isGeneratedName(tokens[i])) kept.add(tokens[i]);
  }
  return [...kept].sort();
}

/**
 * Sorted attribute *names* (values excluded - they churn). `class`/`id` live in
 * their own fingerprint fields, our own bookkeeping attributes and known
 * volatile ones are dropped, and so are generated names such as Vue's
 * `data-v-1a2b3c`, which changes on every build.
 */
export function attrKeysOf(el: Element): string[] {
  try {
    const names = el.getAttributeNames();
    const out: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i].toLowerCase();
      if (name === 'class' || name === 'id') continue;
      if (IGNORED_ATTRS.has(name) || VOLATILE_ATTRS.has(name)) continue;
      if (isGeneratedName(name)) continue;
      out.push(name);
    }
    return out.sort();
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Structure                                                                  */
/* -------------------------------------------------------------------------- */

/** Position among the parent's element children (0 when detached). */
export function elementChildIndex(el: Element): number {
  try {
    let index = 0;
    for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) index++;
    return index;
  } catch {
    return 0;
  }
}

/**
 * Position among the parent's element children *of the same tag*. Far more
 * stable than the raw child index, because frameworks constantly insert and
 * remove wrappers of other tags around a node.
 */
export function elementTagIndex(el: Element): number {
  try {
    const tag = el.tagName;
    let index = 0;
    for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.tagName === tag) index++;
    }
    return index;
  } catch {
    return 0;
  }
}

/** Number of element ancestors; `<html>` is 0. Bounded, so a cycle cannot hang us. */
export function elementDepth(el: Element): number {
  try {
    let depth = 0;
    let cur = el.parentElement;
    while (cur && depth < 512) {
      depth++;
      cur = cur.parentElement;
    }
    return depth;
  } catch {
    return 0;
  }
}

/**
 * Text contributed by the element itself (direct child text nodes only).
 * This is the signal that survives when children are re-rendered around it, and
 * it is what tells a leaf button apart from the container that wraps it.
 */
export function ownText(el: Element): string {
  try {
    let raw = '';
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === TEXT_NODE) raw += n.nodeValue ?? '';
    }
    return normalizeText(raw);
  } catch {
    return '';
  }
}

/** Whole subtree text, normalised and *not* truncated (callers decide the cap). */
export function fullText(el: Element): string {
  try {
    return normalizeText(el.textContent);
  } catch {
    return '';
  }
}

/**
 * Shape of the element's children, e.g. "span,span,svg". A cheap structural
 * signal that survives class/attribute churn; capped so huge lists stay small.
 */
export function childTagSignature(el: Element): string {
  try {
    const kids = el.children;
    const count = Math.min(kids.length, 12);
    if (count === 0) return '';
    const parts: string[] = [];
    for (let i = 0; i < count; i++) parts.push(kids[i].tagName.toLowerCase());
    return parts.join(',');
  } catch {
    return '';
  }
}

/** Direct child text nodes in document order - the addressing space for TextChange. */
export function textNodesOf(el: Element): Text[] {
  const out: Text[] = [];
  try {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (isTextNode(n)) out.push(n);
    }
  } catch {
    /* detached / torn-down node: an empty list is the honest answer */
  }
  return out;
}

/**
 * Index of `node` among `el`'s direct child text nodes, or -1.
 * Walks the sibling chain directly so the common case allocates nothing.
 */
export function textNodeIndexOf(el: Element, node: Text): number {
  try {
    let index = 0;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== TEXT_NODE) continue;
      if (n === node) return index;
      index++;
    }
  } catch {
    /* fall through to -1 */
  }
  return -1;
}

/* -------------------------------------------------------------------------- */
/* Ownership                                                                  */
/* -------------------------------------------------------------------------- */

const OUR_NODE_SELECTOR = `#${DM_STYLE_ELEMENT_ID},[${DM_HIGHLIGHT_ATTR}],[${DM_INSERTED_ATTR}]`;

/**
 * True for nodes this extension created or decorated. The recorder must ignore
 * them (otherwise it records its own highlights as user edits) and the replayer
 * must never treat them as page content.
 */
export function isOurNode(n: Node | null | undefined): boolean {
  if (!n) return false;
  try {
    const el = isElement(n) ? n : n.parentElement;
    if (!el) return false;
    if (el.id === DM_STYLE_ELEMENT_ID) return true;
    return el.closest(OUR_NODE_SELECTOR) !== null;
  } catch {
    return false;
  }
}

/** Elements we never fingerprint or edit: non-visual tags, plus our own nodes. */
export function isSkippedElement(el: Element): boolean {
  try {
    const tag = el.tagName;
    if (tag && SKIPPED_TAGS.has(tag.toLowerCase())) return true;
    return isOurNode(el);
  } catch {
    // Unreadable element: skipping is always the safe direction.
    return true;
  }
}

/* -------------------------------------------------------------------------- */
/* Selectors and URLs                                                         */
/* -------------------------------------------------------------------------- */

/** Manual CSS identifier escape, used only where `CSS.escape` is unavailable. */
function manualCssEscape(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0) {
      out += '\ufffd';
      continue;
    }
    const isDigit = code >= 0x30 && code <= 0x39;
    // A leading digit (or a digit right after a leading '-') must be hex-escaped.
    if (isDigit && (i === 0 || (i === 1 && value.charCodeAt(0) === 0x2d))) {
      out += `\\${code.toString(16)} `;
      continue;
    }
    const isSafe =
      code >= 0x80 ||
      isDigit ||
      code === 0x5f ||
      (code === 0x2d && value.length > 1) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a);
    out += isSafe ? value[i] : `\\${value[i]}`;
  }
  return out;
}

/** `CSS.escape` with a manual fallback, so selector building can never throw. */
export function cssEscape(value: string): string {
  try {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  } catch {
    /* fall through to the manual path */
  }
  return manualCssEscape(value);
}

/** Escape for use inside a double-quoted attribute-selector string. */
function escapeAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Longest URL fragment kept in a fingerprint; query strings can be enormous. */
const URL_ATTR_MAX = 240;

/**
 * Reduce an href/src to `pathname + search` so the same link fingerprints
 * identically across environments (localhost vs prod, http vs https, rotating
 * CDN hosts). Values carrying no locatable identity are dropped entirely:
 * empty, in-page fragments (every anchor on the page would collide on the
 * current path), and `javascript:` / `data:` / `blob:` / `about:` URLs.
 */
export function normalizeUrlAttr(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (raw.startsWith('#')) return undefined;
  if (/^(?:javascript|data|blob|about):/i.test(raw)) return undefined;
  try {
    const base = typeof document !== 'undefined' ? document.baseURI : '';
    const url = base ? new URL(raw, base) : new URL(raw);
    const out = `${url.pathname}${url.search}`;
    return out ? truncate(out, URL_ATTR_MAX) : undefined;
  } catch {
    // Relative URL with no usable base: keep the literal, it still discriminates.
    return truncate(raw, URL_ATTR_MAX);
  }
}

/**
 * Document-relative box, rounded. Offsetting by scroll makes it comparable
 * between a recording and a replay that happened at a different scroll
 * position. It is only ever a tie-breaker, hence `undefined` for anything the
 * layout gave no box to (display:none and friends).
 */
export function safeRect(el: Element): { x: number; y: number; w: number; h: number } | undefined {
  try {
    const rect = el.getBoundingClientRect();
    if (!rect) return undefined;
    if (rect.width === 0 && rect.height === 0) return undefined;
    const scrollX = typeof window !== 'undefined' ? window.scrollX : 0;
    const scrollY = typeof window !== 'undefined' ? window.scrollY : 0;
    const x = Math.round(rect.left + scrollX);
    const y = Math.round(rect.top + scrollY);
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
      return undefined;
    }
    return { x, y, w, h };
  } catch (err) {
    log.debug('safeRect failed', err);
    return undefined;
  }
}

/**
 * Short human label for logs, the popup list and the highlight overlay.
 * Text is only appended when the element actually owns it, so containers read
 * as `div#root` instead of dumping the whole page into the label.
 */
export function elementLabel(el: Element): string {
  try {
    let label = (el.tagName || 'node').toLowerCase();
    const id = el.getAttribute('id');
    if (id && !isGeneratedName(id)) {
      label += `#${id}`;
    } else {
      const cls = semanticClassTokens(el)[0];
      if (cls) label += `.${cls}`;
    }
    let text = ownText(el);
    if (!text && el.childElementCount === 0) text = fullText(el);
    if (!text) text = normalizeText(el.getAttribute('aria-label'));
    if (text) label += ` "${truncate(text, 30)}"`;
    return truncate(label, 60);
  } catch {
    return 'node';
  }
}

/* -------------------------------------------------------------------------- */
/* Set / string similarity                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Jaccard overlap of two token lists, 0..1. Two empty lists count as identical
 * (J of two empty sets is 1 by convention) so callers never see NaN; one empty
 * side means no overlap at all.
 */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setB) {
    if (setA.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Sorensen-Dice similarity over character bigrams, 0..1. Chosen over edit
 * distance because it is linear and forgiving about inserted or reordered
 * words - exactly how re-rendered labels drift ("Create" -> "Create ad").
 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Below two characters there are no bigrams; only exact equality can match.
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    const count = bigrams.get(gram) ?? 0;
    if (count > 0) {
      bigrams.set(gram, count - 1);
      hits++;
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

/* -------------------------------------------------------------------------- */
/* Stable anchors                                                             */
/* -------------------------------------------------------------------------- */

/** How far up we are willing to look for an anchor before giving up. */
const MAX_ANCHOR_WALK = 30;

/**
 * The scope a selector should be tested against: the shadow root when the
 * element lives in one, otherwise its document. Keeps uniqueness honest for
 * web-component internals, which a document-level query cannot even see.
 */
function searchRootOf(el: Element): ParentNode | null {
  try {
    const root = el.getRootNode() as unknown as Partial<ParentNode>;
    if (typeof root.querySelectorAll === 'function') return root as ParentNode;
    return el.ownerDocument;
  } catch {
    return null;
  }
}

function matchesOnlyTarget(root: ParentNode, selector: string, el: Element): boolean {
  try {
    const found = root.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

/**
 * A selector that pins this exact element, or `undefined`. Deliberately strict:
 * the name must not look generated *and* the selector must already match
 * exactly one element, because the matcher trusts an anchor completely and a
 * wrong anchor is worse than no anchor at all.
 */
export function stableSelectorFor(el: Element): string | undefined {
  try {
    const root = searchRootOf(el);
    if (!root) return undefined;
    const id = el.getAttribute('id');
    if (id && !isGeneratedName(id)) {
      const selector = `#${cssEscape(id)}`;
      if (matchesOnlyTarget(root, selector, el)) return selector;
    }
    for (const attr of TEST_ID_ATTRS) {
      const raw = el.getAttribute(attr);
      if (!raw) continue;
      const value = raw.trim();
      if (!value || isGeneratedName(value)) continue;
      const selector = `[${attr}="${escapeAttrValue(value)}"]`;
      if (matchesOnlyTarget(root, selector, el)) return selector;
    }
    return undefined;
  } catch (err) {
    log.debug('stableSelectorFor failed', err);
    return undefined;
  }
}

/**
 * Nearest ancestor (never the element itself) that has a stable selector.
 * Used to scope matching to a small subtree, which both speeds up replay and
 * removes whole classes of false positives on pages full of identical rows.
 */
export function closestStableAncestor(el: Element): Element | undefined {
  try {
    let cur = el.parentElement;
    let steps = 0;
    while (cur && steps < MAX_ANCHOR_WALK) {
      if (stableSelectorFor(cur)) return cur;
      cur = cur.parentElement;
      steps++;
    }
  } catch (err) {
    log.debug('closestStableAncestor failed', err);
  }
  return undefined;
}

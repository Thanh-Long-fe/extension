/**
 * Element fingerprinting.
 *
 * A fingerprint is the only thing that survives between the moment a user edits
 * a node and the moment we try to find "the same" node again - after F5, after
 * a SPA route change, after React re-rendered the subtree from scratch. On the
 * target sites CSS selectors are worthless (atomic hashed class names, no ids),
 * so instead of one brittle locator we capture many weak, independent signals
 * and let the matcher score them together. Everything here is therefore
 * deliberately redundant, and everything is defensive: fingerprinting must
 * never throw, because it runs from inside the recorder's mutation callback.
 */

import type { AncestorFingerprint, ElementFingerprint } from '@/shared/types';
import {
  ANCESTOR_DEPTH,
  ANCESTOR_TEXT_MAX,
  IDENTITY_ATTRS,
  MAX_ANCESTOR_VOLATILE_CLASSES,
  MAX_VOLATILE_CLASSES,
  TEST_ID_ATTRS,
  TEXT_FINGERPRINT_MAX,
} from '@/shared/constants';
import { log } from '@/shared/logger';
import {
  allClassTokens,
  attrKeysOf,
  childTagSignature,
  closestStableAncestor,
  elementChildIndex,
  elementDepth,
  elementTagIndex,
  fullText,
  isGeneratedName,
  normalizeText,
  normalizeUrlAttr,
  ownText,
  safeRect,
  semanticClassTokens,
  stableSelectorFor,
  truncate,
  volatileClassTokens,
} from './dom-utils';

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/** Hard cap on path length: deep React trees would otherwise produce novels. */
const PATH_MAX_STEPS = 25;

/**
 * Tags that are structural singletons in every HTML document, so writing an
 * index for them adds noise without adding information.
 */
const INDEXLESS_TAGS = new Set(['html', 'head', 'body']);

/**
 * Ancestor text is only a coarse locality hint, so we never normalise more than
 * this many raw characters. Without the cap, fingerprinting a node near <body>
 * would normalise the entire page text on every mutation.
 */
const ANCESTOR_TEXT_SCAN_MAX = 512;

/** Optional string-valued identity fields on ElementFingerprint. */
type IdentityField =
  | 'role'
  | 'ariaLabel'
  | 'name'
  | 'type'
  | 'placeholder'
  | 'alt'
  | 'title'
  | 'href'
  | 'src';

/**
 * Which IDENTITY_ATTRS have a typed home on the fingerprint. `for` and `value`
 * are in the constant but have no field in the frozen type - they still show up
 * in `attrKeys`, which is where the matcher can use them.
 */
const IDENTITY_FIELD_BY_ATTR: Readonly<Record<string, IdentityField | undefined>> = {
  role: 'role',
  'aria-label': 'ariaLabel',
  name: 'name',
  type: 'type',
  placeholder: 'placeholder',
  alt: 'alt',
  title: 'title',
  href: 'href',
  src: 'src',
};

/** Lowercase tag name that tolerates exotic / half-torn-down elements. */
function tagOf(el: Element): string {
  try {
    const tag = el.tagName;
    return tag ? tag.toLowerCase() : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** First test-id attribute carrying a value that is worth trusting. */
function pickTestId(el: Element): string | undefined {
  for (const attr of TEST_ID_ATTRS) {
    let raw: string | null = null;
    try {
      raw = el.getAttribute(attr);
    } catch {
      continue;
    }
    if (!raw) continue;
    const value = normalizeText(raw);
    // A hashed test id is as useless as a hashed class, so keep probing.
    if (!value || isGeneratedName(value)) continue;
    return truncate(value, TEXT_FINGERPRINT_MAX);
  }
  return undefined;
}

/** Element id, but only when it is a name a human wrote. */
function pickStableId(el: Element): string | undefined {
  try {
    const raw = el.getAttribute('id');
    if (!raw) return undefined;
    const id = raw.trim();
    if (!id || isGeneratedName(id)) return undefined;
    return truncate(id, TEXT_FINGERPRINT_MAX);
  } catch {
    return undefined;
  }
}

/** Cheap, capped subtree text for ancestors. */
function ancestorText(el: Element): string {
  try {
    const raw = el.textContent;
    if (!raw) return '';
    return truncate(normalizeText(raw.slice(0, ANCESTOR_TEXT_SCAN_MAX)), ANCESTOR_TEXT_MAX);
  } catch {
    return '';
  }
}

/**
 * Resolve an id reference the way the accessibility tree does: inside the
 * element's own root, so aria-labelledby still works in shadow DOM.
 */
function lookupById(el: Element, id: string): Element | null {
  try {
    const root = el.getRootNode() as unknown as Partial<{
      getElementById(elementId: string): Element | null;
    }>;
    if (typeof root.getElementById === 'function') return root.getElementById(id);
    return el.ownerDocument ? el.ownerDocument.getElementById(id) : null;
  } catch {
    return null;
  }
}

/** One `tag` / `tag:tagIndex` segment of a structural path. */
function pathSegment(el: Element): string {
  const tag = tagOf(el);
  if (INDEXLESS_TAGS.has(tag)) return tag;
  return `${tag}:${elementTagIndex(el)}`;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Root-to-element structural path, e.g. "body>div:2>div:0>button:1", where the
 * number after ':' is the tagIndex (position among same-tag siblings) rather
 * than the raw child index - wrappers of other tags come and go on every
 * render, siblings of the same tag are far steadier.
 *
 * Passing `stopAt` produces a path relative to that ancestor (exclusive), which
 * is what makes an anchored fingerprint survive changes higher up the tree.
 */
export function structuralPath(el: Element, stopAt?: Element | null): string {
  const parts: string[] = [];
  try {
    const doc = el.ownerDocument;
    const root = doc ? doc.documentElement : null;
    let cur: Element | null = el;
    let steps = 0;
    while (cur && steps < PATH_MAX_STEPS) {
      if (stopAt && cur === stopAt) break;
      parts.push(pathSegment(cur));
      if (cur === root) break;
      cur = cur.parentElement;
      steps++;
    }
  } catch (err) {
    log.error('structuralPath failed', err);
  }
  return parts.reverse().join('>');
}

/**
 * Compact identity of one ancestor. Ancestors are what rescue a fingerprint
 * when the element itself was rewritten wholesale: the surrounding dialog,
 * row or toolbar usually keeps its role, test id or heading text.
 */
export function fingerprintAncestor(el: Element): AncestorFingerprint {
  const fp: AncestorFingerprint = {
    tag: 'unknown',
    semanticClasses: [],
    childIndex: 0,
    tagIndex: 0,
  };
  try {
    fp.tag = tagOf(el);
    fp.semanticClasses = semanticClassTokens(el);
    const volatileClasses = volatileClassTokens(el);
    if (volatileClasses.length > 0) {
      fp.volatileClasses = volatileClasses.slice(0, MAX_ANCESTOR_VOLATILE_CLASSES);
    }
    fp.childIndex = elementChildIndex(el);
    fp.tagIndex = elementTagIndex(el);

    const id = pickStableId(el);
    if (id) fp.id = id;

    const testId = pickTestId(el);
    if (testId) fp.testId = testId;

    const role = normalizeText(el.getAttribute('role'));
    if (role) fp.role = truncate(role, ANCESTOR_TEXT_MAX);

    const ariaLabel = normalizeText(el.getAttribute('aria-label'));
    if (ariaLabel) fp.ariaLabel = truncate(ariaLabel, ANCESTOR_TEXT_MAX);

    const text = ancestorText(el);
    if (text) fp.text = text;
  } catch (err) {
    log.error('fingerprintAncestor failed', err);
  }
  return fp;
}

/**
 * Capture everything we will later need to re-find this element.
 *
 * Optional fields are omitted rather than stored as empty strings so the
 * matcher can distinguish "the element had no aria-label" from "the element had
 * an empty one" - the first means *skip this signal*, the second is evidence.
 */
export function fingerprintElement(el: Element): ElementFingerprint {
  const fp: ElementFingerprint = {
    v: 1,
    tag: tagOf(el),
    semanticClasses: [],
    classCount: 0,
    attrKeys: [],
    textLen: 0,
    childIndex: 0,
    tagIndex: 0,
    depth: 0,
    childTagSignature: '',
    ancestors: [],
    path: '',
  };

  try {
    /* --- strong signals ------------------------------------------------- */
    const id = pickStableId(el);
    if (id) fp.id = id;

    const testId = pickTestId(el);
    if (testId) fp.testId = testId;

    for (const attr of IDENTITY_ATTRS) {
      const field = IDENTITY_FIELD_BY_ATTR[attr];
      if (!field) continue;
      let raw: string | null = null;
      try {
        raw = el.getAttribute(attr);
      } catch {
        continue;
      }
      if (raw === null) continue;
      let value: string;
      if (attr === 'href' || attr === 'src') {
        const url = normalizeUrlAttr(raw);
        if (!url) continue;
        value = url;
      } else {
        value = normalizeText(raw);
      }
      if (!value) continue;
      fp[field] = truncate(value, TEXT_FINGERPRINT_MAX);
    }

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts: string[] = [];
      for (const rawId of labelledBy.split(/\s+/)) {
        if (!rawId) continue;
        const ref = lookupById(el, rawId);
        if (!ref) continue;
        const refText = fullText(ref);
        if (refText) parts.push(refText);
      }
      const joined = parts.join(' ');
      if (joined) fp.ariaLabelledByText = truncate(joined, TEXT_FINGERPRINT_MAX);
    }

    /* --- medium signals ------------------------------------------------- */
    fp.semanticClasses = semanticClassTokens(el);
    // Class băm: vô dụng qua một lần deploy, nhưng là danh tính duy nhất còn
    // lại của những node chỉ có atomic CSS. Matcher chỉ cộng điểm, không trừ.
    const volatileClasses = volatileClassTokens(el);
    if (volatileClasses.length > 0) {
      fp.volatileClasses = volatileClasses.slice(0, MAX_VOLATILE_CLASSES);
    }
    fp.classCount = allClassTokens(el).length;
    fp.attrKeys = attrKeysOf(el);

    /* --- content -------------------------------------------------------- */
    const own = ownText(el);
    if (own) fp.ownText = truncate(own, TEXT_FINGERPRINT_MAX);

    const text = fullText(el);
    // textLen is deliberately the *untruncated* length: it stays a usable size
    // signal even for elements whose text is far longer than the stored sample.
    fp.textLen = text.length;
    if (text) fp.text = truncate(text, TEXT_FINGERPRINT_MAX);

    /* --- structure ------------------------------------------------------ */
    fp.childIndex = elementChildIndex(el);
    fp.tagIndex = elementTagIndex(el);
    fp.depth = elementDepth(el);
    fp.childTagSignature = childTagSignature(el);

    const doc = el.ownerDocument;
    const documentElement = doc ? doc.documentElement : null;
    const ancestors: AncestorFingerprint[] = [];
    let cur = el.parentElement;
    while (cur && ancestors.length < ANCESTOR_DEPTH) {
      ancestors.push(fingerprintAncestor(cur));
      if (cur === documentElement) break;
      cur = cur.parentElement;
    }
    fp.ancestors = ancestors;

    const anchor = closestStableAncestor(el);
    const anchorSelector = anchor ? stableSelectorFor(anchor) : undefined;
    if (anchor && anchorSelector) {
      fp.anchorSelector = anchorSelector;
      fp.path = structuralPath(el, anchor);
    } else {
      fp.path = structuralPath(el, null);
    }

    /* --- weak signal ---------------------------------------------------- */
    const rect = safeRect(el);
    if (rect) fp.rect = rect;
  } catch (err) {
    // A partial fingerprint still matches better than none, so keep what we got.
    log.error('fingerprintElement failed', err);
  }

  return fp;
}

/**
 * The human-readable `targetLabel` stored on every change and rendered in the
 * popup. Built from the fingerprint rather than the live element so a change
 * still describes itself after the element it points at is long gone.
 */
export function describeFingerprint(fp: ElementFingerprint): string {
  try {
    let label = fp.tag || 'node';
    if (fp.id) {
      label += `#${fp.id}`;
    } else if (fp.testId) {
      label += `[data-testid=${fp.testId}]`;
    } else if (fp.semanticClasses.length > 0) {
      label += `.${fp.semanticClasses[0]}`;
    }

    const text =
      fp.ownText || fp.ariaLabel || fp.ariaLabelledByText || fp.text || fp.placeholder || fp.title || fp.alt;
    if (text) {
      label += ` "${truncate(text, 32)}"`;
    } else if (fp.role) {
      label += `[role=${fp.role}]`;
    } else if (fp.href) {
      label += `[href=${truncate(fp.href, 24)}]`;
    }

    return truncate(label, 64);
  } catch (err) {
    log.error('describeFingerprint failed', err);
    return fp.tag || 'node';
  }
}

/**
 * The "show me this element" overlay.
 *
 * The popup lists recorded changes; hovering/clicking one asks the content
 * script to point at the element it targets. That has to work on a page whose
 * CSS we do not control and must never disturb: everything is drawn inside a
 * closed Shadow DOM on a host that carries {@link DM_HIGHLIGHT_ATTR}, so
 * `isOurNode()` filters it out of the recorder (otherwise merely *looking* at a
 * change would record a change) and page stylesheets cannot reach the internals.
 *
 * The host's own box is pinned with `!important` inline styles because the page
 * can still match it with selectors like `html > div` or `* { display: none }`.
 */

import { DM_HIGHLIGHT_ATTR } from '@/shared/constants';
import { log } from '@/shared/logger';
import { elementLabel } from './dom-utils';

/** How long the overlay stays up when the caller does not say. */
const DEFAULT_DURATION_MS = 2000;

/** Height reserved for the label chip when deciding whether it fits above the box. */
const CHIP_HEIGHT_PX = 18;

/** Above everything a sane page uses; `pointer-events:none` keeps clicks flowing. */
const HOST_CSS = [
  'position:absolute!important',
  'top:0!important',
  'left:0!important',
  'width:0!important',
  'height:0!important',
  'margin:0!important',
  'padding:0!important',
  'border:0!important',
  'display:block!important',
  'visibility:visible!important',
  'opacity:1!important',
  'transform:none!important',
  'clip-path:none!important',
  'pointer-events:none!important',
  'z-index:2147483647!important',
].join(';');

const SHADOW_CSS = `
.dm-box {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid #8b5cf6;
  border-radius: 3px;
  background: rgba(139, 92, 246, 0.14);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.7), 0 2px 12px rgba(0, 0, 0, 0.28);
  pointer-events: none;
}
.dm-chip {
  position: absolute;
  box-sizing: border-box;
  max-width: 60vw;
  padding: 2px 6px;
  border-radius: 3px;
  background: #8b5cf6;
  color: #fff;
  font: 600 11px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
`;

let host: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let boxEl: HTMLElement | null = null;
let chipEl: HTMLElement | null = null;
let targetEl: Element | null = null;
let hideTimer: number | null = null;
let rafId: number | null = null;
let listening = false;

/**
 * Flash an outline over `el`.
 *
 * Scrolls the element into view when it is off screen, keeps the box glued to it
 * while the user scrolls or the window resizes, and clears itself after
 * `durationMs` (pass `0` or a negative number to keep it until
 * {@link clearHighlight}). A null element just clears — the popup uses that for
 * "this change no longer matches anything".
 */
export function highlightElement(
  el: Element | null,
  options?: { label?: string; durationMs?: number },
): void {
  try {
    clearHighlight();
    if (!el || !el.isConnected) return;

    const duration = options?.durationMs ?? DEFAULT_DURATION_MS;
    targetEl = el;

    if (!mount()) {
      targetEl = null;
      return;
    }

    if (chipEl) chipEl.textContent = labelFor(el, options?.label);

    scrollIntoViewIfNeeded(el);
    reposition();
    attachViewportListeners();

    if (duration > 0) {
      hideTimer = window.setTimeout(clearHighlight, duration);
    }
  } catch (e) {
    log.error('highlightElement failed', e);
    // Never leave half-built UI on the page.
    try {
      clearHighlight();
    } catch {
      /* already logged */
    }
  }
}

/** Tear the overlay down and stop every listener/timer it installed. */
export function clearHighlight(): void {
  try {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    detachViewportListeners();
    host?.remove();
  } catch (e) {
    log.error('clearHighlight failed', e);
  } finally {
    host = null;
    shadow = null;
    boxEl = null;
    chipEl = null;
    targetEl = null;
  }
}

/* -------------------------------------------------------------------------- */

/** Build the host + shadow tree. Returns false when the page is unusable. */
function mount(): boolean {
  // Both are typed non-null but really can be missing at document_start.
  const root: Element | null =
    (document.documentElement as HTMLElement | null) ?? (document.body as HTMLElement | null);
  if (!root) return false;

  host = document.createElement('div');
  host.setAttribute(DM_HIGHLIGHT_ATTR, '1');
  host.style.cssText = HOST_CSS;

  // "Closed-ish": closed mode keeps page scripts from walking into our nodes via
  // `host.shadowRoot`; we keep the only reference here in module scope.
  shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = SHADOW_CSS;

  boxEl = document.createElement('div');
  boxEl.className = 'dm-box';

  chipEl = document.createElement('div');
  chipEl.className = 'dm-chip';

  shadow.append(style, boxEl, chipEl);
  root.appendChild(host);
  return true;
}

/** Prefer the caller's label; otherwise describe the element the way the UI does. */
function labelFor(el: Element, label?: string): string {
  if (label) return label;
  try {
    return elementLabel(el);
  } catch {
    return el.tagName.toLowerCase();
  }
}

/**
 * Place the box over the element's *document*-relative rect.
 *
 * Document coordinates (viewport rect + scroll offset) are used rather than
 * `position:fixed` so the overlay survives ordinary scrolling untouched; the
 * scroll listener exists for elements that actually move (sticky headers,
 * virtualised lists), not for the scroll itself.
 */
function reposition(): void {
  if (!targetEl || !boxEl || !chipEl) return;
  try {
    if (!targetEl.isConnected) {
      clearHighlight();
      return;
    }
    const rect = targetEl.getBoundingClientRect();
    const left = rect.left + window.scrollX;
    const top = rect.top + window.scrollY;

    boxEl.style.left = `${Math.round(left)}px`;
    boxEl.style.top = `${Math.round(top)}px`;
    boxEl.style.width = `${Math.max(1, Math.round(rect.width))}px`;
    boxEl.style.height = `${Math.max(1, Math.round(rect.height))}px`;

    // Chip above the box, flipped inside when the element sits at the page top.
    const above = top - CHIP_HEIGHT_PX - 4;
    const chipTop = above >= window.scrollY ? above : top + 2;
    chipEl.style.left = `${Math.round(left)}px`;
    chipEl.style.top = `${Math.round(chipTop)}px`;
  } catch (e) {
    log.error('highlight reposition failed', e);
  }
}

/** Coalesce scroll/resize storms into one measurement per frame. */
function onViewportChange(): void {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    reposition();
  });
}

function attachViewportListeners(): void {
  if (listening) return;
  // Capture phase so scrolling of inner containers is seen too, passive so we
  // never delay the page's own scrolling.
  window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  window.addEventListener('resize', onViewportChange, { passive: true });
  listening = true;
}

function detachViewportListeners(): void {
  if (!listening) return;
  window.removeEventListener('scroll', onViewportChange, { capture: true });
  window.removeEventListener('resize', onViewportChange);
  listening = false;
}

/** Only scroll when the element is actually outside the viewport — never yank the page otherwise. */
function scrollIntoViewIfNeeded(el: Element): void {
  try {
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const offscreen = rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw;
    if (offscreen && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  } catch (e) {
    log.error('highlight scrollIntoView failed', e);
  }
}

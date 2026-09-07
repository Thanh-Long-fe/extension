/**
 * SPA route-change detection.
 *
 * WHY this is not just `popstate`: single-page apps navigate with
 * `history.pushState()` / `replaceState()`, and neither fires an event in the
 * page, let alone in us.
 *
 * WHY we do NOT monkey-patch History: a content script runs in an ISOLATED
 * world. Its `window` / `history` are a separate wrapper pair around the same
 * browsing context, so patching `history.pushState` here only intercepts calls
 * made by *our* code — the page's own `pushState` is untouched and our patch
 * would never fire. Injecting a patch into the main world would work but means
 * running script in the page's realm on a hostile third-party site, which this
 * extension refuses to do. So we observe from the outside instead:
 *
 *   1. the Navigation API (`window.navigation`) when the browser has it — this
 *      is the only source that reports same-document pushState navigations
 *      promptly and reliably;
 *   2. `popstate` + `hashchange`, which cover back/forward and anchor routing
 *      on browsers or pages the Navigation API misses;
 *   3. a cheap ~250 ms poll of `location.href`, because some routers reach the
 *      new URL in ways nothing above reports (e.g. a `replaceState` chain during
 *      hydration, or a same-document swap while the tab is throttled).
 *
 * All three feed one deduplicating check, so the handler only ever sees a real
 * href change.
 */

import { log } from '@/shared/logger';

/** Called once per actual URL change, with the new and the previous href. */
export type UrlChangeHandler = (url: string, previousUrl: string) => void;

/** Fallback poll interval. Cheap: one string compare, no DOM access. */
const POLL_MS = 250;

/**
 * Minimal structural type for the Navigation API.
 *
 * `@types/chrome` / `lib.dom` may not declare `window.navigation` yet, and this
 * codebase bans `any`, so we describe only the two methods we use and
 * feature-detect them before trusting the object.
 */
interface NavigationLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Events that mean "the current entry is now a different URL". */
const NAVIGATION_EVENTS = ['navigatesuccess', 'currententrychange'] as const;

/** The page's current href, or `''` if the location is unreadable (sandboxed frame). */
export function currentUrl(): string {
  try {
    return location.href;
  } catch {
    return '';
  }
}

/** Return `window.navigation` only when it really looks like the Navigation API. */
function getNavigation(): NavigationLike | null {
  try {
    const raw = (window as unknown as { navigation?: unknown }).navigation;
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as Partial<NavigationLike>;
    if (typeof candidate.addEventListener !== 'function') return null;
    if (typeof candidate.removeEventListener !== 'function') return null;
    return candidate as NavigationLike;
  } catch {
    return null;
  }
}

/**
 * Start watching for route changes; returns an unsubscribe that removes every
 * listener and clears the poll. Idempotent — calling it twice is harmless.
 *
 * The handler is invoked after the internal "previous url" bookkeeping is
 * updated, so a handler that itself navigates cannot cause a duplicate fire, and
 * a throwing handler is logged rather than allowed to kill the watcher.
 */
export function watchUrlChanges(onChange: UrlChangeHandler): () => void {
  let previous = currentUrl();
  let stopped = false;
  let intervalId: number | null = null;

  const check = (): void => {
    if (stopped) return;
    const next = currentUrl();
    if (!next || next === previous) return;
    const from = previous;
    previous = next; // update first: a re-entrant navigation must not re-fire `from`
    try {
      onChange(next, from);
    } catch (e) {
      log.error('url change handler threw', e);
    }
  };

  const navigation = getNavigation();

  try {
    // Same-document navigations settle a tick after the event; re-check on the
    // next task so `location.href` is guaranteed to be the new one.
    const soon = (): void => {
      check();
      window.setTimeout(check, 0);
    };

    window.addEventListener('popstate', soon, true);
    window.addEventListener('hashchange', soon, true);
    if (navigation) {
      for (const type of NAVIGATION_EVENTS) navigation.addEventListener(type, soon);
    }
    intervalId = window.setInterval(check, POLL_MS);

    return (): void => {
      if (stopped) return;
      stopped = true;
      try {
        window.removeEventListener('popstate', soon, true);
        window.removeEventListener('hashchange', soon, true);
        if (navigation) {
          for (const type of NAVIGATION_EVENTS) navigation.removeEventListener(type, soon);
        }
        if (intervalId !== null) {
          window.clearInterval(intervalId);
          intervalId = null;
        }
      } catch (e) {
        log.error('watchUrlChanges teardown failed', e);
      }
    };
  } catch (e) {
    // Something in the page's realm refused a listener; degrade to "no watcher"
    // rather than taking the content script down with us.
    log.error('watchUrlChanges setup failed', e);
    stopped = true;
    if (intervalId !== null) window.clearInterval(intervalId);
    return (): void => {
      /* nothing was successfully installed */
    };
  }
}

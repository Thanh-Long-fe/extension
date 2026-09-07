/**
 * The popup's single source of truth.
 *
 * Every component below `App` is deliberately dumb: this hook owns the active
 * tab, the polling loop, all messaging and every error path, so that a broken
 * page (no content script, a `chrome://` URL, a tab loaded before the extension
 * was installed) degrades into a flag the UI can render instead of an exception
 * that blanks the popup.
 *
 * State discipline: mutating `cs:` messages already answer with a fresh
 * `ContentState`, so actions never guess — they fire and then adopt the reply.
 * Nothing here is optimistic.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { POPUP_POLL_MS } from '@/shared/constants';
import { log, setLogLevel } from '@/shared/logger';
import { MessagingError, sendToBackground, sendToTab } from '@/shared/messages';
import { DEFAULT_SETTINGS } from '@/shared/types';
import type { ContentState, Settings, Snapshot, UrlMatchMode } from '@/shared/types';
import { originOf } from '@/shared/url-match';

/** The bits of the active tab the popup actually needs. */
export interface ActiveTab {
  id: number;
  url: string;
  title: string;
}

/** Payload for `cs:snapshot:commit`, produced by the save dialog. */
export interface SaveSnapshotInput {
  name: string;
  urlPattern: string;
  matchMode: UrlMatchMode;
  /** when set, the enabled pending changes are appended to that snapshot */
  snapshotId?: string;
}

/** Everything the popup tree is allowed to touch. */
export interface Controller {
  loading: boolean;
  error: string | null;
  /** the page has no content script — the UI must offer "reload the page" */
  unavailable: boolean;
  tab: ActiveTab | null;
  state: ContentState | null;
  settings: Settings;
  /** every snapshot stored for the active tab's origin */
  snapshots: Snapshot[];
  /** the subset of `snapshots` whose pattern matches the current URL */
  matching: Snapshot[];

  startRecording: () => void;
  stopRecording: () => void;
  clearPending: () => void;
  togglePending: (changeId: string, enabled: boolean) => void;
  deletePending: (changeId: string) => void;
  setAllPending: (enabled: boolean) => void;

  highlight: (changeId: string | null) => void;
  saveSnapshot: (input: SaveSnapshotInput) => Promise<Snapshot | null>;
  runReplay: () => void;
  revertReplay: () => void;
  refresh: () => void;

  toggleSnapshot: (id: string, enabled: boolean) => void;
  renameSnapshot: (id: string, name: string) => void;
  deleteSnapshot: (id: string) => void;
  deleteSnapshotChange: (snapshotId: string, changeId: string) => void;
  toggleSnapshotChange: (snapshotId: string, changeId: string, enabled: boolean) => void;

  updateSettings: (patch: Partial<Settings>) => void;
  exportSnapshots: () => void;
  importSnapshots: (file: File) => Promise<number>;
}

/** Resolve the tab the popup was opened over, or null when it is unusable. */
async function queryActiveTab(): Promise<ActiveTab | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const found = tabs[0];
  if (!found || typeof found.id !== 'number' || !found.url) return null;
  return { id: found.id, url: found.url, title: found.title ?? '' };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isDisconnect(e: unknown): boolean {
  return e instanceof MessagingError && e.disconnected;
}

/** Timestamp slug used for the export filename. */
function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * Wire the popup to the background page and to the content script of the
 * active tab. Polls `cs:state` while the popup is open and tears the interval
 * down on unmount.
 */
export function useController(): Controller {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [state, setState] = useState<ContentState | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [matching, setMatching] = useState<Snapshot[]>([]);

  /** Read inside timers, where the state closure would be stale. */
  const tabRef = useRef<ActiveTab | null>(null);
  /** True while any request is outstanding; the poll tick skips those turns. */
  const busyRef = useRef(false);
  const refreshTimer = useRef<number | null>(null);

  const fail = useCallback((e: unknown) => {
    if (isDisconnect(e)) {
      setUnavailable(true);
      setState(null);
      return;
    }
    log.error('popup:', e);
    setError(messageOf(e));
  }, []);

  /** Pull settings + snapshots for a URL from the background. */
  const loadStore = useCallback(async (url: string): Promise<void> => {
    const boot = await sendToBackground('bg:bootstrap', { url });
    setSettings(boot.settings);
    setLogLevel(boot.settings.logLevel);
    setSnapshots(boot.snapshots);
    setMatching(boot.matching);
  }, []);

  /**
   * Ask the content script to re-read storage and replay, a short while after
   * a background-side edit. Debounced because settings sliders fire per pixel.
   */
  const scheduleContentRefresh = useCallback(() => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      const active = tabRef.current;
      if (!active) return;
      sendToTab(active.id, 'cs:refresh', {})
        .then((next) => setState(next))
        .catch((e: unknown) => {
          if (isDisconnect(e)) setUnavailable(true);
          else log.error('popup: refresh failed', e);
        });
    }, 250);
  }, []);

  /** Run a content-script call, adopt its ContentState, never throw upwards. */
  const withTab = useCallback(
    async function runWithTab<T>(fn: (tabId: number) => Promise<T>): Promise<T | null> {
      const active = tabRef.current;
      if (!active) return null;
      busyRef.current = true;
      try {
        const result = await fn(active.id);
        setError(null);
        return result;
      } catch (e) {
        fail(e);
        return null;
      } finally {
        busyRef.current = false;
      }
    },
    [fail],
  );

  /** Run a background call, then resync snapshots/settings and the page. */
  const withStore = useCallback(
    async (fn: () => Promise<void>): Promise<void> => {
      busyRef.current = true;
      try {
        await fn();
        const active = tabRef.current;
        if (active) await loadStore(active.url);
        setError(null);
        scheduleContentRefresh();
      } catch (e) {
        fail(e);
      } finally {
        busyRef.current = false;
      }
    },
    [fail, loadStore, scheduleContentRefresh],
  );

  /* ----------------------------- bootstrap ------------------------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const active = await queryActiveTab();
        if (cancelled) return;
        if (!active) {
          setUnavailable(true);
          return;
        }
        tabRef.current = active;
        setTab(active);
        await loadStore(active.url);
        if (cancelled) return;
        try {
          const next = await sendToTab(active.id, 'cs:state', {});
          if (!cancelled) setState(next);
        } catch (e) {
          if (cancelled) return;
          if (isDisconnect(e)) setUnavailable(true);
          else throw e;
        }
      } catch (e) {
        if (!cancelled) fail(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadStore, fail]);

  /* ------------------------------- polling ------------------------------- */

  useEffect(() => {
    if (unavailable) return;
    const timer = window.setInterval(() => {
      const active = tabRef.current;
      if (!active || busyRef.current) return; // never overlap requests
      busyRef.current = true;
      sendToTab(active.id, 'cs:state', {})
        .then((next) => setState(next))
        .catch((e: unknown) => {
          if (isDisconnect(e)) setUnavailable(true);
        })
        .finally(() => {
          busyRef.current = false;
        });
    }, POPUP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [unavailable]);

  /* Drop the debounced refresh if the popup closes first. */
  useEffect(
    () => () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    },
    [],
  );

  /* ------------------------------ recording ------------------------------ */

  const startRecording = useCallback(() => {
    void withTab(async (id) => setState(await sendToTab(id, 'cs:record:start', {})));
  }, [withTab]);

  const stopRecording = useCallback(() => {
    void withTab(async (id) => setState(await sendToTab(id, 'cs:record:stop', {})));
  }, [withTab]);

  const clearPending = useCallback(() => {
    void withTab(async (id) => setState(await sendToTab(id, 'cs:record:clear', {})));
  }, [withTab]);

  const togglePending = useCallback(
    (changeId: string, enabled: boolean) => {
      void withTab(async (id) =>
        setState(await sendToTab(id, 'cs:pending:setEnabled', { changeId, enabled })),
      );
    },
    [withTab],
  );

  const deletePending = useCallback(
    (changeId: string) => {
      void withTab(async (id) =>
        setState(await sendToTab(id, 'cs:pending:delete', { changeId })),
      );
    },
    [withTab],
  );

  const setAllPending = useCallback(
    (enabled: boolean) => {
      void withTab(async (id) =>
        setState(await sendToTab(id, 'cs:pending:setAllEnabled', { enabled })),
      );
    },
    [withTab],
  );

  /* ------------------------------- replay -------------------------------- */

  const highlight = useCallback(
    (changeId: string | null) => {
      void withTab(async (id) => {
        await sendToTab(id, 'cs:highlight', { changeId });
      });
    },
    [withTab],
  );

  const runReplay = useCallback(() => {
    void withTab(async (id) => setState(await sendToTab(id, 'cs:replay:run', {})));
  }, [withTab]);

  const revertReplay = useCallback(() => {
    void withTab(async (id) => setState(await sendToTab(id, 'cs:replay:revert', {})));
  }, [withTab]);

  const refresh = useCallback(() => {
    void withTab(async (id) => {
      const active = tabRef.current;
      if (active) await loadStore(active.url);
      setState(await sendToTab(id, 'cs:refresh', {}));
    });
  }, [withTab, loadStore]);

  /* ------------------------------ snapshots ------------------------------ */

  const saveSnapshot = useCallback(
    async (input: SaveSnapshotInput): Promise<Snapshot | null> => {
      const result = await withTab(async (id) => {
        const res = await sendToTab(id, 'cs:snapshot:commit', {
          name: input.name,
          urlPattern: input.urlPattern,
          matchMode: input.matchMode,
          snapshotId: input.snapshotId,
        });
        const active = tabRef.current;
        if (active) await loadStore(active.url);
        setState(await sendToTab(id, 'cs:state', {}));
        return res.snapshot;
      });
      return result;
    },
    [withTab, loadStore],
  );

  const toggleSnapshot = useCallback(
    (id: string, enabled: boolean) => {
      void withStore(async () => {
        await sendToBackground('bg:snapshots:update', { id, patch: { enabled } });
      });
    },
    [withStore],
  );

  const renameSnapshot = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      void withStore(async () => {
        await sendToBackground('bg:snapshots:update', { id, patch: { name: trimmed } });
      });
    },
    [withStore],
  );

  const deleteSnapshot = useCallback(
    (id: string) => {
      void withStore(async () => {
        await sendToBackground('bg:snapshots:delete', { id });
      });
    },
    [withStore],
  );

  const deleteSnapshotChange = useCallback(
    (snapshotId: string, changeId: string) => {
      void withStore(async () => {
        await sendToBackground('bg:snapshots:deleteChange', { snapshotId, changeId });
      });
    },
    [withStore],
  );

  const toggleSnapshotChange = useCallback(
    (snapshotId: string, changeId: string, enabled: boolean) => {
      void withStore(async () => {
        await sendToBackground('bg:snapshots:setChangeEnabled', { snapshotId, changeId, enabled });
      });
    },
    [withStore],
  );

  /* ------------------------------- settings ------------------------------ */

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      busyRef.current = true;
      sendToBackground('bg:settings:set', { patch })
        .then((next) => {
          setSettings(next);
          setLogLevel(next.logLevel);
          setError(null);
          scheduleContentRefresh();
        })
        .catch((e: unknown) => fail(e))
        .finally(() => {
          busyRef.current = false;
        });
    },
    [fail, scheduleContentRefresh],
  );

  /* -------------------------- export / import ---------------------------- */

  const exportSnapshots = useCallback(() => {
    const active = tabRef.current;
    const origin = active ? originOf(active.url) : '';
    busyRef.current = true;
    sendToBackground('bg:export', { origin: origin || undefined })
      .then((bundle) => {
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
        const href = URL.createObjectURL(blob);
        const host = origin ? origin.replace(/^https?:\/\//, '').replace(/[^\w.-]/g, '-') : 'all';
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = `dom-modifier-${host}-${stamp()}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(href), 4000);
      })
      .catch((e: unknown) => fail(e))
      .finally(() => {
        busyRef.current = false;
      });
  }, [fail]);

  const importSnapshots = useCallback(
    async (file: File): Promise<number> => {
      busyRef.current = true;
      try {
        const json = await file.text();
        const res = await sendToBackground('bg:import', { json, mode: 'merge' });
        const active = tabRef.current;
        if (active) await loadStore(active.url);
        setError(null);
        scheduleContentRefresh();
        return res.imported;
      } catch (e) {
        fail(e);
        return 0;
      } finally {
        busyRef.current = false;
      }
    },
    [fail, loadStore, scheduleContentRefresh],
  );

  return {
    loading,
    error,
    unavailable,
    tab,
    state,
    settings,
    snapshots,
    matching,
    startRecording,
    stopRecording,
    clearPending,
    togglePending,
    deletePending,
    setAllPending,
    highlight,
    saveSnapshot,
    runReplay,
    revertReplay,
    refresh,
    toggleSnapshot,
    renameSnapshot,
    deleteSnapshot,
    deleteSnapshotChange,
    toggleSnapshotChange,
    updateSettings,
    exportSnapshots,
    importSnapshots,
  };
}

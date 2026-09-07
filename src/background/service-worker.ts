/**
 * MV3 background service worker: the extension's only writer of durable state
 * and the only piece that can talk to `chrome.tabs` / `chrome.action`.
 *
 * Three rules shape everything below.
 *
 *  1. The worker is killed and revived per event. Every listener is therefore
 *     registered **synchronously at module top level** — a listener added from
 *     inside a promise callback is simply missing on the wake-up that mattered,
 *     and the message that woke us is dropped with "Receiving end does not
 *     exist".
 *  2. Nothing important lives in a module variable, because the module is
 *     re-evaluated from scratch on every revival. All durable state goes
 *     through `@/storage/snapshot-storage`; the only module state here is a
 *     debounce timer, whose loss costs at most one redundant refresh.
 *  3. Handlers run on behalf of hostile third-party pages, so every one of them
 *     is wrapped: a rejection is normalised into a real `Error` with a readable
 *     message, since the messaging layer only transports `error.message`.
 */

import type { BgHandlers, BgProtocol, BootstrapPayload } from '@/shared/messages';
import { notifyTab, registerBackgroundHandlers } from '@/shared/messages';
import type { Settings, Snapshot } from '@/shared/types';
import { DEFAULT_SETTINGS } from '@/shared/types';
import { EXTENSION_VERSION } from '@/shared/constants';
import { originOf, snapshotMatches } from '@/shared/url-match';
import { log, setLogLevel } from '@/shared/logger';
import {
  appendChanges,
  clearDraft,
  clearRecording,
  deleteChange,
  deleteSnapshot,
  exportSnapshots,
  getDraft,
  getRecording,
  getSettings,
  getSnapshot,
  importSnapshots,
  listSnapshots,
  matchingSnapshots,
  onSnapshotsChanged,
  readAll,
  saveSnapshot,
  setChangeEnabled,
  setDraft,
  setRecording,
  setSettings,
  updateSnapshot,
} from '@/storage/snapshot-storage';

/* ========================================================================== */
/* Tunables                                                                   */
/* ========================================================================== */

/** Fan-out window for storage edits: a burst of writes must refresh tabs once. */
const BROADCAST_DEBOUNCE_MS = 150;

/** Only these tabs can host the content script, so only these are broadcast to. */
const BROADCAST_URL_PATTERNS = ['http://*/*', 'https://*/*'];

/** Recording is a destructive-looking mode; red is the one colour users read as "live". */
const BADGE_RECORDING_COLOR = '#ef4444';

/** Applied-count badge, matching the popup's accent so the two read as one product. */
const BADGE_APPLIED_COLOR = '#6366f1';

const BASE_TITLE = 'DOM Modifier';

/* ========================================================================== */
/* Small guarded helpers                                                      */
/* ========================================================================== */

/** `chrome` can be half torn down mid-suspension; never let that throw upwards. */
function hasChrome(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime;
  } catch {
    return false;
  }
}

/** The manifest is the source of truth for the version; the constant is a fallback. */
function extensionVersion(): string {
  try {
    return chrome.runtime.getManifest().version || EXTENSION_VERSION;
  } catch {
    return EXTENSION_VERSION;
  }
}

/** A usable tab id: real tabs are non-negative integers, `TAB_ID_NONE` is -1. */
function isTabId(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** First usable tab id, in caller-defined preference order. */
function pickTabId(...candidates: (number | undefined)[]): number | null {
  for (const candidate of candidates) {
    if (isTabId(candidate)) return candidate;
  }
  return null;
}

/**
 * Keep the worker's own console at the level the user picked.
 *
 * The worker restarts constantly and cannot afford a storage read per wake just
 * to configure logging, so instead every path that already holds a `Settings`
 * object pushes it here for free.
 */
function applyLogLevel(settings: Settings): Settings {
  setLogLevel(settings.logLevel);
  return settings;
}

/* ========================================================================== */
/* Handler wrapper                                                            */
/* ========================================================================== */

/**
 * Wrap one protocol handler so its failures reach the caller intact.
 *
 * `registerBackgroundHandlers` serialises `error.message` only: a rejection
 * with a string, a DOMException or `undefined` would arrive as an unreadable
 * blob. This re-throws a real `Error` tagged with the message type, and logs
 * the original (with its stack) on the worker side.
 */
function handler<K extends keyof BgProtocol>(
  type: K,
  run: (
    payload: BgProtocol[K]['req'],
    sender: chrome.runtime.MessageSender,
  ) => Promise<BgProtocol[K]['res']>,
): (
  payload: BgProtocol[K]['req'],
  sender: chrome.runtime.MessageSender,
) => Promise<BgProtocol[K]['res']> {
  return async (payload, sender) => {
    try {
      return await run(payload, sender);
    } catch (e) {
      const detail = e instanceof Error && e.message ? e.message : String(e);
      log.error(`background: ${type} failed —`, e);
      throw new Error(`${type}: ${detail}`);
    }
  };
}

/* ========================================================================== */
/* Bootstrap                                                                  */
/* ========================================================================== */

/** Popup ordering: most recently touched first. Mirrors `listSnapshots`. */
function byRecency(a: Snapshot, b: Snapshot): number {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;
}

/** Replay ordering: oldest first, so a newer snapshot wins a contested element. */
function byAge(a: Snapshot, b: Snapshot): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/**
 * Everything the popup needs to render, from **one** storage read.
 *
 * Calling `getSettings` + `listSnapshots` + `matchingSnapshots` would do the
 * same work three times and — because each read re-runs migration — three times
 * as much validation, on the click that has to feel instant.
 */
async function buildBootstrap(url: string, tabId: number | null): Promise<BootstrapPayload> {
  const state = await readAll();
  const settings = applyLogLevel(state.settings);
  const all = Object.values(state.snapshots);
  const origin = originOf(url);

  const snapshots = (origin ? all.filter((s) => s.origin === origin) : all.slice()).sort(byRecency);
  const matching = all.filter((s) => s.enabled && snapshotMatches(s, url)).sort(byAge);

  // Bản nháp chỉ có nghĩa với một tab cụ thể; popup gọi bootstrap thì `sender.tab`
  // là undefined và nó cũng đã lấy pending qua `cs:state` rồi.
  const draft = tabId !== null && settings.autoDraft ? await getDraft(tabId, url) : [];

  return { settings, snapshots, matching, draft };
}

/* ========================================================================== */
/* Badge                                                                      */
/* ========================================================================== */

/** Every `chrome.action` call can reject if the tab died mid-flight: swallow it. */
async function safeAction(op: string, call: () => Promise<void>): Promise<void> {
  try {
    if (!hasChrome() || !chrome.action) return;
    await call();
  } catch (e) {
    log.debug(`background: chrome.action.${op} skipped`, e);
  }
}

/** Badges have room for ~4 glyphs; clamp instead of rendering an ellipsis. */
function badgeCount(applied: number): string {
  if (!Number.isFinite(applied) || applied <= 0) return '';
  return applied > 99 ? '99+' : String(Math.trunc(applied));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Paint one tab's toolbar badge.
 *
 * Recording always shows, regardless of `showBadge`: a user who forgets they
 * are recording keeps accumulating pending edits, so that state is never
 * allowed to be invisible. The applied count is opt-in, since on a page with
 * many changes it is just noise.
 */
async function paintBadge(
  tabId: number,
  input: { applied: number; recording: boolean; pending: number },
): Promise<void> {
  const applied = Math.max(0, Math.trunc(Number(input.applied) || 0));
  const pending = Math.max(0, Math.trunc(Number(input.pending) || 0));

  let text = '';
  let color = BADGE_APPLIED_COLOR;
  let title = BASE_TITLE;

  if (input.recording) {
    text = 'REC';
    color = BADGE_RECORDING_COLOR;
    title = `${BASE_TITLE} — recording (${plural(pending, 'pending change')})`;
  } else {
    const settings = applyLogLevel(await getSettings());
    if (settings.showBadge && applied > 0) text = badgeCount(applied);
    title = applied > 0 ? `${BASE_TITLE} — ${plural(applied, 'change')} applied` : BASE_TITLE;
  }

  // Colour first: setting the text before the colour can flash the previous
  // colour for a frame when a tab switches from REC to a count.
  if (text) {
    await safeAction('setBadgeBackgroundColor', () =>
      chrome.action.setBadgeBackgroundColor({ tabId, color }),
    );
  }
  await safeAction('setBadgeText', () => chrome.action.setBadgeText({ tabId, text }));
  await safeAction('setTitle', () => chrome.action.setTitle({ tabId, title }));
}

/* ========================================================================== */
/* Refresh broadcast                                                          */
/* ========================================================================== */

/**
 * The only module-level state in this file.
 *
 * Losing it to a suspension costs one skipped refresh at worst, and the worker
 * is kept alive well past this window by the event that scheduled it.
 */
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Tell every content script to re-read storage and replay.
 *
 * Fire-and-forget per tab (`notifyTab` swallows "no receiving end"), because
 * most tabs on `http(s)` will not have our content script alive at all.
 */
export async function refreshAllTabs(): Promise<void> {
  try {
    if (!hasChrome() || !chrome.tabs) return;
    const tabs = await chrome.tabs.query({ url: BROADCAST_URL_PATTERNS });
    const sends: Promise<void>[] = [];
    for (const tab of tabs) {
      if (isTabId(tab.id)) sends.push(notifyTab(tab.id, 'cs:refresh', {}));
    }
    await Promise.all(sends);
    log.debug(`background: refreshed ${sends.length} tab(s)`);
  } catch (e) {
    log.error('background: broadcasting cs:refresh failed', e);
  }
}

/**
 * Coalesce a burst of storage writes into one fan-out.
 *
 * Importing a bundle or toggling ten changes writes ten times in a few ms;
 * without this, every open tab would replay ten times over.
 */
function scheduleRefreshBroadcast(): void {
  try {
    if (broadcastTimer !== null) clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      void refreshAllTabs();
    }, BROADCAST_DEBOUNCE_MS);
  } catch (e) {
    log.error('background: could not schedule a refresh broadcast', e);
  }
}

/* ========================================================================== */
/* Protocol handlers                                                          */
/* ========================================================================== */

/**
 * The complete `BgProtocol` handler table.
 *
 * Exported so the table can be inspected or exercised directly; the worker
 * itself installs it synchronously below.
 */
export const bgHandlers: BgHandlers = {
  'bg:bootstrap': handler('bg:bootstrap', async (payload, sender) =>
    buildBootstrap(payload.url, pickTabId(sender.tab?.id)),
  ),

  'bg:snapshots:list': handler('bg:snapshots:list', async (payload) =>
    listSnapshots(payload.origin),
  ),

  'bg:snapshots:matching': handler('bg:snapshots:matching', async (payload) =>
    matchingSnapshots(payload.url),
  ),

  'bg:snapshots:get': handler('bg:snapshots:get', async (payload) => getSnapshot(payload.id)),

  'bg:snapshots:save': handler('bg:snapshots:save', async (payload) =>
    saveSnapshot(payload.snapshot),
  ),

  'bg:snapshots:update': handler('bg:snapshots:update', async (payload) =>
    updateSnapshot(payload.id, payload.patch),
  ),

  'bg:snapshots:delete': handler('bg:snapshots:delete', async (payload) => {
    await deleteSnapshot(payload.id);
    return { ok: true };
  }),

  'bg:snapshots:appendChanges': handler('bg:snapshots:appendChanges', async (payload) =>
    appendChanges(payload.snapshotId, payload.changes),
  ),

  'bg:snapshots:deleteChange': handler('bg:snapshots:deleteChange', async (payload) =>
    deleteChange(payload.snapshotId, payload.changeId),
  ),

  'bg:snapshots:setChangeEnabled': handler('bg:snapshots:setChangeEnabled', async (payload) =>
    setChangeEnabled(payload.snapshotId, payload.changeId, payload.enabled),
  ),

  'bg:settings:get': handler('bg:settings:get', async () => applyLogLevel(await getSettings())),

  'bg:settings:set': handler('bg:settings:set', async (payload) =>
    applyLogLevel(await setSettings(payload.patch)),
  ),

  'bg:export': handler('bg:export', async (payload) =>
    exportSnapshots({ ids: payload.ids, origin: payload.origin }),
  ),

  'bg:import': handler('bg:import', async (payload) => {
    const imported = await importSnapshots(payload.json, payload.mode);
    return { imported };
  }),

  // Bản nháp: `sender.tab` được ưu tiên vì content script luôn đúng về tab của
  // chính nó; payload.tabId chỉ là đường lui cho popup.
  'bg:draft:set': handler('bg:draft:set', async (payload, sender) => {
    const tabId = pickTabId(sender.tab?.id, payload.tabId);
    if (tabId === null) throw new Error('no tab id in the payload and no tab behind the sender');
    return setDraft(tabId, payload.url, payload.changes);
  }),

  'bg:draft:get': handler('bg:draft:get', async (payload, sender) => {
    const tabId = pickTabId(sender.tab?.id, payload.tabId);
    if (tabId === null) throw new Error('no tab id in the payload and no tab behind the sender');
    return { changes: await getDraft(tabId, payload.url) };
  }),

  'bg:draft:clear': handler('bg:draft:clear', async (payload, sender) => {
    const tabId = pickTabId(sender.tab?.id, payload.tabId);
    if (tabId === null) throw new Error('no tab id in the payload and no tab behind the sender');
    await clearDraft(tabId, payload.url);
    return { ok: true };
  }),

  'bg:recording:get': handler('bg:recording:get', async (payload, sender) => {
    // Payload wins: the popup knows which tab it is acting on, and its own
    // `sender.tab` is undefined.
    const tabId = pickTabId(payload.tabId, sender.tab?.id);
    if (tabId === null) throw new Error('no tab id in the payload and no tab behind the sender');
    return { recording: await getRecording(tabId) };
  }),

  'bg:recording:set': handler('bg:recording:set', async (payload, sender) => {
    const tabId = pickTabId(payload.tabId, sender.tab?.id);
    if (tabId === null) throw new Error('no tab id in the payload and no tab behind the sender');
    const recording = payload.recording === true;
    await setRecording(tabId, recording);
    return { recording };
  }),

  'bg:badge': handler('bg:badge', async (payload, sender) => {
    // Sender wins here: the content script reporting its own replay result is
    // always right about which tab it is in, even if it echoes a stale tabId.
    const tabId = pickTabId(sender.tab?.id, payload.tabId);
    if (tabId === null) {
      log.debug('background: bg:badge without a resolvable tab; nothing to paint');
      return { ok: true };
    }
    await paintBadge(tabId, payload);
    return { ok: true };
  }),
};

/* ========================================================================== */
/* Lifecycle                                                                  */
/* ========================================================================== */

/**
 * Seed defaults on install, and force the migration to run on update.
 *
 * `readAll()` *is* the migration: it normalises, re-validates and writes back
 * whatever the previous version left behind, so an upgraded user never hits a
 * half-migrated record on their first replay.
 */
async function handleInstalled(details: chrome.runtime.InstalledDetails): Promise<void> {
  const version = extensionVersion();
  try {
    if (details.reason === 'install') {
      const settings = applyLogLevel(await setSettings(DEFAULT_SETTINGS));
      log.info(`background: installed v${version} (log level ${settings.logLevel})`);
      return;
    }
    if (details.reason === 'update') {
      const state = await readAll();
      applyLogLevel(state.settings);
      const count = Object.keys(state.snapshots).length;
      log.info(
        `background: updated to v${version} from ${details.previousVersion ?? 'unknown'} ` +
          `(schema ${state.schemaVersion}, ${plural(count, 'snapshot')})`,
      );
      return;
    }
    log.debug(`background: onInstalled "${details.reason}" on v${version}`);
  } catch (e) {
    // A failure here must not stop the worker from serving messages.
    log.error(`background: onInstalled (${details.reason}) failed`, e);
  }
}

/* ========================================================================== */
/* Top-level wiring — everything below must stay synchronous                  */
/* ========================================================================== */

registerBackgroundHandlers(bgHandlers);

try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    // Recording is per tab and lives in session storage; a closed tab would
    // otherwise leave its flag behind for a recycled id to inherit.
    void clearRecording(tabId);
    // Bản nháp cũng vậy — và quan trọng hơn: Chrome tái sử dụng tab id, nên nếu
    // không dọn thì tab mới sẽ thừa hưởng đống sửa dở của tab đã đóng.
    void clearDraft(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // A finished load means a brand-new DOM and a content script that has not
    // seen storage yet; poke it rather than making it poll.
    if (changeInfo.status === 'complete') void notifyTab(tabId, 'cs:refresh', {});
  });
} catch (e) {
  log.error('background: could not register tab listeners', e);
}

// Any edit — this worker, another popup window, a second profile window —
// re-broadcasts to every tab, so two open tabs of the same site never drift.
onSnapshotsChanged(scheduleRefreshBroadcast);

try {
  chrome.runtime.onInstalled.addListener((details) => {
    void handleInstalled(details);
  });
} catch (e) {
  log.error('background: could not register onInstalled', e);
}

log.debug(`background: service worker ready (v${extensionVersion()})`);

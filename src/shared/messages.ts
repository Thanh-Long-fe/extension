/**
 * Typed message protocol.
 *
 * Two independent channels, which never collide because Chrome routes them
 * differently:
 *   - popup/content  -> background  via chrome.runtime.sendMessage  (BgProtocol)
 *   - popup/background -> content   via chrome.tabs.sendMessage     (CsProtocol)
 *
 * Every handler's return value is wrapped in an envelope so thrown errors
 * survive the boundary instead of turning into `undefined`.
 */

import type {
  ApplyReport,
  Change,
  ContentState,
  ExportBundle,
  Settings,
  Snapshot,
  UrlMatchMode,
} from './types';

/* ========================================================================== */
/* Protocols                                                                  */
/* ========================================================================== */

export interface BootstrapPayload {
  settings: Settings;
  /** every snapshot for the given origin */
  snapshots: Snapshot[];
  /** subset of `snapshots` whose pattern matches the given url */
  matching: Snapshot[];
  /**
   * Các thay đổi chưa lưu của tab + route này, còn sót lại từ lần tải trang
   * trước. Rỗng khi popup gọi (popup không phải là tab), khi tắt `autoDraft`,
   * hoặc khi chưa có gì để khôi phục.
   */
  draft: Change[];
}

export interface BgProtocol {
  'bg:bootstrap': { req: { url: string }; res: BootstrapPayload };

  'bg:snapshots:list': { req: { origin?: string }; res: Snapshot[] };
  'bg:snapshots:matching': { req: { url: string }; res: Snapshot[] };
  'bg:snapshots:get': { req: { id: string }; res: Snapshot | null };
  /** create when the id is unknown, otherwise replace wholesale */
  'bg:snapshots:save': { req: { snapshot: Snapshot }; res: Snapshot };
  'bg:snapshots:update': { req: { id: string; patch: Partial<Snapshot> }; res: Snapshot | null };
  'bg:snapshots:delete': { req: { id: string }; res: { ok: true } };
  'bg:snapshots:appendChanges': {
    req: { snapshotId: string; changes: Change[] };
    res: Snapshot | null;
  };
  'bg:snapshots:deleteChange': {
    req: { snapshotId: string; changeId: string };
    res: Snapshot | null;
  };
  'bg:snapshots:setChangeEnabled': {
    req: { snapshotId: string; changeId: string; enabled: boolean };
    res: Snapshot | null;
  };

  'bg:settings:get': { req: Record<string, never>; res: Settings };
  'bg:settings:set': { req: { patch: Partial<Settings> }; res: Settings };

  'bg:export': { req: { ids?: string[]; origin?: string }; res: ExportBundle };
  'bg:import': { req: { json: string; mode: 'merge' | 'replace' }; res: { imported: number } };

  /**
   * Ghi đè bản nháp của route hiện tại. `changes` rỗng nghĩa là xoá route đó
   * khỏi bản nháp, không phải lưu một danh sách rỗng.
   */
  'bg:draft:set': {
    req: { tabId?: number; url: string; changes: Change[] };
    res: { saved: number; savedAt: number };
  };
  /** Đọc bản nháp của một route (dùng khi cần lấy lại ngoài luồng bootstrap). */
  'bg:draft:get': { req: { tabId?: number; url: string }; res: { changes: Change[] } };
  /** Xoá bản nháp: chỉ route của `url` khi có, còn không thì cả tab. */
  'bg:draft:clear': { req: { tabId?: number; url?: string }; res: { ok: true } };

  'bg:recording:get': { req: { tabId?: number }; res: { recording: boolean } };
  'bg:recording:set': { req: { tabId?: number; recording: boolean }; res: { recording: boolean } };

  'bg:badge': {
    req: { tabId?: number; applied: number; recording: boolean; pending: number };
    res: { ok: true };
  };
}

export interface CsProtocol {
  'cs:ping': { req: Record<string, never>; res: { ok: true; version: string } };
  'cs:state': { req: Record<string, never>; res: ContentState };

  'cs:record:start': { req: Record<string, never>; res: ContentState };
  'cs:record:stop': { req: Record<string, never>; res: ContentState };
  'cs:record:clear': { req: Record<string, never>; res: ContentState };

  'cs:pending:setEnabled': { req: { changeId: string; enabled: boolean }; res: ContentState };
  'cs:pending:delete': { req: { changeId: string }; res: ContentState };
  'cs:pending:setAllEnabled': { req: { enabled: boolean }; res: ContentState };

  /** flash an outline over the element a change points at; null clears */
  'cs:highlight': { req: { changeId: string | null }; res: { ok: true; found: boolean } };

  /** commit the enabled pending changes into a snapshot (new, or appended) */
  'cs:snapshot:commit': {
    req: { name: string; urlPattern: string; matchMode: UrlMatchMode; snapshotId?: string };
    res: { snapshot: Snapshot };
  };

  'cs:replay:run': { req: Record<string, never>; res: ContentState };
  'cs:replay:revert': { req: Record<string, never>; res: ContentState };
  /** re-read settings + snapshots from storage, then replay */
  'cs:refresh': { req: Record<string, never>; res: ContentState };

  'cs:reports': { req: Record<string, never>; res: ApplyReport[] };
}

/* ========================================================================== */
/* Envelope                                                                   */
/* ========================================================================== */

const MARK = '__dom_modifier__' as const;

interface Envelope {
  [MARK]: 1;
  type: string;
  payload: unknown;
}

type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === 'object' && value !== null && (value as Envelope)[MARK] === 1;
}

export class MessagingError extends Error {
  override name = 'MessagingError';
  /** true when the target simply had no listener (e.g. no content script on the page) */
  readonly disconnected: boolean;

  constructor(message: string, disconnected = false) {
    super(message);
    this.disconnected = disconnected;
  }
}

const DISCONNECT_HINTS = [
  'Could not establish connection',
  'Receiving end does not exist',
  'The message port closed',
  'No tab with id',
  'No window with id',
];

function toMessagingError(raw: string): MessagingError {
  return new MessagingError(raw, DISCONNECT_HINTS.some((h) => raw.includes(h)));
}

function unwrap<T>(reply: unknown): T {
  const err = chrome.runtime.lastError?.message;
  if (err) throw toMessagingError(err);
  if (reply === undefined) {
    throw new MessagingError('No response from the receiving end.', true);
  }
  const typed = reply as Reply<T>;
  if (!typed || typeof typed !== 'object' || !('ok' in typed)) {
    throw new MessagingError('Malformed response envelope.');
  }
  if (!typed.ok) throw new MessagingError(typed.error);
  return typed.data;
}

/* ========================================================================== */
/* Senders                                                                    */
/* ========================================================================== */

export function sendToBackground<K extends keyof BgProtocol>(
  type: K,
  payload: BgProtocol[K]['req'],
): Promise<BgProtocol[K]['res']> {
  return new Promise((resolve, reject) => {
    const envelope: Envelope = { [MARK]: 1, type, payload };
    try {
      chrome.runtime.sendMessage(envelope, (reply: unknown) => {
        try {
          resolve(unwrap<BgProtocol[K]['res']>(reply));
        } catch (e) {
          reject(e);
        }
      });
    } catch (e) {
      reject(new MessagingError(String(e)));
    }
  });
}

export function sendToTab<K extends keyof CsProtocol>(
  tabId: number,
  type: K,
  payload: CsProtocol[K]['req'],
): Promise<CsProtocol[K]['res']> {
  return new Promise((resolve, reject) => {
    const envelope: Envelope = { [MARK]: 1, type, payload };
    try {
      chrome.tabs.sendMessage(tabId, envelope, { frameId: 0 }, (reply: unknown) => {
        try {
          resolve(unwrap<CsProtocol[K]['res']>(reply));
        } catch (e) {
          reject(e);
        }
      });
    } catch (e) {
      reject(new MessagingError(String(e)));
    }
  });
}

/* ========================================================================== */
/* Receivers                                                                  */
/* ========================================================================== */

export type BgHandlers = {
  [K in keyof BgProtocol]?: (
    payload: BgProtocol[K]['req'],
    sender: chrome.runtime.MessageSender,
  ) => BgProtocol[K]['res'] | Promise<BgProtocol[K]['res']>;
};

export type CsHandlers = {
  [K in keyof CsProtocol]?: (
    payload: CsProtocol[K]['req'],
    sender: chrome.runtime.MessageSender,
  ) => CsProtocol[K]['res'] | Promise<CsProtocol[K]['res']>;
};

type AnyHandler = (
  payload: never,
  sender: chrome.runtime.MessageSender,
) => unknown | Promise<unknown>;

function install(handlers: Record<string, AnyHandler | undefined>): void {
  chrome.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse: (r: Reply<unknown>) => void) => {
      if (!isEnvelope(message)) return false;
      const handler = handlers[message.type];
      if (!handler) return false;

      void (async () => {
        try {
          const data = await handler(message.payload as never, sender);
          sendResponse({ ok: true, data });
        } catch (e) {
          sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })();

      return true; // keep the port open for the async reply
    },
  );
}

export function registerBackgroundHandlers(handlers: BgHandlers): void {
  install(handlers as Record<string, AnyHandler | undefined>);
}

export function registerContentHandlers(handlers: CsHandlers): void {
  install(handlers as Record<string, AnyHandler | undefined>);
}

/** Fire-and-forget broadcast from the background to one tab; failures are ignored. */
export async function notifyTab<K extends keyof CsProtocol>(
  tabId: number,
  type: K,
  payload: CsProtocol[K]['req'],
): Promise<void> {
  try {
    await sendToTab(tabId, type, payload);
  } catch {
    /* the tab may have no content script — that is fine */
  }
}

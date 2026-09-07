/**
 * The content script's entry point — the orchestrator.
 *
 * Every other module in this folder is a passive component: the recorder never
 * subscribes to anything, the replayer never reads storage, the observer never
 * decides what a mutation means. This file is the only place where they are
 * wired together, and it owns the three things none of them can own alone:
 *
 *  1. TIMING. At `document_start` there is no DOM, and on a React app there is
 *     still no meaningful DOM 200 ms later. So replay is driven off
 *     RETRY_SCHEDULE_MS after every navigation and stops as soon as the
 *     replayer reports nothing unresolved.
 *  2. THE GUARD. React re-renders over our edits, so the observer's "the DOM
 *     went quiet" callback re-runs the replayer. This is safe only because a
 *     replay pass that changes nothing writes nothing.
 *  3. SUPPRESSION. Every DOM write we perform — replay, load, revert, reset,
 *     highlight — happens inside `observer.suppress()`, otherwise the recorder
 *     would record our own writes as user edits and the guard would observe its
 *     own output and spin forever.
 *
 * Nothing here may throw into the page: the whole boot is wrapped, every
 * callback is wrapped, and a background that is asleep or an extension context
 * that was invalidated degrade to "no replay", never to a broken host page.
 */

import { changeKey } from '@/shared/change-key';
import {
  CONFIDENCE,
  DRAFT_SAVE_DEBOUNCE_MS,
  EXTENSION_VERSION,
  FAST_RETRY_MIN_GAP_MS,
  FAST_RETRY_MS,
  MAX_DRAFT_CHANGES,
  MAX_DRAFT_ROUTES,
  RETRY_SCHEDULE_MS,
  SUBSTANTIAL_RENDER_NODES,
} from '@/shared/constants';
import { uid } from '@/shared/id';
import { log, setLogLevel } from '@/shared/logger';
import type { CsHandlers } from '@/shared/messages';
import { registerContentHandlers, sendToBackground } from '@/shared/messages';
import type {
  ActiveSnapshotState,
  ApplyReport,
  Change,
  ContentState,
  Settings,
  Snapshot,
} from '@/shared/types';
import { DEFAULT_SETTINGS, SCHEMA_VERSION } from '@/shared/types';
import { originOf, pathOf, routeKeyOf, suggestPattern } from '@/shared/url-match';
import { findElement, invalidateCache } from './element-matcher';
import { clearHighlight, highlightElement } from './highlight';
import { DomObserver } from './observer';
import { Recorder } from './recorder';
import type { PreparedChange } from './replayer';
import { Replayer } from './replayer';
import { currentUrl, watchUrlChanges } from './spa';
import { StyleManager } from './style-manager';

/* ========================================================================== */
/* Local tunables                                                             */
/* ========================================================================== */

/**
 * Marker on the isolated world's `window`. The same content script can be
 * injected twice (declaratively at document_start *and* programmatically via
 * chrome.scripting after an update), and two live instances would mean two
 * message listeners answering the same popup request and two guards fighting
 * over the same nodes.
 */
const INSTALL_FLAG = '__domModifierContentInstalled__';

/** Upper bound on how often the toolbar badge is refreshed. */
const BADGE_THROTTLE_MS = 500;

/**
 * Events that prove the page is being *used* rather than *edited*. Fed to the
 * recorder, which uses the resulting quiet windows as its strongest signal for
 * telling a DevTools edit apart from an app render.
 */
/**
 * Cố ý KHÔNG có 'scroll'.
 *
 * Ba event kia là hành động thật của người: chúng chỉ xảy ra khi có ai đó bấm,
 * gõ hoặc lăn chuột. Còn `scroll` là HỆ QUẢ, và phần lớn thời gian nó chẳng do
 * người nào gây ra — sticky header, danh sách lazy-load, IntersectionObserver,
 * và quan trọng nhất: DevTools tự cuộn element vào tầm nhìn khi bạn chọn nó
 * trong tab Elements.
 *
 * Đúng cái cuộn đó bắn `scroll` lên trang ngay trước lúc bạn sửa, làm recorder
 * tưởng bạn đang DÙNG trang, hạ điểm tin cậy từ 0.9 xuống 0.4, và thay đổi bị
 * xếp nguồn 'app' -> không bao giờ được tự áp lại sau F5. Người dùng thấy dòng
 * đó nằm trong danh sách mà trang thì trơ ra, không hiểu vì sao.
 *
 * Bỏ nó đi không mất gì: cuộn bằng chuột đã có `wheel`, cuộn bằng phím đã có
 * `keydown`, kéo thanh cuộn đã có `pointerdown`.
 */
const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const;

/**
 * Id "snapshot" giả gắn cho các thay đổi chưa lưu khi đưa chúng vào replayer.
 *
 * Bản nháp đi qua đúng đường ống của snapshot đã lưu — nhờ vậy nó cũng được
 * guard bảo vệ khi React render đè, cũng được undo khi user tắt hay xoá nó, và
 * không cần một nhánh xử lý riêng nào trong Replayer.
 */
const DRAFT_SNAPSHOT_ID = '__draft__';

/* ========================================================================== */
/* Module state                                                               */
/* ========================================================================== */

/** Everything one frame's orchestrator owns. Created once, in {@link boot}. */
interface Ctx {
  replayer: Replayer;
  recorder: Recorder;
  observer: DomObserver;
  settings: Settings;
  /** Snapshots whose pattern matches the current URL (enabled or not). */
  snapshots: Snapshot[];
  /** How many changes are currently loaded into the replayer. */
  loadedCount: number;
  lastReplayAt: number | null;
  /**
   * Set by an explicit revert. Without it the guard — or a pending retry timer
   * — would re-apply everything a few milliseconds later and the user's revert
   * would look like it did nothing. Cleared by run/refresh/commit/navigation.
   */
  suspended: boolean;
  retryTimers: number[];
  badgeTimer: number | null;
  lastBadgeAt: number;
  stopUrlWatch: (() => void) | null;

  /* --- bản nháp ------------------------------------------------------- */
  /** URL của route mà bản nháp hiện đang được ghi vào. */
  draftUrl: string;
  draftTimer: number | null;
  draftSavedAt: number | null;
  /** Có change MỚI chưa được nạp vào replayer (change cũ thì dùng patchChange). */
  draftNeedsLoad: boolean;
  /**
   * Khoá của các insert mà node đã NẰM SẴN trên trang do user tự chèn tay trong
   * phiên này. Áp lại chúng sẽ nhân đôi node, nên bị loại khỏi replayer cho tới
   * lần tải trang sau — lúc đó node không còn và set này cũng rỗng.
   * Khoá theo `changeKey` chứ không theo id, để một insert đã commit thành
   * snapshot (id có thể đổi) vẫn được nhận ra.
   */
  liveInsertKeys: Set<string>;
  /** Change khôi phục từ bản nháp mà chưa gắn được vào element sống. */
  unadopted: Set<string>;

  /**
   * Từ lượt settle trước tới giờ, trang đã dựng thêm một mảng UI đáng kể.
   *
   * Đây là thứ thay cho câu hỏi không trả lời được "trang load xong chưa": ta
   * không biết lúc nào là xong, nhưng biết lúc nào trang vừa render thêm — và
   * đó chính là lúc đáng đi tìm lại những element chưa khớp.
   */
  sawBigRender: boolean;

  /* --- làn nhanh ------------------------------------------------------- */
  /** Timer của làn nhanh; null khi không có lượt nào đang hẹn. */
  fastTimer: number | null;
  /** Thời điểm lượt làn nhanh gần nhất chạy, để giữ sàn giãn cách. */
  lastFastAt: number;
}

let ctx: Ctx | null = null;

/** Set at page teardown; every timer callback checks it before touching the DOM. */
let disposed = false;

/** Timer for the post-DOM-ready settling delay, so teardown can drop it. */
let bootDelayTimer: number | null = null;

/**
 * Context accessor for message handlers. Throwing here is deliberate: the
 * message layer turns it into `{ ok: false, error }` for the popup, which is a
 * far better outcome than a silent `undefined` state.
 */
function context(): Ctx {
  if (!ctx) throw new Error('DOM Modifier: content script is not initialised.');
  return ctx;
}

/* ========================================================================== */
/* Single-instantiation guard                                                 */
/* ========================================================================== */

/** Claim this frame, or report that another instance already owns it. */
function claimFrame(): boolean {
  try {
    const globals = window as unknown as Record<string, unknown>;
    if (globals[INSTALL_FLAG] === true) return false;
    globals[INSTALL_FLAG] = true;
    return true;
  } catch (e) {
    // An unreadable window is not a page we can safely instrument.
    log.error('DOM Modifier: could not claim the frame', e);
    return false;
  }
}

/* ========================================================================== */
/* Settings & snapshot plumbing                                               */
/* ========================================================================== */

/** Push one settings object into every component that derives behaviour from it. */
function applySettings(next: Settings): void {
  const c = ctx;
  if (!c) return;
  c.settings = next;
  setLogLevel(next.logLevel);
  c.replayer.setSettings(next);
  c.recorder.setFilter(next.recordFilter);
  c.observer.setDebounce(next.guardDebounceMs);
  // Tắt autoDraft thì gương phải đi theo: để nó nằm lại là lần tải trang sau
  // vẫn nạp đồ cũ vào buffer dù tính năng đã tắt.
  if (!next.autoDraft) {
    try {
      window.sessionStorage.removeItem(MIRROR_KEY);
    } catch {
      /* trang chặn sessionStorage thì cũng chẳng có gương nào để xoá */
    }
  }
}

/**
 * Insert mà node của nó đã có sẵn trên trang (user vừa chèn tay). Áp lại là
 * nhân đôi, nên bỏ qua — cho tới lần tải trang sau.
 */
function isAlreadyOnPage(c: Ctx, change: Change): boolean {
  if (change.type !== 'insert') return false;
  try {
    return c.liveInsertKeys.has(changeKey(change));
  } catch {
    return false;
  }
}

/** Flatten the enabled snapshots into the replayer's input, keeping provenance. */
function prepareChanges(c: Ctx, snapshots: Snapshot[]): PreparedChange[] {
  const items: PreparedChange[] = [];
  for (const snapshot of snapshots) {
    if (!snapshot.enabled) continue;
    for (const change of snapshot.changes) {
      if (isAlreadyOnPage(c, change)) continue;
      items.push({ change, snapshotId: snapshot.id });
    }
  }
  return items;
}

/**
 * Các thay đổi CHƯA lưu, đưa vào replayer y như snapshot.
 *
 * Đây chính là mắt xích làm cho "sửa DevTools rồi F5 không mất": sau khi tải
 * lại, `hydrate()` nạp chúng từ bản nháp vào recorder, rồi hàm này đẩy chúng
 * xuống replayer để được áp lại lên DOM.
 *
 * Bộ lọc `draftDevtoolsOnly` là câu trả lời cho "chỉ lưu cái nào đã sửa thôi":
 * change điểm tin cậy thấp (recorder ngờ là app tự render) vẫn hiện trong popup
 * để user tự quyết, nhưng không tự động áp lại lên trang.
 */
function prepareDraftChanges(c: Ctx): PreparedChange[] {
  if (!c.settings.autoDraft) return [];
  const items: PreparedChange[] = [];
  for (const change of c.recorder.getPending()) {
    if (!change.enabled) continue;
    if (c.settings.draftDevtoolsOnly && !safeToAutoApply(change)) continue;
    if (isAlreadyOnPage(c, change)) continue;
    items.push({ change, snapshotId: DRAFT_SNAPSHOT_ID });
  }
  return items;
}

/**
 * Change này có đủ chắc chắn để TỰ ĐỘNG áp lại không (không hỏi ai)?
 *
 * Không thể chỉ xét `source === 'devtools'`, vì `classifyAddition` cấp đúng
 * `CONFIDENCE.likely` (0.65) cho MỌI lần thêm node nhỏ lúc trang yên tĩnh —
 * ngưỡng của 'devtools' cũng là 0.65, nên một lượt React render nền sẽ lọt.
 * Sau khi tải lại trang thì càng nguy: các WeakSet `knownElements` rỗng trơn,
 * nên mọi node app dựng lên đều trông như "mới toanh".
 *
 * Nên chia hai mức theo mức độ tàn phá nếu đoán sai:
 *   - insert / remove: đoán sai là NHÂN ĐÔI nội dung hoặc ẩn mất phần trang
 *     thật, và không tự sửa được. Đòi `CONFIDENCE.human`.
 *   - style / text / attribute / class: chỉ ghi một giá trị vào một ô. Đoán sai
 *     thì thấy ngay, tắt một cái là xong. `likely` là đủ.
 *
 * Change bị chặn ở đây KHÔNG bị vứt: nó vẫn nằm trong danh sách của popup để
 * user tự bật, và vẫn được lưu vào bản nháp.
 */
function safeToAutoApply(change: Change): boolean {
  if (change.type === 'insert' || change.type === 'remove') {
    return change.confidence >= CONFIDENCE.human;
  }
  return change.source === 'devtools';
}

/**
 * Hand the current change set to the replayer.
 *
 * With the master switch off we load an *empty* set rather than skipping the
 * call: `Replayer.load` runs the undo closure of every change that disappeared
 * from the set, so turning replay off actually restores the page instead of
 * freezing it mid-edit.
 */
function loadIntoReplayer(): void {
  const c = ctx;
  if (!c || disposed) return;
  try {
    // Snapshot trước, bản nháp sau: change đứng sau thắng khi hai bên cùng động
    // vào một element, và thứ user vừa sửa mà chưa lưu phải là thứ thắng.
    const items: PreparedChange[] = c.settings.enabled
      ? [...prepareChanges(c, c.snapshots), ...prepareDraftChanges(c)]
      : [];
    c.loadedCount = items.length;
    c.observer.suppress(() => c.replayer.load(items));
  } catch (e) {
    log.error('content: loading changes failed', e);
  }
}

/** Re-fetch the snapshots matching the current URL and hand them to the replayer. */
async function refreshSnapshots(url: string): Promise<void> {
  const matching = await sendToBackground('bg:snapshots:matching', { url });
  const c = ctx;
  // A navigation while we were awaiting makes this answer stale; that
  // navigation started its own fetch, and its result must win.
  if (!c || disposed || currentUrl() !== url) return;
  c.snapshots = matching;
  loadIntoReplayer();
}

/* ========================================================================== */
/* Bản nháp: tự lưu + tự khôi phục                                            */
/* ========================================================================== */

function clearDraftTimer(c: Ctx): void {
  if (c.draftTimer === null) return;
  window.clearTimeout(c.draftTimer);
  c.draftTimer = null;
}

/**
 * Ghi buffer pending xuống bản nháp của `url`.
 *
 * Fire-and-forget: background ngủ, extension vừa được reload, hay tab sắp đóng
 * đều chỉ nên dẫn tới "lần này không lưu được", không bao giờ là một exception
 * ném vào trang của người ta.
 */
function saveDraftFor(url: string, force = false): void {
  const c = ctx;
  // `force` dành riêng cho teardown: lúc đó `disposed` đã bật lên rồi, mà đây
  // lại đúng là cơ hội CUỐI CÙNG để giữ những gì user vừa sửa trong khoảng
  // debounce chưa kịp ghi. Không có nó thì cả lưới cứu lúc đóng trang là code
  // chết — nó luôn thoát ngay ở dòng dưới.
  if (!c || (disposed && !force) || !c.settings.autoDraft || !url) return;
  // Gương trước, message sau: gương là cú ghi ĐỒNG BỘ nên chắc chắn xong, còn
  // message có thể chết dọc đường lúc trang đang đóng.
  writeMirror(url);
  const changes = c.recorder.getPending();
  sendToBackground('bg:draft:set', { url, changes })
    .then((res) => {
      const cur = ctx;
      if (cur && !disposed) cur.draftSavedAt = res.savedAt;
    })
    .catch((e: unknown) => {
      log.debug('content: không ghi được bản nháp', e);
    });
}

/**
 * Đồng bộ ngay lập tức: nạp change mới vào replayer nếu cần, rồi ghi bản nháp.
 * Gọi được từ mọi chỗ vừa động vào buffer pending ngoài luồng recorder.
 */
function flushDraft(): void {
  const c = ctx;
  if (!c || disposed) return;
  clearDraftTimer(c);
  if (c.draftNeedsLoad) {
    c.draftNeedsLoad = false;
    loadIntoReplayer();
    replayNow();
  }
  saveDraftFor(c.draftUrl);
}

/**
 * Gộp các lần đồng bộ trong một khoảng ngắn thành một.
 *
 * Kéo thanh chọn màu trong DevTools sinh hàng chục change mỗi giây; không gộp
 * thì mỗi lần kéo là một lượt `Replayer.load()` (quét lại toàn bộ binding) và
 * một lượt ghi storage.
 */
function scheduleDraftSync(needsLoad: boolean): void {
  const c = ctx;
  if (!c || disposed || !c.settings.autoDraft) return;
  if (needsLoad) c.draftNeedsLoad = true;
  if (c.draftTimer !== null) return;
  c.draftTimer = window.setTimeout(() => {
    const cur = ctx;
    if (!cur || disposed) return;
    cur.draftTimer = null;
    flushDraft();
  }, DRAFT_SAVE_DEBOUNCE_MS);
}

/** Nạp bản nháp vào recorder và ghi nhận chúng đang chờ được gắn vào element. */
function restoreDraft(changes: Change[]): void {
  const c = ctx;
  if (!c || disposed || !Array.isArray(changes) || changes.length === 0) return;
  const before = new Set<string>();
  for (const change of c.recorder.getPending()) before.add(change.id);

  const added = c.recorder.restore(changes);
  if (added === 0) return;

  for (const change of c.recorder.getPending()) {
    if (!before.has(change.id)) c.unadopted.add(change.id);
  }
  log.info('content: khôi phục', added, 'thay đổi chưa lưu');
}

/**
 * Gắn change vừa khôi phục vào element mà replayer tìm được.
 *
 * Không làm bước này thì lần sửa tiếp theo của user lên đúng element đó sẽ tạo
 * ra một change THỨ HAI, và trang sẽ có hai thay đổi đánh nhau trên một ô.
 * Chạy sau mỗi lượt replay, nhưng tự tắt ngay khi không còn ai chờ.
 */
function adoptRestored(): void {
  const c = ctx;
  if (!c || disposed || c.unadopted.size === 0) return;
  for (const changeId of [...c.unadopted]) {
    const element = c.replayer.elementFor(changeId);
    if (!element) continue;
    // Chỉ gỡ khỏi hàng chờ khi gắn ĐƯỢC. `adopt` từ chối khi ô đó đã có change
    // khác chiếm; bỏ ra khỏi hàng chờ lúc ấy là biến change thành mồ côi vĩnh
    // viễn, và lần user sửa tiếp sẽ đẻ ra một change trùng đánh nhau với nó.
    if (c.recorder.adopt(changeId, element)) c.unadopted.delete(changeId);
  }
}

/* ------------------- gương bản nháp trong sessionStorage ------------------- */

/**
 * Khoá gương bản nháp trong `sessionStorage` CỦA TRANG.
 *
 * Vì sao phải có bản gương trong khi đã có `chrome.storage.session`: bản chính
 * nằm sau một round-trip tới service worker MV3, mà worker đang ngủ thì phải
 * đánh thức — mất 50-200ms. Trong đúng khoảng đó parser đã có thể dựng xong
 * element và VẼ giá trị gốc lên màn hình; ta có muốn vá trước khi paint cũng
 * không có gì trong tay để vá. `sessionStorage` thì đọc ĐỒNG BỘ ngay tại
 * document_start — bản nháp sẵn sàng trước cả byte HTML đầu tiên được parse.
 *
 * Vòng đời của nó cũng khớp một cách tình cờ mà đẹp: per-tab, per-origin, sống
 * qua F5, chết cùng tab — y hệt thiết kế của bản nháp.
 *
 * Đánh đổi, nói thẳng: `sessionStorage` là của TRANG, JS của trang đọc-ghi
 * được. Nghĩa là (1) trang nhìn thấy nội dung nháp của user — chấp nhận được,
 * vì nháp vốn là chỉnh sửa trên chính trang đó; (2) trang có thể ghi đè đồ giả
 * vào — cũng chấp nhận được, vì thứ duy nhất nó "lừa" ta làm là sửa DOM của
 * chính nó, việc nó tự làm được từ đầu, và HTML chèn vào vẫn đi qua bộ khử
 * script của replayer. Bản gương vì thế CHỈ là cache tăng tốc: bản chính trong
 * chrome.storage vẫn là nguồn sự thật, hydrate() về sau vẫn đối chiếu lại.
 */
const MIRROR_KEY = '__dom_modifier_draft__';

interface MirrorShape {
  v: 1;
  routes: Record<string, { updatedAt: number; changes: Change[] }>;
}

/** Đọc + kiểm tra thô bản gương. Dữ liệu trang ghi được nên không tin cấu trúc. */
function readMirror(): MirrorShape {
  try {
    const raw = window.sessionStorage.getItem(MIRROR_KEY);
    if (!raw) return { v: 1, routes: {} };
    const parsed = JSON.parse(raw) as MirrorShape;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.routes !== 'object' || !parsed.routes) {
      return { v: 1, routes: {} };
    }
    return { v: 1, routes: parsed.routes };
  } catch {
    // Trang chặn sessionStorage (sandbox) hoặc JSON rác: coi như không có gương.
    return { v: 1, routes: {} };
  }
}

/** Các change trong gương cho route hiện tại, đã lọc thô những mục dị dạng. */
function mirrorChangesFor(url: string): Change[] {
  const entry = readMirror().routes[routeKeyOf(url)];
  if (!entry || !Array.isArray(entry.changes)) return [];
  const out: Change[] = [];
  for (const change of entry.changes) {
    // Chỉ kiểm tra tối thiểu để replayer/recorder không nghẹn; validation đầy
    // đủ vẫn nằm ở background (normaliseChange) khi autosave đẩy chúng lên.
    if (change && typeof change === 'object' && typeof change.id === 'string' && change.target) {
      out.push(change);
    }
    if (out.length >= MAX_DRAFT_CHANGES) break;
  }
  return out;
}

/**
 * Ghi buffer pending hiện tại vào gương. ĐỒNG BỘ — nên đây cũng chính là lưới
 * cứu đáng tin nhất lúc đóng trang: message tới background lúc teardown có thể
 * không kịp đi, còn cú ghi này thì xong ngay trước khi trang chết. Cửa sổ mất
 * dữ liệu 350ms của debounce coi như được bịt nốt.
 */
function writeMirror(url: string): void {
  const c = ctx;
  if (!c || !url) return;
  try {
    if (!c.settings.autoDraft) {
      window.sessionStorage.removeItem(MIRROR_KEY);
      return;
    }
    const mirror = readMirror();
    const key = routeKeyOf(url);
    const changes = c.recorder.getPending().slice(-MAX_DRAFT_CHANGES);
    if (changes.length === 0) delete mirror.routes[key];
    else mirror.routes[key] = { updatedAt: Date.now(), changes };

    // Cắt route cũ khi quá đông — cùng luật với bản chính trong storage.
    const keys = Object.keys(mirror.routes);
    if (keys.length > MAX_DRAFT_ROUTES) {
      keys
        .sort((a, b) => (mirror.routes[a]?.updatedAt ?? 0) - (mirror.routes[b]?.updatedAt ?? 0))
        .slice(0, keys.length - MAX_DRAFT_ROUTES)
        .forEach((k) => delete mirror.routes[k]);
    }
    window.sessionStorage.setItem(MIRROR_KEY, JSON.stringify(mirror));
  } catch (e) {
    // Hết quota (chia chung 5MB với trang) hay bị chặn: bản chính vẫn còn đó.
    log.debug('content: không ghi được gương bản nháp', e);
  }
}

/** Xoá gương của một route (hoặc cả khoá khi không còn route nào). */
function clearMirrorRoute(url: string): void {
  try {
    const mirror = readMirror();
    delete mirror.routes[routeKeyOf(url)];
    if (Object.keys(mirror.routes).length === 0) window.sessionStorage.removeItem(MIRROR_KEY);
    else window.sessionStorage.setItem(MIRROR_KEY, JSON.stringify(mirror));
  } catch (e) {
    log.debug('content: không xoá được gương bản nháp', e);
  }
}

/**
 * Khôi phục TỨC THÌ từ gương, chạy đồng bộ ngay sau createContext().
 *
 * Đây là mảnh cuối của "áp ngay lập tức sau reload": tới lúc parser dựng ra
 * element đầu tiên thì bản nháp đã nằm sẵn trong replayer, và làn nhanh vá nó
 * ngay trong microtask — trước khi trình duyệt kịp vẽ giá trị gốc. Không phải
 * đợi service worker thức dậy, không phải đợi DOMContentLoaded.
 */
function restoreFromMirror(): void {
  const c = ctx;
  if (!c || disposed) return;
  const changes = mirrorChangesFor(c.draftUrl);
  if (changes.length === 0) return;
  restoreDraft(changes);
  loadIntoReplayer();
  // Trang render sẵn từ server có thể đã có element ngay lúc này.
  replayNow();
  log.info('content: nạp', changes.length, 'thay đổi từ gương, không chờ background');
}

/** Quên sạch mọi trạng thái bản nháp trong RAM (không đụng tới storage). */
function resetDraftState(c: Ctx): void {
  clearDraftTimer(c);
  c.draftNeedsLoad = false;
  c.draftSavedAt = null;
  c.liveInsertKeys.clear();
  c.unadopted.clear();
}

/* ========================================================================== */
/* Replay driving                                                             */
/* ========================================================================== */

/** One replay pass, with every DOM write hidden from our own observer. */
function replayNow(): void {
  const c = ctx;
  if (!c || disposed) return;
  if (!c.settings.enabled || c.suspended || c.loadedCount === 0) return;
  try {
    c.observer.suppress(() => {
      c.replayer.run();
    });
    c.lastReplayAt = Date.now();
    // Ngoài vùng nín vì nó không đụng tới DOM: chỉ nối change khôi phục với
    // element mà lượt replay vừa tìm ra.
    adoptRestored();
  } catch (e) {
    log.error('content: replay pass failed', e);
  }
}

function clearRetryTimers(): void {
  const c = ctx;
  if (!c) return;
  for (const id of c.retryTimers) window.clearTimeout(id);
  c.retryTimers.length = 0;
  if (c.fastTimer !== null) {
    window.clearTimeout(c.fastTimer);
    c.fastTimer = null;
  }
}

/**
 * Arm the post-navigation retry schedule.
 *
 * A single replay at DOM-ready matches almost nothing on a React app: the tree
 * that our fingerprints describe does not exist yet. So we replay again at each
 * RETRY_SCHEDULE_MS offset and stop the moment the replayer says every enabled
 * change is either applied or permanently given up on — the page then costs us
 * nothing but the guard.
 */
function scheduleRetries(): void {
  const c = ctx;
  if (!c || disposed) return;
  clearRetryTimers();
  for (const offset of RETRY_SCHEDULE_MS) {
    const id = window.setTimeout(() => {
      const cur = ctx;
      if (!cur || disposed) return;
      replayNow();
      if (!cur.replayer.hasUnresolved()) {
        clearRetryTimers();
        pushBadge();
      }
    }, offset);
    c.retryTimers.push(id);
  }
}

/** Replay once, and keep retrying only while something is still unresolved. */
function replayAndRetry(): void {
  replayNow();
  const c = ctx;
  if (!c || disposed) return;
  if (c.replayer.hasUnresolved()) scheduleRetries();
  else clearRetryTimers();
}

/**
 * Đo xem một batch mutation có phải là "app vừa dựng một mảng giao diện" không.
 *
 * Đếm cả `childElementCount` chứ không chỉ số node được thêm: một lượt React
 * commit thường gắn đúng MỘT node vào cây, nhưng node đó mang theo cả một cây
 * con. Chỉ đếm addedNodes thì mọi lượt render đều trông như vặt vãnh.
 *
 * Cố tình rẻ: thoát ngay khi đủ ngưỡng, và bỏ qua hẳn nếu lượt trước đã đánh
 * dấu rồi — hàm này nằm trên đường nóng của MutationObserver.
 */
function noteRenderVolume(records: MutationRecord[]): void {
  const c = ctx;
  if (!c || disposed) return;
  let added = 0;
  let anyAddition = false;
  /** Batch này có đụng vào một element đang được vá không? */
  let touchedBound = false;

  for (const record of records) {
    if (record.type === 'childList') {
      // React đôi khi THAY text node dưới element đã vá (childList chứ không
      // phải characterData) — target của record chính là element đó.
      if (!touchedBound && c.replayer.ownsTarget(record.target)) touchedBound = true;
      for (const node of record.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        anyAddition = true;
        if (c.sawBigRender) break; // ngưỡng "mảng lớn" đã đạt rồi, khỏi đếm tiếp
        added += 1 + (node as Element).childElementCount;
        if (added >= SUBSTANTIAL_RENDER_NODES) c.sawBigRender = true;
      }
    } else if (!touchedBound) {
      // characterData / attributes ghi đè TẠI CHỖ — không thêm node nào, nên
      // cổng anyAddition không bắt được. Mà đây lại chính là cách React cập
      // nhật chữ trong đa số trường hợp: thiếu nhánh này thì đúng ca re-render
      // phổ biến nhất vẫn nháy giá trị cũ một nhịp rồi mới được vá lại.
      if (c.replayer.ownsTarget(record.target)) touchedBound = true;
    }
  }

  // LÀN NHANH — hai cò: trang vừa mọc node (có thể là element đang tìm), hoặc
  // app vừa ghi đè lên element đang vá (phải vá lại trước khi kịp paint).
  if (anyAddition || touchedBound) fastReplayOnMutation(touchedBound);
}

/**
 * Replay NGAY BÊN TRONG microtask của MutationObserver — trước khi trình duyệt
 * kịp vẽ.
 *
 * Đây là điểm mấu chốt của việc "không nhấp nháy giá trị cũ": theo vòng đời
 * event loop, mutation mà app vừa tạo ra CHƯA được paint cho tới khi task hiện
 * tại và các microtask của nó chạy xong — mà callback của MutationObserver
 * chính là một microtask như thế. Ghi đè ngay tại đây nghĩa là khung hình đầu
 * tiên người dùng thấy đã là giá trị MỚI; "55000" cũ không bao giờ lên màn
 * hình. Hẹn `setTimeout(16)` nghe có vẻ nhanh, nhưng đã là task khác — trình
 * duyệt kịp vẽ giá trị cũ ít nhất một khung hình, đủ để mắt bắt được cú nháy.
 *
 * Đổi lại phải trả chi phí matcher ngay trên đường nóng của observer, nên có
 * ba chốt chặn:
 *   - chỉ khi đang SĂN TÌM (còn change chưa khớp) — mọi thứ yên vị rồi thì
 *     canh giữ là việc của guard với nhịp debounce của nó;
 *   - chỉ khi batch có THÊM node — thứ duy nhất có thể làm element đang thiếu
 *     xuất hiện;
 *   - sàn giãn cách FAST_RETRY_MIN_GAP_MS: trang render như bão thì lượt vượt
 *     sàn rơi xuống timer, chấp nhận một cú nháy hiếm hoi thay vì tự tay làm
 *     nghẽn trang của người ta.
 *
 * Vẫn còn một cửa nháy không bịt được từ content script: element render xong
 * TRƯỚC khi hydrate() lấy được bản nháp từ background (round-trip qua service
 * worker MV3 có thể mất cả trăm ms lúc worker ngủ). Trang SPA render muộn thì
 * gần như không bao giờ dính; trang tĩnh render sẵn từ server thì khung hình
 * đầu vẫn là giá trị gốc — muốn bịt nốt phải giấu element bằng CSS từ
 * document_start, một bước xâm lấn cỡ khác, chưa làm ở đây.
 */
function fastReplayOnMutation(touchedBound: boolean): void {
  const c = ctx;
  if (!c || disposed) return;
  if (!c.settings.enabled || c.suspended || c.loadedCount === 0) return;
  // Ba lý do để chạy: (1) batch vừa ĐỤNG thẳng vào element đang vá — lúc này
  // element vẫn connected và status vẫn 'applied' nên hai phép hỏi phía dưới
  // đều mù, phải tin cái cò; (2) còn change chưa khớp đang săn element;
  // (3) element đã vá vừa bị React thay bằng bản mới mang giá trị gốc.
  if (!touchedBound && !c.replayer.hasUnresolved() && !c.replayer.hasLostBinding()) return;

  const now = Date.now();
  if (now - c.lastFastAt >= FAST_RETRY_MIN_GAP_MS) {
    c.lastFastAt = now;
    replayNow();
    pushBadge();
    return;
  }

  // Trong sàn giãn cách: dồn về một lượt hẹn giờ duy nhất.
  if (c.fastTimer !== null) return;
  c.fastTimer = window.setTimeout(
    () => {
      const cur = ctx;
      if (!cur || disposed) return;
      cur.fastTimer = null;
      cur.lastFastAt = Date.now();
      replayNow();
      pushBadge();
    },
    Math.max(FAST_RETRY_MS, FAST_RETRY_MIN_GAP_MS - (now - c.lastFastAt)),
  );
}

/**
 * The guard. Runs after the page has been quiet for `guardDebounceMs`, which is
 * exactly when a framework commit that rendered over one of our edits has
 * finished. Cheap by construction: a pass where every desired value is already
 * in place performs no DOM write, so it cannot re-trigger itself.
 *
 * Đây cũng là chỗ xử lý "trang vừa render thêm": không có mốc load-xong nào để
 * chờ, nên mỗi lần trang dựng thêm một mảng UI ta lại mở cửa sổ tìm kiếm cho
 * những change chưa khớp. Nhờ vậy element xuất hiện muộn — mạng chậm, modal mở
 * sau hai phút, danh sách cuộn vô hạn — vẫn được bắt, thay vì bị bỏ cuộc sau
 * đúng `matchTimeoutMs` giây.
 */
function onSettled(): void {
  const c = ctx;
  if (!c || disposed) return;
  if (!c.settings.guard) return;
  if (c.loadedCount === 0) return;

  if (c.sawBigRender) {
    c.sawBigRender = false;
    const renewed = c.replayer.renewMatchWindow();
    if (renewed > 0) {
      log.debug('content: trang render thêm, mở lại tìm kiếm cho', renewed, 'thay đổi');
      replayNow();
      // Cửa sổ vừa mở lại nên hasUnresolved() có thể true trở lại; bật lại lịch
      // thử để không phải đợi tới lượt settle kế tiếp.
      if (c.replayer.hasUnresolved()) scheduleRetries();
      return;
    }
  }
  replayNow();
}

/* ========================================================================== */
/* Recording                                                                  */
/* ========================================================================== */

function noteInteraction(): void {
  ctx?.recorder.noteInteraction();
}

function installInteractionListeners(): void {
  try {
    // Capture phase so a page that stops propagation cannot blind us, passive
    // so we never delay scrolling on a site we do not control.
    const options: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of INTERACTION_EVENTS) window.addEventListener(type, noteInteraction, options);
  } catch (e) {
    log.error('content: could not install interaction listeners', e);
  }
}

function removeInteractionListeners(): void {
  try {
    for (const type of INTERACTION_EVENTS) {
      window.removeEventListener(type, noteInteraction, { capture: true });
    }
  } catch (e) {
    log.error('content: could not remove interaction listeners', e);
  }
}

/** Persist the per-tab recording flag so it survives the next reload. */
function persistRecordingFlag(recording: boolean): void {
  sendToBackground('bg:recording:set', { recording }).catch((e: unknown) => {
    log.error('content: could not persist the recording flag', e);
  });
}

/* ========================================================================== */
/* Badge                                                                      */
/* ========================================================================== */

/** Changes currently in effect on the page: freshly written *or* already right. */
function countApplied(reports: ApplyReport[]): number {
  let applied = 0;
  for (const report of reports) {
    if (report.status === 'applied' || report.status === 'unchanged') applied++;
  }
  return applied;
}

/**
 * Refresh the toolbar badge, at most once per {@link BADGE_THROTTLE_MS}.
 *
 * The recorder can emit dozens of changes a second while a user drags a colour
 * picker, and every one of them would otherwise be a message to the service
 * worker. Leading edge fires immediately; anything inside the window is
 * collapsed into a single trailing update so the final count is never stale.
 * The numbers are always sent as they are — honouring `showBadge` is the
 * background's job, since it also has to clear a badge the user just disabled.
 */
function pushBadge(): void {
  const c = ctx;
  if (!c || disposed) return;

  const wait = BADGE_THROTTLE_MS - (Date.now() - c.lastBadgeAt);
  if (wait > 0) {
    if (c.badgeTimer === null) {
      c.badgeTimer = window.setTimeout(() => {
        const cur = ctx;
        if (!cur) return;
        cur.badgeTimer = null;
        pushBadge();
      }, wait);
    }
    return;
  }

  c.lastBadgeAt = Date.now();
  const payload = {
    applied: countApplied(c.replayer.getReports()),
    recording: c.recorder.recording,
    pending: c.recorder.getPending().length,
  };
  sendToBackground('bg:badge', payload).catch((e: unknown) => {
    log.debug('content: badge update failed', e);
  });
}

/* ========================================================================== */
/* State for the popup                                                        */
/* ========================================================================== */

/**
 * Per-snapshot tallies, derived from the last replay pass.
 *
 * `applied` counts both 'applied' and 'unchanged', because after the first pass
 * every successful change reports 'unchanged' forever — counting only 'applied'
 * would show a working page as 0/12. 'failed' is folded into `unmatched`: the
 * popup has no separate bucket, and from the user's point of view both mean
 * "this edit is not on the page".
 */
function summariseSnapshots(snapshots: Snapshot[], reports: ApplyReport[]): ActiveSnapshotState[] {
  const byChange = new Map<string, ApplyReport>();
  for (const report of reports) byChange.set(report.changeId, report);

  const out: ActiveSnapshotState[] = [];
  for (const snapshot of snapshots) {
    let applied = 0;
    let unmatched = 0;
    let ambiguous = 0;
    for (const change of snapshot.changes) {
      const report = byChange.get(change.id);
      if (!report) continue;
      if (report.status === 'applied' || report.status === 'unchanged') applied++;
      else if (report.status === 'ambiguous') ambiguous++;
      else if (report.status === 'unmatched' || report.status === 'failed') unmatched++;
    }
    out.push({
      id: snapshot.id,
      name: snapshot.name,
      urlPattern: snapshot.urlPattern,
      matchMode: snapshot.matchMode,
      enabled: snapshot.enabled,
      total: snapshot.changes.length,
      applied,
      unmatched,
      ambiguous,
    });
  }
  return out;
}

/** The complete answer to `cs:state`, and the reply of every mutating handler. */
function buildState(): ContentState {
  const c = context();
  const url = currentUrl();
  const reports = c.replayer.getReports();
  return {
    version: EXTENSION_VERSION,
    url,
    origin: originOf(url),
    path: pathOf(url),
    enabled: c.settings.enabled,
    recording: c.recorder.recording,
    pending: c.recorder.getPending(),
    filteredOut: c.recorder.filteredOut,
    restoredCount: c.recorder.restoredCount,
    draftSavedAt: c.draftSavedAt,
    activeSnapshots: summariseSnapshots(c.snapshots, reports),
    lastReplayAt: c.lastReplayAt,
    stats: c.replayer.getStats(),
    reports,
  };
}

/* ========================================================================== */
/* SPA navigation                                                             */
/* ========================================================================== */

/**
 * Đổi route thay luôn cái DOM mà mọi binding của ta đang trỏ vào, nên không
 * revert gì cả (chẳng còn gì để revert) — replayer được reset, cache match bị
 * bỏ, rồi snapshot của URL mới được nạp và replay theo một lịch thử lại mới.
 *
 * Buffer pending được chuyển theo ROUTE chứ không giữ nguyên: bản nháp lưu tách
 * theo từng route, nên nếu bê nguyên buffer sang route mới thì lần autosave kế
 * tiếp sẽ đem sửa đổi của route cũ ghi đè lên bản nháp của route mới. Ta ghi
 * chúng vào bản nháp của route cũ (không mất gì cả — quay lại là có lại), dọn
 * buffer, rồi nạp bản nháp của route mới.
 *
 * Tắt `autoDraft` thì không có chỗ nào an toàn để cất, nên buffer được giữ
 * nguyên đúng như hành vi cũ.
 */
function onUrlChanged(url: string, previousUrl: string): void {
  const c = ctx;
  if (!c || disposed) return;
  try {
    log.info('content: navigated to', url);

    // Query đổi mà đường dẫn không đổi thì vẫn là cùng một bản nháp — SPA đổi
    // query liên tục (bộ lọc, tab con, tracking param) và không có lý do gì để
    // mỗi lần như thế lại coi như user sang trang khác.
    const routeChanged = routeKeyOf(previousUrl) !== routeKeyOf(url);
    if (routeChanged && c.settings.autoDraft) {
      clearDraftTimer(c);
      saveDraftFor(previousUrl);
      c.recorder.clear();
      resetDraftState(c);
    }
    c.draftUrl = url;

    clearRetryTimers();
    c.suspended = false;
    c.loadedCount = 0;
    c.lastReplayAt = null;
    c.snapshots = [];
    c.sawBigRender = false;
    c.observer.suppress(() => {
      clearHighlight();
      c.replayer.reset();
    });
    invalidateCache();
    void refreshRoute(url, routeChanged)
      .then(() => {
        if (!disposed) scheduleRetries();
      })
      .catch((e: unknown) => log.error('content: reload after navigation failed', e));
  } catch (e) {
    log.error('content: navigation handling failed', e);
  }
}

/**
 * Nạp lại toàn bộ trạng thái của một route: snapshot khớp URL, cộng bản nháp
 * của chính route đó khi vừa thực sự đổi route.
 */
async function refreshRoute(url: string, withDraft: boolean): Promise<void> {
  const matching = await sendToBackground('bg:snapshots:matching', { url });
  {
    const c = ctx;
    if (!c || disposed || currentUrl() !== url) return;
    c.snapshots = matching;
  }

  if (withDraft && ctx?.settings.autoDraft) {
    try {
      const { changes } = await sendToBackground('bg:draft:get', { url });
      // Một lần điều hướng nữa trong lúc chờ làm câu trả lời này thành cũ; lần
      // điều hướng đó đã tự đi lấy dữ liệu của nó và kết quả đó phải thắng.
      if (!ctx || disposed || currentUrl() !== url) return;
      restoreDraft(changes);
    } catch (e) {
      log.debug('content: không đọc được bản nháp của route mới', e);
    }
  }

  loadIntoReplayer();
}

/* ========================================================================== */
/* Message handlers                                                           */
/* ========================================================================== */

/** Look a change up wherever it may live: unsaved buffer first, then snapshots. */
function findChangeById(changeId: string): Change | null {
  const c = context();
  for (const change of c.recorder.getPending()) {
    if (change.id === changeId) return change;
  }
  for (const snapshot of c.snapshots) {
    for (const change of snapshot.changes) {
      if (change.id === changeId) return change;
    }
  }
  return null;
}

/**
 * Buffer pending vừa bị đổi từ ngoài (popup bật/tắt/xoá một dòng): nạp lại vào
 * replayer để thay đổi đó có hiệu lực NGAY trên trang, rồi ghi bản nháp.
 *
 * `loadIntoReplayer` là chỗ làm việc thật: change bị tắt sẽ biến mất khỏi tập
 * nạp vào, và `Replayer.load` chạy undo của nó — nếu chỉ đổi cờ trong buffer
 * thì trang vẫn giữ nguyên chỉnh sửa và nút bật/tắt trông như bị hỏng.
 */
function syncPending(c: Ctx): void {
  loadIntoReplayer();
  replayNow();
  clearDraftTimer(c);
  c.draftNeedsLoad = false;
  saveDraftFor(c.draftUrl);
}

/** A readable default when the user saved without naming the snapshot. */
function defaultSnapshotName(url: string): string {
  const path = pathOf(url);
  return path && path !== '/' ? path : originOf(url) || 'Snapshot';
}

/** Wire up every member of CsProtocol. Mutating handlers reply with fresh state. */
function registerHandlers(): void {
  const handlers: CsHandlers = {
    'cs:ping': () => ({ ok: true, version: EXTENSION_VERSION }),

    'cs:state': () => buildState(),

    'cs:record:start': () => {
      const c = context();
      c.recorder.start();
      persistRecordingFlag(true);
      pushBadge();
      return buildState();
    },

    'cs:record:stop': () => {
      const c = context();
      c.recorder.stop();
      persistRecordingFlag(false);
      pushBadge();
      return buildState();
    },

    'cs:record:clear': () => {
      const c = context();
      c.recorder.clear();
      resetDraftState(c);
      // Xoá luôn bản nháp trên storage LẪN gương, nếu không thì F5 một cái là
      // đống vừa xoá lại mọc về.
      clearMirrorRoute(c.draftUrl);
      sendToBackground('bg:draft:clear', { url: c.draftUrl }).catch((e: unknown) => {
        log.debug('content: không xoá được bản nháp', e);
      });
      // Nạp lại tập rỗng để replayer chạy undo của những change vừa biến mất.
      loadIntoReplayer();
      pushBadge();
      return buildState();
    },

    'cs:pending:setEnabled': ({ changeId, enabled }) => {
      const c = context();
      c.recorder.setEnabled(changeId, enabled);
      syncPending(c);
      return buildState();
    },

    'cs:pending:delete': ({ changeId }) => {
      const c = context();
      c.recorder.remove(changeId);
      c.unadopted.delete(changeId);
      syncPending(c);
      pushBadge();
      return buildState();
    },

    'cs:pending:setAllEnabled': ({ enabled }) => {
      const c = context();
      c.recorder.setAllEnabled(enabled);
      syncPending(c);
      return buildState();
    },

    'cs:highlight': ({ changeId }) => {
      const c = context();
      if (!changeId) {
        c.observer.suppress(() => clearHighlight());
        return { ok: true, found: false };
      }

      const change = findChangeById(changeId);
      // A bound element is authoritative and free; the live match is the
      // fallback for a change that has not been replayed (or has stopped
      // matching), so the popup can still point at what the user recorded.
      let element = c.replayer.elementFor(changeId);
      if (!element && change) {
        element = findElement(change.target, {
          threshold: c.settings.matchThreshold,
          margin: c.settings.matchMargin,
        }).element;
      }

      c.observer.suppress(() => {
        highlightElement(element, change ? { label: change.targetLabel } : undefined);
      });
      return { ok: true, found: element !== null };
    },

    'cs:snapshot:commit': async ({ name, urlPattern, matchMode, snapshotId }) => {
      const c = context();
      const changes = c.recorder.takeEnabled();
      if (changes.length === 0) throw new Error('There are no enabled changes to save.');

      const url = currentUrl();
      let saved: Snapshot | null;

      if (snapshotId) {
        saved = await sendToBackground('bg:snapshots:appendChanges', { snapshotId, changes });
        if (!saved) throw new Error('That snapshot no longer exists.');
      } else {
        const now = Date.now();
        const snapshot: Snapshot = {
          id: uid('s'),
          name: name.trim() || defaultSnapshotName(url),
          origin: originOf(url),
          urlPattern: urlPattern.trim() || suggestPattern(url, matchMode),
          matchMode,
          enabled: true,
          createdAt: now,
          updatedAt: now,
          schemaVersion: SCHEMA_VERSION,
          changes,
        };
        saved = await sendToBackground('bg:snapshots:save', { snapshot });
      }

      // Only now that storage has accepted them: a failed save must leave the
      // user's unsaved work exactly where it was.
      for (const change of changes) {
        c.recorder.remove(change.id);
        c.unadopted.delete(change.id);
      }

      // Bản nháp giờ chỉ còn phần chưa commit; danh sách rỗng thì storage tự
      // xoá hẳn route đó đi.
      clearDraftTimer(c);
      c.draftNeedsLoad = false;
      saveDraftFor(c.draftUrl);

      c.suspended = false;
      await refreshSnapshots(currentUrl());
      replayAndRetry();
      pushBadge();
      return { snapshot: saved };
    },

    'cs:replay:run': () => {
      const c = context();
      c.suspended = false;
      replayAndRetry();
      pushBadge();
      return buildState();
    },

    'cs:replay:revert': () => {
      const c = context();
      // Suspend first: a pending retry timer or the guard would otherwise put
      // every change straight back a few milliseconds later.
      clearRetryTimers();
      c.suspended = true;
      c.observer.suppress(() => {
        clearHighlight();
        c.replayer.revert();
      });
      c.lastReplayAt = Date.now();
      pushBadge();
      return buildState();
    },

    'cs:refresh': async () => {
      const c = context();
      const url = currentUrl();
      const bundle = await sendToBackground('bg:bootstrap', { url });
      applySettings(bundle.settings);
      if (currentUrl() === url) {
        c.snapshots = bundle.matching;
        loadIntoReplayer();
      }
      c.suspended = false;
      replayAndRetry();
      pushBadge();
      return buildState();
    },

    'cs:reports': () => context().replayer.getReports(),
  };

  try {
    registerContentHandlers(handlers);
  } catch (e) {
    log.error('content: could not register message handlers', e);
  }
}

/* ========================================================================== */
/* Lifecycle                                                                  */
/* ========================================================================== */

/** Resolve once the parser has produced a usable tree. */
function whenDomReady(): Promise<void> {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise<void>((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true, capture: true });
  });
}

/** `setTimeout` as a promise, with the id kept so teardown can drop it. */
function sleep(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    bootDelayTimer = window.setTimeout(() => {
      bootDelayTimer = null;
      resolve();
    }, ms);
  });
}

/** Release every timer, listener and observer this frame installed. */
function teardown(): void {
  disposed = true;
  try {
    clearRetryTimers();
    if (bootDelayTimer !== null) {
      window.clearTimeout(bootDelayTimer);
      bootDelayTimer = null;
    }
    const c = ctx;
    if (c) {
      // Cố ghi nốt lần cuối TRƯỚC khi huỷ timer: đây là cơ hội cuối để giữ lại
      // những gì user vừa sửa trong khoảng debounce chưa kịp lưu.
      if (c.draftTimer !== null) saveDraftFor(c.draftUrl, true);
      clearDraftTimer(c);
      if (c.badgeTimer !== null) {
        window.clearTimeout(c.badgeTimer);
        c.badgeTimer = null;
      }
      c.stopUrlWatch?.();
      c.stopUrlWatch = null;
      c.observer.stop();
    }
    removeInteractionListeners();
    clearHighlight();
  } catch (e) {
    log.error('content: teardown failed', e);
  }
}

function installUnloadListener(): void {
  try {
    window.addEventListener(
      'pagehide',
      (event) => {
        // A persisted pagehide is the bfcache: the page can be restored intact,
        // and tearing down would leave a live message listener with no timers,
        // no observer and no way to come back.
        if (event.persisted) return;
        teardown();
      },
      { capture: true },
    );
  } catch (e) {
    log.error('content: could not install the unload listener', e);
  }
}

/**
 * Build every component and start observing.
 *
 * Synchronous on purpose: the observer and the message listener must exist
 * before the first `await`, so mutations during hydration are not missed and a
 * popup opened immediately after load does not see a dead tab.
 */
function createContext(): void {
  const styles = new StyleManager();
  const replayer = new Replayer(styles);

  const recorder = new Recorder({
    filter: DEFAULT_SETTINGS.recordFilter,
    onChange: (change, isNew) => {
      log.debug('content: recorded', change.type, change.label);
      const c = ctx;
      if (c) {
        // Node của insert này do user tự chèn tay và đang nằm sẵn trên trang.
        if (change.type === 'insert') {
          try {
            c.liveInsertKeys.add(changeKey(change));
          } catch (e) {
            log.debug('content: không tính được khoá insert', e);
          }
        }
        if (isNew) {
          // Change mới thì replayer chưa biết nó -> phải nạp lại (có debounce).
          scheduleDraftSync(true);
        } else {
          // Sửa tiếp một change replayer ĐANG giữ: báo ngay, không đợi debounce.
          // Chậm một nhịp là guard sẽ ghi đè giá trị cũ lên đúng thứ user vừa gõ.
          c.replayer.patchChange(change);
          scheduleDraftSync(false);
        }
      }
      pushBadge();
    },
    onRemoved: (changeId) => {
      const c = ctx;
      if (!c || disposed) return;
      c.unadopted.delete(changeId);
      // Change đã rời buffer thì replayer phải thôi giữ nó — `loadIntoReplayer`
      // chạy undo closure của nó, nên hiệu ứng cũng biến khỏi trang. Không làm
      // bước này thì "sửa rồi sửa về như cũ" sẽ để lại giá trị cũ dính vĩnh
      // viễn, và F5 xong nó lại mọc về từ bản nháp.
      scheduleDraftSync(true);
    },
  });

  const observer = new DomObserver({
    onBatch: (records) => {
      noteRenderVolume(records);
      ctx?.recorder.ingest(records);
    },
    onSettled,
    debounceMs: DEFAULT_SETTINGS.guardDebounceMs,
  });

  const created: Ctx = {
    replayer,
    recorder,
    observer,
    settings: DEFAULT_SETTINGS,
    snapshots: [],
    loadedCount: 0,
    lastReplayAt: null,
    suspended: false,
    retryTimers: [],
    badgeTimer: null,
    lastBadgeAt: 0,
    stopUrlWatch: null,
    draftUrl: currentUrl(),
    draftTimer: null,
    draftSavedAt: null,
    draftNeedsLoad: false,
    liveInsertKeys: new Set<string>(),
    unadopted: new Set<string>(),
    sawBigRender: false,
    fastTimer: null,
    lastFastAt: 0,
  };
  ctx = created;

  // Observe before anything else: at document_start every mutation from here on
  // is the app building itself, and the recorder must not start half-blind.
  observer.start();
  created.stopUrlWatch = watchUrlChanges(onUrlChanged);
  registerHandlers();
  installInteractionListeners();
  installDraftFlushListener();
  installUnloadListener();
}

/**
 * Ghi nốt bản nháp khi trang sắp bị giấu đi.
 *
 * `visibilitychange -> hidden` là tín hiệu đáng tin nhất trước một lần F5, đóng
 * tab hay chuyển tab: nó chạy sớm hơn `pagehide` và vẫn còn kịp gửi message cho
 * service worker. Đây là lưới an toàn cho khoảng debounce ~350ms cuối cùng —
 * đúng cái khoảng mà một cú Ctrl+R ngay sau khi sửa sẽ rơi vào.
 */
function installDraftFlushListener(): void {
  try {
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState !== 'hidden') return;
        const c = ctx;
        if (!c || disposed) return;
        clearDraftTimer(c);
        saveDraftFor(c.draftUrl);
      },
      { capture: true },
    );
  } catch (e) {
    log.error('content: không cài được listener ghi bản nháp', e);
  }
}

/**
 * Pull settings, the matching snapshots and the pre-reload recording flag from
 * the background. A background that is unreachable (asleep, mid-update, or the
 * extension context was invalidated) leaves us on defaults with no snapshots,
 * which is inert but never broken.
 */
async function hydrate(): Promise<void> {
  const c = context();
  const url = currentUrl();

  try {
    const bundle = await sendToBackground('bg:bootstrap', { url });
    applySettings(bundle.settings);
    if (currentUrl() === url) {
      c.snapshots = bundle.matching;
      c.draftUrl = url;
      // Đây chính là bước làm cho F5 không mất gì: những thay đổi chưa lưu từ
      // lần tải trang trước quay lại buffer pending, rồi `loadIntoReplayer`
      // đẩy chúng xuống replayer để được áp lại lên DOM. (Gương đã nạp trước
      // phần lớn ở boot; restore() dedup theo id nên đoạn này chỉ bù những gì
      // gương thiếu — và là nguồn sự thật khi hai bên lệch nhau.)
      if (bundle.settings.autoDraft) restoreDraft(bundle.draft);
      loadIntoReplayer();
      // Replay NGAY, đừng đợi tới DOMContentLoaded ở cuối boot(): element nào
      // parser đã dựng xong trong lúc chờ round-trip này là vá được luôn.
      replayNow();
    }
  } catch (e) {
    log.error('content: bootstrap failed, continuing with defaults', e);
  }

  try {
    const { recording } = await sendToBackground('bg:recording:get', {});
    // Recording is a per-tab intent that must survive F5: the user armed it
    // before the reload and expects to keep capturing afterwards.
    if (recording && !c.recorder.recording) c.recorder.start();
  } catch (e) {
    log.debug('content: recording flag unavailable', e);
  }
}

/** Single entry point. Anything it throws is logged and the frame stays inert. */
async function boot(): Promise<void> {
  if (!claimFrame()) {
    log.debug('content: another instance already owns this frame');
    return;
  }
  try {
    createContext();
    // TRƯỚC hydrate, đồng bộ, không await: bản nháp phải sẵn sàng trước khi
    // parser dựng element đầu tiên thì mới vá kịp trước lượt paint đầu. Thuần
    // cộng thêm — hydrate() phía dưới vẫn đối chiếu với bản chính như cũ, và
    // restore() dedup theo id nên nạp trùng là no-op.
    restoreFromMirror();
    await hydrate();
    if (disposed) return;

    await whenDomReady();
    if (disposed) return;

    // The app has not rendered anything useful yet at DOM-ready; this is the
    // cheap head start before the retry schedule takes over.
    await sleep(context().settings.initialDelayMs);
    if (disposed) return;

    replayNow();
    scheduleRetries();
    pushBadge();

    const c = context();
    log.info('content: ready', c.loadedCount, 'changes from', c.snapshots.length, 'snapshot(s)');
  } catch (e) {
    log.error('content: boot failed', e);
  }
}

void boot();

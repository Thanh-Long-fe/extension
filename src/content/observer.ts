/**
 * MutationObserver DUY NHẤT của content script.
 *
 * VÌ SAO chỉ một observer: mỗi bên tiêu thụ (recorder muốn từng batch thô,
 * guard chỉ muốn biết "DOM đã ngừng động đậy") mà tự cắm observer riêng thì cùng
 * một subtree bị theo dõi nhiều lần. Trên trang cỡ Facebook Ads Manager, điều đó
 * đồng nghĩa với việc trả chi phí nhân bản MutationRecord của trình duyệt vài
 * lần mỗi khung hình. Ở đây một observer thu rồi chia ra cho các bên.
 *
 * VÌ SAO phải có cơ chế nín (suppress): replayer có ghi vào DOM. Những lần ghi
 * đó cũng là mutation, nên nếu không nín thì recorder sẽ ghi lại chính chỉnh sửa
 * của ta như thể user vừa sửa, còn guard thì thấy DOM "đổi" mỗi lần nó áp lại
 * change — thành vòng lặp áp-lại vô tận. Xem {@link DomObserver.suppress}.
 */

import { log } from '@/shared/logger';

/**
 * Toàn bộ loại mutation ta đăng ký nghe.
 *
 * Bắt buộc phải xin cả giá trị cũ (`attributeOldValue`, `characterDataOldValue`)
 * vì recorder cần chúng để dựng `oldValue` / `oldSummary` cho mỗi change — không
 * có giá trị cũ thì không biết user đã đổi TỪ cái gì, và cũng không phát hiện
 * được trường hợp "sửa rồi sửa về như cũ".
 */
const OBSERVE_INIT: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeOldValue: true,
  characterData: true,
  characterDataOldValue: true,
};

/**
 * Trần cứng cho khoảng thời gian `onSettled` bị bỏ đói.
 *
 * Debounce đuôi thuần tuý sẽ KHÔNG BAO GIỜ kích hoạt trên một trang mutate liên
 * tục không nghỉ, mà Facebook thì đúng là như vậy (polling, video, render do
 * IntersectionObserver kích). Hằng số này biến nó thành một cái sàn throttle:
 * một khi mutation bắt đầu, `onSettled` vẫn chạy ít nhất chừng này một lần, kể
 * cả khi trang không bao giờ chịu im.
 */
const MAX_SETTLE_WAIT_MS = 1000;

/** Khoảng chờ thử lại khi timer settle lỡ rơi vào đúng lúc đang nín. */
const SUPPRESSED_RETRY_MS = 16;

/** Các callback và thông số thời gian cho {@link DomObserver}. */
export interface DomObserverOptions {
  /** Gọi ở MỖI lần callback của observer gốc, kèm danh sách record thô. */
  onBatch: (records: MutationRecord[]) => void;
  /** Gọi một lần cho mỗi quãng lặng, sau mutation cuối `debounceMs` mili-giây. */
  onSettled: () => void;
  /** Cửa sổ debounce đuôi cho `onSettled`, tính bằng mili-giây. */
  debounceMs: number;
}

/**
 * Sở hữu MutationObserver của trang và chia record ra cho recorder (thô) lẫn
 * guard (đã debounce).
 *
 * An toàn khi start/stop lặp đi lặp lại, và không phương thức công khai nào ném
 * lỗi ra ngoài: một trang thù địch không được phép giết chết content script chỉ
 * bằng cách làm callback của nó nổ.
 */
export class DomObserver {
  private readonly options: DomObserverOptions;
  private observer: MutationObserver | null = null;
  /** Node đang được theo dõi (có thể là `document` khi parser chưa dựng xong). */
  private target: Node | null = null;
  /** Khác null khi caller tự chỉ định target — lúc đó tắt tự đổi target. */
  private explicitTarget: Node | null = null;
  private debounceMs: number;
  private settleTimer: number | null = null;
  private maxTimer: number | null = null;
  /** Đếm độ sâu chứ không phải cờ boolean, để suppress() lồng nhau vẫn đúng. */
  private suppressDepth = 0;
  private readyHooked = false;

  constructor(options: DomObserverOptions) {
    this.options = options;
    this.debounceMs = normalizeDelay(options.debounceMs);
  }

  /** True khi đang có một MutationObserver được nối vào DOM. */
  get running(): boolean {
    return this.observer !== null;
  }

  /**
   * Nối observer vào DOM và bắt đầu nghe.
   *
   * `target` mặc định là `document.documentElement`, mà ở thời điểm
   * `document_start` thì nó có thể CHƯA TỒN TẠI — kiểu TypeScript khai báo là
   * non-null nhưng DOM thực tế thì chưa có `<html>` cho tới khi parser dựng
   * xong. Trường hợp đó ta theo dõi tạm `document` (nhờ `subtree` nên vẫn phủ
   * toàn bộ cây) rồi chuyển sang node gốc thật khi DOMContentLoaded, để các bên
   * tiêu thụ sau này thấy đúng target như họ mong đợi.
   *
   * Gọi start() khi đang chạy sẽ khởi động lại trên target mới.
   */
  start(target?: Node): void {
    try {
      if (this.observer) this.stop();

      // Cố tình nới kiểu ra: documentElement là null ở document_start.
      const autoRoot = document.documentElement as HTMLElement | null;
      const node: Node = target ?? autoRoot ?? document;

      this.explicitTarget = target ?? null;
      this.target = node;
      this.observer = new MutationObserver((records) => this.deliver(records));
      this.observer.observe(node, OBSERVE_INIT);

      if (!target && node !== autoRoot) this.hookReady();
      log.debug('DomObserver started on', node.nodeName);
    } catch (e) {
      this.observer = null;
      this.target = null;
      log.error('DomObserver.start failed', e);
    }
  }

  /** Ngắt kết nối, huỷ mọi timer đang chờ và thôi nghe sự kiện DOM-ready. */
  stop(): void {
    try {
      this.unhookReady();
      this.clearTimers();
      this.observer?.disconnect();
    } catch (e) {
      log.error('DomObserver.stop failed', e);
    } finally {
      this.observer = null;
      this.target = null;
      this.explicitTarget = null;
    }
  }

  /** Đổi độ dài quãng lặng lúc đang chạy (thanh trượt trong Cài đặt gọi vào đây). */
  setDebounce(ms: number): void {
    this.debounceMs = normalizeDelay(ms);
    // Khởi động lại timer đuôi đang chạy dở để giá trị mới có hiệu lực ngay,
    // thay vì phải đợi hết quãng debounce cũ.
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => this.fireSettled(), this.debounceMs);
    }
  }

  /**
   * Chạy `fn` với mọi mutation do CHÍNH TA gây ra bị giấu khỏi các callback.
   *
   * Một cờ boolean thuần tuý là KHÔNG ĐỦ: callback của MutationObserver được
   * giao trong một microtask SAU khi phần việc đồng bộ đã xong, nên tới lúc
   * callback chạy thì cờ đã trở lại false và những lần ghi của ta trông hệt như
   * hoạt động của trang. Mẹo chắc ăn là tự tay vét sạch hàng đợi record của
   * observer — `takeRecords()` làm rỗng nó, và một observer có hàng đợi rỗng vào
   * lúc microtask chạy thì đơn giản là không được gọi.
   *
   * Việc vét đặt trong `finally`, TRƯỚC khi giảm biến đếm độ sâu, để một lỗi ném
   * ra từ trong `fn` cũng không làm rò các lần ghi của ta sang recorder. Biến
   * đếm độ sâu làm cho việc lồng nhau hoạt động đúng: các lần gọi bên trong vẫn
   * vét (vô hại) và chỉ lần thoát ngoài cùng mới bật lại việc giao record.
   *
   * Đánh đổi có chủ ý: việc vét cũng vứt luôn những mutation THẬT của trang đã
   * nằm trong hàng đợi nhưng chưa kịp được giao vào lúc bắt đầu nín. Mất vài
   * record nhiễu của app rẻ hơn nhiều so với việc ghi nhầm chỉnh sửa của chính
   * mình thành chỉnh sửa của user. Chỉ phần việc ĐỒNG BỘ mới được bảo vệ — tuyệt
   * đối không `await` bên trong `fn`.
   */
  suppress<T>(fn: () => T): T {
    this.suppressDepth++;
    try {
      return fn();
    } finally {
      try {
        this.observer?.takeRecords();
      } catch (e) {
        log.error('DomObserver.suppress drain failed', e);
      }
      this.suppressDepth--;
    }
  }

  /**
   * Giao ngay mọi record mà nền tảng đang giữ, rồi lập tức coi như đã lặng.
   *
   * Dùng khi có thứ gì đó từ bên ngoài (một lần điều hướng, một lệnh từ popup)
   * cần các bên tiêu thụ cập nhật ngay mà không phải chờ hết quãng debounce.
   */
  flush(): void {
    if (!this.observer) return;
    try {
      const records = this.observer.takeRecords();
      if (this.suppressDepth > 0) return; // đám record này là của ta; vứt đi
      const hadPendingSettle = this.settleTimer !== null || this.maxTimer !== null;
      this.deliver(records);
      if (records.length > 0 || hadPendingSettle) this.fireSettled();
    } catch (e) {
      log.error('DomObserver.flush failed', e);
    }
  }

  /* ---------------------------------------------------------------------- */

  /** Chia một batch cho `onBatch` rồi hẹn giờ cho lượt settle. */
  private deliver(records: MutationRecord[]): void {
    if (records.length === 0) return;
    if (this.suppressDepth > 0) {
      // Chỉ tới được đây nếu caller nín xuyên qua một await; vứt nhiễu của ta đi.
      log.debug('DomObserver dropped', records.length, 'records while suppressed');
      return;
    }
    try {
      this.options.onBatch(records);
    } catch (e) {
      log.error('DomObserver onBatch handler threw', e);
    }
    this.scheduleSettled();
  }

  /**
   * Debounce đuôi cộng với một trần chờ tối đa.
   *
   * Timer đuôi được đặt lại ở mỗi batch; timer trần chỉ được lên dây MỘT LẦN cho
   * mỗi quãng lặng và không bao giờ bị đẩy lùi, nhờ vậy một trang mutate mãi mãi
   * vẫn đều đặn có lượt settle.
   */
  private scheduleSettled(): void {
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.fireSettled(), this.debounceMs);
    if (this.maxTimer === null) {
      const cap = Math.max(this.debounceMs, MAX_SETTLE_WAIT_MS);
      this.maxTimer = window.setTimeout(() => this.fireSettled(), cap);
    }
  }

  /** Gộp lượt settle: xoá cả hai timer đảm bảo mỗi quãng lặng chỉ gọi một lần. */
  private fireSettled(): void {
    if (this.suppressDepth > 0) {
      // Phòng thủ: tuyệt đối không để guard chạy chen vào lúc replayer đang ghi.
      if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => this.fireSettled(), SUPPRESSED_RETRY_MS);
      return;
    }
    this.clearTimers();
    try {
      this.options.onSettled();
    } catch (e) {
      log.error('DomObserver onSettled handler threw', e);
    }
  }

  private clearTimers(): void {
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.maxTimer !== null) {
      window.clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
  }

  private hookReady(): void {
    if (this.readyHooked) return;
    this.readyHooked = true;
    document.addEventListener('DOMContentLoaded', this.onDomReady, true);
  }

  private unhookReady(): void {
    if (!this.readyHooked) return;
    this.readyHooked = false;
    document.removeEventListener('DOMContentLoaded', this.onDomReady, true);
  }

  /**
   * Chuyển việc theo dõi từ `document` sang `<html>` thật.
   *
   * Gọi observe() lần nữa mà không disconnect trước sẽ đăng ký cùng một observer
   * hai lần trên hai subtree chồng lên nhau, và mọi record sẽ bị nhân đôi. Nên
   * ta giao hết record đang xếp hàng cho các bên tiêu thụ trước, rồi mới nối lại
   * vào node gốc mới.
   */
  private readonly onDomReady = (): void => {
    this.unhookReady();
    try {
      if (!this.observer || this.explicitTarget) return;
      const root = document.documentElement as HTMLElement | null;
      if (!root || this.target === root) return;
      this.deliver(this.observer.takeRecords());
      this.observer.disconnect();
      this.observer.observe(root, OBSERVE_INIT);
      this.target = root;
      log.debug('DomObserver re-targeted onto <html>');
    } catch (e) {
      log.error('DomObserver re-target failed', e);
    }
  };
}

/** Kẹp một khoảng chờ do caller đưa vào thành số mili-giây nguyên và hợp lệ. */
function normalizeDelay(ms: number): number {
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
}

// 中国法定节假日日历 · 峰谷判定共用数据源（动态装载版）
//
// 挂件里「谷时段倒计时」与「峰谷预警」都要回答同一个问题：**今天有没有高峰段**。
// 只按周一至周五判断会在节假日给出错误结论（假期内的周三被当成高峰），
// 因此这里集中维护「每一年」的放假区间与补班日，任何一处需要判断日期类型时
// 都调用本模块，不再各写一份星期表。
//
// 数据不再硬编码，也不再限定年份：由后端从**内置免费源**自动获取（免注册、免 AppKey，
// 用户无需配置任何接口地址或密钥），缓存缺失 / 过期 / 残缺时才联网，并落盘在
// `<数据目录>/holiday/CN-<年份>.json`；前端只负责装载与查询：
//
//   get_holiday_calendar     同步读本地（缓存 → 内置兜底 → 空白），永不联网；
//   refresh_holiday_calendar 按需更新（后端自行判断是否需要联网）。
//
// 判定口径与后端 `domain/pricing/model/valobj/holiday_calendar.rs` 完全一致：
//   - 法定节假日放假区间 → 全天谷价；
//   - **周六日的调休上班日（补班日）→ 同样全天谷价**；
//   - 只有周一至周五、且不在放假区间内的「普通工作日」才有
//     09:00–12:00 与 14:00–18:00 两个高峰段。
//
// 某年数据尚未装载时退化为纯自然周规则（周六日全天谷价），绝不会因为拿不到数据
// 就把周末算成高峰。装载时机见 `start()`：当前年 + 次年，随后定期巡检（跨年自动补齐）。
//
// 依赖：`window.__TAURI__.core.invoke`（缺失时纯离线可用，只查已装载的日历）。

window.DSWHoliday = (function () {
  "use strict";

  // 巡检间隔：后端「缓存优先」，新鲜时这一步只是读文件、不产生任何网络请求，
  // 因此可以取得比较密——跨年后最多 5 分钟就能拿到新一年的安排。
  var SYNC_INTERVAL_MS = 5 * 60 * 1000;

  // 已装载的年份：year -> { source, fetchedAt, complete, fresh, holidays, adjusted, ... }
  var calendars = {};

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /**
   * 拼出 `YYYY-MM-DD` 日期串（用于查表；字典序即时间序）。
   *
   * @param {number} year 公元年
   * @param {number} month **0 基**月份（与 `Date#getUTCMonth` 一致）
   * @param {number} date 日
   */
  function isoOf(year, month, date) {
    return year + "-" + pad2(month + 1) + "-" + pad2(date);
  }

  /** 北京时间「现在」（整体前移 8 小时后读 UTC 字段，不依赖系统时区）。 */
  function beijingNow() {
    return new Date(Date.now() + 8 * 3600000);
  }

  /** 当前北京时间的年份。 */
  function currentYear() {
    return beijingNow().getUTCFullYear();
  }

  /** 日期串数组 → 查表对象（每秒判定走 O(1) 命中）。 */
  function toLookup(list) {
    var map = {};
    var items = list || [];
    for (var i = 0; i < items.length; i++) {
      var iso = String(items[i] || "");
      if (iso) map[iso] = true;
    }
    return map;
  }

  /**
   * 装载某一年（或某几年）的日历数据。
   *
   * @param dto 后端返回的日历（`HolidayCalendarDto`）；含 `calendar` 字段的刷新结果也可直接传入。
   * @returns {boolean} 是否装载成功（数据非法时忽略，保留原有日历）。
   */
  function setCalendar(dto) {
    var calendar = dto && dto.calendar ? dto.calendar : dto;
    if (!calendar || typeof calendar.year !== "number") return false;
    var holidays = toLookup(calendar.holidays);
    var adjusted = toLookup(calendar.adjustedWorkdays);
    calendars[calendar.year] = {
      source: String(calendar.source || "none"),
      fetchedAt: Number(calendar.fetchedAt) || 0,
      complete: calendar.complete !== false,
      fresh: calendar.fresh !== false,
      holidays: holidays,
      adjusted: adjusted,
      holidayDays: Object.keys(holidays).length,
      adjustedDays: Object.keys(adjusted).length,
      ranges: calendar.ranges || [],
    };
    return true;
  }

  /** 该年份的数据是否已装载。 */
  function has(year) {
    return !!calendars[year];
  }

  /** 只读视图（设置界面展示用），未装载时返回 null。 */
  function calendarOf(year) {
    var table = calendars[year];
    if (!table) return null;
    return {
      year: year,
      source: table.source,
      fetchedAt: table.fetchedAt,
      complete: table.complete,
      fresh: table.fresh,
      holidayDays: table.holidayDays,
      adjustedDays: table.adjustedDays,
      ranges: table.ranges,
    };
  }

  /**
   * 判定日期类型。
   *
   * @param {number} weekday 0=周日 … 6=周六（与 `Date#getUTCDay` 一致）
   * @returns {"holiday"|"adjusted"|"weekend"|"workday"}
   *          `holiday` 法定节假日放假 / `adjusted` 调休上班日（补班）/
   *          `weekend` 普通周末 / `workday` 普通工作日。
   */
  function kindOf(year, month, date, weekday) {
    var table = calendars[year];
    if (table) {
      var iso = isoOf(year, month, date);
      if (table.holidays[iso]) return "holiday";
      if (table.adjusted[iso]) return "adjusted";
    }
    return weekday >= 1 && weekday <= 5 ? "workday" : "weekend";
  }

  /**
   * 该日是否适用工作日高峰时段（09:00–12:00 / 14:00–18:00）。
   *
   * 只有「普通工作日」才有高峰段：法定节假日放假区间不算，
   * **周六日的调休上班日（补班日）同样不算**——补班日照常全天谷价。
   *
   * 参数与 [`kindOf`](#kindOf) 相同。
   */
  function hasPeakHours(year, month, date, weekday) {
    return kindOf(year, month, date, weekday) === "workday";
  }

  // ===== 数据装载（缓存优先，必要时联网）=====

  /** Tauri IPC 入口（浏览器里预览时为 null，此时只保留纯离线能力）。 */
  function invoke() {
    return window.__TAURI__ && window.__TAURI__.core
      ? window.__TAURI__.core.invoke
      : null;
  }

  /** 把一次调用的结果吸收进日历表（响应结构不同：刷新结果比日历多一层 `calendar`）。 */
  function absorb(res) {
    setCalendar(res);
    return res;
  }

  /**
   * 准备某一年的数据（数据源与是否联网全由后端决定，前端不做任何配置）。
   *
   * - 手上这份还新鲜：只读一次本地缓存（后端可能刚更新过）；
   * - 缺失 / 过期 / 残缺：交给后端按「缓存 / TTL / 完整性」规则决定是否请求接口。
   */
  function sync(year) {
    var call = invoke();
    if (!call) return Promise.resolve(null);
    var info = calendarOf(year);
    var cmd =
      info && info.fresh
        ? "get_holiday_calendar"
        : "refresh_holiday_calendar";
    return call(cmd, { year: year })
      .then(absorb)
      .catch(function (err) {
        // 单年失败不影响判定：未装载的年份退化为自然周规则。
        console.error("装载 " + year + " 年节假日日历失败", err);
        return null;
      });
  }

  /** 准备「当前年 + 次年」两年：当年判定要用，次年供跨年倒计时使用。 */
  function syncAround() {
    var year = currentYear();
    return sync(year).then(function () {
      return sync(year + 1);
    });
  }

  var timer = null;

  /**
   * 启动装载与巡检（幂等；无 IPC 时不做任何动作）。
   *
   * @returns {Promise} 首次装载完成（配置页据此在装载后刷新界面）。
   */
  function start() {
    if (!invoke()) return Promise.resolve(null);
    if (!timer) {
      timer = setInterval(function () {
        syncAround();
      }, SYNC_INTERVAL_MS);
    }
    return syncAround();
  }

  /** 停止巡检。 */
  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    isoOf: isoOf,
    currentYear: currentYear,
    setCalendar: setCalendar,
    has: has,
    calendarOf: calendarOf,
    kindOf: kindOf,
    hasPeakHours: hasPeakHours,
    sync: sync,
    syncAround: syncAround,
    start: start,
    stop: stop,
  };
})();

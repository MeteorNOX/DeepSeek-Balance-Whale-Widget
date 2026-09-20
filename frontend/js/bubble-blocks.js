// 模块化气泡 · 共享渲染器
//
// 配置页右侧的「预览气泡」与桌面挂件上的真实气泡共用这一份渲染逻辑：
// 两处各写一遍必然走样（预览看着对、上桌就变），因此这里只做一件事——
// 把「行 → 模块 → DOM」这套结构算出来，样式全部交给 bubble-blocks.css。
//
// 尺寸基准：气泡内 1u = 挂件宽度 / 1026（与既有气泡文字一致），
// 因此模块字号存「逻辑像素」，渲染时换算成 u 倍数（--dshw-fs），
// 这样挂件整体缩放时模块字会跟着一起缩放，不会出现大小两张皮。
//
// 依赖：无（纯函数 + DOM，配置页与挂件窗口都能直接加载）。

window.DSWH = window.DSWH || {};

(function (DSWH) {
  "use strict";

  // 气泡内 1 逻辑像素对应的 u 数量（1026 / 250）。
  var U_PER_PX = 1026 / 250;

  // 可选模块区：类型 + 中文名。
  var KINDS = [
    { kind: "text", label: "文本" },
    { kind: "balance", label: "余额" },
    { kind: "today", label: "今日已用" },
    { kind: "countdown", label: "DS峰谷倒计时" },
    { kind: "link", label: "超链接" },
    { kind: "media", label: "图片/动图" },
  ];

  // 字号 / 图片宽度的取值区间（与后端规范化、弹窗滑块完全一致）。
  var FONT_SIZE = { min: 10, max: 40, step: 1, value: 18 };
  var MEDIA_WIDTH = { min: 50, max: 300, step: 10, value: 120 };

  // 默认文字色（与气泡描边同色）。
  var DEFAULT_COLOR = "#203170";
  var DEFAULT_BG = "#ffffff";

  // 上传字体之后的字族兜底：上传字体通常不含中文字形，缺字必须能回落。
  var FALLBACK_FONTS = '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif';

  function kindLabel(kind) {
    for (var i = 0; i < KINDS.length; i++) {
      if (KINDS[i].kind === kind) return KINDS[i].label;
    }
    return kind;
  }

  /** 文本转义（预览与挂件都会把用户输入写进 innerHTML 之外的属性 / 文本节点）。 */
  function escape(text) {
    return String(text === undefined || text === null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** 生成一个模块 id（拖拽 / 删除时定位用）。 */
  function newId() {
    return "bb-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  /**
   * 按类型生成一个新模块（字段与后端 `BubbleBlock::default()` 对齐）。
   *
   * 内容一律留空：示例文案由输入框的 placeholder 承担，
   * 「占位提示」不是可提交内容，配置里也就不该出现「自定义文本」这种假数据。
   */
  function newBlock(kind) {
    return {
      id: newId(),
      kind: kind,
      text: "",
      linkName: "",
      linkUrl: "",
      media: "",
      mediaWidth: MEDIA_WIDTH.value,
      supplier: "",
      fontFamily: "",
      fontSize: kind === "countdown" ? 16 : FONT_SIZE.value,
      color: DEFAULT_COLOR,
      bold: false,
      italic: false,
      underline: false,
      background: false,
      backgroundColor: DEFAULT_BG,
      glow: false,
    };
  }

  /** 文字模块的占位符（弹窗输入框用，避免两处各写一份文案）。 */
  var PLACEHOLDERS = {
    text: "请输入文本内容",
    linkName: "请输入显示名称",
    linkUrl: "https://example.com",
  };

  /** 上传字体对应的 CSS 家族名（配置页与挂件注入 @font-face 时用同一个名字）。 */
  function fontFamilyOf(file) {
    if (!file) return "";
    return "dshw-font-" + String(file).replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  // ===== 峰谷时段与倒计时 =====
  //
  // 与 balance.js（挂件内置三行气泡）以及后端 `domain/pricing/service/pricing_service.rs`
  // 保持同一套规则：高峰时段（北京时间）09:00–12:00 与 14:00–18:00，且只有
  // 「普通工作日」才有高峰段——法定节假日放假区间与周六日的调休上班日（补班日）
  // 全天谷价，普通周末同样如此（日历见 holiday-calendar.js）。
  // 模块化气泡的倒计时由这里统一推算，配置页预览与桌面挂件因此完全一致。
  var PEAK_BLOCKS = [
    [9 * 60, 12 * 60],
    [14 * 60, 18 * 60],
  ];

  /** 取北京时间的字段（时间戳整体前移 8 小时后读 UTC 字段，不依赖系统时区）。 */
  function beijingParts(now) {
    var ms = now === undefined || now === null ? Date.now() : now.getTime();
    var d = new Date(ms + 8 * 3600000);
    return {
      weekday: d.getUTCDay(),
      minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
      year: d.getUTCFullYear(),
      month: d.getUTCMonth(),
      date: d.getUTCDate(),
    };
  }

  /** 北京时间「当天 00:00」的毫秒时间戳。 */
  function beijingDayStart(now) {
    var b = beijingParts(now);
    return Date.UTC(b.year, b.month, b.date) - 8 * 3600000;
  }

  /** 目标时刻 = 今天 00:00（北京时间）+ 偏移天数 + 当日分钟数。 */
  function targetAt(now, dayOffset, minutesOfDay) {
    return beijingDayStart(now) + (dayOffset * 1440 + minutesOfDay) * 60000;
  }

  /** 以今天为基准偏移 offset 天的北京日期字段（跨月跨年由 Date.UTC 归一化）。 */
  function beijingDayAt(now, offset) {
    var b = beijingParts(now);
    var d = new Date(Date.UTC(b.year, b.month, b.date + offset));
    return {
      weekday: d.getUTCDay(),
      year: d.getUTCFullYear(),
      month: d.getUTCMonth(),
      date: d.getUTCDate(),
    };
  }

  /** 该天是否有高峰段（只有普通工作日有：法定节假日与补班日、周末都没有）。 */
  function isPeakDay(parts) {
    return DSWHoliday.hasPeakHours(
      parts.year,
      parts.month,
      parts.date,
      parts.weekday,
    );
  }

  /**
   * 当前时段与倒计时目标：高峰时指向本段结束时刻，空闲时指向下一段开始时刻。
   *
   * 周末、法定节假日与补班日都没有高峰段，因此周五 18:00 之后、以及长假期间的
   * 倒计时会直接落到下一个普通工作日 09:00。
   */
  function periodInfo(now) {
    var d = now || new Date();
    var today = beijingParts(d);
    var minutes = today.minutes;
    var i;
    if (isPeakDay(today)) {
      for (i = 0; i < PEAK_BLOCKS.length; i++) {
        if (minutes >= PEAK_BLOCKS[i][0] && minutes < PEAK_BLOCKS[i][1]) {
          return { isPeak: true, target: targetAt(d, 0, PEAK_BLOCKS[i][1]) };
        }
      }
    }
    // 向后找最近一个有高峰段的日子：官方最长假期（春节）为 9 天，
    // 取三周窗口足以覆盖放假区间与前后周末。
    for (var offset = 0; offset <= 21; offset++) {
      var day = beijingDayAt(d, offset);
      if (!isPeakDay(day)) continue;
      for (i = 0; i < PEAK_BLOCKS.length; i++) {
        // 今天已开始（或已结束）的段不再作为目标。
        if (offset === 0 && PEAK_BLOCKS[i][0] <= minutes) continue;
        return { isPeak: false, target: targetAt(d, offset, PEAK_BLOCKS[i][0]) };
      }
    }
    return { isPeak: false, target: d.getTime() };
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /** 剩余毫秒 → `HH:MM:SS`（小时不取模，周末倒计时可超过 24 小时）。 */
  function fmtCountdown(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return pad2(h) + ":" + pad2(m) + ":" + pad2(s);
  }

  /** 倒计时模块的展示文本（预览与挂件共用，避免两处走样）。 */
  function countdownText(values) {
    var time = (values && values.countdown) || "";
    return time ? (values.peak ? "峰：" : "谷：") + time : "峰谷：--";
  }

  /** 该 block 是否需要在气泡里渲染出可见内容。 */
  function hasContent(block) {
    if (!block) return false;
    if (block.kind === "media") return !!block.media;
    return true;
  }

  /** 把模块的样式写进元素（尺寸 / 颜色 / 字形 / 底色 / 流光）。 */
  function applyStyle(el, block) {
    var size = Number(block.fontSize);
    if (!isFinite(size)) size = FONT_SIZE.value;
    size = Math.max(FONT_SIZE.min, Math.min(FONT_SIZE.max, size));
    // --dshw-fs 是「u 倍数」：font-size = u * 倍数，随挂件缩放一起变。
    el.style.setProperty("--dshw-fs", String(size * U_PER_PX));
    el.style.color = block.color || DEFAULT_COLOR;
    var family = fontFamilyOf(block.fontFamily);
    // 上传字体后面必须跟具体字族兜底：CSS 不允许「字族列表里混用 inherit」这样的
    // 组合值（整条声明会被丢弃），而缺字形的字符要能回落到界面默认字体。
    if (family) el.style.fontFamily = '"' + family + '", ' + FALLBACK_FONTS;
    el.style.fontWeight = block.bold ? "800" : "";
    el.style.fontStyle = block.italic ? "italic" : "";
    el.style.textDecoration = block.underline ? "underline" : "";
    if (block.background) {
      el.classList.add("dshw-bblock-bg");
      el.style.background = block.backgroundColor || DEFAULT_BG;
    }
    if (block.glow) el.classList.add("dshw-bblock-glow");
  }

  /** 取数据值（余额 / 今日已用）：按供应商 slug 查，取不到统一回落 `--`。 */
  function valueOf(values, group, slug) {
    var bucket = (values && values[group]) || {};
    var key = slug || "";
    var hit = bucket[key];
    if (hit === undefined || hit === null || hit === "") return "--";
    return String(hit);
  }

  /**
   * 渲染单个模块。
   *
   * @param block 配置里的模块对象。
   * @param values 动态数据：`{ balance: {slug: 文本}, today: {...}, countdown: "HH:MM:SS",
   *               media: {文件名: DataURL} }`。
   */
  function renderBlock(block, values) {
    var el = document.createElement("span");
    el.className = "dshw-bblock";
    el.setAttribute("data-kind", block.kind || "text");
    el.setAttribute("data-block-id", block.id || "");
    // 流光由 .dshw-bblock-glow 一条类名全部承担（CSS 在文字本体上做渐变位移），
    // JS 不需要额外插入节点：倒计时每秒改写 textContent 也就不会把高光抹掉。
    applyStyle(el, block);
    var inner;
    if (block.kind === "media") {
      var src = ((values && values.media) || {})[block.media] || "";
      inner = document.createElement("img");
      inner.className = "dshw-bmedia";
      inner.alt = "气泡图片";
      inner.draggable = false;
      var width = Number(block.mediaWidth);
      if (!isFinite(width)) width = MEDIA_WIDTH.value;
      width = Math.max(MEDIA_WIDTH.min, Math.min(MEDIA_WIDTH.max, width));
      inner.style.setProperty("--dshw-mw", String(width * U_PER_PX));
      if (src) inner.src = src;
    } else if (block.kind === "link") {
      inner = document.createElement("a");
      inner.className = "dshw-btext dshw-blink";
      inner.href = "#";
      inner.setAttribute("data-url", block.linkUrl || "");
      inner.textContent = block.linkName || block.linkUrl || "链接";
    } else if (block.kind === "balance") {
      inner = document.createElement("span");
      inner.className = "dshw-btext";
      inner.textContent = valueOf(values, "balance", block.supplier);
    } else if (block.kind === "today") {
      inner = document.createElement("span");
      inner.className = "dshw-btext";
      inner.textContent = valueOf(values, "today", block.supplier);
    } else if (block.kind === "countdown") {
      inner = document.createElement("span");
      inner.className = "dshw-btext";
      inner.textContent = countdownText(values);
    } else {
      inner = document.createElement("span");
      inner.className = "dshw-btext";
      inner.textContent = block.text || "";
    }
    el.appendChild(inner);
    return el;
  }

  /**
   * 渲染整块气泡内容：一行一个 `.dshw-brow`，行内模块从左到右。
   *
   * @param rows 配置里的行数组。
   * @param values 动态数据（见 {@link renderBlock}）。
   * @param options `{ onClickLink(url) }`：超链接点击回调（挂件用系统浏览器打开）。
   */
  function renderRows(rows, values, options) {
    var opts = options || {};
    var frag = document.createDocumentFragment();
    (rows || []).forEach(function (row) {
      var blocks = (row && row.blocks) || [];
      if (!blocks.length) return;
      var rowEl = document.createElement("div");
      rowEl.className = "dshw-brow";
      blocks.forEach(function (block) {
        if (!hasContent(block)) return;
        var el = renderBlock(block, values);
        if (block.kind === "link") {
          var link = el.querySelector(".dshw-blink");
          if (link) {
            link.addEventListener("click", function (e) {
              e.preventDefault();
              e.stopPropagation();
              var url = link.getAttribute("data-url") || "";
              if (url && opts.onClickLink) opts.onClickLink(url);
            });
          }
        }
        rowEl.appendChild(el);
      });
      if (rowEl.children.length) frag.appendChild(rowEl);
    });
    return frag;
  }

  /** 配置里是否有可渲染的模块（决定是否切换到模块化气泡）。 */
  function hasBlocks(rows) {
    return (rows || []).some(function (row) {
      return row && (row.blocks || []).some(function (block) {
        return block && block.kind;
      });
    });
  }

  DSWH.KINDS = KINDS;
  DSWH.FONT_SIZE = FONT_SIZE;
  DSWH.MEDIA_WIDTH = MEDIA_WIDTH;
  DSWH.DEFAULT_COLOR = DEFAULT_COLOR;
  DSWH.DEFAULT_BG = DEFAULT_BG;
  DSWH.PLACEHOLDERS = PLACEHOLDERS;
  DSWH.kindLabel = kindLabel;
  DSWH.escape = escape;
  DSWH.newId = newId;
  DSWH.newBlock = newBlock;
  DSWH.fontFamilyOf = fontFamilyOf;
  DSWH.periodInfo = periodInfo;
  DSWH.fmtCountdown = fmtCountdown;
  DSWH.countdownText = countdownText;
  DSWH.renderBlock = renderBlock;
  DSWH.renderRows = renderRows;
  DSWH.hasBlocks = hasBlocks;
})(window.DSWH);

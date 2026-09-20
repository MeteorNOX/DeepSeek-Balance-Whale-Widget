// 小鲸鱼余额挂件 · 模块化气泡渲染模块（桌面挂件）
//
// 气泡内容不再写死：只要配置里有模块行，气泡就改由用户配置的模块渲染
// （文本 / 余额 / 今日已用 / 峰谷倒计时 / 超链接 / 图片动图），
// 配置为空时回落到内置的余额三行气泡，老用户界面不变。
//
// 渲染交给 bubble-blocks.js（window.DSWH）——与配置页右侧预览是同一份代码，
// 因此「配置里看到的」与「桌面上显示的」必然一致。
//
// 依赖：core.js（DSW.invoke/DSW.C）、dom.js（DSW.dom）、bubble-blocks.js（window.DSWH）。

window.DSW = window.DSW || {};

(function (DSW) {
  "use strict";

  if (DSW.modular) return;

  var DSWH = window.DSWH;
  if (!DSWH || !DSW.dom) return;

  var C = DSW.C;
  var dom = DSW.dom;

  // 当前配置的模块行（形状与后端 BubbleConfig.rows 一致）。
  var rows = [];
  // 是否处于模块化气泡模式（配置里至少有一个模块）。
  var active = false;
  // 渲染用的动态数据，形状见 DSWH.renderBlock 的 values 参数。
  var values = { balance: {}, today: {}, countdown: "", peak: false, media: {} };
  var mediaCache = {};
  var fontLoaded = {};
  var fontStyleEl = null;
  var containerEl = null;
  var refreshTimer = null;
  var tickTimer = null;
  /** 上一次渲染的内容签名：内容没变就不重建 DOM。 */
  var renderKey = "";
  // 「--」占位符：余额 / 今日已用取不到数据时统一展示。
  var PLACEHOLDER = "--";

  /** 内容层：挂在文字层内，与内置三行共用同一个定位（left 44.25% / top 38%）。 */
  function ensureContainer() {
    if (containerEl && containerEl.parentNode === dom.textBox) return containerEl;
    containerEl = document.createElement("div");
    containerEl.className = "dshw-bmodular";
    containerEl.style.display = "none";
    dom.textBox.appendChild(containerEl);
    return containerEl;
  }

  /** 隐藏内置三行（display:none 不占位，气泡高度随之收缩）。 */
  function hideBuiltinLines() {
    [dom.amountEl, dom.hintEl, dom.periodEl].forEach(function (el) {
      if (el) el.style.display = "none";
    });
  }

  function openExternal(url) {
    if (!url || !DSW.invoke) return;
    DSW.invoke("open_external", { url: url }).catch(function () {
      /* 打开失败无需打扰用户（配置页里已有对应提示） */
    });
  }

  /**
   * 内容签名：只包含「重绘时会被写进 DOM 的那部分静态数据」。
   *
   * 倒计时与峰谷标记不参与签名：它们每秒由 tickCountdown 直接改文本节点，
   * 一旦计入签名，任何一次 render()（余额轮询、悬浮展示气泡、余额刷新事件）
   * 都会因为「秒数变了」而整块重建 DOM——正在跑的流光动画随之被打断重播，
   * 桌面上的观感就是「循环一两轮后卡一下再从头」。
   */
  function contentKey() {
    return (
      JSON.stringify(rows) +
      "|" +
      JSON.stringify({
        balance: values.balance,
        today: values.today,
        media: values.media,
      })
    );
  }

  /** 重绘气泡内容（仅在模块化模式下有意义）。 */
  function render() {
    if (!active) return;
    var el = ensureContainer();
    hideBuiltinLines();
    el.style.display = "";
    // 内容签名未变时不重建 DOM：避免每次余额轮询都重排、并让流光动画重头播。
    var key = contentKey();
    if (key === renderKey) return;
    renderKey = key;
    el.innerHTML = "";
    el.appendChild(
      DSWH.renderRows(rows, values, { onClickLink: openExternal }),
    );
  }

  /** 显示 / 隐藏模块化内容层（台词气泡等场景需要临时让位）。 */
  function setVisible(visible) {
    if (!containerEl) return;
    containerEl.style.display = visible && active ? "" : "none";
    if (visible && active) hideBuiltinLines();
  }

  function isActive() {
    return active;
  }

  // ===== 动态数据 =====

  function usedSlugs() {
    var list = [];
    rows.forEach(function (row) {
      (row.blocks || []).forEach(function (block) {
        if (block.kind !== "balance" && block.kind !== "today") return;
        var slug = block.supplier || "";
        if (list.indexOf(slug) === -1) list.push(slug);
      });
    });
    return list;
  }

  function usedMedia() {
    var list = [];
    rows.forEach(function (row) {
      (row.blocks || []).forEach(function (block) {
        if (block.kind !== "media" || !block.media) return;
        if (list.indexOf(block.media) === -1) list.push(block.media);
      });
    });
    return list;
  }

  function usedFonts() {
    var list = [];
    rows.forEach(function (row) {
      (row.blocks || []).forEach(function (block) {
        if (!block.fontFamily) return;
        if (list.indexOf(block.fontFamily) === -1) list.push(block.fontFamily);
      });
    });
    return list;
  }

  function hasCountdown() {
    return rows.some(function (row) {
      return (row.blocks || []).some(function (block) {
        return block.kind === "countdown";
      });
    });
  }

  /**
   * 金额格式化：直接复用 balance.js 的 `fmt`（内置气泡用的同一个函数），
   * 保证模块化气泡里的数字与内置气泡完全一致（含币种符号与小数位）。
   */
  function fmtMoney(value, currency) {
    if (DSW.balance && DSW.balance.fmt) return DSW.balance.fmt(value, currency);
    var num = Number(value);
    return isFinite(num) ? num.toFixed(2) : PLACEHOLDER;
  }

  /** 余额载荷 → 展示文本；失败 / 取不到统一展示占位符 `--`。 */
  function payloadText(payload, field) {
    if (!payload || !payload.ok) return PLACEHOLDER;
    var raw = payload[field];
    if (raw === null || raw === undefined) return PLACEHOLDER;
    var num = Number(raw);
    if (!isFinite(num)) return PLACEHOLDER;
    return fmtMoney(num * (Number(payload.rate) || 1), payload.displayCurrency);
  }

  /** 注入 @font-face：上传的字体在桌面气泡里同样生效。 */
  function injectFontFace(family, dataUrl) {
    if (!fontStyleEl) {
      fontStyleEl = document.createElement("style");
      fontStyleEl.id = "dshwFontFaces";
      document.head.appendChild(fontStyleEl);
    }
    fontStyleEl.appendChild(
      document.createTextNode(
        '@font-face{font-family:"' +
          family +
          '";src:url("' +
          dataUrl +
          '");font-display:swap;}',
      ),
    );
  }

  function loadMedia(name) {
    if (!name) return Promise.resolve();
    if (mediaCache[name]) {
      values.media[name] = mediaCache[name];
      return Promise.resolve();
    }
    return DSW.invoke("read_bubble_media", { name: name })
      .then(function (dataUrl) {
        mediaCache[name] = dataUrl;
        values.media[name] = dataUrl;
      })
      .catch(function () {
        // 资源被删除：该模块不渲染图片，不影响其它模块。
      });
  }

  function loadFont(name) {
    if (!name || fontLoaded[name]) return Promise.resolve();
    fontLoaded[name] = true;
    return DSW.invoke("read_bubble_font", { name: name })
      .then(function (dataUrl) {
        injectFontFace(DSWH.fontFamilyOf(name), dataUrl);
      })
      .catch(function () {
        fontLoaded[name] = false;
      });
  }

  /** 每秒只更新倒计时的文本节点：不重建 DOM，气泡内容不会闪烁。 */
  function tickCountdown() {
    if (!active || !hasCountdown()) return;
    var info = DSWH.periodInfo(new Date());
    values.countdown = DSWH.fmtCountdown(info.target - Date.now());
    values.peak = info.isPeak;
    if (!containerEl) return;
    var next = DSWH.countdownText(values);
    containerEl
      .querySelectorAll('[data-kind="countdown"] .dshw-btext')
      .forEach(function (node) {
        if (node.textContent !== next) node.textContent = next;
      });
  }

  /** 重新拉取余额 / 今日已用 / 图片 / 字体，然后重绘。 */
  function refreshValues() {
    if (!active || !DSW.invoke) return Promise.resolve();
    var jobs = [];
    usedSlugs().forEach(function (slug) {
      jobs.push(
        DSW.invoke("get_supplier_balance", { scope: "balance", slug: slug })
          .then(function (payload) {
            values.balance[slug] = payloadText(payload, "totalBalance");
            values.today[slug] = payloadText(payload, "todayUsage");
          })
          .catch(function () {
            values.balance[slug] = PLACEHOLDER;
            values.today[slug] = PLACEHOLDER;
          }),
      );
    });
    usedMedia().forEach(function (name) {
      jobs.push(loadMedia(name));
    });
    usedFonts().forEach(function (name) {
      jobs.push(loadFont(name));
    });
    values.countdown = "";
    return Promise.all(jobs).then(function () {
      tickCountdown();
      render();
    });
  }

  /**
   * 应用气泡配置。
   *
   * @param cfg 后端 `BubbleConfig` 形状的对象（事件载荷与 get_config 里的 bubble 一致）。
   */
  function applyConfig(cfg) {
    rows = cfg && Array.isArray(cfg.rows) ? cfg.rows : [];
    active = DSWH.hasBlocks(rows);
    renderKey = "";
    if (!active) {
      // 未配置模块：彻底让位给内置三行气泡，界面与旧版完全一致。
      values = { balance: {}, today: {}, countdown: "", peak: false, media: {} };
      if (containerEl) {
        containerEl.innerHTML = "";
        containerEl.style.display = "none";
      }
      // 先恢复内置三行的可见性（模块化期间它们被 display:none 隐藏过），
      // 再让 balance 重算内容与峰谷行的显隐。
      [dom.amountEl, dom.hintEl, dom.periodEl].forEach(function (el) {
        if (el) el.style.display = "";
      });
      if (DSW.balance) DSW.balance.render();
      return;
    }
    render();
    refreshValues();
  }

  DSW.modular = {
    applyConfig: applyConfig,
    render: render,
    setVisible: setVisible,
    isActive: isActive,
    refreshValues: refreshValues,
  };

  // 每秒刷新倒计时；气泡未展示时不写 DOM（展开时由 balance.render 立即补上最新值）。
  tickTimer = setInterval(function () {
    if (!DSW.flags.bubbleShown || DSW.flags.bubbleRandomActive) return;
    tickCountdown();
  }, 1000);

  // 余额数据源 / 显示币种变化时，模块化的余额与今日已用同样要重新取数。
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen("balance-refresh-requested", function () {
      refreshValues();
    });
  }

  // 周期刷新：与内置气泡的余额轮询同频（只是把同一个数字取回来）。
  refreshTimer = setInterval(function () {
    refreshValues();
  }, C.REFRESH_MS);

  DSW.modular.stopTimers = function () {
    if (tickTimer) clearInterval(tickTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    tickTimer = null;
    refreshTimer = null;
  };
})(window.DSW);

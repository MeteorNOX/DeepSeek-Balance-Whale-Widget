// 小鲸鱼余额挂件 · 余额刷新/动画/渲染模块
//
// 负责余额格式化、数值滚动动画、气泡内容渲染与余额拉取刷新。
// 依赖：core.js（DSW.invoke/DSW.state/DSW.flags/DSW.C）、dom.js（DSW.dom）、
//       bubble.js（DSW.bubble）、bubble-blocks.js（DSWH 的时段判定与倒计时）。

window.DSW = window.DSW || {};

(function (DSW) {
  "use strict";

  if (DSW.balance) return;

  var C = DSW.C;
  var state = DSW.state;
  var flags = DSW.flags;

  // 数值夹取到 [lo, hi] 区间。
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // 各币种对应的货币符号。
  var CURRENCY_SYMBOL = {
    CNY: "¥",
    USD: "$",
    EUR: "€",
    JPY: "¥",
    GBP: "£",
    HKD: "HK$",
  };

  // 余额格式化。
  function fmt(balance, currency) {
    const num = Number(balance);
    const fixed = isFinite(num) ? num.toFixed(2) : "--";
    const symbol = CURRENCY_SYMBOL[currency];
    if (symbol) return symbol + " " + fixed;
    return currency ? fixed + " " + currency : fixed;
  }

  // 按展示币种与汇率换算后格式化。
  function fmtDisplay(nativeValue) {
    if (nativeValue === null || nativeValue === undefined) return "--";
    const num = Number(nativeValue);
    if (!isFinite(num)) return "--";
    return fmt(num * state.rate, state.displayCurrency);
  }

  // 余额滚动动画：沿用平滑缓出曲线。
  function animateAmount(from, to, duration) {
    if (flags.animId) cancelAnimationFrame(flags.animId);
    if (from === null || !isFinite(from)) from = to;
    if (from === to) {
      flags.shown = to;
      DSW.dom.amountEl.textContent = fmtDisplay(to);
      return;
    }
    let startTime = null;
    function step(ts) {
      if (startTime === null) startTime = ts;
      const t = Math.min(1, (ts - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = from + (to - from) * eased;
      DSW.dom.amountEl.textContent = fmtDisplay(val);
      if (t < 1) flags.animId = requestAnimationFrame(step);
      else {
        flags.animId = null;
        flags.shown = to;
        DSW.dom.amountEl.textContent = fmtDisplay(to);
      }
    }
    flags.animId = requestAnimationFrame(step);
  }

  // 停掉进行中的滚动动画与它的调度 / 收尾定时器。
  //
  // 动画是**每帧直接写金额节点**的，若不显式取消，它会在「--」写入之后继续把
  // 上一个数值画回气泡，并把 flags.shown 定格为旧值——这正是一条独立的
  // 「显示上一个数据源数字」的路径，因此失败与切换数据源时都必须先取消它。
  function cancelAmountAnimation() {
    if (flags.animId) {
      cancelAnimationFrame(flags.animId);
      flags.animId = null;
    }
    if (flags.animDelayTimer) {
      clearTimeout(flags.animDelayTimer);
      flags.animDelayTimer = null;
    }
    if (flags.settleTimer) {
      clearTimeout(flags.settleTimer);
      flags.settleTimer = null;
    }
  }

  // 余额数据源（当前启用供应商）已切换：把上一个供应商的余额与今日已用一并作废。
  //
  // 必须同时作废**在途请求**（序号自增）：切换前发出的响应稍后落地时，
  // 会把气泡又写回上一个供应商的余额与今日已用——这是「切到未连通的供应商却
  // 显示 DeepSeek 数字」的主要成因。
  function invalidateBalance() {
    cancelAmountAnimation();
    flags.balanceSeq += 1;
    state.balance = null;
    state.todayUsage = null;
    state.awaitingSource = true;
    state.status = "loading";
    state.message = "";
    flags.shown = null;
  }

  // ===== 峰谷时段与倒计时 =====
  //
  // 时段判定与倒计时推算只保留**一份实现**：`DSWH.periodInfo` / `DSWH.fmtCountdown`
  // （见 bubble-blocks.js，日期类型由 holiday-calendar.js 提供）。
  // 内置三行气泡与模块化气泡因此永远同口径，不会出现「预览对、上桌错」。
  // 规则本身与后端 `domain/pricing/service/pricing_service.rs` 一致，
  // 前端持有它是为了每秒本地推算（无需额外请求）。

  // 时段行的子节点（每秒刷新时复用，避免反复重建 DOM）。
  var periodTagEl = null;
  var periodTimeEl = null;

  // 构建时段行：峰/谷 标签 + 分隔符 + 倒计时。
  function ensurePeriodDom() {
    var host = DSW.dom.periodEl;
    if (
      periodTagEl &&
      periodTagEl.parentNode === host &&
      periodTimeEl &&
      periodTimeEl.parentNode === host
    ) {
      return;
    }
    host.innerHTML = "";
    periodTagEl = document.createElement("span");
    periodTagEl.className = "dshwv-period-tag";
    var sep = document.createElement("span");
    sep.className = "dshwv-period-sep";
    sep.textContent = "：";
    periodTimeEl = document.createElement("span");
    periodTimeEl.className = "dshwv-period-time";
    host.appendChild(periodTagEl);
    host.appendChild(sep);
    host.appendChild(periodTimeEl);
  }

  // 峰谷提示的显隐：非 DeepSeek 数据源整行去掉（display:none 不占位，
  // 气泡高度随之收缩，不会留下空白行）；模块化气泡下同样整行让位。
  function applyPeriodVisibility() {
    var show =
      state.peakSupported !== false &&
      !(DSW.modular && DSW.modular.isActive());
    DSW.dom.periodEl.style.display = show ? "" : "none";
    return show;
  }

  // 渲染时段行（峰：红 / 谷：绿，数字随场景同色）。
  function renderPeriod() {
    if (!applyPeriodVisibility()) return;
    var info = DSWH.periodInfo(new Date());
    ensurePeriodDom();
    var host = DSW.dom.periodEl;
    host.classList.toggle("dshwv-period-peak", info.isPeak);
    host.classList.toggle("dshwv-period-off", !info.isPeak);
    // 与展示保持一致：当前时段以本地推算为准（后端同规则，仅用于首次赋值）。
    state.isPeak = info.isPeak;
    var tag = info.isPeak ? "峰" : "谷";
    if (periodTagEl.textContent !== tag) periodTagEl.textContent = tag;
    var text = DSWH.fmtCountdown(info.target - Date.now());
    // 仅在文本变化时写入，避免无意义的样式/布局计算。
    if (periodTimeEl.textContent !== text) periodTimeEl.textContent = text;
  }

  // 每秒刷新倒计时：只改数字文本，节点与布局保持稳定，无卡顿。
  // 气泡未展示或正在展示台词时不写 DOM：这两种情况下时段行要么不可见、
  // 要么被台词占用，气泡重新展开时由 showBubble → restoreBubbleLines → render
  // 立即补渲染，因此不会出现过期数值。
  function startPeriodTicker() {
    if (flags.periodTimer) return;
    flags.periodTimer = setInterval(function () {
      if (!flags.bubbleShown || flags.bubbleRandomActive) return;
      // 非 DeepSeek 数据源不展示峰谷提示，无需每秒空转。
      if (state.peakSupported === false) return;
      renderPeriod();
    }, 1000);
  }

  // 渲染当前余额/用量到气泡。
  function render() {
    // 模块化气泡：气泡内容完全由用户配置的模块渲染，内置三行整层让位。
    // 值本身来自各模块各自的供应商（见 modular.js），与 state.balance 无关，
    // 因此这里直接交给模块化渲染器，不写入任何内置行。
    if (DSW.modular && DSW.modular.isActive()) {
      // 台词气泡优先占用整个文字层（与内置三行同一套语义）：
      // 轮询触发的重渲染不能把正在展示的台词盖掉。
      if (flags.bubbleRandomActive && flags.bubbleRandomLines) {
        DSW.bubble.applyBubbleLines(flags.bubbleRandomLines);
      } else {
        DSW.modular.render();
      }
      return;
    }
    let amount, hint;
    if (state.status === "error" || state.awaitingSource) {
      // 取数失败，或刚切换余额数据源（旧数值已作废）：一律显示占位文案，
      // 绝不把上一个供应商的余额 / 今日已用留在气泡上。
      amount = "--";
      hint = "--";
    } else if (state.balance === null) {
      amount = flags.shown !== null ? fmtDisplay(flags.shown) : "…";
      hint = "加载中…";
    } else {
      amount =
        flags.shown !== null
          ? fmtDisplay(flags.shown)
          : fmtDisplay(state.balance);
      hint =
        "今日已用 " +
        (state.todayUsage !== null && state.todayUsage !== undefined
          ? fmtDisplay(state.todayUsage)
          : "--");
    }
    DSW.dom.amountEl.textContent = amount;
    if (flags.bubbleRandomActive && flags.bubbleRandomLines)
      DSW.bubble.applyBubbleLines(flags.bubbleRandomLines);
    else {
      DSW.bubble.setHint(hint);
      // 时段行：峰/谷 标签 + 剩余时间倒计时（每秒由 ticker 刷新）。
      renderPeriod();
    }
  }

  // 拉取余额并刷新显示。
  //
  // `opts.sourceChanged` 由调用方（余额数据源变更事件）给出：为真时表示当前启用的
  // 供应商换了，上一个供应商的数值必须立刻作废。这一步要在 busy 早退**之前**做，
  // 否则切换时恰好有一次轮询在途，旧供应商的响应会先落地并显示出来。
  function refresh(manual, opts) {
    if (opts && opts.sourceChanged) {
      invalidateBalance();
      // 立刻把「--」画出来：既不能等到新数据源取数回来才更新显示，
      // 也不能让在途的旧供应商响应抢先落地。
      render();
    }
    if (flags.busy) {
      if (manual) flags.pendingBalanceRefresh = true;
      return;
    }
    flags.busy = true;
    flags.pendingBalanceRefresh = false;
    cancelAmountAnimation();
    if (manual || state.balance === null) {
      state.status = "loading";
      render();
    }

    if (!DSW.invoke) {
      flags.busy = false;
      return;
    }
    // 本次取数的序号：响应回来时若已不是最新序号（例如期间切换了数据源），
    // 说明它属于上一个数据源，整条丢弃。
    const seq = ++flags.balanceSeq;
    DSW.invoke("get_balance")
      .then(function (data) {
        if (seq !== flags.balanceSeq) return;
        state.awaitingSource = false;
        // 峰谷提示的显隐只取决于「当前数据源是否支持峰谷计价」，
        // 与本次查询成败无关：查询失败时同样要按数据源决定是否展示。
        if (data) state.peakSupported = data.peakSupported !== false;
        if (data && data.ok) {
          const nb = Number(data.totalBalance);
          const nc = String(data.currency || "CNY");
          const changed =
            state.balance !== null &&
            (nb !== state.balance || nc !== state.currency);
          const currencyChanged =
            state.currency !== null && nc !== state.currency;
          state.balance = nb;
          state.currency = nc;
          state.message = "";
          state.todayUsage =
            data.todayUsage !== undefined ? data.todayUsage : null;
          state.isPeak = !!data.isPeak;
          state.displayCurrency = String(data.displayCurrency || nc);
          state.rate = Number(data.rate) || 1;
          if (DSW.expression && DSW.expression.syncExhaustedMode) {
            DSW.expression.syncExhaustedMode();
          }
          // 自动轮询下若余额变化，先展示气泡再执行数字滚动。
          if (changed && !currencyChanged) {
            if (!manual) {
              DSW.bubble.showBubble();
              state.status = "changing";
              if (flags.animDelayTimer) clearTimeout(flags.animDelayTimer);
              flags.animDelayTimer = setTimeout(function () {
                flags.animDelayTimer = null;
                animateAmount(flags.shown, nb, C.ANIM_MS);
              }, 300);
              if (flags.settleTimer) clearTimeout(flags.settleTimer);
              flags.settleTimer = setTimeout(function () {
                flags.settleTimer = null;
                if (state.status === "changing") {
                  state.status = "ok";
                  render();
                }
              }, C.CHANGE_MS + 300);
            } else {
              animateAmount(flags.shown, nb, C.ANIM_MS);
              state.status = "ok";
              render();
            }
          } else {
            if (flags.animId === null) flags.shown = nb;
            state.status = "ok";
            render();
          }
        } else {
          // 失败：先停掉滚动动画，否则它会在「--」写入之后把旧数值继续画出来。
          cancelAmountAnimation();
          state.status = "error";
          state.message = data && data.error ? String(data.error) : "获取失败";
          render();
        }
      })
      .catch(function () {
        if (seq !== flags.balanceSeq) return;
        state.awaitingSource = false;
        cancelAmountAnimation();
        state.status = "error";
        state.message = "获取失败";
        render();
      })
      .finally(function () {
        flags.busy = false;
        if (flags.pendingBalanceRefresh) {
          refresh(true);
        }
      });
  }

  DSW.balance = {
    fmt: fmt,
    clamp: clamp,
    animateAmount: animateAmount,
    render: render,
    refresh: refresh,
    renderPeriod: renderPeriod,
  };

  // 启动每秒倒计时刷新：挂件常驻，单次仅写入一个文本节点。
  startPeriodTicker();
})(window.DSW);

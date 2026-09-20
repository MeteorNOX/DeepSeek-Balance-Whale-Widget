// 小鲸鱼余额挂件 · 气泡交互模块
//
// 负责气泡的显示/隐藏、三行文字切换、文字层生命周期动画、
// 随机台词与时间气泡等交互逻辑。
// 文字淡入淡出只发生在气泡的入场（隐藏→展示）与退场（展示→隐藏）两个节点，
// 稳定打开阶段更新文字一律立即完整显示，不触发任何过渡。
// 依赖：core.js（DSW.state/DSW.flags/DSW.C）、dom.js（DSW.dom）、
//       widget-config.js（DSW.widgetConfig，运行时调用）、balance.js（DSW.balance，运行时调用）。

window.DSW = window.DSW || {};

(function (DSW) {
  "use strict";

  if (DSW.bubble) return;

  var C = DSW.C;
  var flags = DSW.flags;

  // 气泡三行文字对应的样式 class。
  var BUBBLE_STYLE_CLASS = {
    A: "dshwv-label",
    B: "dshwv-amount",
    P: "dshwv-period",
    C: "dshwv-hint",
  };

  // 生成单行居中的三行气泡结构。
  function singleCenter(style, text, color, wrap) {
    return [null, { t: text, s: style, c: color || "", w: !!wrap }, null];
  }

  // 将三行台词应用到气泡文字节点。
  function applyBubbleLines(lines) {
    // 台词气泡要占用整个文字层：模块化内容先让位（否则会与台词叠在一起）。
    if (DSW.modular) DSW.modular.setVisible(false);
    const els = [DSW.dom.amountEl, DSW.dom.periodEl, DSW.dom.hintEl];
    for (let i = 0; i < 3; i++) {
      const el = els[i];
      const ln = lines && lines[i];
      if (ln) {
        el.style.display = "";
        el.className =
          (BUBBLE_STYLE_CLASS[ln.s] || "dshwv-label") +
          (ln.w ? " dshwv-wrap" : "");
        el.textContent = ln.t;
        el.style.color = ln.c || "";
      } else {
        el.style.display = "none";
        el.textContent = "";
        el.style.color = "";
      }
    }
  }

  // 设置提示行文字（直接赋值，无渐显动画）。
  function setHint(text) {
    DSW.dom.hintEl.textContent = text;
  }

  // ===== 文字层生命周期 =====
  //
  // closed → entering（入场：文字随气泡渐入）→ open（稳定打开）
  //        → exiting（退场：文字渐出）→ closed
  //
  // 过渡类只在 entering / exiting 阶段挂在文字层上（样式见 widget.css），
  // 稳定打开阶段文字层没有任何透明度过渡，因此期间的内容更新会立即完整显示。
  var TEXT_FADE_MS = 160; // 渐入/渐出时长，与 widget.css 中同名类一致
  var TEXT_FADE_DELAY_MS = 360; // 入场延迟：与气泡形状的展开动画错开
  var ENTER_SETTLE_MS = TEXT_FADE_DELAY_MS + TEXT_FADE_MS + 40;
  var EXIT_SETTLE_MS = TEXT_FADE_MS + 40;
  var TEXT_ENTER_CLASS = "dshwv-text-enter";
  var TEXT_EXIT_CLASS = "dshwv-text-exit";

  // 当前阶段："closed" | "entering" | "open" | "exiting"。
  var textPhase = "closed";
  var textPhaseTimer = null;

  function clearPhaseTimer() {
    if (textPhaseTimer) {
      clearTimeout(textPhaseTimer);
      textPhaseTimer = null;
    }
  }

  // 进入/离开过渡阶段时挂载、结算后摘除过渡类。
  function dropPhaseClasses() {
    DSW.dom.textBox.classList.remove(TEXT_ENTER_CLASS, TEXT_EXIT_CLASS);
  }

  // 入场：仅在“从隐藏到展示”时调用，触发一次文字渐入。
  function enterText() {
    clearPhaseTimer();
    dropPhaseClasses();
    DSW.dom.textBox.classList.add(TEXT_ENTER_CLASS);
    textPhase = "entering";
    textPhaseTimer = setTimeout(function () {
      textPhaseTimer = null;
      // 结算到稳定打开阶段：此后更新文字不会有任何过渡。
      dropPhaseClasses();
      textPhase = "open";
    }, ENTER_SETTLE_MS);
  }

  // 退场：仅在“从展示到隐藏”时调用，触发一次文字渐出。
  function exitText() {
    clearPhaseTimer();
    dropPhaseClasses();
    DSW.dom.textBox.classList.add(TEXT_EXIT_CLASS);
    textPhase = "exiting";
    textPhaseTimer = setTimeout(function () {
      textPhaseTimer = null;
      dropPhaseClasses();
      textPhase = "closed";
    }, EXIT_SETTLE_MS);
  }

  // 恢复默认的余额三行内容（纯内容更新，不涉及任何过渡）。
  function restoreBubbleLines() {
    DSW.dom.amountEl.style.display = "";
    DSW.dom.amountEl.className = "dshwv-amount";
    DSW.dom.amountEl.style.color = "";
    DSW.dom.periodEl.style.display = "";
    DSW.dom.periodEl.className = "dshwv-period";
    DSW.dom.periodEl.style.color = "";
    DSW.dom.hintEl.style.display = "";
    DSW.dom.hintEl.className = "dshwv-hint";
    DSW.dom.hintEl.style.color = "";
    DSW.balance.render();
  }

  // 展示余额气泡。
  function showBubble() {
    if (flags.bubbleTimer) {
      clearTimeout(flags.bubbleTimer);
      flags.bubbleTimer = null;
    }
    flags.clickBubbleActive = true;
    DSW.widgetConfig.pauseDialogue();
    // 记录切换前的状态：只有“隐藏 → 展示”才走入场动画。
    const alreadyShown = flags.bubbleShown;
    flags.bubbleShown = true;
    flags.bubbleRandomActive = false;
    // 先写入最终内容，再入场渐入，保证渐入的就是最新文字。
    restoreBubbleLines();
    if (!alreadyShown) enterText();
    DSW.dom.bubbleBox.classList.add("dshwv-bubble-open");
    flags.bubbleTimer = setTimeout(hideBubble, C.BUBBLE_MS);
  }

  // 隐藏气泡。
  function hideBubble() {
    if (flags.bubbleTimer) {
      clearTimeout(flags.bubbleTimer);
      flags.bubbleTimer = null;
    }
    flags.bubbleRandomActive = false;
    flags.bubbleRandomLines = null;
    // 记录切换前的状态：只有“展示 → 隐藏”才走退场动画。
    const wasShown = flags.bubbleShown;
    flags.bubbleShown = false;
    flags.clickBubbleActive = false;
    if (wasShown) exitText();
    DSW.dom.bubbleBox.classList.remove("dshwv-bubble-open");
  }

  // 展示一条台词（居中样式）。
  function showDialogueLine(line) {
    flags.clickBubbleActive = false;
    const lines = singleCenter("A", line, "", true);
    flags.bubbleRandomActive = true;
    flags.bubbleRandomLines = lines;
    if (flags.bubbleShown) {
      // 稳定打开状态下更换文字：直接替换，立即完整显示。
      applyBubbleLines(lines);
    } else {
      flags.bubbleShown = true;
      // 隐藏 → 展示：先写入内容，再走入场渐入。
      applyBubbleLines(lines);
      enterText();
      DSW.dom.bubbleBox.classList.add("dshwv-bubble-open");
    }
    if (flags.bubbleTimer) {
      clearTimeout(flags.bubbleTimer);
      flags.bubbleTimer = null;
    }
    // 台词气泡使用单独时长，避免与余额气泡互相覆盖。
    flags.bubbleTimer = setTimeout(hideBubble, C.DIALOGUE_SHOW_MS);
  }

  DSW.bubble = {
    showBubble: showBubble,
    hideBubble: hideBubble,
    applyBubbleLines: applyBubbleLines,
    restoreBubbleLines: restoreBubbleLines,
    setHint: setHint,
    showDialogueLine: showDialogueLine,
  };
})(window.DSW);

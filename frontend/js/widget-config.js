// 小鲸鱼余额挂件 · 显示配置与台词调度模块
//
// 负责应用挂件显示配置（缩放/音量/音效/气泡颜色）、保存配置、
// 以及台词配置的应用与定时调度。
// 依赖：core.js（DSW.invoke/DSW.state/DSW.flags/DSW.C）、
//       audio.js（DSW.audio，运行时调用）、balance.js（DSW.balance.clamp）、
//       bubble.js（DSW.bubble.showDialogueLine，运行时调用）。

window.DSW = window.DSW || {};

(function (DSW) {
  "use strict";

  if (DSW.widgetConfig) return;

  var C = DSW.C;
  var state = DSW.state;
  var flags = DSW.flags;
  var EXHAUSTED_LINES = [
    "额度快见底了，省着点花喵…",
    "本鲸已经有点转不动了…",
    "余额薄得像尾巴尖了…",
    "再这样下去要喝西北风啦…",
    "我闻到贫穷的海风了喵。",
    "今天先克制一点点，好吗？",
    "钱包在打喷嚏，是真的。",
    "余额快瘦成一条线了…",
    "本鲸的工作餐要保不住了。",
    "别再连点了，额度会哭的。",
    "这个数额，看着有点心慌…",
    "再冲动消费，本鲸就躺平了。",
    "现在适合精打细算模式。",
    "我已经自动切到省电表情了。",
    "先缓一缓，明天再战也行。",
    "余额这么低，本鲸都不敢翻身。",
    "这点额度，只够我眨两次眼…",
    "理智一点，别让账单追上来。",
    "本鲸建议你先补充一点预算。",
    "再不回点血，就真要疲惫了喵。",
  ];

  // 峰谷切换点（北京时间）：toPeak=true 表示进入高峰。
  // 只有「普通工作日」才有这些切换点（法定节假日放假区间与周六日的补班日
  // 全天谷价，都没有切换点），日期类型由 holiday-calendar.js 统一判定。
  var PEAK_TRANSITIONS = [
    { h: 9, m: 0, toPeak: true },
    { h: 12, m: 0, toPeak: false },
    { h: 14, m: 0, toPeak: true },
    { h: 18, m: 0, toPeak: false },
  ];

  // 取“北京时间的同一时刻”Date：时间戳整体前移 8 小时后，
  // 其 UTC 字段即为北京时间（下面两个取值函数都按 UTC 读取）。
  // 注意：这里不能参与本地时区换算——加上 getTimezoneOffset() 只在系统时区为 UTC 时
  // 才凑巧正确，在 UTC+8 等时区会多偏移 8 小时，导致峰谷提示在错误时刻触发。
  function beijingNow() {
    var now = new Date();
    return new Date(now.getTime() + 8 * 3600000);
  }
  function beijingMinutesOfDay(d) {
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }

  function clampInt(v, fallback, min, max) {
    var num = Math.floor(Number(v));
    if (!isFinite(num)) return fallback;
    var out = Math.max(min || 0, num);
    return typeof max === "number" ? Math.min(max, out) : out;
  }

  function clampThreshold(v) {
    var num = Math.round(Math.max(0, Number(v)) * 100) / 100;
    return isFinite(num) ? num : 5;
  }

  function canShowAutoSpeech() {
    return !(
      flags.clickBubbleActive ||
      flags.bubbleShown ||
      flags.pressing ||
      (flags.drag && flags.drag.active)
    );
  }

  function applyBlinkConfig(minSec, maxSec) {
    var min = clampInt(minSec, 4, 1);
    var max = clampInt(maxSec, 6, 1);
    flags.blinkIntervalMinSec = min;
    flags.blinkIntervalMaxSec = Math.max(min, max);
  }

  function applyExhaustedConfig(enabled, threshold) {
    flags.exhaustedModeEnabled = enabled !== false;
    flags.exhaustedBalanceThreshold = clampThreshold(threshold);
  }

  // 表情阈值：失望（分钟）/ 生气（点击次数）/ 害羞（秒）。
  //
  // 全部来自配置（配置页「挂件状态」区块），不再写死在 core.js 常量里；
  // 越界值按各自区间收敛，缺省时回落到出厂值（3 分钟 / 18 次 / 2 秒）。
  function applyMoodConfig(minutes, clicks, shySec) {
    flags.disappointedThresholdMin = clampInt(minutes, 3, 1, 1440);
    flags.angryThresholdClicks = clampInt(clicks, 18, 1, 100);
    flags.shyThresholdSec = clampInt(shySec, 2, 1, 3600);
  }

  function applyPeakWarnConfig(enabled, minutes) {
    flags.peakWarnEnabled = enabled !== false;
    var m = Math.floor(Number(minutes));
    flags.peakWarnMinutes = isFinite(m) && m >= 1 ? m : 9;
    schedulePeakWarn();
  }

  function schedulePeakWarn() {
    stopPeakWarn();
    if (!flags.peakWarnEnabled) return;
    flags.peakWarnTimer = setInterval(checkPeakWarn, 30000);
    checkPeakWarn();
  }

  function stopPeakWarn() {
    if (flags.peakWarnTimer) {
      clearInterval(flags.peakWarnTimer);
      flags.peakWarnTimer = null;
    }
  }

  function checkPeakWarn() {
    if (!flags.peakWarnEnabled) return;
    // 峰谷预警是 DeepSeek 的计价提示：切换到其它供应商后整条链路停用。
    if (DSW.state && DSW.state.peakSupported === false) return;
    var now = beijingNow();
    // 日期类型按北京时间的年月日与星期判定：只有普通工作日才有峰谷切换点。
    // 法定节假日放假区间与周六日的补班日全天谷价，因此都不提醒。
    var isPeakDay = DSWHoliday.hasPeakHours(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCDay(),
    );
    if (!isPeakDay) return;
    var nowMin = beijingMinutesOfDay(now);
    var dateKey = now.toISOString().slice(0, 10);
    var interval = Math.max(1, Math.round(flags.peakWarnMinutes / 3));
    for (var i = 0; i < PEAK_TRANSITIONS.length; i++) {
      var t = PEAK_TRANSITIONS[i];
      var tMin = t.h * 60 + t.m;
      for (var k = 3; k >= 1; k--) {
        var notifyMin = tMin - interval * k;
        if (notifyMin < 0 || nowMin < notifyMin || nowMin >= tMin) continue;
        var key = dateKey + "_" + t.h + ":" + t.m + "_" + k;
        if (flags.peakWarnShown[key]) continue;
        if (!canShowAutoSpeech()) return;
        flags.peakWarnShown[key] = true;
        DSW.bubble.showDialogueLine(
          t.toPeak ? "我马上变贵啦！" : "我马上便宜啦！",
        );
        return;
      }
    }
  }

  // 应用缩放（通过 CSS 变量同步缩放内容，不再 resize 窗口）。
  function applyScale(v) {
    const next =
      Math.round(Math.min(C.MAX_SCALE, Math.max(C.MIN_SCALE, Number(v))) * 10) /
      10;
    if (next === state.scale) return;
    state.scale = next;
    DSW.dom.root.style.setProperty("--dshw-scale", String(next));
  }

  // 应用音量（播放时按 soundVol 生效，无需逐个调整音频实例）。
  function applyVol(v) {
    const next = Math.round(Math.min(1, Math.max(0, Number(v))) * 100) / 100;
    flags.soundVol = next;
    flags.soundOn = next > 0;
  }

  // 应用音效组配置：预设 id（duck / dingdong）或自定义音效组名称。
  function applySoundSetFromConfig(v) {
    if (C.SOUND_SETS[v]) flags.soundSet = v;
    else if (typeof v === "string" && v.trim()) flags.soundSet = v.trim();
    else flags.soundSet = "duck";
    DSW.audio.applySoundSet();
  }

  // 应用气泡描边/文字颜色。
  function applyBubbleColor(color) {
    if (!color) return;
    document
      .querySelectorAll(".dshwv-bshape, .dshwv-b1, .dshwv-b2")
      .forEach(function (el) {
        el.setAttribute("stroke", color);
      });
    const textEl = document.querySelector(".dshwv-text");
    if (textEl) textEl.style.color = color;
  }

  // 应用挂件显示配置。
  function applyWidgetConfig(w) {
    if (!w) return;
    if (
      typeof w.scale === "number" &&
      w.scale >= C.MIN_SCALE - 0.1 &&
      w.scale <= C.MAX_SCALE + 0.1
    ) {
      if (Math.abs(w.scale - state.scale) > 0.001) applyScale(w.scale);
    }
    if (typeof w.vol === "number") {
      applyVol(w.vol);
    }
    if (typeof w.soundSet === "string") {
      applySoundSetFromConfig(w.soundSet);
    }
    if (typeof w.bubbleColor === "string") {
      flags.bubbleColor = w.bubbleColor;
      applyBubbleColor(w.bubbleColor);
    }
    flags.soundOn = w.sound !== false;
    applyBlinkConfig(w.blinkIntervalMinSec, w.blinkIntervalMaxSec);
    applyExhaustedConfig(w.exhaustedModeEnabled, w.exhaustedBalanceThreshold);
    applyPeakWarnConfig(w.peakWarnEnabled, w.peakWarnMinutes);
    applyMoodConfig(
      w.disappointedThresholdMin,
      w.angryThresholdClicks,
      w.shyThresholdSec,
    );
    if (typeof w.snapDistance === "number") flags.snapDistance = w.snapDistance;
    if (typeof w.widgetBody === "string" && w.widgetBody) {
      if (flags.widgetBody !== w.widgetBody) {
        flags.widgetBody = w.widgetBody;
        // 切换挂件本体：作废旧资源缓存并重建命中蒙版，
        // 确保后续表情只从新本体对应文件夹读取，杜绝跨组串图。
        if (DSW.images && DSW.images.invalidate) DSW.images.invalidate();
        if (DSW.hit && DSW.hit.setupHitTest) DSW.hit.setupHitTest();
      }
    }
    if (DSW.expression && DSW.expression.handleWidgetConfigChange) {
      DSW.expression.handleWidgetConfigChange();
    }
  }

  // 保存挂件显示配置到后端。
  function saveConfig() {
    if (!DSW.invoke) return;
    DSW.invoke("save_widget_config", {
      widget: {
        scale: state.scale,
        sound: flags.soundOn,
        vol: flags.soundVol,
        soundSet: flags.soundSet,
        bubbleColor: flags.bubbleColor,
        blinkIntervalMinSec: flags.blinkIntervalMinSec,
        blinkIntervalMaxSec: flags.blinkIntervalMaxSec,
        exhaustedModeEnabled: flags.exhaustedModeEnabled,
        exhaustedBalanceThreshold: flags.exhaustedBalanceThreshold,
        peakWarnEnabled: flags.peakWarnEnabled,
        peakWarnMinutes: flags.peakWarnMinutes,
        snapDistance: flags.snapDistance,
        widgetBody: flags.widgetBody,
      },
    }).catch(function () {});
  }

  // 应用台词配置。
  function applyDialogueConfig(dlg) {
    if (!dlg) return;
    flags.dialogueLines = Array.isArray(dlg.lines) ? dlg.lines.slice() : [];
    flags.dialogueMode =
      dlg.mode === "carousel" || dlg.mode === "random" ? dlg.mode : "random";
    flags.dialogueIntervalMin =
      typeof dlg.intervalMin === "number" && dlg.intervalMin >= 1
        ? dlg.intervalMin
        : 5;
    flags.dialogueJitter =
      typeof dlg.jitter === "number"
        ? DSW.balance.clamp(dlg.jitter, 0, 100)
        : 0;
    flags.dialogueIndex = 0;
    // 新配置生效后重新排期，避免沿用旧 timer。
    scheduleNextDialogue();
  }

  // 计算下一条台词的延迟毫秒数。
  function nextDialogueDelayMs() {
    const base = flags.dialogueIntervalMin * 60000;
    const jitterFrac = (flags.dialogueJitter / 100) * 0.8;
    const min = base * (1 - jitterFrac);
    const delay = min + Math.random() * (base - min);
    return Math.round(delay);
  }

  // 选择下一条台词（random / carousel）。
  function pickDialogueLine() {
    if (!flags.dialogueLines.length) return null;
    if (flags.dialogueMode === "random") {
      return flags.dialogueLines[
        Math.floor(Math.random() * flags.dialogueLines.length)
      ];
    }
    const line =
      flags.dialogueLines[flags.dialogueIndex % flags.dialogueLines.length];
    flags.dialogueIndex =
      (flags.dialogueIndex + 1) % flags.dialogueLines.length;
    return line;
  }

  // 暂停台词调度。
  function pauseDialogue() {
    if (flags.dialogueTimer) {
      clearTimeout(flags.dialogueTimer);
      flags.dialogueTimer = null;
    }
  }

  function pickExhaustedPromptLine() {
    if (!EXHAUSTED_LINES.length) return null;
    var line =
      EXHAUSTED_LINES[flags.exhaustedPromptIndex % EXHAUSTED_LINES.length];
    flags.exhaustedPromptIndex =
      (flags.exhaustedPromptIndex + 1) % EXHAUSTED_LINES.length;
    return line;
  }

  function pauseExhaustedPrompts() {
    if (flags.exhaustedPromptTimer) {
      clearTimeout(flags.exhaustedPromptTimer);
      flags.exhaustedPromptTimer = null;
    }
  }

  function scheduleNextExhaustedPrompt(delayMs) {
    pauseExhaustedPrompts();
    if (
      !DSW.expression ||
      !DSW.expression.isExhaustedModeActive ||
      !DSW.expression.isExhaustedModeActive()
    ) {
      return;
    }
    flags.exhaustedPromptTimer = setTimeout(
      function () {
        flags.exhaustedPromptTimer = null;
        if (
          !DSW.expression ||
          !DSW.expression.isExhaustedModeActive ||
          !DSW.expression.isExhaustedModeActive()
        ) {
          return;
        }
        if (!canShowAutoSpeech()) {
          scheduleNextExhaustedPrompt(1000);
          return;
        }
        var line = pickExhaustedPromptLine();
        if (line) DSW.bubble.showDialogueLine(line);
        scheduleNextExhaustedPrompt(C.EXHAUSTED_PROMPT_INTERVAL_MS);
      },
      typeof delayMs === "number" ? delayMs : C.EXHAUSTED_PROMPT_INTERVAL_MS,
    );
  }

  function syncExhaustedPromptSchedule() {
    if (
      DSW.expression &&
      DSW.expression.isExhaustedModeActive &&
      DSW.expression.isExhaustedModeActive()
    ) {
      if (!flags.exhaustedPromptTimer) {
        scheduleNextExhaustedPrompt(C.EXHAUSTED_PROMPT_INTERVAL_MS);
      }
      return;
    }
    pauseExhaustedPrompts();
  }

  // 调度下一条台词。
  function scheduleNextDialogue() {
    if (flags.dialogueTimer) {
      clearTimeout(flags.dialogueTimer);
      flags.dialogueTimer = null;
    }
    if (!flags.dialogueLines.length) return;
    const delay = nextDialogueDelayMs();
    flags.dialogueTimer = setTimeout(function () {
      flags.dialogueTimer = null;
      // 有用户交互或气泡占用时顺延，不抢占当前反馈。
      if (!canShowAutoSpeech()) {
        scheduleNextDialogue();
        return;
      }
      const line = pickDialogueLine();
      if (line) DSW.bubble.showDialogueLine(line);
      scheduleNextDialogue();
    }, delay);
  }

  DSW.widgetConfig = {
    applyScale: applyScale,
    applyVol: applyVol,
    applySoundSetFromConfig: applySoundSetFromConfig,
    applyBubbleColor: applyBubbleColor,
    applyMoodConfig: applyMoodConfig,
    applyWidgetConfig: applyWidgetConfig,
    saveConfig: saveConfig,
    applyDialogueConfig: applyDialogueConfig,
    nextDialogueDelayMs: nextDialogueDelayMs,
    pickDialogueLine: pickDialogueLine,
    pauseDialogue: pauseDialogue,
    pickExhaustedPromptLine: pickExhaustedPromptLine,
    pauseExhaustedPrompts: pauseExhaustedPrompts,
    scheduleNextExhaustedPrompt: scheduleNextExhaustedPrompt,
    syncExhaustedPromptSchedule: syncExhaustedPromptSchedule,
    scheduleNextDialogue: scheduleNextDialogue,
  };
})(window.DSW);

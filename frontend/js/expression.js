// 小鲸鱼余额挂件 · 表情状态机模块
//
// 负责鲸鱼的表情状态（普通/生气/失落/害羞）切换、空闲计时、
// 以及点击处理（连点检测、主状态点击序列）。
// 依赖：core.js（DSW.flags/DSW.C）、dom.js（DSW.dom）、bubble.js（DSW.bubble）、
//       balance.js（DSW.balance）、widget-config.js（DSW.widgetConfig）。

window.DSW = window.DSW || {};

(function (DSW) {
  "use strict";

  if (DSW.expression) return;

  var C = DSW.C;
  var flags = DSW.flags;
  var state = DSW.state;

  // 失落状态内置语录
  var LONELY_LINES = [
    "主人不理我，好寂寞…",
    "喵…都不看本鲸一眼…",
    "等了你好久好久…",
    "尾巴都垂下来了…",
    "罐头不香了吗…",
    "你忘了本鲸在这里了吗…",
    "太阳落山了，你还没来…",
    "连呼噜都没力气…",
    "本鲸趴门口等了好久…",
    "你鼠标路过也不摸我…",
    "喵…本鲸心里空空的…",
    "窗台好冷，主人不在…",
    "我给空气翻肚皮…",
    "本鲸叫了三声，没人应…",
    "你的影子都走了…",
    "本鲸的人生突然好灰暗…",
    "你连本鲸尾巴尖都没碰过…",
    "主人…本鲸还在等你回家呢。",
  ];

  // 眨眼帧对应的状态资源（自定义挂件组需具备其中之一才启用眨眼）。
  var BLINK_FRAME_STATES = ["half_closed_eyes", "close_eyes", "half_open_eyes"];

  // 切换鲸鱼图片（内置资源直接用，自定义挂件组经 DSW.images 解析为 Data URL）。
  // 序号保证只有最新一次请求的结果会被应用，避免异步返回乱序导致表情串图。
  var iconSeq = 0;
  // 最近一次请求的图标来源：自定义组的 <img> src 是 Data URL，不能直接比对路径。
  var lastIconSrc = null;
  function setIcon(src) {
    var seq = ++iconSeq;
    lastIconSrc = src;
    DSW.images.resolve(src, function (resolved) {
      if (seq !== iconSeq) return;
      DSW.dom.img.src = resolved;
    });
  }

  function getBaseIcon() {
    return flags.exhaustedMode ? C.IMG_EXHAUSTED : C.IMG_URL;
  }

  function getPressIcon() {
    return C.IMG_URL_PRESS;
  }

  function syncVisualState() {
    if (!DSW.dom || !DSW.dom.img) return;
    if (flags.mood === "angry") {
      setIcon(C.IMG_ANGRY);
      return;
    }
    if (flags.mood === "disappointed") {
      setIcon(C.IMG_DISAPPOINTED);
      return;
    }
    if (flags.mood === "shy") {
      setIcon(C.IMG_SHY);
      return;
    }
    if (flags.pressing) {
      setIcon(getPressIcon());
      return;
    }
    setIcon(getBaseIcon());
  }

  function clearBlinkTimers() {
    if (flags.blinkTimer) {
      clearTimeout(flags.blinkTimer);
      flags.blinkTimer = null;
    }
    if (flags.blinkFrameTimer) {
      clearTimeout(flags.blinkFrameTimer);
      flags.blinkFrameTimer = null;
    }
  }

  // 是否允许开始眨眼：仅主状态、非疲惫、未按下，且本组确实具备眨眼帧资源。
  // 缺少眨眼帧的挂件组（例如仅 main.png）保持主图不变，不产生任何状态切换。
  function isBlinkAllowed() {
    return (
      flags.mood === "normal" &&
      !flags.exhaustedMode &&
      !flags.pressing &&
      !!DSW.dom.img &&
      lastIconSrc === C.IMG_URL &&
      DSW.images.hasAnyState(BLINK_FRAME_STATES)
    );
  }

  function cancelBlink(restoreIcon) {
    var active = !!(
      flags.blinking ||
      flags.blinkTimer ||
      flags.blinkFrameTimer
    );
    clearBlinkTimers();
    flags.blinking = false;
    if (restoreIcon && active) syncVisualState();
  }

  function scheduleNextBlink() {
    cancelBlink(false);
    if (flags.mood !== "normal" || flags.exhaustedMode || flags.pressing)
      return;
    // 本组没有眨眼帧资源时无需排期，避免无意义的定时器与状态抖动。
    if (!DSW.images.hasAnyState(BLINK_FRAME_STATES)) return;
    var min = Math.max(1, Number(flags.blinkIntervalMinSec) || 4);
    var max = Math.max(min, Number(flags.blinkIntervalMaxSec) || 6);
    var delay = Math.round((min + Math.random() * (max - min)) * 1000);
    flags.blinkTimer = setTimeout(function () {
      flags.blinkTimer = null;
      startBlink();
    }, delay);
  }

  function startBlink() {
    if (!isBlinkAllowed()) {
      scheduleNextBlink();
      return;
    }
    flags.blinking = true;
    setIcon(C.IMG_HALF_CLOSED_EYES);
    flags.blinkFrameTimer = setTimeout(function () {
      if (
        !flags.blinking ||
        flags.mood !== "normal" ||
        flags.exhaustedMode ||
        flags.pressing
      ) {
        cancelBlink(true);
        return;
      }
      setIcon(C.IMG_CLOSE_EYES);
      flags.blinkFrameTimer = setTimeout(function () {
        if (
          !flags.blinking ||
          flags.mood !== "normal" ||
          flags.exhaustedMode ||
          flags.pressing
        ) {
          cancelBlink(true);
          return;
        }
        setIcon(C.IMG_HALF_OPEN_EYES);
        flags.blinkFrameTimer = setTimeout(function () {
          flags.blinkFrameTimer = null;
          flags.blinking = false;
          syncVisualState();
          scheduleNextBlink();
        }, C.BLINK_HALF_OPEN_MS);
      }, C.BLINK_CLOSE_MS);
    }, C.BLINK_HALF_CLOSED_MS);
  }

  // 清除表情相关计时器（生气/失落轮播）。
  function clearMoodTimers() {
    if (flags.moodTimer) {
      clearTimeout(flags.moodTimer);
      flags.moodTimer = null;
    }
    if (flags.lonelyCarouselTimer) {
      clearInterval(flags.lonelyCarouselTimer);
      flags.lonelyCarouselTimer = null;
    }
  }

  // 清除悬浮计时器。
  function clearHoverTimer() {
    if (flags.hoverTimer) {
      clearTimeout(flags.hoverTimer);
      flags.hoverTimer = null;
    }
    flags.isHovering = false;
  }

  // 重置空闲计时（无交互达到「失望阈值」分钟则进入失望状态）。
  //
  // 阈值来自配置（flags.disappointedThresholdMin），出厂默认 3 分钟。
  function resetIdle() {
    if (flags.idleTimer) {
      clearTimeout(flags.idleTimer);
      flags.idleTimer = null;
    }
    if (flags.mood === "disappointed" || flags.mood === "exhausted") return;
    var minutes = Math.max(
      1,
      Math.round(Number(flags.disappointedThresholdMin) || 3),
    );
    flags.idleTimer = setTimeout(
      function () {
        flags.idleTimer = null;
        enterDisappointed();
      },
      minutes * 60 * 1000,
    );
  }

  // 以台词气泡展示心情提示。
  function showMoodBubble(text) {
    DSW.bubble.showDialogueLine(text);
  }

  // 重置主状态下的点击序列计数。
  function resetWhaleClickSequence() {
    flags.lastWhaleClickAt = 0;
    flags.whaleClickStep = 0;
  }

  function isExhaustedModeActive() {
    return !!flags.exhaustedMode;
  }

  function enterExhausted() {
    if (flags.exhaustedMode && flags.mood === "exhausted") {
      syncVisualState();
      if (DSW.widgetConfig && DSW.widgetConfig.syncExhaustedPromptSchedule) {
        DSW.widgetConfig.syncExhaustedPromptSchedule();
      }
      return;
    }
    cancelBlink(false);
    clearHoverTimer();
    clearMoodTimers();
    if (flags.idleTimer) {
      clearTimeout(flags.idleTimer);
      flags.idleTimer = null;
    }
    flags.exhaustedMode = true;
    flags.mood = "exhausted";
    flags.clickLog = [];
    resetWhaleClickSequence();
    syncVisualState();
    DSW.widgetConfig.scheduleNextDialogue();
    if (DSW.widgetConfig && DSW.widgetConfig.syncExhaustedPromptSchedule) {
      DSW.widgetConfig.syncExhaustedPromptSchedule();
    }
  }

  function exitExhausted() {
    if (!flags.exhaustedMode) return;
    flags.exhaustedMode = false;
    flags.mood = "normal";
    flags.clickLog = [];
    resetWhaleClickSequence();
    if (DSW.widgetConfig && DSW.widgetConfig.syncExhaustedPromptSchedule) {
      DSW.widgetConfig.syncExhaustedPromptSchedule();
    }
    syncVisualState();
    DSW.widgetConfig.scheduleNextDialogue();
    resetIdle();
    scheduleNextBlink();
  }

  function syncExhaustedMode() {
    if (!flags.exhaustedModeEnabled) {
      exitExhausted();
      return;
    }
    var balance = Number(state.balance);
    if (!isFinite(balance)) return;
    if (!flags.exhaustedMode && balance < flags.exhaustedBalanceThreshold) {
      enterExhausted();
      return;
    }
    if (flags.exhaustedMode && balance > flags.exhaustedBalanceThreshold) {
      exitExhausted();
    }
  }

  function handleWidgetConfigChange() {
    syncExhaustedMode();
    // 配置变了（最典型的是切换挂件本体）：旧本体的资源缓存已经作废，当前这帧图
    // 必须**重新解析一次**，否则会一直停在上一个本体的图片上——疲惫模式尤其明显：
    // 这里过去直接 return，切回默认小鲸鱼后画面仍是自定义组的图，要等退出疲惫模式
    // （exitExhausted → syncVisualState）才恢复，看起来就是「切回默认挂件失效」。
    cancelBlink(false);
    syncVisualState();
    if (flags.exhaustedMode) return;
    if (flags.mood === "normal" && !flags.pressing) {
      scheduleNextBlink();
      resetIdle();
      return;
    }
  }

  // 进入生气状态：暂停台词、切图并给出警告气泡。
  function enterAngry() {
    if (flags.exhaustedMode) return;
    flags.mood = "angry";
    cancelBlink(false);
    clearHoverTimer();
    clearMoodTimers();
    DSW.widgetConfig.pauseDialogue();
    setIcon(C.IMG_ANGRY);
    showMoodBubble("你再摸人家就生气了喵 (╬ Ò﹏Ó)");
    flags.moodTimer = setTimeout(function () {
      flags.moodTimer = null;
      exitAngry();
    }, C.ANGRY_DURATION_MS);
    flags.clickLog = [];
    resetWhaleClickSequence();
  }

  // 离开生气状态后恢复默认外观与台词调度。
  function exitAngry() {
    if (flags.mood !== "angry") return;
    flags.mood = "normal";
    clearHoverTimer();
    syncVisualState();
    resetWhaleClickSequence();
    DSW.widgetConfig.scheduleNextDialogue();
    resetIdle();
    scheduleNextBlink();
  }

  // 长时间无交互后进入失落状态，并开始轮播内置语录。
  function enterDisappointed() {
    if (flags.mood === "disappointed" || flags.exhaustedMode) return;
    flags.mood = "disappointed";
    cancelBlink(false);
    clearHoverTimer();
    clearMoodTimers();
    DSW.widgetConfig.pauseDialogue();
    setIcon(C.IMG_DISAPPOINTED);
    showMoodBubble("鲸鲸没人要了喵 (╥﹏╥)");
    flags.lonelyCarouselTimer = setInterval(function () {
      const line =
        LONELY_LINES[Math.floor(Math.random() * LONELY_LINES.length)];
      showMoodBubble(line);
    }, C.LONELY_CAROUSEL_MS);
    flags.clickLog = [];
    resetWhaleClickSequence();
  }

  // 用户重新交互后退出失落状态，短暂展示回弹图标。
  function exitDisappointed() {
    if (flags.mood !== "disappointed") return;
    flags.mood = "normal";
    clearMoodTimers();
    clearHoverTimer();
    setIcon(getPressIcon());
    showMoodBubble("你终于想起本鲸了喵 (=￣ω￣=)");
    resetWhaleClickSequence();
    DSW.widgetConfig.scheduleNextDialogue();
    resetIdle();
    flags.moodTimer = setTimeout(function () {
      flags.moodTimer = null;
      if (flags.mood === "normal") {
        syncVisualState();
        scheduleNextBlink();
      }
    }, C.DISAPPOINTED_RELEASE_MS);
  }

  // 持续悬浮触发害羞状态。
  function enterShy() {
    if (flags.mood !== "normal" || flags.exhaustedMode) return;
    flags.mood = "shy";
    cancelBlink(false);
    clearHoverTimer();
    clearMoodTimers();
    resetWhaleClickSequence();
    DSW.widgetConfig.pauseDialogue();
    setIcon(C.IMG_SHY);
    showMoodBubble("主人摸本鲸头了喵 (≧◡≦)♡");
    flags.moodTimer = setTimeout(function () {
      flags.moodTimer = null;
      exitShy(false);
    }, C.SHY_DURATION_MS);
  }

  // 退出害羞状态时，根据是否被打断决定恢复到按压图或默认图。
  function exitShy(interrupted) {
    if (flags.mood !== "shy") return;
    flags.mood = "normal";
    clearMoodTimers();
    clearHoverTimer();
    if (interrupted) {
      setIcon(getPressIcon());
    } else {
      syncVisualState();
    }
    resetWhaleClickSequence();
    DSW.widgetConfig.scheduleNextDialogue();
    resetIdle();
    if (!interrupted) scheduleNextBlink();
  }

  // 生气判定阈值（点击次数）来自配置；提醒阈值随之收敛，至少提前 1 次提醒。
  function angryClickThresholds() {
    var limit = Math.max(
      1,
      Math.floor(Number(flags.angryThresholdClicks) || 18),
    );
    var warn = Math.max(1, Math.min(C.HIGH_FREQ_WARN_COUNT, limit - 1));
    return { limit: limit, warn: warn };
  }

  // 处理鲸鱼本体点击（连点检测 + 余额气泡）。
  function handleWhaleClick() {
    const now = Date.now();
    resetIdle();

    if (flags.exhaustedMode) {
      resetWhaleClickSequence();
      DSW.bubble.showBubble();
      DSW.balance.refresh(true);
      return;
    }

    // 高频连点检测：相邻间隔 ≤0.5s，窗口内累计达到配置的「生气阈值」即生气。
    const thresholds = angryClickThresholds();
    if (
      flags.clickLog.length &&
      now - flags.clickLog[flags.clickLog.length - 1] > C.HIGH_FREQ_GAP_MS
    ) {
      flags.clickLog = [];
    }
    flags.clickLog.push(now);
    while (
      flags.clickLog.length &&
      now - flags.clickLog[0] > C.HIGH_FREQ_WINDOW_MS
    ) {
      flags.clickLog.shift();
    }
    if (
      flags.clickLog.length >= thresholds.warn &&
      flags.clickLog.length < thresholds.limit
    ) {
      showMoodBubble("你再摸人家就生气了喵");
      return;
    }
    if (flags.clickLog.length >= thresholds.limit) {
      flags.clickLog = [];
      enterAngry();
      return;
    }

    DSW.bubble.showBubble();
    DSW.balance.refresh(true);
  }

  // 资源清单就绪后重新评估状态机：眨眼等能力依赖「本组是否存在对应状态图」，
  // 清单晚于首帧到达，因此必须在此刻重新决策一次。
  if (DSW.images) {
    DSW.images.onBodyReady = function () {
      syncExhaustedMode();
      syncVisualState();
      scheduleNextBlink();
    };
  }

  DSW.expression = {
    setIcon: setIcon,
    clearMoodTimers: clearMoodTimers,
    clearHoverTimer: clearHoverTimer,
    resetIdle: resetIdle,
    showMoodBubble: showMoodBubble,
    getBaseIcon: getBaseIcon,
    getPressIcon: getPressIcon,
    syncVisualState: syncVisualState,
    isBlinkAllowed: isBlinkAllowed,
    cancelBlink: cancelBlink,
    scheduleNextBlink: scheduleNextBlink,
    isExhaustedModeActive: isExhaustedModeActive,
    enterExhausted: enterExhausted,
    exitExhausted: exitExhausted,
    syncExhaustedMode: syncExhaustedMode,
    handleWidgetConfigChange: handleWidgetConfigChange,
    enterAngry: enterAngry,
    exitAngry: exitAngry,
    enterDisappointed: enterDisappointed,
    exitDisappointed: exitDisappointed,
    enterShy: enterShy,
    exitShy: exitShy,
    resetWhaleClickSequence: resetWhaleClickSequence,
    handleWhaleClick: handleWhaleClick,
  };
})(window.DSW);

// 小鲸鱼余额挂件 · 前端逻辑
//
// 由原 DSH 插件 `widget.js` 移植而来，改为通过 Tauri IPC 与 Rust 后端通信：
// - 余额/用量：invoke('get_balance')
// - 挂件显示配置：invoke('get_config') / invoke('save_widget_config')
// - 拖拽/吸附/缩放：invoke('set_window_position') / invoke('snap_window') / invoke('resize_widget')
// - 打开设置：invoke('open_config')
//
// 视觉/交互逻辑（气泡、台词、滚动动画、Q 弹、音效）与原插件保持一致。

(function () {
  if (window.__dswWhaleWidget) return;
  window.__dswWhaleWidget = true;

  // Tauri IPC 入口（withGlobalTauri 注入的全局 API）。
  const invoke =
    window.__TAURI__ && window.__TAURI__.core
      ? window.__TAURI__.core.invoke
      : null;

  // —— 常量 ——
  const MIN_SCALE = 0.6;
  const MAX_SCALE = 2.5;
  const REFRESH_MS = 60000;
  const CHANGE_MS = 900;
  const ANIM_MS = 700;
  const BUBBLE_MS = 5000;
  const CLICK_SQ = 9; // 位移平方阈值：> 3px 判定为拖动

  const IMG_URL = "assets/main.png";
  const IMG_URL_PRESS = "assets/stroking.png";
  const IMG_ANGRY = "assets/angry.png";
  const IMG_DISAPPOINTED = "assets/disappointed.png";
  const IMG_SHY = "assets/shy.png";
  const SOUND_SETS = {
    duck: { press: "assets/Ya1.mp3", release: "assets/Ya2.mp3" },
    fx1: { press: "assets/D1.mp3", release: "assets/D2.mp3" },
  };

  // —— 表情状态机常量 ——
  const ANGRY_DURATION_MS = 5000;
  const IDLE_TO_DISAPPOINTED_MS = 3 * 60 * 1000;
  const HOVER_TO_SHY_MS = 1500;
  const SHY_DURATION_MS = 10000;
  const LONELY_CAROUSEL_MS = 30000;
  const HIGH_FREQ_WINDOW_MS = 10000;
  const HIGH_FREQ_GAP_MS = 500;
  const HIGH_FREQ_COUNT = 18;
  const HIGH_FREQ_WARN_COUNT = 5;
  const DISAPPOINTED_RELEASE_MS = 300;

  // 失落状态内置语录（固定 18 条，不可被用户查看或修改）。
  const LONELY_LINES = [
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

  // 倍率 → 窗口逻辑边长（与 Rust 端 widget_size 一致）。
  function baseForScale(s) {
    return Math.min(625, Math.max(122, 250 * s));
  }

  // —— DOM 构建 ——
  const root = document.createElement("div");
  root.className = "dshwv-root";

  const img = document.createElement("img");
  img.className = "dshwv-img";
  img.src = IMG_URL;
  img.alt = "DeepSeek 余额";
  img.draggable = false;

  // 气泡内三行文字。
  const textBox = document.createElement("div");
  textBox.className = "dshwv-text";
  const labelEl = document.createElement("div");
  labelEl.className = "dshwv-label";
  labelEl.textContent = "DeepSeek 余额";
  const amountEl = document.createElement("div");
  amountEl.className = "dshwv-amount";
  const hintEl = document.createElement("div");
  hintEl.className = "dshwv-hint";
  textBox.appendChild(labelEl);
  textBox.appendChild(amountEl);
  textBox.appendChild(hintEl);

  // 气泡 SVG（几何与原插件一致）。
  const bubbleBox = document.createElement("div");
  bubbleBox.className = "dshwv-bubble";
  bubbleBox.innerHTML =
    '<svg viewBox="0 0 1026 700" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' +
    '<path class="dshwv-bshape" fill="#FFFFFF" stroke="#203170" stroke-width="18" stroke-linejoin="round" stroke-linecap="round" d="M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z"/>' +
    '<ellipse class="dshwv-b1" cx="352" cy="561" rx="37.5" ry="26" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
    '<ellipse class="dshwv-b2" cx="442" cy="646" rx="24.5" ry="18" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
    "</svg>";
  bubbleBox.appendChild(textBox);
  bubbleBox.addEventListener("click", function (e) {
    e.stopPropagation();
    if (!bubbleShown) return;
    if (bubbleRandomActive) {
      hideBubble();
    } else {
      bubbleRandomActive = true;
      bubbleRandomLines = pickRandomLines();
      swapBubbleContent(function () {
        applyBubbleLines(bubbleRandomLines);
      });
    }
  });

  const body = document.createElement("div");
  body.className = "dshwv-body";
  body.appendChild(img);
  body.appendChild(bubbleBox);
  root.appendChild(body);
  document.body.appendChild(root);

  // —— 状态 ——
  const state = {
    scale: 1.5,
    h: "right",
    v: "bottom",
    balance: null,
    currency: null,
    todayUsage: null,
    isPeak: false,
    status: "loading",
    message: "",
  };

  let busy = false;
  let settleTimer = null;
  let animDelayTimer = null;
  let drag = null;
  let shown = null;
  let animId = null;
  let bubbleShown = false;
  let bubbleTimer = null;
  let bubbleRandomActive = false;
  let bubbleRandomLines = null;

  // —— 表情状态机 ——
  let mood = "normal"; // 'normal' | 'angry' | 'disappointed' | 'shy'
  let idleTimer = null;
  let hoverTimer = null;
  let moodTimer = null;
  let lonelyCarouselTimer = null;
  let clickLog = [];
  let isHovering = false;

  const BUBBLE_STYLE_CLASS = {
    A: "dshwv-label",
    B: "dshwv-amount",
    P: "dshwv-period",
    C: "dshwv-hint",
  };

  function pickOne(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }
  function singleCenter(style, text, color, wrap) {
    return [null, { t: text, s: style, c: color || "", w: !!wrap }, null];
  }
  const RANDOM_GROUPS = [
    {
      w: 7,
      lines: function () {
        return singleCenter("B", pickOne(["好模型... ↓", "好女孩...↓"]));
      },
    },
    {
      w: 7,
      lines: function () {
        return singleCenter(
          "A",
          pickOne([
            "不知道用户有什么用，先赶走吧~",
            "我...我...我也要挣钱吗？",
            "我去吃饭啦，测完叫我",
            "压力一只蓝色大肥鱼？！",
            "DeepSleep...",
            "坏了...用户彻底怒了！",
          ]),
          "",
          true,
        );
      },
    },
    {
      w: 3,
      lines: function () {
        return singleCenter(
          "A",
          pickOne([
            "你目录里的dsh是什么...大烧货吗...?",
            "恭喜你实现token自由！token全跑了！",
            "真当我是便宜货啊...",
          ]),
          "",
          true,
        );
      },
    },
    {
      w: 1,
      lines: function () {
        return [
          { t: "这个", s: "A", c: "" },
          { t: "凶", s: "B", c: "" },
          { t: "是什么意思呀...", s: "A", c: "" },
        ];
      },
    },
    {
      w: 1,
      lines: function () {
        return singleCenter("B", "哦鲸鲸... ");
      },
    },
  ];
  function pickRandomLines() {
    let total = 0;
    for (let i = 0; i < RANDOM_GROUPS.length; i++) total += RANDOM_GROUPS[i].w;
    let r = Math.random() * total;
    for (let i = 0; i < RANDOM_GROUPS.length; i++) {
      r -= RANDOM_GROUPS[i].w;
      if (r < 0) return RANDOM_GROUPS[i].lines();
    }
    return RANDOM_GROUPS[RANDOM_GROUPS.length - 1].lines();
  }

  function applyBubbleLines(lines) {
    const els = [labelEl, amountEl, hintEl];
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

  let bubbleSwapTimer = null;
  let hintFadeTimer = null;
  let lastHintText = null;
  function setHint(text) {
    if (text === lastHintText) return;
    lastHintText = text;
    if (hintFadeTimer) {
      clearTimeout(hintFadeTimer);
      hintFadeTimer = null;
    }
    if (!bubbleShown) {
      hintEl.textContent = text;
      return;
    }
    hintEl.style.transition = "opacity .18s ease";
    hintEl.style.opacity = "0";
    hintFadeTimer = setTimeout(function () {
      hintFadeTimer = null;
      hintEl.textContent = text;
      hintEl.style.opacity = "1";
      setTimeout(function () {
        hintEl.style.transition = "";
        hintEl.style.opacity = "";
      }, 220);
    }, 190);
  }

  function swapBubbleContent(applyFn) {
    if (bubbleSwapTimer) {
      clearTimeout(bubbleSwapTimer);
      bubbleSwapTimer = null;
    }
    textBox.style.transition = "opacity .18s ease";
    textBox.style.opacity = "0";
    bubbleSwapTimer = setTimeout(function () {
      bubbleSwapTimer = null;
      applyFn();
      textBox.style.opacity = "1";
      setTimeout(function () {
        textBox.style.transition = "";
        textBox.style.opacity = "";
      }, 220);
    }, 190);
  }

  function restoreBubbleLines() {
    if (bubbleSwapTimer) {
      clearTimeout(bubbleSwapTimer);
      bubbleSwapTimer = null;
    }
    if (hintFadeTimer) {
      clearTimeout(hintFadeTimer);
      hintFadeTimer = null;
    }
    lastHintText = null;
    textBox.style.transition = "";
    textBox.style.opacity = "";
    labelEl.style.display = "";
    labelEl.className = "dshwv-label";
    labelEl.textContent = "DeepSeek 余额";
    labelEl.style.color = "";
    amountEl.style.display = "";
    amountEl.className = "dshwv-amount";
    amountEl.style.color = "";
    hintEl.style.display = "";
    hintEl.className = "dshwv-hint";
    hintEl.style.color = "";
    render();
  }

  function showBubble() {
    if (bubbleTimer) {
      clearTimeout(bubbleTimer);
      bubbleTimer = null;
    }
    clickBubbleActive = true;
    pauseDialogue();
    bubbleShown = true;
    bubbleRandomActive = false;
    restoreBubbleLines();
    bubbleBox.classList.add("dshwv-bubble-open");
    bubbleTimer = setTimeout(hideBubble, BUBBLE_MS);
  }

  function hideBubble() {
    if (bubbleTimer) {
      clearTimeout(bubbleTimer);
      bubbleTimer = null;
    }
    if (bubbleSwapTimer) {
      clearTimeout(bubbleSwapTimer);
      bubbleSwapTimer = null;
    }
    if (hintFadeTimer) {
      clearTimeout(hintFadeTimer);
      hintFadeTimer = null;
    }
    textBox.style.transition = "";
    textBox.style.opacity = "";
    hintEl.style.transition = "";
    hintEl.style.opacity = "";
    bubbleRandomActive = false;
    bubbleRandomLines = null;
    bubbleShown = false;
    bubbleBox.classList.remove("dshwv-bubble-open");
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function fmt(balance, currency) {
    const num = Number(balance);
    const fixed = isFinite(num) ? num.toFixed(2) : "--";
    return currency === "CNY" ? "¥ " + fixed : fixed + " " + currency;
  }

  function animateAmount(from, to, currency, duration) {
    if (animId) cancelAnimationFrame(animId);
    if (from === null || !isFinite(from)) from = to;
    if (from === to) {
      shown = to;
      amountEl.textContent = fmt(to, currency);
      return;
    }
    let startTime = null;
    function step(ts) {
      if (startTime === null) startTime = ts;
      const t = Math.min(1, (ts - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const val = from + (to - from) * eased;
      amountEl.textContent = fmt(val, currency);
      if (t < 1) animId = requestAnimationFrame(step);
      else {
        animId = null;
        shown = to;
        amountEl.textContent = fmt(to, currency);
      }
    }
    animId = requestAnimationFrame(step);
  }

  function render() {
    let amount, hint;
    if (state.status === "error") {
      amount = shown !== null ? fmt(shown, state.currency) : "--";
      hint = state.message ? state.message.slice(0, 14) : "获取失败 · 点击重试";
    } else if (state.balance === null) {
      amount = shown !== null ? fmt(shown, state.currency) : "…";
      hint = "加载中…";
    } else {
      amount =
        shown !== null
          ? fmt(shown, state.currency)
          : fmt(state.balance, state.currency);
      hint =
        "今日已用 " +
        (state.todayUsage !== null && state.todayUsage !== undefined
          ? fmt(state.todayUsage, state.currency)
          : "--");
    }
    amountEl.textContent = amount;
    if (bubbleRandomActive && bubbleRandomLines)
      applyBubbleLines(bubbleRandomLines);
    else setHint(hint);
  }

  // 更新镜像翻转（左吸附时整体水平翻转）。
  function express() {
    root.classList.toggle("dshwv-left", state.h === "left");
  }

  // 余额刷新。
  function refresh(manual) {
    if (busy) return;
    busy = true;
    if (animDelayTimer) {
      clearTimeout(animDelayTimer);
      animDelayTimer = null;
    }
    if (manual || state.balance === null) {
      state.status = "loading";
      render();
    }

    if (!invoke) {
      busy = false;
      return;
    }
    invoke("get_balance")
      .then(function (data) {
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
          if (changed && !currencyChanged) {
            if (!manual) {
              showBubble();
              state.status = "changing";
              if (animDelayTimer) clearTimeout(animDelayTimer);
              animDelayTimer = setTimeout(function () {
                animDelayTimer = null;
                animateAmount(shown, nb, nc, ANIM_MS);
              }, 300);
              if (settleTimer) clearTimeout(settleTimer);
              settleTimer = setTimeout(function () {
                settleTimer = null;
                if (state.status === "changing") {
                  state.status = "ok";
                  render();
                }
              }, CHANGE_MS + 300);
            } else {
              animateAmount(shown, nb, nc, ANIM_MS);
              state.status = "ok";
              render();
            }
          } else {
            if (animId === null) shown = nb;
            state.status = "ok";
            render();
          }
        } else {
          state.status = "error";
          state.message = data && data.error ? String(data.error) : "获取失败";
          render();
        }
      })
      .catch(function () {
        state.status = "error";
        state.message = "获取失败";
        render();
      })
      .finally(function () {
        busy = false;
      });
  }

  // —— 显示配置 ——
  let soundOn = true;
  let soundVol = 0.9;
  let soundSet = "duck";
  let bubbleColor = "#203170";
  let customSounds = [];
  let dialogueLines = [];
  let dialogueMode = "random";
  let dialogueIntervalMin = 5;
  let dialogueJitter = 0;
  let dialogueIndex = 0;
  let dialogueTimer = null;
  let lastWhaleClickAt = 0;
  const DOUBLE_CLICK_MS = 1500;
  let clickBubbleActive = false;

  function applyScale(v) {
    const next =
      Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(v))) * 10) / 10;
    if (next === state.scale) return;
    state.scale = next;
    // 内容尺寸由 ResizeObserver 跟随窗口实际尺寸，此处只负责触发窗口 resize。
    if (invoke) invoke("resize_widget", { scale: next }).catch(function () {});
  }

  function applyVol(v) {
    const next = Math.round(Math.min(1, Math.max(0, Number(v))) * 100) / 100;
    soundVol = next;
    soundOn = next > 0;
    try {
      if (pressAudio) pressAudio.volume = next;
      if (releaseAudio) releaseAudio.volume = next;
    } catch (err) {}
  }

  function applySoundSetFromConfig(v) {
    if (SOUND_SETS[v]) soundSet = v;
    else if (typeof v === "string" && v)
      soundSet = v; // 自定义音频文件路径（单文件同时用于按下/松开）
    else soundSet = "duck";
    applySoundSet();
  }

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

  function applyWidgetConfig(w) {
    if (!w) return;
    if (
      typeof w.scale === "number" &&
      w.scale >= MIN_SCALE - 0.1 &&
      w.scale <= MAX_SCALE + 0.1
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
      bubbleColor = w.bubbleColor;
      applyBubbleColor(w.bubbleColor);
    }
    if (Array.isArray(w.customSounds)) customSounds = w.customSounds;
    soundOn = w.sound !== false;
  }

  function saveConfig() {
    if (!invoke) return;
    invoke("save_widget_config", {
      widget: {
        scale: state.scale,
        sound: soundOn,
        vol: soundVol,
        soundSet: soundSet,
        bubbleColor: bubbleColor,
        customSounds: customSounds,
      },
    }).catch(function () {});
  }

  const DIALOGUE_SHOW_MS = 4000;

  function applyDialogueConfig(dlg) {
    if (!dlg) return;
    dialogueLines = Array.isArray(dlg.lines) ? dlg.lines.slice() : [];
    dialogueMode =
      dlg.mode === "carousel" || dlg.mode === "random" ? dlg.mode : "random";
    dialogueIntervalMin =
      typeof dlg.intervalMin === "number" && dlg.intervalMin >= 1
        ? dlg.intervalMin
        : 5;
    dialogueJitter =
      typeof dlg.jitter === "number" ? clamp(dlg.jitter, 0, 100) : 0;
    dialogueIndex = 0;
    scheduleNextDialogue();
  }

  function nextDialogueDelayMs() {
    const base = dialogueIntervalMin * 60000;
    const jitterFrac = (dialogueJitter / 100) * 0.8;
    const min = base * (1 - jitterFrac);
    const delay = min + Math.random() * (base - min);
    return Math.round(delay);
  }

  function pickDialogueLine() {
    if (!dialogueLines.length) return null;
    if (dialogueMode === "random") {
      return dialogueLines[Math.floor(Math.random() * dialogueLines.length)];
    }
    const line = dialogueLines[dialogueIndex % dialogueLines.length];
    dialogueIndex = (dialogueIndex + 1) % dialogueLines.length;
    return line;
  }

  function pauseDialogue() {
    if (dialogueTimer) {
      clearTimeout(dialogueTimer);
      dialogueTimer = null;
    }
  }

  function showDialogueLine(line) {
    clickBubbleActive = false;
    const lines = singleCenter("A", line, "", true);
    bubbleRandomActive = true;
    bubbleRandomLines = lines;
    if (bubbleShown) {
      swapBubbleContent(function () {
        applyBubbleLines(lines);
      });
    } else {
      bubbleShown = true;
      bubbleBox.classList.add("dshwv-bubble-open");
      applyBubbleLines(lines);
    }
    if (bubbleTimer) {
      clearTimeout(bubbleTimer);
      bubbleTimer = null;
    }
    bubbleTimer = setTimeout(hideBubble, DIALOGUE_SHOW_MS);
  }

  function scheduleNextDialogue() {
    if (dialogueTimer) {
      clearTimeout(dialogueTimer);
      dialogueTimer = null;
    }
    if (!dialogueLines.length) return;
    const delay = nextDialogueDelayMs();
    dialogueTimer = setTimeout(function () {
      dialogueTimer = null;
      if (
        clickBubbleActive ||
        bubbleShown ||
        pressing ||
        (drag && drag.active)
      ) {
        scheduleNextDialogue();
        return;
      }
      const line = pickDialogueLine();
      if (line) showDialogueLine(line);
      scheduleNextDialogue();
    }, delay);
  }

  function beijingHour() {
    const now = new Date();
    return (now.getUTCHours() + 8) % 24;
  }

  function isPeakTime() {
    const h = beijingHour();
    return (h >= 9 && h < 12) || (h >= 14 && h < 18);
  }

  function showTimeBubble() {
    const peak = isPeakTime();
    const lines = [
      { t: "当前时间", s: "A", c: "" },
      {
        t: peak ? "高峰时间" : "空闲时间",
        s: "P",
        c: peak ? "#e0433f" : "#2fa24c",
      },
      null,
    ];
    clickBubbleActive = true;
    pauseDialogue();
    bubbleRandomActive = true;
    bubbleRandomLines = lines;
    bubbleShown = true;
    bubbleBox.classList.add("dshwv-bubble-open");
    applyBubbleLines(lines);
    if (bubbleTimer) {
      clearTimeout(bubbleTimer);
      bubbleTimer = null;
    }
    bubbleTimer = setTimeout(hideBubble, BUBBLE_MS);
  }

  // —— 表情状态机 ——
  function setIcon(src) {
    img.src = src;
  }

  function clearMoodTimers() {
    if (moodTimer) {
      clearTimeout(moodTimer);
      moodTimer = null;
    }
    if (lonelyCarouselTimer) {
      clearInterval(lonelyCarouselTimer);
      lonelyCarouselTimer = null;
    }
  }

  function clearHoverTimer() {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    isHovering = false;
  }

  function resetIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (mood === "disappointed") return;
    idleTimer = setTimeout(function () {
      idleTimer = null;
      enterDisappointed();
    }, IDLE_TO_DISAPPOINTED_MS);
  }

  function showMoodBubble(text) {
    showDialogueLine(text);
  }

  function enterAngry() {
    mood = "angry";
    clearHoverTimer();
    clearMoodTimers();
    pauseDialogue();
    setIcon(IMG_ANGRY);
    showMoodBubble("你再摸人家就生气了喵 (╬ Ò﹏Ó)");
    moodTimer = setTimeout(function () {
      moodTimer = null;
      exitAngry();
    }, ANGRY_DURATION_MS);
    clickLog = [];
  }

  function exitAngry() {
    if (mood !== "angry") return;
    mood = "normal";
    setIcon(IMG_URL);
    scheduleNextDialogue();
    resetIdle();
  }

  function enterDisappointed() {
    if (mood === "disappointed") return;
    mood = "disappointed";
    clearHoverTimer();
    clearMoodTimers();
    pauseDialogue();
    setIcon(IMG_DISAPPOINTED);
    showMoodBubble("鲸鲸没人要了喵 (╥﹏╥)");
    lonelyCarouselTimer = setInterval(function () {
      const line =
        LONELY_LINES[Math.floor(Math.random() * LONELY_LINES.length)];
      showMoodBubble(line);
    }, LONELY_CAROUSEL_MS);
    clickLog = [];
  }

  function exitDisappointed() {
    if (mood !== "disappointed") return;
    mood = "normal";
    clearMoodTimers();
    setIcon(IMG_URL_PRESS);
    showMoodBubble("你终于想起本鲸了喵 (=￣ω￣=)");
    scheduleNextDialogue();
    resetIdle();
    moodTimer = setTimeout(function () {
      moodTimer = null;
      if (mood === "normal") setIcon(IMG_URL);
    }, DISAPPOINTED_RELEASE_MS);
  }

  function enterShy() {
    if (mood !== "normal") return;
    mood = "shy";
    clearHoverTimer();
    clearMoodTimers();
    pauseDialogue();
    setIcon(IMG_SHY);
    showMoodBubble("主人摸本鲸头了喵 (≧◡≦)♡");
    moodTimer = setTimeout(function () {
      moodTimer = null;
      exitShy(false);
    }, SHY_DURATION_MS);
  }

  function exitShy(interrupted) {
    if (mood !== "shy") return;
    mood = "normal";
    clearMoodTimers();
    setIcon(interrupted ? IMG_URL_PRESS : IMG_URL);
    scheduleNextDialogue();
    resetIdle();
  }

  function handleWhaleClick() {
    const now = Date.now();
    resetIdle();

    // 高频连点检测：连续 ≥12 次且相邻间隔 ≤0.5s。
    if (
      clickLog.length &&
      now - clickLog[clickLog.length - 1] > HIGH_FREQ_GAP_MS
    ) {
      clickLog = [];
    }
    clickLog.push(now);
    while (clickLog.length && now - clickLog[0] > HIGH_FREQ_WINDOW_MS) {
      clickLog.shift();
    }
    if (
      clickLog.length >= HIGH_FREQ_WARN_COUNT &&
      clickLog.length < HIGH_FREQ_COUNT
    ) {
      showMoodBubble("你再摸人家就生气了喵 (╬ Ò﹏Ó)");
      return;
    }
    if (clickLog.length >= HIGH_FREQ_COUNT) {
      clickLog = [];
      enterAngry();
      return;
    }

    if (now - lastWhaleClickAt <= DOUBLE_CLICK_MS) {
      lastWhaleClickAt = 0;
      showTimeBubble();
    } else {
      showBubble();
      refresh(true);
      lastWhaleClickAt = now;
    }
  }

  // —— 音效 ——
  const SQUISH = "scaleY(0.88) scaleX(1.05)";
  let pressAudio = null;
  let releaseAudio = null;
  let pressing = false;
  let pressEnded = false;
  let releasePlayed = false;
  let releaseTimer = null;
  let singleFileSound = false;

  const PRESET_SRCS = [];
  for (const k in SOUND_SETS) {
    PRESET_SRCS.push(SOUND_SETS[k].press, SOUND_SETS[k].release);
  }

  function toAudioSrc(p) {
    if (!p) return p;
    if (/^(https?:|data:)/i.test(p)) return p;
    if (PRESET_SRCS.indexOf(p) !== -1) return p;
    const convertFileSrc =
      window.__TAURI__ && window.__TAURI__.core
        ? window.__TAURI__.core.convertFileSrc
        : null;
    if (convertFileSrc) {
      try {
        return convertFileSrc(p);
      } catch (err) {}
    }
    return p;
  }

  function loadCustomAudio(path, audio) {
    if (invoke) {
      invoke("read_audio_file", { path: path })
        .then(function (dataUrl) {
          if (dataUrl) audio.src = dataUrl;
        })
        .catch(function () {
          audio.src = toAudioSrc(path);
        });
    } else {
      audio.src = toAudioSrc(path);
    }
  }

  function applySoundSet() {
    try {
      const preset = SOUND_SETS[soundSet];
      if (preset) {
        singleFileSound = false;
        pressAudio = new Audio(toAudioSrc(preset.press));
        releaseAudio = new Audio(toAudioSrc(preset.release));
        pressAudio.preload = "auto";
        pressAudio.volume = soundVol;
        releaseAudio.preload = "auto";
        releaseAudio.volume = soundVol;
      } else if (typeof soundSet === "string" && soundSet) {
        // 自定义单文件：仅按下播放一次，无松开音效。
        singleFileSound = true;
        releaseAudio = null;
        pressAudio = new Audio();
        pressAudio.preload = "auto";
        pressAudio.volume = soundVol;
        loadCustomAudio(soundSet, pressAudio);
      } else {
        singleFileSound = false;
        pressAudio = null;
        releaseAudio = null;
      }
    } catch (err) {}
  }

  function playPress() {
    if (!pressAudio || !soundOn) return;
    try {
      if (releaseTimer) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
      }
      if (releaseAudio) {
        releaseAudio.pause();
        releaseAudio.currentTime = 0;
      }
      pressEnded = false;
      releasePlayed = false;
      pressAudio.onended = function () {
        pressEnded = true;
        if (!singleFileSound && !pressing && !releasePlayed) playRelease();
      };
      pressAudio.currentTime = 0;
      const p = pressAudio.play();
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch (err) {}
  }

  function playRelease() {
    if (releasePlayed || !releaseAudio || !soundOn) return;
    releasePlayed = true;
    try {
      releaseAudio.currentTime = 0;
      const p = releaseAudio.play();
      if (p && typeof p.catch === "function") p.catch(function () {});
    } catch (err) {}
  }

  function pressDown() {
    body.style.transform = SQUISH;
    pressing = true;
    img.src = IMG_URL_PRESS;
    playPress();
  }
  function pressUp() {
    body.style.transform = "scaleY(1) scaleX(1)";
    pressing = false;
    img.src = IMG_URL;
    if (singleFileSound) return;
    if (pressEnded) {
      playRelease();
      return;
    }
    let durKnown = false;
    let remainMs = 0;
    try {
      const dur = pressAudio ? pressAudio.duration : 0;
      if (isFinite(dur) && dur > 0) {
        durKnown = true;
        remainMs = (dur - pressAudio.currentTime) * 1000;
      }
    } catch (err) {}
    if (durKnown) {
      releaseTimer = setTimeout(
        function () {
          releaseTimer = null;
          playRelease();
        },
        Math.max(0, remainMs - 100),
      );
    }
  }

  // —— 命中测试（仅鲸鱼不透明像素可拖拽/点击） ——
  let hitCanvas = null;
  let hitReady = false;
  function setupHitTest() {
    try {
      hitCanvas = document.createElement("canvas");
      hitCanvas.width = 610;
      hitCanvas.height = 610;
      const probe = new Image();
      probe.onload = function () {
        try {
          hitCanvas.getContext("2d").drawImage(probe, 0, 0);
          hitReady = true;
        } catch (err) {}
      };
      probe.onerror = function () {};
      probe.src = IMG_URL;
    } catch (err) {}
  }
  function isWhaleHit(e) {
    if (!hitCanvas || !hitReady) return true;
    try {
      const r = img.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      let lx = ((e.clientX - r.left) / r.width) * 610;
      let ly = ((e.clientY - r.top) / r.height) * 610;
      if (lx < 0 || ly < 0 || lx >= 610 || ly >= 610) return false;
      if (state.h === "left") lx = 610 - lx;
      const data = hitCanvas
        .getContext("2d")
        .getImageData(Math.floor(lx), Math.floor(ly), 1, 1).data;
      return data[3] > 10;
    } catch (err) {
      return true;
    }
  }

  // —— 拖拽/吸附 ——
  function onDocPointerDown(e) {
    if (e.target && e.target.closest) {
      if (e.target.closest(".dshwv-bubble")) return;
    }
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (!isWhaleHit(e)) return;
    try {
      e.preventDefault();
      e.stopPropagation();
    } catch (err) {}

    resetIdle();
    clearHoverTimer();

    drag = {
      active: true,
      startSX: e.screenX,
      startSY: e.screenY,
      grabDX: e.screenX - window.screenX,
      grabDY: e.screenY - window.screenY,
      moved: false,
    };
    root.classList.add("dshwv-dragging");

    if (mood === "disappointed") {
      // 失落状态：不改变图标、不播放音效，仅记录按压用于后续判断点击。
    } else if (mood === "angry") {
      body.style.transform = SQUISH;
    } else {
      if (mood === "shy") {
        mood = "normal";
        clearMoodTimers();
        scheduleNextDialogue();
      }
      pressDown();
    }

    document.addEventListener("pointermove", onDocPointerMove, true);
    document.addEventListener("pointerup", onDocPointerUp, true);
    document.addEventListener("pointercancel", onDocPointerCancel, true);
    document.addEventListener("click", onDocClickStopper, true);
  }

  function onDocPointerMove(e) {
    if (!drag || !drag.active) return;
    const dx = e.screenX - drag.startSX;
    const dy = e.screenY - drag.startSY;
    if (dx * dx + dy * dy >= CLICK_SQ) drag.moved = true;
    if (drag.moved && invoke && mood !== "disappointed" && mood !== "angry") {
      invoke("set_window_position", {
        x: e.screenX - drag.grabDX,
        y: e.screenY - drag.grabDY,
      }).catch(function () {});
    }
  }

  function onDocPointerUp(e) {
    endDrag(true);
  }
  function onDocPointerCancel() {
    endDrag(false);
  }
  function onDocClickStopper(e) {
    try {
      e.preventDefault();
      e.stopPropagation();
    } catch (err) {}
  }
  document.addEventListener("pointerdown", onDocPointerDown, true);

  function endDrag(clickAllowed) {
    if (!drag || !drag.active) return;
    drag.active = false;
    document.removeEventListener("pointermove", onDocPointerMove, true);
    document.removeEventListener("pointerup", onDocPointerUp, true);
    document.removeEventListener("pointercancel", onDocPointerCancel, true);
    document.removeEventListener("click", onDocClickStopper, true);
    root.classList.remove("dshwv-dragging");

    if (mood === "disappointed") {
      if (clickAllowed && !drag.moved) exitDisappointed();
      return;
    }

    if (mood === "angry") {
      if (clickAllowed && !drag.moved)
        showMoodBubble("再也不理你了喵 (｀へ´*)");
      body.style.transform = "scaleY(1) scaleX(1)";
      return;
    }

    pressUp();
    if (clickAllowed && !drag.moved) {
      handleWhaleClick();
      return;
    }
    if (drag.moved && invoke) {
      invoke("snap_window")
        .then(function (snap) {
          if (snap.h === "left") state.h = "left";
          else if (snap.h === "right") state.h = "right";
          else state.h = "none";
          if (snap.v === "top") state.v = "top";
          else if (snap.v === "bottom") state.v = "bottom";
          else state.v = "none";
          express();
        })
        .catch(function () {});
    }
  }

  // —— 光标提示 ——
  document.addEventListener(
    "pointermove",
    function (e) {
      if (drag && drag.active) return;
      let el = null;
      try {
        el = document.elementFromPoint(e.clientX, e.clientY);
      } catch (err) {}
      if (el && el.closest && el.closest(".dshwv-bubble")) {
        document.body.style.cursor = "";
        return;
      }
      const over = isWhaleHit(e);
      document.body.style.cursor = over ? "grab" : "";

      // 悬浮触发害羞：仅默认活跃状态、鼠标悬停在鲸鱼上且未按压时计时。
      if (mood === "normal" && over && !pressing) {
        resetIdle();
        if (!isHovering) {
          isHovering = true;
          hoverTimer = setTimeout(function () {
            hoverTimer = null;
            if (mood === "normal" && isHovering && !pressing) {
              enterShy();
            }
          }, HOVER_TO_SHY_MS);
        }
      } else if (isHovering) {
        clearHoverTimer();
      }
    },
    true,
  );

  // —— 初始化 ——
  // 窗口驱动缩放：--dshw-base 跟随窗口实际尺寸，避免手动回流与异步 resize 错位导致的闪屏抖动。
  function syncBaseFromWindow() {
    root.style.setProperty("--dshw-base", (window.innerWidth || 375) + "px");
  }
  if (typeof ResizeObserver !== "undefined") {
    const baseObserver = new ResizeObserver(syncBaseFromWindow);
    baseObserver.observe(document.body);
  } else {
    window.addEventListener("resize", syncBaseFromWindow);
  }
  syncBaseFromWindow();
  express();
  render();
  applySoundSet();
  setupHitTest();
  resetIdle();

  // 读取挂件显示配置（尺寸/音效/音量/用量模式）。
  if (invoke) {
    invoke("get_config")
      .then(function (cfg) {
        const w = cfg && cfg.widget ? cfg.widget : null;
        if (w) {
          applyWidgetConfig(w);
        }
        if (cfg && cfg.dialogue) applyDialogueConfig(cfg.dialogue);
        refresh(false);
      })
      .catch(function () {
        refresh(false);
      });
  }

  // 监听来自配置窗口的显示设置变更并实时应用。
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen("widget-config-changed", function (e) {
      applyWidgetConfig(e.payload);
    });
  }

  // 监听台词配置变更并实时应用。
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen("dialogue-changed", function (e) {
      applyDialogueConfig(e.payload);
    });
  }

  // —— Ctrl+滚轮快捷缩放（鼠标悬浮鲸鱼本体时） ——
  document.addEventListener(
    "wheel",
    function (e) {
      if (!e.ctrlKey) return;
      if (!isWhaleHit(e)) return;
      try {
        e.preventDefault();
      } catch (err) {}
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      const next =
        Math.round(
          Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale + delta)) * 10,
        ) / 10;
      if (next === state.scale) return;
      applyScale(next);
      saveConfig();
    },
    { passive: false },
  );

  // 全局禁用浏览器默认右键菜单。
  document.addEventListener("contextmenu", function (e) {
    e.preventDefault();
  });

  setInterval(function () {
    refresh(false);
  }, REFRESH_MS);
})();

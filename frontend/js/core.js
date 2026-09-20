// 小鲸鱼余额挂件 · 核心模块
//
// 负责：
// - 全局命名空间 window.DSW 的初始化与一次性执行守卫（DSW.__init）
// - Tauri IPC 封装（DSW.invoke）
// - 全局常量（DSW.C）
// - 共享状态（DSW.state）与共享标记（DSW.flags）
//
// 本文件为其余所有模块的基础，必须最先加载。

window.DSW = window.DSW || {};

(function (DSW) {
  "use strict";

  // 一次性执行守卫：防止脚本被重复引入时二次初始化。
  if (DSW.__init) return;
  DSW.__init = true;

  // —— 全局异常兜底 ——
  // 挂件窗口没有提示组件（气泡里不能塞错误信息），因此只记录日志：
  // 目的是让任何一处未捕获的异常都不会打断表情 / 气泡 / 拖拽的渲染循环。
  window.addEventListener("error", function (e) {
    console.error("[挂件] 未捕获异常", (e && (e.error || e.message)) || e);
  });
  window.addEventListener("unhandledrejection", function (e) {
    console.error("[挂件] 未处理的 Promise 异常", e && e.reason);
  });

  // Tauri IPC 入口（withGlobalTauri 注入的全局 API）。
  DSW.invoke =
    window.__TAURI__ && window.__TAURI__.core
      ? window.__TAURI__.core.invoke
      : null;

  // 共享音频引擎（audio-engine.js，提供上下文预热 / 解码缓存 / 终止播放）。
  DSW.audioEngine = window.DSWAudio || null;

  // —— 常量 ——
  DSW.C = {
    MIN_SCALE: 0.6,
    MAX_SCALE: 2.5,
    REFRESH_MS: 60000,
    CHANGE_MS: 900,
    ANIM_MS: 700,
    BUBBLE_MS: 5000,
    CLICK_SQ: 9, // 位移平方阈值：> 3px 判定为拖动

    IMG_URL: "../assets/images/main.png",
    IMG_URL_PRESS: "../assets/images/stroking.png",
    IMG_ANGRY: "../assets/images/angry.png",
    IMG_DISAPPOINTED: "../assets/images/disappointed.png",
    IMG_SHY: "../assets/images/shy.png",
    IMG_EXHAUSTED: "../assets/images/exhausted.png",
    IMG_HALF_CLOSED_EYES: "../assets/images/half_closed_eyes.png",
    IMG_CLOSE_EYES: "../assets/images/close_eyes.png",
    IMG_HALF_OPEN_EYES: "../assets/images/half_open_eyes.png",

    SOUND_SETS: {
      duck: {
        press: "../assets/audio/duck-press.mp3",
        release: "../assets/audio/duck-release.mp3",
      },
      dingdong: {
        press: "../assets/audio/dingdong-press.mp3",
        release: "../assets/audio/dingdong-release.mp3",
      },
    },

    // —— 表情状态机常量 ——
    // 注意：失望 / 生气 / 害羞三个阈值已改为配置项（配置页「挂件状态」），
    // 这里只保留不可配置的时长与判定窗口。默认值见 flags 的 disappointedThresholdMin /
    // angryThresholdClicks / shyThresholdSec。
    ANGRY_DURATION_MS: 5000,
    SHY_DURATION_MS: 10000,
    LONELY_CAROUSEL_MS: 30000,
    HIGH_FREQ_WINDOW_MS: 10000,
    HIGH_FREQ_GAP_MS: 500,
    HIGH_FREQ_WARN_COUNT: 5,
    DISAPPOINTED_RELEASE_MS: 300,

    DOUBLE_CLICK_MS: 1500,
    DIALOGUE_SHOW_MS: 4000,
    BLINK_HALF_CLOSED_MS: 70,
    BLINK_CLOSE_MS: 150,
    BLINK_HALF_OPEN_MS: 70,
    EXHAUSTED_PROMPT_INTERVAL_MS: 10000,

    SQUISH: "scaleY(0.88) scaleX(1.05)",
  };

  // —— 共享状态 ——
  // 记录可序列化的显示/业务状态，供多个模块直接复用。
  DSW.state = {
    scale: 1.5,
    h: "right",
    // 垂直锚点：`top` 贴窗口上沿（为上方的气泡预留空间），`bottom` / `none` 都贴窗口下沿。
    // 初值取 `none`，与配置里的默认值同一套取值，避免两种写法指同一状态。
    v: "none",
    balance: null,
    currency: null,
    todayUsage: null,
    displayCurrency: "CNY",
    rate: 1,
    isPeak: false,
    // 当前余额数据源是否支持峰谷计价（目前仅 DeepSeek）。
    // 未拿到数据前保持 true，以维持既有表现；拿到载荷后以数据为准。
    peakSupported: true,
    status: "loading",
    message: "",
    // 余额数据源刚刚切换：上一个供应商的余额与今日已用已作废，正在等新数据源的
    // 首个结果。渲染层据此显示「--」，而不是把上一个供应商的数字留在气泡上。
    awaitingSource: false,
  };

  // —— 共享标记（含各 timer 句柄与运行时开关） ——
  // 记录运行时临时状态，避免模块之间各自维护重复 timer/flag。
  DSW.flags = {
    // 刷新/动画
    busy: false,
    pendingBalanceRefresh: false,
    settleTimer: null,
    animDelayTimer: null,
    shown: null,
    animId: null,
    // 余额取数序号：每次请求自增；切换余额数据源时也自增，
    // 使切换前发出的在途响应全部作废（见 balance.js 的 refresh / invalidateBalance）。
    balanceSeq: 0,

    // 气泡
    bubbleShown: false,
    bubbleTimer: null,
    bubbleRandomActive: false,
    bubbleRandomLines: null,

    // 峰谷时段倒计时（每秒刷新）
    periodTimer: null,

    // 表情状态机
    mood: "normal", // 'normal' | 'angry' | 'disappointed' | 'shy' | 'exhausted'
    idleTimer: null,
    hoverTimer: null,
    moodTimer: null,
    lonelyCarouselTimer: null,
    clickLog: [],
    isHovering: false,
    blinkTimer: null,
    blinkFrameTimer: null,
    blinking: false,
    blinkIntervalMinSec: 4,
    blinkIntervalMaxSec: 6,
    exhaustedModeEnabled: true,
    exhaustedBalanceThreshold: 5,
    exhaustedMode: false,
    exhaustedPromptTimer: null,
    exhaustedPromptIndex: 0,

    // 表情阈值（配置页「挂件状态」可自定义；默认值 3 分钟 / 18 次 / 2 秒）
    disappointedThresholdMin: 3,
    angryThresholdClicks: 18,
    shyThresholdSec: 2,

    // 拖拽
    drag: null,

    // 显示配置
    soundOn: true,
    soundVol: 0.9,
    soundSet: "duck",
    bubbleColor: "#203170",
    dialogueLines: [],
    dialogueMode: "random",
    dialogueIntervalMin: 5,
    dialogueJitter: 0,
    dialogueIndex: 0,
    dialogueTimer: null,
    lastWhaleClickAt: 0,
    whaleClickStep: 0,
    clickBubbleActive: false,

    // 峰谷提示
    peakWarnEnabled: true,
    peakWarnMinutes: 9,
    snapDistance: 0,
    peakWarnTimer: null,
    peakWarnShown: {},

    // 音效（当前音效组与播放状态由 audio.js 内部维护）
    pressing: false,

    // 鼠标穿透
    clickThrough: null,

    // 挂件本体（图片组名）；「小鲸鱼」为内置默认资源。
    widgetBody: "小鲸鱼",
  };

  // 挂件图片解析：内置默认组直接用静态资源，自定义组只从「本组文件夹」取图。
  //
  // 状态机隔离规则（阻断跨组非法状态流转）：
  // 1. 先读取当前本体的状态资源清单，只有清单内存在的状态才会被加载；
  // 2. 非 main 状态缺失时，一律回退到「本组 main」，绝不使用其他挂件组或内置素材；
  // 3. 默认组之外的资源永远带本组前缀缓存，切换本体时代际号作废所有在途请求。
  DSW.images = (function () {
    var C = DSW.C;
    var DEFAULT_BODY = "小鲸鱼";
    var STATE_BY_SRC = {};
    STATE_BY_SRC[C.IMG_URL] = "main";
    STATE_BY_SRC[C.IMG_URL_PRESS] = "stroking";
    STATE_BY_SRC[C.IMG_ANGRY] = "angry";
    STATE_BY_SRC[C.IMG_DISAPPOINTED] = "disappointed";
    STATE_BY_SRC[C.IMG_SHY] = "shy";
    STATE_BY_SRC[C.IMG_EXHAUSTED] = "exhausted";
    STATE_BY_SRC[C.IMG_HALF_CLOSED_EYES] = "half_closed_eyes";
    STATE_BY_SRC[C.IMG_CLOSE_EYES] = "close_eyes";
    STATE_BY_SRC[C.IMG_HALF_OPEN_EYES] = "half_open_eyes";

    var cache = {}; // "body:state" -> dataUrl
    var manifests = {}; // body -> { loading, waiters, states }
    // 资源代际：切换挂件本体或图片更新时自增，用于作废旧请求。
    var generation = 0;

    // 当前挂件本体（图片组名）。
    function currentBody() {
      return DSW.flags.widgetBody || DEFAULT_BODY;
    }

    function isCustomBody(body) {
      return body !== DEFAULT_BODY;
    }

    function manifestOf(body) {
      if (!manifests[body]) {
        manifests[body] = { loading: false, waiters: [], states: null };
      }
      return manifests[body];
    }

    // 读取（或复用）指定本体的状态资源清单；就绪后回调。
    function ensureManifest(body, cb) {
      var m = manifestOf(body);
      if (m.states) {
        cb(m);
        return;
      }
      m.waiters.push(cb);
      if (m.loading) return;
      m.loading = true;
      DSW.invoke("widget_group_states", { group: body })
        .then(function (list) {
          var map = {};
          (list || []).forEach(function (s) {
            map[s] = true;
          });
          m.states = map;
          prefetchMain(body);
        })
        .catch(function (err) {
          console.error("读取挂件状态清单失败：", body, err);
          m.states = {};
        })
        .then(function () {
          m.loading = false;
          var waiters = m.waiters;
          m.waiters = [];
          // 期间若已被 invalidate 作废，等到的调用方会走全新清单重新决策。
          waiters.forEach(function (fn) {
            fn(m);
          });
          if (typeof DSW.images.onBodyReady === "function") {
            DSW.images.onBodyReady(body);
          }
        });
    }

    // 预取本组 main：缺失状态回退 main 时可同步命中缓存，避免切换闪烁。
    function prefetchMain(body) {
      var key = body + ":main";
      if (cache[key]) return;
      var gen = generation;
      DSW.invoke("read_widget_image", { group: body, state: "main" })
        .then(function (dataUrl) {
          if (dataUrl && gen === generation) cache[key] = dataUrl;
        })
        .catch(function () {});
    }

    // 从本组加载指定状态；失败时若目标非 main 则回退本组 main。
    function loadState(body, state, src, cb) {
      var key = body + ":" + state;
      if (cache[key]) {
        cb(cache[key]);
        return;
      }
      var gen = generation;
      DSW.invoke("read_widget_image", { group: body, state: state })
        .then(function (dataUrl) {
          if (!dataUrl) throw new Error("自定义图片数据为空");
          // 等待期间已切换本体或刷新缓存：丢弃过期结果，禁止跨组串图。
          if (gen !== generation || currentBody() !== body) return;
          cache[key] = dataUrl;
          cb(dataUrl);
        })
        .catch(function (err) {
          if (gen !== generation || currentBody() !== body) return;
          console.error("加载自定义挂件图片失败：", body, state, err);
          if (state !== "main") {
            loadState(body, "main", src, cb);
            return;
          }
          // 连本组 main 都不可读（目录被外部破坏）：退回内置素材并记录。
          console.error("挂件组无可用资源，回退内置素材：", body);
          cb(src);
        });
    }

    function resolve(src, cb) {
      var body = currentBody();
      if (!isCustomBody(body) || !DSW.invoke) {
        cb(src);
        return;
      }
      var state = STATE_BY_SRC[src];
      if (!state) {
        cb(src);
        return;
      }
      ensureManifest(body, function (m) {
        // 清单等待期间本体可能已切换，此处必须重新校验。
        if (currentBody() !== body || !isCustomBody(body)) {
          cb(src);
          return;
        }
        var map = m.states || {};
        if (!map.main) {
          // 异常目录（无任何状态资源）：退回内置素材，避免挂件空白。
          console.error("挂件组缺少 main.png，回退内置素材：", body);
          cb(src);
          return;
        }
        // 状态图不存在时立即改用本组 main，决策同步完成，不产生错误帧。
        var target = map[state] ? state : "main";
        loadState(body, target, src, cb);
      });
    }

    // 当前本体是否具备某个状态资源（内置素材九态齐全）。
    function hasState(state) {
      var body = currentBody();
      if (!isCustomBody(body) || !DSW.invoke) return true;
      var m = manifests[body];
      if (!m || !m.states) return false;
      return !!m.states[state];
    }

    function hasAnyState(states) {
      for (var i = 0; i < states.length; i++) {
        if (hasState(states[i])) return true;
      }
      return false;
    }

    // 作废当前缓存、清单与所有在途请求（切换本体或图片更新后调用）。
    function invalidate() {
      generation += 1;
      cache = {};
      manifests = {};
    }

    return {
      resolve: resolve,
      invalidate: invalidate,
      currentBody: currentBody,
      hasState: hasState,
      hasAnyState: hasAnyState,
      onBodyReady: null,
    };
  })();
})(window.DSW);

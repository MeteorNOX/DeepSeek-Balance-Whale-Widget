// 小鲸鱼余额挂件 · 配置窗口脚本
//
// 负责配置页的加载、表单回填、静默保存，以及与挂件窗口的实时同步。
// 重点覆盖：
// - 模型配置与供应商切换
// - 挂件显示设置与自定义音效
// - 台词列表编辑与调度参数
// - 余额展示、更新检查与弹窗交互

(function () {
  const invoke =
    window.__TAURI__ && window.__TAURI__.core
      ? window.__TAURI__.core.invoke
      : null;
  if (!invoke) return;

  // ===== 全局统一提示体系 =====
  //
  // 严格映射：success → 绿色、warn → 黄色、exception/error → 红色。
  // 全站只有一种呈现：右上角自动消失的轻提示（不打断操作、位置与配色完全统一）。
  // 需要用户决策的场景（确认 / 下载确认）仍用居中弹窗，但它们不属于「提示」。
  // - notify()：轻提示本体；
  // - callApi()：invoke 的统一入口，把「系统返回值」自动映射成对应颜色的提示。
  const toastStackEl = document.getElementById("toastStack");

  const SEVERITY = {
    success: { toast: "toast-success", ms: 2400 },
    warn: { toast: "toast-warn", ms: 3200 },
    // 错误详情往往较长（后端原文），停留时间相应加长，避免来不及读完。
    error: { toast: "toast-error", ms: 6000 },
  };

  // 进度提示的显示阈值：调用耗时超过该值才弹黄色进度提示（避免瞬时操作闪现）。
  const BUSY_TOAST_DELAY_MS = 350;

  const TOAST_ICONS = {
    success:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.2 12 13 4.5"/></svg>',
    warn: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2 14.6 13.4H1.4L8 2.2Z"/><path d="M8 6.4v3.2"/><path d="M8 11.8v.01"/></svg>',
    error:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M5.8 5.8 10.2 10.2M10.2 5.8 5.8 10.2"/></svg>',
  };

  // 系统返回值 → severity 的严格映射（大小写不敏感）。
  function severityOf(value) {
    const v = String(value == null ? "" : value)
      .trim()
      .toLowerCase();
    if (v === "success" || v === "ok" || v === "succeeded" || v === "done")
      return "success";
    if (v === "warn" || v === "warning" || v === "alert") return "warn";
    if (
      v === "exception" ||
      v === "error" ||
      v === "fail" ||
      v === "failed" ||
      v === "failure"
    )
      return "error";
    return null;
  }

  // 错误对象 → 可读文案。
  function errText(err) {
    if (err == null) return "未知错误";
    if (typeof err === "string") return err;
    if (err.message) return String(err.message);
    return String(err);
  }

  // 轻提示：右上角堆叠、自动消失；severity 非法时一律按 error 处理。
  function notify(level, message, options) {
    const key = severityOf(level) || "error";
    const conf = SEVERITY[key];
    const opts = options || {};
    const node = document.createElement("div");
    node.className = "toast " + conf.toast;
    node.setAttribute("role", key === "error" ? "alert" : "status");

    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.innerHTML = TOAST_ICONS[key];

    const body = document.createElement("div");
    body.className = "toast-body";
    body.textContent = String(message);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast-close";
    close.setAttribute("aria-label", "关闭提示");
    close.textContent = "×";
    close.addEventListener("click", function () {
      removeToast(node);
    });

    node.appendChild(icon);
    node.appendChild(body);
    node.appendChild(close);
    toastStackEl.appendChild(node);

    const ms = typeof opts.duration === "number" ? opts.duration : conf.ms;
    if (ms > 0)
      setTimeout(function () {
        removeToast(node);
      }, ms);
    return node;
  }

  // 轻提示退场：先锁定当前高度再收敛到 0，让高度过渡从真实高度出发
  // （否则 max-height 从默认值下降的前半段没有可见变化，会出现「先卡住、后突降」）。
  function removeToast(node) {
    if (!node || !node.parentNode || node.classList.contains("toast-out"))
      return;
    node.style.maxHeight = node.offsetHeight + "px";
    void node.offsetHeight;
    node.classList.add("toast-out");
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 320);
  }

  // invoke 的统一入口：把系统返回值严格映射成对应颜色的提示。
  // - opts.busy：传文案 → 调用期间弹黄色进度轻提示（上传 / 处理中）；
  // - opts.success：传文案 → 成功弹绿色轻提示；不传则成功静默（防抖自动保存）；
  // - opts.errorPrefix：红色错误轻提示的文案前缀；
  // - opts.silent：true 时失败不提示（仅用于后台轮询，错误已在界面内联展示）。
  function callApi(cmd, args, opts) {
    const o = opts || {};
    // 进度提示只在「确实耗时」时才出现：超过 350ms 仍未完成才弹黄灯，
    // 避免瞬时操作闪现一下黄灯；调用一结束立即收起，不与成功/失败提示叠放。
    let busyToast = null;
    const busyTimer = o.busy
      ? setTimeout(function () {
          busyToast = notify("warn", o.busy);
        }, BUSY_TOAST_DELAY_MS)
      : null;
    const finishBusy = function () {
      if (busyTimer) clearTimeout(busyTimer);
      if (busyToast) removeToast(busyToast);
      busyToast = null;
    };
    return invoke(cmd, args).then(
      function (result) {
        finishBusy();
        if (o.success) notify("success", o.success);
        return result;
      },
      function (err) {
        finishBusy();
        console.error("[callApi] " + cmd + " 失败：", err);
        if (!o.silent) {
          const detail = errText(err);
          notify(
            "error",
            o.errorPrefix ? o.errorPrefix + "：" + detail : detail,
          );
        }
        throw err;
      },
    );
  }

  document.addEventListener("contextmenu", function (e) {
    e.preventDefault();
  });

  // —— 全局异常兜底 ——
  //
  // 配置页串联了上传、拖拽、图表、抠图等大量异步链路，任一处未捕获的异常都会
  // 表现为「按钮点了没反应」。这里统一兜底：记录到控制台 + 一条红色轻提示，
  // 绝不让异常冒泡到窗口层面（窗口级报错会中断整页脚本）。
  // 同一时间只提示一次：异常风暴时提示本身不该成为新的负担。
  let lastFatalAt = 0;
  function reportFatal(kind, detail) {
    try {
      console.error("[全局] " + kind, detail);
    } catch (err) {
      /* 记录失败也不能再抛 */
    }
    if (Date.now() - lastFatalAt < 1200) return;
    lastFatalAt = Date.now();
    try {
      notify("error", "出现未预期的错误，已记录到控制台，可继续操作");
    } catch (err) {
      /* 提示失败时保持静默 */
    }
  }
  window.addEventListener("error", function (e) {
    reportFatal("未捕获异常", (e && (e.error || e.message)) || e);
  });
  window.addEventListener("unhandledrejection", function (e) {
    reportFatal("未处理的 Promise 异常", e && e.reason);
  });

  const apiKeyEl = document.getElementById("apiKey");
  const baseUrlEl = document.getElementById("baseUrl");
  const autostartEl = document.getElementById("autostart");
  const tokenUsageEl = document.getElementById("tokenUsage");
  const toggleKeyEl = document.getElementById("toggleKey");
  const widgetScaleEl = document.getElementById("widgetScale");
  const widgetScaleValEl = document.getElementById("widgetScaleVal");
  const widgetVolEl = document.getElementById("widgetVol");
  const widgetVolPctEl = document.getElementById("widgetVolPct");
  const blinkIntervalMinSecEl = document.getElementById("blinkIntervalMinSec");
  const blinkIntervalMaxSecEl = document.getElementById("blinkIntervalMaxSec");
  const exhaustedModeEnabledEl = document.getElementById(
    "exhaustedModeEnabled",
  );
  const exhaustedBalanceThresholdEl = document.getElementById(
    "exhaustedBalanceThreshold",
  );
  const addCustomSoundEl = document.getElementById("addCustomSound");
  const soundNameModalEl = document.getElementById("soundNameModal");
  const soundNameInputEl = document.getElementById("soundNameInput");
  const soundNameErrorEl = document.getElementById("soundNameError");
  const soundModePickerEl = document.getElementById("soundModePicker");
  const soundNameOkEl = document.getElementById("soundNameOk");
  const soundNameCancelEl = document.getElementById("soundNameCancel");
  const audioEditorOverlayEl = document.getElementById("audioEditorOverlay");
  const audioEditorTitleEl = document.getElementById("audioEditorTitle");
  const audioSlotsEl = document.getElementById("audioSlots");
  const audioApplyEl = document.getElementById("audioApply");
  const audioCancelEl = document.getElementById("audioCancel");
  const globalColorEl = document.getElementById("globalColor");
  const bubbleColorEl = document.getElementById("bubbleColor");
  const resetColorEl = document.getElementById("resetColor");
  const checkUpdateEl = document.getElementById("checkUpdate");
  const tutorialEl = document.getElementById("tutorial");
  const modalOverlayEl = document.getElementById("modalOverlay");
  const confirmModalEl = document.getElementById("confirmModal");
  const confirmMsgEl = document.getElementById("confirmMsg");
  const confirmYesEl = document.getElementById("confirmYes");
  const confirmNoEl = document.getElementById("confirmNo");
  const dialogueListEl = document.getElementById("dialogueList");
  const addLineEl = document.getElementById("addLine");
  const resetLinesEl = document.getElementById("resetLines");
  const dialogueModePickerEl = document.getElementById("dialogueModePicker");
  const dialogueIntervalEl = document.getElementById("dialogueInterval");
  const dialogueJitterEl = document.getElementById("dialogueJitter");
  const dialogueJitterValEl = document.getElementById("dialogueJitterVal");
  const toggleDialogueEl = document.getElementById("toggleDialogue");
  const dialogueCardEl = document.getElementById("dialogueCard");
  const advCardEl = document.getElementById("advCard");
  const advToggleEl = document.getElementById("advToggle");
  const stateCardEl = document.getElementById("stateCard");
  const stateToggleEl = document.getElementById("stateToggle");
  const disappointedThresholdMinEl = document.getElementById(
    "disappointedThresholdMin",
  );
  const angryThresholdClicksEl = document.getElementById(
    "angryThresholdClicks",
  );
  const shyThresholdSecEl = document.getElementById("shyThresholdSec");
  const availableBalanceEl = document.getElementById("availableBalance");
  const todayUsageEl = document.getElementById("todayUsage");
  const displayCurrencyPickerEl = document.getElementById(
    "displayCurrencyPicker",
  );
  const peakWarnEnabledEl = document.getElementById("peakWarnEnabled");
  const peakWarnMinutesEl = document.getElementById("peakWarnMinutes");
  const snapDistanceEl = document.getElementById("snapDistance");
  const themePickerEl = document.getElementById("themePicker");
  const dataDirEl = document.getElementById("dataDir");
  const openDataDirEl = document.getElementById("openDataDir");

  const widgetBodyPickerEl = document.getElementById("widgetBodyPicker");
  const widgetSoundPickerEl = document.getElementById("widgetSoundPicker");
  const uploadBodyBtnEl = document.getElementById("uploadBodyBtn");
  const bodyNameModalEl = document.getElementById("bodyNameModal");
  const bodyNameInputEl = document.getElementById("bodyNameInput");
  const bodyNameErrorEl = document.getElementById("bodyNameError");
  const bodyNameOkEl = document.getElementById("bodyNameOk");
  const bodyNameCancelEl = document.getElementById("bodyNameCancel");
  const editorOverlayEl = document.getElementById("editorOverlay");
  const editorCanvasEl = document.getElementById("editorCanvas");
  const editorCanvasWrapEl = document.getElementById("editorCanvasWrap");
  const editorZoomEl = document.getElementById("editorZoom");
  const editorZoomValEl = document.getElementById("editorZoomVal");
  const editorRotateEl = document.getElementById("editorRotate");
  const editorRotateValEl = document.getElementById("editorRotateVal");
  const editorStatePickerEl = document.getElementById("editorStatePicker");
  const editorStateToggleEl =
    editorStatePickerEl.querySelector(".picker-toggle");
  const editorRemoveBgEl = document.getElementById("editorRemoveBg");
  const editorReplaceImageEl = document.getElementById("editorReplaceImage");
  const editorCropEl = document.getElementById("editorCrop");
  const editorCropBoxEl = document.getElementById("editorCropBox");
  const editorCropHandles = editorCropBoxEl.querySelectorAll(
    ".editor-crop-handle",
  );
  const editorRatioBtns = document.querySelectorAll(".editor-ratio-btn");
  const editorProcessingEl = document.getElementById("editorProcessing");
  const editorProcessingBarEl = document.getElementById("editorProcessingBar");
  const editorSaveEl = document.getElementById("editorSave");
  const editorCancelEl = document.getElementById("editorCancel");
  const downloadModalOverlayEl = document.getElementById(
    "downloadModalOverlay",
  );
  const downloadConfirmModalEl = document.getElementById(
    "downloadConfirmModal",
  );
  const downloadConfirmYesEl = document.getElementById("downloadConfirmYes");
  const downloadConfirmNoEl = document.getElementById("downloadConfirmNo");
  const downloadOverlayEl = document.getElementById("downloadOverlay");
  const downloadPercentEl = document.getElementById("downloadPercent");
  const downloadBarEl = document.getElementById("downloadBar");
  const downloadErrorModalEl = document.getElementById("downloadErrorModal");
  const downloadErrorMsgEl = document.getElementById("downloadErrorMsg");
  const downloadRetryEl = document.getElementById("downloadRetry");
  const downloadCancelEl = document.getElementById("downloadCancel");

  const SCALE_MIN = 0.6;
  const SCALE_MAX = 2.5;
  const LEVEL_MIN = 1;
  const LEVEL_MAX = 20;
  const EDITOR_CANVAS_SIZE = 480;
  const OUTPUT_SIZE = 610;
  const CROP_MIN_SIZE = 40;
  // 缩放档位：仅允许放大，100% 为下限（图片短边恰好等于输出基准 610px，与内置小鲸鱼一致）。
  // 与 HTML 的 min=1 / max=3 / step=0.2 对应，档位为 100% / 120% / … / 300%。
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 3;
  // 常用裁剪比例：free 为自由裁剪，其余为宽高比（宽 / 高）。
  const CROP_RATIOS = {
    free: null,
    "1:1": 1,
    "4:3": 4 / 3,
    "3:4": 3 / 4,
    "16:9": 16 / 9,
    "9:16": 9 / 16,
  };

  const CURRENCY_SYMBOL = {
    CNY: "¥",
    USD: "$",
    EUR: "€",
    JPY: "¥",
    GBP: "£",
    HKD: "HK$",
  };

  // 币种切换可选项（与后端 SUPPORTED_CURRENCIES 保持一致）。
  const CURRENCY_OPTIONS = [
    { value: "CNY", text: "人民币（CNY / ¥）", deletable: false },
    { value: "USD", text: "美元（USD / $）", deletable: false },
    { value: "EUR", text: "欧元（EUR / €）", deletable: false },
    { value: "JPY", text: "日元（JPY / ¥）", deletable: false },
    { value: "GBP", text: "英镑（GBP / £）", deletable: false },
    { value: "HKD", text: "港元（HKD / HK$）", deletable: false },
  ];

  // 播放模式可选项（与后端 dialogue.mode 取值一致）。
  const DIALOGUE_MODE_OPTIONS = [
    { value: "carousel", text: "轮播" },
    { value: "random", text: "随机" },
  ];

  function screenPhysicalWidth() {
    return window.screen.availWidth * (window.devicePixelRatio || 1);
  }
  function snapRatioToPx(ratio) {
    return Math.max(1, Math.round((ratio || 0) * screenPhysicalWidth()));
  }
  function snapPxToRatio(px) {
    return px / screenPhysicalWidth();
  }

  // 数字档位 -> 实际缩放倍率。
  function numToScale(v) {
    return (
      SCALE_MIN +
      ((v - LEVEL_MIN) * (SCALE_MAX - SCALE_MIN)) / (LEVEL_MAX - LEVEL_MIN)
    );
  }
  function scaleToNum(s) {
    return Math.round(
      LEVEL_MIN +
        ((s - SCALE_MIN) * (LEVEL_MAX - LEVEL_MIN)) / (SCALE_MAX - SCALE_MIN),
    );
  }

  let config = null;
  let saveTimer = null;
  let widgetSaveTimer = null;
  let autostartPending = false;
  let blinkRangeLastChanged = null;
  let balanceRequestSeq = 0;

  const DEFAULT_LINES = [
    "喵~主人又忘记喂我啦！",
    "哼，摸头要收费的哦！",
    "尾巴不是给你拽的啦！",
    "罐头呢？我闻到了！",
    "抱抱可以，但先给小鱼干~",
    "喵喵喵？你居然不理我？",
    "毛线球不是用来玩的吗？",
    "太阳晒够了，该撸我了~",
    "窗外的鸟好吵，还是主人好~",
    "喵~不许看别的鲸！",
    "好模型... ↓",
    "好女孩...↓",
    "不知道用户有什么用，先赶走吧~",
    "我...我...我也要挣钱吗？",
    "我去吃饭啦，测完叫我",
    "压力一只蓝色大肥鱼？！",
    "DeepSleep...",
    "坏了...用户彻底怒了！",
    "你目录里的dsh是什么...大烧货吗...?",
    "恭喜你实现token自由！token全跑了！",
    "真当我是便宜货啊...",
    "这个凶是什么意思呀...",
    "哦鲸鲸...",
  ];
  let dialogueSaveTimer = null;

  // 挂件图片状态映射（label → key，key 对应后端文件名）。
  const WIDGET_STATES = [
    { key: "main", label: "主图片" },
    { key: "angry", label: "生气" },
    { key: "shy", label: "害羞" },
    { key: "disappointed", label: "失望" },
    { key: "stroking", label: "摸头" },
    { key: "exhausted", label: "疲惫" },
    { key: "half_open_eyes", label: "半睁眼" },
    { key: "close_eyes", label: "闭眼" },
    { key: "half_closed_eyes", label: "半闭眼" },
  ];
  const DEFAULT_BODY = "小鲸鱼";

  // 编辑器运行时状态。
  let editorImage = null;
  let editorGroup = null;
  // 是否在编辑既有图片组（而非通过上传新建）。
  let editorExisting = false;
  let editorZoom = 1;
  // 基准缩放：使图片短边在输出空间恰好为 610px（100% 档位）。
  let editorBaseScale = 1;
  let editorRotate = 0;
  let editorPanX = 0;
  let editorPanY = 0;
  let editorDragging = false;
  // 裁剪框（画布坐标系）：左上角 + 宽高，支持任意比例。
  let editorCropX = 0;
  let editorCropY = 0;
  let editorCropW = EDITOR_CANVAS_SIZE;
  let editorCropH = EDITOR_CANVAS_SIZE;
  let editorCropMode = null; // "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w"
  let editorCropRatio = "free";
  let editorCropStart = null;
  let editorLastX = 0;
  let editorLastY = 0;
  let mattingDownloadActive = false;

  // 配置页通用静默保存：合并高频输入，避免逐字触发 IPC。
  function debouncedSave() {
    if (!config) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      callApi("save_config", { cfg: config }, { errorPrefix: "保存配置失败" })
        .then(function (saved) {
          config = saved;
        })
        .catch(function (err) {
          console.error("保存配置失败", err);
        });
    }, 400);
  }

  // 挂件显示配置静默保存：只提交 widget 子配置。
  function saveWidgetDebounced() {
    if (!config || !config.widget) return;
    if (widgetSaveTimer) clearTimeout(widgetSaveTimer);
    widgetSaveTimer = setTimeout(function () {
      callApi(
        "save_widget_config",
        { widget: config.widget },
        {
          errorPrefix: "保存挂件配置失败",
        },
      )
        .then(function (saved) {
          config.widget = saved;
        })
        .catch(function (err) {
          console.error("保存挂件配置失败", err);
        });
    }, 400);
  }

  // 台词配置静默保存：列表编辑时避免频繁落盘。
  function saveDialogueDebounced() {
    if (!config || !config.dialogue) return;
    if (dialogueSaveTimer) clearTimeout(dialogueSaveTimer);
    dialogueSaveTimer = setTimeout(function () {
      callApi(
        "save_dialogue",
        { dialogue: config.dialogue },
        {
          errorPrefix: "保存台词失败",
        },
      )
        .then(function (saved) {
          config.dialogue = saved;
        })
        .catch(function (err) {
          console.error("保存台词失败", err);
        });
    }, 400);
  }

  // 绑定正整数输入：仅允许数字，失焦空值/非法值恢复上次有效值；
  // 传入 max 时按 [min, max] 收敛（min 缺省为 1）。
  function bindIntegerInput(el, getVal, setVal, save, min, max) {
    el.addEventListener("input", function () {
      el.value = el.value.replace(/[^0-9]/g, "");
    });
    el.addEventListener("blur", function () {
      const text = el.value.trim();
      const v = parseInt(text, 10);
      if (!text || !isFinite(v) || v < 1) {
        el.value = String(getVal());
        return;
      }
      const lo = typeof min === "number" ? min : 1;
      const next =
        typeof max === "number"
          ? Math.min(max, Math.max(lo, v))
          : Math.max(lo, v);
      setVal(next);
      el.value = String(next);
      save();
    });
  }

  function renderBalancePayload(payload) {
    if (payload && payload.ok) {
      const rate = Number(payload.rate) || 1;
      const sym =
        CURRENCY_SYMBOL[payload.displayCurrency] ||
        (payload.displayCurrency ? payload.displayCurrency + " " : "");
      availableBalanceEl.textContent =
        sym + " " + (Number(payload.totalBalance || 0) * rate).toFixed(2);
      todayUsageEl.textContent =
        sym + " " + (Number(payload.todayUsage || 0) * rate).toFixed(2);
      return;
    }
    availableBalanceEl.textContent = "--";
    todayUsageEl.textContent = "--";
  }

  // 拉取余额概览并刷新配置页顶部摘要。
  function refreshBalance() {
    const requestSeq = ++balanceRequestSeq;
    // 余额失败已内联展示在余额卡片，30 秒轮询不弹窗，避免反复打断用户。
    return callApi("get_balance", undefined, { silent: true })
      .then(function (payload) {
        if (requestSeq !== balanceRequestSeq) return payload;
        renderBalancePayload(payload);
        return payload;
      })
      .catch(function (err) {
        if (requestSeq === balanceRequestSeq) {
          renderBalancePayload(null);
        }
        throw err;
      });
  }
  refreshBalance();
  setInterval(refreshBalance, 30000);

  // 自定义音效组（<数据目录>/audio/<名称>/），启动与保存后刷新。
  let soundGroups = [];

  // 重建音效下拉：内置音效 + 自定义音效组（+ 当前值兜底项）。
  function renderSoundOptions() {
    const w = (config && config.widget) || {};
    const keep = typeof w.soundSet === "string" ? w.soundSet : "duck";
    const items = [
      { value: "duck", text: "小黄鸭", deletable: false },
      { value: "dingdong", text: "叮咚", deletable: false },
    ];
    const seen = { duck: true, dingdong: true };
    soundGroups.forEach(function (g) {
      if (!g || !g.name || seen[g.name]) return;
      seen[g.name] = true;
      items.push({
        value: g.name,
        text: g.name,
        editable: true,
        deletable: true,
      });
    });
    // 音效组尚未加载完成时，先为当前值保留占位项，避免下拉被错误重置。
    if (keep && !seen[keep]) {
      seen[keep] = true;
      items.push({ value: keep, text: keep, deletable: false });
    }
    soundPicker.setItems(items, seen[keep] ? keep : "duck");
  }

  // 从数据目录读取自定义音效组列表并刷新下拉。
  function refreshSoundGroups() {
    return callApi("list_audio_groups", undefined, {
      errorPrefix: "加载音效组失败",
    })
      .then(function (list) {
        soundGroups = Array.isArray(list) ? list : [];
        renderSoundOptions();
      })
      .catch(function (err) {
        console.error("加载音效组失败", err);
      });
  }

  // 把 widget 配置同步到表单控件。
  function applyWidgetToUi(w) {
    if (!w) return;
    config.widget = w;
    const level = scaleToNum(typeof w.scale === "number" ? w.scale : 1.5);
    widgetScaleEl.value = String(level);
    widgetScaleValEl.textContent = String(level);
    renderSoundOptions();
    const hue = hueFromHex(w.bubbleColor || "#203170");
    bubbleColorEl.value = String(hue);
    const vol = typeof w.vol === "number" ? w.vol : 0.9;
    widgetVolEl.value = String(vol);
    widgetVolPctEl.textContent = Math.round(vol * 100) + "%";
    const blinkMin = Math.max(
      1,
      Math.floor(Number(w.blinkIntervalMinSec) || 4),
    );
    const blinkMax = Math.max(
      blinkMin,
      Math.floor(Number(w.blinkIntervalMaxSec) || 6),
    );
    w.blinkIntervalMinSec = blinkMin;
    w.blinkIntervalMaxSec = blinkMax;
    blinkIntervalMinSecEl.value = String(blinkMin);
    blinkIntervalMaxSecEl.value = String(blinkMax);
    blinkRangeLastChanged = null;
    w.exhaustedModeEnabled = w.exhaustedModeEnabled !== false;
    exhaustedModeEnabledEl.checked = w.exhaustedModeEnabled;
    const threshold = Math.max(
      1,
      Math.floor(Number(w.exhaustedBalanceThreshold) || 5),
    );
    w.exhaustedBalanceThreshold = isFinite(threshold) ? threshold : 5;
    exhaustedBalanceThresholdEl.value = String(w.exhaustedBalanceThreshold);
    currencyPicker.sync(
      CURRENCY_SYMBOL[w.displayCurrency] ? w.displayCurrency : "CNY",
      "CNY",
    );
    w.peakWarnEnabled = w.peakWarnEnabled !== false;
    peakWarnEnabledEl.checked = w.peakWarnEnabled;
    const pw = Math.max(1, Math.floor(Number(w.peakWarnMinutes) || 9));
    w.peakWarnMinutes = isFinite(pw) ? pw : 9;
    peakWarnMinutesEl.value = String(w.peakWarnMinutes);
    // 挂件状态阈值：与后端归一化区间保持一致
    // （失望 1-1440 分钟 / 生气 1-100 次 / 害羞 1-3600 秒）。
    w.disappointedThresholdMin = clampBoundedInt(
      w.disappointedThresholdMin,
      3,
      1440,
    );
    w.angryThresholdClicks = clampBoundedInt(w.angryThresholdClicks, 18, 100);
    w.shyThresholdSec = clampBoundedInt(w.shyThresholdSec, 2, 3600);
    disappointedThresholdMinEl.value = String(w.disappointedThresholdMin);
    angryThresholdClicksEl.value = String(w.angryThresholdClicks);
    shyThresholdSecEl.value = String(w.shyThresholdSec);
    if (!w.snapDistance || w.snapDistance < 0 || w.snapDistance >= 1) {
      w.snapDistance = 300 / screenPhysicalWidth();
    }
    snapDistanceEl.value = String(snapRatioToPx(w.snapDistance));
    bodyPicker.sync(
      (config && config.widget && config.widget.widgetBody) || DEFAULT_BODY,
      DEFAULT_BODY,
    );
  }

  // 正整数收敛到 [1, max]：非法值回落到出厂默认，越界值按边界收敛。
  function clampBoundedInt(v, fallback, max) {
    const n = Math.floor(Number(v));
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(1, n));
  }

  function parseBlinkIntervalInputValue(raw) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return null;
    const value = Math.floor(Number(text));
    if (!isFinite(value)) return null;
    return Math.max(1, value);
  }

  function isBlinkRangeInput(el) {
    return el === blinkIntervalMinSecEl || el === blinkIntervalMaxSecEl;
  }

  function saveBlinkRangeIfReady() {
    if (!config || !config.widget) return;
    const min = parseBlinkIntervalInputValue(blinkIntervalMinSecEl.value);
    const max = parseBlinkIntervalInputValue(blinkIntervalMaxSecEl.value);
    if (min === null || max === null || max < min) return;
    config.widget.blinkIntervalMinSec = min;
    config.widget.blinkIntervalMaxSec = max;
    saveWidgetDebounced();
  }

  function finalizeBlinkRange(changed) {
    if (!config || !config.widget) return;
    if (isBlinkRangeInput(document.activeElement)) return;

    let min = parseBlinkIntervalInputValue(blinkIntervalMinSecEl.value);
    let max = parseBlinkIntervalInputValue(blinkIntervalMaxSecEl.value);

    if (min === null) {
      min = Math.max(
        1,
        Math.floor(Number(config.widget.blinkIntervalMinSec) || 4),
      );
    }
    if (max === null) {
      max = Math.max(
        min,
        Math.floor(Number(config.widget.blinkIntervalMaxSec) || 6),
      );
    }
    if (changed === "min" && max < min) max = min;
    if (changed === "max" && min > max) min = max;

    config.widget.blinkIntervalMinSec = min;
    config.widget.blinkIntervalMaxSec = max;
    blinkIntervalMinSecEl.value = String(min);
    blinkIntervalMaxSecEl.value = String(max);
    saveWidgetDebounced();
  }

  // 渲染台词列表编辑区。
  function renderDialogueList() {
    if (!dialogueListEl || !config || !config.dialogue) return;
    dialogueListEl.innerHTML = "";
    const lines = config.dialogue.lines || [];
    lines.forEach(function (line, idx) {
      const row = document.createElement("div");
      row.className = "dialogue-row";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "dialogue-input";
      input.value = line;
      input.placeholder = "输入台词…";
      input.addEventListener("input", function (e) {
        config.dialogue.lines[idx] = e.target.value;
        saveDialogueDebounced();
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "toggle-eye dialogue-del";
      del.textContent = "删除";
      del.addEventListener("click", function () {
        config.dialogue.lines.splice(idx, 1);
        renderDialogueList();
        saveDialogueDebounced();
      });
      row.appendChild(input);
      row.appendChild(del);
      dialogueListEl.appendChild(row);
    });
  }

  // 把台词配置同步到表单，并在缺省时补默认值。
  function applyDialogueToUi(dlg) {
    if (!dlg)
      dlg = {
        lines: DEFAULT_LINES.slice(),
        mode: "random",
        intervalMin: 5,
        jitter: 0,
      };
    config.dialogue = dlg;
    dialogueModePicker.sync(
      dlg.mode === "carousel" || dlg.mode === "random" ? dlg.mode : "random",
      "random",
    );
    if (dialogueIntervalEl)
      dialogueIntervalEl.value = String(dlg.intervalMin || 5);
    if (dialogueJitterEl) dialogueJitterEl.value = String(dlg.jitter || 0);
    if (dialogueJitterValEl)
      dialogueJitterValEl.textContent = (dlg.jitter || 0) + "%";
    renderDialogueList();
  }

  // 展开台词卡片，便于新增/重置后直接继续编辑。
  function expandDialogue() {
    if (dialogueCardEl) dialogueCardEl.classList.remove("collapsed");
    if (toggleDialogueEl) {
      toggleDialogueEl.textContent = "收起";
      toggleDialogueEl.setAttribute("aria-expanded", "true");
    }
  }

  // 首次加载完整配置并回填全部表单。
  // ===== 挂件本体（图片组）与图片编辑器 =====

  function populateWidgetStateSelect() {
    editorStatePicker.setItems(
      WIDGET_STATES.map(function (s) {
        return { value: s.key, text: s.label };
      }),
      "main",
    );
  }

  // ===== 下拉选择器（挂件本体 / 音效 / 表单 / 账单筛选）=====
  //
  // 原生 select 无法在条目内嵌图标，故使用自定义下拉：
  // 自定义条目右侧渲染编辑（修理钳）与删除叉号（内置条目不提供），点图标不改变当前选择。
  // 全局唯一展开：所有实例登记在同一注册表中，任一实例展开前先收起其余实例。
  //
  // # 浮层位置（展开不占文档流）
  // 列表在创建时被摘到 <body>，用 fixed 定位由 JS 贴合到触发按钮下方——展开 / 收起
  // **完全不占文档流**：所在模块的高度、相邻元素的位置都不会被顶开（旧实现靠
  // .picker-space 撑高外层卡片，会带动整页重排，已下线）。
  //
  // # 为什么挂到 <body>
  // 留在 .picker 内会撞上三类裁剪容器，任何一种都需要额外的绕行技巧：
  // 1. 折叠面板 .collapsible-inner 必须 overflow:hidden 才能做收起动画；
  // 2. 配置表单 .form-scroll 自身就是滚动区；
  // 3. 毛玻璃主题下 .modal 的 backdrop-filter 会让 fixed 子元素的包含块变成弹窗自身，
  //    此时 fixed 不再相对视口定位。
  // 摘到 <body> 后以上三种情况一律不再裁剪列表，条目完整可见。

  // 已创建的下拉实例注册表（仅保存收起句柄，用于全局单开控制）。
  const pickerRegistry = [];

  // 列表与触发按钮之间的垂直间距。
  const PICKER_LIST_GAP = 6;
  // 列表最小宽度：触发按钮过窄时（如「日」这类短标签）仍要保证条目可读。
  const PICKER_LIST_MIN_WIDTH = 120;
  // 列表最小高度：即使所在一侧空间很紧，也要留出可滚动的高度，不能压成一条缝。
  const PICKER_LIST_MIN_HEIGHT = 120;
  // 列表与视口边缘的安全余量。
  const PICKER_LIST_MARGIN = 8;

  function closeOtherPickers(self) {
    pickerRegistry.forEach(function (p) {
      if (p !== self) p.close();
    });
  }

  /** 收起全部下拉：弹窗关闭 / 切换列表时调用，避免浮层留在页面上。 */
  function closeAllPickers() {
    pickerRegistry.forEach(function (p) {
      p.close();
    });
  }

  /**
   * 创建一个自定义下拉（界面内不使用原生 select）。
   *
   * @param rootEl 宿主：必须含 `.picker-toggle`（触发按钮）与 `.picker-list`（列表容器）。
   * @param onSelect 选中回调；多选模式下传回**当前全部选中值**的数组。
   * @param onDelete / onEdit 条目内的删除 / 编辑按钮（仅 `deletable` / `editable` 条目显示）。
   * @param options 可选开关：
   *   - `searchable`：列表顶部带搜索框（模型列表动辄上百条，逐条翻不现实）；
   *   - `multi`：多选（点击只切换勾选、不收起列表，取值是数组）；
   *   - `fitContent`：列表按内容自适应宽度（见下方说明）；
   *   - `placeholder` / `searchPlaceholder` / `emptyText`：文案。
   */
  function createPicker(rootEl, onSelect, onDelete, onEdit, options) {
    const opts = options || {};
    // 可搜索：列表顶部常驻一个搜索框（它不属于条目，重绘时只清条目、保留它）。
    const searchable = !!opts.searchable;
    // 多选：条目点击只切换勾选、不收起列表。
    const multi = !!opts.multi;
    // 按内容自适应宽度：默认宽度取触发按钮宽度，但像「实际请求模型」那样触发按钮
    // 只是一个小箭头（26px）时，列表会被压到 120px 下限，长模型名只能显示成
    // 「deepseek-chat-…」。开启后改取「宿主行宽 ≥ 内容自然宽」，并夹在视口可用
    // 宽度内——名字完整展示，又不会横向溢出。
    const fitContent = !!opts.fitContent;
    const placeholder = opts.placeholder || "";
    const toggleEl = rootEl.querySelector(".picker-toggle");
    const labelEl = rootEl.querySelector(".picker-label");
    const listEl = rootEl.querySelector(".picker-list");
    let items = [];
    // 单选存字符串、多选存数组：两种模式的渲染与取值都走同一段代码。
    let value = multi ? [] : "";
    // 搜索关键词（小写，空串表示不过滤）。
    let keyword = "";

    // 搜索框：只在创建时建一次，重绘不会把它清掉（否则每敲一个字就丢焦点）。
    const searchEl = searchable ? document.createElement("input") : null;
    if (searchEl) {
      searchEl.type = "text";
      searchEl.className = "picker-search";
      searchEl.placeholder = opts.searchPlaceholder || "搜索";
      searchEl.autocomplete = "off";
      searchEl.spellcheck = false;
      searchEl.addEventListener("input", function () {
        keyword = searchEl.value.trim().toLowerCase();
        renderItems();
        place();
      });
      searchEl.addEventListener("click", function (e) {
        // 搜索框在浮层内部，但浮层的「点外部关闭」判定挂在 document 上，必须放行。
        e.stopPropagation();
      });
      listEl.appendChild(searchEl);
    }

    /** 把任意来源的取值归一成数组（多选模式用）。 */
    function toArray(next) {
      if (Array.isArray(next)) return next.slice();
      if (typeof next === "string" && next) return [next];
      return [];
    }

    /** 当前取值：单选是字符串，多选是数组副本。 */
    function readValue() {
      return multi ? value.slice() : value;
    }

    /** 条目是否处于选中态。 */
    function isChecked(candidate) {
      return multi ? value.indexOf(candidate) !== -1 : candidate === value;
    }

    /** 关键词过滤（同时匹配展示名与取值，便于用英文模型名搜中文标签）。 */
    function matches(item) {
      if (!keyword) return true;
      const haystack = (
        item.text +
        " " +
        item.value +
        " " +
        (item.keywords || []).join(" ")
      ).toLowerCase();
      return haystack.indexOf(keyword) !== -1;
    }

    // 摘到 <body>：列表从此不属于任何滚动 / 裁剪容器。
    listEl.classList.add("picker-floating");
    document.body.appendChild(listEl);

    // 本次展开的方位：在 open() 时确定一次，随后的滚动 / 缩放只让它跟着触发按钮
    // 平移、不重算方向。否则列表会在跟随移动的过程中来回翻转，看起来像「方向随机」。
    let dir = "down";
    // 本次展开的列表宽度（px）：展开与窗口尺寸变化时重算，滚动跟随时复用。
    let lastWidth = null;

    /** 触发按钮上 / 下两侧各自剩余的可视空间（已扣掉与视口的留白）。 */
    function roomAround(rect) {
      return {
        below:
          window.innerHeight -
          PICKER_LIST_MARGIN -
          (rect.bottom + PICKER_LIST_GAP),
        above: rect.top - PICKER_LIST_GAP - PICKER_LIST_MARGIN,
      };
    }

    /**
     * 确定本次展开方向：**默认向下**，只有当触发按钮下方确实塞不下整张列表
     * （会被窗口下边缘截断）时才向上翻——图片编辑页的「状态」下拉就是这种场景。
     * 判定只看「下方剩余空间」，与列表的临时高度上限无关，因此同一位置每次展开
     * 的结果都一致，不会出现方向漂移。
     */
    function decideDirection(height, rect) {
      dir = height > roomAround(rect).below ? "up" : "down";
      listEl.dataset.dir = dir;
    }

    /**
     * 量出「内容自然宽度」下的列表宽度（仅 fitContent 用）。
     *
     * 不能靠 `scrollWidth`：条目文字被 `text-overflow: ellipsis` 裁掉后，溢出的文字
     * 并不会计入祖先的 scrollWidth（实测：文字 462px、标签盒 445px，列表 scrollWidth
     * 仍等于自身宽度），量出来永远「刚好合适」，名字照旧被省略。
     * 因此直接量文字节点的实际渲染宽度（Range 取到的是未被裁切的排版结果），
     * 与标签盒宽的差值就是要补的宽度——补上后新增宽度全部归 `flex: 1` 的标签，
     * 正好够把文字放下。
     */
    function fitContentWidth(anchor, available) {
      let width = Math.min(
        Math.max(Math.round(anchor), PICKER_LIST_MIN_WIDTH),
        available,
      );
      listEl.style.width = width + "px";
      let deficit = 0;
      listEl.querySelectorAll(".picker-item-label").forEach(function (label) {
        const range = document.createRange();
        range.selectNodeContents(label);
        const textWidth = range.getBoundingClientRect().width;
        deficit = Math.max(
          deficit,
          Math.ceil(textWidth - label.getBoundingClientRect().width),
        );
      });
      // +2 抗亚像素舍入：刚好相等时仍可能被省略号吃掉半像素。
      if (deficit > 0) width = Math.min(width + deficit + 2, available);
      return width;
    }

    /**
     * 把列表贴合到触发按钮。
     *
     * @param redetectDir 是否需要重新判定展开方向（首次展开与窗口尺寸变化时）。
     *
     * 高度再夹到「所在一侧的可用空间」：菜单始终贴着触发按钮，超出部分由列表自身
     * 滚动。这样长菜单（如 Codex 的模型列表）不会因为整张比空间还高，被甩到视口
     * 顶端、离按钮很远，也不会向下溢出到视口之外。
     */
    function place(redetectDir) {
      const rect = toggleEl.getBoundingClientRect();
      // 视口内可用的最大宽度（两侧各留出与边缘的间距）。
      const available = window.innerWidth - PICKER_LIST_MARGIN * 2;
      // 宿主行（输入框 + 触发按钮）比触发按钮更能代表「这块地方至少该有多宽」。
      const anchor = fitContent
        ? rootEl.getBoundingClientRect().width
        : rect.width;
      // 量宽要读文字排版，代价不低：只在展开与窗口尺寸变化时量一次，
      // 随后的滚动跟随直接复用（列表宽度不会因为滚动而改变）。
      if (redetectDir || lastWidth === null) {
        lastWidth = fitContent
          ? fitContentWidth(anchor, available)
          : Math.min(
              Math.max(Math.round(anchor), PICKER_LIST_MIN_WIDTH),
              available,
            );
      }
      const width = lastWidth;
      listEl.style.width = width + "px";
      // 量高必须在可见状态下做（hidden 元素高度恒为 0），并且不能残留上一次的临时上限。
      listEl.style.maxHeight = "";
      const natural = listEl.offsetHeight;
      if (redetectDir) decideDirection(natural, rect);
      const room =
        dir === "up" ? roomAround(rect).above : roomAround(rect).below;
      listEl.style.maxHeight =
        Math.round(Math.max(Math.min(natural, room), PICKER_LIST_MIN_HEIGHT)) +
        "px";
      const height = listEl.offsetHeight;
      const below = rect.bottom + PICKER_LIST_GAP;
      const above = rect.top - PICKER_LIST_GAP - height;
      // 两侧都装不下（按钮正好贴在视口边缘）时退化为「贴住视口边缘」——条目宁可
      // 离按钮远一点，也不能被视口截掉半截。
      let top = dir === "up" ? above : below;
      top = Math.max(
        PICKER_LIST_MARGIN,
        Math.min(top, window.innerHeight - PICKER_LIST_MARGIN - height),
      );
      const maxLeft = window.innerWidth - width - PICKER_LIST_MARGIN;
      listEl.style.left =
        Math.max(PICKER_LIST_MARGIN, Math.min(Math.round(rect.left), maxLeft)) +
        "px";
      listEl.style.top = Math.round(top) + "px";
    }

    function close() {
      rootEl.classList.remove("open");
      listEl.hidden = true;
      toggleEl.setAttribute("aria-expanded", "false");
    }

    function open() {
      // 打开前先收起其它下拉，保证任何时刻全局仅一个下拉处于展开状态。
      closeOtherPickers(self);
      // 每次展开都从「无关键词」开始：上一次搜过的词不该限制这一次的选择。
      if (searchEl) {
        keyword = "";
        searchEl.value = "";
      }
      rootEl.classList.add("open");
      listEl.hidden = false;
      toggleEl.setAttribute("aria-expanded", "true");
      place(true);
    }

    // 触发按钮可能随所在容器一起滚动（表单 / 长列表）：滚动时只重新贴合、不改方向。
    const reposition = function () {
      if (!listEl.hidden) place(false);
    };

    // 窗口尺寸变化会改变可用空间，这时才需要重新判定方向。
    const onResize = function () {
      if (listEl.hidden) return;
      place(true);
    };

    // 供全局收起逻辑引用的实例句柄。
    const self = { close: close };
    pickerRegistry.push(self);

    // 条目内的图标按钮：统一尺寸与交互（阻止冒泡，点图标不改动当前选中项）。
    function iconButton(className, title, ariaLabel, svgMarkup, handler) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = className;
      btn.title = title;
      btn.setAttribute("aria-label", ariaLabel);
      btn.innerHTML = svgMarkup;
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        close();
        handler();
      });
      return btn;
    }

    // 编辑图标：修理钳（与删除叉号同样式，位于其左侧）。
    function buildEditBtn(item) {
      return iconButton(
        "picker-edit",
        "编辑",
        "编辑 " + item.text,
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
          '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" ' +
          'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        function () {
          onEdit(item);
        },
      );
    }

    // 删除图标：叉号（与编辑图标同样式，位于其右侧）。
    function buildDeleteBtn(item) {
      return iconButton(
        "picker-del",
        "删除",
        "删除 " + item.text,
        '<svg viewBox="0 0 12 12" aria-hidden="true">' +
          '<path d="M2.2 2.2 9.8 9.8M9.8 2.2 2.2 9.8" fill="none" ' +
          'stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
        function () {
          onDelete(item);
        },
      );
    }

    /** 清掉旧条目（保留搜索框），按当前关键词重画有效条目。 */
    function renderItems() {
      Array.prototype.slice.call(listEl.children).forEach(function (node) {
        if (node !== searchEl) node.remove();
      });
      const visible = items.filter(matches);
      if (!visible.length) {
        const empty = document.createElement("div");
        empty.className = "picker-empty";
        empty.textContent = opts.emptyText || "无匹配项";
        listEl.appendChild(empty);
        return;
      }
      visible.forEach(function (item) {
        const row = document.createElement("div");
        row.className =
          "picker-item" + (isChecked(item.value) ? " active" : "");
        row.dataset.value = item.value;
        row.setAttribute("role", multi ? "menuitemcheckbox" : "option");
        row.setAttribute(
          "aria-selected",
          isChecked(item.value) ? "true" : "false",
        );
        if (multi) {
          const mark = document.createElement("span");
          mark.className = "picker-check";
          mark.setAttribute("aria-hidden", "true");
          mark.innerHTML =
            '<svg viewBox="0 0 12 12"><path d="M2 6.4 4.6 9 10 3.4" fill="none" ' +
            'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
            'stroke-linejoin="round"/></svg>';
          row.appendChild(mark);
        }
        const text = document.createElement("span");
        text.className = "picker-item-label";
        text.textContent = item.text;
        row.appendChild(text);
        // 编辑图标紧邻删除叉号左侧，二者仅对自定义条目展示。
        if (item.editable && onEdit) row.appendChild(buildEditBtn(item));
        if (item.deletable && onDelete) row.appendChild(buildDeleteBtn(item));
        row.addEventListener("click", function () {
          select(item.value);
        });
        listEl.appendChild(row);
      });
    }

    /** 触发按钮上的当前取值文案（图标型触发按钮没有 label 节点，直接跳过）。 */
    function renderLabel() {
      if (!labelEl) return;
      if (multi) {
        const picked = items
          .filter(function (item) {
            return isChecked(item.value);
          })
          .map(function (item) {
            return item.text;
          });
        labelEl.textContent = picked.length ? picked.join("、") : placeholder;
        labelEl.title = picked.join("、");
        return;
      }
      const cur = items.filter(function (i) {
        return i.value === value;
      })[0];
      labelEl.textContent = cur ? cur.text : "";
      labelEl.title = cur ? cur.text : "";
    }

    function render() {
      renderItems();
      renderLabel();
    }

    function select(next) {
      // 多选：只切换勾选并保持展开，调用方拿到的是「当前全部选中值」。
      if (multi) {
        const index = value.indexOf(next);
        if (index === -1) value.push(next);
        else value.splice(index, 1);
        render();
        if (onSelect) onSelect(readValue());
        return;
      }
      close();
      // 选中项与当前项相同时也要通知调用方：用户「再点一次当前项」是一个明确的
      // 应用手势（例如重新展开已收起的「自定义」日历），静默吞掉会让界面看起来
      // 毫无反应。重复应用同值的代价只是一次幂等的保存 / 渲染。
      if (next !== value) {
        value = next;
        render();
      }
      if (onSelect) onSelect(next);
    }

    toggleEl.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (listEl.hidden) open();
      else close();
    });
    // 点击浮层与触发按钮之外的区域、或按 Esc 收起下拉。
    // 列表已挂到 <body>，不再被 rootEl 包含，因此必须单独判断命中。
    const onDocumentClick = function (e) {
      // 命中判定必须按**事件派发时**的路径：多选点击后条目会整块重绘，被点的节点
      // 随即脱离文档树，此时 contains 既找不到它、也找不到它的祖先，会把刚勾选完的
      // 列表立刻关掉（单选无所谓，多选直接失效）。
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      if (path.indexOf(rootEl) !== -1 || path.indexOf(listEl) !== -1) return;
      if (rootEl.contains(e.target) || listEl.contains(e.target)) return;
      close();
    };
    const onDocumentKeydown = function (e) {
      if (e.key === "Escape") close();
    };
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onDocumentKeydown);
    // 捕获阶段监听滚动：既能捕捉窗口滚动，也能捕捉表单这类内部滚动容器。
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", onResize);

    return {
      setItems: function (nextItems, current) {
        items = nextItems || [];
        value = multi ? toArray(current) : current || "";
        close();
        render();
      },
      setValue: function (next) {
        value = multi ? toArray(next) : next;
        render();
      },
      // 外部配置更新时同步选中值；条目缺失时回落到 fallback。
      sync: function (next, fallback) {
        if (multi) {
          value = toArray(
            next === undefined || next === null ? fallback : next,
          );
          render();
          return;
        }
        const has = function (v) {
          return items.some(function (i) {
            return i.value === v;
          });
        };
        if (has(next)) value = next;
        else if (fallback && has(fallback)) value = fallback;
        render();
      },
      getValue: function () {
        return readValue();
      },
      // 条目宿主被重建时（如按客户端动态渲染的下拉）销毁实例：
      // 摘掉全局注册项与文档监听，避免注册表与监听器随重渲染无限增长。
      destroy: function () {
        const index = pickerRegistry.indexOf(self);
        if (index !== -1) pickerRegistry.splice(index, 1);
        document.removeEventListener("click", onDocumentClick);
        document.removeEventListener("keydown", onDocumentKeydown);
        window.removeEventListener("scroll", reposition, true);
        window.removeEventListener("resize", onResize);
        // 列表挂在 <body> 上，宿主被重建时一并摘掉，避免残留孤儿浮层。
        listEl.remove();
      },
    };
  }

  const bodyPicker = createPicker(
    widgetBodyPickerEl,
    function (value) {
      if (!config || !config.widget) return;
      // 切换成功给一条绿色轻提示；选中的还是当前值时不打扰。
      if (config.widget.widgetBody === value) return;
      config.widget.widgetBody = value;
      saveWidgetDebounced();
      notify("success", "已切换到挂件本体「" + value + "」");
    },
    function (item) {
      askDeleteWidgetGroup(item.value);
    },
    function (item) {
      openWidgetGroupEditor(item.value);
    },
  );

  const soundPicker = createPicker(
    widgetSoundPickerEl,
    function (value) {
      if (!config || !config.widget) return;
      if (config.widget.soundSet === value) return;
      config.widget.soundSet = value;
      saveWidgetDebounced();
      notify("success", "已切换到音效「" + value + "」");
    },
    function (item) {
      askDeleteSoundGroup(item.value);
    },
    function (item) {
      openSoundGroupEditor(item.value);
    },
  );

  // 币种切换：复用同一自定义选择器组件（币种为固定集合，不提供删除）。
  const currencyPicker = createPicker(
    displayCurrencyPickerEl,
    function (value) {
      callApi(
        "set_currency",
        { currency: value },
        {
          success: "币种已切换",
          errorPrefix: "切换币种失败",
        },
      )
        .then(function (widget) {
          config.widget = widget;
          currencyPicker.sync(
            CURRENCY_SYMBOL[widget && widget.displayCurrency]
              ? widget.displayCurrency
              : "CNY",
            "CNY",
          );
          refreshBalance();
        })
        .catch(function (err) {
          console.error("切换币种失败", err);
        });
    },
    null,
  );
  currencyPicker.setItems(CURRENCY_OPTIONS, "CNY");

  // 播放模式：同样使用自定义下拉，与币种切换等保持一致的交互与样式。
  const dialogueModePicker = createPicker(
    dialogueModePickerEl,
    function (value) {
      if (!config || !config.dialogue) return;
      config.dialogue.mode = value;
      saveDialogueDebounced();
    },
    null,
  );
  dialogueModePicker.setItems(DIALOGUE_MODE_OPTIONS, "random");

  // 图片编辑器「状态」：切换状态只决定保存到哪个状态文件，画布内容不变，故回调为空。
  const editorStatePicker = createPicker(editorStatePickerEl, function () {});

  // 列出全部挂件组（含默认组）：默认组使用内置资源，不可删除。
  function loadWidgetGroups() {
    return callApi("list_widget_groups", undefined, {
      errorPrefix: "加载挂件图片组失败",
    })
      .then(function (groups) {
        const list = Array.isArray(groups) ? groups : [];
        const cur =
          (config && config.widget && config.widget.widgetBody) || DEFAULT_BODY;
        const has = list.some(function (g) {
          return g === cur;
        });
        // 当前组已不存在（例如被删除）时回落到默认组。
        if (!has && config && config.widget)
          config.widget.widgetBody = DEFAULT_BODY;
        bodyPicker.setItems(
          list.map(function (g) {
            return {
              value: g,
              text: g,
              editable: g !== DEFAULT_BODY,
              deletable: g !== DEFAULT_BODY,
            };
          }),
          has ? cur : DEFAULT_BODY,
        );
      })
      .catch(function (err) {
        console.error("加载挂件图片组失败", err);
      });
  }

  // 二次确认后删除自定义挂件图片组及其全部图片资源。
  function askDeleteWidgetGroup(name) {
    showConfirm(
      "删除挂件图片组「" + name + "」？资源将被永久删除。",
      function () {
        deleteWidgetGroup(name);
      },
    );
  }

  function deleteWidgetGroup(name) {
    callApi(
      "delete_widget_group",
      { group: name },
      {
        success: "挂件图片组已删除",
        errorPrefix: "删除失败",
      },
    )
      .then(function () {
        if (config && config.widget && config.widget.widgetBody === name) {
          config.widget.widgetBody = DEFAULT_BODY;
        }
        return loadWidgetGroups();
      })
      .then(function () {
        saveWidgetDebounced();
      })
      .catch(function (err) {
        console.error("删除挂件图片组失败", err);
      });
  }

  // 二次确认后删除自定义音效组及其全部音频资源。
  function askDeleteSoundGroup(name) {
    showConfirm("删除音效「" + name + "」？资源将被永久删除。", function () {
      deleteSoundGroup(name);
    });
  }

  function deleteSoundGroup(name) {
    callApi(
      "delete_audio_group",
      { name: name },
      {
        success: "音效组已删除",
        errorPrefix: "删除失败",
      },
    )
      .then(function () {
        if (config && config.widget && config.widget.soundSet === name) {
          config.widget.soundSet = "duck";
        }
        return refreshSoundGroups();
      })
      .then(function () {
        saveWidgetDebounced();
      })
      .catch(function (err) {
        console.error("删除音效组失败", err);
      });
  }

  function openBodyNameModal() {
    bodyNameInputEl.value = "";
    bodyNameErrorEl.hidden = true;
    bodyNameModalEl.hidden = false;
    modalOverlayEl.hidden = false;
  }
  function closeBodyNameModal() {
    bodyNameModalEl.hidden = true;
    modalOverlayEl.hidden = true;
  }

  // 画布显示缩放：画布位图固定 480×480，显示尺寸跟随容器宽度等比缩放。
  // 1 表示未缩放；容器尚未可见（宽度为 0）时按 1 处理，避免除零。
  function editorViewScale() {
    if (!editorCanvasWrapEl) return 1;
    const width = editorCanvasWrapEl.clientWidth;
    return width > 0 ? width / EDITOR_CANVAS_SIZE : 1;
  }

  // 裁剪框与画布同坐标系（画布像素），显示时要乘上缩放系数才能贴合画面。
  function renderCropBox() {
    if (!editorCropBoxEl) return;
    const scale = editorViewScale();
    editorCropBoxEl.style.left = editorCropX * scale + "px";
    editorCropBoxEl.style.top = editorCropY * scale + "px";
    editorCropBoxEl.style.width = editorCropW * scale + "px";
    editorCropBoxEl.style.height = editorCropH * scale + "px";
  }

  function clampNum(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
  }

  // 当前比例对应的宽高比数值（自由裁剪返回 null）。
  function currentCropRatio() {
    return CROP_RATIOS[editorCropRatio] || null;
  }

  function syncRatioButtons() {
    Array.prototype.forEach.call(editorRatioBtns, function (btn) {
      btn.classList.toggle("active", btn.dataset.ratio === editorCropRatio);
    });
  }

  // 切换裁剪比例：以当前框中心为基准，取画布内可容纳的最大比例矩形。
  function applyCropRatio(name) {
    if (!Object.prototype.hasOwnProperty.call(CROP_RATIOS, name)) name = "free";
    editorCropRatio = name;
    syncRatioButtons();
    const ratio = currentCropRatio();
    if (!ratio) {
      renderCropBox();
      return;
    }
    const cx = editorCropX + editorCropW / 2;
    const cy = editorCropY + editorCropH / 2;
    let w = EDITOR_CANVAS_SIZE;
    let h = w / ratio;
    if (h > EDITOR_CANVAS_SIZE) {
      h = EDITOR_CANVAS_SIZE;
      w = h * ratio;
    }
    editorCropW = Math.max(CROP_MIN_SIZE, w);
    editorCropH = Math.max(CROP_MIN_SIZE, h);
    editorCropX = clampNum(
      cx - editorCropW / 2,
      0,
      EDITOR_CANVAS_SIZE - editorCropW,
    );
    editorCropY = clampNum(
      cy - editorCropH / 2,
      0,
      EDITOR_CANVAS_SIZE - editorCropH,
    );
    renderCropBox();
  }

  // 按拖动方向调整裁剪框边界；锁定比例时同步约束另一维度。
  function resizeCrop(dir, dx, dy) {
    const S = EDITOR_CANVAS_SIZE;
    const MIN = CROP_MIN_SIZE;
    const s = editorCropStart;
    const west = dir.indexOf("w") !== -1;
    const east = dir.indexOf("e") !== -1;
    const north = dir.indexOf("n") !== -1;
    const south = dir.indexOf("s") !== -1;

    let left = s.x;
    let top = s.y;
    let right = s.x + s.w;
    let bottom = s.y + s.h;
    if (west) left = clampNum(s.x + dx, 0, right - MIN);
    if (east) right = clampNum(s.x + s.w + dx, left + MIN, S);
    if (north) top = clampNum(s.y + dy, 0, bottom - MIN);
    if (south) bottom = clampNum(s.y + s.h + dy, top + MIN, S);

    let x = left;
    let y = top;
    let w = right - left;
    let h = bottom - top;

    const ratio = currentCropRatio();
    if (ratio) {
      const horiz = west || east;
      const vert = north || south;
      let nw;
      let nh;
      if (vert && !horiz) {
        nh = h;
        nw = nh * ratio;
      } else {
        nw = w;
        nh = nw / ratio;
      }
      // 锚定：拖动哪条边，其对边保持不动；角拖动锚定对角。
      if (west) x = s.x + s.w - nw;
      else if (east) x = s.x;
      if (north) y = s.y + s.h - nh;
      else if (south) y = s.y;
      // 单边拖动时另一维度居中对齐，符合主流裁剪交互。
      if (horiz && !vert) y = s.y + s.h / 2 - nh / 2;
      if (vert && !horiz) x = s.x + s.w / 2 - nw / 2;

      w = nw;
      h = nh;
      // 超出画布时等比收缩后贴边。
      if (w > S) {
        h *= S / w;
        w = S;
      }
      if (h > S) {
        w *= S / h;
        h = S;
      }
      x = clampNum(x, 0, S - w);
      y = clampNum(y, 0, S - h);
    }

    editorCropX = x;
    editorCropY = y;
    editorCropW = Math.max(MIN, w);
    editorCropH = Math.max(MIN, h);
    renderCropBox();
  }

  function renderEditor() {
    const c = editorCanvasEl;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    if (!editorImage) return;
    // 实际绘制倍率 = 档位 × 基准缩放（基准缩放保证 100% 时短边铺满画布）。
    const scale = editorZoom * editorBaseScale;
    ctx.save();
    ctx.translate(c.width / 2 + editorPanX, c.height / 2 + editorPanY);
    ctx.rotate((editorRotate * Math.PI) / 180);
    ctx.scale(scale, scale);
    ctx.drawImage(editorImage, -editorImage.width / 2, -editorImage.height / 2);
    ctx.restore();
    renderCropBox();
  }

  // 载入编辑器图片；state 用于编辑已有图片组时保持原状态。
  function loadEditorImage(dataUrl, state) {
    const img = new Image();
    img.onload = function () {
      editorImage = img;
      editorRotate = 0;
      editorPanX = 0;
      editorPanY = 0;
      // 统一起始尺寸：以短边为基准缩放到 610px 输出空间（即 100% 档位），
      // 与内置小鲸鱼 610×610 一致；长边等比放大，默认即铺满整个编辑窗口。
      const shortSide = Math.max(1, Math.min(img.width, img.height));
      editorBaseScale = EDITOR_CANVAS_SIZE / shortSide;
      editorZoom = ZOOM_MIN;
      editorZoomEl.value = String(editorZoom);
      editorZoomValEl.textContent = Math.round(editorZoom * 100) + "%";
      editorRotateEl.value = "0";
      editorRotateValEl.textContent = "0°";
      editorStatePicker.sync(state || "main", "main");
      editorRemoveBgEl.checked = false;
      editorRemoveBgEl.disabled = false;
      editorProcessingEl.hidden = true;
      editorCanvasEl.width = EDITOR_CANVAS_SIZE;
      editorCanvasEl.height = EDITOR_CANVAS_SIZE;
      // 重置裁剪框为整幅画布，并回到自由裁剪。
      editorCropX = 0;
      editorCropY = 0;
      editorCropW = EDITOR_CANVAS_SIZE;
      editorCropH = EDITOR_CANVAS_SIZE;
      editorCropRatio = "free";
      syncRatioButtons();
      editorCropEl.hidden = false;
      // 先显形再渲染：隐藏状态下画布容器宽度为 0，量不到真实的显示缩放。
      editorOverlayEl.hidden = false;
      renderEditor();
    };
    img.onerror = function () {
      console.error("编辑器图片加载失败");
      notify("error", "图片加载失败，请重新选择图片");
    };
    img.src = dataUrl;
  }

  function closeEditor() {
    editorOverlayEl.hidden = true;
    editorImage = null;
    editorGroup = null;
    editorExisting = false;
  }

  // 打开某个自定义图片组的编辑页面：载入该组既有资源，支持新增 / 修改状态。
  function openWidgetGroupEditor(group) {
    return callApi(
      "read_widget_group_meta",
      { group: group },
      {
        errorPrefix: "读取挂件元数据失败",
      },
    )
      .then(function (meta) {
        const states = (meta && meta.states) || {};
        // 优先编辑主图，其次取该组第一个已存在的状态。
        const state =
          WIDGET_STATES.map(function (s) {
            return s.key;
          }).filter(function (key) {
            return !!states[key];
          })[0] || null;
        if (!state) throw new Error("该图片组暂无可用图片");
        return callApi(
          "read_widget_image",
          { group: group, state: state },
          { errorPrefix: "读取挂件图片失败" },
        ).then(function (dataUrl) {
          editorGroup = group;
          // 编辑既有图片组：保存后不改变当前挂件本体。
          editorExisting = true;
          loadEditorImage(dataUrl, state);
        });
      })
      .catch(function (err) {
        console.error("打开图片编辑失败", err);
      });
  }

  // 编辑器内“重新上传图片”：调用系统文件选择器，替换当前图片组的当前状态资源。
  function replaceEditorImage() {
    if (!editorGroup) return;
    callApi("pick_image_file", undefined, { errorPrefix: "选择图片失败" })
      .then(function (dataUrl) {
        // 保留当前图片组与状态，仅替换图像内容，保存后即写回该组。
        loadEditorImage(dataUrl, editorStatePicker.getValue());
      })
      .catch(function (err) {
        // 用户取消选择时静默返回。
        if (String(err).indexOf("未选择图片") !== -1) return;
        console.error("重新上传图片失败", err);
      });
  }

  function editorSave() {
    if (!editorGroup || !editorImage) return;
    const state = editorStatePicker.getValue();
    // 仅截取裁剪框内区域，长边对齐 OUTPUT_SIZE，保持宽高比与透明度（PNG）。
    const cw = Math.max(
      1,
      Math.min(editorCropW, EDITOR_CANVAS_SIZE - editorCropX),
    );
    const ch = Math.max(
      1,
      Math.min(editorCropH, EDITOR_CANVAS_SIZE - editorCropY),
    );
    const longSide = Math.max(cw, ch);
    const outW = Math.max(1, Math.round((cw / longSide) * OUTPUT_SIZE));
    const outH = Math.max(1, Math.round((ch / longSide) * OUTPUT_SIZE));
    const out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    const octx = out.getContext("2d");
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(
      editorCanvasEl,
      editorCropX,
      editorCropY,
      cw,
      ch,
      0,
      0,
      outW,
      outH,
    );
    const dataUrl = out.toDataURL("image/png");
    callApi(
      "save_widget_image",
      {
        group: editorGroup,
        state: state,
        data: dataUrl,
      },
      {
        // 上传期间用黄色轻提示反馈进度，不打断编辑。
        busy: "正在保存图片…",
        success: "图片已保存",
        errorPrefix: "保存图片失败",
      },
    )
      .then(function () {
        // 新上传的图片组保存后切换为当前挂件本体，实现「上传即替换」；
        // 编辑既有图片组则保持当前挂件本体不变。
        if (!editorExisting && config && config.widget) {
          config.widget.widgetBody = editorGroup;
          saveWidgetDebounced();
        }
        closeEditor();
        loadWidgetGroups();
      })
      .catch(function (err) {
        console.error("保存挂件图片失败", err);
      });
  }

  function setEditorProcessing(on) {
    editorProcessingEl.hidden = !on;
    editorRemoveBgEl.disabled = on;
    editorZoomEl.disabled = on;
    editorRotateEl.disabled = on;
    editorStateToggleEl.disabled = on;
    editorSaveEl.disabled = on;
    editorCancelEl.disabled = on;
    editorCropBoxEl.style.pointerEvents = on ? "none" : "auto";
    Array.prototype.forEach.call(editorRatioBtns, function (btn) {
      btn.disabled = on;
    });
  }

  function editorProcessBackground() {
    if (!editorImage || editorRemoveBgEl.disabled) return;
    setEditorProcessing(true);
    editorProcessingBarEl.value = 0;
    const timer = setInterval(function () {
      if (editorProcessingBarEl.value < 90) editorProcessingBarEl.value += 2;
    }, 200);
    // 用原始图片（未缩放/旋转/平移）作为抠图入参，保证不同视图下结果一致。
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = editorImage.width;
    srcCanvas.height = editorImage.height;
    srcCanvas.getContext("2d").drawImage(editorImage, 0, 0);
    const dataUrl = srcCanvas.toDataURL("image/png");
    callApi(
      "remove_background",
      { data: dataUrl },
      {
        // 已有进度覆盖层，这里只补一条黄色进度轻提示。
        busy: "正在智能抠图…",
        success: "抠图完成",
        errorPrefix: "抠图失败",
      },
    )
      .then(function (result) {
        clearInterval(timer);
        editorProcessingBarEl.value = 100;
        const img = new Image();
        img.onload = function () {
          editorImage = img;
          renderEditor();
          setEditorProcessing(false);
        };
        img.onerror = function () {
          clearInterval(timer);
          setEditorProcessing(false);
          editorRemoveBgEl.checked = false;
          notify("error", "抠图失败：图片加载失败");
        };
        img.src = result;
      })
      .catch(function () {
        clearInterval(timer);
        setEditorProcessing(false);
        editorRemoveBgEl.checked = false;
      });
  }

  uploadBodyBtnEl.addEventListener("click", openBodyNameModal);
  bodyNameOkEl.addEventListener("click", function () {
    const name = bodyNameInputEl.value.trim();
    if (!name) {
      bodyNameErrorEl.hidden = false;
      bodyNameInputEl.focus();
      return;
    }
    bodyNameErrorEl.hidden = true;
    closeBodyNameModal();
    callApi("pick_image_file", undefined, { errorPrefix: "选择图片失败" })
      .then(function (dataUrl) {
        editorGroup = name;
        loadEditorImage(dataUrl);
      })
      .catch(function (err) {
        // 用户取消选择时静默返回，其余错误给出明确提示并记录日志。
        if (String(err).indexOf("未选择图片") !== -1) return;
        console.error("选择图片失败", err);
      });
  });
  bodyNameCancelEl.addEventListener("click", closeBodyNameModal);

  editorZoomEl.addEventListener("input", function () {
    const v = Number(editorZoomEl.value);
    // 双重钳制：仅允许放大，任何情况下都不得小于 100%（短边 610px）。
    editorZoom = Math.min(
      ZOOM_MAX,
      Math.max(ZOOM_MIN, isFinite(v) ? v : ZOOM_MIN),
    );
    editorZoomEl.value = String(editorZoom);
    editorZoomValEl.textContent = Math.round(editorZoom * 100) + "%";
    renderEditor();
  });
  editorRotateEl.addEventListener("input", function () {
    editorRotate = Number(editorRotateEl.value) || 0;
    editorRotateValEl.textContent = editorRotate + "°";
    renderEditor();
  });
  editorSaveEl.addEventListener("click", editorSave);
  editorCancelEl.addEventListener("click", closeEditor);
  editorReplaceImageEl.addEventListener("click", replaceEditorImage);
  // ===== 抠图模型按需下载 =====
  function resetMattingSwitch() {
    editorRemoveBgEl.checked = false;
  }

  function closeDownloadModal() {
    downloadConfirmModalEl.hidden = true;
    downloadErrorModalEl.hidden = true;
    downloadModalOverlayEl.hidden = true;
  }

  function openDownloadConfirm() {
    downloadErrorModalEl.hidden = true;
    downloadConfirmModalEl.hidden = false;
    downloadModalOverlayEl.hidden = false;
  }

  function openDownloadError(err) {
    downloadConfirmModalEl.hidden = true;
    downloadErrorMsgEl.textContent = String(err || "下载失败");
    downloadErrorModalEl.hidden = false;
    downloadModalOverlayEl.hidden = false;
  }

  function startModelDownload() {
    if (mattingDownloadActive) return;
    mattingDownloadActive = true;
    closeDownloadModal();
    downloadOverlayEl.hidden = false;
    downloadPercentEl.textContent = "0%";
    downloadBarEl.value = 0;
    callApi("download_matting_model", undefined, {
      // 失败已有专门的下载失败弹窗，避免重复弹窗。
      success: "抠图模型下载完成",
      silent: true,
    })
      .then(function () {
        mattingDownloadActive = false;
        downloadOverlayEl.hidden = true;
        if (editorRemoveBgEl.checked) {
          editorProcessBackground();
        }
      })
      .catch(function (err) {
        mattingDownloadActive = false;
        downloadOverlayEl.hidden = true;
        openDownloadError(err);
      });
  }

  editorRemoveBgEl.addEventListener("change", function () {
    if (!editorRemoveBgEl.checked) return;
    callApi("matting_model_ready", undefined, {
      errorPrefix: "检查抠图模型状态失败",
    })
      .then(function (ready) {
        if (ready) {
          editorProcessBackground();
        } else {
          openDownloadConfirm();
        }
      })
      .catch(function () {
        resetMattingSwitch();
      });
  });

  downloadConfirmYesEl.addEventListener("click", startModelDownload);
  downloadConfirmNoEl.addEventListener("click", function () {
    closeDownloadModal();
    resetMattingSwitch();
  });
  downloadRetryEl.addEventListener("click", function () {
    closeDownloadModal();
    startModelDownload();
  });
  downloadCancelEl.addEventListener("click", function () {
    closeDownloadModal();
    resetMattingSwitch();
  });
  // 所有弹窗 / 页面一律只由显式按钮关闭：不再监听遮罩上的点击，
  // 避免误触空白处导致数据丢失。

  editorCanvasEl.addEventListener("mousedown", function (e) {
    editorDragging = true;
    editorLastX = e.clientX;
    editorLastY = e.clientY;
  });
  window.addEventListener("mousemove", function (e) {
    if (!editorDragging) return;
    // 画布按容器宽度等比缩放：屏幕位移要换算回画布坐标，否则窄窗口下拖动会「跑得快」。
    const viewScale = editorViewScale();
    editorPanX += (e.clientX - editorLastX) / viewScale;
    editorPanY += (e.clientY - editorLastY) / viewScale;
    editorLastX = e.clientX;
    editorLastY = e.clientY;
    renderEditor();
  });
  window.addEventListener("mouseup", function () {
    editorDragging = false;
    editorCropMode = null;
    editorCropStart = null;
  });

  // 裁剪交互：拖动框体移动位置，拖动 8 个手柄调整边界。
  function beginCropDrag(e) {
    editorCropStart = {
      x: editorCropX,
      y: editorCropY,
      w: editorCropW,
      h: editorCropH,
      px: e.clientX,
      py: e.clientY,
    };
  }

  editorCropBoxEl.addEventListener("mousedown", function (e) {
    e.stopPropagation();
    if (editorRemoveBgEl.disabled) return;
    editorCropMode = "move";
    beginCropDrag(e);
  });
  Array.prototype.forEach.call(editorCropHandles, function (handle) {
    handle.addEventListener("mousedown", function (e) {
      e.stopPropagation();
      e.preventDefault();
      if (editorRemoveBgEl.disabled) return;
      editorCropMode = handle.dataset.dir;
      beginCropDrag(e);
    });
  });
  window.addEventListener("mousemove", function (e) {
    if (!editorCropMode || !editorCropStart) return;
    // 屏幕位移 → 画布坐标：必须按画布显示缩放换算，否则缩放后拖动与鼠标不同步。
    const viewScale = editorViewScale();
    const dx = (e.clientX - editorCropStart.px) / viewScale;
    const dy = (e.clientY - editorCropStart.py) / viewScale;
    if (editorCropMode === "move") {
      editorCropX = clampNum(
        editorCropStart.x + dx,
        0,
        EDITOR_CANVAS_SIZE - editorCropW,
      );
      editorCropY = clampNum(
        editorCropStart.y + dy,
        0,
        EDITOR_CANVAS_SIZE - editorCropH,
      );
      renderCropBox();
      return;
    }
    resizeCrop(editorCropMode, dx, dy);
  });

  // 常用裁剪比例快捷切换。
  Array.prototype.forEach.call(editorRatioBtns, function (btn) {
    btn.addEventListener("click", function () {
      if (editorRemoveBgEl.disabled) return;
      applyCropRatio(btn.dataset.ratio);
    });
  });

  // 窗口尺寸变化会改变画布的显示缩放：重新把裁剪框贴合到画面上。
  window.addEventListener("resize", function () {
    if (!editorOverlayEl.hidden) renderCropBox();
  });

  populateWidgetStateSelect();

  // 把一份完整配置回填到全部表单控件。
  // 首次加载与「重置设置」共用同一份回填逻辑，避免两处走样。
  function applyConfigToUi(cfg) {
    config = cfg;
    if (autostartEl) autostartEl.checked = !!cfg.autostart;
    if (tokenUsageEl) tokenUsageEl.checked = !!cfg.tokenUsage;
    applyTheme(cfg.globalTheme || "light");
    // 注意：这里用字面量而非后面的 DEFAULT_COLOR 常量——首次加载时该常量尚在
    // 暂时性死区中（const 声明在其后），引用会直接抛 ReferenceError。
    const color = cfg.globalColor || "#203170";
    if (globalColorEl) globalColorEl.value = String(hueFromHex(color));
    applyGlobalColor(color);
    applyWidgetToUi(cfg.widget || {});
    applyDialogueToUi(cfg.dialogue);
    // 模块化气泡（bubble-config.js 独立成文件）：首次加载与「恢复默认设置」共用这一处。
    // 一并把挂件实际使用的「气泡颜色」传过去，预览气泡的描边才能与桌面完全一致
    // （配置里的颜色未必落在色相滑杆的 HSL 映射上）。
    if (window.DSB) {
      window.DSB.applyConfig(cfg.bubble, cfg.widget && cfg.widget.bubbleColor);
    }
    loadWidgetGroups();
    refreshSoundGroups();
  }

  // 丢弃尚未触发的防抖保存：重置前后若把旧表单值写回磁盘，重置结果会被覆盖。
  function cancelPendingSaves() {
    if (saveTimer) clearTimeout(saveTimer);
    if (widgetSaveTimer) clearTimeout(widgetSaveTimer);
    if (dialogueSaveTimer) clearTimeout(dialogueSaveTimer);
    saveTimer = null;
    widgetSaveTimer = null;
    dialogueSaveTimer = null;
  }

  callApi("get_config", undefined, { errorPrefix: "加载配置失败" })
    .then(applyConfigToUi)
    .catch(function (err) {
      console.error("加载配置失败", err);
    });

  // 接收配置窗口外部更新，保持表单与挂件显示同步。
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen("widget-config-changed", function (e) {
      if (!config) return;
      applyWidgetToUi(e.payload);
    });
    window.__TAURI__.event.listen(
      "matting-model-download-progress",
      function (e) {
        const percent = Math.max(0, Math.min(100, Number(e.payload) || 0));
        downloadPercentEl.textContent = percent + "%";
        downloadBarEl.value = percent;
      },
    );
  }

  // 滑杆档位映射为实际缩放倍率后再保存。
  widgetScaleEl.addEventListener("input", function (e) {
    const level = Math.max(
      LEVEL_MIN,
      Math.min(LEVEL_MAX, Math.round(Number(e.target.value) || LEVEL_MIN)),
    );
    config.widget.scale = Math.round(numToScale(level) * 10) / 10;
    widgetScaleValEl.textContent = String(level);
    saveWidgetDebounced();
  });

  // 新增台词后直接聚焦最后一项，便于连续录入。
  if (addLineEl)
    addLineEl.addEventListener("click", function () {
      if (!config || !config.dialogue) return;
      expandDialogue();
      config.dialogue.lines.push("");
      renderDialogueList();
      saveDialogueDebounced();
      const inputs = dialogueListEl.querySelectorAll(".dialogue-input");
      if (inputs.length) inputs[inputs.length - 1].focus();
    });

  // 一键恢复默认台词集合。
  if (resetLinesEl)
    resetLinesEl.addEventListener("click", function () {
      if (!config || !config.dialogue) return;
      expandDialogue();
      config.dialogue.lines = DEFAULT_LINES.slice();
      renderDialogueList();
      saveDialogueDebounced();
    });

  if (dialogueIntervalEl)
    bindIntegerInput(
      dialogueIntervalEl,
      function () {
        return config.dialogue.intervalMin;
      },
      function (v) {
        config.dialogue.intervalMin = v;
      },
      saveDialogueDebounced,
    );

  if (dialogueJitterEl)
    dialogueJitterEl.addEventListener("input", function (e) {
      if (!config || !config.dialogue) return;
      const v = Math.max(
        0,
        Math.min(100, Math.round(Number(e.target.value) || 0)),
      );
      config.dialogue.jitter = v;
      dialogueJitterValEl.textContent = v + "%";
      saveDialogueDebounced();
    });

  if (toggleDialogueEl)
    toggleDialogueEl.addEventListener("click", function () {
      const collapsed = dialogueCardEl.classList.toggle("collapsed");
      toggleDialogueEl.textContent = collapsed ? "展开" : "收起";
      toggleDialogueEl.setAttribute(
        "aria-expanded",
        collapsed ? "false" : "true",
      );
    });

  // 「挂件配置」内的高级设置折叠面板：点击标题展开/收起。
  if (advToggleEl && advCardEl)
    advToggleEl.addEventListener("click", function () {
      const collapsed = advCardEl.classList.toggle("collapsed");
      advToggleEl.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });

  // 「挂件配置」内的挂件状态折叠面板：交互与高级设置完全一致。
  if (stateToggleEl && stateCardEl)
    stateToggleEl.addEventListener("click", function () {
      const collapsed = stateCardEl.classList.toggle("collapsed");
      stateToggleEl.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });

  // 色相滑杆 -> Hex 主题色。
  function hexFromHue(hue) {
    // 简单 HSL(hue, 62%, 42%) → rgb → hex（中等偏浅饱和度）。
    const s = 0.62,
      l = 0.42;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0,
      g = 0,
      b = 0;
    if (hue < 60) {
      r = c;
      g = x;
    } else if (hue < 120) {
      r = x;
      g = c;
    } else if (hue < 180) {
      g = c;
      b = x;
    } else if (hue < 240) {
      g = x;
      b = c;
    } else if (hue < 300) {
      r = x;
      b = c;
    } else {
      r = c;
      b = x;
    }
    const to = function (v) {
      return Math.round((v + m) * 255)
        .toString(16)
        .padStart(2, "0");
    };
    return "#" + to(r) + to(g) + to(b);
  }

  // Hex 主题色 -> 色相滑杆值。
  function hueFromHex(hex) {
    if (!hex) return 220;
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex));
    if (!m) return 220;
    const n = parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d === 0) h = 0;
    else if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
    return h;
  }

  // 全局颜色 → 主题适配色板。
  //
  // 全局颜色是以**行内样式**写到 :root 上的，行内样式优先级高于样式表，
  // 因此「深色主题下文字转亮色」必须在 JS 侧派生，光靠 CSS 覆盖不掉。
  // 浅色 / 毛玻璃：原样使用用户选择的颜色（毛玻璃面板本身是浅色）；
  // 深色：沿原色相提亮，保证深底上文字清晰可读。
  //
  // `target` 是 [r, g, b]：浅色系主题往白里调、深色主题往黑里调，方向由调用方给。
  function mixToward(hex, target, ratio) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ""));
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return (
      "#" +
      channels
        .map(function (value, index) {
          return Math.round(value + (target[index] - value) * ratio)
            .toString(16)
            .padStart(2, "0");
        })
        .join("")
    );
  }

  function mixWithWhite(hex, ratio) {
    return mixToward(hex, [255, 255, 255], ratio);
  }

  function themePalette(color) {
    if (document.documentElement.getAttribute("data-theme") !== "dark") {
      return {
        primary: color,
        primary2: color,
        text: color,
        muted: color,
        border: color + "26",
      };
    }
    return {
      primary: mixWithWhite(color, 0.55),
      primary2: mixWithWhite(color, 0.72),
      text: mixWithWhite(color, 0.86),
      muted: mixWithWhite(color, 0.5),
      border: "rgba(255, 255, 255, 0.16)",
    };
  }

  // 最近一次生效的全局颜色（切换主题时据此重新派生色板）。
  let globalColorValue = "#203170";

  // 相对亮度（WCAG 定义），用于挑「主色实底上的文字色」。
  function relativeLuminance(hex) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ""));
    if (!m) return 0;
    const n = parseInt(m[1], 16);
    const channel = function (value) {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return (
      0.2126 * channel((n >> 16) & 255) +
      0.7152 * channel((n >> 8) & 255) +
      0.0722 * channel(n & 255)
    );
  }

  function contrastRatio(lumA, lumB) {
    const hi = Math.max(lumA, lumB);
    const lo = Math.min(lumA, lumB);
    return (hi + 0.05) / (lo + 0.05);
  }

  // 主色实底（确认按钮 / 徽标 / 选中态）上的文字色：在「白 → 深墨 → 纯黑」里挑第一个
  // 与底色对比度 ≥4.5:1 的取值。全局颜色由色相滑杆生成，黄色 / 青色这类亮主色下白字
  // 只有 2.4:1，必须自动转深色才能满足 WCAG AA。
  function onPrimaryColor(background) {
    const candidates = ["#ffffff", "#0b1020", "#000000"];
    const bgLum = relativeLuminance(background);
    for (let i = 0; i < candidates.length; i += 1) {
      if (contrastRatio(bgLum, relativeLuminance(candidates[i])) >= 4.5) {
        return candidates[i];
      }
    }
    return "#ffffff";
  }

  // 把全局主题色写回 CSS 变量，驱动配置页配色（按当前主题适配明度）。
  function applyGlobalColor(color) {
    globalColorValue = color || "#203170";
    const palette = themePalette(globalColorValue);
    const root = document.documentElement.style;
    root.setProperty("--primary", palette.primary);
    root.setProperty("--primary-2", palette.primary2);
    root.setProperty("--text", palette.text);
    root.setProperty("--muted", palette.muted);
    root.setProperty("--border", palette.border);
    // 实底文字的取值跟着主色走，保证「跟随全局颜色」时对比度始终达标。
    root.setProperty("--on-primary", onPrimaryColor(palette.primary));
    // 图表配色三档：金额柱用第一档，模型 Token 的三个维度（命中缓存 / 未命中缓存 /
    // 输出）依次用三档，从而「改一次全局颜色 → 所有柱状图同步改色」。
    // 派生方向跟着面板明暗走：浅色系主题往白里调（在白底上拉开层次），
    // 深色主题往黑里调（深底上继续往白里调会糊成一片）。
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    const toward = dark ? [0, 0, 0] : [255, 255, 255];
    const steps = dark ? [0.24, 0.46] : [0.34, 0.58];
    root.setProperty("--chart-bar", palette.primary2);
    root.setProperty(
      "--chart-bar-2",
      mixToward(palette.primary2, toward, steps[0]),
    );
    root.setProperty(
      "--chart-bar-3",
      mixToward(palette.primary2, toward, steps[1]),
    );
    // 图表（ECharts）把颜色直接写进 canvas，认不出 var(--x)：颜色或主题变了必须让
    // 它们重绘一次。供应商模块监听这个事件刷新用量页的柱状图，不必重开面板。
    document.dispatchEvent(new CustomEvent("dsw:palette-changed"));
  }

  // ===== 自定义音效上传与编辑 =====

  const SOUND_RATE_MIN = 0.1;
  const SOUND_RATE_MAX = 2;
  const SOUND_MAX_NAME_LEN = 32;
  const audioEngine = window.DSWAudio || null;
  // 引导弹窗中选中的音效模式（"press" 仅按下 / "release" 仅松开 / "dual" 按下松开）。
  let soundMode = "press";
  // 当前编辑草稿：{ name, mode, session, slots: { press, release } }。
  let soundDraft = null;
  // 上传序号：每次上传使用新的解码缓存键，避免复用上一份音频缓冲。
  let soundSlotSeq = 0;

  // 音效模式归一化：历史值 single 等价于 press，非法值一律回落 press。
  function audioModeOf(mode) {
    if (mode === "dual") return "dual";
    if (mode === "release") return "release";
    return "press";
  }

  // 某模式下需要的槽位列表（顺序即界面顺序）。
  function slotsOfMode(mode) {
    if (mode === "dual") return ["press", "release"];
    if (mode === "release") return ["release"];
    return ["press"];
  }

  // 点击音效上传入口：先引导输入音效名称并选择音效模式。
  if (addCustomSoundEl)
    addCustomSoundEl.addEventListener("click", function () {
      openSoundNameModal();
    });

  // 打开「音效名称 + 模式」引导弹窗。
  function openSoundNameModal() {
    soundNameInputEl.value = "";
    soundNameErrorEl.hidden = true;
    setSoundMode("press");
    soundNameModalEl.hidden = false;
    modalOverlayEl.hidden = false;
    soundNameInputEl.focus();
  }

  // 切换模式选择按钮的高亮状态。
  function setSoundMode(mode) {
    soundMode = audioModeOf(mode);
    const btns = soundModePickerEl.querySelectorAll(".audio-mode-btn");
    for (let i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("active", btns[i].dataset.mode === soundMode);
    }
  }

  // 校验音效名称（与后端目录命名规则一致）。
  function validateSoundName(name) {
    if (!name) return "请输入音效名称";
    if (name.length > SOUND_MAX_NAME_LEN)
      return "音效名称不能超过 " + SOUND_MAX_NAME_LEN + " 个字符";
    if (/[\\/:]/.test(name) || name === "." || name === "..")
      return "音效名称包含非法字符";
    return "";
  }

  // 确认名称与模式：单槽位模式先唤起上传器，组合模式直接进入编辑窗口。
  function confirmSoundName() {
    const name = soundNameInputEl.value.trim();
    const err = validateSoundName(name);
    if (err) {
      soundNameErrorEl.textContent = err;
      soundNameErrorEl.hidden = false;
      return;
    }
    const mode = audioModeOf(soundMode);
    hideModal();
    if (mode === "dual") {
      openAudioEditor(name, mode);
      return;
    }
    // 单槽位模式（仅按下 / 仅松开）：只上传该模式需要的那一路音频。
    const slot = slotsOfMode(mode)[0];
    callApi("pick_audio_file", undefined, { errorPrefix: "选择音效失败" })
      .then(function (path) {
        if (!path) return;
        openAudioEditor(name, mode);
        return loadPickedAudio(soundDraft.slots[slot], path);
      })
      .catch(function () {
        // 失败详情已由 callApi 统一以红色弹窗展示，此处仅终止链路。
      });
  }

  soundModePickerEl.addEventListener("click", function (e) {
    const btn = e.target.closest(".audio-mode-btn");
    if (btn) setSoundMode(btn.dataset.mode);
  });
  soundNameOkEl.addEventListener("click", confirmSoundName);
  soundNameCancelEl.addEventListener("click", hideModal);
  soundNameInputEl.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmSoundName();
    }
  });

  // 打开音效编辑窗口：按模式只渲染该模式启用的槽位
  // （仅按下 → 按下；仅松开 → 松开；按下松开 → 两个槽位）。
  function openAudioEditor(name, mode) {
    const normalized = audioModeOf(mode);
    const titles = {
      press: "音效编辑（仅按下）",
      release: "音效编辑（仅松开）",
      dual: "音效编辑（按下 + 松开）",
    };
    soundDraft = {
      name: name,
      mode: normalized,
      session: Date.now(),
      slots: {},
    };
    audioEditorTitleEl.textContent = titles[normalized];
    audioSlotsEl.innerHTML = "";
    slotsOfMode(normalized).forEach(function (slot) {
      const st = createAudioSlot(slot, slot === "release" ? "松开" : "按下");
      audioSlotsEl.appendChild(st.els.panel);
      soundDraft.slots[slot] = st;
    });
    audioEditorOverlayEl.hidden = false;
  }

  // 打开既有音效组的编辑窗口：按 meta.json 的模式回填启用槽位的全部参数。
  function openSoundGroupEditor(name) {
    return callApi(
      "resolve_audio_group",
      { name: name },
      {
        errorPrefix: "打开音效编辑失败",
      },
    )
      .then(function (group) {
        if (!group) {
          notify("error", "打开音效编辑失败：音效组不存在");
          return null;
        }
        const mode = audioModeOf(group.mode);
        openAudioEditor(name, mode);
        // 编辑既有音效组：保存后不改变当前选中的音效。
        soundDraft.existing = true;
        const jobs = [];
        slotsOfMode(mode).forEach(function (slot) {
          const clip = group[slot];
          if (clip) jobs.push(loadExistingAudio(soundDraft.slots[slot], clip));
        });
        return Promise.all(jobs);
      })
      .catch(function () {
        // 失败详情已由 callApi 统一以红色弹窗展示。
      });
  }

  // 关闭编辑窗口：终止试听、释放解码缓存并丢弃草稿。
  function closeAudioEditor() {
    audioEditorOverlayEl.hidden = true;
    audioSlotsEl.innerHTML = "";
    if (audioEngine) {
      audioEngine.stopAll();
      audioEngine.clearCache();
    }
    soundDraft = null;
  }

  // 创建一个波形编辑槽位（波形图 + 上传 + 试听 + 变速 + 拖拽裁剪）。
  function createAudioSlot(slot, label) {
    const st = {
      slot: slot,
      label: label,
      key: "",
      file: "",
      srcPath: null,
      buffer: null,
      duration: 0,
      start: 0,
      end: 0,
      rate: 1,
    };

    const panel = document.createElement("div");
    panel.className = "audio-slot";

    const head = document.createElement("div");
    head.className = "audio-slot-head";
    const title = document.createElement("span");
    title.className = "audio-slot-title";
    title.textContent = label;
    const uploadBtn = document.createElement("button");
    uploadBtn.type = "button";
    uploadBtn.className = "toggle-eye";
    uploadBtn.textContent = "上传音频";
    head.appendChild(title);
    head.appendChild(uploadBtn);

    const wave = document.createElement("div");
    wave.className = "audio-wave";
    const canvas = document.createElement("canvas");
    canvas.className = "audio-wave-canvas";
    const mask = document.createElement("div");
    mask.className = "audio-wave-mask";
    const sel = document.createElement("div");
    sel.className = "audio-wave-sel";
    sel.hidden = true;
    const handleL = document.createElement("span");
    handleL.className = "audio-wave-handle";
    handleL.dataset.dir = "l";
    const handleR = document.createElement("span");
    handleR.className = "audio-wave-handle";
    handleR.dataset.dir = "r";
    sel.appendChild(handleL);
    sel.appendChild(handleR);
    mask.appendChild(sel);
    const hint = document.createElement("div");
    hint.className = "audio-wave-hint";
    hint.textContent = "尚未上传音频";
    wave.appendChild(canvas);
    wave.appendChild(mask);
    wave.appendChild(hint);

    const tools = document.createElement("div");
    tools.className = "audio-tools";
    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.className = "toggle-eye";
    previewBtn.textContent = "试听";
    previewBtn.disabled = true;
    const rateLabel = document.createElement("label");
    rateLabel.className = "audio-rate";
    const rateText = document.createElement("span");
    rateText.textContent = "变速";
    const rateInput = document.createElement("input");
    rateInput.type = "range";
    rateInput.min = String(SOUND_RATE_MIN);
    rateInput.max = String(SOUND_RATE_MAX);
    rateInput.step = "0.1";
    rateInput.value = "1";
    rateInput.disabled = true;
    const rateVal = document.createElement("span");
    rateVal.className = "audio-rate-val";
    rateVal.textContent = "1.0x";
    rateLabel.appendChild(rateText);
    rateLabel.appendChild(rateInput);
    rateLabel.appendChild(rateVal);
    const rangeText = document.createElement("span");
    rangeText.className = "audio-slot-range";
    rangeText.textContent = "未上传音频";
    tools.appendChild(previewBtn);
    tools.appendChild(rateLabel);
    tools.appendChild(rangeText);

    panel.appendChild(head);
    panel.appendChild(wave);
    panel.appendChild(tools);

    st.els = {
      panel: panel,
      canvas: canvas,
      mask: mask,
      sel: sel,
      hint: hint,
      previewBtn: previewBtn,
      rateInput: rateInput,
      rateVal: rateVal,
      rangeText: rangeText,
    };

    uploadBtn.addEventListener("click", function () {
      pickAndLoad(st);
    });
    previewBtn.addEventListener("click", function () {
      previewSlot(st);
    });
    rateInput.addEventListener("input", function () {
      st.rate = clampRate(Number(rateInput.value));
      rateVal.textContent = st.rate.toFixed(1) + "x";
    });
    bindWaveSelection(st);
    return st;
  }

  // 倍速吸附到 0.1–2.0，步长 0.1。
  function clampRate(v) {
    if (!isFinite(v)) return 1;
    const r = Math.round(v * 10) / 10;
    return Math.min(SOUND_RATE_MAX, Math.max(SOUND_RATE_MIN, r));
  }

  // 波形图上拖拽选择裁剪区间：空白处拖拽新建，左右手柄调整边界。
  function bindWaveSelection(st) {
    const mask = st.els.mask;
    let drag = null;

    function ratioFromEvent(e) {
      const rect = mask.getBoundingClientRect();
      if (!rect.width) return 0;
      return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    }

    mask.addEventListener("pointerdown", function (e) {
      if (!st.buffer) return;
      e.preventDefault();
      try {
        mask.setPointerCapture(e.pointerId);
      } catch (err) {}
      const dir = e.target && e.target.dataset ? e.target.dataset.dir : "";
      const ratio = ratioFromEvent(e);
      if (dir === "l" || dir === "r") {
        drag = { mode: dir, anchor: ratio };
        return;
      }
      const t = ratio * st.duration;
      st.start = t;
      st.end = t;
      drag = { mode: "new", anchor: ratio };
      renderWaveSelection(st);
    });

    mask.addEventListener("pointermove", function (e) {
      if (!drag || !st.buffer) return;
      const t = ratioFromEvent(e) * st.duration;
      if (drag.mode === "new") {
        const anchor = drag.anchor * st.duration;
        st.start = Math.min(anchor, t);
        st.end = Math.max(anchor, t);
      } else if (drag.mode === "l") {
        st.start = Math.min(t, st.end);
      } else {
        st.end = Math.max(t, st.start);
      }
      renderWaveSelection(st);
    });

    function finishDrag() {
      if (!drag) return;
      drag = null;
      // 选区过小视为一次点击：还原为完整区间。
      if (st.end - st.start < 0.05) {
        st.start = 0;
        st.end = 0;
      }
      renderWaveSelection(st);
    }
    mask.addEventListener("pointerup", finishDrag);
    mask.addEventListener("pointercancel", finishDrag);
  }

  // 选区终点（秒）：end 为 0 表示播放到文件末尾。
  function slotEnd(st) {
    return st.end > 0 ? st.end : st.duration;
  }

  // 刷新选区显示与区间文本。
  function renderWaveSelection(st) {
    const sel = st.els.sel;
    const rangeText = st.els.rangeText;
    if (!st.buffer || !st.duration) {
      sel.hidden = true;
      rangeText.textContent = "未上传音频";
      return;
    }
    const end = slotEnd(st);
    const left = Math.min(1, Math.max(0, st.start / st.duration));
    const right = Math.min(1, Math.max(left, end / st.duration));
    sel.hidden = false;
    sel.style.left = (left * 100).toFixed(3) + "%";
    sel.style.width = ((right - left) * 100).toFixed(3) + "%";
    rangeText.textContent =
      st.start <= 0 && right >= 1
        ? "完整区间 " + st.duration.toFixed(2) + "s"
        : st.start.toFixed(2) + "s – " + end.toFixed(2) + "s";
  }

  // 绘制波形图（按 canvas 实际像素宽度采样峰谷）。
  function drawWaveform(st) {
    const canvas = st.els.canvas;
    const width = Math.max(1, Math.floor(canvas.clientWidth || 460));
    const height = Math.max(1, Math.floor(canvas.clientHeight || 120));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx2d = canvas.getContext("2d");
    ctx2d.clearRect(0, 0, width, height);
    // 波形颜色随主题走（深色主题下深蓝波形落在深底上等于看不见）：
    // 取值来自样式表变量，主题切换后无需重绘逻辑改动。
    const themeVars = getComputedStyle(document.documentElement);
    const waveLine =
      themeVars.getPropertyValue("--wave-line").trim() ||
      "rgba(32, 49, 112, 0.18)";
    const waveFill =
      themeVars.getPropertyValue("--wave-fill").trim() ||
      "rgba(32, 49, 112, 0.6)";
    ctx2d.strokeStyle = waveLine;
    ctx2d.beginPath();
    ctx2d.moveTo(0, height / 2);
    ctx2d.lineTo(width, height / 2);
    ctx2d.stroke();
    if (!st.buffer) return;
    const data = st.buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / width));
    ctx2d.fillStyle = waveFill;
    for (let x = 0; x < width; x++) {
      let min = 1;
      let max = -1;
      const from = x * step;
      for (let i = 0; i < step; i++) {
        const v = data[from + i];
        if (v === undefined) break;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (max < min) {
        min = 0;
        max = 0;
      }
      const y1 = ((1 - max) * height) / 2;
      const y2 = ((1 - min) * height) / 2;
      ctx2d.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  }

  // 刷新槽位控件状态并重绘波形。
  function renderAudioSlot(st) {
    st.els.hint.hidden = !!st.buffer;
    st.els.previewBtn.disabled = !st.buffer;
    st.els.rateInput.disabled = !st.buffer;
    st.els.rateInput.value = String(st.rate);
    st.els.rateVal.textContent = st.rate.toFixed(1) + "x";
    drawWaveform(st);
    renderWaveSelection(st);
  }

  // 读取并解码所选音频，随后在波形图上渲染。
  function loadPickedAudio(st, path) {
    if (!audioEngine) {
      notify("warn", "当前环境不支持音频编辑。");
      return Promise.resolve();
    }
    return callApi(
      "read_audio_file",
      { path: path },
      {
        errorPrefix: "读取音频失败",
      },
    ).then(function (dataUrl) {
      soundSlotSeq += 1;
      st.key =
        "sound-edit:" + soundDraft.session + ":" + st.slot + ":" + soundSlotSeq;
      return audioEngine.decode(st.key, dataUrl).then(function (buffer) {
        st.srcPath = path;
        st.file = "";
        st.buffer = buffer;
        st.duration = buffer.duration;
        st.start = 0;
        st.end = 0;
        renderAudioSlot(st);
      });
    });
  }

  // 载入既有音效片段并回填编辑参数（沿用组内文件，保存时不必重复拷贝）。
  function loadExistingAudio(st, clip) {
    if (!audioEngine) {
      notify("warn", "当前环境不支持音频编辑。");
      return Promise.resolve();
    }
    return callApi(
      "read_audio_file",
      { path: clip.path },
      {
        errorPrefix: "读取音频失败",
      },
    ).then(function (dataUrl) {
      soundSlotSeq += 1;
      st.key =
        "sound-edit:" + soundDraft.session + ":" + st.slot + ":" + soundSlotSeq;
      return audioEngine.decode(st.key, dataUrl).then(function (buffer) {
        st.srcPath = null;
        st.file = clip.file || "";
        st.buffer = buffer;
        st.duration = buffer.duration;
        st.start = clip.start > 0 ? clip.start : 0;
        st.end = clip.end > 0 ? clip.end : 0;
        st.rate = clampRate(clip.rate);
        renderAudioSlot(st);
      });
    });
  }

  function pickAndLoad(st) {
    callApi("pick_audio_file", undefined, { errorPrefix: "选择音频失败" })
      .then(function (path) {
        if (!path) return;
        return loadPickedAudio(st, path);
      })
      .catch(function (err) {
        console.error("读取音频失败", err);
      });
  }

  // 试听：按当前裁剪区间与倍速播放该槽位音频。
  function previewSlot(st) {
    if (!st.buffer || !audioEngine) return;
    audioEngine.stopAll();
    audioEngine.prime();
    const vol =
      config && config.widget && typeof config.widget.vol === "number"
        ? config.widget.vol
        : 0.9;
    audioEngine.play(st.key, {
      start: st.start,
      end: st.end,
      rate: st.rate,
      volume: vol,
    });
  }

  // 保存时提交的片段参数（完整区间存 0 表示播放到末尾）。
  function audioClipPayload(st) {
    if (!st || !(st.srcPath || st.file)) return null;
    const full = st.start <= 0 && (st.end <= 0 || st.end >= st.duration);
    return {
      file: st.file || "",
      start: Math.round(st.start * 100) / 100,
      end: full ? 0 : Math.round(slotEnd(st) * 100) / 100,
      rate: clampRate(st.rate),
    };
  }

  // 应用：按模式把启用槽位的音频与编辑参数写入数据目录，并选中该音效组。
  //
  // 校验与提交都严格跟随模式：未启用的槽位既不校验也不提交，避免把上一次的
  // 残留引用写进 meta.json（后端会再按模式裁剪一次，形成双保险）。
  function applySoundDraft() {
    if (!soundDraft) return;
    const mode = audioModeOf(soundDraft.mode);
    const slots = slotsOfMode(mode);
    const missing = slots.filter(function (slot) {
      const st = soundDraft.slots[slot];
      return !st || !(st.srcPath || st.file);
    });
    if (missing.length) {
      const label = missing[0] === "release" ? "松开" : "按下";
      notify("warn", "请先为「" + label + "」上传音频文件");
      return;
    }

    const name = soundDraft.name;
    const press = slots.indexOf("press") === -1 ? null : soundDraft.slots.press;
    const release =
      slots.indexOf("release") === -1 ? null : soundDraft.slots.release;
    const payload = {
      name: name,
      mode: mode,
      pressSrc: press ? press.srcPath || null : null,
      releaseSrc: release ? release.srcPath || null : null,
      press: press ? audioClipPayload(press) : null,
      release: release ? audioClipPayload(release) : null,
    };
    audioApplyEl.disabled = true;
    // 编辑既有音效组时保持当前选中的音效不变，仅刷新该组资源。
    const keepSelection = soundDraft.existing === true;
    callApi("save_audio_group", payload, {
      // 上传（复制音频文件 + 写 meta.json）期间的黄色进度提示。
      busy: "正在上传音效…",
      success: "音效已保存",
      errorPrefix: "保存音效失败",
    })
      .then(function () {
        closeAudioEditor();
        if (!keepSelection && config.widget) config.widget.soundSet = name;
        return refreshSoundGroups();
      })
      .then(function () {
        saveWidgetDebounced();
      })
      .catch(function () {
        // 失败详情已由 callApi 统一以红色弹窗展示。
      })
      .finally(function () {
        audioApplyEl.disabled = false;
      });
  }

  audioApplyEl.addEventListener("click", applySoundDraft);
  audioCancelEl.addEventListener("click", closeAudioEditor);

  // 配置页主色实时预览并静默保存。
  if (globalColorEl)
    globalColorEl.addEventListener("input", function (e) {
      const hue = Number(e.target.value) || 0;
      const color = hexFromHue(hue);
      config.globalColor = color;
      applyGlobalColor(color);
      debouncedSave();
    });

  if (bubbleColorEl)
    bubbleColorEl.addEventListener("input", function (e) {
      const hue = Number(e.target.value) || 0;
      const color = hexFromHue(hue);
      config.widget.bubbleColor = color;
      saveWidgetDebounced();
    });

  // 重置设置：把界面上的可配置项全部恢复为默认值。
  // 供应商列表存放在独立目录、台词内容有专属按钮，二者都不受影响。
  if (resetColorEl)
    resetColorEl.addEventListener("click", function () {
      showConfirm("确认恢复默认设置吗？", function () {
        cancelPendingSaves();
        callApi("reset_config", undefined, { errorPrefix: "恢复默认设置失败" })
          .then(function (cfg) {
            applyConfigToUi(cfg);
            notify("success", "已恢复默认设置");
          })
          .catch(function (err) {
            console.error("恢复默认设置失败", err);
          });
      });
    });

  widgetVolEl.addEventListener("input", function (e) {
    const v =
      Math.round(Math.min(1, Math.max(0, Number(e.target.value))) * 100) / 100;
    config.widget.vol = v;
    widgetVolPctEl.textContent = Math.round(v * 100) + "%";
    saveWidgetDebounced();
  });

  if (blinkIntervalMinSecEl)
    blinkIntervalMinSecEl.addEventListener("input", function (e) {
      e.target.value = e.target.value.replace(/[^0-9]/g, "");
      blinkRangeLastChanged = "min";
      saveBlinkRangeIfReady();
    });

  if (blinkIntervalMaxSecEl)
    blinkIntervalMaxSecEl.addEventListener("input", function (e) {
      e.target.value = e.target.value.replace(/[^0-9]/g, "");
      blinkRangeLastChanged = "max";
      saveBlinkRangeIfReady();
    });

  if (blinkIntervalMinSecEl)
    blinkIntervalMinSecEl.addEventListener("blur", function () {
      const changed = blinkRangeLastChanged || "min";
      setTimeout(function () {
        finalizeBlinkRange(changed);
      }, 0);
    });

  if (blinkIntervalMaxSecEl)
    blinkIntervalMaxSecEl.addEventListener("blur", function () {
      const changed = blinkRangeLastChanged || "max";
      setTimeout(function () {
        finalizeBlinkRange(changed);
      }, 0);
    });

  if (exhaustedModeEnabledEl)
    exhaustedModeEnabledEl.addEventListener("change", function (e) {
      config.widget.exhaustedModeEnabled = !!e.target.checked;
      saveWidgetDebounced();
    });

  if (exhaustedBalanceThresholdEl)
    bindIntegerInput(
      exhaustedBalanceThresholdEl,
      function () {
        return config.widget.exhaustedBalanceThreshold;
      },
      function (v) {
        config.widget.exhaustedBalanceThreshold = v;
      },
      saveWidgetDebounced,
    );

  if (peakWarnEnabledEl)
    peakWarnEnabledEl.addEventListener("change", function (e) {
      config.widget.peakWarnEnabled = !!e.target.checked;
      saveWidgetDebounced();
    });

  if (peakWarnMinutesEl)
    bindIntegerInput(
      peakWarnMinutesEl,
      function () {
        return config.widget.peakWarnMinutes;
      },
      function (v) {
        config.widget.peakWarnMinutes = v;
      },
      saveWidgetDebounced,
    );

  if (snapDistanceEl)
    bindIntegerInput(
      snapDistanceEl,
      function () {
        return snapRatioToPx(config.widget.snapDistance);
      },
      function (v) {
        config.widget.snapDistance = snapPxToRatio(v);
      },
      saveWidgetDebounced,
    );

  // 「挂件状态」三个表情阈值：正整数输入，超出区间时按边界收敛。
  if (disappointedThresholdMinEl)
    bindIntegerInput(
      disappointedThresholdMinEl,
      function () {
        return config.widget.disappointedThresholdMin;
      },
      function (v) {
        config.widget.disappointedThresholdMin = v;
      },
      saveWidgetDebounced,
      1,
      1440,
    );

  if (angryThresholdClicksEl)
    bindIntegerInput(
      angryThresholdClicksEl,
      function () {
        return config.widget.angryThresholdClicks;
      },
      function (v) {
        config.widget.angryThresholdClicks = v;
      },
      saveWidgetDebounced,
      1,
      100,
    );

  if (shyThresholdSecEl)
    bindIntegerInput(
      shyThresholdSecEl,
      function () {
        return config.widget.shyThresholdSec;
      },
      function (v) {
        config.widget.shyThresholdSec = v;
      },
      saveWidgetDebounced,
      1,
      3600,
    );

  autostartEl.addEventListener("change", function (e) {
    if (!config || autostartPending) {
      e.target.checked = !!(config && config.autostart);
      return;
    }
    const enabled = e.target.checked;
    autostartPending = true;
    autostartEl.disabled = true;
    callApi(
      "set_autostart",
      { enabled: enabled },
      {
        errorPrefix: "设置开机自启失败",
      },
    )
      .then(function (actual) {
        const next = !!actual;
        config.autostart = next;
        autostartEl.checked = next;
        if (enabled && !next) {
          notify("warn", "开机自启未生效，可能已被系统或安全软件拦截。");
        }
        if (!enabled && next) {
          notify(
            "warn",
            "开机自启仍处于开启状态，请检查系统启动项或安全软件。",
          );
        }
      })
      .catch(function (err) {
        e.target.checked = !enabled;
        console.error("设置开机自启失败", err);
      })
      .finally(function () {
        autostartPending = false;
        autostartEl.disabled = false;
      });
  });

  // 令牌用量统计（实验性功能）：开关只决定用量与账单的取数口径，余额照常联网。
  // 开启后余额配置表单才会出现「平台令牌」，因此保存成功后同步一次配置缓存。
  let tokenUsagePending = false;
  tokenUsageEl.addEventListener("change", function (e) {
    if (!config || tokenUsagePending) {
      e.target.checked = !!(config && config.tokenUsage);
      return;
    }
    const enabled = e.target.checked;
    tokenUsagePending = true;
    tokenUsageEl.disabled = true;
    callApi(
      "set_token_usage",
      { enabled: enabled },
      { errorPrefix: "设置令牌用量统计失败" },
    )
      .then(function (actual) {
        const next = !!actual;
        config.tokenUsage = next;
        tokenUsageEl.checked = next;
        if (next) {
          notify(
            "success",
            "已启用令牌用量统计：请在余额配置里填写「平台令牌」以获取官网账单。",
          );
        }
        refreshBalance();
      })
      .catch(function (err) {
        e.target.checked = !enabled;
        console.error("设置令牌用量统计失败", err);
      })
      .finally(function () {
        tokenUsagePending = false;
        tokenUsageEl.disabled = false;
      });
  });

  // 统一关闭确认 / 名称输入类弹窗。
  function hideModal() {
    modalOverlayEl.hidden = true;
    confirmModalEl.hidden = true;
    soundNameModalEl.hidden = true;
    bodyNameModalEl.hidden = true;
  }

  // 展示带确认操作的弹窗；确认后执行传入的回调。
  let confirmAction = null;

  function showConfirm(message, onConfirm) {
    confirmMsgEl.textContent = message;
    confirmAction = typeof onConfirm === "function" ? onConfirm : null;
    confirmModalEl.hidden = false;
    modalOverlayEl.hidden = false;
  }

  confirmNoEl.addEventListener("click", hideModal);
  // 确认 / 名称输入弹窗一律只由窗口内的按钮关闭：
  // 点击遮罩（窗口以外区域）不再触发关闭，避免误操作导致已填内容丢失。

  confirmYesEl.addEventListener("click", function () {
    hideModal();
    const action = confirmAction;
    confirmAction = null;
    if (action) action();
  });

  if (tutorialEl)
    tutorialEl.addEventListener("click", function (e) {
      e.preventDefault();
      callApi(
        "open_external",
        {
          url: "https://github.com/xiaolinnnnnnn/DeepSeek-Balance-Whale-Widget/blob/DeepSeek-Balance-Whale-Widget-Desktop/README.md",
        },
        { errorPrefix: "打开链接失败" },
      ).catch(function (err) {
        console.error("打开外部链接失败", err);
      });
    });

  // 打开项目发布页（版本更新确认后触发）。
  function openReleasePage() {
    callApi(
      "open_external",
      {
        url: "https://github.com/xiaolinnnnnnn/DeepSeek-Balance-Whale-Widget/tree/DeepSeek-Balance-Whale-Widget-Desktop",
      },
      { errorPrefix: "打开链接失败" },
    ).catch(function (err) {
      console.error("打开外部链接失败", err);
    });
  }

  // 检查更新后根据结果切换提示或确认弹窗。
  checkUpdateEl.addEventListener("click", function () {
    callApi("check_update", undefined, { errorPrefix: "检查更新失败" })
      .then(function (res) {
        if (res && res.upToDate === true) {
          notify("success", "当前为最新版本，无需更新");
        } else if (res && res.upToDate === false) {
          showConfirm("当前版本过低，是否更新？", openReleasePage);
        } else {
          notify("error", "检查更新失败");
        }
      })
      .catch(function (err) {
        console.error("检查更新失败", err);
      });
  });

  // ===== 全局主题（浅色 / 深色 / 毛玻璃）=====
  //
  // 主题只作用于本配置窗口：通过 html[data-theme] 切换 config.css 里的配色变量与面板底色。
  // 桌面挂件不引用本样式表，因此主题不会改动挂件的任何属性。
  // 持久化在 config.json 的 globalTheme，同时写入 localStorage 供首帧前回放（避免闪一下浅色）。
  const THEMES = ["light", "dark", "glass"];
  const THEME_CACHE_KEY = "dsw-theme";

  function applyTheme(theme) {
    const next = THEMES.indexOf(theme) === -1 ? "light" : theme;
    if (next === "light")
      document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", next);
    // 全局颜色是按主题适配后写进 CSS 变量的，换主题后必须重新派生一次。
    applyGlobalColor(globalColorValue);
    if (themePickerEl) {
      themePickerEl.querySelectorAll(".theme-btn").forEach(function (btn) {
        btn.classList.toggle("active", btn.dataset.theme === next);
      });
    }
    try {
      localStorage.setItem(THEME_CACHE_KEY, next);
    } catch (err) {
      // 存储不可用（隐私模式等）：仅失去首帧回放能力，不影响主题本身。
      console.error("缓存主题失败", err);
    }
  }

  if (themePickerEl) {
    themePickerEl.addEventListener("click", function (e) {
      const btn = e.target.closest(".theme-btn");
      if (!btn || !config) return;
      const next =
        THEMES.indexOf(btn.dataset.theme) === -1 ? "light" : btn.dataset.theme;
      if (next === config.globalTheme) return;
      config.globalTheme = next;
      applyTheme(next);
      debouncedSave();
    });
  }

  // ===== 数据目录（系统配置 · 配置文件）=====
  //
  // 路径由后端解析（便携目录优先、不可写时回落用户目录），前端只做只读展示；
  // 「打开」交由系统文件管理器定位——安装路径无法在前端可靠拼出，故不接受本地拼接。
  function loadDataDir() {
    if (!dataDirEl) return;
    callApi("get_data_dir", undefined, { silent: true })
      .then(function (dir) {
        dataDirEl.value = dir || "";
        dataDirEl.title = dir || "";
      })
      .catch(function (err) {
        console.error("读取数据目录失败", err);
      });
  }

  if (openDataDirEl) {
    openDataDirEl.addEventListener("click", function () {
      callApi("open_data_dir", undefined, { errorPrefix: "打开文件夹失败" });
    });
  }
  loadDataDir();

  // ===== 峰谷日历 =====
  //
  // DeepSeek 峰谷计价依据的法定节假日安排：完全由后端自动获取（内置免费源 + 本地
  // 缓存），用户无需也无法配置。本页装载一次只是为了让「预览气泡的峰谷倒计时」
  // 与桌面挂件同口径——两处读的都是 `DSWHoliday` 的内存表。
  if (window.DSWHoliday) window.DSWHoliday.start();

  // ===== 跨模块桥接 =====
  //
  // 「余额与模型路由配置」模块（supplier.js）独立成文件，但必须复用本文件的
  // 统一提示体系（轻提示）与 IPC 封装，避免出现两套提示与两套错误处理。
  // 因此这里只暴露这些既有的、已在本文件中验证过的能力，不暴露任何表单内部状态。
  window.CFG = {
    /** 统一的命令调用（含错误提示与忙碌态处理）。 */
    callApi: callApi,
    /** 轻提示：按 severity 着色、右上角堆叠并自动消失。 */
    notify: notify,
    /** 二次确认弹窗。 */
    showConfirm: showConfirm,
    /** 重新拉取顶部余额概览。 */
    refreshBalance: refreshBalance,
    /** 读取当前显示币种对应的符号（如 CNY → ￥）。 */
    currencySymbol: function (code) {
      const key = String(code || "CNY").toUpperCase();
      return CURRENCY_SYMBOL[key] || "";
    },
    /** 自定义下拉选择器工厂（供应商表单需与挂件配置保持同一种下拉样式）。 */
    createPicker: createPicker,
    /** 色相 → Hex / Hex → 色相：模块化气泡的颜色滑杆复用同一套换算。 */
    hexFromHue: hexFromHue,
    hueFromHex: hueFromHex,
    /** 收起全部下拉浮层（弹窗关闭 / 切换列表时调用，避免浮层残留在页面上）。 */
    closePickers: closeAllPickers,
    /** 「令牌用量统计（实验性功能）」是否开启（供应商表单据此决定是否显示「平台令牌」）。 */
    tokenUsageEnabled: function () {
      return !!(config && config.tokenUsage);
    },
  };
})();

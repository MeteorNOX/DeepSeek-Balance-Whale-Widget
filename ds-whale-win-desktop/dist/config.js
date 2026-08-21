// 配置窗口逻辑：加载/编辑/保存应用配置（全部热更新，静默保存，双向同步）。

(function () {
  const invoke =
    window.__TAURI__ && window.__TAURI__.core
      ? window.__TAURI__.core.invoke
      : null;
  if (!invoke) return;

  document.addEventListener("contextmenu", function (e) {
    e.preventDefault();
  });

  const apiKeyEl = document.getElementById("apiKey");
  const baseUrlEl = document.getElementById("baseUrl");
  const autostartEl = document.getElementById("autostart");
  const toggleKeyEl = document.getElementById("toggleKey");
  const widgetScaleEl = document.getElementById("widgetScale");
  const widgetScaleValEl = document.getElementById("widgetScaleVal");
  const widgetSoundSetEl = document.getElementById("widgetSoundSet");
  const widgetVolEl = document.getElementById("widgetVol");
  const widgetVolPctEl = document.getElementById("widgetVolPct");
  const addCustomSoundEl = document.getElementById("addCustomSound");
  const globalColorEl = document.getElementById("globalColor");
  const bubbleColorEl = document.getElementById("bubbleColor");
  const resetColorEl = document.getElementById("resetColor");
  const checkUpdateEl = document.getElementById("checkUpdate");
  const tutorialEl = document.getElementById("tutorial");
  const modalOverlayEl = document.getElementById("modalOverlay");
  const tipModalEl = document.getElementById("tipModal");
  const tipMsgEl = document.getElementById("tipMsg");
  const tipOkEl = document.getElementById("tipOk");
  const confirmModalEl = document.getElementById("confirmModal");
  const confirmMsgEl = document.getElementById("confirmMsg");
  const confirmYesEl = document.getElementById("confirmYes");
  const confirmNoEl = document.getElementById("confirmNo");
  const dialogueListEl = document.getElementById("dialogueList");
  const addLineEl = document.getElementById("addLine");
  const resetLinesEl = document.getElementById("resetLines");
  const dialogueModeEl = document.getElementById("dialogueMode");
  const dialogueIntervalEl = document.getElementById("dialogueInterval");
  const dialogueJitterEl = document.getElementById("dialogueJitter");
  const dialogueJitterValEl = document.getElementById("dialogueJitterVal");
  const toggleDialogueEl = document.getElementById("toggleDialogue");
  const dialogueCardEl = document.getElementById("dialogueCard");
  const availableBalanceEl = document.getElementById("availableBalance");
  const todayUsageEl = document.getElementById("todayUsage");
  const provClaudeEl = document.getElementById("provClaude");
  const provCodexEl = document.getElementById("provCodex");

  const SCALE_MIN = 0.6;
  const SCALE_MAX = 2.5;
  const LEVEL_MIN = 1;
  const LEVEL_MAX = 20;
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
  let activeProvider = "claude"; // 'claude' | 'codex'

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
  ];
  let dialogueSaveTimer = null;

  function currentModels() {
    return activeProvider === "codex" ? config.codexModels : config.models;
  }
  function currentBaseUrl() {
    return activeProvider === "codex" ? config.codexBaseUrl : config.baseUrl;
  }

  function debouncedSave() {
    if (!config) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      invoke("save_config", { cfg: config })
        .then(function (saved) {
          config = saved;
        })
        .catch(function (err) {
          console.error("保存配置失败", err);
        });
    }, 400);
  }

  function saveWidgetDebounced() {
    if (!config || !config.widget) return;
    if (widgetSaveTimer) clearTimeout(widgetSaveTimer);
    widgetSaveTimer = setTimeout(function () {
      invoke("save_widget_config", { widget: config.widget })
        .then(function (saved) {
          config.widget = saved;
        })
        .catch(function (err) {
          console.error("保存挂件配置失败", err);
        });
    }, 400);
  }

  function saveDialogueDebounced() {
    if (!config || !config.dialogue) return;
    if (dialogueSaveTimer) clearTimeout(dialogueSaveTimer);
    dialogueSaveTimer = setTimeout(function () {
      invoke("save_dialogue", { dialogue: config.dialogue })
        .then(function (saved) {
          config.dialogue = saved;
        })
        .catch(function (err) {
          console.error("保存台词失败", err);
        });
    }, 400);
  }

  function refreshBalance() {
    invoke("get_balance")
      .then(function (payload) {
        if (payload && payload.ok) {
          availableBalanceEl.textContent =
            "¥ " + Number(payload.totalBalance || 0).toFixed(2);
          todayUsageEl.textContent =
            "¥ " + Number(payload.todayUsage || 0).toFixed(2);
        } else {
          availableBalanceEl.textContent = "--";
          todayUsageEl.textContent = "--";
        }
      })
      .catch(function () {
        availableBalanceEl.textContent = "--";
        todayUsageEl.textContent = "--";
      });
  }
  refreshBalance();
  setInterval(refreshBalance, 30000);

  function restoreSoundOptions(w) {
    const custom = w && Array.isArray(w.customSounds) ? w.customSounds : [];
    const known = {};
    for (let i = 0; i < widgetSoundSetEl.options.length; i++) {
      known[widgetSoundSetEl.options[i].value] = true;
    }
    custom.forEach(function (path) {
      if (known[path]) return;
      const name = path.split(/[\\/]/).pop() || path;
      const opt = document.createElement("option");
      opt.value = path;
      opt.textContent = name;
      widgetSoundSetEl.appendChild(opt);
      known[path] = true;
    });
    const soundSet = typeof w.soundSet === "string" ? w.soundSet : "duck";
    widgetSoundSetEl.value = known[soundSet] ? soundSet : "duck";
  }

  function applyWidgetToUi(w) {
    if (!w) return;
    config.widget = w;
    const level = scaleToNum(typeof w.scale === "number" ? w.scale : 1.5);
    widgetScaleEl.value = String(level);
    widgetScaleValEl.textContent = String(level);
    restoreSoundOptions(w);
    const hue = hueFromHex(w.bubbleColor || "#203170");
    bubbleColorEl.value = String(hue);
    const vol = typeof w.vol === "number" ? w.vol : 0.9;
    widgetVolEl.value = String(vol);
    widgetVolPctEl.textContent = Math.round(vol * 100) + "%";
  }

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

  function applyDialogueToUi(dlg) {
    if (!dlg)
      dlg = {
        lines: DEFAULT_LINES.slice(),
        mode: "random",
        intervalMin: 5,
        jitter: 0,
      };
    config.dialogue = dlg;
    if (dialogueModeEl)
      dialogueModeEl.value =
        dlg.mode === "carousel" || dlg.mode === "random" ? dlg.mode : "random";
    if (dialogueIntervalEl)
      dialogueIntervalEl.value = String(dlg.intervalMin || 5);
    if (dialogueJitterEl) dialogueJitterEl.value = String(dlg.jitter || 0);
    if (dialogueJitterValEl)
      dialogueJitterValEl.textContent = (dlg.jitter || 0) + "%";
    renderDialogueList();
  }

  function expandDialogue() {
    if (dialogueCardEl) dialogueCardEl.classList.remove("collapsed");
    if (toggleDialogueEl) toggleDialogueEl.textContent = "收起";
  }

  // 渲染当前供应商的模型配置。
  function renderModels() {
    if (!config) return;
    baseUrlEl.value = currentBaseUrl() || "";
    document.querySelectorAll(".model-row").forEach(function (row) {
      const key = row.dataset.model;
      const m = currentModels()[key];
      row.querySelector('[data-field="name"]').value = (m && m.name) || "";
      row.querySelector('[data-field="contextWindow"]').value =
        (m && m.contextWindow) || "";
    });
    provClaudeEl.classList.toggle("active", activeProvider === "claude");
    provCodexEl.classList.toggle("active", activeProvider === "codex");
  }

  function switchProvider(provider) {
    if (activeProvider === provider) return;
    activeProvider = provider;
    renderModels();
  }
  provClaudeEl.addEventListener("click", function () {
    switchProvider("claude");
  });
  provCodexEl.addEventListener("click", function () {
    switchProvider("codex");
  });

  invoke("get_config")
    .then(function (cfg) {
      config = cfg;
      apiKeyEl.value = cfg.apiKey || "";
      autostartEl.checked = !!cfg.autostart;
      const ghue = hueFromHex(cfg.globalColor || "#203170");
      globalColorEl.value = String(ghue);
      applyGlobalColor(cfg.globalColor || "#203170");
      applyWidgetToUi(cfg.widget || {});
      applyDialogueToUi(cfg.dialogue);
      renderModels();
    })
    .catch(function (err) {
      console.error("加载配置失败", err);
    });

  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen("widget-config-changed", function (e) {
      if (!config) return;
      applyWidgetToUi(e.payload);
    });
  }

  apiKeyEl.addEventListener("input", function (e) {
    config.apiKey = e.target.value.trim();
    debouncedSave();
  });

  baseUrlEl.addEventListener("input", function (e) {
    const v = e.target.value.trim();
    if (activeProvider === "codex") config.codexBaseUrl = v;
    else config.baseUrl = v;
    debouncedSave();
  });

  toggleKeyEl.addEventListener("click", function () {
    const showing = apiKeyEl.type === "text";
    apiKeyEl.type = showing ? "password" : "text";
    toggleKeyEl.textContent = showing ? "显示" : "隐藏";
  });

  document.querySelectorAll(".model-row").forEach(function (row) {
    const key = row.dataset.model;
    row
      .querySelector('[data-field="name"]')
      .addEventListener("input", function (e) {
        const m = currentModels()[key];
        if (m) m.name = e.target.value.trim();
        debouncedSave();
      });
    row
      .querySelector('[data-field="contextWindow"]')
      .addEventListener("input", function (e) {
        const v = Math.max(1, Math.floor(Number(e.target.value) || 0));
        const m = currentModels()[key];
        if (m) m.contextWindow = v;
        debouncedSave();
      });
  });

  widgetScaleEl.addEventListener("input", function (e) {
    const level = Math.max(
      LEVEL_MIN,
      Math.min(LEVEL_MAX, Math.round(Number(e.target.value) || LEVEL_MIN)),
    );
    config.widget.scale = Math.round(numToScale(level) * 10) / 10;
    widgetScaleValEl.textContent = String(level);
    saveWidgetDebounced();
  });

  widgetSoundSetEl.addEventListener("change", function (e) {
    config.widget.soundSet = e.target.value;
    saveWidgetDebounced();
  });

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

  if (resetLinesEl)
    resetLinesEl.addEventListener("click", function () {
      if (!config || !config.dialogue) return;
      expandDialogue();
      config.dialogue.lines = DEFAULT_LINES.slice();
      renderDialogueList();
      saveDialogueDebounced();
    });

  if (dialogueModeEl)
    dialogueModeEl.addEventListener("change", function (e) {
      if (!config || !config.dialogue) return;
      config.dialogue.mode = e.target.value;
      saveDialogueDebounced();
    });

  if (dialogueIntervalEl)
    dialogueIntervalEl.addEventListener("input", function (e) {
      if (!config || !config.dialogue) return;
      const v = Math.max(1, Math.floor(Number(e.target.value) || 1));
      config.dialogue.intervalMin = v;
      dialogueIntervalEl.value = String(v);
      saveDialogueDebounced();
    });

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
    });

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

  function applyGlobalColor(color) {
    document.documentElement.style.setProperty("--primary", color);
    document.documentElement.style.setProperty("--text", color);
    document.documentElement.style.setProperty("--primary-2", color);
    document.documentElement.style.setProperty("--muted", color);
    document.documentElement.style.setProperty("--border", color + "26");
  }

  if (addCustomSoundEl)
    addCustomSoundEl.addEventListener("click", function () {
      invoke("pick_audio_file")
        .then(function (path) {
          if (!path) return;
          config.widget.customSounds = config.widget.customSounds || [];
          if (config.widget.customSounds.indexOf(path) === -1)
            config.widget.customSounds.push(path);
          const name = path.split(/[\\/]/).pop() || path;
          const opt = document.createElement("option");
          opt.value = path;
          opt.textContent = name;
          widgetSoundSetEl.appendChild(opt);
          widgetSoundSetEl.value = path;
          config.widget.soundSet = path;
          saveWidgetDebounced();
        })
        .catch(function (err) {
          console.error("选择音效失败", err);
        });
    });

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

  const DEFAULT_COLOR = "#203170";
  if (resetColorEl)
    resetColorEl.addEventListener("click", function () {
      config.globalColor = DEFAULT_COLOR;
      config.widget.bubbleColor = DEFAULT_COLOR;
      const defaultHue = hueFromHex(DEFAULT_COLOR);
      if (globalColorEl) globalColorEl.value = String(defaultHue);
      if (bubbleColorEl) bubbleColorEl.value = String(defaultHue);
      applyGlobalColor(DEFAULT_COLOR);
      debouncedSave();
      saveWidgetDebounced();
    });

  widgetVolEl.addEventListener("input", function (e) {
    const v =
      Math.round(Math.min(1, Math.max(0, Number(e.target.value))) * 100) / 100;
    config.widget.vol = v;
    widgetVolPctEl.textContent = Math.round(v * 100) + "%";
    saveWidgetDebounced();
  });

  autostartEl.addEventListener("change", function (e) {
    const enabled = e.target.checked;
    invoke("set_autostart", { enabled: enabled })
      .then(function () {
        config.autostart = enabled;
      })
      .catch(function (err) {
        e.target.checked = !enabled;
        console.error("设置开机自启失败", err);
      });
  });

  function hideModal() {
    modalOverlayEl.hidden = true;
    tipModalEl.hidden = true;
    confirmModalEl.hidden = true;
  }

  function showTip(message) {
    tipMsgEl.textContent = message;
    confirmModalEl.hidden = true;
    tipModalEl.hidden = false;
    modalOverlayEl.hidden = false;
  }

  function showConfirm(message) {
    confirmMsgEl.textContent = message;
    tipModalEl.hidden = true;
    confirmModalEl.hidden = false;
    modalOverlayEl.hidden = false;
  }

  tipOkEl.addEventListener("click", hideModal);
  confirmNoEl.addEventListener("click", hideModal);

  modalOverlayEl.addEventListener("click", function (e) {
    if (e.target === modalOverlayEl) hideModal();
  });

  confirmYesEl.addEventListener("click", function () {
    hideModal();
    invoke("open_external", {
      url: "https://github.com/xiaolinnnnnnn/DeepSeek-Balance-Whale-Widget/tree/DeepSeek-Balance-Whale-Widget-Win-Desktop",
    }).catch(function (err) {
      console.error("打开外部链接失败", err);
    });
  });

  if (tutorialEl)
    tutorialEl.addEventListener("click", function (e) {
      e.preventDefault();
      invoke("open_external", {
        url: "https://github.com/xiaolinnnnnnn/DeepSeek-Balance-Whale-Widget/blob/DeepSeek-Balance-Whale-Widget-Win-Desktop/ds-whale-win-desktop/README.md",
      }).catch(function (err) {
        console.error("打开外部链接失败", err);
      });
    });

  checkUpdateEl.addEventListener("click", function () {
    invoke("check_update")
      .then(function (res) {
        if (res && res.upToDate === true) {
          showTip("当前为最新版本，无需更新");
        } else if (res && res.upToDate === false) {
          showConfirm("当前版本过低，是否更新？");
        } else {
          showTip("检查更新失败");
        }
      })
      .catch(function (err) {
        console.error("检查更新失败", err);
        showTip("检查更新失败");
      });
  });
})();

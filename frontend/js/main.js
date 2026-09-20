// 小鲸鱼余额挂件 · 初始化编排模块
//
// 在所有模块就绪后执行初始化：窗口尺寸同步、镜像翻转、首屏渲染、
// 音效/命中测试初始化、读取配置、订阅配置变更事件、快捷缩放与定时刷新。
// 依赖：其余全部模块（本文件最后加载）。

window.DSW = window.DSW || {};

(function (DSW) {
  "use strict";

  if (DSW.main) return;

  var C = DSW.C;
  var state = DSW.state;

  // 更新吸附朝向：
  // - 左吸附：整体水平翻转，鲸鱼贴到窗口左侧；
  // - 上吸附：内容贴窗口上沿（窗口顶部那块透明区变成「气泡预留区」），
  //   气泡因此完整落在屏幕内、鲸鱼紧接在气泡下方。
  // 两者可同时生效（左上角吸附）。
  DSW.express = function () {
    DSW.dom.root.classList.toggle("dshwv-left", state.h === "left");
    DSW.dom.root.classList.toggle("dshwv-top", state.v === "top");
  };

  // 首屏初始化顺序：朝向 -> 渲染 -> 音效/命中测试 -> 空闲计时。
  DSW.express();
  DSW.balance.render();
  // 提前初始化音频上下文并预加载当前音效组，避免长时间待机后首次点击才创建上下文。
  DSW.audio.init();
  DSW.audio.applySoundSet();
  DSW.hit.setupHitTest();
  DSW.expression.resetIdle();

  // 峰谷日历：尽早装载「当前年 + 次年」的节假日安排（缓存优先，必要时才联网），
  // 之后定期巡检以覆盖跨年。判定链路只读内存表，因此必须走在首屏渲染之前；
  // 某年尚未装载时退化为自然周规则，绝不会把周末算成高峰。
  if (window.DSWHoliday) window.DSWHoliday.start();

  // 首帧延后到挂件本体确定后再渲染：避免先显示内置素材、
  // 再切到自定义挂件组，造成用户可见的跨组错误切换。
  var firstPaintDone = false;
  function paintFirstFrame() {
    if (firstPaintDone) return;
    firstPaintDone = true;
    DSW.expression.handleWidgetConfigChange();
  }
  // 兜底：配置读取异常/超时也必须渲染首帧，避免挂件空白。
  setTimeout(function () {
    if (firstPaintDone) return;
    firstPaintDone = true;
    DSW.expression.setIcon(C.IMG_URL);
  }, 1000);

  // 读取挂件显示配置（尺寸/音效/音量/用量模式）。
  if (DSW.invoke) {
    DSW.invoke("get_config")
      .then(function (cfg) {
        const pos = cfg && cfg.widgetPosition ? cfg.widgetPosition : null;
        if (pos) {
          if (pos.h === "left" || pos.h === "right" || pos.h === "none") {
            state.h = pos.h;
          }
          // 上吸附要跨重启保持：否则窗口坐标贴顶、内容却仍锚在窗口下沿，
          // 看起来就像「掉回屏幕中部」。
          if (pos.v === "top" || pos.v === "bottom" || pos.v === "none") {
            state.v = pos.v;
          }
          DSW.express();
        }
        const w = cfg && cfg.widget ? cfg.widget : null;
        if (w) {
          DSW.widgetConfig.applyWidgetConfig(w);
        }
        if (cfg && cfg.dialogue)
          DSW.widgetConfig.applyDialogueConfig(cfg.dialogue);
        // 模块化气泡：读「已应用」的那一份（配置页编辑中的草稿不会实时推到桌面），
        // 里面没有模块时沿用内置三行气泡。老配置缺这个字段时回落草稿，行为与升级前一致。
        if (DSW.modular) {
          DSW.modular.applyConfig(cfg && (cfg.bubbleApplied || cfg.bubble));
        }
        paintFirstFrame();
        DSW.balance.refresh(false);
      })
      .catch(function () {
        paintFirstFrame();
        DSW.balance.refresh(false);
      });
  } else {
    paintFirstFrame();
  }

  // 监听来自配置窗口的显示设置变更并实时应用。
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen("widget-config-changed", function (e) {
      DSW.widgetConfig.applyWidgetConfig(e.payload);
    });
  }

  // 监听台词配置变更并实时应用。
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen("dialogue-changed", function (e) {
      DSW.widgetConfig.applyDialogueConfig(e.payload);
    });
  }

  // 监听模块化气泡配置变更：配置页每改一次，桌面气泡立即跟着变（编辑即所见）。
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen("bubble-changed", function (e) {
      if (DSW.modular) DSW.modular.applyConfig(e.payload);
    });
  }

  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen("balance-refresh-requested", function (e) {
      // 载荷 true = 余额数据源（当前启用供应商）已变化：上一个供应商的余额与
      // 今日已用必须立刻作废，不能等到新数据源取数失败才显示「--」。
      // 载荷 false = 只是需要重新拉取（如切换显示币种、用量口径），已有数值仍有效。
      DSW.balance.refresh(true, { sourceChanged: e.payload === true });
    });
  }

  // 自定义图片保存后刷新缓存并重绘，确保立即替换桌面鲸鱼图。
  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen("widget-image-changed", function () {
      if (DSW.images && DSW.images.invalidate) DSW.images.invalidate();
      if (DSW.expression && DSW.expression.syncVisualState) {
        DSW.expression.syncVisualState();
      }
    });
  }

  // Ctrl+滚轮快捷缩放（鼠标悬浮鲸鱼本体时）。
  document.addEventListener(
    "wheel",
    function (e) {
      if (!e.ctrlKey) return;
      if (!DSW.hit.isWhaleHit(e)) return;
      try {
        e.preventDefault();
      } catch (err) {}
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      const next =
        Math.round(
          Math.min(C.MAX_SCALE, Math.max(C.MIN_SCALE, state.scale + delta)) *
            10,
        ) / 10;
      if (next === state.scale) return;
      DSW.widgetConfig.applyScale(next);
      DSW.widgetConfig.saveConfig();
    },
    { passive: false },
  );

  // 全局禁用浏览器默认右键菜单。
  document.addEventListener("contextmenu", function (e) {
    e.preventDefault();
  });

  // 退出前释放渲染资源：停掉音效与音频上下文、清空全部定时器。
  //
  // 由宿主层「退出程序」广播的 app-quit 事件触发；beforeunload 作为兜底，
  // 保证窗口被直接销毁时也能清干净，不留下仍在跑的回调。
  var refreshTimer = null;
  var released = false;
  // 「隐藏 / 退出后恢复渲染内容」的兜底定时器（退出流程需要取消它）。
  var blankRestoreTimer = null;

  function releaseRenderResources() {
    if (released) return;
    released = true;
    if (blankRestoreTimer) {
      clearTimeout(blankRestoreTimer);
      blankRestoreTimer = null;
    }
    try {
      if (DSW.audio && DSW.audio.release) DSW.audio.release();
    } catch (err) {}
    if (DSW.modular && DSW.modular.stopTimers) {
      try {
        DSW.modular.stopTimers();
      } catch (err) {}
    }
    if (DSW.expression && DSW.expression.clearHoverTimer) {
      try {
        DSW.expression.clearHoverTimer();
      } catch (err) {}
    }
    if (DSW.widgetConfig) {
      try {
        DSW.widgetConfig.pauseDialogue();
        DSW.widgetConfig.pauseExhaustedPrompts();
      } catch (err) {}
    }
    [
      "blinkTimer",
      "blinkFrameTimer",
      "idleTimer",
      "hoverTimer",
      "dialogueTimer",
      "exhaustedPromptTimer",
      "peakWarnTimer",
    ].forEach(function (key) {
      if (DSW.flags[key]) {
        clearTimeout(DSW.flags[key]);
        clearInterval(DSW.flags[key]);
        DSW.flags[key] = null;
      }
    });
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen("app-quit", function () {
      releaseRenderResources();
    });
  }
  window.addEventListener("beforeunload", releaseRenderResources);

  // 窗口显隐前置通知：隐藏（或退出）前立刻清空渲染内容、显示前立刻恢复。
  //
  // 宿主层在切换窗口可见性 / 销毁窗口前一帧广播该事件，使桌宠「直接消失、直接显示」——
  // 若不先清空，透明 WebView2 窗口在隐藏或销毁瞬间仍会残留上一帧，看起来像渐隐动画。
  function applyRenderVisibility(visible) {
    if (!DSW.dom || !DSW.dom.root) return;
    DSW.dom.root.style.visibility = visible ? "" : "hidden";
  }

  if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen("widget-visibility", function (e) {
      var visible = e.payload !== false;
      if (blankRestoreTimer) {
        clearTimeout(blankRestoreTimer);
        blankRestoreTimer = null;
      }
      applyRenderVisibility(visible);
      if (!visible) {
        // 兜底：窗口隐藏完成后即恢复 DOM 状态，避免万一漏掉「显示」事件时桌宠一直不可见；
        // 退出流程会取消该兜底，保证退出时画面保持清空。
        blankRestoreTimer = setTimeout(function () {
          blankRestoreTimer = null;
          applyRenderVisibility(true);
        }, 800);
      }
    });
  }

  refreshTimer = setInterval(function () {
    DSW.balance.refresh(false);
  }, C.REFRESH_MS);

  DSW.main = {};
})(window.DSW);

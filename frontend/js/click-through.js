// 小鲸鱼余额挂件 · 鼠标穿透轮询模块
//
// 定期检测光标是否落在鲸鱼/气泡上，落在透明区域时通知后端忽略鼠标事件。
// 依赖：core.js（DSW.invoke/DSW.flags）、hit-test.js（DSW.hit）。

window.DSW = window.DSW || {};

(function (DSW) {
  "use strict";

  if (DSW.clickThrough) return;

  var flags = DSW.flags;

  // 判断坐标是否落在可交互区域（鲸鱼本体或已展开的气泡）。
  function isInteractiveAt(cx, cy) {
    if (DSW.hit.isWhaleHit({ clientX: cx, clientY: cy })) return true;
    if (flags.bubbleShown) {
      let el = null;
      try {
        el = document.elementFromPoint(cx, cy);
      } catch (err) {}
      if (el && el.closest && el.closest(".dshwv-bubble")) return true;
    }
    return false;
  }

  // 通知后端切换鼠标穿透状态。
  function applyClickThrough(ignore) {
    if (flags.clickThrough === ignore || !DSW.invoke) return;
    flags.clickThrough = ignore;
    DSW.invoke("set_ignore_cursor_events", { ignore: ignore }).catch(function () {
      flags.clickThrough = null;
    });
  }

  // 高频轮询系统鼠标位置，保持透明区域可穿透。
  setInterval(function () {
    if (!DSW.invoke || (flags.drag && flags.drag.active)) return;
    DSW.invoke("get_cursor_position")
      .then(function (pos) {
        if (!Array.isArray(pos) || pos.length < 2) return;
        // 后端返回的是相对窗口客户区的**物理**像素偏移，除以渲染进程自己的
        // devicePixelRatio 才与 getBoundingClientRect() 同属一套 CSS 像素
        // （不再用 window.screenX/Y 混算：缩放不为 1 时两者不同源，判定区会整体偏移）。
        const dpr = window.devicePixelRatio || 1;
        const sx = pos[0] / dpr;
        const sy = pos[1] / dpr;
        const interactive = isInteractiveAt(sx, sy);
        applyClickThrough(!interactive);
      })
      .catch(function () {});
  }, 60);

  DSW.clickThrough = {
    isInteractiveAt: isInteractiveAt,
    applyClickThrough: applyClickThrough,
  };
})(window.DSW);

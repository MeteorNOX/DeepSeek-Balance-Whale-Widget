// 小鲸鱼余额挂件 · 光标提示与害羞计时模块
//
// 负责在鲸鱼本体上切换 grab 光标，并在持续悬浮时触发害羞表情。
// 依赖：core.js（DSW.invoke/DSW.flags/DSW.C）、hit-test.js（DSW.hit）、
//       expression.js（DSW.expression）。

window.DSW = window.DSW || {};

(function (DSW) {
  "use strict";

  if (DSW.hover) return;

  var C = DSW.C;
  var flags = DSW.flags;

  // 统一处理悬浮光标与“害羞”进入计时。
  document.addEventListener(
    "pointermove",
    function (e) {
      if (flags.drag && flags.drag.active) return;
      let el = null;
      try {
        el = document.elementFromPoint(e.clientX, e.clientY);
      } catch (err) {}
      if (el && el.closest && el.closest(".dshwv-bubble")) {
        document.body.style.cursor = "";
        return;
      }
      const over = DSW.hit.isWhaleHit(e);
      document.body.style.cursor = over ? "grab" : "";

      // 悬浮触发害羞：仅默认活跃状态、鼠标悬停在鲸鱼上且未按压时计时。
      if (flags.mood === "normal" && over && !flags.pressing) {
        DSW.expression.resetIdle();
        if (!flags.isHovering) {
          flags.isHovering = true;
          // 悬浮阈值来自配置（flags.shyThresholdSec 秒），出厂默认 2 秒。
          var shyMs =
            Math.max(1, Math.round(Number(flags.shyThresholdSec) || 2)) * 1000;
          flags.hoverTimer = setTimeout(function () {
            flags.hoverTimer = null;
            if (flags.mood !== "normal" || !flags.isHovering || flags.pressing) return;
            if (!DSW.invoke) {
              DSW.expression.enterShy();
              return;
            }
            DSW.invoke("get_cursor_position")
              .then(function (pos) {
                if (!Array.isArray(pos) || pos.length < 2) return;
                const sx = pos[0] - window.screenX;
                const sy = pos[1] - window.screenY;
                if (
                  flags.mood === "normal" &&
                  flags.isHovering &&
                  !flags.pressing &&
                  DSW.hit.isWhaleHit({ clientX: sx, clientY: sy })
                ) {
                  DSW.expression.enterShy();
                }
              })
              .catch(function () {});
          }, shyMs);
        }
      } else if (flags.isHovering) {
        DSW.expression.clearHoverTimer();
      }
    },
    true,
  );

  // 鼠标离开文档时立即清掉悬浮状态。
  document.addEventListener("pointerleave", function () {
    DSW.expression.clearHoverTimer();
  });
  document.addEventListener("mouseleave", function () {
    DSW.expression.clearHoverTimer();
  });

  DSW.hover = {};
})(window.DSW);

// 小鲸鱼余额挂件 · 右键菜单模块
//
// 负责在鲸鱼本体上右键弹出系统原生菜单（由后端 `popup_menu` 渲染，
// 定位与屏幕边缘检测交由系统处理，避免 DOM 菜单被挂件窗口裁剪）。
// 依赖：core.js（DSW.invoke）、hit-test.js（DSW.hit）。

window.DSW = window.DSW || {};

(function (DSW) {
  "use strict";

  if (DSW.menu) return;

  document.addEventListener(
    "contextmenu",
    function (e) {
      if (!DSW.hit || !DSW.hit.isWhaleHit(e)) return;
      e.preventDefault();
      if (DSW.invoke) {
        DSW.invoke("show_context_menu").catch(function () {});
      }
    },
    true,
  );

  DSW.menu = {};
})(window.DSW);

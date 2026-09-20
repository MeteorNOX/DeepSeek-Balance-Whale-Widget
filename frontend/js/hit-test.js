// 小鲸鱼余额挂件 · 命中测试模块
//
// 通过离屏 canvas 采样鲸鱼图片的不透明像素，判断鼠标是否落在鲸鱼本体上，
// 用于拖拽、点击、悬浮提示与穿透检测。蒙版按当前挂件本体的资源构建。
// 依赖：core.js（DSW.state/DSW.C/DSW.images）、dom.js（DSW.dom）。

window.DSW = window.DSW || {};

(function (DSW) {
  "use strict";

  if (DSW.hit) return;

  // 初始化离屏命中画布：按当前挂件本体的主图采样（610x610）。
  // 经 DSW.images 解析，自定义挂件组使用自身文件夹的资源，避免沿用内置默认图。
  function setupHitTest() {
    try {
      DSW.hit.hitReady = false;
      DSW.hit.hitCanvas = document.createElement("canvas");
      DSW.hit.hitCanvas.width = 610;
      DSW.hit.hitCanvas.height = 610;
      DSW.images.resolve(DSW.C.IMG_URL, function (resolved) {
        const probe = new Image();
        probe.onload = function () {
          try {
            DSW.hit.hitCanvas.getContext("2d").drawImage(probe, 0, 0);
            DSW.hit.hitReady = true;
          } catch (err) {}
        };
        probe.onerror = function () {};
        probe.src = resolved;
      });
    } catch (err) {}
  }

  // 判断坐标是否命中鲸鱼不透明像素（失败时默认视为命中，避免卡死交互）。
  function isWhaleHit(e) {
    if (!DSW.hit.hitCanvas || !DSW.hit.hitReady) return false;
    try {
      const r = DSW.dom.img.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      let lx = ((e.clientX - r.left) / r.width) * 610;
      let ly = ((e.clientY - r.top) / r.height) * 610;
      if (lx < 0 || ly < 0 || lx >= 610 || ly >= 610) return false;
      if (DSW.state.h === "left") lx = 610 - lx;
      const data = DSW.hit.hitCanvas
        .getContext("2d")
        .getImageData(Math.floor(lx), Math.floor(ly), 1, 1).data;
      // alpha 大于阈值才视为点中鲸鱼本体。
      return data[3] > 10;
    } catch (err) {
      return true;
    }
  }

  DSW.hit = {
    hitCanvas: null,
    hitReady: false,
    setupHitTest: setupHitTest,
    isWhaleHit: isWhaleHit,
  };
})(window.DSW);

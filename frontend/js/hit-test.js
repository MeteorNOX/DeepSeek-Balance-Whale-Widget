// 小鲸鱼余额挂件 · 命中测试模块
//
// 通过离屏 canvas 采样鲸鱼图片的不透明像素，判断鼠标是否落在鲸鱼本体上，
// 用于拖拽、点击、悬浮提示与穿透检测。蒙版按当前挂件本体的资源构建。
// 依赖：core.js（DSW.state/DSW.C/DSW.images）、dom.js（DSW.dom）。

window.DSW = window.DSW || {};

(function (DSW) {
  "use strict";

  if (DSW.hit) return;

  // 初始化离屏命中画布：按当前挂件本体的主图采样（画布尺寸＝源图原始尺寸）。
  // 经 DSW.images 解析，自定义挂件组使用自身文件夹的资源，避免沿用内置默认图。
  function setupHitTest() {
    try {
      DSW.hit.hitReady = false;
      DSW.hit.hitCanvas = document.createElement("canvas");
      DSW.images.resolve(DSW.C.IMG_URL, function (resolved) {
        const probe = new Image();
        probe.onload = function () {
          try {
            // 画布按源图原始尺寸建，采样时也按同一坐标系映射。内置素材恰好是
            // 610×610，但自定义挂件本体的图可以是任意尺寸——写死 610 会让掩码
            // 与看得见的鲸鱼整体错位（表现为「点不中」）。
            DSW.hit.hitCanvas.width = probe.naturalWidth || 610;
            DSW.hit.hitCanvas.height = probe.naturalHeight || 610;
            DSW.hit.hitCanvas.getContext("2d").drawImage(probe, 0, 0);
            DSW.hit.hitReady = true;
          } catch (err) {}
        };
        probe.onerror = function () {};
        probe.src = resolved;
      });
    } catch (err) {}
  }

  // 掩码就绪前的兜底：落在内容块（气泡 + 鲸鱼）矩形内即视为可交互。
  //
  // 与「失败时默认视为命中」的约定一致。若这里返回 false，掩码一旦加载不出来
  // （图片缺失、解码失败），整个挂件会永久处于鼠标穿透状态——既点不动也拖不动，
  // 而且穿透是整窗的，用户没有任何入口能把它救回来。
  function isInsideContent(e) {
    try {
      const r = DSW.dom.root.getBoundingClientRect();
      return (
        e.clientX >= r.left &&
        e.clientX < r.right &&
        e.clientY >= r.top &&
        e.clientY < r.bottom
      );
    } catch (err) {
      return true;
    }
  }

  // 判断坐标是否命中鲸鱼不透明像素（掩码未就绪或失败时视为命中，避免卡死交互）。
  function isWhaleHit(e) {
    if (!DSW.hit.hitCanvas || !DSW.hit.hitReady) return isInsideContent(e);
    try {
      const r = DSW.dom.img.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return isInsideContent(e);
      const w = DSW.hit.hitCanvas.width;
      const h = DSW.hit.hitCanvas.height;
      // `.dshwv-img` 是 object-fit: contain：源图按比例缩放后居中，非正方形的
      // 自定义图会留下留白。按 contain 的实际绘制矩形反推，才能把点击点正确还原
      // 到源图像素坐标（内置正方形素材下与旧公式等价）。
      const k = Math.min(r.width / w, r.height / h);
      const offX = r.left + (r.width - w * k) / 2;
      const offY = r.top + (r.height - h * k) / 2;
      let lx = (e.clientX - offX) / k;
      let ly = (e.clientY - offY) / k;
      if (lx < 0 || ly < 0 || lx >= w || ly >= h) return false;
      if (DSW.state.h === "left") lx = w - lx;
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
    isInsideContent: isInsideContent,
  };
})(window.DSW);

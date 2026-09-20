// 小鲸鱼余额挂件 · DOM 构建模块
//
// 负责创建挂件的全部 DOM 节点（根容器、鲸鱼图片、气泡与三行文字），
// 并挂载到 DSW.dom 供其他模块使用。
// 依赖：core.js（DSW.C）。

window.DSW = window.DSW || {};

(function (DSW) {
  "use strict";

  if (DSW.dom) return;

  // 根容器。
  const root = document.createElement("div");
  root.className = "dshwv-root";

  // 鲸鱼主体图片。首帧延后到挂件本体确定后再渲染（见 main.js），
  // 避免先渲染内置素材、再切到自定义挂件组造成跨组错误切换。
  const img = document.createElement("img");
  img.className = "dshwv-img";
  img.alt = "DeepSeek 余额";
  img.draggable = false;

  // 气泡内三行文字。自上而下：余额金额 → 今日已用 → 峰谷时段倒计时。
  // 注意：顺序仅由这里的插入顺序决定，其它模块均按引用取用元素，
  // 因此调整顺序不影响渲染逻辑。
  const textBox = document.createElement("div");
  textBox.className = "dshwv-text";
  const amountEl = document.createElement("div");
  amountEl.className = "dshwv-amount";
  const hintEl = document.createElement("div");
  hintEl.className = "dshwv-hint";
  const periodEl = document.createElement("div");
  periodEl.className = "dshwv-period";
  textBox.appendChild(amountEl);
  textBox.appendChild(hintEl);
  textBox.appendChild(periodEl);

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
  // 气泡仅负责展示；点击时阻止事件冒泡，不再切换台词内容。
  bubbleBox.addEventListener("click", function (e) {
    e.stopPropagation();
  });

  // 挂件主体（图片 + 气泡）。
  const body = document.createElement("div");
  body.className = "dshwv-body";
  body.appendChild(img);
  body.appendChild(bubbleBox);

  // 翻转层：仅负责左右镜像（scaleX(-1)），与根节点的缩放 transform 分离，
  // 避免共用 transform-origin 导致贴边缩放错位。
  const scaler = document.createElement("div");
  scaler.className = "dshwv-scaler";
  scaler.appendChild(body);
  root.appendChild(scaler);
  document.body.appendChild(root);

  DSW.dom = {
    root: root,
    scaler: scaler,
    img: img,
    textBox: textBox,
    amountEl: amountEl,
    periodEl: periodEl,
    hintEl: hintEl,
    bubbleBox: bubbleBox,
    body: body,
  };
})(window.DSW);

// 小鲸鱼余额挂件 · 音效模块
//
// 统一音效分类与触发规则（模式来自音效组 meta.json，播放侧只按「槽位是否存在」判定）：
// - 仅按下（press）：鼠标按下时播放一次，松开不再播放，单次触发不会重复；
// - 仅松开（release）：鼠标松开时播放一次，按下不播放；
// - 按下 + 松开（dual）：按下播放「按下」音效、松开播放「松开」音效，两者独立互不干扰。
//
// 音频底座由 `audio-engine.js` 提供（Web Audio）：
// 上下文提前创建并预热、解码缓冲统一缓存、切换音效时彻底释放。
// 依赖：core.js（DSW.invoke/DSW.flags/DSW.C）、dom.js（DSW.dom）、audio-engine.js。

window.DSW = window.DSW || {};

(function (DSW) {
  "use strict";

  if (DSW.audio) return;

  var C = DSW.C;
  var flags = DSW.flags;
  var engine = DSW.audioEngine;

  // 当前音效组定义：
  // { id, mode: "press"|"release"|"dual", press: Clip|null, release: Clip|null }
  // Clip = { key, src, start, end, rate }
  var current = null;
  // 切换代际：切换音效后丢弃上一组的异步解析结果。
  var token = 0;
  var wakeBound = false;
  // 待机唤醒轮询定时器（退出时需清除，避免残留）。
  var wakeTimer = null;

  function presetPlan(id) {
    var preset = C.SOUND_SETS[id];
    if (!preset) return null;
    return {
      id: id,
      mode: "dual",
      press: { key: "preset:" + preset.press, src: preset.press, start: 0, end: 0, rate: 1 },
      release: { key: "preset:" + preset.release, src: preset.release, start: 0, end: 0, rate: 1 },
    };
  }

  // 解析自定义音效组：读取 meta.json，并把音频文件读成 Data URL 供解码。
  //
  // 三种模式都只按「meta.json 里存在哪些槽位」处理：
  // 仅按下只有 press、仅松开只有 release、组合模式两者都有。
  function loadCustomPlan(id) {
    return DSW.invoke("resolve_audio_group", { name: id }).then(function (group) {
      if (!group || (!group.press && !group.release)) {
        throw new Error("音效组缺少可用音频文件");
      }
      function readClip(clip) {
        return DSW.invoke("read_audio_file", { path: clip.path }).then(function (src) {
          return {
            key: clip.path,
            src: src,
            start: Number(clip.start) || 0,
            end: Number(clip.end) || 0,
            rate: Number(clip.rate) || 1,
          };
        });
      }
      var jobs = [];
      if (group.press) jobs.push(readClip(group.press));
      if (group.release) jobs.push(readClip(group.release));
      return Promise.all(jobs).then(function (list) {
        return {
          id: id,
          mode: normalizeMode(group.mode),
          // 顺序与 jobs 的入队顺序一致：先按下、后松开。
          press: group.press ? list.shift() : null,
          release: group.release ? list.shift() : null,
        };
      });
    });
  }

  // 模式归一化：历史值 single 等价于 press，非法值回落 press。
  function normalizeMode(mode) {
    if (mode === "dual") return "dual";
    if (mode === "release") return "release";
    return "press";
  }

  // 预加载（解码并缓存）音效组内的全部音频。
  function preloadPlan(plan) {
    if (!plan) return;
    [plan.press, plan.release].forEach(function (clip) {
      if (!clip) return;
      engine.decode(clip.key, clip.src).catch(function (err) {
        console.error("音效解码失败：", plan.id, err);
      });
    });
  }

  // 切换音效组：先彻底终止上一组的播放与缓存并重置音频上下文，再预加载新音效。
  function applySoundSet() {
    var id = flags.soundSet;
    token += 1;
    var myToken = token;

    // 1) 终止所有正在播放的实例、清空音频缓存队列、重置音频上下文（释放旧资源）。
    engine.reset();

    var preset = presetPlan(id);
    if (preset) {
      current = preset;
      preloadPlan(preset);
      return;
    }

    current = null;
    if (!id || !DSW.invoke) return;
    loadCustomPlan(id)
      .then(function (plan) {
        if (myToken !== token) return; // 期间又切换了音效，丢弃过期结果
        current = plan;
        preloadPlan(plan);
      })
      .catch(function (err) {
        if (myToken !== token) return;
        console.error("加载音效组失败，回退预设音效：", id, err);
        current = presetPlan("duck");
        preloadPlan(current);
      });
  }

  // 播放指定槽位（press / release）：只按该槽位是否存在判定，
  // 因此「仅松开」组在按下时静默、松开时播放。
  function playSlot(slot) {
    if (!flags.soundOn || !current) return false;
    var clip = current[slot];
    if (!clip) return false;
    return engine.play(clip.key, {
      start: clip.start,
      end: clip.end,
      rate: clip.rate,
      volume: flags.soundVol,
    });
  }

  // 提前初始化音频上下文并预热，同时登记「待机唤醒」预唤醒机制。
  function init() {
    engine.ensureContext();
    engine.prime();
    bindWake();
  }

  // 待机唤醒：窗口激活 / 鼠标进入 / 可见性恢复时恢复上下文并预热输出通道。
  function bindWake() {
    if (wakeBound) return;
    wakeBound = true;

    function softWake() {
      // 仅当上下文未处于运行态时才做恢复 + 预热，避免高频事件反复触发。
      if (engine.stats().contextState === "running") return;
      engine.wake();
    }
    function hardWake() {
      // 系统休眠 / 窗口重新激活：强制预热一次输出通道。
      engine.wake();
    }

    document.addEventListener("pointerenter", softWake, true);
    document.addEventListener("pointermove", softWake, true);
    document.addEventListener("pointerdown", softWake, true);
    window.addEventListener("focus", hardWake);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) hardWake();
    });
    // 兜底：长时间待机后上下文可能被系统挂起，定期检查并恢复。
    wakeTimer = setInterval(softWake, 30000);
  }

  // 退出前彻底释放音频资源：停掉待机轮询、终止播放与缓存、关闭音频上下文。
  function release() {
    if (wakeTimer) {
      clearInterval(wakeTimer);
      wakeTimer = null;
    }
    engine.release();
    current = null;
    token += 1;
  }

  // 按下：Q 弹变形 + 播放「按下」音效（单音效模式仅此一次）。
  function pressDown() {
    DSW.dom.body.style.transform = C.SQUISH;
    flags.pressing = true;
    if (DSW.expression && DSW.expression.cancelBlink) {
      DSW.expression.cancelBlink(false);
    }
    // 统一走状态机换图，确保自定义挂件组始终读取自身资源。
    DSW.expression.syncVisualState();
    // 播放前先确保音频上下文处于运行态，避免待机唤醒后的首次点击延迟。
    if (engine.stats().contextState !== "running") engine.wake();
    playSlot("press");
  }

  // 松开：恢复形态 + 播放「松开」音效（仅双音效模式）。
  function pressUp() {
    DSW.dom.body.style.transform = "scaleY(1) scaleX(1)";
    flags.pressing = false;
    DSW.expression.syncVisualState();
    if (DSW.expression.scheduleNextBlink) DSW.expression.scheduleNextBlink();
    playSlot("release");
  }

  DSW.audio = {
    init: init,
    applySoundSet: applySoundSet,
    release: release,
    pressDown: pressDown,
    pressUp: pressUp,
    playSlot: playSlot,
    wake: function () {
      engine.wake();
    },
    stats: function () {
      return {
        context: engine.stats(),
        mode: current ? current.mode : null,
        id: current ? current.id : null,
        hasPress: !!(current && current.press),
        hasRelease: !!(current && current.release),
      };
    },
  };
})(window.DSW);

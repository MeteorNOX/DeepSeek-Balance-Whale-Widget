// 小鲸鱼余额挂件 · 共享音频引擎
//
// 基于 Web Audio API 的统一音频底座，挂件与配置页共用：
// - 提前创建并预热 AudioContext，避免首次触发时才创建上下文导致的播放延迟；
// - 解码后的 AudioBuffer 统一缓存，支持按裁剪区间与倍速播放；
// - 可一次性终止全部正在播放的实例、断开音频图并清空缓存，
//   确保切换音效后不会残留上一次的音频触发。
//
// 依赖：无（仅使用浏览器 Web Audio API）。

window.DSWAudio = (function () {
  "use strict";

  /** 当前音频上下文。 */
  var ctx = null;
  /** 已解码缓冲：key -> AudioBuffer。 */
  var buffers = {};
  /** 音频源：key -> 可直接 fetch 的地址（用于按需解码）。 */
  var sources = {};
  /** 进行中的解码任务：key -> Promise。 */
  var decoding = {};
  /** 正在播放的节点：{ source, gain }。 */
  var active = [];

  function AudioCtor() {
    return window.AudioContext || window.webkitAudioContext || null;
  }

  // 创建（或复用）音频上下文；挂起状态自动恢复。
  function ensureContext() {
    if (!ctx) {
      var AC = AudioCtor();
      if (!AC) return null;
      try {
        ctx = new AC();
      } catch (err) {
        console.error("创建音频上下文失败：", err);
        return null;
      }
    }
    if (ctx.state === "suspended") {
      try {
        var p = ctx.resume();
        if (p && typeof p.catch === "function") p.catch(function () {});
      } catch (err) {}
    }
    return ctx;
  }

  // 播放一段极短音频，唤醒音频输出通道（待机后首次播放更接近零延迟）。
  function prime() {
    var c = ensureContext();
    if (!c) return false;
    try {
      var buffer = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * 0.02)), c.sampleRate);
      var source = c.createBufferSource();
      var gain = c.createGain();
      // 极低增益：听不见，但能让输出通道保持活跃。
      gain.gain.value = 0.0001;
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(c.destination);
      source.start(0);
      source.onended = function () {
        try {
          source.disconnect();
          gain.disconnect();
        } catch (err) {}
      };
      return true;
    } catch (err) {
      return false;
    }
  }

  // 恢复上下文并预热（待机唤醒 / 窗口激活时调用）。
  function wake() {
    var c = ensureContext();
    if (!c) return false;
    return prime();
  }

  // 解码音频源并缓存；同一 key 只解码一次。
  function decode(key, src) {
    if (buffers[key]) return Promise.resolve(buffers[key]);
    if (decoding[key]) return decoding[key];
    var c = ensureContext();
    if (!c) return Promise.reject(new Error("音频上下文不可用"));
    if (!src) return Promise.reject(new Error("缺少音频地址"));
    sources[key] = src;
    decoding[key] = fetch(src)
      .then(function (resp) {
        if (!resp.ok) throw new Error("读取音频失败：" + resp.status);
        return resp.arrayBuffer();
      })
      .then(function (data) {
        return c.decodeAudioData(data);
      })
      .then(function (buffer) {
        buffers[key] = buffer;
        delete decoding[key];
        return buffer;
      })
      .catch(function (err) {
        delete decoding[key];
        throw err;
      });
    return decoding[key];
  }

  // 播放已缓存的音频；未缓存时按需触发解码（本次不发声）。
  function play(key, opts) {
    opts = opts || {};
    var buffer = buffers[key];
    if (!buffer) {
      if (sources[key]) {
        decode(key, sources[key]).catch(function () {});
      }
      return false;
    }
    var c = ensureContext();
    if (!c) return false;
    try {
      var source = c.createBufferSource();
      source.buffer = buffer;
      var rate = Number(opts.rate);
      source.playbackRate.value = isFinite(rate) && rate > 0 ? rate : 1;
      var gain = c.createGain();
      var vol = Number(opts.volume);
      gain.gain.value = isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 1;
      source.connect(gain);
      gain.connect(c.destination);

      var start = Number(opts.start);
      if (!isFinite(start) || start < 0) start = 0;
      var end = Number(opts.end);
      var duration;
      if (isFinite(end) && end > start) duration = end - start;
      if (start > buffer.duration) start = 0;
      var node = { source: source, gain: gain };
      active.push(node);
      source.onended = function () {
        dropNode(node);
        try {
          source.disconnect();
          gain.disconnect();
        } catch (err) {}
      };
      if (duration !== undefined) source.start(0, start, duration);
      else if (start > 0) source.start(0, start);
      else source.start(0);
      return true;
    } catch (err) {
      console.error("播放音频失败：", err);
      return false;
    }
  }

  function dropNode(node) {
    var idx = active.indexOf(node);
    if (idx >= 0) active.splice(idx, 1);
  }

  // 强制终止所有正在播放的音频实例。
  function stopAll() {
    var list = active.slice();
    active = [];
    list.forEach(function (node) {
      try {
        node.source.onended = null;
        node.source.stop(0);
      } catch (err) {}
      try {
        node.source.disconnect();
        node.gain.disconnect();
      } catch (err) {}
    });
    return list.length;
  }

  // 清空音频缓存队列与进行中的解码任务。
  function clearCache() {
    buffers = {};
    decoding = {};
    sources = {};
  }

  // 重置：终止播放 + 清空缓存 + 释放旧上下文并立即重建预热。
  // 既彻底释放上一轮音频资源（杜绝残留触发），又不把上下文创建成本留到首次点击。
  function reset() {
    stopAll();
    clearCache();
    if (ctx) {
      try {
        ctx.close();
      } catch (err) {}
      ctx = null;
    }
    ensureContext();
    prime();
  }

  // 彻底释放音频资源：终止全部播放、清空解码缓存并关闭音频上下文。
  //
  // 与 reset() 的区别是不再重建上下文——退出程序前调用，确保内存立即归还。
  function release() {
    stopAll();
    clearCache();
    if (ctx) {
      try {
        ctx.close();
      } catch (err) {}
      ctx = null;
    }
  }

  function stats() {
    return {
      contextState: ctx ? ctx.state : "none",
      cacheSize: Object.keys(buffers).length,
      pending: Object.keys(decoding).length,
      activeCount: active.length,
    };
  }

  return {
    ensureContext: ensureContext,
    decode: decode,
    play: play,
    stopAll: stopAll,
    clearCache: clearCache,
    reset: reset,
    release: release,
    wake: wake,
    prime: prime,
    stats: stats,
  };
})();

(() => {
  'use strict';
  const key = 'dshw-v3-feedback', events = { press: '按下', release: '松开', success: '完成提示', cancelled: '取消提示', failed: '拥挤失败提示' };
  const defaults = () => ({ feel: 'balanced', events: Object.fromEntries(Object.keys(events).map(k => [k, { preset: k === 'press' || k === 'release' || k === 'success' ? 'original' : 'silent', volume: .8 }])) });
  let settings = defaults();
  let gestureSerial = 0, pressPlayback = Promise.resolve();
  try { const saved = JSON.parse(localStorage.getItem(key)); if (saved) { settings.feel = saved.feel || settings.feel; for (const k of Object.keys(events)) if (saved.events?.[k]) settings.events[k] = saved.events[k]; } } catch {}
  function play(event, url, master = 1, override) {
    const cfg = (override || settings).events[event];
    if (!cfg) return false;
    const options = {
      channel: event === 'press' || event === 'release' ? 'gesture' : 'notice',
      url: Array.isArray(url) ? undefined : url,
      urls: Array.isArray(url) ? url : undefined,
      preset: cfg.preset,
      volume: cfg.preset === 'silent' ? 0 : cfg.volume * master
    };
    if (event === 'press') {
      ++gestureSerial;
      pressPlayback = Promise.resolve(window.WhaleAudio.play(options));
    } else if (event === 'release') {
      const own = gestureSerial;
      Promise.resolve(pressPlayback).then(() => {
        if (own !== gestureSerial) return;
        window.WhaleAudio.play(options);
      });
    } else window.WhaleAudio.play(options);
    return true;
  }
  function cancelGesture() {
    gestureSerial++;
    pressPlayback = Promise.resolve();
    window.WhaleAudio.stop('gesture');
  }
  function open() {
    const draft = JSON.parse(JSON.stringify(settings)), dialog = document.createElement('dialog'); dialog.className = 'whale-v3-dialog';
    const title = document.createElement('h2'); title.textContent = '音效、提示与手感'; dialog.append(title);
    const help = document.createElement('p'); help.textContent = '保存后生效；取消或 Esc 放弃本次修改。总音量仍控制所有事件。原音效使用现有音效组，新增预设为原创合成短音。'; dialog.append(help);
    const feelLabel = document.createElement('label'); feelLabel.textContent = '按压手感'; const feel = document.createElement('select');
    for (const [value, text] of Object.entries({ balanced: '均衡 · 75/140ms', crisp: '清脆 · 65/125ms', soft: '柔和 · 85/155ms' })) feel.add(new Option(text, value));
    feel.value = draft.feel; feel.onchange = () => { draft.feel = feel.value; }; feelLabel.append(feel); dialog.append(feelLabel);
    for (const [event, label] of Object.entries(events)) {
      const row = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = label; row.append(legend);
      const select = document.createElement('select');
      for (const [value, text] of Object.entries({ original: '现有音效', pearl: '珍珠', bubble: '水泡', glass: '风铃', silent: '静音' })) { if (value === 'original' && !['press','release','success'].includes(event)) continue; select.add(new Option(text, value)); }
      select.value = draft.events[event].preset; select.onchange = () => { draft.events[event].preset = select.value; };
      const volume = document.createElement('input'); volume.type = 'range'; volume.min = '0'; volume.max = '1'; volume.step = '.01'; volume.value = draft.events[event].volume; volume.setAttribute('aria-label', label + '音量');
      const number = document.createElement('output'); number.textContent = Math.round(volume.value * 100) + '%';
      volume.oninput = () => { draft.events[event].volume = Number(volume.value); number.textContent = Math.round(volume.value * 100) + '%'; };
      const preview = document.createElement('button'); preview.type = 'button'; preview.textContent = '试听'; preview.onclick = () => play(event, window.WhaleFeedbackSources?.[event] || '/dsh-whale/sound/press.mp3?set=duck', 1, draft);
      row.append(select, volume, number, preview); dialog.append(row);
    }
    const actions = document.createElement('div'); actions.className = 'dialog-actions';
    const cancel = document.createElement('button'); cancel.textContent = '取消'; cancel.onclick = () => dialog.close();
    const save = document.createElement('button'); save.textContent = '保存'; save.className = 'primary'; save.onclick = () => { try { localStorage.setItem(key, JSON.stringify(draft)); settings = draft; dialog.close(); } catch { window.whaleToast?.('设置未能保存，请检查存储空间。'); } };
    actions.append(cancel, save); dialog.append(actions); dialog.addEventListener('close', () => { cancelGesture(); window.WhaleAudio.stop(); dialog.remove(); }); document.body.append(dialog); dialog.showModal();
  }
  window.WhaleFeedback = { play, open, cancelGesture, get feel() { return settings.feel; } };
})();

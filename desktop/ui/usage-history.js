(() => {
  'use strict';
  const add = (parent, tag, value) => { const node = document.createElement(tag); node.textContent = value; parent.append(node); return node; };
  const money = (value, currency) => value == null ? '未知' : `${currency} ${Number(value).toFixed(2)}${value > 0 && value < 0.01 ? '（含小额用量）' : ''}`;
  function open() {
    const dialog = document.createElement('dialog'); dialog.className = 'whale-v3-dialog';
    add(dialog, 'h2', '历史账户账本');
    add(dialog, 'p', '按匿名账户及币种查看；账户合计来自余额观测，本轮估算不会累加到账户合计。');
    const select = add(dialog, 'select', ''); select.setAttribute('aria-label', '匿名账户及币种');
    const content = add(dialog, 'div', '正在读取…');
    const close = add(dialog, 'button', '关闭'); close.onclick = () => dialog.close();
    let generation = 0;
    dialog.onclose = () => { generation++; dialog.remove(); };
    async function load() {
      const own = ++generation; content.textContent = '正在读取…';
      try {
        const response = await fetch('/dsh-whale/usage-records.json?scope=' + encodeURIComponent(select.value), { cache: 'no-store' });
        if (!response.ok) throw Error('暂时无法读取此账本');
        const data = await response.json(); if (own !== generation || !dialog.isConnected) return;
        content.replaceChildren(); add(content, 'p', '历史已观测合计：' + money(data.all.total, data.currency));
        if (!data.all.totalComplete) add(content, 'p', '部分旧日汇总缺失，合计不完整。');
        const table = add(content, 'table', ''), head = add(table, 'tr', '');
        for (const label of ['日期', '账户已观测扣费']) add(head, 'th', label);
        for (const day of data.all.days) { const row = add(table, 'tr', ''); add(row, 'td', day.date); add(row, 'td', money(day.total, data.currency)); }
        add(content, 'h3', '最近任务明细');
        for (const event of data.all.events) {
          const row = add(content, 'p', '');
          const status = { completed: '完成', failed: '失败', aborted: '取消', interrupted: '中断', superseded: '已替换' }[event.outcome] || '未知';
          row.textContent = `${event.day} · ${status} · 本轮${event.costState === 'estimated' ? '估算' : '费用'} ${money(event.cost, data.currency)} · ${Number(event.tokens || 0)} token`;
          if (event.accountIntervalAmount != null) add(row, 'small', '；账户期间扣费 ' + money(event.accountIntervalAmount, event.accountIntervalCurrency || data.currency) + '（不可归属本轮）');
        }
        add(content, 'small', data.note);
      } catch (error) { if (own === generation) content.textContent = error.message; }
    }
    select.onchange = load; document.body.append(dialog); dialog.showModal();
    fetch('/api/usage-scopes', { cache: 'no-store' }).then(r => { if (!r.ok) throw Error('账户列表读取失败'); return r.json(); }).then(data => {
      if (!dialog.isConnected) return;
      for (const item of data.scopes) { const option = add(select, 'option', item.label + (item.current ? '（当前）' : '')); option.value = item.scope; }
      if (!data.scopes.length) { content.textContent = '暂无历史账本'; return; }
      const current = data.scopes.find(item => item.current); if (current) select.value = current.scope;
      load();
    }).catch(error => { if (dialog.isConnected) content.textContent = error.message; });
  }
  const menu = document.querySelector('.dshwv-menu');
  if (menu) { const row = add(menu.querySelector('.dshwv-menu-root') || menu.firstElementChild || menu, 'div', ''); row.className = 'dshwv-menu-row'; const button = add(row, 'button', '历史账户账本'); button.className = 'dshwv-sound'; button.onclick = open; }
})();

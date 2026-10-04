// Display-only schedule. Never changes a provider bill or configured token prices.
// Rules checked against https://api-docs.deepseek.com/quick_start/pricing on 2026-09-28.
const holidays = new Set();
for (const [month, first, last] of [[1,1,3],[2,15,23],[4,4,6],[5,1,5],[6,19,21],[9,25,27],[10,1,7]]) {
  for (let day=first; day<=last; day++) holidays.add(`2026-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`);
}
const source = 'https://api-docs.deepseek.com/quick_start/pricing';
const validFrom = Date.parse('2026-09-19T00:00:00+08:00');
const validUntil = Date.parse('2027-01-01T00:00:00+08:00');
function peakAt(now) {
  const bj = new Date(now + 8 * 3600000), day = bj.getUTCDay(), hour = bj.getUTCHours();
  return day !== 0 && day !== 6 && !holidays.has(bj.toISOString().slice(0,10)) && (hour >= 9 && hour < 12 || hour >= 14 && hour < 18);
}
export function pricingSchedule(config, now = Date.now()) {
  let host;
  try { host = new URL(config?.baseUrl).hostname; } catch { return { visible:false }; }
  if (host !== 'api.deepseek.com') return { visible:false };
  // Do not silently extrapolate a holiday calendar into an unverified year.
  if (!Number.isFinite(now) || now < validFrom || now >= validUntil) return { visible:true, phase:'unknown', nextChangeAt:null, source, stale:true, note:'时段规则需更新，请查看官方定价。' };
  const peak = peakAt(now);
  let next = Math.floor(now / 3600000) * 3600000 + 3600000;
  const deadline = Math.min(now + 16 * 86400000, validUntil);
  while (next < deadline && peakAt(next) === peak) next += 3600000;
  return { visible:true, phase:peak ? 'peak' : 'off-peak', nextChangeAt:next < deadline ? next : null,
    timeZone:'Asia/Shanghai', source, rulesCheckedAt:'2026-09-28', validUntil, stale:false,
    note:next >= validUntil ? '当前规则有效至北京时间 2027-01-01 00:00；后续时段需更新，请查看官方定价。' : '北京时间工作日 09–12、14–18 为高峰；周末及法定节假日为谷期。此提示不改变账单。' };
}

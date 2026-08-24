import { DEFAULT_CREDENTIALS, DEFAULT_LABELS, normalizeOrigin } from "./lib/providers.js";
// replicate normalizeProviders from index.js
function normalizeProviders(cfg) {
  const list = Array.isArray(cfg.providers) ? cfg.providers : null
  if (!list || list.length === 0) {
    return [{ type: 'deepseek', label: DEFAULT_LABELS.deepseek, baseUrl: undefined, credential: DEFAULT_CREDENTIALS.deepseek }]
  }
  const out = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const type = raw.type
    if (type !== 'deepseek' && type !== 'newapi' && type !== 'sub2api') continue
    out.push({
      type: type,
      label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label : DEFAULT_LABELS[type],
      baseUrl: type === 'deepseek' ? undefined : normalizeOrigin(raw.baseUrl),
      credential: typeof raw.credential === 'string' && raw.credential.trim() !== '' ? raw.credential : DEFAULT_CREDENTIALS[type],
    })
  }
  if (out.length === 0) {
    return [{ type: 'deepseek', label: DEFAULT_LABELS.deepseek, baseUrl: undefined, credential: DEFAULT_CREDENTIALS.deepseek }]
  }
  return out
}
const fs = await import("node:fs");
const path = await import("node:path");
const os = await import("node:os");
// 与 lib/index.js 的 SIZE_FILE_CANDIDATES 同源：优先 $DSH_HOME，其次 ~/.dsh
const sizeCandidates = []
if (process.env.DSH_HOME) sizeCandidates.push(path.join(process.env.DSH_HOME, '.dshw-size.json'))
sizeCandidates.push(path.join(os.homedir(), '.dsh', '.dshw-size.json'))
let cfg = null
for (const p of sizeCandidates) {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (parsed && typeof parsed.scale === 'number') { cfg = parsed; break }
  } catch (err) {}
}
if (!cfg) {
  console.error('未找到 .dshw-size.json（设置 DSH_HOME 环境变量后重试）')
  process.exit(2)
}
console.log("parsed providers:", JSON.stringify(cfg.providers));
console.log("normalized:", JSON.stringify(normalizeProviders(cfg), null, 2));
console.log("size read requires scale number:", typeof cfg.scale);

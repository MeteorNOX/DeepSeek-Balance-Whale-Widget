import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import dns from 'node:dns'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  preciseMoney, addMoney, sumMoney, beijingDay, dayOffset,
  observeBalance, balanceSummary, daySummary, accountingDays, reconcileBalance,
} from './accounting.mjs'

// Node 的 fetch(undici) 可能优先 IPv6：个别域名(如 open.bigmodel.cn)有 AAAA 记录但本机 IPv6 不通，
// 会直接报 "fetch failed"（curl 会自动回退 IPv4，所以看起来正常）。统一改为 IPv4 优先。
try { dns.setDefaultResultOrder('ipv4first') } catch (err) {}

// Package root: lib/index.js -> package root. Keeps the bundle relocatable
// when installed as a normal DSH npm plugin (node_modules or a local link).
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// DSH home: used for the widget memory/role/audio files, since node_modules may
// be read-only or cleaned on update.
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

// Whale image: package-relative first (ship DSniang1/DSniang02.png in assets/),
// legacy absolute paths as fallback.
const IMAGE_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'DSniang1.png'),
  path.join(PACKAGE_ROOT, 'assets', 'DSniang02.png'),
]
// 自定义角色图片存放目录（第一个可写的会被使用；roles.json 存角色元数据）
const ROLE_DIR_CANDIDATES = [
  path.join(DSH_HOME, 'whale-roles'),
  path.join(DSH_HOME, 'profiles', 'web', 'whale-roles'),
]
const ROLE_INDEX_NAME = 'roles.json'
const ROLE_DEFAULT_ID = 'default'
// 自定义音频片段存放目录（每个片段一个 <id>.wav + audio.json 索引）
const AUDIO_DIR_CANDIDATES = [
  path.join(DSH_HOME, 'whale-audio'),
  path.join(DSH_HOME, 'profiles', 'web', 'whale-audio'),
]
const AUDIO_INDEX_NAME = 'audio.json'
// 内置预设音效组（不可删、不可改），对应 assets 里的 Ya/D 系列
const PRESET_GROUPS = {
  duck: { id: 'duck', name: '小黄鸭', press: 'ya1', release: 'ya2', preset: true },
  fx1: { id: 'fx1', name: '音效1', press: 'd1', release: 'd2', preset: true },
}
// 内置预设片段（不可删）：传统 4 个映射到 SOUND_SETS 的 mp3，exp_orb / end_a 映射到随包发布的 wav。
// mime 必须与文件字节一致（音频路由按它下发 Content-Type，不匹配会导致解码/听感异常）。
const PRESET_FRAGMENTS = {
  ya1: { id: 'ya1', name: '小黄鸭·按下', preset: true, mime: 'audio/mpeg' },
  ya2: { id: 'ya2', name: '小黄鸭·松开', preset: true, mime: 'audio/mpeg' },
  d1: { id: 'd1', name: '音效1·按下', preset: true, mime: 'audio/mpeg' },
  d2: { id: 'd2', name: '音效1·松开', preset: true, mime: 'audio/mpeg' },
  // 任务结束音的内置默认音效(随包资源,用户库缺失时回退内置文件)
  exp_orb: { id: 'exp_orb', name: 'Minecraft·经验球', preset: true, mime: 'audio/wav' },
  // 任务结束音 A(随包资源):原为用户音效库里的自导入片段，现作为内置预设随包发布。
  // 显示名与用户库里同名片段一致时，前端下拉按显示名去重（内置与前端的同名条目只出现一条）。
  end_a: { id: 'end_a', name: 'A', preset: true, mime: 'audio/wav' },
}
// 内置片段的音频文件：包内 assets 优先，开发环境回退到 skin 目录
const BUILTIN_FRAGMENT_FILES = {
  exp_orb: [
    path.join(PACKAGE_ROOT, 'assets', 'minecraft-exp-orb.wav'),
  ],
  // 任务结束音 A：随包发布 assets/task-end-a.wav（1.81s / 48kHz / 立体声 / 16bit PCM）
  end_a: [
    path.join(PACKAGE_ROOT, 'assets', 'task-end-a.wav'),
  ],
}
// —— 自定义 API 模型（v655）：非 DeepSeek 厂商的余额 / 用量 / 提醒 ——
// 注册表落在 $DSH_HOME/.dshw-api.json；密钥走 DSH 官方凭据（ctx.credentials），本文件不存明文。
const API_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-api.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-api.json'),
]
const API_BUILTIN_ID = 'deepseek'
// 「充值 / 余额校正」只属于固定的 DeepSeek（内置）：模型条目下发 canAdjustBalance，路由层再校验一次。
// 新增厂商模板 / 手动新增的同名模型 / Kimi 等其它厂商都不会继承这个能力。
function canAdjustBuiltinBalance(model) {
  return !!(model && model.id === API_BUILTIN_ID && model.builtin === true && model.provider === 'deepseek')
}
// 内置厂商模板：balance 描述「怎么取余额」。json 路径支持 a.b[0].c；scale 为取值后的乘数。
// 余额接口已按官方文档 / 社区参考核对（DeepSeek、OpenRouter、Kimi、阶跃、Novita、OpenAI 兼容中转站）；
// 硅基流动的余额接口已官方下线（410），故改为「无余额接口 + /v1/models 探活」；
// 火山方舟同理（余额/用量属火山引擎 AK/SK 签名的 OpenAPI）。其余厂商可选用 custom 手填 URL 与字段路径。
// 厂商模板下拉的排序键（v726）：英文名直接用；中文名取首字的拼音，让中英文按 A→Z **混排**。
// 为什么不用 localeCompare：ICU 默认把汉字排到拉丁字母之后，中文厂商会被整段甩到列表末尾。
// 新增中文厂商时在下面补一行（键 = 厂商名首字）。
const TPL_PINYIN_INITIAL = { 阿: 'a', 百: 'bai', 本: 'ben', 硅: 'gui', 火: 'huo', 阶: 'jie', 魔: 'mo', 腾: 'teng', 讯: 'xun', 智: 'zhi', 自: 'zi' }
function tplSortKey(name) {
  const s = String(name || '').trim()
  if (!s) return ''
  const py = TPL_PINYIN_INITIAL[s.slice(0, 1)]
  return py || s.toLowerCase()
}
const API_TEMPLATES = {
  deepseek: {
    name: 'DeepSeek', currency: 'CNY', keyRef: 'DEEPSEEK_API_KEY', builtin: true,
    balance: { url: 'https://api.deepseek.com/user/balance', auth: 'Bearer {key}', json: { remaining: 'balance_infos[0].total_balance' } },
  },
  openrouter: {
    name: 'OpenRouter', currency: 'USD', keyRef: 'OPENROUTER_API_KEY',
    balance: { url: 'https://openrouter.ai/api/v1/credits', auth: 'Bearer {key}', json: { total: 'data.total_credits', used: 'data.total_usage' } },
  },
  siliconflow_cn: {
    name: '硅基流动（CN）', currency: 'CNY', keyRef: 'SILICONFLOW_API_KEY', noBalanceApi: true,
    // ⚠️ 官方已下线余额接口（不是"暂时故障"）——2026-08-11 更新公告《【接口服务调整】/user/info 接口将停止服务》：
    //   「/user/info 已无法适配平台用户账户体系，该 API 将于 2026-08-14 正式停止服务，届时接口将不再可用」，
    //   并称「后续将适时提供账户层面的替代 API，新接口上线后将在本页面另行通知」。
    //   截至 2026-09-14，公告页最新条目（2026.09.09）**仍未见替代 API**；CN 文档「平台系列」也只剩「获取用户模型列表」。
    //   v724 路由实测：/v1 下未知路径 404、而 /v1/user/info 仍返 401（鉴权层）→ 路由没被摘掉，但按公告已不可用。
    //   → 日后官方恢复或上线替代接口：把 url 与 json 字段路径填回来即可（模板只是默认值，用户可覆盖）。
    apiNote: '官方已下线 /user/info 余额接口（2026-08-14 起停止服务；公告称后续会提供替代 API，暂未上线）→ 余额显示「—」，今日已用按会话事件估算；「测试连通性」用 /v1/models 验证 key',
    matchIds: ['siliconflow', 'Qwen', 'deepseek-ai'],
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
    probeUrl: 'https://api.siliconflow.cn/v1/models',
  },
  siliconflow_en: {
    name: '硅基流动（EN）', currency: 'USD', keyRef: 'SILICONFLOW_API_KEY', noBalanceApi: true,
    // 同国内站：余额接口已停止服务。注意国际站文档 docs.siliconflow.com 至今仍挂着 Retrieve user info 页
    //（文档未同步），不能据此认为接口可用 —— 以国内官方公告为准。
    apiNote: '同国内站：/user/info 余额接口已停止服务（国际站文档尚未同步）→ 余额「—」，今日已用按会话事件估算',
    matchIds: ['siliconflow', 'Qwen', 'deepseek-ai'],
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
    probeUrl: 'https://api.siliconflow.com/v1/models',
  },
  moonshot: {
    // 大陆站：api.moonshot.cn，余额为人民币（充值 + 代金券合计）。v724 实测：200 且字段命中 ✓
    name: 'Kimi / Moonshot（CN）', currency: 'CNY', keyRef: 'MOONSHOT_API_KEY', matchIds: ['moonshot', 'kimi'],
    balance: { url: 'https://api.moonshot.cn/v1/users/me/balance', auth: 'Bearer {key}', json: { remaining: 'data.available_balance' } },
    probeUrl: 'https://api.moonshot.cn/v1/models',
  },
  moonshot_intl: {
    // 国际站是独立账号体系（key 不通用），余额按美元计
    name: 'Kimi / Moonshot（国际）', currency: 'USD', keyRef: 'MOONSHOT_INTL_API_KEY',
    balance: { url: 'https://api.moonshot.ai/v1/users/me/balance', auth: 'Bearer {key}', json: { remaining: 'data.available_balance' } },
    probeUrl: 'https://api.moonshot.ai/v1/models',
  },
  stepfun: {
    name: '阶跃星辰 StepFun', currency: 'CNY', keyRef: 'STEPFUN_API_KEY', matchIds: ['stepfun', 'step-'],
    balance: { url: 'https://api.stepfun.com/v1/accounts', auth: 'Bearer {key}', json: { remaining: 'balance' } },
  },
  novita: {
    name: 'Novita AI', currency: 'USD', keyRef: 'NOVITA_API_KEY', matchIds: ['novita'],
    balance: { url: 'https://api.novita.ai/v3/user/balance', auth: 'Bearer {key}', json: { remaining: 'availableBalance', scale: 0.0001 } },
  },
  volcengine_ark: {
    name: '火山方舟 Ark', currency: 'CNY', keyRef: 'ARK_API_KEY', noBalanceApi: true,
    // 方舟没有「用 API key 查余额」的接口（余额/用量属于火山引擎 AK/SK 签名的 OpenAPI）。
    // v724 实测：/api/v3/models → 200（探活可用）；/api/v3/balance → 404（无余额接口，确认）。
    apiNote: '余额/用量需火山引擎 AK/SK 签名的 OpenAPI（或控制台）→ 余额「—」，今日已用按会话事件估算；探活用 /api/v3/models（实测可用）',
    matchIds: ['doubao', 'ep-'],
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
    probeUrl: 'https://ark.cn-beijing.volces.com/api/v3/models',
  },
  // —— 订阅额度（Coding Plan）模板：kind='quota'，语义是"窗口用量% + 重置时间"，不是钱 ——
  // 注意：这些接口只对「订阅套餐」账号有效。买 Token 包（资源包）的账号查不到额度
  // （智谱会返回「当前用户不存在coding plan」），那种情况用模型菜单里的
  // 「额度（订阅/资源包）」按会话 token 自动统计。
  zhipu_glm_coding: {
    name: '智谱 GLM Coding Plan（订阅）', currency: 'CNY', keyRef: 'ZHIPU_API_KEY', kind: 'quota',
    quota: {
      url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      auth: '{key}', // 智谱此接口不带 Bearer
      json: { percent: 'data.limits[0].TOKENS_LIMIT.percentage', resetAt: 'data.limits[0].nextResetTime', level: 'data.level' },
    },
    probeUrl: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
  },
  kimi_coding: {
    name: 'Kimi Coding（订阅）', currency: 'CNY', keyRef: 'KIMI_CODING_KEY', kind: 'quota',
    quota: {
      url: 'https://api.kimi.com/coding/v1/usages',
      auth: 'Bearer {key}',
      json: { remain: 'usage.remaining', total: 'usage.limit', resetAt: 'usage.resetTime' },
    },
    probeUrl: 'https://api.kimi.com/coding/v1/usages',
  },
  minimax_coding: {
    name: 'MiniMax Coding（订阅）', currency: 'CNY', keyRef: 'MINIMAX_API_KEY', kind: 'quota',
    quota: {
      url: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
      auth: 'Bearer {key}',
      json: {
        remainPct: 'model_remains[0].current_interval_remaining_percent',
        weeklyRemainPct: 'model_remains[0].current_weekly_remaining_percent',
        resetAtMs: 'model_remains[0].end_time',
      },
    },
    probeUrl: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  },
  // OpenCode Go（订阅）：一次返回 rolling / weekly / monthly 三个窗口，值为「已用% + 重置时间」
  // （usage.rolling|weekly|monthly.{percent,resetsAt}）。走多窗口路径 json.windows，见 fetchModelQuota。
  // 鉴权只需 Authorization: Bearer <key>（2026-09 实测：x-api-key 单独使用返回 401，无需额外请求头）。
  opencode_go: {
    name: 'OpenCode Go（订阅）', currency: 'USD', keyRef: 'OPENCODE_GO_API_KEY', kind: 'quota',
    quota: {
      url: 'https://opencode.ai/zen/go/v1/usage',
      auth: 'Bearer {key}',
      json: {
        windows: [
          { key: 'rolling', label: '5h', percent: 'usage.rolling.percent', resetAt: 'usage.rolling.resetsAt' },
          { key: 'weekly', label: '周', percent: 'usage.weekly.percent', resetAt: 'usage.weekly.resetsAt' },
          { key: 'monthly', label: '月', percent: 'usage.monthly.percent', resetAt: 'usage.monthly.resetsAt' },
        ],
      },
    },
    probeUrl: 'https://opencode.ai/zen/go/v1/usage',
  },
  openai_compat: {
    name: 'OpenAI 兼容中转站', currency: 'USD', keyRef: 'CUSTOM_API_KEY', needsBaseUrl: true,
    // OneAPI / New API 一类网关的经典账单接口：额度(美元) + 已用(美分)
    balance: {
      url: '{base}/v1/dashboard/billing/subscription', auth: 'Bearer {key}', json: { total: 'hard_limit_usd' },
      usage: { url: '{base}/v1/dashboard/billing/usage', auth: 'Bearer {key}', json: { used: 'total_usage', scale: 0.01 } },
    },
  },
  custom: {
    name: '自定义 HTTP', currency: 'CNY', keyRef: 'CUSTOM_API_KEY',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  // —— Codex 模式（第一期：本地会话统计）——
  // 不查余额、不联网、不用凭据：直接读 ~/.codex/sessions 的 rollout-*.jsonl 统计 token。
  // 好处：能覆盖「不在 DSH 里跑」的 Codex 使用；坏处：只有 token，没有金额（费用另由余额/额度口径处理）。
  codex: {
    name: 'Codex（本地会话）', currency: 'CNY', keyRef: '', kind: 'codex',
    balance: { url: '', auth: '', json: { remaining: '' } },
  },
  // ================= v724：补齐「官方没有用 API key 查余额的接口」的常用厂商 =================
  // 作用：① 选完自动填好 凭据名 / 币种 / 事件匹配(matchIds) / 探活地址 ②「测试连通性」可验证 key
  // ③ 余额显示「—」，今日已用按本机会话事件估算（noBalanceApi + apiNote 会显示在面板提示里）。
  // 说明：probeUrl 一律用各家的 OpenAI 兼容 /v1/models（官方文档形态，能否通过取决于 key 权限）。
  openai: {
    name: 'OpenAI', currency: 'USD', keyRef: 'OPENAI_API_KEY', noBalanceApi: true,
    apiNote: '官方已下线 billing 余额接口，没有「用 API key 查余额」的公开接口（只能看控制台）→ 余额「—」，今日已用按会话事件估算',
    matchIds: ['gpt', 'o1-', 'o3-', 'o4-', 'chatgpt'],
    probeUrl: 'https://api.openai.com/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  anthropic: {
    name: 'Anthropic Claude', currency: 'USD', keyRef: 'ANTHROPIC_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口；用量要走 Admin API（需 admin key）或控制台。注意其探活需要 x-api-key + anthropic-version 两个请求头，本挂件暂不支持 → 不提供探活',
    matchIds: ['claude'],
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  gemini: {
    name: 'Google Gemini', currency: 'USD', keyRef: 'GEMINI_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口（配额只在 AI Studio / Cloud 控制台）→ 余额「—」，今日已用按会话事件估算；探活用 ?key= 形式',
    matchIds: ['gemini'],
    probeUrl: 'https://generativelanguage.googleapis.com/v1beta/models?key={key}',
    balance: { url: '', auth: '', json: { remaining: '' } },
  },
  xai: {
    name: 'xAI Grok', currency: 'USD', keyRef: 'XAI_API_KEY', noBalanceApi: true,
    apiNote: '官方无公开的余额查询接口（额度在 console.x.ai）→ 余额「—」，今日已用按会话事件估算',
    matchIds: ['grok'],
    probeUrl: 'https://api.x.ai/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  groq: {
    name: 'Groq', currency: 'USD', keyRef: 'GROQ_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口（免费额度/速率在控制台看）→ 余额「—」，今日已用按会话事件估算',
    matchIds: ['llama', 'mixtral', 'qwen', 'deepseek', 'gemma', 'whisper'],
    probeUrl: 'https://api.groq.com/openai/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  mistral: {
    name: 'Mistral AI', currency: 'USD', keyRef: 'MISTRAL_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['mistral', 'codestral', 'magistral', 'pixtral', 'ministral'],
    probeUrl: 'https://api.mistral.ai/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  together: {
    name: 'Together AI', currency: 'USD', keyRef: 'TOGETHER_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['meta-llama', 'Qwen', 'deepseek', 'mistralai', 'nvidia'],
    probeUrl: 'https://api.together.xyz/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  fireworks: {
    name: 'Fireworks AI', currency: 'USD', keyRef: 'FIREWORKS_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['accounts/fireworks', 'llama-v3', 'qwen'],
    probeUrl: 'https://api.fireworks.ai/inference/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  deepinfra: {
    name: 'DeepInfra', currency: 'USD', keyRef: 'DEEPINFRA_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['meta-llama', 'Qwen', 'deepseek'],
    probeUrl: 'https://api.deepinfra.com/v1/openai/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  cerebras: {
    name: 'Cerebras', currency: 'USD', keyRef: 'CEREBRAS_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['llama', 'qwen'],
    probeUrl: 'https://api.cerebras.ai/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  dashscope: {
    name: '阿里云百炼（通义千问）', currency: 'CNY', keyRef: 'DASHSCOPE_API_KEY', noBalanceApi: true,
    apiNote: '云厂商：余额/账单要走阿里云 AK/SK 的 OpenAPI（或控制台），API key 查不到 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['qwen', 'qwq', 'qvq'],
    probeUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  qianfan: {
    name: '百度千帆（文心）', currency: 'CNY', keyRef: 'QIANFAN_API_KEY', noBalanceApi: true,
    apiNote: '云厂商：余额/账单要走百度云 AK/SK（或控制台），API key 查不到 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['ernie'],
    probeUrl: 'https://qianfan.baidubce.com/v2/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  hunyuan: {
    name: '腾讯混元', currency: 'CNY', keyRef: 'HUNYUAN_API_KEY', noBalanceApi: true,
    apiNote: '云厂商：余额/账单要走腾讯云 SecretId/Key（或控制台），API key 查不到 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['hunyuan'],
    probeUrl: 'https://api.hunyuan.cloud.tencent.com/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  spark: {
    name: '讯飞星火', currency: 'CNY', keyRef: 'SPARK_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口（额度在控制台）→ 余额「—」，今日已用按会话事件估算',
    matchIds: ['spark', 'generalv', '4.0ultra'],
    probeUrl: 'https://spark-api-open.xf-yun.com/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  modelscope: {
    name: '魔搭 ModelScope', currency: 'CNY', keyRef: 'MODELSCOPE_API_KEY', noBalanceApi: true,
    apiNote: '官方无余额接口 → 余额「—」，今日已用按会话事件估算',
    matchIds: ['Qwen', 'deepseek', 'MiniMax', 'glm'],
    probeUrl: 'https://api-inference.modelscope.cn/v1/models',
    balance: { url: '', auth: 'Bearer {key}', json: { remaining: '' } },
  },
  ollama: {
    name: '本地模型（Ollama / LM Studio）', currency: 'CNY', keyRef: '', noBalanceApi: true, needsBaseUrl: true,
    apiNote: '本地推理没有余额概念 → 余额「—」；填好 Base URL（如 http://127.0.0.1:11434/v1）后按会话事件统计 token',
    matchIds: ['llama', 'qwen', 'gemma', 'deepseek', 'mistral', 'phi'],
    probeUrl: '{base}/v1/models',
    balance: { url: '', auth: '', json: { remaining: '' } },
  },
  zhipu_glm_coding_intl: {
    name: '智谱 GLM Coding Plan（国际 z.ai）', currency: 'USD', keyRef: 'ZHIPU_INTL_API_KEY', kind: 'quota',
    quota: {
      url: 'https://api.z.ai/api/monitor/usage/quota/limit',
      auth: '{key}', // 与国内站一样不带 Bearer
      json: { percent: 'data.limits[0].TOKENS_LIMIT.percentage', resetAt: 'data.limits[0].nextResetTime', level: 'data.level' },
    },
    probeUrl: 'https://api.z.ai/api/monitor/usage/quota/limit',
  },
  minimax_coding_intl: {
    name: 'MiniMax Coding（国际）', currency: 'USD', keyRef: 'MINIMAX_INTL_API_KEY', kind: 'quota',
    quota: {
      url: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
      auth: 'Bearer {key}',
      json: {
        remainPct: 'model_remains[0].current_interval_remaining_percent',
        weeklyRemainPct: 'model_remains[0].current_weekly_remaining_percent',
        resetAtMs: 'model_remains[0].end_time',
      },
    },
    probeUrl: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
  },
}

// Size memory file: prefer writable DSH home locations, then legacy fallbacks.
const SIZE_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-size.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-size.json'),
]
// Usage ledger file (小鲸鱼记账 mode): same policy as the size file.
const USAGE_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-usage.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-usage.json'),
]
// 每轮消耗 seq 持久化文件：避免插件热重载后 seq 归零导致页面把新轮次误判为旧轮次吞掉
const TURN_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-turn.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-turn.json'),
]
// Sound assets: package-relative first (ship Ya1/Ya2/D1/D2.mp3 in assets/),
// legacy absolute paths as fallback.
const BUBBLE_FILE_CANDIDATES = [
  // v728：发布版会删掉开发机路径（§9.4），所以这里必须有 $DSH_HOME 兜底 ——
  // 否则清完这个数组会变成空的：泡泡配置读不了也存不了（自定义泡泡整体失效）。
  path.join(DSH_HOME, '.dshw-bubble.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-bubble.json'),
]
// 泡泡图库(独立于角色图库):图片文件目录 + 索引
const BUBBLE_IMG_DIR_CANDIDATES = [
  // v728：同理必须有 $DSH_HOME 兜底 —— pickBubbleImgDir() 遍历失败还会取 [0]，
  // 空数组会让图库上传直接报错。
  path.join(DSH_HOME, 'whale-bubble-imgs'),
  path.join(DSH_HOME, 'profiles', 'web', 'whale-bubble-imgs'),
]
const BUBBLE_IMG_INDEX_NAME = 'bubble-imgs.json'
// 内置默认泡泡图(语义 id → assets 文件):面板常驻可选;全新安装无用户图库时
// bubble-img.png 从内置清单回退加载。文件同时位于 package assets/ 与开发回退目录。
const DEFAULT_BUBBLE_IMGS = [
  { id: 'bimg_petpet', name: 'petpet', file: 'bubble-petpet.gif', format: 'gif' },
  { id: 'bimg_money1', name: 'money1', file: 'bubble-money1.gif', format: 'gif' },
]
function bubbleImgFileCandidates(file) {
  return [
    path.join(PACKAGE_ROOT, 'assets', file),
  ]
}
function loadBuiltinBubbleImgBytes(def) {
  if (!def || !def.file) return null
  for (const p of bubbleImgFileCandidates(def.file)) {
    try {
      const bytes = fs.readFileSync(p)
      if (bytes && bytes.length > 0) return bytes
    } catch (err) {}
  }
  return null
}
const SOUND_SETS = {
  duck: { press: [path.join(PACKAGE_ROOT, 'assets', 'Ya1.mp3')], release: [path.join(PACKAGE_ROOT, 'assets', 'Ya2.mp3')] },
  fx1: { press: [path.join(PACKAGE_ROOT, 'assets', 'D1.mp3')], release: [path.join(PACKAGE_ROOT, 'assets', 'D2.mp3')] },
}
function soundSetFromUrl(url) {
  try {
    const q = String(url || '').split('?')[1] || ''
    const m = /(?:^|&)set=([^&]+)/.exec(q)
    return m ? decodeURIComponent(m[1]) : ''
  } catch (err) { return '' }
}
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TTL_MS = 25000
const RUA_GIF_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'rua.gif'),
]
// DeepSeek CNY prices per million tokens: [空闲时段价, 高峰时段价].
// 高峰时段（官方 2026-09-19 说明，见 docs 脚注 (2)）：**北京时间周一至周五（不含中国法定节假日）
// 9:00–12:00、14:00–18:00**；其余时段 —— 包括**周末、调休上班的周末、以及中国法定节假日全天** ——
// 一律按空闲时段计费。
//   时间线：2026-08-17 峰谷定价正式实施 → 2026-08-23 00:00 起周末全天谷价 →
//           2026-09-19 明确「调休上班的周末 + 法定节假日全天」也按空闲计。
// 价格来源：官方 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// 2026-09-10 起 Flash 系列降价：缓存命中 0.05→0.02、未命中 1.5→1、输出 4.5→4（高峰=空闲×2）。
// 2026-09-19 复核：价格数字与上表一致（Flash 0.02/1/4 与 0.04/2/8；Pro 0.15/4.5/13.5 与 0.30/9/27），
//           峰谷规则新增「法定节假日全天谷价」这一条，见下方 HOLIDAY_VALLEY。
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]
// Flash（正式模型名 deepseek-flash = DeepSeek-V4.1-Flash）
const BASE_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
// Pro 为 Flash 的 3 倍价（官方 2026-08-17 生效）。官方 2026-09-14 公告：V4 Pro 继续提供 API 服务、
// 计费方式保持不变——此前"9/14 12:00 起 pro 请求路由到 V4.1 Flash 并按 Flash 价计费"的安排已取消，
// 因此这里不做按日期的降级切换。
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = {
  'deepseek-flash': BASE_PRICE,
  'deepseek-v4-flash-vision-exp': BASE_PRICE, // 旧名已下线,请求由 V4.1-Flash 提供,按 Flash 价计费
  'deepseek-v4-flash': BASE_PRICE, // 同上
  'deepseek-v4-pro': PRO_PRICE,
  _default: BASE_PRICE,
}
// 用户自定义单价（自定义 API 模型面板里填的「元/百万 token」），按 matchIds 子串匹配，优先于内置价目表
let CUSTOM_PRICES = {}
// 自定义单价的币种/汇率（与 CUSTOM_PRICES 同键）：单价若按美元填写，记账时按用户填的汇率换算成人民币
let CUSTOM_PRICE_META = {}
function customPriceMetaFor(model) {
  const m = String(model || '').toLowerCase()
  // 按键长降序：最长命中优先，避免短关键字（如 pro）误伤别的模型
  for (const key of Object.keys(CUSTOM_PRICE_META).sort((a, b) => b.length - a.length)) {
    if (key && m.indexOf(key) !== -1) return CUSTOM_PRICE_META[key]
  }
  return null
}
function priceFor(model) {
  const m = String(model || '').toLowerCase()
  // 自定义单价同样按键长降序匹配（与 customPriceMetaFor 保持一致）
  for (const key of Object.keys(CUSTOM_PRICES).sort((a, b) => b.length - a.length)) {
    if (key && m.indexOf(key) !== -1) return CUSTOM_PRICES[key]
  }
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  return PRICING._default
}
// bucket time is an epoch second; derive the Beijing local hour to pick peak vs off-peak price.
// 2026-08-23 起（北京时间）周末（周六/周日）全天按谷价；生效时刻之前的历史
// 分桶仍按旧规则计价，所以周末判定带生效分界。
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000) // = 北京时间 2026-08-23 00:00
// ===== 法定节假日全天谷价（官方 2026-09-19 说明）=====
// 依据：《国务院办公厅关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7 号，2025-11-04）
//       + DeepSeek API 官方计费脚注「周一至周五（不含中国法定节假日）…其余时段，包括周末及
//       中国法定节假日全天均为空闲时段」。
// 只需列**放假**的日期：调休上班日全部落在周末（2026 年为 1/4、2/14、2/28、5/9、9/20、10/10），
// 按"周末也算谷价"的规则本来就是谷价，无需单列。
// ⚠️ **每年 11 月国务院发布次年安排后，必须在这里补下一年的日期**（探针 `_peak-holiday-check.mjs`
// 会检查当年是否已覆盖并给出提醒）。
const HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1, // 元旦 1/1–1/3（1/4 周日上班）
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1, // 春节 2/15–2/23（9 天）
  '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1, // 清明 4/4–4/6
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1, // 劳动节 5/1–5/5（5/9 周六上班）
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1, // 端午 6/19–6/21
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1, // 中秋 9/25–9/27
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1, // 国庆 10/1–10/7（9/20 周日、10/10 周六上班）
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
}
// 这条规则自 2026-09-19 起生效（此前历史分桶按旧规则计价）。2026 年内落在 8/17（峰谷机制实施）
// 与 9/19 之间没有任何"工作日的法定节假日"，所以对 2026 年的账目没有影响；次年（2027）之后
// 整年的节假日都会走到这个分支。
const HOLIDAY_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000) // = 北京时间 2026-09-19 00:00
// 下发给前端（挂件）的节假日清单：前端「时段倒计时」也要按节假日算下一切换点，
// 而前端无法自己知道法定安排，所以由宿主单一来源下发。每次 /dsh-whale/balance 都会带上。
const HOLIDAY_VALLEY_LIST = Object.keys(HOLIDAY_VALLEY).sort()
function isHolidayValley(bjDate) {
  try {
    return !!HOLIDAY_VALLEY[bjDate.toISOString().slice(0, 10)]
  } catch (err) { return false }
}
function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay() // 0=周日 6=周六（bj 按 UTC 读即为北京日历日）
    if (dow === 0 || dow === 6) return false
  }
  // 法定节假日全天谷价（含调休放假的工作日）
  if (n >= HOLIDAY_VALLEY_FROM_SEC && isHolidayValley(bj)) return false
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}
// 下一个峰谷切换时刻（epoch 秒）：与 isPeakTime 完全同源（含周末 + 法定节假日规则）。
// 只需扫北京时间的小时边界 0/9/12/14/18 点；最长假期（春节 9 天）也只到第 9 天，
// 这里扫 12 天留足余量。返回 null 表示 12 天内没有切换点（当前规则下不会发生），
// 由前端回退到自己的本地推算。
function nextPeakChangeAt(timeSec) {
  const n = Number(timeSec)
  if (!isFinite(n)) return null
  const cur = isPeakTime(n)
  const day0 = Math.floor((n + 8 * 3600) / 86400) * 86400 // 北京当日 00:00（在 +8h 平移坐标系里）
  for (let d = 0; d <= 12; d++) {
    for (const edge of [0, 9, 12, 14, 18]) {
      const cand = day0 + d * 86400 + edge * 3600 - 8 * 3600
      if (cand <= n + 1) continue
      if (isPeakTime(cand) !== cur) return cand
    }
  }
  return null
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
}

// 浏览器端挂件代码已拆分为独立文件 whale-widget.js(与本文件同目录),
// 不再内嵌模板字面量:可直接 node --check / IDE 高亮,改 widget 后硬刷新页面即生效(无需重启 DSH)。
// 每次请求按 mtime 判断是否需要重读,避免常驻缓存导致改了不生效。
const WIDGET_FILE_CANDIDATES = [
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'whale-widget.js'),
  path.join(PACKAGE_ROOT, 'whale-widget.js'),
  path.join(PACKAGE_ROOT, 'assets', 'whale-widget.js'),
]
let widgetJsCache = null // { text, mtimeMs }
function loadWidgetJs() {
  for (const p of WIDGET_FILE_CANDIDATES) {
    try {
      const st = fs.statSync(p)
      if (widgetJsCache && widgetJsCache.mtimeMs === st.mtimeMs) return widgetJsCache.text
      const text = fs.readFileSync(p, 'utf8')
      widgetJsCache = { text, mtimeMs: st.mtimeMs }
      return text
    } catch (err) {}
  }
  return widgetJsCache ? widgetJsCache.text : ''
}

// —— 桌面端（Electron）结构化注入行：**内联 script 行**，不是 script-src 行（issue #154）——
// 桌面壳的 index.html 从安装包静态 dist 直出，`tapIndex`（函数变换）永远过不去；唯一通道是
// `webserver/index-inject` 推的结构化行，经 IPC 交给页面侧解释器逐行应用。
// 但解释器对两种 script 行的处理**不对称**（desktop 前端 `web-boot`）：
//   case "script":     createElement + textContent + append   —— 没有 await，**不可能"加载失败"**
//   case "script-src": await loadScript(src)                   —— 失败即 reject，而那个 reject 会
//                                                                reject 掉 __DSH_BOOT_READY__ ⇒ **应用起不来**
// 再加一层：外壳把这张表在**宿主启动时收集一次**后缓存，**没有任何刷新路径** ⇒ 插件在运行期被关掉时，
// 表里仍留着这一行，而 `/dsh-whale/*` 路由已注销 ⇒ 加载 404 ⇒ 就是 issue #154 那个
// "desktop web: failed to load /dsh-whale/widget.js" 致命错误。
// 所以改成内联行：由**我们自己**建 `<script src=…>` 并**吞掉** onerror —— 路由在就正常加载，
// 路由不在就静默失败，宿主永远不会因为我们起不来。
const DESKTOP_WIDGET_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="/dsh-whale/widget.js";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

export default {
  name: 'whale-balance-widget',
  // v758：**有意去掉对象级 `inject: ['webServer','credentials','connection']`**（issue #154 的隐患面）。
  // 对象级 inject 会把整个 apply() 推迟到三个服务就绪之后；而桌面端的注入表是**宿主启动时一次性
  // 收集**的（`dsh-desktop-host`：`collectIndexInjections()` → IPC → 渲染层），订阅一旦晚于那次收集，
  // 这一行就永远进不了表 = 桌面端挂件完全不出现（#152/#153 那位报告人无法稳定复现的正是这个竞态）。
  // 现在 apply() 立刻执行、**第一件事就是注册注入行**（它不依赖任何服务），其余逻辑原样放进
  // `root.inject([...], cb)` 局部等待 —— 语义与原来的对象级 inject 等价，但行的注册不再被推迟。
  apply(root) {
    const rowDisposers = []
    root.effect(() => () => { for (const d of rowDisposers) { try { d() } catch (err) {} } })
    // ① 结构化注入行：桌面端唯一能生效的通道（web 形态另有 tapIndex，两条并存、各自去重）
    rowDisposers.push(root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (!row) continue
          if (row.kind === 'script-src' && row.src === '/dsh-whale/widget.js') return // 旧版本推过 → 不重复
          if (row.kind === 'script' && typeof row.text === 'string'
            && row.text.indexOf('/dsh-whale/widget.js') >= 0) return
        }
        table.push({ kind: 'script', placement: 'body', text: DESKTOP_WIDGET_ROW_TEXT })
      } catch (err) {}
    }))

    // ② 其余逻辑：等齐三个服务后再跑（等价于原来的对象级 inject，但不再挡住 ①）
    root.inject(['webServer', 'credentials', 'connection'], (ctx) => {
    // —— 浏览器信任栅栏（issue #92 建立，issue #136 补 fail-closed）——
    // dsh 的 connection 服务提供 requestRejection(req)：Host/Origin 被伪造（DNS 重绑定）或未认证的
    // 请求必须被拒。**但这个方法在较老的 dsh 上不存在**（#136 实测：0.1.5-rc.2/rc.3 有、0.1.0-rc.3 没有），
    // 而旧实现在"服务缺失"与"栅栏自己抛异常"两条路径上都是 fail-open（放行）—— 于是 22 条 /dsh-whale/*
    // 路由会**集体**失去校验：伪造 Host 可读写、普通跨站 POST 可直接写配置，而 api-models.json 还连着
    // ctx.credentials（可 set/delete key）。现在改成三层：
    //   ① **插件自己的轻量校验**（永远先跑；正常浏览器与本地脚本都不受影响）：
    //      Host 必须是回环权威或 DSHW_TRUSTED_HOSTS 里显式声明的，`Sec-Fetch-Site: cross-site` 一律拒，
    //      带 Origin 时必须与 Host 同源；
    //   ② 宿主栅栏可用 → **委托**它（不重写它的语义：它里面还有一层浏览器鉴权 401），返回码照用；
    //      **它抛异常则按拒绝处理**（旧实现这条路径静默放行，且连 warn 都没有）；
    //   ③ 宿主栅栏不可用 → 只靠 ①，并在**插件加载时**就打一条醒目 warn（不是等第一次请求才打）。
    const TRUSTED_AUTHORITIES = String(process.env.DSHW_TRUSTED_HOSTS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    // 只认回环：localhost / *.localhost / 127.0.0.0/8（逐段校验，防 `127.0.0.1.evil.com` 这类相似域名）/ ::1
    function isLoopbackHostname(hn) {
      const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
      if (!h) return false
      if (h === 'localhost' || h.endsWith('.localhost')) return true
      if (h === '::1') return true
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
      if (!m) return false
      if (Number(m[1]) !== 127) return false
      return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
    }
    // 通过 → null；否则返回应当拒绝的状态码。
    // opts.fenceAvailable：宿主栅栏此刻可用时，**非回环 Host 交给它判** —— 它知道 dsh 自己的
    // `--trusted-host` 声明了谁；我们只在"确实没有栅栏"时才回落到 DSHW_TRUSTED_HOSTS。
    // （0.3.11 把自校验放在委托之前，导致宿主已信任的权威在插件这边被 403，见 issue #136 后续的 A/B。）
    function selfRejection(req, opts) {
      try {
        const headers = (req && req.headers) || {}
        let hostUrl = null
        try { hostUrl = new URL('http://' + String(headers.host || '')) } catch (err) { return 403 } // 缺 Host / 畸形 → 拒
        const hostname = hostUrl.hostname
        const authority = hostUrl.host
        if (!isLoopbackHostname(hostname)) {
          const listed = TRUSTED_AUTHORITIES.some((e) => (e.indexOf(':') >= 0 ? e === authority.toLowerCase() : e === hostname.toLowerCase()))
          const fenceAvailable = !!(opts && opts.fenceAvailable)
          if (!listed && !fenceAvailable) return 403
        }
        // 下面两条与"信任列表"无关，任何情况下都执行：跨站标记、Origin 与 Host 不同源。
        const site = String(headers['sec-fetch-site'] || '').toLowerCase()
        if (site === 'cross-site') return 403
        const origin = headers.origin
        if (typeof origin === 'string' && origin && origin !== 'null') {
          let originUrl = null
          try { originUrl = new URL(origin) } catch (err) { return 403 }
          if (originUrl.host.toLowerCase() !== authority.toLowerCase()) return 403
        }
        return null
      } catch (err) { return 403 } // 校验器自身出错 → 拒绝（fail-closed）
    }
    function connectionFence() {
      try {
        const conn = ctx.get('connection') || ctx.connection
        return conn && typeof conn.requestRejection === 'function' ? conn : null
      } catch (err) { return null }
    }
    if (!connectionFence()) {
      try {
        console.warn('[whale-balance] 宿主信任栅栏不可用（connection.requestRejection 缺失）：已启用插件自带的回环/同源校验，'
          + '所有路由（含写接口）仍受它保护；若本机 dsh 部署在非回环地址（反代/局域网），请用环境变量 '
          + 'DSHW_TRUSTED_HOSTS 声明允许的 Host（逗号分隔，可带端口）。')
      } catch (err) {}
    }
    function rejected(req, res) {
      const deny = (code) => {
        try { res.statusCode = code || 403; res.end() } catch (err) {}
        return true
      }
      const conn = connectionFence()
      // 先算栅栏可用性，再自校验：非回环 Host 在"栅栏可用"时交给栅栏判（它知道 --trusted-host）
      const self = selfRejection(req, { fenceAvailable: !!conn })
      if (self !== null) return deny(self)
      if (!conn) return false // 已通过自校验；此刻没有宿主栅栏可委托（加载时已 warn）
      let code
      try {
        code = conn.requestRejection(req)
      } catch (err) {
        // 旧实现这里是 `return false`：栅栏自己抛异常被当成"没被拒"而静默放行（#136 的第二条路径）
        if (!rejected.warned) {
          rejected.warned = true
          try { console.warn('[whale-balance] 信任栅栏抛异常，已按拒绝处理：' + String((err && err.message) || err)) } catch (e2) {}
        }
        return deny(403)
      }
      if (code === undefined || code === null || code === false) return false
      return deny(typeof code === 'number' ? code : 403)
    }
    // 统一注册入口：所有路由自动套上信任栅栏
    function registerRoute(route) {
      const inner = route && route.handler
      const wrapped = Object.assign({}, route, {
        handler: async (req, res) => {
          if (rejected(req, res)) return
          return inner(req, res)
        },
      })
      return ctx.webServer.register(wrapped)
    }
    let imageBytes = null
    let balanceCache = null
    let balanceInFlight = null
    let gifBytes = null
    // 每轮对话消耗统计：按 (session.id, turn) 分桶聚合，完成后写入 lastTurn。
    // 用 Map 分桶避免主会话与子代理（spawn/fork）并行时串账。
    let turnAggs = new Map() // sessionId -> { turn, cost, tokens, byModel, byModelTokens, lastTs }
    let lastTurn = null // { turn, amount, tokens, ts }
    let lastTurnSeq = 0
    const disposers = []

    // 持久化 seq：热重载/重启后 seq 继续递增，前端不会把新轮次误判为旧轮次
    function readTurnSeq() {
      for (const p of TURN_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (parsed && typeof parsed.seq === 'number' && parsed.seq >= 0) return parsed.seq
        } catch (err) {}
      }
      return 0
    }
    function writeTurnSeq(seq) {
      const body = JSON.stringify({ seq, updatedAt: new Date().toISOString() })
      for (const p of TURN_FILE_CANDIDATES) {
        try { fs.writeFileSync(p, body, 'utf8'); return } catch (err) {}
      }
    }
    lastTurnSeq = readTurnSeq()

    function finalizeTurn(sessionId) {
      const agg = turnAggs.get(sessionId)
      if (agg && agg.cost > 0) {
        lastTurn = { turn: agg.turn, amount: agg.cost, tokens: agg.tokens, ts: agg.lastTs }
        lastTurnSeq++
        writeTurnSeq(lastTurnSeq)
        // 按模型拆分写入用量事件(模型明细的唯一来源)
        const byModel = agg.byModel || {}
        const byModelTokens = agg.byModelTokens || {}
        const modelNames = Object.keys(byModel)
        if (modelNames.length) {
          for (const mname of modelNames) {
            appendUsageEvent({ ts: agg.lastTs, model: mname, cost: byModel[mname], tokens: byModelTokens[mname] || 0 })
            // 自定义模型：按 matchIds 归属到注册表里的模型（余额差不可用时作为该模型的今日已用兜底）
            apiAttributeEvent(mname, byModel[mname], byModelTokens[mname] || 0)
          }
        } else {
          appendUsageEvent({ ts: agg.lastTs, model: '未知', cost: agg.cost, tokens: agg.tokens })
        }
      }
      turnAggs.delete(sessionId)
    }
    // 监听会话事件流：assistant/message 携带每步真实 usage，按 (session,turn) 聚合；
    // turn/end 时结算该会话本轮并写入 lastTurn
    function handleSessionEvent(sessionId, event) {
      try {
        const type = event && event.type
        const d = event && event.data
        if (!d || typeof d !== 'object') return
        if (type === 'turn/end') {
          finalizeTurn(sessionId)
          return
        }
        if (type !== 'assistant/message') return
        const turn = Number(d.turn)
        const usage = d.usage
        if (!usage || typeof usage !== 'object' || !isFinite(turn)) return
        let agg = turnAggs.get(sessionId)
        if (!agg || agg.turn !== turn) {
          if (agg) finalizeTurn(sessionId)
          agg = { turn, cost: 0, tokens: 0, byModel: {}, byModelTokens: {}, lastTs: Date.now() }
          turnAggs.set(sessionId, agg)
        }
        const input = Number(usage.inputTokens) || 0
        const cache = Number(usage.cacheReadTokens) || 0
        const output = Number(usage.outputTokens) || 0
        // 口径修正（issue #89 / PR #83）：dsh 保证 reasoningTokens ⊆ outputTokens
        // （见 dsh-token-meter 的校验 reasoningTokens > outputTokens 即判非法），
        // 所以 reasoning 不能再单独累加 —— 否则输出侧按输出价被重复计费（实测偏高约一倍）。
        const outputBilled = output // DSH outputTokens already includes reasoningTokens.
        const toks = input + cache + outputBilled
        agg.tokens += toks
        // 定价换算（CNY/百万 token；缓存命中=输入价，其余按各自档位），并按模型拆分
        const model = d.message && d.message.source ? d.message.source.model : ''
        // 每轮结算前刷新一次自定义单价（10 秒节流），让自定义 API 模型用用户填的价格计费
        try { refreshCustomPrices() } catch (err) {}
        const p = priceFor(model)
        const off = isPeakTime(Math.floor(Date.now() / 1000)) ? 1 : 0
        let costMsg = (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + (outputBilled / 1e6) * p.out[off]
        // 自定义单价若按美元填写，按用户填的汇率换算成人民币（账本统一按 CNY 记账）
        try {
          const meta = customPriceMetaFor(model)
          if (meta && meta.cur === 'USD' && Number(meta.rate) > 0) costMsg = costMsg * Number(meta.rate)
        } catch (err) {}
        agg.cost = addMoney(agg.cost, costMsg)
        if (model) {
          agg.byModel[model] = addMoney(agg.byModel[model] || 0, costMsg)
          agg.byModelTokens[model] = (agg.byModelTokens[model] || 0) + toks
        }
        agg.lastTs = Date.now()
      } catch (err) {}
    }

    // 监听所有会话的追加事件；按会话 id 分桶，turn/end 时结算该会话本轮
    disposers.push(ctx.on('session/event', (session, event) => {
      const sid = session && session.id ? session.id : 'default'
      handleSessionEvent(sid, event)
    }))
    // 会话销毁时清理残留聚合，避免内存泄漏
    disposers.push(ctx.on('session/disposed', (session) => {
      if (session && session.id) turnAggs.delete(session.id)
    }))

    function loadGif() {
      if (gifBytes) return gifBytes
      for (const p of RUA_GIF_CANDIDATES) {
        try {
          const bytes = fs.readFileSync(p)
          if (bytes && bytes.length > 0) {
            gifBytes = bytes
            return bytes
          }
        } catch (err) {}
      }
      throw new Error('rua gif not found')
    }

    function loadImage() {
      if (imageBytes) return imageBytes
      for (const p of IMAGE_CANDIDATES) {
        try {
          const bytes = fs.readFileSync(p)
          if (bytes && bytes.length > 0) {
            imageBytes = bytes
            return bytes
          }
        } catch (err) {}
      }
      throw new Error('whale image not found')
    }

    function pickBalanceInfo(infos) {
      if (!Array.isArray(infos) || infos.length === 0) return null
      const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
      return (
        infos.find((x) => x && x.currency === 'CNY' && num(x) > 0) ||
        infos.find((x) => num(x) > 0) ||
        infos.find((x) => x && x.currency === 'CNY') ||
        infos[0]
      )
    }

    async function fetchBalance() {
      // v739（用户反馈「每次新实例的第一次余额请求都失败」）：
      // ① 冷启动时凭据服务可能尚未就绪（resolve 抛错），这与「确实没配置」不同 → 短延迟重试一次；
      // ② 单次超时从 20s 收到 8s，保证「2 次尝试 + 退避」明显短于前端 FETCH_TIMEOUT_MS(25s) ——
      //    否则前端先 abort，用户看到的永远是「第一次失败」，只能干等 60 秒后的下一轮。
      let cred = null
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
          break
        } catch (err) {
          if (attempt === 0) { await new Promise((r) => setTimeout(r, 700)); continue }
          return { ok: false, code: 'NO_KEY', error: '凭据读取失败: ' + String((err && err.message) || err).slice(0, 160) }
        }
      }
      if (!cred) {
        return { ok: false, code: 'NO_KEY', error: '未配置 DEEPSEEK_API_KEY' }
      }
      let lastErr = null
      for (let attempt = 0; attempt < 2; attempt++) {
        let res
        try {
          res = await fetch(BALANCE_URL, {
            headers: { Authorization: 'Bearer ' + cred.value },
            signal: AbortSignal.timeout(8000),
          })
        } catch (err) {
          lastErr = err
          if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
          continue
        }
        if (!res.ok) {
          lastErr = new Error('HTTP ' + res.status)
          if (res.status < 500) break
          if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
          continue
        }
        let data
        try {
          data = await res.json()
        } catch (err) {
          return { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' }
        }
        const info = pickBalanceInfo(data && data.balance_infos)
        if (!info || info.total_balance === undefined || !Number.isFinite(Number(info.total_balance))) {
          return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
        }
        return {
          ok: true,
          totalBalance: Number(info.total_balance),
          accountTag: createHash('sha256').update(String(cred.value)).digest('hex').slice(0, 24),
          currency: String(info.currency || 'CNY'),
          updatedAt: new Date().toISOString(),
        }
      }
      const transient = !(lastErr && /^HTTP 4\d\d/.test(lastErr.message))
      return {
        ok: false,
        code: 'HTTP',
        transient: transient,
        error: '余额接口请求失败: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 200),
      }
    }

    function todayKey() { return beijingDay() }
    // Windows indexers can briefly hold a just-written file. Retry sharing
    // conflicts; never treat an unreadable existing ledger as an empty ledger.
    function ledgerIo(operation) {
      for (let attempt = 0; ; attempt++) {
        try { return operation() } catch (err) {
          if (attempt >= 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1))
        }
      }
    }
    function readUsageLedger() {
      for (const p of USAGE_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(ledgerIo(() => fs.readFileSync(p, 'utf8')))
          if (parsed && typeof parsed === 'object' && typeof parsed.date === 'string') return parsed
          throw new Error('账本结构异常，已停止写入以保护原记录')
        } catch (err) { if (err.code !== 'ENOENT') throw err }
      }
      return { date: todayKey(), lastBalance: null, todayUsage: 0, history: {} }
    }
    function writeUsageLedger(led) {
      const body = JSON.stringify(led)
      for (const p of USAGE_FILE_CANDIDATES) {
        const temp = p + '.tmp-' + process.pid
        try {
          if (fs.existsSync(p)) {
            const existing = JSON.parse(ledgerIo(() => fs.readFileSync(p, 'utf8')))
            if (!existing.accounting || existing.accounting.version !== 1) {
              try { ledgerIo(() => fs.copyFileSync(p, p + '.before-recharge-fix.bak', fs.constants.COPYFILE_EXCL)) }
              catch (err) { if (err.code !== 'EEXIST') throw err }
            }
          }
          ledgerIo(() => fs.writeFileSync(temp, body, 'utf8'))
          ledgerIo(() => fs.renameSync(temp, p))
          return true
        } catch (err) {
          try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch (cleanupErr) {}
          if (err.code !== 'ENOENT') console.error('[whale-ledger] 账本保存失败:', err.code || err.message)
        }
      }
      return false
    }
    // —— 账本保留策略（v700）：events 保留 90 天或最多 2 万条；history 保留 365 天；
    //    超期部分归档到 .dshw-usage-archive.json（不丢历史，只是移出主账本，避免账本无限膨胀）——
    function usageArchivePath() {
      for (const p of USAGE_FILE_CANDIDATES) {
        try {
          fs.accessSync(path.dirname(p), fs.constants.W_OK)
          return path.join(path.dirname(p), '.dshw-usage-archive.json')
        } catch (err) {}
      }
      return path.join(DSH_HOME, '.dshw-usage-archive.json')
    }
    function readUsageArchive() {
      try {
        const j = JSON.parse(fs.readFileSync(usageArchivePath(), 'utf8'))
        if (j && typeof j === 'object') return j
      } catch (err) {}
      return { version: 1, events: [], history: {} }
    }
    // 返回 true 表示账本被裁剪过（调用方随后写盘即可）
    function pruneLedgerUsage(led) {
      try {
        const ev = Array.isArray(led.events) ? led.events : []
        const hist = (led.history && typeof led.history === 'object') ? led.history : {}
        const dateCut90 = dayAdd(todayKey(), -90)
        const dateCut365 = dayAdd(todayKey(), -365)
        const keepEv = []
        const dropEv = []
        for (const e of ev) {
          const day = String((e && e.day) || '')
          if (day && day < dateCut90) dropEv.push(e)
          else keepEv.push(e)
        }
        if (keepEv.length > 20000) {
          const extra = keepEv.length - 20000
          for (const e of keepEv.splice(0, extra)) dropEv.push(e)
        }
        const dropHist = {}
        let histDropped = 0
        for (const day of Object.keys(hist)) {
          if (String(day) < dateCut365) {
            dropHist[day] = hist[day]
            delete hist[day]
            histDropped++
          }
        }
        if (!dropEv.length && !histDropped) return false
        const ar = readUsageArchive()
        ar.events = Array.isArray(ar.events) ? ar.events : []
        for (const e of dropEv) ar.events.push(e)
        if (ar.events.length > 200000) ar.events.splice(0, ar.events.length - 200000)
        ar.history = Object.assign({}, ar.history || {}, dropHist)
        ar.updatedAt = new Date().toISOString()
        ar.note = '小鲸鱼记账归档：events 超 90 天或超 2 万条、history 超 365 天的部分'
        try { fs.writeFileSync(usageArchivePath(), JSON.stringify(ar), 'utf8') } catch (err) { return false }
        led.events = keepEv
        led.history = hist
        return true
      } catch (err) { return false }
    }
    function dayKeyOfDate(d) { return beijingDay(d.getTime()) }
    function dayKeyFromTs(ts) { return beijingDay(Number(ts)) }
    function dayAdd(baseDayStr, delta) { return dayOffset(baseDayStr, delta) }
    // 每轮结算后追加一条用量事件(模型明细/7天/全部记录的来源;上限 8000 条)
    function appendUsageEvent(ev) {
      const led = readUsageLedger()
      led.events = Array.isArray(led.events) ? led.events : []
      led.events.push({
        ts: Number(ev.ts) || Date.now(),
        day: dayKeyFromTs(Number(ev.ts) || Date.now()),
        model: String(ev.model || '未知'),
        cost: preciseMoney(Number(ev.cost) || 0),
        tokens: Math.round(Number(ev.tokens) || 0),
      })
      // 保留策略：events 90 天 / 最多 2 万条（超期或超量归档到 .dshw-usage-archive.json）
      pruneLedgerUsage(led)
      writeUsageLedger(led)
    }
    // 供面板/窗口使用的汇总:今日(按模型降序)、近7天、7天合计、全部记录
    function usageRecordsPayload() {
      const led = readUsageLedger()
      const events = Array.isArray(led.events) ? led.events : []
      const today = todayKey()
      function modelsFor(day) {
        const map = new Map()
        for (const e of events) {
          if (e.day !== day) continue
          const name = String(e.model || '未知')
          map.set(name, addMoney(map.get(name) || 0, Number(e.cost) || 0))
        }
        return Array.from(map, ([model, cost]) => ({ model, cost, source: 'events', currency: 'CNY' }))
          .sort((a, b) => b.cost - a.cost)
      }
      function forDay(date) {
        const summary = daySummary(led, date)
        const models = modelsFor(date)
        return {
          ...summary, date, total: summary.amount, models,
          modelTotal: sumMoney(models.map(m => m.cost)), modelCurrency: 'CNY',
        }
      }
      const todayData = forDay(today)
      const days7 = Array.from({ length: 7 }, (_, i) => forDay(dayAdd(today, -i)))
      const total7ByCurrency = {}
      for (const d of days7) total7ByCurrency[d.currency] = addMoney(total7ByCurrency[d.currency] || 0, d.total)
      const days = new Set([today, ...Object.keys(led.history || {}), ...accountingDays(led)])
      for (const e of events) if (/^\d{4}-\d{2}-\d{2}$/.test(e.day)) days.add(e.day)
      return {
        ok: true, version: '0.3.13', today: todayData, days7,
        total7: total7ByCurrency[todayData.currency] || 0, total7Currency: todayData.currency, total7ByCurrency,
        all: {
          days: Array.from(days).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().map(forDay),
          events: events.slice().sort((a, b) => b.ts - a.ts).slice(0, 500),
        },
        settings: readUsageSettings(),
      }
    }
    // 用量相关设置(任务结束音 / 余额预警 / 今日预算)存于用量账本 settings
    function usageSettingsDefaults() {
      return {
        // 任务结束音：默认关闭，但默认已选中内置的 Minecraft·经验球（exp_orb），打开即用
        taskEnd: { on: false, sel: 'frag:exp_orb' },
        // 默认固化自开发环境当前 usage.json 设置(全新安装即此体验)
        // ⚠️ 这里的 alert / budget / turnCost 内容与前端 whale-widget.js 的
        //    usageRemindDefaultLines() / usageTurnCostDefaultLines() **必须逐字段一致**
        //    (host = 新用户默认内容；前端 = 编辑器里「恢复默认」的目标内容)。改一处必须同步另一处。
        alert: {
          on: true, below: 5,
          msg: '余额预警:当前余额已低于设定值 {below}',
          lines: [
            { type: 'text', text: '老大~你的DS余额', size: 5, bold: true },
            { type: 'text', text: '已经不足', size: 5, bold: true, row: 2 },
            { type: 'text', text: '¥{below}', size: 5, bold: true, rgb: 'rouge', color: '', bgRgb: '', bg: '', row: 2 },
            { type: 'text', text: '啦~', size: 5, bold: true, row: 2 },
            { type: 'image', imgId: 'bimg_money1', size: 6, imgScale: 0.4 },
            { type: 'link', text: '>> 喂 点 米 <<', url: 'https://platform.deepseek.com/top_up', size: 1, color: '#ffffff', rgb: '', bgRgb: 'indigo', bg: '', bold: true, ul: false },
          ],
          autoClose: false, ttlSec: 6,
        },
        budget: {
          on: true, amount: 10,
          msg: '今日已用已达预算 ¥{amount}',
          lines: [
            { type: 'text', text: '老大，今天花销已经超过', size: 6, bold: true, row: 1 },
            { type: 'text', text: '¥{amount}', size: 7, bold: true, row: 1, rgb: 'rouge', color: '', italic: false, bgRgb: '', bg: '' },
            { type: 'text', text: '啦，再花要变成穷光蛋啦...', size: 6, bold: true, row: 1 },
          ],
          autoClose: false, ttlSec: 6,
        },
        // 每轮消耗提示内容(自定义提示窗口):与预警/预算同一套模块化内容,{cost} = 本轮消耗金额。
        // 内容 = 冻结的当前生效快照(与前端 usageTurnCostDefaultLines() 一致)；
        // 开关/自动关闭秒数仍存 .dshw-size.json(不迁移),这里只放内容。
        turnCost: {
          lines: [
            { type: 'text', text: '上一轮对话消耗:', size: 8, bold: true },
            { type: 'text', text: '¥ {cost}', size: 24, bold: true, color: '#e0433f' },
            { type: 'today', size: 2, tpl: '今日已用 {expense_ds}', bold: false, rgb: '', color: '#ffffff', bgRgb: 'indigo', bg: '' },
          ],
        },
      }
    }
    function readUsageSettings() {
      const led = readUsageLedger()
      const d = usageSettingsDefaults()
      const s = led && led.settings && typeof led.settings === 'object' ? led.settings : {}
      if (s.taskEnd && typeof s.taskEnd === 'object') d.taskEnd = Object.assign({}, d.taskEnd, s.taskEnd)
      if (s.alert && typeof s.alert === 'object') d.alert = Object.assign({}, d.alert, s.alert)
      if (s.budget && typeof s.budget === 'object') d.budget = Object.assign({}, d.budget, s.budget)
      if (s.turnCost && typeof s.turnCost === 'object') d.turnCost = Object.assign({}, d.turnCost, s.turnCost)
      // 每个模型各自的提醒/预算：内置 DeepSeek 沿用顶层 alert/budget（旧配置零迁移）
      const byModel = s.models && typeof s.models === 'object' ? s.models : {}
      // 手动额度默认值：资源包/订阅制厂商没有额度接口时，总量与已用由用户在面板里手填
      const qDef = () => ({ on: false, mode: 'auto', total: 0, unit: 'tokens', used: 0, reset: 'none', baseAt: 0 })
      d.models = { [API_BUILTIN_ID]: { alert: d.alert, budget: d.budget, quota: Object.assign(qDef(), (byModel[API_BUILTIN_ID] && byModel[API_BUILTIN_ID].quota) || {}) } }
      for (const m of readApiRegistry().models) {
        if (!m || !m.id || m.id === API_BUILTIN_ID) continue
        const st = byModel[m.id] && typeof byModel[m.id] === 'object' ? byModel[m.id] : {}
        d.models[m.id] = {
          alert: Object.assign({}, usageSettingsDefaults().alert, st.alert || {}),
          budget: Object.assign({}, usageSettingsDefaults().budget, st.budget || {}),
          quota: Object.assign(qDef(), st.quota || {}),
        }
      }
      return d
    }
    function writeUsageSettings(patch) {
      const led = readUsageLedger()
      led.settings = led.settings && typeof led.settings === 'object' ? led.settings : {}
      const p = patch || {}
      if (p.taskEnd && typeof p.taskEnd === 'object') led.settings.taskEnd = Object.assign({}, led.settings.taskEnd || {}, p.taskEnd)
      if (p.alert && typeof p.alert === 'object') led.settings.alert = Object.assign({}, led.settings.alert || {}, p.alert)
      if (p.budget && typeof p.budget === 'object') led.settings.budget = Object.assign({}, led.settings.budget || {}, p.budget)
      // 每轮消耗提示内容(自定义提示窗口)
      if (p.turnCost && typeof p.turnCost === 'object') led.settings.turnCost = Object.assign({}, led.settings.turnCost || {}, p.turnCost)
      // 按模型保存提醒/预算：{ modelId, alert?, budget? }
      if (p.modelSettings && p.modelSettings.id) {
        const mid = String(p.modelSettings.id)
        led.settings.models = led.settings.models && typeof led.settings.models === 'object' ? led.settings.models : {}
        const cur = led.settings.models[mid] && typeof led.settings.models[mid] === 'object' ? led.settings.models[mid] : {}
        if (p.modelSettings.alert && typeof p.modelSettings.alert === 'object') cur.alert = Object.assign({}, cur.alert || {}, p.modelSettings.alert)
        if (p.modelSettings.budget && typeof p.modelSettings.budget === 'object') cur.budget = Object.assign({}, cur.budget || {}, p.modelSettings.budget)
        // 手动额度：整体覆盖（总量/单位/已用/重置周期/统计模式/开关）
        if (p.modelSettings.quota && typeof p.modelSettings.quota === 'object') {
          const q = Object.assign({}, p.modelSettings.quota)
          const wantReset = !!q.resetBase
          delete q.resetBase
          // 「重置基准」：把累计 token 的基准点设为当前值 → 已用从 0 重新计
          if (wantReset) {
            const u = apiUsageRaw(mid)
            q.baseAt = Number(u && u.tokensTotal) || 0
          }
          cur.quota = Object.assign({}, cur.quota || {}, q)
        }
        led.settings.models[mid] = cur
        // 内置 DeepSeek：同步回写顶层字段，旧读取方（泡泡提醒）不受影响
        if (mid === API_BUILTIN_ID) {
          if (cur.alert) led.settings.alert = cur.alert
          if (cur.budget) led.settings.budget = cur.budget
        }
      }
      if (!writeUsageLedger(led)) return { ok: false, error: '保存失败' }
      return { ok: true, settings: readUsageSettings() }
    }
    // ===== Codex 本地会话统计（Codex 适配 · 第一期）=====
    // 数据源：$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl 与 archived_sessions/*.jsonl（明文 JSONL）
    //   每行：{ type, timestamp, ordinal, payload }
    //   逐轮用量：type=token_count 的 payload.info.last_token_usage / total_token_usage
    //   模型归属：type=turn_context 的 payload.model
    // 口径：优先用「累计量的差值」（total_token_usage 单调递增，天然免疫一次轮次多条 token_count 的重复），
    //       用量拆分按该事件的 last_token_usage 比例缩放；累计缺失时退回 last_token_usage。
    // 缓存：$DSH_HOME/.dshw-codex.json（只存各文件聚合与 size/mtime，不存任何凭据，也不写 ~/.codex）
    function codexHome() {
      const env = String(process.env.CODEX_HOME || '').trim()
      for (const c of [env, path.join(os.homedir(), '.codex')]) {
        try { if (c && fs.existsSync(c)) return c } catch (err) {}
      }
      return ''
    }
    function readCodexCache() {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DSH_HOME, '.dshw-codex.json'), 'utf8'))
        if (j && j.files && typeof j.files === 'object') return j
      } catch (err) {}
      return { version: 1, files: {} }
    }
    function writeCodexCache(c) {
      try { fs.writeFileSync(path.join(DSH_HOME, '.dshw-codex.json'), JSON.stringify(c), 'utf8'); return true } catch (err) { return false }
    }
    function listCodexSessionFiles(root) {
      const out = []
      const walk = (dir, depth) => {
        if (depth > 6) return
        let ents = []
        try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (err) { return }
        for (const e of ents) {
          const p = path.join(dir, e.name)
          if (e.isDirectory()) walk(p, depth + 1)
          else if (/^rollout-.*\.jsonl$/i.test(e.name)) out.push(p)
        }
      }
      walk(path.join(root, 'sessions'), 0)
      walk(path.join(root, 'archived_sessions'), 0)
      return out
    }
    // 解析单个会话文件的**文本** → { days, rl, rlTs }
    // issue #116：读取改由调用方异步完成（先判大小、读完让出事件循环），这里只做纯解析。
    function parseCodexFileText(text) {
      const days = {}
      let model = 'codex'
      let prevTotal = null
      let lastRl = null, rlTs = 0
      if (typeof text !== 'string' || !text) return { days, rl: null, rlTs: 0 }
      const bump = (day, mk, v) => {
        days[day] = days[day] || {}
        const cur = days[day][mk] || { in: 0, cached: 0, cwrite: 0, out: 0, reason: 0, total: 0, turns: 0 }
        cur.in += v.in; cur.cached += v.cached; cur.cwrite += v.cwrite
        cur.out += v.out; cur.reason += v.reason; cur.total += v.total; cur.turns += v.turns
        days[day][mk] = cur
      }
      for (const line of text.split('\n')) {
        if (!line || line.charCodeAt(0) !== 123) continue // 只处理 '{' 开头的行
        let o = null
        try { o = JSON.parse(line) } catch (err) { continue }
        const p = o && o.payload
        if (!p) continue
        if (o.type === 'turn_context') {
          if (p.model) model = String(p.model)
          continue
        }
        if (o.type !== 'event_msg' || p.type !== 'token_count') continue
        const info = p.info
        if (!info || typeof info !== 'object') continue
        const last = info.last_token_usage || null
        const tot = info.total_token_usage || null
        const ts = Date.parse(String(o.timestamp || '')) || 0
        if (!ts) continue
        const day = dayKeyFromTs(ts)
        // 该次增量
        let delta = null
        const totAll = tot ? Number(tot.total_tokens) || 0 : 0
        if (totAll > 0) {
          if (prevTotal === null || totAll < prevTotal) delta = totAll
          else delta = totAll - prevTotal
          prevTotal = totAll
        }
        if (delta === null || delta <= 0) {
          if (!last) continue
          delta = Number(last.total_tokens) || 0
        }
        if (delta <= 0) continue
        // 拆分：按 last_token_usage 的比例缩放到 delta
        const lTotal = last ? Number(last.total_tokens) || 0 : 0
        const k = (lTotal > 0 && last) ? delta / lTotal : 0
        const v = last && k > 0
          ? {
            in: Math.round((Number(last.input_tokens) || 0) * k),
            cached: Math.round((Number(last.cached_input_tokens) || 0) * k),
            cwrite: Math.round((Number(last.cache_write_input_tokens) || 0) * k),
            out: Math.round((Number(last.output_tokens) || 0) * k),
            reason: Math.round((Number(last.reasoning_output_tokens) || 0) * k),
          }
          : { in: 0, cached: 0, cwrite: 0, out: 0, reason: 0 }
        bump(day, model, { in: v.in, cached: v.cached, cwrite: v.cwrite, out: v.out, reason: v.reason, total: delta, turns: 1 })
        // 订阅窗口快照：Codex 在 token_count 事件里带 rate_limits（ChatGPT 订阅 provider 才有值，
        // DeepSeek 这类 API-key provider 是 null）。保留最新的非空快照，供第二期展示。
        const rl = p.rate_limits
        if (rl && typeof rl === 'object' && (rl.primary || rl.secondary || rl.plan_type || rl.credits)) {
          if (ts >= rlTs) { lastRl = rl; rlTs = ts }
        }
      }
      return { days, rl: lastRl, rlTs }
    }
    // rate_limits 字段名在不同 Codex 版本里不一致 → 多候选键容错，换算成「已用% + 重置时间戳」
    function normalizeCodexWindow(w) {
      if (!w || typeof w !== 'object') return null
      const pick = (keys) => {
        for (const k of keys) {
          const raw = w[k]
          if (raw === null || raw === undefined || raw === '') continue
          const n = Number(raw)
          if (isFinite(n)) return n
        }
        return null
      }
      let usedPct = pick(['used_percent', 'usedPercent', 'percent', 'used_pct', 'usage_percent', 'usagePercent'])
      const remainPct = pick(['remaining_percent', 'remainingPercent', 'left_percent', 'remaining_pct'])
      if (usedPct === null && remainPct !== null) usedPct = Math.max(0, 100 - remainPct)
      let resetAt = null
      const secs = pick(['resets_in_seconds', 'resetsInSeconds', 'reset_after_seconds', 'reset_in_seconds', 'seconds_until_reset'])
      if (secs !== null && secs >= 0) resetAt = Date.now() + secs * 1000
      else {
        const abs = w.resets_at || w.reset_at || w.reset_time || w.next_reset || w.resetAt || w.nextResetTime
        if (typeof abs === 'number' && isFinite(abs)) resetAt = abs < 1e12 ? abs * 1000 : abs
        else if (typeof abs === 'string' && abs) { const t = Date.parse(abs); if (isFinite(t)) resetAt = t }
      }
      const windowMinutes = pick(['window_minutes', 'windowMinutes', 'window', 'period_minutes'])
      const label = String(w.limit_name || w.name || w.label || w.window_name || '')
      if (usedPct === null && resetAt === null) return null
      return { usedPct, resetAt, windowMinutes, label }
    }
    function normalizeCodexRateLimits(rl) {
      if (!rl || typeof rl !== 'object') return null
      const primary = normalizeCodexWindow(rl.primary)
      const secondary = normalizeCodexWindow(rl.secondary)
      if (!primary && !secondary) return null
      return {
        primary, secondary,
        planType: rl.plan_type ? String(rl.plan_type) : '',
        limitName: rl.limit_name ? String(rl.limit_name) : (rl.limit_id ? String(rl.limit_id) : ''),
        reached: rl.rate_limit_reached_type ? String(rl.rate_limit_reached_type) : '',
      }
    }
    // 汇总（带增量缓存：只有变化的文件才重新解析）
    // ===== issue #116：Codex 本地统计的护栏 =====
    // 旧实现是「启动 1.5s + 每 5 分钟」在事件循环上做**同步**全量扫描：递归遍历
    // ~/.codex/sessions，对每个过期文件 readFileSync + split('\n') + 逐行 JSON.parse。
    // 会话攒多之后，一轮扫描能冻结事件循环数分钟（整个 dsh web 不响应、满核 CPU），
    // 而且单个超过 V8 字符串上限（约 512MB）的 rollout 会抛 ERR_STRING_TOO_LONG ——
    // 由于是在写缓存之前就抛出，那个文件每轮都会被重读，size/mtime 又一直在变，永久复发。
    // 现在三条护栏：
    //   ① 单文件上限：超过 CODEX_MAX_FILE_BYTES 直接跳过（结果记进缓存，不再重读），
    //      并在汇总里报 skipped / skippedBytes，界面上能看出"有文件被跳过"；
    //   ② 单轮预算：一轮最多读 CODEX_BUDGET_FILES 个 / CODEX_BUDGET_BYTES 字节，超了就
    //      带 deferred 出结果，本轮立刻返回、稍后再刷新 —— 绝不长时间占住事件循环；
    //   ③ 全程异步（fs.promises）＋ 每个文件处理后让出一次事件循环（await setImmediate）。
    const CODEX_MAX_FILE_BYTES = 32 * 1024 * 1024
    const CODEX_BUDGET_FILES = 400
    const CODEX_BUDGET_BYTES = 96 * 1024 * 1024
    const CODEX_SNAP_TTL = 60 * 1000
    const yieldLoop = () => new Promise((r) => setImmediate(r))

    // 汇总（带增量缓存：只有变化的文件才重新解析）。异步、受预算约束。
    async function codexScan() {
      const home = codexHome()
      if (!home) return { ok: false, error: '未找到 Codex 目录（$CODEX_HOME 或 ~/.codex）' }
      const cache = readCodexCache()
      const files = listCodexSessionFiles(home)
      const keep = {}
      let changed = 0, skipped = 0, skippedBytes = 0, deferred = 0, readBytes = 0, parsedCount = 0
      for (const f of files) {
        let st = null
        try { st = await fs.promises.stat(f) } catch (err) { continue }
        const prev = cache.files[f]
        if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.days) {
          keep[f] = prev
          if (prev.skip === 'too-big') { skipped++; skippedBytes += Number(st.size) || 0 }
          continue
        }
        // ① 单文件上限：跳过超大文件（errno 不再产生，也不再每轮重读）
        if (st.size > CODEX_MAX_FILE_BYTES) {
          keep[f] = { size: st.size, mtimeMs: st.mtimeMs, days: {}, rl: null, rlTs: 0, skip: 'too-big' }
          skipped++; skippedBytes += st.size; changed++
          continue
        }
        // ② 单轮预算：本轮读够了就停，剩下的留到下一次刷新
        if (readBytes + st.size > CODEX_BUDGET_BYTES || parsedCount >= CODEX_BUDGET_FILES) { deferred++; continue }
        let text = ''
        try { text = await fs.promises.readFile(f, 'utf8') } catch (err) { text = '' }
        readBytes += st.size
        const parsed = parseCodexFileText(text)
        keep[f] = { size: st.size, mtimeMs: st.mtimeMs, days: parsed.days, rl: parsed.rl || null, rlTs: parsed.rlTs || 0 }
        changed++
        parsedCount++
        await yieldLoop() // ③ 每个文件让出一次，HTTP 请求不会被整轮扫描堵住
      }
      if (changed > 0 || Object.keys(cache.files).length !== Object.keys(keep).length) {
        writeCodexCache({ version: 1, files: keep, builtAt: Date.now() })
      }
      const today = dayKeyFromTs(Date.now())
      const month = today.slice(0, 7)
      const byDay = {}
      const byModel = {}
      let totalTokens = 0, todayTokens = 0, monthTokens = 0, outTokens = 0, reasonTokens = 0, cachedTokens = 0
      let bestRl = null, bestRlTs = -1
      for (const f of Object.keys(keep)) {
        if (keep[f].rl && (keep[f].rlTs || 0) >= bestRlTs) { bestRl = keep[f].rl; bestRlTs = keep[f].rlTs || 0 }
        const days = keep[f].days || {}
        for (const d of Object.keys(days)) {
          const day0 = byDay[d] || (byDay[d] = { tokens: 0, turns: 0, models: {} })
          for (const m of Object.keys(days[d])) {
            const v = days[d][m] || {}
            day0.tokens += Number(v.total) || 0
            day0.turns += Number(v.turns) || 0
            day0.models[m] = (day0.models[m] || 0) + (Number(v.total) || 0)
            const bm = byModel[m] || (byModel[m] = { tokens: 0, out: 0, reason: 0, cached: 0, turns: 0 })
            bm.tokens += Number(v.total) || 0
            bm.out += Number(v.out) || 0
            bm.reason += Number(v.reason) || 0
            bm.cached += Number(v.cached) || 0
            bm.turns += Number(v.turns) || 0
            totalTokens += Number(v.total) || 0
            outTokens += Number(v.out) || 0
            reasonTokens += Number(v.reason) || 0
            cachedTokens += Number(v.cached) || 0
            if (d === today) todayTokens += Number(v.total) || 0
            if (d.slice(0, 7) === month) monthTokens += Number(v.total) || 0
          }
        }
      }
      const days7 = []
      for (let i = 0; i < 7; i++) {
        const d = dayAdd(today, -i)
        days7.push({ date: d, tokens: (byDay[d] && byDay[d].tokens) || 0, turns: (byDay[d] && byDay[d].turns) || 0 })
      }
      return {
        ok: true, home, sessions: files.length, changed,
        // issue #116：把护栏的实际情况报出来，界面/日志能看出"有文件被跳过或本轮没扫完"
        skipped, skippedBytes, deferred, readBytes,
        maxFileBytes: CODEX_MAX_FILE_BYTES,
        todayTokens, monthTokens, totalTokens,
        outTokens, reasonTokens, cachedTokens,
        days7, byModel,
        // 第二期：订阅窗口（5h / 周）。仅当日志里带着带值的 rate_limits（ChatGPT 订阅 provider）时才有内容
        rateLimits: bestRl,
        windows: normalizeCodexRateLimits(bestRl),
        rateLimitsTs: bestRlTs > 0 ? bestRlTs : 0,
      }
    }
    // ===== 汇总快照（issue #116）=====
    // 关键变化：**任何调用方都不会再触发同步扫描**。
    //   · codexSummaryCached()：同步、永不阻塞 —— 直接返回上一次快照；快照过期时
    //     「顺手发起」一次后台刷新（不等待），所以同步调用点（额度计算）也一样安全；
    //   · codexSummaryEnsured(ms)：需要尽量新的地方（探活 / 模型列表）用，等在途扫描，
    //     最多等 ms 毫秒，超时就用当前快照，绝不无限等；
    //   · 同一时刻只允许一次扫描在跑（去重），预算用完时安排一次稍后的补扫。
    let codexSnap = null
    let codexSnapAt = 0
    let codexScanP = null
    let codexCatchupT = null
    // 配置变更（例如用户在设置里关掉 Codex 统计）后必须让快照失效，
    // 否则下一次请求还会命中关闭前的旧快照、开关看起来"没生效"。
    function codexInvalidate() { codexSnap = null; codexSnapAt = 0; codexStatsOnV = null; codexStatsOnAt = 0 }
    // 开关读取加 2 秒缓存：codexBackgroundRefresh 可能被高频调用（快照过期时每次 payload
    // 构建都会试一次），而 readSizeConfig() 是同步文件读 —— 不能放在热路径上。
    // 用户改设置时 codexInvalidate() 会清掉缓存，所以开关仍然是"立刻生效"。
    let codexStatsOnV = null, codexStatsOnAt = 0
    // v748：**没配置 Codex 模型时「本机统计」默认不启用** —— 完全不去读 ~/.codex/sessions
    // （用户没加 Codex 模型时那些日志与他无关，白扫一遍既费磁盘又占事件循环）。
    // 判定按模板 kind === 'codex'（与模型列表里"Codex 用量"那一行的判定同源）。
    function hasCodexModel() {
      try {
        for (const m of readApiRegistry().models) {
          const tpl = apiTemplateOf(m && m.provider)
          if (tpl && tpl.kind === 'codex') return true
        }
      } catch (err) {}
      return false
    }
    function codexStatsOn() {
      const now = Date.now()
      if (codexStatsOnV !== null && now - codexStatsOnAt < 2000) return codexStatsOnV
      let v = true
      try {
        if (!hasCodexModel()) {
          v = false // 没有 Codex 模型 → 默认关闭（不是"用户关掉的"，见下面的提示文案）
        } else {
          const cfg = readSizeConfig()
          v = !cfg || cfg.codexStatsOn !== false
        }
      } catch (err) { v = true }
      codexStatsOnV = v
      codexStatsOnAt = now
      return v
    }
    // 关闭原因的文案：区分「用户自己关的」与「压根没配 Codex 模型（默认关）」
    function codexDisabledReason() {
      try { return hasCodexModel() ? 'Codex 统计已在设置里关闭' : '未添加 Codex 模型，本机统计默认关闭' } catch (err) { return 'Codex 统计已关闭' }
    }
    function codexBackgroundRefresh(delayMs) {
      if (codexScanP) return codexScanP // 已在扫：先返回，避免重复读配置/重复排队
      if (!codexStatsOn()) {
        codexSnap = { ok: false, disabled: true, error: codexDisabledReason() }
        codexSnapAt = Date.now()
        return null
      }
      if (delayMs > 0) {
        if (codexCatchupT) return null
        codexCatchupT = setTimeout(() => { codexCatchupT = null; codexBackgroundRefresh(0) }, delayMs)
        try { if (codexCatchupT.unref) codexCatchupT.unref() } catch (err) {}
        return null
      }
      codexScanP = codexScan()
        .then((s) => {
          codexSnap = s
          codexSnapAt = Date.now()
          // 本轮没扫完（预算用尽）→ 稍后补扫，逐步把统计补齐，而不是一次占满事件循环
          if (s && s.ok && s.deferred > 0) codexBackgroundRefresh(5000)
        })
        .catch((err) => {
          codexSnap = { ok: false, error: String((err && err.message) || err) }
          codexSnapAt = Date.now()
        })
        .finally(() => { codexScanP = null })
      return codexScanP
    }
    function codexSummaryCached() {
      const now = Date.now()
      if (!codexSnap || now - codexSnapAt > CODEX_SNAP_TTL) codexBackgroundRefresh(0)
      return codexSnap
    }
    async function codexSummaryEnsured(maxWaitMs) {
      const stale = !codexSnap || Date.now() - codexSnapAt > CODEX_SNAP_TTL
      const p = codexScanP || (stale ? codexBackgroundRefresh(0) : null)
      if (!p) return codexSnap
      try { await Promise.race([p, new Promise((r) => setTimeout(r, Math.max(200, maxWaitMs || 2500)))]) } catch (err) {}
      return codexSnap
    }
    // 后台预热：启动后预热一次，并每 5 分钟刷新一次缓存（现在都是异步 + 有预算的，不再阻塞）。
    let codexPrewarmT = null, codexPrewarmI = null
    try {
      codexPrewarmT = setTimeout(function () { try { codexBackgroundRefresh(0) } catch (err) {} }, 1500)
      codexPrewarmI = setInterval(function () { try { codexBackgroundRefresh(0) } catch (err) {} }, 5 * 60 * 1000)
      // issue #109：这两个定时器原先不存句柄、也不进 disposers，插件树 dispose 之后
      // 事件循环里仍有一个被引用的 interval → 用户退出 dsh 时进程不结束（只能 Ctrl+C）。
      // 存句柄并纳入 disposers，卸载时一并清掉；unref 作为兜底（正常运行时由 HTTP 服务维持事件循环）。
      try { if (codexPrewarmT && codexPrewarmT.unref) codexPrewarmT.unref() } catch (err) {}
      try { if (codexPrewarmI && codexPrewarmI.unref) codexPrewarmI.unref() } catch (err) {}
      disposers.push(function () {
        if (codexPrewarmT !== null) { clearTimeout(codexPrewarmT); codexPrewarmT = null }
        if (codexPrewarmI !== null) { clearInterval(codexPrewarmI); codexPrewarmI = null }
        if (codexCatchupT !== null) { clearTimeout(codexCatchupT); codexCatchupT = null }
      })
    } catch (err) {}
    // ===== 自定义 API 模型注册表（v655）=====
    // 文件：$DSH_HOME/.dshw-api.json → { version, models:[…], usage:{ [id]:{day,dayStart,lastBalance,delta,eventCost} } }
    // 密钥不落此文件：写入 DSH 官方凭据（ctx.credentials.set），读取走 credentials.resolve(keyRef)。
    function defaultApiRegistry() { return { version: 1, models: [], usage: {} } }
    function readApiRegistry() {
      for (const p of API_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (parsed && Array.isArray(parsed.models)) {
            if (!parsed.usage || typeof parsed.usage !== 'object') parsed.usage = {}
            return parsed
          }
        } catch (err) {}
      }
      return defaultApiRegistry()
    }
    function writeApiRegistry(reg) {
      const body = JSON.stringify(reg, null, 2)
      for (const p of API_FILE_CANDIDATES) {
        try { fs.writeFileSync(p, body, 'utf8'); return true } catch (err) {}
      }
      return false
    }
    function apiTemplateOf(provider) {
      return API_TEMPLATES[String(provider || '')] || null
    }
    // 内置 DeepSeek 永远存在（不进注册表文件），其余来自注册表
    function apiBuiltinModel() {
      const t = API_TEMPLATES.deepseek
      return { id: API_BUILTIN_ID, name: t.name, provider: 'deepseek', currency: t.currency, keyRef: t.keyRef, builtin: true, matchIds: ['deepseek'] }
    }
    function apiAllModels() {
      const custom = readApiRegistry().models.filter((m) => m && m.id && m.id !== API_BUILTIN_ID)
      return [apiBuiltinModel()].concat(custom)
    }
    function apiModelById(id) {
      if (String(id || '') === API_BUILTIN_ID) return apiBuiltinModel()
      return readApiRegistry().models.find((m) => m && m.id === id) || null
    }
    // JSON 取值：支持 a.b[0].c
    function pickJsonPath(obj, pathStr) {
      try {
        const parts = String(pathStr || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter((x) => x.length > 0)
        let cur = obj
        for (const p of parts) {
          if (cur === null || cur === undefined) return undefined
          cur = cur[p]
        }
        return cur
      } catch (err) { return undefined }
    }
    function apiNum(v, scale) {
      const n = Number(v)
      if (!isFinite(n)) return null
      const s = isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1
      return n * s
    }
    // v724 非空合并：over 里的空串 / undefined / null **不覆盖** base。
    // 为什么需要：新建模型时表单里没填的字段会存成空串，若直接 Object.assign，
    // 空串会把模板自带的接口地址 / 字段路径"盖掉"，余额就永远查不到（会报「未配置余额接口地址」）。
    function mergeNonEmpty(base, over) {
      const out = Object.assign({}, base || {})
      const o = over && typeof over === 'object' ? over : {}
      for (const k of Object.keys(o)) {
        const v = o[k]
        if (v === undefined || v === null || v === '') continue
        if (v && typeof v === 'object' && !Array.isArray(v)) { out[k] = mergeNonEmpty(out[k], v); continue }
        out[k] = v
      }
      return out
    }
    // v724 递归去空：写注册表时用。让"没填的字段"根本不存在 → 模板默认值继续生效（配合 mergeNonEmpty）
    function stripEmptyDeep(o) {
      if (Array.isArray(o)) return o
      if (!o || typeof o !== 'object') return o
      const out = {}
      for (const k of Object.keys(o)) {
        const v = stripEmptyDeep(o[k])
        if (v === undefined || v === null || v === '') continue
        if (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue
        out[k] = v
      }
      return out
    }
    // PR #104（收窄版）：只放行 http/https，并挡掉云厂商元数据与 link-local 地址。
    // 关键取舍：**不拦回环与内网** —— 我们内置的 ollama 模板就推荐用户填
    // http://127.0.0.1:11434/v1（本地 Ollama / LM Studio），自建网关（New API 之类，
    // 见 issue #53）也跑在本机；拦掉它们会把正当用法一起打死。接口地址由用户自己在面板/
    // 注册表里填写，且所有 /dsh-whale/* 路由都在受信任栅栏之后 —— 真正要挡的是
    // 「被诱导去读云元数据把凭据带出来」，而不是「访问本机服务」。
    // decimal / octal / hex 形式的 IPv4 已由 WHATWG URL 规范化成点分十进制，这里只按规范化结果判定。
    function assertSafeApiUrl(u) {
      let parsed
      try { parsed = new URL(u) } catch { throw new Error('无效的接口地址') }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('不支持的协议: ' + parsed.protocol)
      const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
      if (host === 'metadata.google.internal' || host === 'metadata.goog' || host === '100.100.100.200') throw new Error('禁止访问云元数据地址')
      const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
      if (m) {
        const [a, b] = [Number(m[1]), Number(m[2])]
        if (a === 169 && b === 254) throw new Error('禁止访问 link-local 地址')
        if (a === 0) throw new Error('禁止访问该地址')
      }
      if (/^fe[89ab][0-9a-f]:/i.test(host)) throw new Error('禁止访问 link-local 地址')
    }
    async function apiFetchJson(url, auth, key) {
      const headers = {}
      const a = String(auth == null ? 'Bearer {key}' : auth)
      if (a) headers.Authorization = a.replace('{key}', key)
      // v724：URL 里也支持 {key}（如 Gemini 的 ?key=… 形式；auth 传空串时不带 Authorization 头）
      const u = String(url).replace('{key}', key)
      assertSafeApiUrl(u)
      const res = await fetch(u, { headers, signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.json()
    }
    // 测试连通性：优先模板的 probeUrl（如方舟 /api/v3/models），否则用余额接口/Base URL
    // 从响应体里提炼「业务层错误」：有些接口（如智谱额度）key 不对也返回 HTTP 200，
    // 真正的问题在 body 的 code/msg（例如「当前用户不存在coding plan」），必须报出来
    function apiBusinessError(data) {
      if (!data || typeof data !== 'object') return ''
      if (data.success === false || data.ok === false) {
        return String(data.msg || data.message || data.error || 'success=false').slice(0, 120)
      }
      const code = Number(data.code)
      if (isFinite(code) && code !== 0 && code !== 200 && data.msg) return String(data.msg).slice(0, 120)
      if (typeof data.error === 'string' && data.error) return data.error.slice(0, 120)
      if (data.error && typeof data.error === 'object' && data.error.message) return String(data.error.message).slice(0, 120)
      return ''
    }
    async function apiProbeModel(model) {
      if (!model) return { ok: false, error: '模型不存在' }
      const tpl = apiTemplateOf(model.provider) || {}
      if (model.id === API_BUILTIN_ID) {
        const r = await fetchBalance()
        return r.ok ? { ok: true, detail: '余额 ' + r.totalBalance + ' ' + (r.currency || 'CNY') } : { ok: false, error: r.error || r.code }
      }
      // Codex 模式：本地会话统计即「探活结果」，不需要网络与密钥
      if (tpl.kind === 'codex') {
        const cs = await codexSummaryEnsured(2500)
        const f = (n) => (n >= 100000000 ? (n / 100000000).toFixed(2) + '亿' : (n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(Math.round(Number(n) || 0))))
        if (cs && cs.ok) {
          return { ok: true, detail: 'Codex 本地会话：今日 ' + f(cs.todayTokens) + ' · 本月 ' + f(cs.monthTokens) + ' · 累计 ' + f(cs.totalTokens) + ' tokens（' + cs.sessions + ' 个会话文件）' }
        }
        return { ok: false, error: (cs && cs.error) || '未找到 Codex 会话目录' }
      }
      let key = ''
      try {
        const cred = await ctx.credentials.resolve(model.keyRef || tpl.keyRef || '')
        key = cred && cred.value ? String(cred.value) : ''
      } catch (err) { key = '' }
      if (!key) return { ok: false, error: '未配置 ' + (model.keyRef || tpl.keyRef || 'API key') }
      const b = mergeNonEmpty(tpl.balance, model.balance) // v724：模型侧空串不再覆盖模板
      const base = String(model.baseUrl || '').replace(/\/+$/, '')
      const url = String(tpl.probeUrl || b.url || (base ? base + '/v1/models' : '')).replace('{base}', base)
      if (!url) return { ok: false, error: '没有可测试的接口（请填余额接口或 Base URL）' }
      try {
        const data = await apiFetchJson(url, b.auth, key)
        const bizErr = apiBusinessError(data)
        if (bizErr) return { ok: false, error: '测试失败: ' + bizErr }
        let detail = 'HTTP 200'
        if (data && Array.isArray(data.data)) detail = '可用模型 ' + data.data.length + ' 个'
        else if (data && data.data && Array.isArray(data.data.models)) detail = '可用模型 ' + data.data.models.length + ' 个'
        return { ok: true, detail: detail }
      } catch (err) {
        return { ok: false, error: '测试失败: ' + String((err && err.message) || err).slice(0, 140) }
      }
    }
    // 订阅额度（Coding Plan）解析：各厂商字段不同，统一归一成「已用% + 重置时间 + 档位」
    //   zhipu:    data.limits[0].TOKENS_LIMIT.percentage（已用%）+ nextResetTime
    //   kimi:     usage.remaining / usage.limit（剩余/总量）
    //   minimax:  model_remains[0].current_interval_remaining_percent（剩余%）+ end_time(ms)
    async function fetchModelQuota(model) {
      if (!model) return { ok: false, error: '模型不存在' }
      const tpl = apiTemplateOf(model.provider) || {}
      const q = tpl.quota
      if (!q || !q.url) return { ok: false, code: 'NO_QUOTA', error: '该厂商没有订阅额度接口' }
      let key = ''
      try {
        const cred = await ctx.credentials.resolve(model.keyRef || tpl.keyRef || '')
        key = cred && cred.value ? String(cred.value) : ''
      } catch (err) { key = '' }
      if (!key) return { ok: false, code: 'NO_KEY', error: '未配置 ' + (model.keyRef || tpl.keyRef || 'API key') }
      const base = String(model.baseUrl || '').replace(/\/+$/, '')
      const url = String(q.url).replace('{base}', base)
      try {
        const data = await apiFetchJson(url, q.auth, key)
        const bizErr = apiBusinessError(data)
        if (bizErr) return { ok: false, code: 'BIZ', error: bizErr }
        const j = q.json || {}
        const num = (v) => { const n = Number(v); return isFinite(n) ? n : null }
        let usedPct = null, remainPct = null, resetAt = null, level = '', weeklyUsedPct = null
        if (j.percent) { const p = num(pickJsonPath(data, j.percent)); if (p !== null) usedPct = p }
        if (j.remainPct) {
          const p = num(pickJsonPath(data, j.remainPct))
          if (p !== null) { remainPct = p; if (usedPct === null) usedPct = Math.max(0, 100 - p) }
        }
        if (j.weeklyRemainPct) {
          const p = num(pickJsonPath(data, j.weeklyRemainPct))
          if (p !== null) weeklyUsedPct = Math.max(0, 100 - p)
        }
        if (j.remain && j.total) {
          const r0 = num(pickJsonPath(data, j.remain))
          const t0 = num(pickJsonPath(data, j.total))
          if (r0 !== null && t0) {
            remainPct = Math.max(0, Math.min(100, r0 / t0 * 100))
            usedPct = Math.max(0, 100 - remainPct)
          }
        }
        if (j.resetAt) resetAt = pickJsonPath(data, j.resetAt)
        if (j.resetAtMs) { const ms = num(pickJsonPath(data, j.resetAtMs)); if (ms !== null) resetAt = ms }
        if (j.level) level = String(pickJsonPath(data, j.level) || '')
        // v0.3.1：多窗口额度 —— 有些订阅额度接口一次返回多个窗口（如 OpenCode Go 的
        // rolling / weekly / monthly），每个窗口各有「已用% + 重置时间」。模板用
        // json.windows: [{ key, label, percent, resetAt }] 描述；这里归一成 windows 数组，
        // 并把第一个窗口回填成主窗口 usedPct / resetAt，保持原有单窗口链路的兼容。
        let windows = null
        if (Array.isArray(j.windows)) {
          const list = []
          for (const w of j.windows) {
            if (!w) continue
            let wp = w.percent ? num(pickJsonPath(data, w.percent)) : null
            if (wp !== null) wp = Math.max(0, Math.min(100, wp))
            let wr = null
            if (w.resetAt) {
              const rv = pickJsonPath(data, w.resetAt)
              if (rv !== undefined && rv !== null && rv !== '') wr = rv
            }
            if (wp === null && wr === null) continue
            list.push({ key: String(w.key || ''), label: String(w.label || ''), usedPct: wp, resetAt: wr })
          }
          if (list.length) windows = list
        }
        if (windows) {
          const w0 = windows[0]
          if (usedPct === null && w0.usedPct !== null) usedPct = w0.usedPct
          if (!resetAt && w0.resetAt !== null) resetAt = w0.resetAt
          if (weeklyUsedPct === null) {
            for (const w of windows) {
              if ((w.key === 'weekly' || w.label === '周') && w.usedPct !== null) { weeklyUsedPct = w.usedPct; break }
            }
          }
        }
        if (usedPct === null && remainPct === null && !resetAt && !windows) {
          return { ok: false, code: 'PARSE', error: '额度接口返回无法解析（字段路径不匹配）' }
        }
        return { ok: true, usedPct, remainPct, resetAt, level, weeklyUsedPct, windows }
      } catch (err) {
        return { ok: false, code: 'HTTP', error: '额度接口请求失败: ' + String((err && err.message) || err).slice(0, 140) }
      }
    }
    // 厂商回报「账号没有该订阅套餐」（如智谱的「当前用户不存在coding plan」）：
    // 对没订阅的用户这行没意义，标记 hide 让前端不显示（真正的网络/密钥错误不隐藏）
    function apiPlanNoPlan(msg) {
      const s = String(msg || '').toLowerCase()
      if (!s) return false
      return s.indexOf('coding plan') >= 0 || s.indexOf('不存在') >= 0 || s.indexOf('未订阅') >= 0 ||
        s.indexOf('not subscribed') >= 0 || s.indexOf('no plan') >= 0 || s.indexOf('no active') >= 0 ||
        s.indexOf('subscription') >= 0
    }
    // 取某模型余额：DeepSeek 复用既有官方链路；其余按模板/自定义描述请求并解析
    async function fetchModelBalance(model) {
      if (!model) return { ok: false, code: 'NO_MODEL', error: '模型不存在' }
      if (model.id === API_BUILTIN_ID) {
        const r = await fetchBalance()
        if (!r.ok) return r
        return { ok: true, remaining: Number(r.totalBalance), currency: r.currency || 'CNY' }
      }
      const tpl = apiTemplateOf(model.provider) || {}
      const b = mergeNonEmpty(tpl.balance, model.balance) // v724：模型侧空串不再覆盖模板
      if (!b.url) return { ok: false, code: 'NO_URL', error: '未配置余额接口地址' }
      let key = ''
      try {
        const cred = await ctx.credentials.resolve(model.keyRef || tpl.keyRef || '')
        key = cred && cred.value ? String(cred.value) : ''
      } catch (err) { key = '' }
      if (!key) return { ok: false, code: 'NO_KEY', error: '未配置 ' + (model.keyRef || tpl.keyRef || 'API key') }
      const base = String(model.baseUrl || '').replace(/\/+$/, '')
      const url = String(b.url).replace('{base}', base)
      try {
        const data = await apiFetchJson(url, b.auth, key)
        const j = b.json || {}
        let remaining = null
        let total = null
        let used = 0
        if (j.remaining) { const v = apiNum(pickJsonPath(data, j.remaining), j.scale); if (v !== null) remaining = v }
        if (j.total) { const v = apiNum(pickJsonPath(data, j.total), j.scale); if (v !== null) total = v }
        if (j.used) { const v = apiNum(pickJsonPath(data, j.used), j.scale); if (v !== null) used += v }
        if (b.usage && b.usage.url) {
          const u = b.usage
          const d2 = await apiFetchJson(String(u.url).replace('{base}', base), u.auth || b.auth, key)
          const j2 = u.json || {}
          if (j2.used) { const v = apiNum(pickJsonPath(d2, j2.used), j2.scale); if (v !== null) used += v }
        }
        if (remaining === null && total !== null) remaining = total - used
        if (remaining === null) return { ok: false, code: 'SHAPE', error: '接口返回里没找到配置的字段（检查 JSON 路径）' }
        return { ok: true, remaining, total, used, currency: model.currency || tpl.currency || 'CNY' }
      } catch (err) {
        return { ok: false, code: 'HTTP', error: '余额接口请求失败: ' + String((err && err.message) || err).slice(0, 160) }
      }
    }
    // 逐模型记录的骨架：跨天只重置「当日」字段，累计量（tokensTotal/tokensMonth）保留
    function apiUsageNewDay(cur, day, dayKey) {
      const prev = cur && typeof cur === 'object' ? cur : {}
      const mk = String(dayKey || '').slice(0, 7)
      return {
        day: day, dayStart: null, lastBalance: null, delta: 0, eventCost: 0, eventTokens: 0, currency: '',
        tokensTotal: Number(prev.tokensTotal) || 0,
        month: mk,
        tokensMonth: prev.month === mk ? (Number(prev.tokensMonth) || 0) : 0,
      }
    }
    // 逐模型余额差记账（与 DeepSeek 账本同口径：当天首次观测为基准，之后累加下降额）
    function apiRecordBalance(id, remaining) {
      try {
        const reg = readApiRegistry()
        reg.usage = reg.usage && typeof reg.usage === 'object' ? reg.usage : {}
        const day = todayKey()
        let cur = reg.usage[id]
        if (!cur || cur.day !== day) cur = apiUsageNewDay(cur, day, todayKey())
        if (typeof remaining === 'number' && isFinite(remaining)) {
          if (cur.dayStart === null || cur.dayStart === undefined) cur.dayStart = remaining
          if (typeof cur.lastBalance === 'number' && remaining < cur.lastBalance) cur.delta = addMoney(cur.delta, cur.lastBalance - remaining)
          cur.lastBalance = remaining
        }
        reg.usage[id] = cur
        writeApiRegistry(reg)
        return cur
      } catch (err) { return null }
    }
    // 今日已用：来源可能是「余额差」（厂商币种）或「会话事件金额」（已按自定义单价折算成人民币）。
    // 两种来源币种不同 → 返回值必须带上 currency，前端显示与阈值比较都按它走，
    // 否则 USD 单价的模型会把人民币数额渲染成 $、或拿两种单位直接比大小。
    function apiTodayUsage(id, modelCurrency) {
      const mcur = String(modelCurrency || 'CNY').toUpperCase() || 'CNY'
      try {
        const reg = readApiRegistry()
        const cur = reg.usage && reg.usage[id]
        if (!cur || cur.day !== todayKey()) return { amount: 0, source: 'none', currency: mcur }
        if (typeof cur.lastBalance === 'number' && isFinite(cur.lastBalance)) return { amount: preciseMoney(cur.delta || 0), source: 'balance', currency: mcur }
        return { amount: preciseMoney(Number(cur.eventCost) || 0), source: 'events', currency: 'CNY' }
      } catch (err) { return { amount: 0, source: 'none', currency: mcur } }
    }
    function apiUsageRaw(id) {
      try {
        const reg = readApiRegistry()
        return (reg.usage && reg.usage[id]) || null
      } catch (err) { return null }
    }
    // 额度「已用」：自动模式用会话 token 统计（不重置=累计-基准，每日=今日，每月=本月）
    function apiQuotaAutoUsed(id, q) {
      const u = apiUsageRaw(id) || {}
      const reset = (q && q.reset) || 'none'
      // 单位是「金额（元）」时自动统计意义不成立：自动累计的是 token，不是钱。
      // 这里直接回退成手动值（q.used），避免把 token 数当金额显示；界面上也约束为只能手动填写。
      if (q && q.unit === 'money' && (q.mode === 'auto' || q.mode === 'codex')) {
        return Math.round(Number(q.used) || 0)
      }
      // Codex 模式：已用 = Codex 本地会话统计的 token（按重置口径取今日/本月/累计）
      if (q && q.mode === 'codex') {
        const cs = codexSummaryCached()
        const base = Number(q.used) || 0
        if (!cs || !cs.ok) return base
        if (reset === 'daily') return Math.round(Number(cs.todayTokens) || 0)
        if (reset === 'monthly') return Math.round(Number(cs.monthTokens) || 0)
        const baseAt = Number(q.baseAt) || 0
        return Math.round(base + Math.max(0, (Number(cs.totalTokens) || 0) - baseAt))
      }
      if (reset === 'daily') return Math.round(Number(u.eventTokens) || 0)
      if (reset === 'monthly') return Math.round(Number(u.tokensMonth) || 0)
      const total = Number(u.tokensTotal) || 0
      const baseAt = Number(q && q.baseAt) || 0
      // used 在自动模式下表示「起始已用」（装机前已经用掉的部分）
      return Math.round((Number(q && q.used) || 0) + Math.max(0, total - baseAt))
    }
    // 会话事件归属：把某模型的 token 花费累加到注册表里匹配的模型（matchIds 子串匹配）
    function apiAttributeEvent(modelName, cost, tokens) {
      try {
        const name = String(modelName || '').toLowerCase()
        if (!name) return false
        const reg = readApiRegistry()
        let hit = null
        for (const m of reg.models) {
          if (!m || !m.id) continue
          const ids = Array.isArray(m.matchIds) && m.matchIds.length ? m.matchIds : [m.name, m.id]
          for (const s of ids) {
            const k = String(s || '').toLowerCase().trim()
            if (k && name.indexOf(k) >= 0) { hit = m; break }
          }
          if (hit) break
        }
        if (!hit) return false
        reg.usage = reg.usage && typeof reg.usage === 'object' ? reg.usage : {}
        const day = todayKey()
        let cur = reg.usage[hit.id]
        if (!cur || cur.day !== day) cur = apiUsageNewDay(cur, day, todayKey())
        cur.eventCost = addMoney(Number(cur.eventCost) || 0, Number(cost) || 0)
        cur.eventTokens = (Number(cur.eventTokens) || 0) + (Number(tokens) || 0)
        // 累计量：额度（资源包/订阅）按它算已用；跨天不清零
        const tk = Number(tokens) || 0
        cur.tokensTotal = (Number(cur.tokensTotal) || 0) + tk
        const mk = todayKey().slice(0, 7)
        if (cur.month !== mk) { cur.month = mk; cur.tokensMonth = 0 }
        cur.tokensMonth = (Number(cur.tokensMonth) || 0) + tk
        reg.usage[hit.id] = cur
        writeApiRegistry(reg)
        return true
      } catch (err) { return false }
    }
    // 删除模型：注册表 + 逐模型设置 + 所有泡泡里引用该模型的模块（含并列 A/B 与模块库）
    function apiDeleteModel(id) {
      const mid = String(id || '')
      if (!mid || mid === API_BUILTIN_ID) return { ok: false, error: '内置模型不可删除' }
      const reg = readApiRegistry()
      reg.models = reg.models.filter((m) => !(m && m.id === mid))
      if (reg.usage) delete reg.usage[mid]
      writeApiRegistry(reg)
      // 删除模型后同样失效单价缓存（它可能带着自定义单价）
      customPriceAt = 0
      let removed = 0
      try {
        const led = readUsageLedger()
        if (led.settings && led.settings.models && led.settings.models[mid]) {
          delete led.settings.models[mid]
          writeUsageLedger(led)
        }
      } catch (err) {}
      try {
        const cfg = loadBubbleConfig()
        let changed = false
        const stripItem = (obj) => {
          if (!obj || typeof obj !== 'object') return
          if (Array.isArray(obj.modules)) {
            const before = obj.modules.length
            obj.modules = obj.modules.filter((m) => !(m && m.modelId === mid))
            removed += before - obj.modules.length
            if (obj.modules.length !== before) changed = true
          }
          if (Array.isArray(obj.options)) {
            for (const o of obj.options) if (o && o.item) stripItem(o.item)
          }
        }
        // 泡泡步骤（含并列 A/B）
        if (Array.isArray(cfg.items)) for (const it of cfg.items) stripItem(it)
        // 模块库条目形态为 {id,name,module}
        if (Array.isArray(cfg.lib)) {
          for (let i = cfg.lib.length - 1; i >= 0; i--) {
            const lb = cfg.lib[i]
            if (lb && lb.module && lb.module.modelId === mid) { cfg.lib.splice(i, 1); changed = true; removed++; continue }
            if (lb && lb.module) stripItem(lb.module)
          }
        }
        if (changed) writeBubbleConfig(cfg)
      } catch (err) {}
      // v748：删掉的可能是最后一个 Codex 模型 → 立即重算「本机统计」是否启用（含清掉 2s 开关缓存）
      try { codexInvalidate() } catch (err) {}
      return { ok: true, removedModules: removed }
    }
    // 新增/更新模型；密钥（keyValue）若提供则写入 DSH 官方凭据
    // 自定义单价表刷新：把每个自定义 API 模型的 matchIds → 价格表映射进来，供 module 级 priceFor 使用
    // （priceFor 在模块作用域，读不到插件内的注册表，所以这里把结果写进 CUSTOM_PRICES）
    let customPriceAt = 0
    function refreshCustomPrices() {
      const now = Date.now()
      if (now - customPriceAt < 10000) return
      customPriceAt = now
      try {
        const map = {}
        const metaMap = {}
        for (const m of readApiRegistry().models) {
          // 内置模型（DeepSeek）跳过：它有自己的峰谷价表，不能被自定义单价覆盖
          if (!m || m.id === API_BUILTIN_ID) continue
          const pr = m && m.price
          if (!pr) continue
          const hit = Number(pr.hit), miss = Number(pr.miss), out = Number(pr.out)
          const ok = (v) => (isFinite(v) ? v : 0)
          if (!isFinite(hit) && !isFinite(miss) && !isFinite(out)) continue
          const table = { hit: [ok(hit), ok(hit)], miss: [ok(miss), ok(miss)], out: [ok(out), ok(out)] }
          const meta = { cur: String(pr.cur || 'CNY').toUpperCase(), rate: isFinite(Number(pr.rate)) ? Number(pr.rate) : 0 }
          const ids = Array.isArray(m.matchIds) && m.matchIds.length ? m.matchIds : [m.name, m.id]
          for (const s of ids) {
            const k = String(s || '').toLowerCase().trim()
            // 关键字过短（< 3 字符，如 pro/flash）极易误伤其它模型，直接忽略
            if (k && k.length >= 3) { map[k] = table; metaMap[k] = meta }
          }
        }
        CUSTOM_PRICES = map
        CUSTOM_PRICE_META = metaMap
      } catch (err) {}
    }
    async function apiSaveModel(input) {
      const p = input || {}
      const tpl = apiTemplateOf(p.provider)
      if (!tpl) return { ok: false, error: '未知的厂商模板' }
      const name = String(p.name || '').trim().slice(0, 30) || tpl.name
      const keyRef = String(p.keyRef || tpl.keyRef || '').trim().slice(0, 64) || tpl.keyRef
      const id = p.id ? String(p.id) : ('api_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7))
      const reg = readApiRegistry()
      let model = reg.models.find((m) => m && m.id === id)
      if (!model) {
        model = { id, createdAt: Date.now() }
        reg.models.push(model)
      }
      model.name = name
      model.provider = p.provider
      model.currency = String(p.currency || tpl.currency || 'CNY').toUpperCase().slice(0, 8)
      model.keyRef = keyRef
      if (p.baseUrl !== undefined) model.baseUrl = String(p.baseUrl || '').slice(0, 300)
      if (p.balance && typeof p.balance === 'object') {
        // v724：空字段不写入（stripEmptyDeep）→ 模板默认值继续生效；
        // 全部为空时直接删掉 model.balance，等于"完全用模板"
        const balIn = stripEmptyDeep({
          url: String(p.balance.url || '').slice(0, 500),
          auth: String(p.balance.auth || '').slice(0, 200),
          json: {
            remaining: String((p.balance.json && p.balance.json.remaining) || '').slice(0, 200),
            total: String((p.balance.json && p.balance.json.total) || '').slice(0, 200),
            used: String((p.balance.json && p.balance.json.used) || '').slice(0, 200),
            scale: isFinite(Number(p.balance.json && p.balance.json.scale)) ? Number(p.balance.json.scale) : undefined,
          },
        })
        if (balIn && Object.keys(balIn).length) model.balance = balIn
        else delete model.balance
        if (p.balance.usage && p.balance.usage.url) {
          model.balance = model.balance || {}
          model.balance.usage = stripEmptyDeep({
            url: String(p.balance.usage.url).slice(0, 500),
            auth: String(p.balance.usage.auth == null ? '' : p.balance.usage.auth).slice(0, 200),
            json: { used: String((p.balance.usage.json && p.balance.usage.json.used) || '').slice(0, 200), scale: isFinite(Number(p.balance.usage.json && p.balance.usage.json.scale)) ? Number(p.balance.usage.json.scale) : undefined },
          })
        }
      }
      // 会话事件归属：默认用「模型名」和「id」做子串匹配，用户可另填
      // 自定义单价（元/百万 token）：缓存命中 / 未命中输入 / 输出。留空则沿用内置价目表
      if (p.price && typeof p.price === 'object') {
        const num = (v) => {
          const s = String(v === undefined || v === null ? '' : v).trim()
          if (s === '') return undefined
          return isFinite(Number(s)) ? Number(s) : undefined
        }
        const pr = { hit: num(p.price.hit), miss: num(p.price.miss), out: num(p.price.out) }
        const cur0 = String(p.price.cur || '').trim().toUpperCase().slice(0, 8)
        const rate0 = num(p.price.rate)
        const anyPrice = pr.hit !== undefined || pr.miss !== undefined || pr.out !== undefined
        // 校验（为什么：不校验的话，负数/超大值会算出荒谬金额；USD 缺汇率会被静默当人民币记账）
        const inRange = (v, max) => v === undefined || (v >= 0 && v <= max)
        if (!inRange(pr.hit, 1000000) || !inRange(pr.miss, 1000000) || !inRange(pr.out, 1000000)) {
          return { ok: false, error: '单价必须是 0–1000000 之间的数字（单位：币种/百万 token）' }
        }
        if (rate0 !== undefined && !(rate0 > 0 && rate0 <= 1000)) {
          return { ok: false, error: '汇率必须是 0–1000 之间的正数（元/USD）' }
        }
        if (anyPrice && cur0 === 'USD' && !(rate0 > 0)) {
          return { ok: false, error: '单价币种为美元时必须填写汇率（元/USD）' }
        }
        if (cur0) pr.cur = cur0
        if (rate0 !== undefined) pr.rate = rate0
        if (pr.hit === undefined && pr.miss === undefined && pr.out === undefined) delete model.price
        else model.price = pr
      } else if (p.price === null) {
        delete model.price
      }
      writeApiRegistry(reg)
      // 改完单价立即失效缓存：否则 refreshCustomPrices 的 10 秒节流会让新价最坏 10 秒后才生效
      customPriceAt = 0
      // v748：新增/编辑模型可能改变"有没有 Codex 模型"，让 Codex 统计开关与快照立刻重算
      try { codexInvalidate() } catch (err) {}
      let keySaved = false
      if (p.keyValue !== undefined && String(p.keyValue).length) {
        try {
          await ctx.credentials.set(keyRef, String(p.keyValue))
          keySaved = true
        } catch (err) {}
      }
      return { ok: true, id, keySaved }
    }
    // 列表（含实时余额与各模型提醒/预算）：余额并发取，失败只影响该项
    async function apiModelsPayload() {
      const models = apiAllModels()
      const settings = readUsageSettings()
      const out = []
      let codexStats = null // Codex 本地会话统计（机器级，多个 codex 模型共享，算一次）
      for (const m of models) {
        let entry = {
          id: m.id, name: m.name, provider: m.provider, currency: m.currency,
          keyRef: m.keyRef, builtin: !!m.builtin, baseUrl: m.baseUrl || '',
          canAdjustBalance: canAdjustBuiltinBalance(m),
          matchIds: m.matchIds || [], settings: settings.models && settings.models[m.id] ? settings.models[m.id] : null,
          price: m.price || null,
          // 手动额度（订阅/资源包）：总量、单位、已用、重置周期；前端据此显示额度模块
          quota: (settings.models && settings.models[m.id] && settings.models[m.id].quota)
            ? Object.assign({}, settings.models[m.id].quota) : null,
          balance: null, todayUsage: null, todayUsageCurrency: null, usageSource: 'none', error: null,
        }
        // 自动模式的「已用」由 host 按会话 token 统计（前端不自己算）
        if (entry.quota) {
          entry.quota.autoUsed = apiQuotaAutoUsed(m.id, entry.quota)
          entry.quota.autoToday = Math.round(Number((apiUsageRaw(m.id) || {}).eventTokens) || 0)
        }
        // 把「接口描述」（url/请求头/字段）单独下发，供前端面板回填；
        // entry.balance 是数值，不能当描述用（否则面板保存会用空值覆盖描述）
        const tplE = apiTemplateOf(m.provider) || {}
        entry.balanceDesc = mergeNonEmpty(tplE.balance, m.balance) // v724：空串不覆盖模板
        if (m.id === API_BUILTIN_ID) {
          entry.balanceMode = 'api'
          entry.hasBalanceApi = true
          try {
            const cred = await ctx.credentials.resolve(m.keyRef || 'DEEPSEEK_API_KEY')
            entry.hasKey = !!(cred && cred.value)
          } catch (err) {}
          try {
            const p = await getBalance()
            if (p && p.ok) {
              entry.balance = Number(p.totalBalance)
              const summary = daySummary(readUsageLedger(), todayKey())
              entry.currency = p.currency
              entry.todayUsage = summary.amount
              entry.todayUsageCurrency = summary.currency
              entry.usageSource = summary.source
              entry.usageLabel = summary.label
              entry.accounting = balanceSummary(readUsageLedger(), todayKey())
            } else if (p) entry.error = p.error || p.code || '余额获取失败'
          } catch (err) { entry.error = String((err && err.message) || err) }
        } else {
          let hasKey = false
          try {
            const cred = await ctx.credentials.resolve(m.keyRef || '')
            hasKey = !!(cred && cred.value)
          } catch (err) {}
          entry.hasKey = hasKey
          // 该模型实际生效的余额描述：模板默认 + 用户覆盖
          const tplM = apiTemplateOf(m.provider) || {}
          const balDesc = Object.assign({}, tplM.balance || {}, m.balance || {})
          const hasBalanceApi = !!String(balDesc.url || '').trim()
          entry.hasBalanceApi = hasBalanceApi
          entry.probeUrl = String(tplM.probeUrl || '')
          // 订阅额度（kind='quota' 的模板，如智谱/Kimi/MiniMax Coding）：前端据此显示额度行与模块
          entry.planSupport = !!tplM.quota
          // Codex 模式：不查余额、不需要密钥，直接给本地会话统计（今日/本月/累计/近7天）
          if (tplM.kind === 'codex') {
            // 这里能等：模型列表请求可以稍等一下在途扫描（最多 2.5s），但绝不触发同步扫描
            if (!codexStats) codexStats = await codexSummaryEnsured(2500)
            entry.codex = codexStats
            entry.hasKey = true
            entry.error = codexStats && codexStats.ok ? null
              : (codexStats && codexStats.disabled ? null : ((codexStats && codexStats.error) || '未找到 Codex 会话目录'))
          }
          // 没有余额接口的厂商（如火山方舟）：余额显示「—」，只用会话事件估算
          entry.balanceMode = hasBalanceApi ? 'api' : 'events'
          if (hasBalanceApi && hasKey) {
            const r = await fetchModelBalance(m)
            if (r && r.ok) {
              entry.balance = r.remaining
              if (r.currency) entry.currency = r.currency
              apiRecordBalance(m.id, r.remaining)
              const u = apiTodayUsage(m.id, entry.currency || m.currency)
              entry.todayUsage = u.amount
              entry.usageSource = u.source
              entry.todayUsageCurrency = u.currency
            } else if (r) {
              entry.error = r.error || r.code || '余额获取失败'
            }
          } else if (!hasBalanceApi) {
            entry.error = null // 无余额接口不算错误
          } else {
            entry.error = '未配置 ' + (m.keyRef || 'API key')
          }
          // 订阅额度：有额度接口 + 有 key 才请求；失败只影响 plan 字段
          if (tplM.quota && hasKey) {
            try {
              entry.plan = await fetchModelQuota(m)
              if (entry.plan && !entry.plan.ok && apiPlanNoPlan(entry.plan.error)) entry.plan.hide = true
            } catch (err) { entry.plan = { ok: false, error: String((err && err.message) || err) } }
          }
          if (entry.todayUsage === null) {
            const u2 = apiTodayUsage(m.id, entry.currency || m.currency)
            entry.todayUsage = u2.amount
            entry.usageSource = u2.source
            entry.todayUsageCurrency = u2.currency
          }
        }
        out.push(entry)
      }
      return {
        ok: true,
        builtinId: API_BUILTIN_ID,
        // v724：把模板的接口描述也下发（B 方案：前端选模板后直接回填这些字段）
        templates: Object.keys(API_TEMPLATES).map((k) => ({
          id: k, name: API_TEMPLATES[k].name, currency: API_TEMPLATES[k].currency,
          keyRef: API_TEMPLATES[k].keyRef, builtin: !!API_TEMPLATES[k].builtin,
          needsBaseUrl: !!API_TEMPLATES[k].needsBaseUrl,
          hasBalance: !!String((API_TEMPLATES[k].balance || {}).url || '').trim(),
          probeUrl: String(API_TEMPLATES[k].probeUrl || ''),
          kind: String(API_TEMPLATES[k].kind || 'balance'),
          balance: API_TEMPLATES[k].balance ? JSON.parse(JSON.stringify(API_TEMPLATES[k].balance)) : null,
          quota: API_TEMPLATES[k].quota ? JSON.parse(JSON.stringify(API_TEMPLATES[k].quota)) : null,
          matchIds: Array.isArray(API_TEMPLATES[k].matchIds) ? API_TEMPLATES[k].matchIds.slice(0, 12) : [],
          noBalanceApi: !!API_TEMPLATES[k].noBalanceApi,
          apiNote: String(API_TEMPLATES[k].apiNote || ''),
          sortKey: tplSortKey(API_TEMPLATES[k].name), // v726：下拉排序键（前端按它排）
        })),
        models: out,
      }
    }

    // Each currency/key has its own timed observation window. An increase is
    // recorded separately and never subtracts previously observed consumption.
    function recordLedgerUsage(currentBalance, currency, scope, at) {
      const led = readUsageLedger()
      observeBalance(led, { balance: currentBalance, currency, scope, at })
      pruneLedgerUsage(led)
      if (!writeUsageLedger(led)) throw new Error('账本保存失败，请检查 DSH 数据目录写入权限')
      return led
    }
    function normalizeUsageMode() {
      return 'ledger' // 小鲸鱼记账为唯一记账方式
    }
    function ledgerTodayTotal(led) { return daySummary(led, todayKey()).amount }

    function publicBalance(payload) {
      const { accountTag, ...visible } = payload
      const led = readUsageLedger()
      const summary = daySummary(led, todayKey())
      const nowSec = Math.floor(Date.now() / 1000)
      return {
        ...visible, version: '0.3.13', isPeak: isPeakTime(nowSec),
        // 峰谷切换点与节假日清单：前端倒计时要与宿主同源（否则法定节假日会算错切换点）
        peakNextChangeAt: nextPeakChangeAt(nowSec),
        peakHolidays: HOLIDAY_VALLEY_LIST,
        todayUsage: summary.amount, todayUsageCurrency: summary.currency,
        usageSource: summary.source, usageLabel: summary.label, usageMode: 'ledger',
        accounting: balanceSummary(led, todayKey()),
      }
    }

    function getBalance(force = false) {
      const now = Date.now()
      if (!force && balanceCache && now - balanceCache.at < BALANCE_TTL_MS) {
        return Promise.resolve(publicBalance(balanceCache.payload))
      }
      if (balanceInFlight) return balanceInFlight
      balanceInFlight = fetchBalance()
        .then((payload) => {
          if (payload.ok) {
            recordLedgerUsage(payload.totalBalance, payload.currency, payload.accountTag, Date.parse(payload.updatedAt))
            balanceCache = { at: Date.now(), payload }
            return publicBalance(payload)
          }
          if (payload.transient && balanceCache) {
            return { ...publicBalance(balanceCache.payload), stale: true, error: payload.error }
          }
          return publicBalance(payload)
        })
        .catch((err) => ({
          ok: false, code: 'ERROR',
          error: '余额服务异常: ' + String((err && err.message) || err).slice(0, 200),
        }))
        .finally(() => { balanceInFlight = null })
      return balanceInFlight
    }

    function readSizeConfig() {
      for (const p of SIZE_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (parsed && typeof parsed.scale === 'number') {
            return {
              scale: parsed.scale,
              sound: parsed.sound !== false,
              vol: typeof parsed.vol === 'number' ? parsed.vol : 0.9,
              soundSet: typeof parsed.soundSet === 'string' && parsed.soundSet ? parsed.soundSet : 'duck',
              usageMode: normalizeUsageMode(parsed.usageMode),
              peakMode: parsed.peakMode === 'liangwen' || parsed.peakMode === 'qiangqiang' ? parsed.peakMode : 'default',
              bubbleOn: parsed.bubbleOn !== false,
              turnCostOn: parsed.turnCostOn !== false,
              turnCostCloseMs: typeof parsed.turnCostCloseMs === 'number' ? parsed.turnCostCloseMs : 5000,
              scrollGapOn: parsed.scrollGapOn === true,
              scrollGapPx: typeof parsed.scrollGapPx === 'number' ? Math.round(parsed.scrollGapPx) : 17,
              menuBtnHide: parsed.menuBtnHide === true,
              // issue #116：Codex 本地统计可以在设置里关掉（默认开）。关掉后宿主完全不扫
              // ~/.codex/sessions，也不做后台预热。
              codexStatsOn: parsed.codexStatsOn !== false,
            }
          }
        } catch (err) {}
      }
      return null
    }

    function writeSizeConfig(scale, sound, vol, soundSet, usageMode, peakMode, bubbleOn, turnCostOn, turnCostCloseMs, scrollGapOn, scrollGapPx, menuBtnHide, codexStatsOnArg) {
      const um = normalizeUsageMode(usageMode)
      const pm = peakMode === 'liangwen' || peakMode === 'qiangqiang' ? peakMode : 'default'
      const bo = bubbleOn !== false
      const tco = turnCostOn !== false
      const tcc = typeof turnCostCloseMs === 'number' ? (turnCostCloseMs > 0 ? turnCostCloseMs : 0) : 5000
      const sgo = scrollGapOn === true
      const sgp = typeof scrollGapPx === 'number' && scrollGapPx > 0 ? Math.round(scrollGapPx) : 0
      const mbh = menuBtnHide === true
      const cso = codexStatsOnArg !== false
      const body = JSON.stringify({
        scale: scale,
        sound: sound !== false,
        vol: typeof vol === 'number' ? vol : 0.9,
        soundSet: typeof soundSet === 'string' && soundSet ? soundSet : 'duck',
        usageMode: um,
        peakMode: pm,
        bubbleOn: bo,
        turnCostOn: tco,
        turnCostCloseMs: tcc,
        scrollGapOn: sgo,
        scrollGapPx: sgp,
        menuBtnHide: mbh,
        codexStatsOn: cso,
        updatedAt: new Date().toISOString(),
      })
      let lastSizeErr = null
      for (const p of SIZE_FILE_CANDIDATES) {
        try {
          fs.writeFileSync(p, body, 'utf8')
          return {
            ok: true,
            scale: scale,
            sound: sound !== false,
            vol: typeof vol === 'number' ? vol : 0.9,
            soundSet: typeof soundSet === 'string' && soundSet ? soundSet : 'duck',
            usageMode: um,
            peakMode: pm,
            bubbleOn: bo,
            turnCostOn: tco,
            turnCostCloseMs: tcc,
            scrollGapOn: sgo,
            scrollGapPx: sgp,
            menuBtnHide: mbh,
            codexStatsOn: cso,
          }
        } catch (err) { lastSizeErr = err }
      }
      // #88 / #97 报告者建议：把底层原因（EPERM / EACCES / 路径问题…）带出去。
      // 原先无论哪个候选路径失败，返回的都是同一句固定文案，即使前端检查了响应也定位不到原因。
      return { ok: false, error: '无法持久化挂件尺寸' + (lastSizeErr && lastSizeErr.message ? '：' + lastSizeErr.message : '') }
    }

    function readBody(req) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > 8192) {
            reject(new Error('body too large'))
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
    }

    function readBodyMax(req, maxBytes) {
      return new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', (c) => {
          size += c.length
          if (size > maxBytes) {
            reject(new Error('body too large'))
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
      })
    }

    // —— 自定义角色存储：whale-roles/ 目录，每个角色一个 <id>.png + roles.json 索引 ——
    function pickRoleDir() {
      for (const p of ROLE_DIR_CANDIDATES) {
        try {
          fs.mkdirSync(p, { recursive: true })
          fs.accessSync(p, fs.constants.W_OK)
          return p
        } catch (err) {}
      }
      return ROLE_DIR_CANDIDATES[0]
    }

    function defaultRolesIndex() {
      return {
        version: 1,
        roles: [
          // 默认小鲸鱼初始置顶；pinnedAt=1 作为基线，任何新置顶（Date.now()）都会排在它上面
          { id: ROLE_DEFAULT_ID, name: '小鲸鱼', pinnedAt: 1, createdAt: 0 },
        ],
      }
    }

    function readRolesIndex() {
      const dir = pickRoleDir()
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, ROLE_INDEX_NAME), 'utf8'))
        if (parsed && Array.isArray(parsed.roles)) {
          if (!parsed.roles.some((r) => r && r.id === ROLE_DEFAULT_ID)) {
            parsed.roles.unshift(defaultRolesIndex().roles[0])
          }
          return parsed
        }
      } catch (err) {}
      return defaultRolesIndex()
    }

    function writeRolesIndex(index) {
      const dir = pickRoleDir()
      try {
        fs.writeFileSync(path.join(dir, ROLE_INDEX_NAME), JSON.stringify(index, null, 2), 'utf8')
        return true
      } catch (err) {
        return false
      }
    }

    // 排序：置顶的在前（pinnedAt 大者先，即最新置顶在最上面），未置顶按创建时间倒序
    function sortRoles(roles) {
      return roles.slice().sort((a, b) => {
        const ap = a.pinnedAt && a.pinnedAt > 0 ? a.pinnedAt : 0
        const bp = b.pinnedAt && b.pinnedAt > 0 ? b.pinnedAt : 0
        if (ap && bp) return bp - ap
        if (ap) return -1
        if (bp) return 1
        return (b.createdAt || 0) - (a.createdAt || 0)
      })
    }

    function rolesPayload() {
      const index = readRolesIndex()
      return {
        ok: true,
        roles: sortRoles(index.roles).map((r) => ({
          id: r.id,
          name: String(r.name || r.id),
          url: r.id === ROLE_DEFAULT_ID ? '/dsh-whale/image.png' : '/dsh-whale/role-image.png?id=' + encodeURIComponent(r.id),
          pinned: !!(r.pinnedAt && r.pinnedAt > 0),
          pinnedAt: r.pinnedAt || null,
          createdAt: r.createdAt || null,
          // format: 'png' | 'gif' | 'apng'（旧角色无 format 字段 → png）
          format: r.format === 'gif' || r.format === 'apng' ? r.format : 'png',
        })),
      }
    }

    // 角色文件按格式映射扩展名：gif→.gif，apng/png→.png（APNG 文件仍是 PNG 容器）
    function roleFileExt(format) {
      return format === 'gif' ? 'gif' : 'png'
    }

    function roleFilePath(id, format) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || id === ROLE_DEFAULT_ID) return null
      return path.join(pickRoleDir(), id + '.' + roleFileExt(format))
    }

    function roleImagePath(id) {
      // 查找角色元数据确定扩展名；找不到默认 png
      const { role } = roleIndexFind(id)
      const format = role && (role.format === 'gif' || role.format === 'apng') ? role.format : 'png'
      const p = roleFilePath(id, format)
      return p
    }

    function roleIdFromUrl(url) {
      try {
        const q = String(url || '').split('?')[1] || ''
        const m = /(?:^|&)id=([^&]+)/.exec(q)
        return m ? decodeURIComponent(m[1]) : ''
      } catch (err) { return '' }
    }

    function roleIndexFind(id) {
      const index = readRolesIndex()
      const role = index.roles.find((r) => r && r.id === id)
      return { index, role }
    }

    // —— 自定义音频：whale-audio/ 目录，片段 <id>.wav + audio.json 索引 ——
    function pickAudioDir() {
      for (const p of AUDIO_DIR_CANDIDATES) {
        try {
          fs.mkdirSync(p, { recursive: true })
          fs.accessSync(p, fs.constants.W_OK)
          return p
        } catch (err) {}
      }
      return AUDIO_DIR_CANDIDATES[0]
    }

    function defaultAudioIndex() {
      return { version: 1, groups: [], fragments: [] }
    }

    function readAudioIndex() {
      const dir = pickAudioDir()
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, AUDIO_INDEX_NAME), 'utf8'))
        if (parsed && Array.isArray(parsed.groups) && Array.isArray(parsed.fragments)) {
          return parsed
        }
      } catch (err) {}
      return defaultAudioIndex()
    }

    function writeAudioIndex(index) {
      const dir = pickAudioDir()
      try {
        fs.writeFileSync(path.join(dir, AUDIO_INDEX_NAME), JSON.stringify(index, null, 2), 'utf8')
        return true
      } catch (err) {
        return false
      }
    }

    // 自定义片段 id -> 文件路径；预设片段无文件
    function audioFragmentPath(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
      if (PRESET_FRAGMENTS[id]) return null
      return path.join(pickAudioDir(), id + '.wav')
    }

    function audioIdFromUrl(url) {
      try {
        const q = String(url || '').split('?')[1] || ''
        const m = /(?:^|&)id=([^&]+)/.exec(q)
        return m ? decodeURIComponent(m[1]) : ''
      } catch (err) { return '' }
    }

    // 片段列表：预设片段 + 用户自定义片段
    function audioFragmentsPayload() {
      const index = readAudioIndex()
      const presets = Object.keys(PRESET_FRAGMENTS).map((k) => ({
        id: k,
        name: PRESET_FRAGMENTS[k].name,
        preset: true,
      }))
      const custom = index.fragments.map((f) => ({
        id: f.id,
        name: String(f.name || f.id),
        preset: false,
        createdAt: f.createdAt || null,
      }))
      return presets.concat(custom)
    }

    // 音效组列表：预设组 + 用户自定义组（置顶优先，组内按创建时间倒序）
    function audioGroupsPayload() {
      const index = readAudioIndex()
      // 排序：置顶的自定义组最前，其次预设组，最后未置顶的自定义组（按创建时间倒序）
      const customs = index.groups.slice().map((g) => ({
        id: g.id,
        name: String(g.name || g.id),
        press: typeof g.press === 'string' ? g.press : null,
        release: typeof g.release === 'string' ? g.release : null,
        preset: false,
        pinned: !!(g.pinnedAt && g.pinnedAt > 0),
        pinnedAt: g.pinnedAt || null,
        createdAt: g.createdAt || 0,
      }))
      const pinned = customs.filter((g) => g.pinned).sort((a, b) => b.pinnedAt - a.pinnedAt)
      const unpinned = customs.filter((g) => !g.pinned).sort((a, b) => b.createdAt - a.createdAt)
      const presets = Object.keys(PRESET_GROUPS).map((k) => {
        const g = PRESET_GROUPS[k]
        return { id: g.id, name: g.name, press: g.press, release: g.release, preset: true, pinned: false, pinnedAt: null, createdAt: 0 }
      })
      return pinned.concat(presets, unpinned)
    }

    function audioPayload() {
      return {
        ok: true,
        groups: audioGroupsPayload(),
        fragments: audioFragmentsPayload(),
      }
    }

    // 取片段音频字节：内置随包片段 → 预设(SOUND_SETS) → 自定义 whale-audio/<id>.wav
    function loadAudioFragmentBytes(fragId) {
      if (BUILTIN_FRAGMENT_FILES[fragId]) {
        return loadSound(BUILTIN_FRAGMENT_FILES[fragId])
      }
      if (PRESET_FRAGMENTS[fragId]) {
        // 预设片段映射到对应音效文件：ya1->duck.press, ya2->duck.release, d1->fx1.press, d2->fx1.release
        const map = { ya1: ['duck', 'press'], ya2: ['duck', 'release'], d1: ['fx1', 'press'], d2: ['fx1', 'release'] }
        const [setName, slot] = map[fragId]
        const set = SOUND_SETS[setName]
        if (!set) return null
        return loadSound(set[slot])
      }
      const p = audioFragmentPath(fragId)
      if (!p) return null
      try {
        const bytes = fs.readFileSync(p)
        if (bytes && bytes.length > 0) return bytes
      } catch (err) {}
      return null
    }

    // 组内实际使用的片段：若自定义组引用的片段被删，回退到预设
    // 返回 '' 表示该槽显式留空（该事件静音），调用方应据此不发音频
    function groupFragmentId(groupId, slot) {
      const custom = readAudioIndex().groups.find((g) => g && g.id === groupId)
      if (custom) {
        const fid = custom[slot]
        if (fid === '') return ''
        if (fid) {
          if (PRESET_FRAGMENTS[fid]) return fid
          if (customFragExists(fid)) return fid
        }
        // 无字段/引用失效 → 回退预设：新组无引用时用 duck
        return slot === 'press' ? PRESET_GROUPS.duck.press : PRESET_GROUPS.duck.release
      }
      const preset = PRESET_GROUPS[groupId]
      if (preset) return preset[slot]
      return slot === 'press' ? PRESET_GROUPS.duck.press : PRESET_GROUPS.duck.release
    }

    function customFragExists(id) {
      try {
        const p = audioFragmentPath(id)
        if (!p) return false
        const st = fs.statSync(p)
        return st.isFile()
      } catch (err) { return false }
    }

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/image.png',
      handler: (req, res) => {
        try {
          const bytes = loadImage()
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('whale image unavailable: ' + String((err && err.message) || err))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/rua.gif',
      handler: (req, res) => {
        try {
          const bytes = loadGif()
          res.writeHead(200, {
            'Content-Type': 'image/gif',
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('rua gif unavailable: ' + String((err && err.message) || err))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/balance.json',
      handler: async (req, res) => {
        try {
          const refresh = new URL(req.url || '/', 'http://localhost').searchParams.get('refresh') === '1'
          const payload = await getBalance(refresh)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(payload))
        } catch (err) {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/last-turn.json',
      handler: (req, res) => {
        // 返回最近一轮已完成的对话消耗；seq 递增供前端判断「新的一轮」
        const payload = lastTurn
          ? { ok: true, seq: lastTurnSeq, turn: lastTurn.turn, amount: lastTurn.amount, tokens: lastTurn.tokens, ts: lastTurn.ts }
          : { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(payload))
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/size.json',
      handler: async (req, res) => {
        if (req.method === 'PUT' || req.method === 'POST') {
          try {
            const body = await readBody(req)
            const parsed = JSON.parse(body)
            const scale = typeof parsed.scale === 'number' ? parsed.scale : null
            if (scale === null) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'missing scale' }))
              return
            }
            // issue #97：缺字段一律「沿用现有值」，绝不落默认 —— 否则任何不全的 PUT
            // （旧客户端 / 手写 curl / 加载竞态）都会把用户的设置洗成默认值。
            // 特别注意 scrollGapPx：读取默认是 17，而写入缺省曾是 0，会静默把避让宽度改掉。
            const old = readSizeConfig() || {}
            const pickB = (v, cur, dflt) => (typeof v === 'boolean' ? v : (typeof cur === 'boolean' ? cur : dflt))
            const pickN = (v, cur, dflt) => (typeof v === 'number' ? v : (typeof cur === 'number' ? cur : dflt))
            const pickS = (v, cur, dflt) => (typeof v === 'string' && v ? v : (typeof cur === 'string' && cur ? cur : dflt))
            // 用量模式变化时让余额缓存失效，下次请求立即按新模式计算
            if (typeof parsed.usageMode === 'string') {
              if (normalizeUsageMode(old.usageMode) !== normalizeUsageMode(parsed.usageMode)) {
                balanceCache = null
              }
            }
            const result = writeSizeConfig(
              scale,
              pickB(parsed.sound, old.sound, true),
              pickN(parsed.vol, old.vol, 0.9),
              pickS(parsed.soundSet, old.soundSet, 'duck'),
              typeof parsed.usageMode === 'string' ? parsed.usageMode : old.usageMode,
              typeof parsed.peakMode === 'string' ? parsed.peakMode : old.peakMode,
              pickB(parsed.bubbleOn, old.bubbleOn, true),
              pickB(parsed.turnCostOn, old.turnCostOn, true),
              pickN(parsed.turnCostCloseMs, old.turnCostCloseMs, 5000),
              pickB(parsed.scrollGapOn, old.scrollGapOn, false),
              pickN(parsed.scrollGapPx, old.scrollGapPx, 17),
              pickB(parsed.menuBtnHide, old.menuBtnHide, false),
              pickB(parsed.codexStatsOn, old.codexStatsOn, true)
            )
            res.writeHead(result.ok ? 200 : 500, JSON_HEADERS)
            // 配置刚变（可能刚关掉/打开 Codex 统计）→ 丢掉旧快照，让下一次请求立刻反映新设置
            if (result.ok) { try { codexInvalidate() } catch (err) {} }
            res.end(JSON.stringify(result))
          } catch (err) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
          }
          return
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(readSizeConfig() || {}))
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/usage-records.json',
      handler: async (req, res) => {
        try {
          // Reports read the committed ledger. Replaying cached balance samples
          // here could roll back a correction or create a false midnight baseline.
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(usageRecordsPayload()))
        } catch (err) {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
        }
      },
    }))
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/balance-adjustments.json',
      handler: async (req, res) => {
        try {
          // 先核对身份再碰余额或账本：必须是唯一且明确的 DeepSeek（内置）。
          // 新增厂商模板不会自动继承这个能力，也拒绝其它模型读写校正。
          const targetIds = new URL(req.url || '/', 'http://localhost').searchParams.getAll('modelId')
          const targetModelId = targetIds.length === 1 ? targetIds[0] : null
          if (targetModelId !== API_BUILTIN_ID || !canAdjustBuiltinBalance(apiModelById(targetModelId))) {
            const error = new Error('余额校正仅支持 DeepSeek（内置），请从该模型的设置菜单进入')
            error.status = 403
            throw error
          }
          if (req.method === 'PUT') {
            const input = JSON.parse(await readBodyMax(req, 8192))
            if (!input || typeof input !== 'object') throw new Error('校正内容无效')
            if (input.modelId !== targetModelId) {
              const error = new Error('校正请求的模型不匹配，仅支持 DeepSeek（内置）')
              error.status = 403
              throw error
            }
            if (input.day === todayKey()) {
              const fresh = await getBalance(true)
              if (!fresh.ok || fresh.stale) {
                res.writeHead(503, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: '暂时无法刷新余额，请稍后再保存校正' }))
                return
              }
            }
            const led = readUsageLedger()
            const summary = reconcileBalance(led, input)
            if (!writeUsageLedger(led)) throw new Error('校正保存失败，请检查 DSH 数据目录写入权限')
            balanceCache = null
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify({ ok: true, summary }))
            return
          }
          if (req.method !== 'GET' && req.method !== undefined) {
            res.writeHead(405, { ...JSON_HEADERS, Allow: 'GET, PUT' })
            res.end(JSON.stringify({ ok: false, error: '不支持的请求方法' }))
            return
          }
          const fresh = await getBalance(true)
          const led = readUsageLedger()
          const days = accountingDays(led).sort().reverse().map(day => balanceSummary(led, day))
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({
            ok: true, days, today: todayKey(), fresh: !!fresh.ok && !fresh.stale,
            error: !fresh.ok || fresh.stale ? (fresh.error || '余额暂未刷新') : null,
          }))
        } catch (err) {
          res.writeHead(err.status || 400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 240) }))
        }
      },
    }))

    // 用量设置(任务结束音/余额预警/今日预算)
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/usage-settings.json',
      handler: async (req, res) => {
        try {
          if (req.method === 'PUT' || req.method === 'POST') {
            const body = await readBody(req)
            const parsed = JSON.parse(body || '{}')
            if (!parsed || typeof parsed !== 'object') throw new Error('bad body')
            const result = writeUsageSettings(parsed)
            res.writeHead(result.ok ? 200 : 400, JSON_HEADERS)
            res.end(JSON.stringify(result))
            return
          }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, settings: readUsageSettings() }))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
        }
      },
    }))

    // 自定义 API 模型：GET 列表（含实时余额/今日已用/各模型提醒预算）
    // POST {action: save|delete|set-key|delete-key|model-settings}
    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/api-models.json',
      handler: async (req, res) => {
        try {
          if (req.method === 'PUT' || req.method === 'POST') {
            const body = await readBody(req)
            const parsed = JSON.parse(body || '{}')
            const action = String((parsed && parsed.action) || 'save')
            if (action === 'delete') {
              const r = apiDeleteModel(parsed.id)
              const list = await apiModelsPayload()
              res.writeHead(r.ok ? 200 : 400, JSON_HEADERS)
              res.end(JSON.stringify({ ...r, models: list.models }))
              return
            }
            if (action === 'probe') {
              // 只做只读连通性测试（如方舟 /api/v3/models），不消耗 token
              const m0 = apiModelById(parsed.id)
              const pr = await apiProbeModel(m0)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify(pr))
              return
            }
            if (action === 'set-key' || action === 'delete-key') {
              const ref = String(parsed.keyRef || '').trim()
              if (!ref) throw new Error('bad keyRef')
              const svc = ctx.credentials
              if (action === 'set-key') {
                await svc.set(ref, String(parsed.keyValue || ''))
              } else if (typeof svc.unset === 'function') {
                // 普通密钥存在凭据文档的 refs 段：必须用 unset 才能真正删除
                // （deleteRecord 只处理 records 段的结构化记录，对 refs 会静默返回）
                await svc.unset(ref)
              } else {
                await svc.deleteRecord(ref)
              }
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true }))
              return
            }
            if (action === 'model-settings') {
              const r = writeUsageSettings({ modelSettings: { id: String(parsed.id || ''), alert: parsed.alert, budget: parsed.budget, quota: parsed.quota } })
              res.writeHead(r.ok ? 200 : 400, JSON_HEADERS)
              res.end(JSON.stringify(r))
              return
            }
            // 注意：keyValue 在提交体上（不在 model 里），必须合并进去，
            // 否则前端面板里填的 API key 会被丢弃（密钥永远存不进去）
            const r = await apiSaveModel({ ...(parsed.model || parsed), keyValue: parsed.keyValue })
            const list2 = await apiModelsPayload()
            res.writeHead(r.ok ? 200 : 400, JSON_HEADERS)
            res.end(JSON.stringify({ ...r, models: list2.models }))
            return
          }
          const payload = await apiModelsPayload()
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(payload))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/roles.json',
      handler: async (req, res) => {
        if (req.method === 'POST' || req.method === 'PUT') {
          try {
            // 放宽到 30MB：支持最大 20MB 的 GIF（base64 膨胀约 1.33 倍）
            const body = await readBodyMax(req, 30 * 1024 * 1024)
            const parsed = JSON.parse(body)
            const name = String(parsed.name || '').trim().slice(0, 20) || '新角色'
            const image = String(parsed.image || '')
            const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(image)
            if (!m) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'invalid image data' }))
              return
            }
            const buf = Buffer.from(m[2], 'base64')
            if (buf.length < 8 || buf.length > 20 * 1024 * 1024) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'image too large' }))
              return
            }
            // format：客户端显式告知 gif/apng（APNG 的 dataURL 是 image/png，需客户端区分）；
            // 未显式给时按 dataURL 的 MIME 推断（gif→gif，其余 png）
            const declared = parsed.format === 'gif' ? 'gif' : (parsed.format === 'apng' ? 'apng' : null)
            const fmt = declared || (m[1] === 'gif' ? 'gif' : 'png')
            const id = 'role_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
            const dir = pickRoleDir()
            fs.writeFileSync(path.join(dir, id + '.' + roleFileExt(fmt)), buf)
            const index = readRolesIndex()
            index.roles.push({ id, name, format: fmt, pinnedAt: null, createdAt: Date.now() })
            writeRolesIndex(index)
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify(rolesPayload()))
          } catch (err) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
          }
          return
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(rolesPayload()))
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/role-pin.json',
      handler: async (req, res) => {
        try {
          const body = await readBodyMax(req, 8192)
          const parsed = JSON.parse(body)
          const id = String(parsed.id || '')
          const { index, role } = roleIndexFind(id)
          if (!role) {
            res.writeHead(404, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'role not found' }))
            return
          }
          role.pinnedAt = parsed.pinned === true ? Date.now() : null
          writeRolesIndex(index)
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(rolesPayload()))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/role-delete.json',
      handler: async (req, res) => {
        try {
          const body = await readBodyMax(req, 8192)
          const parsed = JSON.parse(body)
          const id = String(parsed.id || '')
          if (id === ROLE_DEFAULT_ID) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'cannot delete default role' }))
            return
          }
          const { index, role } = roleIndexFind(id)
          if (!role) {
            res.writeHead(404, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'role not found' }))
            return
          }
          // 先按角色 format 确定文件路径（必须在从索引移除之前，否则查不到 format 默认成 png，删不掉 .gif）
          const fmt = role.format === 'gif' || role.format === 'apng' ? role.format : 'png'
          const p = roleFilePath(id, fmt)
          index.roles = index.roles.filter((r) => r.id !== id)
          writeRolesIndex(index)
          if (p) { try { fs.unlinkSync(p) } catch (err) {} }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(rolesPayload()))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/role-image.png',
      handler: (req, res) => {
        try {
          const id = roleIdFromUrl(req.url)
          const p = roleImagePath(id)
          if (!p) throw new Error('bad role id')
          const bytes = fs.readFileSync(p)
          // 按角色格式返回对应 MIME：gif 动图 → image/gif；png/apng 都是 PNG 容器 → image/png
          const { role } = roleIndexFind(id)
          const mime = role && role.format === 'gif' ? 'image/gif' : 'image/png'
          res.writeHead(200, {
            'Content-Type': mime,
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('role image unavailable')
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/audio.json',
      handler: async (req, res) => {
        if (req.method === 'POST' || req.method === 'PUT') {
          try {
            const body = await readBodyMax(req, 8 * 1024 * 1024)
            const parsed = JSON.parse(body)
            const action = parsed.action
            const index = readAudioIndex()
            if (action === 'upload-fragment') {
              const name = String(parsed.name || '').trim().slice(0, 40) || '未命名音频'
              const audio = String(parsed.audio || '')
              const m = /^data:audio\/wav;base64,([A-Za-z0-9+/=]+)$/.exec(audio)
              if (!m) {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: 'invalid wav data' }))
                return
              }
              const buf = Buffer.from(m[1], 'base64')
              if (buf.length < 44 || buf.length > 8 * 1024 * 1024) {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: 'audio too large' }))
                return
              }
              const id = 'audio_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
              fs.writeFileSync(path.join(pickAudioDir(), id + '.wav'), buf)
              index.fragments.push({ id, name, createdAt: Date.now() })
              writeAudioIndex(index)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, id, fragments: audioFragmentsPayload() }))
              return
            }
            if (action === 'save-group') {
              const id = String(parsed.id || '')
              const name = String(parsed.name || '').trim().slice(0, 20) || '未命名音效组'
              const press = String(parsed.press ?? '')
              const release = String(parsed.release ?? '')
              // 校验引用片段存在（预设或自定义）；空字符串=该槽留空(该事件静音)，允许保存
              const frags = audioFragmentsPayload().map((f) => f.id)
              const validPress = press === '' ? '' : (frags.includes(press) ? press : PRESET_GROUPS.duck.press)
              const validRelease = release === '' ? '' : (frags.includes(release) ? release : PRESET_GROUPS.duck.release)
              if (id && index.groups.some((g) => g.id === id)) {
                const g = index.groups.find((x) => x.id === id)
                g.name = name
                g.press = validPress
                g.release = validRelease
              } else {
                const gid = 'group_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
                index.groups.push({ id: gid, name, press: validPress, release: validRelease, pinnedAt: null, createdAt: Date.now() })
              }
              writeAudioIndex(index)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, groups: audioGroupsPayload() }))
              return
            }
            if (action === 'delete-group') {
              const id = String(parsed.id || '')
              if (PRESET_GROUPS[id]) {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: 'cannot delete preset group' }))
                return
              }
              index.groups = index.groups.filter((g) => g.id !== id)
              writeAudioIndex(index)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, groups: audioGroupsPayload() }))
              return
            }
            if (action === 'delete-fragment') {
              const id = String(parsed.id || '')
              if (PRESET_FRAGMENTS[id]) {
                res.writeHead(400, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: 'cannot delete preset fragment' }))
                return
              }
              index.fragments = index.fragments.filter((f) => f.id !== id)
              writeAudioIndex(index)
              const p = audioFragmentPath(id)
              if (p) { try { fs.unlinkSync(p) } catch (err) {} }
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, fragments: audioFragmentsPayload(), groups: audioGroupsPayload() }))
              return
            }
            if (action === 'pin-group') {
              const id = String(parsed.id || '')
              const g = index.groups.find((x) => x.id === id)
              if (!g) {
                res.writeHead(404, JSON_HEADERS)
                res.end(JSON.stringify({ ok: false, error: 'group not found' }))
                return
              }
              g.pinnedAt = parsed.pinned === true ? Date.now() : null
              writeAudioIndex(index)
              res.writeHead(200, JSON_HEADERS)
              res.end(JSON.stringify({ ok: true, groups: audioGroupsPayload() }))
              return
            }
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
          } catch (err) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
          }
          return
        }
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(audioPayload()))
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/audio-fragment.wav',
      handler: (req, res) => {
        try {
          const id = audioIdFromUrl(req.url)
          const bytes = loadAudioFragmentBytes(id)
          if (!bytes) throw new Error('bad fragment id')
          // 预设/内置片段可能是 mp3 也可能是 wav —— Content-Type 必须与字节匹配，
          // 否则浏览器解码路径/加载行为异常（MIME 与字节不符会导致听感差异）
          const mime = fragmentMime(id)
          res.writeHead(200, {
            'Content-Type': mime,
            'Cache-Control': 'no-store',
            'Content-Length': String(bytes.length),
          })
          res.end(bytes)
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('audio fragment unavailable')
        }
      },
    }))

    // 片段字节对应的 MIME：内置/预设片段按声明，自定义片段一律 wav
    function fragmentMime(fragId) {
      const f = PRESET_FRAGMENTS[fragId]
      return (f && f.mime) || 'audio/wav'
    }

    function loadSound(candidates) {
      for (const p of candidates) {
        try {
          const bytes = fs.readFileSync(p)
          if (bytes && bytes.length > 0) return bytes
        } catch (err) {}
      }
      return null
    }

    function serveSound(req, res, candidates) {
      const bytes = loadSound(candidates)
      if (!bytes) {
        // v752：404 也带 no-store。原来只有 200 分支有缓存头，失败的响应可能被浏览器/中间层
        // 缓存住，一旦缓存就会变成"永久没声音、刷新也没用"。
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end('sound unavailable')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Content-Length': String(bytes.length),
      })
      res.end(bytes)
    }

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/sound/press.mp3',
      handler: (req, res) => {
        const set = SOUND_SETS[soundSetFromUrl(req.url)] || SOUND_SETS.duck
        // 自定义音效组：set 为组 id 时按组内 press 片段取音频
        const setName = soundSetFromUrl(req.url)
        if (setName && !SOUND_SETS[setName]) {
          const fragId = groupFragmentId(setName, 'press')
          if (fragId === '') { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return } // 留空槽：该事件静音（v752：补 no-store，空响应不允许被缓存）
          const bytes = loadAudioFragmentBytes(fragId)
          if (bytes) {
            res.writeHead(200, {
              'Content-Type': fragmentMime(fragId),
              'Cache-Control': 'no-store',
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
            return
          }
        }
        serveSound(req, res, set.press)
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/sound/release.mp3',
      handler: (req, res) => {
        const set = SOUND_SETS[soundSetFromUrl(req.url)] || SOUND_SETS.duck
        const setName = soundSetFromUrl(req.url)
        if (setName && !SOUND_SETS[setName]) {
          const fragId = groupFragmentId(setName, 'release')
          if (fragId === '') { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return } // 留空槽：该事件静音（v752：补 no-store，空响应不允许被缓存）
          const bytes = loadAudioFragmentBytes(fragId)
          if (bytes) {
            res.writeHead(200, {
              'Content-Type': fragmentMime(fragId),
              'Cache-Control': 'no-store',
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
            return
          }
        }
        serveSound(req, res, set.release)
      },
    }))

    function pickBubbleImgDir() {
      for (const p of BUBBLE_IMG_DIR_CANDIDATES) {
        try {
          fs.mkdirSync(p, { recursive: true })
          fs.accessSync(p, fs.constants.W_OK)
          return p
        } catch (err) {}
      }
      return BUBBLE_IMG_DIR_CANDIDATES[0]
    }
    function defaultBubbleImgIndex() {
      return { version: 1, images: [] }
    }
    function readBubbleImgIndex() {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(pickBubbleImgDir(), BUBBLE_IMG_INDEX_NAME), 'utf8'))
        if (parsed && Array.isArray(parsed.images)) return parsed
      } catch (err) {}
      return defaultBubbleImgIndex()
    }
    function writeBubbleImgIndex(index) {
      try {
        fs.writeFileSync(path.join(pickBubbleImgDir(), BUBBLE_IMG_INDEX_NAME), JSON.stringify(index, null, 2), 'utf8')
        return true
      } catch (err) {
        return false
      }
    }
    function bubbleImgPayload() {
      const index = readBubbleImgIndex()
      // 内置默认图常驻(先列出,不占 createdAt 排序;用户图库含同 id 时不重复)
      const seen = {}
      index.images.forEach((im) => { seen[im.id] = 1 })
      const builtins = DEFAULT_BUBBLE_IMGS.filter((d) => !seen[d.id]).map((d) => ({
        id: d.id,
        name: String(d.name || d.id),
        format: d.format === 'gif' ? 'gif' : 'png',
        url: '/dsh-whale/bubble-img.png?id=' + encodeURIComponent(d.id),
        createdAt: null,
        builtin: true,
      }))
      return {
        ok: true,
        images: builtins.concat(index.images.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((im) => ({
          id: im.id,
          name: String(im.name || im.id),
          format: im.format === 'gif' ? 'gif' : 'png',
          url: '/dsh-whale/bubble-img.png?id=' + encodeURIComponent(im.id),
          createdAt: im.createdAt || null,
        }))),
      }
    }
    function bubbleImgIdFromUrl(url) {
      try {
        const q = String(url || '').split('?')[1] || ''
        const m = /(?:^|&)id=([^&]+)/.exec(q)
        return m ? decodeURIComponent(m[1]) : ''
      } catch (err) { return '' }
    }
    function loadBubbleConfig() {
      for (const p of BUBBLE_FILE_CANDIDATES) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (parsed && parsed.v === 1) return parsed
        } catch (err) {}
      }
      return null
    }
    function writeBubbleConfig(cfg) {
      const body = JSON.stringify(cfg, null, 2)
      for (const p of BUBBLE_FILE_CANDIDATES) {
        try { fs.writeFileSync(p, body, 'utf8'); return true } catch (err) {}
      }
      return false
    }

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/bubble.json',
      handler: async (req, res) => {
        try {
          if (req.method === 'POST' || req.method === 'PUT') {
            const body = await readBodyMax(req, 512 * 1024)
            const parsed = JSON.parse(body)
            if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items) || !Array.isArray(parsed.lib)) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'invalid bubble config' }))
              return
            }
            // v727：tapAdvance =「点按角色推进泡泡队列」（只存布尔值，不放行其它字段）
            const cfg = { v: 1, items: parsed.items, lib: parsed.lib, tapAdvance: parsed.tapAdvance === true }
            writeBubbleConfig(cfg)
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify({ ok: true, config: cfg }))
            return
          }
          const cfg = loadBubbleConfig()
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, config: cfg }))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/bubble-imgs.json',
      handler: (req, res) => {
        res.writeHead(200, JSON_HEADERS)
        res.end(JSON.stringify(bubbleImgPayload()))
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/bubble-img-upload.json',
      handler: async (req, res) => {
        try {
          const body = await readBodyMax(req, 10 * 1024 * 1024)
          const parsed = JSON.parse(body)
          const action = parsed && parsed.action
          const index = readBubbleImgIndex()
          if (action === 'upload') {
            const name = String(parsed.name || '').trim().slice(0, 40) || ''
            const data = String(parsed.data || '')
            const m = /^data:image\/(png|gif);base64,([A-Za-z0-9+/=]+)$/.exec(data)
            if (!m) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'invalid image data' }))
              return
            }
            const format = m[1] === 'gif' ? 'gif' : 'png'
            const buf = Buffer.from(m[2], 'base64')
            if (buf.length < 64 || buf.length > 8 * 1024 * 1024) {
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'image too large' }))
              return
            }
            const id = 'bimg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
            fs.writeFileSync(path.join(pickBubbleImgDir(), id + '.' + format), buf)
            index.images.push({ id, name, format, createdAt: Date.now() })
            writeBubbleImgIndex(index)
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify(bubbleImgPayload()))
            return
          }
          if (action === 'delete') {
            const id = String(parsed.id || '')
            const img = index.images.find((x) => x.id === id)
            if (!img) {
              res.writeHead(404, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'image not found' }))
              return
            }
            index.images = index.images.filter((x) => x.id !== id)
            writeBubbleImgIndex(index)
            const ext = img.format === 'gif' ? 'gif' : 'png'
            try { fs.unlinkSync(path.join(pickBubbleImgDir(), id + '.' + ext)) } catch (err) {}
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify(bubbleImgPayload()))
            return
          }
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'unknown action' }))
        } catch (err) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
        }
      },
    }))

    disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/bubble-img.png',
      handler: (req, res) => {
        try {
          const id = bubbleImgIdFromUrl(req.url)
          // 1) 用户图库优先
          const index = readBubbleImgIndex()
          const img = index.images.find((x) => x.id === id)
          if (img) {
            const ext = img.format === 'gif' ? 'gif' : 'png'
            const bytes = fs.readFileSync(path.join(pickBubbleImgDir(), id + '.' + ext))
            res.writeHead(200, {
              'Content-Type': img.format === 'gif' ? 'image/gif' : 'image/png',
              'Cache-Control': 'no-store',
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
            return
          }
          // 2) 内置默认图回退(全新安装无用户图库时,泡泡序列引用的语义 id 也能出图)
          const def = DEFAULT_BUBBLE_IMGS.find((x) => x.id === id)
          if (def) {
            const bytes = loadBuiltinBubbleImgBytes(def)
            if (bytes) {
              res.writeHead(200, {
                'Content-Type': def.format === 'gif' ? 'image/gif' : 'image/png',
                'Cache-Control': 'no-store',
                'Content-Length': String(bytes.length),
              })
              res.end(bytes)
              return
            }
          }
          throw new Error('bad image id')
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('bubble image unavailable')
        }
      },
    }))

          disposers.push(registerRoute({
      kind: 'exact',
      path: '/dsh-whale/widget.js',
      handler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(loadWidgetJs())
      },
    }))

    disposers.push(ctx.webServer.tapIndex((html) => {
      if (html.indexOf('/dsh-whale/widget.js') !== -1) return html
      const tag = '<script defer src="/dsh-whale/widget.js"></script>'
      if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
      return html + tag
    }))

    // —— 官方 DSH 桌面端（Electron）适配（issue #152 / #153 / #154）——
    // 桌面壳的 index.html 是**从安装包静态 dist 直接读盘**的（`dsh-app://app/`），永远不经过宿主的
    // renderIndex()，所以上面的 tapIndex 在桌面端不生效 —— 于是"宿主半区活着、客户端半区从未被请求"。
    // 桌面端唯一的注入通道是 `webserver/index-inject` 的结构化行（宿主启动时 collectIndexInjections()
    // 经 IPC 交给渲染层，渲染层按 kind 逐行应用）。
    // **该行的注册已上移到 apply() 开头**（见 `DESKTOP_WIDGET_ROW_TEXT` 上方那段注释）：两个原因 ——
    // ① 桌面端的注入表是**一次性收集**的，行必须尽早进表；② 行本身改成了**内联 script 行**，
    // 因为页面侧解释器对 `script-src` 是"加载失败即 reject 整个 boot"（issue #154 的致命启动错误）。

    ctx.effect(() => () => {
      for (const d of disposers) {
        try { d() } catch (err) {}
      }
    })
    }) // ← 结束 root.inject(['webServer','credentials','connection'], cb)
  },
}

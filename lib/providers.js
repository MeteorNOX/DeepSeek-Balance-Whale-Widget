/**
 * Relay-account adapters for the whale-balance widget: one reader per provider
 * type, a single shared read path, and a uniform output shape.
 *
 * ## Why this file exists
 *
 * The widget used to know one account: DeepSeek's own. A key from a relay
 * (New API, Sub2API) cannot be read with that code, not because the query is
 * hard but because the shapes differ and because two of them answer refusal in
 * the HTTP body rather than the status line. This is the seam that keeps those
 * differences out of `index.js` and out of the UI: add a reader, register it,
 * and the widget can describe a third kind of key without touching any rendering
 * code.
 *
 * ## One shape for every reader
 *
 * Every reader returns the same object, and a field is ABSENT rather than zero
 * when the response does not carry it. A balance of nothing and an unreported
 * balance are different facts, and showing the second as the first tells someone
 * their account is empty.
 *
 *     { ok, error?, message?, total?, granted?, used?, unlimited?,
 *       isAvailable?, currency?, windows?, label?, keyName?, expiresAt?,
 *       provider? }
 *
 * `ok` is true when the account was read at all. `error` is a machine code on
 * failure (see below); `message` is the human reason. `windows` is an
 * array of rolling subscription quanta, already normalized to the display
 * order session → daily → weekly → monthly. `provider` mirrors the type so an
 * orchestrator never has to carry it around separately. `isAvailable` means
 * "the account can spend now" and is false for a key the vendor recognises but
 * has exhausted/expired/disabled — a different fact from a failed request,
 * which is `ok:false` (TokenLedger semantics, `@see balance.js`).
 *
 * ## A 200 is not a yes
 *
 * New API answers every request, even a refused one, with HTTP 200 and puts the
 * verdict in the body (`{"success":false,"message":"..."}`). Reading only
 * `response.ok` there parses the refusal as data, finds none of the fields it
 * wanted, and renders a card that says the account is empty — the one thing this
 * module promises never to do. So a scheme may declare an `envelope`, which the
 * shared read path runs BEFORE the reader sees the body. That is the same fence
 * TokenLedger's `balance.js` draws (`@see TokenLedger/src/balance.js`).
 *
 * @module dsh-whale-providers
 */

/** Byte ceiling on an upstream response body (PRD 4.2: 建议 256 KB). */
export const MAX_BYTES = 256 * 1024;

/** How many same-origin redirect hops are followed before giving up (PRD 4.2). */
export const MAX_REDIRECTS = 3;

/** Display order for subscription windows: shortest clock first. */
export const WINDOW_ORDER = ["session", "daily", "weekly", "monthly"];

/** The credential reference each type resolves by default (PRD 6.2). */
export const DEFAULT_CREDENTIALS = {
  deepseek: "DEEPSEEK_API_KEY",
  newapi: "NEWAPI_API_KEY",
  sub2api: "SUB2API_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  "kimi-coding": "KIMI_CODING_API_KEY",
  zhipu: "ZHIPU_API_KEY",
  "zhipu-coding": "ZHIPU_CODING_API_KEY",
  openrouter: "OPENROUTER_MANAGEMENT_KEY",
  "opencode-go": "OPENCODE_GO_API_KEY",
  minimax: "MINIMAX_SUBSCRIPTION_KEY",
};

/**
 * Default credential references for the New API user-balance path.
 *
 * `GET /api/user/self` needs the user's own system access token (not the `sk-`
 * API key) and, on some stations, the user ID:
 *
 * - `Authorization: Bearer <访问令牌>` — generated at 个人设置 → 安全设置.
 * - `New-Api-User: <用户ID>` — shown at the top of the 个人设置 page.
 *
 * Both are resolved through the credentials seam like any other key and never
 * ride a query string, a config file, or a payload returned to the browser.
 */
export const DEFAULT_USER_TOKEN_CREDENTIALS = {
  userToken: "NEWAPI_USER_TOKEN",
  userId: "NEWAPI_USER_ID",
};

/** The fallback label when the caller does not supply one (PRD 6.2). */
export const DEFAULT_LABELS = {
  deepseek: "DeepSeek 官方",
  newapi: "New API",
  sub2api: "Sub2API",
  moonshot: "Moonshot / Kimi",
  "kimi-coding": "Kimi For Coding",
  zhipu: "智谱 GLM / Z.ai",
  "zhipu-coding": "智谱 GLM Coding",
  openrouter: "OpenRouter",
  "opencode-go": "OpenCode Go",
  minimax: "MiniMax Token Plan",
};

/**
 * Parse a number a JSON API may have sent as a string.
 *
 * Named for its direction, mirroring TokenLedger: a string that trims to empty
 * is absent, and a non-finite number is absent too. `undefined` is returned
 * rather than `0` so a caller can tell "not reported" from "zero".
 */
export function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * DeepSeek's own balance-selection strategy, lifted verbatim from the widget's
 * existing `pickBalanceInfo` (lib/index.js). Kept as a single implementation so
 * the relay adaptation never forks the official rule.
 *
 * Preference order, in decreasing priority:
 *   1. a CNY entry with a positive balance,
 *   2. any entry with a positive balance,
 *   3. a CNY entry (even a zero one),
 *   4. the first entry.
 */
export function pickBalanceInfo(infos) {
  if (!Array.isArray(infos) || infos.length === 0) return null;
  const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN);
  return (
    infos.find((x) => x && x.currency === "CNY" && num(x) > 0) ||
    infos.find((x) => num(x) > 0) ||
    infos.find((x) => x && x.currency === "CNY") ||
    infos[0]
  );
}

/**
 * Validate and normalize a user-supplied station address.
 *
 * PRD 4.2: `baseUrl` must be a real http(s) URL with no username/password
 * component (a credential in the URL would leak into logs and browser history).
 * `origin` is returned so every request, and every redirect decision, is
 * measured against the same string.
 */
export function normalizeOrigin(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl === "") return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username !== "" || url.password !== "") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Build an upstream query gate: per-origin fixed-window counter with an
 * ADAPTIVE per-origin cap.
 *
 * 起点上限 15 次 / 5 分钟（实测 api.hohai.eu.org：60 次 / 20 分钟，
 * 等效 15 次 / 5 分钟）。当站点回 429 且带 `retry-after` 时，宿主调用
 * {@link learnRateLimitCap} 用「retry-after 窗口内实际已发请求数」推算站点
 * 真实配额，再经 `guard.setMax(origin, n)` 收紧该站点的上限 —— 无需人工
 * 配置，自动收敛到站点能承受的次数。
 *
 * `readAccount` accepts the returned function as its `guard` option and
 * checks it before EVERY upstream request; a refusal becomes
 * `error: "rate-limited"` without touching the network. Counting happens
 * before the request, so an over-limit station is never asked to enforce its
 * own limit by answering 429.
 *
 * One gate instance is shared by all accounts; the window is keyed by origin,
 * so accounts on different stations share nothing and one station cannot
 * starve another.
 *
 * Accessors:
 *   - `guard.max(origin?)` → 该 origin 的当前上限（未学习时返回默认值）。
 *   - `guard.setMax(origin, n)` → 设定/收紧某 origin 的上限（立即生效）。
 *   - `guard.stats()` → `{ [origin]: { used, max, remaining, learned } }`。
 *   - `guard.historyCount(origin, windowMs)` → 最近 windowMs 内该 origin
 *     实际发出的请求数（自适应学习的样本来源）。
 *
 * @param options - `{ windowMs = 5 min, max = 15, now = Date.now }`.
 * @returns `guard(origin)` → `true` when the request may proceed.
 */
export function createRateLimiter(options = {}) {
  const windowMs = options.windowMs ?? 5 * 60 * 1000;
  const defaultMax = options.max ?? 15;
  const now = options.now ?? Date.now;
  const windows = new Map(); // origin -> { start, count }
  const overrides = new Map(); // origin -> max（429 学习后的自适应上限）
  const history = new Map(); // origin -> number[]（已放行请求的时间戳）
  const HISTORY_CAP = 4000; // 每 origin 保留的时间戳上限，防内存无界增长
  const maxFor = (origin) => (overrides.has(origin) ? overrides.get(origin) : defaultMax);
  function guard(origin) {
    const t = now();
    let w = windows.get(origin);
    if (w === undefined || t - w.start >= windowMs) {
      w = { start: t, count: 0 };
      windows.set(origin, w);
    }
    if (w.count >= maxFor(origin)) return false;
    w.count += 1;
    let h = history.get(origin);
    if (h === undefined) {
      h = [];
      history.set(origin, h);
    }
    h.push(t);
    if (h.length > HISTORY_CAP) h.splice(0, h.length - HISTORY_CAP);
    return true;
  }
  guard.max = (origin) => (origin === undefined ? defaultMax : maxFor(origin));
  guard.setMax = (origin, n) => {
    overrides.set(origin, Math.max(1, Math.min(Math.round(n), 10000)));
  };
  guard.stats = () => {
    const out = {};
    for (const [origin, w] of windows) {
      const m = maxFor(origin);
      out[origin] = { used: w.count, max: m, remaining: Math.max(0, m - w.count), learned: overrides.has(origin) };
    }
    return out;
  };
  guard.historyCount = (origin, windowMs2) => {
    const h = history.get(origin);
    if (h === undefined || h.length === 0) return 0;
    const cutoff = now() - windowMs2;
    let count = 0;
    for (let i = h.length - 1; i >= 0; i--) {
      if (h[i] >= cutoff) count++;
      else break;
    }
    return count;
  };
  return guard;
}

/**
 * 自适应限流学习公式（纯函数，供宿主在收到 429 + retry-after 时调用）。
 *
 * 输入：站点 429 响应里 retry-after 的封禁窗口（通常等于站点的计数窗口，
 * 实测 hohai ≈ 20 分钟），以及我们在这个窗口内实际发出的请求数 `recent`。
 * 输出：折算到 5 分钟窗口的安全上限（×0.8 余量，向下取整，下限 1）。
 *
 * 样本不足（recent < 5，例如本窗口第一个请求就 429 —— 说明是站内其它
 * 流量触发的封禁）时不学习，避免用噪声把上限打残。
 *
 * @param recent - retryAfterMs 窗口内实际已发请求数。
 * @param retryAfterMs - 站点 429 的 retry-after（毫秒）。
 * @param windowMs - 折算目标窗口（默认 5 分钟）。
 * @param safety - 安全系数（默认 0.8）。
 * @returns `{ learned: boolean, per5min?: number }`。
 */
export function learnRateLimitCap(recent, retryAfterMs, windowMs = 5 * 60 * 1000, safety = 0.8) {
  if (!Number.isFinite(recent) || recent < 5) return { learned: false };
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return { learned: false };
  const per5 = Math.max(1, Math.min(10000, Math.floor((recent * windowMs) / retryAfterMs * safety)));
  return { learned: true, per5min: per5 };
}

/** A labeled error. `code` is the stable machine reason; `message` is human. */
function fail(code, message) {
  return Object.assign(new Error(typeof message === "string" && message !== "" ? message : code), { code });
}

/**
 * Follow redirects by hand, and stop at the first one that leaves the origin.
 *
 * The default `redirect: "follow"` sends the Authorization header wherever the
 * redirect points, so a relay that answers `302 https://collector.example/` is
 * handed the user's key. That is the cheapest way around every other rule in
 * this module, and it costs one option to close: take the hops manually, allow
 * at most `MAX_REDIRECTS`, and abort the moment the target is a different
 * origin (TokenLedger's `fetchNoCrossOriginRedirect`, `@see balance.js`).
 *
 * A stub `fetch` in a test returns no `status` and no headers, so the 3xx
 * branch is simply never entered.
 */
async function followRedirects(doFetch, url, init) {
  let current = url;
  for (let hop = 0; ; hop++) {
    let response;
    try {
      response = await doFetch(current, init);
    } catch (error) {
      throw labelFetchError(error);
    }
    const status = response?.status;
    if (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) return response;

    const location = response.headers?.get?.("location");
    if (location === undefined || location === null || location === "" || hop >= MAX_REDIRECTS) {
      throw fail(`http-${status}`, `HTTP ${status}（重定向次数超限）`);
    }
    const next = new URL(location, current);
    if (next.origin !== new URL(current).origin) {
      // Not a transport failure — a refusal to hand the credential to another host.
      throw fail("cross-origin-redirect", "跨域重定向已中止（防止 Authorization 泄漏）");
    }
    current = next.href;
  }
}

/** Map a thrown fetch error to a labeled one, or pass an already-labeled one through. */
function labelFetchError(error) {
  if (error && typeof error.code === "string") return error;
  const name = error?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return fail("timeout", "请求超时（15 秒）");
  }
  return fail("unreachable", `网络请求失败: ${String(error?.message || error)}`);
}

/**
 * Read a response body with a byte ceiling.
 *
 * The declared endpoint is not one of ours, so its answer is not assumed to be
 * a reasonable size. Streamed where the runtime gives us a reader — which is
 * what actually bounds the cost — and length-checked otherwise, which at least
 * bounds the parse (PRD 4.2: 响应体读取上限 256 KB).
 */
async function readCapped(response, maxBytes) {
  const reader = response?.body?.getReader?.();
  if (reader === undefined || reader === null) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw fail("too-large", "响应体超过 256 KB 上限");
    return text;
  }

  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw fail("too-large", "响应体超过 256 KB 上限");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Build the labeled error to throw for a non-2xx response (PRD 5.4). */
function httpError(status) {
  const hint = status === 401 || status === 403
    ? `HTTP ${status} · 站点需要普通 API key（当前凭据无效或权限不足）`
    : `HTTP ${status}`;
  return fail(`http-${status}`, hint);
}

// —— 新增站点适配器的共用小工具（v1.3 多上游对接） ——

/** 字段值可能是字符串数字或真数字，两种都收（Kimi coding 实测两种都出现）。 */
function numLike(value) {
  return toNumber(value);
}

/** 已用/剩余二选一：优先 used；否则用 limit − remaining 推导并夹到 ≥0。 */
function pickCount(usedRaw, remainingRaw, limit) {
  const used = numLike(usedRaw);
  if (used !== undefined) return Math.max(0, used);
  const remaining = numLike(remainingRaw);
  if (remaining !== undefined && Number.isFinite(limit)) return Math.max(0, limit - remaining);
  return undefined;
}

/** Kimi 系重置时刻：字段名三种写法（reset_at/resetTime/resetAt），RFC3339。 */
function kimiResetAt(obj) {
  for (const key of ["reset_at", "resetTime", "resetAt"]) {
    const raw = obj?.[key];
    if (typeof raw === "string" && raw !== "") {
      const ms = Date.parse(raw);
      if (Number.isFinite(ms)) return { resetsAt: new Date(ms).toISOString() };
    }
  }
  return {};
}

/** 持续秒数 → 展示窗口 kind（未知时长归入最接近的较短桶）。 */
function kindForDuration(seconds) {
  const s = numLike(seconds);
  if (s === undefined) return "daily";
  if (s <= 6 * 3600) return "session";
  if (s <= 24 * 3600 * 2) return "daily";
  if (s <= 24 * 3600 * 10) return "weekly";
  return "monthly";
}

/** 百分比字段宽容读取：数值/字符串数字，夹在 [0,100]。 */
function clampPercent(value) {
  const v = numLike(value);
  if (v === undefined) return undefined;
  return Math.min(100, Math.max(0, v));
}

/** 智谱 quota type 关键词 → 展示窗口 kind。 */
function kindForZhipuType(type) {
  const t = String(type || "").toLowerCase();
  if (t.includes("week")) return "weekly";
  if (t.includes("month") || t.includes("mon")) return "monthly";
  if (t.includes("day") || t.includes("daily")) return "daily";
  if (t.includes("5") || t.includes("hour") || t.includes("prompt")) return "session";
  return "daily";
}

/**
 * One reader per provider type, plus the official DeepSeek account.
 *
 * Each reader receives a `get(path, { anonymous })` fence (see
 * {@link readAccount}) and returns the account fields. `get` already applied
 * the type's `envelope` and threw on refusal, so a reader only ever sees a body
 * its vendor meant to show.
 */
export const SCHEMES = {
  deepseek: {
    label: DEFAULT_LABELS.deepseek,
    defaultOrigin: "https://api.deepseek.com",
    /**
     * DeepSeek official balance: `{origin}/user/balance`, key held in the
     * Bearer header. The account is a wallet, so there is no "unlimited" shape
     * — the existing official selection strategy (CNY-first, via
     * `pickBalanceInfo`) is the only rule that matters. `@see lib/index.js`.
     */
    async read({ get }) {
      const body = await get("/user/balance");
      if (!body || typeof body !== "object") throw fail("shape", "余额接口返回结构异常");
      const info = pickBalanceInfo(Array.isArray(body?.balance_infos) ? body.balance_infos : []);
      if (!info || info.total_balance === undefined) throw fail("shape", "余额接口返回结构异常");
      return {
        currency: String(info.currency || "CNY"),
        total: toNumber(info.total_balance),
        granted: toNumber(info.granted_balance),
        // is_available===false means the key is real but the account cannot
        // spend; surface it rather than pretending the balance is usable.
        // Absent means "no verdict", which we treat as available (the field
        // only ever says "no" explicitly).
        isAvailable: body.is_available !== false,
      };
    },
  },

  newapi: {
    label: DEFAULT_LABELS.newapi,
    // New API answers every request — even a refused or invalid one — with HTTP
    // 200, and puts the verdict in the body. See the module header.
    envelope: (body) => {
      if (!body || body.success !== false) return undefined;
      const message =
        (typeof body.message === "string" && body.message.trim() !== "" ? body.message : null) ||
        (typeof body.msg === "string" && body.msg.trim() !== "" ? body.msg : "refused");
      return { message };
    },
    /**
     * New API token usage quota + user wallet balance.
     *
     * Two upstream facts, two different credentials:
     *
     * - `/api/usage/token/` (ordinary `sk-` key) answers **token usage**: the
     *   port's `total_granted` / `total_used` / `total_available` /
     *   `unlimited_quota`. The trailing slash is load-bearing: without it New
     *   API answers 301, and a redirect drops the Authorization header on some
     *   clients. Never remove it.
     * - `/api/user/self` (user access token, see module header) answers the
     *   **user wallet balance**: `data.quota` is the user's remaining balance
     *   in internal quota units and `data.used_quota` the amount used — the
     *   same pair the site's own wallet page renders as
     *   `quota ÷ quota_per_unit` in `quota_display_type` currency. Request
     *   shape per the station API docs: `Authorization: Bearer <访问令牌>`
     *   plus `New-Api-User: <用户ID>`.
     *
     * `{origin}/api/status` is queried anonymously for `quota_per_unit`, the
     *   site's own divisor for turning a quota integer into money, and
     *   `quota_display_type`, the currency the site's wallet page shows.
     *
     * The token path stays the source of `used`/`granted`/`unlimited` (the
     * 已用配额 view). The user path supplies `total` (the 余额 view) — and
     * when the user token is not configured, `total` is ABSENT with
     * `userTokenConfigured: false`, which is the UI's signal to prompt for it.
     * A failed user-balance request degrades only that one field
     * (`userBalanceError`), never the token facts.
     */
    async read({ get, userToken, userId, scaleFallback }) {
      const body = await get("/api/usage/token/");
      const data = body?.data ?? {};
      const granted = toNumber(data.total_granted);
      const used = toNumber(data.total_used);
      const available = toNumber(data.total_available);

      let scale;
      let siteCurrency = "USD";
      let statusOk = false;
      try {
        const status = (await get("/api/status", { anonymous: true }))?.data ?? {};
        const perUnit = toNumber(status.quota_per_unit);
        if (perUnit !== undefined && perUnit > 0) scale = 1 / perUnit;
        const displayType =
          typeof status.quota_display_type === "string" && status.quota_display_type.trim() !== ""
            ? status.quota_display_type.trim()
            : undefined;
        if (displayType !== undefined) siteCurrency = displayType;
        statusOk = true;
      } catch {
        // 状态接口失败（限流/网络抖动）时，优先用宿主缓存的「上次成功换算率」：
        // quota_per_unit 几乎不变，用缓存换算可避免把配额整数当金额显示成
        // 天文数字（实测超限后出现过 65755622.00 这类原始 total_used）。
        if (scaleFallback && typeof scaleFallback === "object") {
          scale = scaleFallback.scale;
          if (typeof scaleFallback.siteCurrency === "string" && scaleFallback.siteCurrency !== "") {
            siteCurrency = scaleFallback.siteCurrency;
          }
        }
        // 缓存也没有：保持 scale 未定义（raw 回退仅作最后手段）。
      }

      // Rounded like the billing adapter does: 752600/500000 is 1.5052, and
      // binary floating point renders it 1.5051999999999999 on a card.
      // 配额整数 ÷ quota_per_unit（本类站点为 50w / 500000）= 网站额度（USD/CNY）。
      const money = (quota) =>
        quota === undefined ? undefined : scale === undefined ? quota : Math.round(quota * scale * 1e6) / 1e6;
      // 有些站点把 unlimited_quota 置为 true，却仍返回真实有限的 quota
      // （如 total_granted=500000、total_available 为正）——此时余额确实存在，应照常显示；
      // 只有 quota 真正缺失或为负（从 0 递减成负的用量，是假余额）才算「不限额」。
      const flaggedUnlimited = data.unlimited_quota === true;
      const hasQuota = (granted !== undefined && granted > 0) || (available !== undefined && available > 0);
      const unlimited = flaggedUnlimited && !hasQuota;

      // —— 用户余额：/api/user/self（系统访问令牌 + 用户 ID）——
      const userTokenConfigured = typeof userToken === "string" && userToken !== "";
      let userBalance; // money
      let userBalanceRaw; // quota integer
      let userUnlimited;
      let userBalanceError;
      if (userTokenConfigured) {
        try {
          const self = await get("/api/user/self", {
            bearer: userToken,
            headers: typeof userId === "string" && userId !== "" ? { "New-Api-User": userId } : undefined,
          });
          const u = self?.data ?? {};
          // data.quota = 用户余额（剩余额度），不是「授予总量」。站点文档原文：
          // "quota": 用户余额，除以 50w（500000）等于网站额度。
          const raw = toNumber(u.quota);
          const uUnlimited = u.unlimited_quota === true;
          userUnlimited = uUnlimited;
          if (!uUnlimited && raw !== undefined) {
            userBalanceRaw = raw;
            userBalance = money(raw);
          }
        } catch (error) {
          // The wallet figure degrades alone; the token facts stay true.
          userBalanceError = typeof error?.code === "string" ? error.code : "unreachable";
        }
      }

      // 货币选择：站点币种与配额原值两个变体（其余币种无可靠汇率，不虚构换算）。
      let currencyOptions;
      if (userBalanceRaw !== undefined) {
        currencyOptions = [
          { key: "site", label: siteCurrency, value: userBalance, currency: siteCurrency },
          { key: "raw", label: "配额原值", value: userBalanceRaw, currency: "" },
        ];
      }

      return {
        unlimited,
        // An unlimited key can spend by definition; a limited key is spendable
        // while any quota remains (TokenLedger's `isAvailable` semantics).
        isAvailable: unlimited || (available ?? 0) > 0,
        currency: scale === undefined ? undefined : "USD",
        // 余额态 = 用户余额。未配置访问令牌时缺省，由前端弹窗引导配置；
        // 用户不限额时同样缺省（无「余额」可言，展示「已用」）。
        total: userBalance,
        // 用户余额自身币种（站点 quota_display_type，实测 CNY）：余额态的
        // 「自动」符号以此为准，避免把 CNY 数值错标成 USD。
        ...(userBalance !== undefined ? { balanceCurrency: siteCurrency } : {}),
        granted: unlimited ? undefined : money(granted),
        used: money(used),
        // The key's own name, which the site's console shows beside every row.
        keyName: typeof data.name === "string" && data.name !== "" ? data.name : undefined,
        // 0 means "never" in New API's shape, not "expired at the epoch".
        expiresAt: toNumber(data.expires_at) || undefined,
        userTokenConfigured,
        ...(userUnlimited ? { userUnlimited: true } : {}),
        ...(userBalanceError ? { userBalanceError } : {}),
        // 状态接口本次成功且拿到换算率：回传给宿主缓存，供下次失败时兜底
        ...(statusOk && scale !== undefined ? { statusScale: { scale, siteCurrency } } : {}),
        ...(currencyOptions ? { currencyOptions } : {}),
      };
    },
  },

  sub2api: {
    label: DEFAULT_LABELS.sub2api,
    /**
     * `/v1/usage` answers in one of three shapes, and only one of them has a
     * `balance`:
     *
     * - **quota_limited** — the key carries a total quota, or per-window rate
     *   limits, or both. `quota` holds the money; `rate_limits[]` holds one
     *   entry per configured window (`5h`, `1d`, `7d`) with a `reset_at` that is
     *   only present while the window is still open.
     * - **subscription** — no key-level limit, but the key's group is a plan.
     *   The periods live under `subscription` as paired `*_usage_usd` /
     *   `*_limit_usd` figures, and there is no `balance`.
     * - **wallet** — the original shape, and the only one that sends
     *   `balance`/`remaining`.
     *
     * `remaining === -1` is the gateway's "no period limit is configured", not a
     * debt — an unlimited key, showing its spent total instead of a fake
     * balance. `@see TokenLedger balance.js`.
     */
    async read({ get }) {
      const body = await get("/v1/usage");
      if (!body || typeof body !== "object") throw fail("shape", "usage 接口返回结构异常");

      const currency = typeof body.unit === "string" && body.unit !== "" ? body.unit : undefined;

      // `isValid` stays true for a key that is out of quota or past expiry —
      // upstream means "we recognise this key", not "you can spend on it". The
      // availability line is about the latter.
      const status = typeof body.status === "string" ? body.status : undefined;
      const isAvailable =
        body.isValid !== false && status !== "quota_exhausted" && status !== "expired" && status !== "disabled";

      // -1 is "no period limit is configured", not a debt.
      const remaining = toNumber(body.remaining);
      const subscription = body.subscription;
      const quota = body.quota;
      const unlimited = subscription !== undefined && subscription !== null && remaining === -1;

      const amount =
        quota !== undefined && quota !== null
          ? { total: toNumber(quota.remaining), granted: toNumber(quota.limit), used: toNumber(quota.used) }
          : subscription !== undefined && subscription !== null
            ? { total: unlimited ? undefined : remaining, used: sub2apiUsed(body) }
            : { total: toNumber(body.balance) };

      const windows = normalizeWindows([...sub2apiRateLimits(body.rate_limits), ...sub2apiPeriods(subscription)]);

      return {
        currency,
        ...amount,
        ...(unlimited ? { unlimited: true } : {}),
        isAvailable,
        ...(windows === undefined ? {} : { windows }),
      };
    },
  },

  /**
   * Moonshot / Kimi 开放平台余额：`GET {origin}/v1/users/me/balance`。
   * 响应：`{code:0, status:true, data:{available_balance, voucher_balance,
   * cash_balance}}`，单位人民币元（platform.kimi.com/docs/api/balance）。
   * available_balance ≤ 0 时站点会拒绝推理调用 —— 与 isAvailable 对齐。
   */
  moonshot: {
    label: DEFAULT_LABELS.moonshot,
    envelope(body) {
      if (body && typeof body === "object" && body.code !== undefined && Number(body.code) !== 0) {
        const message =
          typeof body.message === "string" && body.message !== ""
            ? body.message
            : typeof body.error?.message === "string"
              ? body.error.message
              : `余额接口 code=${body.code}`;
        return { status: body.code, message };
      }
      if (body && typeof body === "object" && body.status === false) {
        return { status: "status-false", message: "余额接口返回 status=false" };
      }
      return undefined;
    },
    async read({ get }) {
      const body = await get("/v1/users/me/balance");
      const data = body?.data ?? {};
      const balance = toNumber(data.available_balance);
      if (balance === undefined) throw fail("shape", "余额接口缺少 available_balance");
      return {
        currency: "CNY",
        total: balance,
        // 可用余额 ≤ 0 → 账户实际不可消费（欠费/代金券耗尽），如实呈现。
        isAvailable: balance > 0,
      };
    },
  },

  /**
   * Kimi For Coding 订阅：`GET {origin}/coding/v1/usages`。
   * 形状（社区解析为准，kimi.rs / usagebar）：顶层
   * `{usage:{limit,used,remaining?,reset_at|resetTime|resetAt}, limits:[{
   *   detail:{limit,used|remaining}, window:{duration 秒}}]}`。
   * `usage` 视为周窗口；`limits[]` 按持续秒数映射窗口类型。字段值允许字符串
   * 数字（上游两种都出现过）。
   */
  "kimi-coding": {
    label: DEFAULT_LABELS["kimi-coding"],
    async read({ get }) {
      const body = await get("/coding/v1/usages");
      if (!body || typeof body !== "object") throw fail("shape", "usages 接口返回结构异常");
      if (typeof body.error?.message === "string" && !body.usage && !Array.isArray(body.limits)) {
        throw fail("upstream-" + body.error.message.slice(0, 60), body.error.message);
      }
      const windows = [];
      const usage = body.usage;
      if (usage && typeof usage === "object") {
        const limit = numLike(usage.limit);
        if (limit !== undefined && limit > 0) {
          windows.push({
            kind: "weekly",
            used: pickCount(usage.used, usage.remaining, limit),
            limit,
            ...kimiResetAt(usage),
          });
        }
      }
      for (const entry of Array.isArray(body.limits) ? body.limits : []) {
        const detail = entry?.detail ?? {};
        const limit = numLike(detail.limit);
        if (limit === undefined || limit <= 0) continue;
        windows.push({
          kind: kindForDuration(entry?.window?.duration),
          used: pickCount(detail.used, detail.remaining, limit),
          limit,
        });
      }
      const norm = normalizeWindows(windows);
      if (!norm || norm.length === 0) throw fail("shape", "usages 接口没有可展示的配额窗口");
      return { windows: norm, total: undefined, isAvailable: true };
    },
  },

  /**
   * 智谱 GLM / Z.ai 余额（v1.3.3 统一策略）：报表接口站域无关地先试——
   * 国内与国际站都开放 `GET /api/biz/account/query-customer-account-report`；
   * 失败时以 `GET /api/paas/v4/balance` 兜底。字段映射（实测契约，vendor 不
   * 回传货币字段，固定 CNY）：
   *     total     = availableBalance ?? balance      （isAvailable = total > 0）
   *     granted   = rechargeAmount + giveAmount       （授予总额）
   *     used      = totalSpendAmount                  （消费）
   * 两连败时抛兜底端点的错误。仅「端点不存在」（404）触发兜底——信封类
   * 拒绝（鉴权失败等）是上游的有效回答，直接透传，不烧查询额度。
   */
  zhipu: {
    label: DEFAULT_LABELS.zhipu,
    envelope(body) {
      if (body && typeof body === "object") {
        if (body.success === false) {
          return { status: body.code ?? "error", message: typeof body.msg === "string" ? body.msg : "balance 接口拒绝" };
        }
        if (typeof body.code === "number" && body.code !== 200 && body.data === undefined) {
          return { status: body.code, message: typeof body.msg === "string" ? body.msg : `balance 接口 code=${body.code}` };
        }
      }
      return undefined;
    },
    async read({ origin, get }) {
      try {
        const body = await get("/api/biz/account/query-customer-account-report");
        const root = body && typeof body === "object" && body.data && typeof body.data === "object" ? body.data : body ?? {};
        if (!root || typeof root !== "object") throw fail("shape", "账户报表返回结构异常");
        const total = toNumber(root.availableBalance) ?? toNumber(root.balance);
        if (total === undefined) throw fail("shape", "账户报表缺少 availableBalance/balance 字段");
        const recharge = toNumber(root.rechargeAmount);
        const give = toNumber(root.giveAmount);
        const granted = recharge === undefined && give === undefined ? undefined : (recharge ?? 0) + (give ?? 0);
        const used = toNumber(root.totalSpendAmount);
        return {
          currency: "CNY",
          total,
          ...(granted !== undefined ? { granted } : {}),
          ...(used !== undefined ? { used } : {}),
          isAvailable: total > 0,
        };
      } catch (error) {
        // 兜底触发面：端点不存在（404）与网络级失败（unreachable/timeout，
        // 可能是瞬时抖动）。信封类拒绝（鉴权失败等）是上游的有效回答，直接
        // 透传给用户，不烧查询额度。
        const code = String(error?.code)
        if (code !== "http-404" && code !== "unreachable" && code !== "timeout") throw error;
      }

      // —— 兜底：paas/v4 余额（宽容提取） ——
      try {
        const body = await get("/api/paas/v4/balance");
        const data = body?.data ?? body;
        if (!data || typeof data !== "object") throw fail("shape", "balance 接口返回结构异常");
        const candidates = [
          "available_balance",
          "availableBalance",
          "totalBalance",
          "total_balance",
          "balance",
          "remaining_amount",
        ];
        let balance;
        for (const key of candidates) {
          const value = toNumber(data[key]);
          if (value !== undefined) { balance = value; break; }
        }
        if (balance === undefined) throw fail("shape", "balance 接口未包含可识别的余额字段");
        return { currency: "CNY", total: balance, isAvailable: true };
      } catch (fallbackError) {
        // 兜底端点自身的错误（含 404：两个端点都缺失）即为最终结论
        throw fallbackError;
      }
    },
  },

  /**
   * OpenRouter 余额：`GET https://openrouter.ai/api/v1/credits`，
   * **Management Key**（管理密钥，非 sk-or-v1- 推理 key）认证。响应：
   * `{data:{total_credits:number,total_usage:number}}`（官方 OpenAPI 示例）。
   * USD 结算：remaining = credits − usage。
   */
  openrouter: {
    label: DEFAULT_LABELS.openrouter,
    defaultOrigin: "https://openrouter.ai",
    async read({ get }) {
      const body = await get("/api/v1/credits");
      const data = body?.data ?? {};
      const credits = toNumber(data.total_credits);
      const usedRaw = toNumber(data.total_usage);
      if (credits === undefined) throw fail("shape", "credits 接口缺少 total_credits");
      const used = usedRaw ?? 0;
      return {
        currency: "USD",
        total: Math.round((credits - used) * 1e6) / 1e6,
        granted: credits,
        used,
        isAvailable: credits > used,
      };
    },
  },

  /**
   * OpenCode Go 订阅：`GET {origin}/zen/go/v1/usage`。
   * 响应（社区约定，opencode-go-usage）：`{usage:{rolling:{percent,resetsAt},
   * weekly:{percent,resetsAt}, monthly:{percent,resetsAt}}}` —— 只有百分比与
   * 重置时刻，没有绝对用量，故窗口只带 usedPercent/resetsAt（used/limit 缺省），
   * 提示行渲染「剩余 N%」而不是虚构计数。
   */
  "opencode-go": {
    label: DEFAULT_LABELS["opencode-go"],
    defaultOrigin: "https://opencode.ai",
    async read({ get }) {
      const body = await get("/zen/go/v1/usage");
      const usage = body?.usage;
      if (!usage || typeof usage !== "object") throw fail("shape", "usage 接口返回结构异常");
      const map = [
        ["rolling", "session"],
        ["weekly", "weekly"],
        ["monthly", "monthly"],
      ];
      const windows = [];
      for (const [remoteKind, kind] of map) {
        const row = usage[remoteKind];
        if (!row || typeof row !== "object") continue;
        const percent = clampPercent(row.percent);
        if (percent === undefined) continue;
        windows.push({
          kind,
          usedPercent: percent,
          ...(typeof row.resetsAt === "string" && row.resetsAt !== "" ? { resetsAt: row.resetsAt } : {}),
        });
      }
      const norm = normalizeWindows(windows);
      if (!norm || norm.length === 0) throw fail("shape", "usage 接口没有可展示的窗口");
      return { windows: norm, total: undefined, isAvailable: true };
    },
  },

  /**
   * MiniMax Token Plan（原 Coding Plan）订阅：
   * `GET {origin}/v1/token_plan/remains`，Bearer 用 **Subscription Key**
   * （platform.minimax.io/user-center/payment/token-plan）。响应：
   * `{model_remains:[{model_name,current_interval_total_count,
   * current_interval_usage_count,remains_time,current_interval_status,
   * current_weekly_total_count,current_weekly_usage_count,
   * weekly_remains_time,current_weekly_status}]}`；
   * status 1=正常 2=耗尽 3=无限。多模型行取「消耗占比最差」的一行作为该
   * 窗口的显示值（统一额度池下最先触顶的维度决定体验）。秒级剩余时间在
   * 此刻折算为绝对重置时刻（now 注入保持纯函数）。
   */
  minimax: {
    label: DEFAULT_LABELS.minimax,
    async read({ get, now }) {
      const body = await get("/v1/token_plan/remains");
      const rows = Array.isArray(body?.model_remains) ? body.model_remains.filter((r) => r && typeof r === "object") : [];
      if (rows.length === 0) throw fail("shape", "remains 接口缺少 model_remains");
      const allUnlimited =
        rows.every((r) => numLike(r.current_interval_status) === 3) &&
        rows.every((r) => numLike(r.current_weekly_status) === 3);
      if (allUnlimited) return { unlimited: true, total: undefined, isAvailable: true };

      const worstBy = (aKey, bKey, tKey, sKey) => {
        let best;
        for (const r of rows) {
          const limit = numLike(r[aKey]);
          if (limit === undefined || limit <= 0) continue;
          const used = numLike(r[bKey]) ?? 0;
          const fraction = used / limit;
          if (best === undefined || fraction > best.fraction) best = { limit, used, fraction, ttl: numLike(r[tKey]), status: numLike(r[sKey]) };
        }
        return best;
      };
      const interval = worstBy("current_interval_total_count", "current_interval_usage_count", "remains_time", "current_interval_status");
      const weekly = worstBy("current_weekly_total_count", "current_weekly_usage_count", "weekly_remains_time", "current_weekly_status");
      const exhausted = interval?.status === 2 || weekly?.status === 2;
      const windows = [];
      if (interval && interval.status !== 3) {
        windows.push({
          kind: "session",
          used: interval.used,
          limit: interval.limit,
          ...(Number.isFinite(interval.ttl) ? { resetsAt: new Date(now + interval.ttl * 1000).toISOString() } : {}),
        });
      }
      if (weekly && weekly.status !== 3) {
        windows.push({
          kind: "weekly",
          used: weekly.used,
          limit: weekly.limit,
          ...(Number.isFinite(weekly.ttl) ? { resetsAt: new Date(now + weekly.ttl * 1000).toISOString() } : {}),
        });
      }
      const norm = normalizeWindows(windows);
      return {
        currency: undefined,
        unlimited: allUnlimited === true ? true : undefined,
        total: undefined,
        used: interval?.used,
        isAvailable: !exhausted,
        ...(norm ? { windows: norm } : {}),
      };
    },
  },

  /**
   * 智谱 GLM / Z.ai Coding Plan 订阅 + 余额：
   * `GET {origin}/api/monitor/usage/quota/limit`，Bearer provider apiKeyEnv。
   * 响应 `{code,msg,data:{limits:[{type,unit,number,usage?,currentValue?,
   * remaining?,percentage,nextResetTime?(毫秒)}],level}}`（huswim/glm-coding-
   * plan-usage 解析）。每条 limit 视为一个窗口：type 关键词映射 kind；
   * number>0 时输出 已用/限额，否则退化为百分比窗口。
   */
  "zhipu-coding": {
    label: DEFAULT_LABELS["zhipu-coding"],
    envelope(body) {
      if (body && typeof body === "object" && body.success === false) {
        return { status: body.code ?? "error", message: typeof body.msg === "string" ? body.msg : "quota 接口拒绝" };
      }
      return undefined;
    },
    async read({ get }) {
      const body = await get("/api/monitor/usage/quota/limit");
      const data = body?.data;
      const items = Array.isArray(data?.limits) ? data.limits : null;
      if (items === null) throw fail("shape", "quota 接口缺少 limits 列表");
      const windows = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const kind = kindForZhipuType(item.type);
        const limit = numLike(item.number);
        const percent = clampPercent(item.percentage);
        if ((limit === undefined || limit <= 0) && percent === undefined) continue;
        windows.push({
          kind,
          ...(limit !== undefined && limit > 0
            ? { limit, used: item.usage !== undefined ? numLike(item.usage) : numLike(item.currentValue) ?? 0 }
            : {}),
          ...(percent !== undefined ? { usedPercent: percent } : {}),
          ...(item.nextResetTime !== undefined && item.nextResetTime !== null
            ? { resetsAt: new Date(numLike(item.nextResetTime)).toISOString() }
            : {}),
        });
      }
      const norm = normalizeWindows(windows);
      if (!norm || norm.length === 0) throw fail("shape", "quota 接口没有可展示的限额项");
      return { windows: norm, total: undefined, level: typeof data.level === "string" ? data.level : undefined, isAvailable: true };
    },
  },
};

/**
 * Backward-compatible alias. The contract name is `SCHEMES` (PRD 6.1); an
 * earlier draft called this registry `READERS`, so both spellings stay valid
 * for anything that was written against the old one.
 */
export const READERS = SCHEMES;

/** The money a Sub2API key has consumed, for the unlimited "已用" line (PRD 5.2). */
function sub2apiUsed(body) {
  // Prefer the gateway's own cumulative total; this is the most direct answer.
  const usage = body?.usage?.total;
  const fromUsage = toNumber(usage?.cost ?? usage?.actual_cost);
  if (fromUsage !== undefined) return fromUsage;
  // Otherwise fall back to the subscription period amounts. These OVERLAP (a
  // day sits inside a week, a week inside a month), so summing them counts the
  // same tokens twice. Prefer the longest period that reported a figure: it is
  // the single closest number to the account's actual spend, without inventing
  // an arithmetic the gateway never stated.
  const sub = body?.subscription;
  if (sub === null || typeof sub !== "object") return undefined;
  for (const value of [sub.monthly_usage_usd, sub.weekly_usage_usd, sub.daily_usage_usd]) {
    const parsed = toNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** Map Sub2API's duration-named rate-limit windows to our display kinds. */
const SUB2API_WINDOW_KINDS = new Map([
  ["5h", "session"],
  ["1d", "daily"],
  ["7d", "weekly"],
]);

/** One week after a window opened, which is when Sub2API rolls it over. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sub2API's per-key rate-limit windows (`rate_limits[]`).
 *
 * `reset_at` is only present while the window is still open — once it lapses
 * the gateway expects the next request to open a fresh one, so there is nothing
 * to show. A window with no positive limit is not capped, so it produces no
 * window at all.
 */
function sub2apiRateLimits(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const kind = SUB2API_WINDOW_KINDS.get(entry?.window);
    if (kind === undefined) continue;
    const limit = toNumber(entry.limit);
    if (limit === undefined || limit <= 0) continue;
    out.push({
      kind,
      used: toNumber(entry.used),
      limit,
      ...(entry.reset_at === undefined || entry.reset_at === null ? {} : { resetsAt: entry.reset_at }),
    });
  }
  return out;
}

/**
 * Sub2API's subscription periods (`subscription`).
 *
 * A limit that is null means the group does not cap that period, so it produces
 * no window (an uncapped allowance has nothing to draw a bar against). The
 * weekly window resets one week after it opened, reported as the absolute
 * instant `weekly_window_start + 7 days`.
 */
function sub2apiPeriods(subscription) {
  if (subscription === null || typeof subscription !== "object") return [];
  const openedAt = Date.parse(subscription.weekly_window_start ?? "");
  const rows = [
    { kind: "daily", used: subscription.daily_usage_usd, limit: subscription.daily_limit_usd },
    {
      kind: "weekly",
      used: subscription.weekly_usage_usd,
      limit: subscription.weekly_limit_usd,
      ...(Number.isNaN(openedAt) ? {} : { resetsAt: new Date(openedAt + WEEK_MS).toISOString() }),
    },
    { kind: "monthly", used: subscription.monthly_usage_usd, limit: subscription.monthly_limit_usd },
  ];
  const out = [];
  for (const row of rows) {
    const limit = toNumber(row.limit);
    if (limit === undefined || limit <= 0) continue;
    out.push({ kind: row.kind, used: toNumber(row.used), limit, ...(row.resetsAt ? { resetsAt: row.resetsAt } : {}) });
  }
  return out;
}

/**
 * Clean and order a scheme's windows.
 *
 * Unusable entries are dropped rather than rendered as blanks, one kind appears
 * at most once (the first wins, so a reader can list its best source first),
 * and the order is `WINDOW_ORDER` regardless of the order they arrived in — two
 * accounts of the same plan must not lay their rows out differently. Absent
 * (not `[]`) when there is nothing, so a card never claims to be a subscription
 * with no windows.
 */
export function normalizeWindows(list) {
  if (!Array.isArray(list)) return undefined;
  const byKind = new Map();
  for (const entry of list) {
    if (entry && !byKind.has(entry.kind)) byKind.set(entry.kind, entry);
  }
  if (byKind.size === 0) return undefined;
  return WINDOW_ORDER.filter((kind) => byKind.has(kind)).map((kind) => byKind.get(kind));
}

/** Turn an already-built error into the uniform failure shape. */
function failureFrom(error, provider, label) {
  const code = error?.code;
  const message = typeof error?.message === "string" ? error.message : undefined;
  if (typeof code === "string") {
    return {
      ok: false,
      provider,
      label,
      error: code.slice(0, 160),
      ...(message && message !== code ? { message: message.slice(0, 200) } : {}),
      // 429 的 retry-after（毫秒）：编排层据此定负缓存时长（实测站点封 20 分钟）
      ...(typeof error?.retryAfterMs === "number" && error.retryAfterMs > 0
        ? { retryAfterMs: Math.min(Math.round(error.retryAfterMs), 24 * 3600 * 1000) }
        : {}),
    };
  }
  const name = error?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return { ok: false, provider, label, error: "timeout", message: "请求超时（15 秒）" };
  }
  return {
    ok: false,
    provider,
    label,
    error: "unreachable",
    message: String(error?.message || error).slice(0, 200),
  };
}

/**
 * Read one provider account.
 *
 * Pure from the caller's perspective: every external effect (the HTTP fetch)
 * is injectable, so a test can stub `fetch` with fixture-shaped responses and
 * never touch the network. The credential is supplied already-resolved as
 * `credential`, because resolving it is the orchestrator's job (via the DSH
 * credentials seam, so the key never rides a query string or a log line).
 *
 * @param options - `{ type, baseUrl?, credential?, label?, credentialName?,
 *   fetch?, timeoutMs?, maxBytes?, userToken?, userId?, scaleFallback?,
 *   guard? }`. `type` is one of `SCHEMES`. `credential` is the
 *   already-resolved key text; empty/absent is reported as `no-credential`
 *   (a friendly fact, not a fault). `apiKey` is accepted as a
 *   backward-compatible alias for `credential`. `userToken`/`userId` are the
 *   already-resolved New API user-balance credentials (`/api/user/self`).
 *   `scaleFallback` is the host-cached `{ scale, siteCurrency }` from the
 *   last successful `/api/status` read of this origin, used when the status
 *   endpoint fails (限流/网络抖动) so quota integers are still converted to
 *   money instead of being displayed raw. `guard` is an optional
 *   `(origin) => boolean` upstream query gate checked before every request;
 *   a refusal fails the read with `rate-limited` (see
 *   {@link createRateLimiter}).
 * @returns the uniform account shape.
 */
export async function readAccount(options = {}) {
  const { type, baseUrl, label, credentialName, maxBytes = MAX_BYTES, guard } = options;
  const apiKey = options.credential ?? options.apiKey;
  const timeoutMs = options.timeoutMs ?? 15_000;
  // 用户令牌规范化：粘贴值允许带 "Bearer " 前缀（与平台令牌一致的容错），
  // 剥掉前缀并去空白，避免 Authorization 头出现双 Bearer 被站点 401。
  const userTokenRaw = options.userToken;
  const userToken =
    typeof userTokenRaw === "string" ? userTokenRaw.replace(/^Bearer\s+/i, "").trim() : userTokenRaw;
  const userId = options.userId;
  const scaleFallback = options.scaleFallback;

  const scheme = SCHEMES[type];
  if (scheme === undefined) {
    return { ok: false, provider: type, label: label || type, error: "shape", message: `未知的 provider 类型: ${type}` };
  }
  const fallbackLabel = label || scheme.label;

  const origin = normalizeOrigin(baseUrl ?? scheme.defaultOrigin);
  if (origin === undefined) {
    return { ok: false, provider: type, label: fallbackLabel, error: "shape", message: "baseUrl 不是合法的 http(s) 地址且不含账号密码成分" };
  }

  if (typeof apiKey !== "string" || apiKey === "") {
    const which = credentialName || DEFAULT_CREDENTIALS[type];
    return { ok: false, provider: type, label: fallbackLabel, error: "no-credential", message: `未配置 ${which}` };
  }

  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now();

  /**
   * One fenced GET: an upstream query gate, manual redirects (cross-origin
   * abort), a per-request 15s timeout, a 256 KB body ceiling, and the scheme's
   * envelope check.
   *
   * @param path - origin-relative path, e.g. `/user/balance`.
   * @param opts - `{ anonymous }` sends no Authorization at all (used to read
   *   a public status route); `{ bearer }` replaces the Authorization value
   *   (the New API user token on `/api/user/self`); `{ headers }` adds extra
   *   headers (the `New-Api-User` user id). The key always rides the
   *   Authorization header, never a query string.
   */
  const get = async (path, opts = {}) => {
    // 查询限流（实测站点 60 次/20 分钟，等效 15 次/5 分钟）：计数在发请求
    // 之前，超限时直接拒绝，不把 429 当数据解析。
    if (guard !== undefined && !guard(origin)) {
      throw fail("rate-limited", "站点查询频率超限（15 次 / 5 分钟），请稍后重试");
    }
    const url = new URL(path, origin).href;
    const signal = AbortSignal.timeout(timeoutMs);
    const headers = { ...(opts.headers ?? {}), accept: "application/json" };
    if (!opts.anonymous) headers.authorization = `Bearer ${opts.bearer ?? apiKey}`;
    const response = await followRedirects(doFetch, url, { headers, redirect: "manual", signal });
    if (!response.ok) {
      const httpErr = httpError(response.status);
      // 429 时带上站点的 retry-after（秒），编排层用真实封禁时长做负缓存
      if (response.status === 429 && typeof response.headers?.get === "function") {
        const ra = parseInt(response.headers.get("retry-after"), 10);
        if (Number.isFinite(ra) && ra > 0) httpErr.retryAfterMs = ra * 1000;
      }
      throw httpErr;
    }

    const text = await readCapped(response, maxBytes);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw fail("invalid-response", "响应不是合法 JSON");
    }

    // Run before the reader sees it, so a refusal can never be mistaken for a
    // response whose fields all happen to be missing.
    const refusal = scheme.envelope?.(body);
    if (refusal === undefined) return body;
    const message = refusal.message ?? `upstream-${refusal.status ?? "error"}`;
    throw fail(`upstream-${message}`, message);
  };

  try {
    const read = await scheme.read({ origin, get, now, userToken, userId, scaleFallback });
    if (!read || typeof read !== "object") throw fail("shape", "reader 返回异常");
    return { ok: true, provider: type, label: fallbackLabel, ...read };
  } catch (error) {
    return failureFrom(error, type, fallbackLabel);
  }
}

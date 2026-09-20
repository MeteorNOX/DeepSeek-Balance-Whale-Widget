// 小鲸鱼设置 · 余额与模型路由配置模块
//
// 顶部按「余额配置 / 各客户端」切换列表，各列表**数据完全独立**：
// - 「余额配置」列表只维护余额所需字段（名称 / API Key / 请求地址），可「应用」为
//   全局余额数据源；在线余额与用量接口是**内置**的（按供应商标识匹配），无需配置；
// - 每个客户端列表维护该客户端的模型路由，「应用」会把配置合并写入客户端真实配置文件。
//
// 「令牌用量统计（实验性功能）」开启后，余额配置表单才出现「平台令牌」——它用于按
// 官网用量接口取逐日账单；关闭时表单里不存在任何用量查询/统计配置项。
//
// 依赖：
// - config.js 暴露的 window.CFG（callApi / notify / showConfirm / refreshBalance /
//   currencySymbol / createPicker / closePickers / tokenUsageEnabled），以复用统一提示
//   体系、错误处理与自定义下拉选择器（界面内不再出现原生 select）；
// - assets/vendor/echarts.min.js（用量趋势图）；
// - assets/presets/*.json（cc-switch 预设目录）与 assets/logos/*（logo 素材）。

(function () {
  "use strict";

  var CFG = window.CFG;
  if (!CFG) return;

  // ===== 常量 =====

  /** 「余额配置」列表的保留 scope 名（与后端一致）。 */
  var BALANCE_SCOPE = "balance";
  var LOGO_BASE = "../assets/logos/";
  var PRESET_BASE = "../assets/presets/";
  /** API 格式白名单（与后端 `supplier_service::API_FORMATS` 一致）。 */
  var API_FORMATS = [
    { value: "anthropic", label: "Anthropic" },
    { value: "openai", label: "OpenAI Chat" },
    { value: "openai-responses", label: "OpenAI Responses" },
    { value: "gemini", label: "Gemini" },
  ];
  /** 认证字段白名单（与后端 `AUTH_FIELDS` 一致）。 */
  var AUTH_FIELDS = [
    { value: "x-api-key", label: "x-api-key" },
    { value: "authorization", label: "Authorization" },
    { value: "api-key", label: "api-key" },
  ];
  /** cc-switch 预设的 apiFormat 取值 → 本项目白名单值。 */
  var PRESET_FORMAT_MAP = {
    anthropic: "anthropic",
    openai: "openai",
    openai_chat: "openai",
    openai_responses: "openai-responses",
    gemini_native: "gemini",
  };
  var CATEGORY_LABELS = {
    official: "官方",
    cn_official: "国内官方",
    aggregator: "聚合平台",
    third_party: "第三方",
    cloud_provider: "云服务商",
    custom: "自定义",
  };
  /**
   * 中文检索别名：cc-switch 的预设名一律是英文或拼音，中文界面下直接搜「小米」「胜算云」
   * 会一无所获。这里按「常用中文叫法」补一层检索别名——**只影响搜索命中**，
   * 不改动预设名称与任何落盘数据；命中是叠加的，不会挤掉原本能搜到的结果。
   */
  var PRESET_ALIASES = [
    { terms: ["小米", "米mo", "mimo"], match: /xiaomi|mimo/i },
    { terms: ["胜算云"], match: /shengsuanyun/i },
    { terms: ["月之暗面", "月暗", "moonshot"], match: /kimi|moonshot/i },
    { terms: ["深度求索", "深度搜索"], match: /deepseek/i },
    { terms: ["硅基流动"], match: /siliconflow/i },
    { terms: ["智谱", "glm"], match: /zhipu|glm/i },
    {
      terms: ["豆包", "火山", "方舟"],
      match: /doubao|huoshan|volcengine|byteplus/i,
    },
    { terms: ["腾讯", "混元"], match: /tencent|hunyuan/i },
    {
      terms: ["阿里", "通义", "百炼", "千问"],
      match: /qwen|qianwen|dashscope|aliyun/i,
    },
    { terms: ["百度", "文心"], match: /baidu|wenxin/i },
    { terms: ["阶跃星辰", "阶跃"], match: /stepfun/i },
    { terms: ["英伟达"], match: /nvidia/i },
    { terms: ["亚马逊", "bedrock"], match: /aws|amazon|bedrock/i },
    { terms: ["微软"], match: /azure|microsoft/i },
    { terms: ["优刻得", "ucloud"], match: /ucloud/i },
    { terms: ["七牛"], match: /qiniu/i },
    { terms: ["无问芯穹"], match: /infini/i },
    { terms: ["开放路由"], match: /openrouter/i },
  ];
  /** 客户端 scope 的预设来源文件；未登记的客户端回落到通用网关。 */
  var CLIENT_PRESET_FILE = { claude: "claude.json", codex: "codex.json" };
  /**
   * 兜底预设来源：预设清单（`presets/manifest.json`）读取失败时使用。
   *
   * 「余额配置」列表与客户端无关，因此收录 cc-switch **全部**客户端的预设
   * （同一供应商标识去重后取先到的一份），保证 DeepSeek / 阶跃 / 小米MiMo 等
   * 任一家的主流供应商都能被搜到。
   */
  var FALLBACK_BALANCE_PRESET_FILES = [
    "claude.json",
    "codex.json",
    "gemini.json",
    "grokbuild.json",
    "openclaw.json",
    "opencode.json",
    "hermes.json",
    "universal.json",
  ];
  /** 卡片图标（复用 cc-switch 同源 lucide 素材）。 */
  var ICONS = {
    edit: "edit.svg",
    test: "activity.svg",
    usage: "chart-column.svg",
    remove: "trash-2.svg",
  };
  /** 加载态图标：图标按钮「处理中」时替换为该图标并叠加旋转动画。 */
  var LOADING_ICON = "loading.svg";

  /**
   * 详细账单的日期筛选项（与官网用量页的筛选项一致）。
   *
   * `bucket` 决定柱状图的聚合步长：`hour` 按小时、`day` 按天、`month` 按月。
   * `labelStep` 决定横轴标签的疏密（每 N 个刻度显示一个），与官网保持一致：
   * 近 7 天 3 天一个、近 30 天 / 上月 / 自定义 10 天一个、本月 7 天一个、
   * 近一年一季度（3 个月）一个；今天 / 昨天固定显示 00:00、08:00、15:00、23:00。
   */
  var USAGE_RANGES = [
    { value: "today", label: "今天", bucket: "hour", labelStep: 1 },
    { value: "yesterday", label: "昨天", bucket: "hour", labelStep: 1 },
    { value: "last7", label: "近7天", bucket: "day", labelStep: 3 },
    { value: "last30", label: "近30天", bucket: "day", labelStep: 10 },
    { value: "lastYear", label: "近一年", bucket: "month", labelStep: 3 },
    { value: "thisMonth", label: "本月", bucket: "day", labelStep: 7 },
    { value: "lastMonth", label: "上月", bucket: "day", labelStep: 10 },
    { value: "custom", label: "自定义", bucket: "day", labelStep: 10 },
  ];

  /** 按小时画图时固定展示的横轴节点（与官网一致）。 */
  var HOUR_LABELS = ["00", "08", "15", "23"];

  /** 打开面板时的默认筛选口径（产品默认：今天）。 */
  var DEFAULT_USAGE_RANGE = "today";

  /** 自定义日期区间最多可选的天数（含首尾：01 日 → 30 日共 30 天）。 */
  var CUSTOM_MAX_DAYS = 30;

  /** 日历浮层与触发下拉之间的垂直间距 / 与视口边缘的安全余量（与下拉浮层一致）。 */
  var CALENDAR_GAP = 6;
  var CALENDAR_MARGIN = 8;

  /** 详细账单固定展示的日期范围：最近一年。 */
  var BILL_DAYS = 365;

  /** 「支持1M」在模型名后的能力标记（与后端 `supplier_service::ONE_M_MARKER` 一致）。 */
  var ONE_M_MARKER = "[1M]";
  /** Codex 勾选「支持1M」时写入的上下文窗口与压缩阈值（与后端渲染约定一致）。 */
  var CODEX_1M_WINDOW = 1000000;
  var CODEX_1M_COMPACT = 900000;
  /** 模型映射行未填上下文窗口时展示的默认值（与后端目录默认窗口一致）。 */
  var CATALOG_DEFAULT_WINDOW = 128000;
  /** 获取模型列表等网络按钮的提示文案（与后端 model_service 的错误文案一致）。 */
  var MSG_INVALID_API_KEY = "API Key无效或无权限";

  // ===== DOM =====
  var el = function (id) {
    return document.getElementById(id);
  };
  var supplierCardEl = el("supplierCard");
  var scopeBalanceEl = el("scopeBalance");
  var scopeClientsEl = el("scopeClients");
  var addSupplierEl = el("addSupplier");
  var supplierListEl = el("supplierList");
  var supplierEmptyEl = el("supplierEmpty");
  var supplierOverlayEl = el("supplierOverlay");
  var presetModalEl = el("presetModal");
  var presetTitleEl = el("presetTitle");
  var presetSearchEl = el("presetSearch");
  var presetListEl = el("presetList");
  var presetEmptyEl = el("presetEmpty");
  var presetCustomEl = el("presetCustom");
  var presetCancelEl = el("presetCancel");
  var formModalEl = el("supplierFormModal");
  var formTitleEl = el("supplierFormTitle");
  var formScrollEl = formModalEl.querySelector(".form-scroll");
  var supNameEl = el("supName");
  var supNameErrorEl = el("supNameError");
  var supApiKeyEl = el("supApiKey");
  var supApiKeyErrorEl = el("supApiKeyError");
  var supUsageTokenEl = el("supUsageToken");
  var supUsageTokenRowEl = el("supUsageTokenRow");
  var supToggleKeyEl = el("supToggleKey");
  var supToggleTokenEl = el("supToggleToken");
  var supKeyLinkRowEl = el("supKeyLinkRow");
  var supKeyLinkEl = el("supKeyLink");
  var supBaseUrlEl = el("supBaseUrl");
  var supBaseUrlErrorEl = el("supBaseUrlError");
  var supNoteEl = el("supNote");
  var supNoteRowEl = el("supNoteRow");
  var supApiFormatRowEl = el("supApiFormatRow");
  var supAuthFieldRowEl = el("supAuthFieldRow");
  var supRoutingSectionEl = el("supRoutingSection");
  var supRoutingActionsEl = el("supRoutingActions");
  var supModelSlotsEl = el("supModelSlots");
  var supModelCatalogEl = el("supModelCatalog");
  var supCatalogActionsEl = el("supCatalogActions");
  var supCatalogRowsEl = el("supCatalogRows");
  var supSwitchesEl = el("supSwitches");
  var supOptionsEl = el("supOptions");
  var supEditCommonEl = el("supEditCommon");
  var commonConfigPageEl = el("commonConfigPage");
  var commonConfigTextEl = el("commonConfigText");
  var commonConfigErrorEl = el("commonConfigError");
  var commonConfigSaveEl = el("commonConfigSave");
  var commonConfigCancelEl = el("commonConfigCancel");
  var commonConfigExtractEl = el("commonConfigExtract");
  var supPreviewSectionEl = el("supPreviewSection");
  var supPreviewTabsEl = el("supPreviewTabs");
  var supPreviewFilesEl = el("supPreviewFiles");
  var supplierSaveEl = el("supplierSave");
  var supplierCancelEl = el("supplierCancel");
  var supplierToggleEl = el("supplierToggle");
  var supplierHeadEl = supplierCardEl
    ? supplierCardEl.querySelector(".supplier-head")
    : null;
  var usageOverlayEl = el("usageOverlay");
  var usageModalEl = el("usageModal");
  var usageTitleEl = el("usageTitle");
  var usageSourceEl = el("usageSource");
  var usageRangePickerEl = el("usageRangePicker");
  var usageCalendarEl = el("usageCalendar");
  var usageCalendarInnerEl = el("usageCalendarInner");
  var usageChartEl = el("usageChart");
  var usageMoneyEmptyEl = el("usageMoneyEmpty");
  var usageTokenChartsEl = el("usageTokenCharts");
  var usageTokenEmptyEl = el("usageTokenEmpty");
  var usageDailyListEl = el("usageDailyList");
  var usageCloseEl = el("usageClose");

  // ===== 自定义下拉（与「音效」「挂件主体」同一种样式）=====
  //
  // 表单内的原生 select 已全部替换为 config.js 的自定义选择器。列表浮层由它统一挂到
  // <body> 并贴合触发按钮，因此展开 / 收起不占文档流，也不会被 .form-scroll 这类
  // 滚动容器裁掉（详见 config.js 的 createPicker）。
  var pickers = {
    apiFormat: createPickerFor("supApiFormatPicker"),
    authField: createPickerFor("supAuthFieldPicker"),
  };

  function createPickerFor(rootId) {
    var root = el(rootId);
    if (!root || !CFG.createPicker) return null;
    return CFG.createPicker(root);
  }

  // ===== 状态 =====
  var clients = [];
  var scope = BALANCE_SCOPE;
  var cards = [];
  var presetCache = {};
  var editing = null; // { slug }：非空表示编辑既有供应商
  var editingMeta = null; // 编辑时保留的预设元数据（logo / 分类 / 官网 / Key 页）
  var formClient = null; // 当前 scope 对应的客户端描述；余额配置为 null
  var usageChart = null;
  /** 模型 Token 柱状图的 ECharts 实例：模型名 → 实例（模型集合变了才重建）。 */
  var usageTokenCharts = {};
  var usageReport = null;
  /**
   * 本次打开面板是否已经播过「柱子上升」的入场动画。
   *
   * 取数是两步（先本地缓存立刻出图、再让在线结果覆盖），一步一次重绘。若每次都播动画，
   * 用户会看到柱子上升两遍；反过来金额图因为先画了一版空图，第二次反而没有入场动画。
   * 因此：每次打开面板复位为 false，**第一次真的画出数据**时播一次，之后的重绘直接换值。
   */
  var usageAnimated = false;
  /** 当前面板对应的供应商 `{ scope, slug }`：日期筛选联动取数时要用它。 */
  var usageTarget = null;
  /** 正在按所选时间段重新取数（界面上给一行提示，避免大区间让人以为卡死）。 */
  var usageLoading = false;
  /** 日期筛选联动取数的防抖句柄：连点筛选不会打出多次请求。 */
  var usageRefreshTimer = null;
  /** 全局颜色变化后的重绘防抖句柄（拖色相滑杆会连续触发）。 */
  var paletteRedrawTimer = null;
  /** 详细账单的日期筛选（取值见 USAGE_RANGES）；`custom` 时另存区间。 */
  var usageRange = DEFAULT_USAGE_RANGE;
  var usageCustom = { start: "", end: "" };
  /** 取数序号：每次打开面板自增，用于丢弃迟到的旧响应（换供应商 / 关面板后）。 */
  var usageSeq = 0;
  /** 自建日历的临时选择：点第一下选起点，点第二下选终点（最多 30 天）。 */
  var calendar = { month: "", start: "", end: "" };
  var usageRangePicker = null;
  var busy = false;
  var routingOptionPickers = {}; // 模型路由「枚举选项」的下拉实例（每次渲染按客户端重建）
  /** 每行「实际请求模型」的模型下拉实例（取到模型列表后才创建）。 */
  var modelRowPickers = [];
  /** 「获取模型列表」拿到的模型名；空数组表示尚未取到（此时不显示下拉按钮）。 */
  var fetchedModels = [];
  /** 取列表请求的并发保护：连点不会打出多次请求。 */
  var fetchingModels = false;
  /** 当前预览的文件列表与正在查看的下标（顶部文件选择框组用）。 */
  var previewFiles = [];
  var previewActive = 0;

  // ===== 工具 =====

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * 取一条主题色变量的**具体颜色值**。
   *
   * 图表（ECharts）把颜色直接写进 canvas，认不出 `var(--x)` 这种写法，因此必须在这里
   * 解析成具体色值；换主题后重绘一次（每次打开用量页都会重绘）即可拿到新配色。
   */
  function themeColor(name, fallback) {
    var value = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return value || fallback;
  }

  /** logo 字段既可能是不带后缀的资源名，也可能是文件名，统一补全为可访问路径。 */
  function logoUrl(logo) {
    var name = String(logo || "").trim();
    if (!name) return "";
    if (/^(https?:|data:|\.\.\/)/.test(name)) return name;
    return LOGO_BASE + (name.indexOf(".") === -1 ? name + ".svg" : name);
  }

  /** 加载失败时隐藏图片，避免出现破图；卡片与列表均复用。 */
  function bindLogoFallback(img) {
    img.addEventListener("error", function () {
      img.style.display = "none";
    });
  }

  /**
   * logo 清单（`assets/logos/manifest.json`）：图标名 → 素材文件名。
   *
   * 老配置迁移出来的供应商没有 logo 字段，此时按 slug 在清单里查一次，
   * 命中才拼路径——避免为不存在的素材发出请求（缺图会污染控制台且毫无收益）。
   */
  var logoManifest = null;

  function loadLogoManifest() {
    if (logoManifest) return Promise.resolve(logoManifest);
    return fetch(LOGO_BASE + "manifest.json")
      .then(function (res) {
        return res.ok ? res.json() : {};
      })
      .then(function (map) {
        logoManifest = map || {};
        return logoManifest;
      })
      .catch(function () {
        logoManifest = {};
        return logoManifest;
      });
  }

  function manifestLogo(slug) {
    if (!logoManifest) return "";
    var file = logoManifest[String(slug || "")];
    return file ? LOGO_BASE + file : "";
  }

  function iconSpan(name, className) {
    return (
      '<span class="icon ' +
      (className || "") +
      '" style="--icon: url(\'../assets/icons/' +
      name +
      "')\"></span>"
    );
  }

  function activeClientIds() {
    return clients.map(function (c) {
      return c.id;
    });
  }

  function clientById(id) {
    for (var i = 0; i < clients.length; i += 1) {
      if (clients[i].id === id) return clients[i];
    }
    return null;
  }

  function scopeLabel(target) {
    if (target === BALANCE_SCOPE) return "余额配置";
    var c = clientById(target);
    return c ? c.name : target;
  }

  /**
   * Codex 的「模型映射」会写进 `model_catalog_json` 指向的目录文件，而它只在启动时读一次：
   * 配置生效后必须提醒用户重启 Codex，`/model` 菜单里才会出现这些模型。
   */
  function restartHint(target) {
    return target === "codex" ? "，重启 Codex 以刷新模型列表" : "";
  }

  function errText(err) {
    if (!err) return "";
    if (typeof err === "string") return err;
    return err.message || String(err);
  }

  /**
   * 金额显示：带币种符号并保留两位小数。
   *
   * 取整方式与官网一致——**截断**而不是四舍五入：官网用量页对「55.99799492」显示
   * `55.99`（四舍五入会得到 `56.00`）。账单要与官网逐日数字对齐，就必须用同一种规则；
   * `+1e-9` 只是消除浮点误差（`13.13 * 100` 会得到 `1312.9999…`）。
   */
  function money(value, currency) {
    var symbol =
      CFG.currencySymbol(currency) || (currency ? currency + " " : "￥");
    var num = Number(value);
    if (!isFinite(num)) num = 0;
    var cents =
      num < 0 ? Math.ceil(num * 100 - 1e-9) : Math.floor(num * 100 + 1e-9);
    return symbol + (cents / 100).toFixed(2);
  }

  /**
   * 是否真的产生了消费：金额截断到「分」之后仍不为 0。
   *
   * 与 money() 用同一套口径——官网按天桶取数时，窗口末端那一格会带出
   * 一个小到看不见的金额（< 0.01），既不该进账单列表（否则会出现「0.00 元」的记录），
   * 也不该被当成「有消费」。
   */
  function hasSpend(value) {
    var num = Number(value);
    return isFinite(num) && Math.floor(Math.abs(num) * 100 + 1e-9) >= 1;
  }

  function todayKey() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  // ===== 列表切换 =====

  function renderScopeTabs() {
    var html = "";
    clients.forEach(function (c) {
      // 客户端标识图标来自应用自带的 icons 目录（claude.svg / openai.svg），
      // 与「供应商 logo」用的是 cc-switch 的 logos 素材，两者来源不同，不可混用。
      var logo = c.logo
        ? "../assets/icons/" +
          (String(c.logo).indexOf(".") === -1 ? c.logo + ".svg" : c.logo)
        : "";
      html +=
        '<button type="button" class="scope-tab scope-client" data-scope="' +
        escapeHtml(c.id) +
        '" title="' +
        escapeHtml(c.name) +
        '">' +
        (logo
          ? '<img class="scope-logo" src="' + escapeHtml(logo) + '" alt="">'
          : "") +
        '<span class="scope-text"' +
        (logo ? " hidden" : "") +
        ">" +
        escapeHtml(c.name) +
        "</span>" +
        "</button>";
    });
    scopeClientsEl.innerHTML = html;
    scopeClientsEl.querySelectorAll(".scope-client").forEach(function (btn) {
      var img = btn.querySelector("img");
      var text = btn.querySelector(".scope-text");
      if (img) {
        img.addEventListener("error", function () {
          img.style.display = "none";
          if (text) text.hidden = false;
        });
      }
      btn.addEventListener("click", function () {
        switchScope(btn.dataset.scope);
      });
    });
    scopeBalanceEl.classList.toggle("active", scope === BALANCE_SCOPE);
  }

  function switchScope(next) {
    if (next === scope) return;
    scope = next;
    formClient = clientById(scope);
    if (CFG.closePickers) CFG.closePickers();
    scopeBalanceEl.classList.toggle("active", scope === BALANCE_SCOPE);
    scopeClientsEl.querySelectorAll(".scope-client").forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.scope === scope);
    });
    renderList();
  }

  // ===== 供应商卡片列表 =====

  function renderList() {
    supplierEmptyEl.textContent =
      scope === BALANCE_SCOPE
        ? "目前没有任何供应商余额配置"
        : "目前没有任何供应商模型路由配置";
    CFG.callApi("list_suppliers", { scope: scope }, { silent: true })
      .then(function (list) {
        cards = Array.isArray(list) ? list : [];
        renderCards();
        // logo 清单是异步的：先出卡片，清单就绪后再补图标，避免列表等待网络。
        loadLogoManifest().then(renderCards);
      })
      .catch(function (err) {
        cards = [];
        renderCards();
        CFG.notify("error", "读取供应商列表失败：" + errText(err));
      });
  }

  function renderCards() {
    supplierEmptyEl.hidden = cards.length > 0;
    supplierListEl.innerHTML = "";
    cards.forEach(function (card) {
      supplierListEl.appendChild(buildCard(card));
    });
  }

  /** 卡片图标按钮：`data-icon` 记录原始图标，加载态结束后据此还原。 */
  function cardIconButton(action, title, icon, extraClass) {
    return (
      '<button type="button" class="icon-btn small' +
      (extraClass || "") +
      '" data-act="' +
      action +
      '" data-icon="' +
      icon +
      '" title="' +
      title +
      '">' +
      iconSpan(icon) +
      "</button>"
    );
  }

  function buildCard(card) {
    var node = document.createElement("div");
    node.className = "supplier-item" + (card.active ? " active" : "");
    var logo = logoUrl(card.logo) || manifestLogo(card.slug);
    node.innerHTML =
      '<div class="supplier-logo-wrap">' +
      (logo
        ? '<img class="supplier-logo" src="' + escapeHtml(logo) + '" alt="">'
        : "") +
      "</div>" +
      '<div class="supplier-meta">' +
      '<div class="supplier-name-row">' +
      '<span class="supplier-name">' +
      escapeHtml(card.name) +
      "</span>" +
      (card.active ? '<span class="supplier-badge">启用中</span>' : "") +
      "</div>" +
      // 官网 / 请求地址：直接展示链接地址（不带前缀），悬浮显示下划线，点击用默认浏览器打开。
      (card.baseUrl
        ? '<div class="supplier-sub"><a class="supplier-link" href="' +
          escapeHtml(card.baseUrl) +
          '" data-url="' +
          escapeHtml(card.baseUrl) +
          '">' +
          escapeHtml(card.baseUrl) +
          "</a></div>"
        : "") +
      "</div>" +
      '<div class="supplier-actions">' +
      '<button type="button" class="sup-apply" data-act="apply">' +
      (card.active ? "已应用" : "应用") +
      "</button>" +
      cardIconButton("edit", "编辑", ICONS.edit, "") +
      cardIconButton("test", "测试连接", ICONS.test, "") +
      // 账单只属于余额配置：客户端列表只做模型路由，没有余额与用量。
      (scope === BALANCE_SCOPE
        ? cardIconButton("usage", "详细账单", ICONS.usage, "")
        : "") +
      cardIconButton("remove", "删除", ICONS.remove, " danger") +
      "</div>";

    var img = node.querySelector(".supplier-logo");
    if (img) bindLogoFallback(img);
    var link = node.querySelector(".supplier-link");
    if (link) {
      link.addEventListener("click", function (e) {
        e.preventDefault();
        openExternal(link.dataset.url, "打开供应商官网失败");
      });
    }
    node
      .querySelector(".supplier-actions")
      .addEventListener("click", function (e) {
        var btn = e.target.closest("button[data-act]");
        if (!btn) return;
        handleCardAction(btn.dataset.act, card, btn);
      });
    return node;
  }

  /** 用系统默认浏览器打开链接：失败以 toast 提示（与其余操作反馈保持同一套样式）。 */
  function openExternal(url, errorPrefix) {
    if (!url) return;
    CFG.callApi("open_external", { url: url }, { silent: true }).catch(
      function (err) {
        CFG.notify("error", errorPrefix + "：" + errText(err));
      },
    );
  }

  function handleCardAction(action, card, btn) {
    if (busy) return;
    if (action === "apply") return applySupplier(card, btn);
    if (action === "edit") return openEditForm(card);
    if (action === "test") return testSupplier(card, btn);
    if (action === "usage") return openUsage(card);
    if (action === "remove") return removeSupplier(card, btn);
    return undefined;
  }

  /** 文本按钮的忙碌态：临时替换文案（仅用于「应用」「保存」这类带文字的按钮）。 */
  function setBusy(target, flag, busyText) {
    if (!target) return;
    if (flag) {
      target.dataset.idleText = target.textContent;
      target.textContent = busyText || "处理中";
      target.disabled = true;
    } else {
      if (target.dataset.idleText) target.textContent = target.dataset.idleText;
      target.disabled = false;
    }
  }

  /**
   * 图标按钮的加载态：把图标换成 loading.svg 并叠加旋转动画。
   *
   * 不出现任何文字，因此不会像「处理中」那样撑破 26px 的图标按钮；
   * 操作一结束（成功或失败）立即还原为 `data-icon` 记录的原始图标，
   * 不会一直停留在加载态。
   */
  function setIconBusy(btn, flag) {
    if (!btn) return;
    var icon = btn.querySelector(".icon");
    if (!icon) return;
    var name = flag ? LOADING_ICON : btn.dataset.icon || "";
    icon.style.setProperty("--icon", "url('../assets/icons/" + name + "')");
    icon.classList.toggle("icon-spin", !!flag);
    btn.disabled = !!flag;
  }

  /** 应用：余额配置切换全局余额数据源；客户端配置写入客户端真实文件。 */
  function applySupplier(card, btn) {
    busy = true;
    setBusy(btn, true, "应用中");
    CFG.callApi(
      "apply_supplier",
      { scope: scope, slug: card.slug },
      { silent: true },
    )
      .then(function (result) {
        setBusy(btn, false);
        busy = false;
        if (scope === BALANCE_SCOPE) {
          CFG.notify("success", "已切换全局余额数据源为「" + card.name + "」");
          CFG.refreshBalance();
        } else {
          var count = result && result.files ? result.files.length : 0;
          CFG.notify(
            "success",
            "已应用到「" +
              scopeLabel(scope) +
              "」配置（写入 " +
              count +
              " 个文件）" +
              restartHint(scope),
          );
        }
        renderList();
      })
      .catch(function (err) {
        setBusy(btn, false);
        busy = false;
        CFG.notify("error", "应用失败：" + errText(err));
      });
  }

  /** 删除：先弹确认窗，确认后静默执行；启用中的供应商由后端拦截，这里只展示原因。 */
  function removeSupplier(card, btn) {
    CFG.showConfirm(
      "确定删除供应商“" + card.name + "”吗？此操作无法撤销。",
      function () {
        doRemoveSupplier(card, btn);
      },
    );
  }

  function doRemoveSupplier(card, btn) {
    busy = true;
    setIconBusy(btn, true);
    CFG.callApi(
      "delete_supplier",
      { scope: scope, slug: card.slug },
      { silent: true },
    )
      .then(function () {
        setIconBusy(btn, false);
        busy = false;
        CFG.notify("success", "已删除「" + card.name + "」");
        if (scope === BALANCE_SCOPE) CFG.refreshBalance();
        renderList();
      })
      .catch(function (err) {
        // 失败（如启用中被拦截）同样立即还原图标，不留「处理中」残留。
        setIconBusy(btn, false);
        busy = false;
        CFG.notify("error", errText(err));
      });
  }

  /** 测试连接：以右上角 toast 反馈结果（成功绿色 / 失败红色），按钮显示旋转加载图标。 */
  function testSupplier(card, btn) {
    busy = true;
    setIconBusy(btn, true);
    CFG.callApi(
      "test_supplier",
      { scope: scope, slug: card.slug },
      { silent: true },
    )
      .then(function (result) {
        setIconBusy(btn, false);
        busy = false;
        var ms =
          result && typeof result.latencyMs === "number" ? result.latencyMs : 0;
        if (result && result.ok) {
          CFG.notify("success", "连接成功，响应耗时 " + ms + " ms");
        } else {
          CFG.notify(
            "error",
            (result && result.message ? result.message : "连接失败") +
              "（耗时 " +
              ms +
              " ms）",
          );
        }
      })
      .catch(function (err) {
        setIconBusy(btn, false);
        busy = false;
        CFG.notify("error", "测试连接失败：" + errText(err));
      });
  }

  // ===== 预设目录 =====

  /** 预设清单（`presets/manifest.json`）：客户端 → 预设文件，避免文件清单写死在前端。 */
  var presetManifest = null;

  function loadPresetManifest() {
    if (presetManifest) return Promise.resolve(presetManifest);
    return fetch(PRESET_BASE + "manifest.json")
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        presetManifest =
          data && Array.isArray(data.clients) ? data.clients : [];
        return presetManifest;
      })
      .catch(function (err) {
        console.error("加载预设清单失败，改用内置兜底清单", err);
        presetManifest = [];
        return presetManifest;
      });
  }

  function loadPresetFile(file) {
    if (presetCache[file]) return Promise.resolve(presetCache[file]);
    return fetch(PRESET_BASE + file)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (list) {
        presetCache[file] = Array.isArray(list) ? list : [];
        return presetCache[file];
      })
      .catch(function (err) {
        console.error("加载预设失败", file, err);
        presetCache[file] = [];
        return [];
      });
  }

  /**
   * 预设清单里的**全部**来源文件（与「余额配置」列表用同一份清单）。
   *
   * 清单读取失败时回落内置兜底清单，保证任何情况下都能给出可用的文件列表。
   */
  function allPresetFiles() {
    var files = (presetManifest || [])
      .map(function (item) {
        return item && item.file ? String(item.file) : "";
      })
      .filter(Boolean);
    return files.length ? files : FALLBACK_BALANCE_PRESET_FILES.slice();
  }

  /**
   * 当前 scope 可选的预设来源文件。
   *
   * 余额配置与客户端无关 → 收录全部客户端预设（带 universal 收尾）；
   * 客户端列表 → 该客户端的预设 + 通用网关；未登记的客户端只给通用网关。
   */
  function presetFilesForScope() {
    var files = allPresetFiles();
    if (scope === BALANCE_SCOPE) {
      return files.indexOf("universal.json") === -1
        ? files.concat(["universal.json"])
        : files;
    }
    var file = CLIENT_PRESET_FILE[scope];
    return file ? [file, "universal.json"] : ["universal.json"];
  }

  /**
   * 新建供应商时的默认 API 格式：由客户端注册表给出（Codex 默认走 Responses 协议），
   * 余额配置等没有客户端的场景回落到 OpenAI Chat。
   */
  function defaultApiFormatOfScope() {
    return (formClient && formClient.defaultApiFormat) || "openai";
  }

  /**
   * 客户端表单最终采用的 API 格式。
   *
   * 预设目录是**跨客户端共享**的（universal.json 一类条目一律是 Anthropic 侧的地址），
   * 历史数据里也可能存着早期版本沿用的 Anthropic 值；而 Codex 只讲 OpenAI 协议——
   * 一旦沿用，写进 config.toml 的 wire_api 就是错的（表单上还会一直显示 Anthropic）。
   *
   * 判据只用注册表已有的信息：候选值是 Anthropic、而该客户端登记的默认格式不是
   * Anthropic → 说明这个协议该客户端讲不了，改用注册表登记的默认值。
   */
  function clientApiFormat(candidate) {
    var fallback = defaultApiFormatOfScope();
    if (!formClient || !candidate) return candidate || fallback;
    if (candidate === "anthropic" && fallback !== "anthropic") return fallback;
    return candidate;
  }

  /**
   * 预设默认 API 格式。
   *
   * 预设显式声明的协议优先（cc-switch 同源），但必须落在该客户端讲得了的协议里；
   * 预设**没声明协议**时用客户端注册表登记的默认格式，不再按地址猜——Codex 只讲
   * OpenAI 协议（登记值为 Responses），按地址猜会猜出 Anthropic、Chat 这些与注册表
   * 不符的值，这正是「Codex 默认 API 格式一直显示 Anthropic」的来源。
   * 余额配置列表没有客户端语义，沿用按地址推断的旧行为。
   */
  function defaultFormatOf(preset) {
    var declared =
      PRESET_FORMAT_MAP[String(preset.apiFormat || "").toLowerCase()];
    if (declared) return clientApiFormat(declared);
    if (formClient) return clientApiFormat(defaultApiFormatOfScope());
    return /\/anthropic\/?$/.test(String(preset.baseUrl || ""))
      ? "anthropic"
      : "openai";
  }

  function defaultAuthOf(format) {
    return format === "anthropic" ? "x-api-key" : "authorization";
  }

  /**
   * 「认证字段」的可选项：客户端列表用注册表登记的词表
   * （Claude 是「密钥写进 settings.json 的哪个 env 键」，Codex 一项都没有），
   * 余额配置列表没有客户端语义，回落到请求头名白名单。
   */
  function authFieldOptions() {
    return (formClient && formClient.authFields) || AUTH_FIELDS;
  }

  /**
   * 认证字段的默认取值。
   *
   * 客户端列表一律取注册表默认项（预设里那一份是请求头名，对客户端无意义）；
   * 余额配置列表按预设 / API 格式推断，保持既有行为。
   */
  function defaultAuthFieldOfScope(preset, format) {
    if (formClient) return formClient.defaultAuthField || "";
    return (preset && preset.authField) || defaultAuthOf(format);
  }

  /** 把 cc-switch 预设归一化为本模块的表单数据。 */
  function normalizePreset(preset) {
    var format = defaultFormatOf(preset);
    return {
      id: String(preset.id || ""),
      name: preset.name || "",
      logo: preset.logo || preset.icon || "",
      category: CATEGORY_LABELS[preset.category] || "其他",
      homepage: preset.websiteUrl || "",
      apiKeyUrl: preset.apiKeyUrl || preset.websiteUrl || "",
      baseUrl: preset.baseUrl || "",
      apiFormat: format,
      authField: defaultAuthOf(format),
      // cc-switch 预设里显式声明的模型列表地址（只有少数网关需要，见 `presetModelsUrl`）。
      modelsUrl: preset.modelsUrl || "",
      note: preset.notes || "",
    };
  }

  function openPresetPicker() {
    if (!cards) cards = [];
    presetTitleEl.textContent = "添加供应商 · " + scopeLabel(scope);
    presetSearchEl.value = "";
    openOverlay(supplierOverlayEl, presetModalEl);
    presetListEl.innerHTML =
      '<div class="preset-loading">正在加载供应商列表…</div>';
    presetEmptyEl.hidden = true;

    // 先读清单拿到「有哪些预设文件」，再并行加载各文件的预设。
    loadPresetManifest()
      .then(function () {
        return Promise.all(presetFilesForScope().map(loadPresetFile));
      })
      .then(function (groups) {
        var seen = {};
        var merged = [];
        groups.forEach(function (list) {
          list.forEach(function (preset) {
            var item = normalizePreset(preset);
            if (!item.id || seen[item.id]) return;
            seen[item.id] = true;
            merged.push(item);
          });
        });
        merged.sort(function (a, b) {
          return a.name.localeCompare(b.name, "zh-Hans-CN");
        });
        allPresets = merged;
        renderPresetList(merged);
        presetSearchEl.focus();
      });
  }

  var currentPresets = [];
  var allPresets = [];

  function renderPresetList(list) {
    currentPresets = list;
    if (!list.length) {
      presetListEl.innerHTML = "";
      presetEmptyEl.hidden = false;
      return;
    }
    presetEmptyEl.hidden = true;
    var html = "";
    list.forEach(function (item, index) {
      var logo = logoUrl(item.logo);
      html +=
        '<button type="button" class="preset-item" data-index="' +
        index +
        '" role="option">' +
        '<span class="preset-logo-wrap">' +
        (logo
          ? '<img class="preset-logo" src="' + escapeHtml(logo) + '" alt="">'
          : "") +
        "</span>" +
        '<span class="preset-name">' +
        escapeHtml(item.name) +
        "</span>" +
        '<span class="preset-tag">' +
        escapeHtml(item.category) +
        "</span>" +
        "</button>";
    });
    presetListEl.innerHTML = html;
    presetListEl.querySelectorAll(".preset-logo").forEach(bindLogoFallback);
    presetListEl.querySelectorAll(".preset-item").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var item = currentPresets[Number(btn.dataset.index)];
        if (!item) return;
        openCreateForm(item);
      });
    });
  }

  /**
   * 搜索筛选始终基于完整列表，否则第二次筛选会作用在上一次的结果上。
   *
   * 命中规则 = 「名称 / 标识 / 分类包含关键词」或「关键词命中中文别名规则」，
   * 两者取并集，因此加别名不会让原本能搜到的供应商消失。
   */
  function filterPresets(keyword) {
    var key = String(keyword || "")
      .trim()
      .toLowerCase();
    if (!key) return allPresets;
    var aliasPatterns = PRESET_ALIASES.filter(function (rule) {
      return rule.terms.some(function (term) {
        var lower = term.toLowerCase();
        return lower.indexOf(key) !== -1 || key.indexOf(lower) !== -1;
      });
    }).map(function (rule) {
      return rule.match;
    });
    return allPresets.filter(function (item) {
      var haystack = (
        item.name +
        " " +
        item.id +
        " " +
        item.category
      ).toLowerCase();
      if (haystack.indexOf(key) !== -1) return true;
      var combined = item.name + " " + item.id;
      return aliasPatterns.some(function (pattern) {
        return pattern.test(combined);
      });
    });
  }

  // ===== 弹窗 / 页面基础 =====
  //
  // 两类宿主：
  // - 弹窗：`.modal-overlay` + `.modal`，遮罩与窗口一起显隐；
  // - 全局页面：单个 `.page`（内容多、需要整页 + 独立滚动），无遮罩概念。
  // 两者共用同一组开关函数，调用方不必区分形态。

  /** 是否「全局页面」形态（整页展示，不需要遮罩配合显隐）。 */
  function isPage(node) {
    return !!(node && node.classList && node.classList.contains("page"));
  }

  function openOverlay(overlay, modal) {
    if (isPage(modal)) {
      modal.hidden = false;
      return;
    }
    overlay.hidden = false;
    modal.hidden = false;
  }

  function closeOverlay(overlay, modal) {
    if (isPage(modal)) {
      modal.hidden = true;
    } else {
      overlay.hidden = true;
      modal.hidden = true;
    }
    // 下拉与日历的浮层都挂在 <body> 上，不随弹窗 / 页面一起隐藏：必须显式收起，
    // 否则会留在页面上。
    if (CFG.closePickers) CFG.closePickers();
    if (modal === usageModalEl) closeCalendar();
  }

  function closeSupplierOverlay() {
    closeOverlay(supplierOverlayEl, presetModalEl);
    closeOverlay(supplierOverlayEl, formModalEl);
    closeCommonConfigPage();
    editing = null;
    editingMeta = null;
    // 表单已关：停掉待发的预览请求，别让它在后台继续跑。
    clearPreview();
  }

  /**
   * 取消：返回供应商列表页面。
   *
   * 新建流程由「供应商列表（预设列表）」进入表单，取消即回到该列表；
   * 编辑流程来自列表中的卡片，取消直接回到配置主界面的供应商列表。
   */
  function cancelSupplierForm() {
    if (editing) {
      closeSupplierOverlay();
      return;
    }
    closeOverlay(supplierOverlayEl, formModalEl);
    openPresetPicker();
  }

  /** 展开 / 收起供应商列表（默认展开，复用「挂件状态」「高级设置」的折叠动画）。 */
  function toggleSupplierList() {
    var collapsed = supplierCardEl.classList.toggle("collapsed");
    supplierToggleEl.setAttribute(
      "aria-expanded",
      collapsed ? "false" : "true",
    );
  }

  // ===== 表单 =====

  /** 回填自定义下拉：options 为 `{ value, label }` 列表（取值与领域契约一一对应）。 */
  function fillPicker(picker, options, value) {
    if (!picker) return;
    picker.setItems(
      (options || []).map(function (opt) {
        return { value: opt.value, text: opt.label };
      }),
      value,
    );
  }

  function setFieldError(input, errorEl, message) {
    if (!input || !errorEl) return;
    if (message) {
      input.classList.add("invalid");
      errorEl.textContent = message;
      errorEl.hidden = false;
    } else {
      input.classList.remove("invalid");
      errorEl.textContent = "";
      errorEl.hidden = true;
    }
  }

  function clearFormErrors() {
    setFieldError(supNameEl, supNameErrorEl, "");
    setFieldError(supApiKeyEl, supApiKeyErrorEl, "");
    setFieldError(supBaseUrlEl, supBaseUrlErrorEl, "");
    clearCatalogErrors();
  }

  /** 自定义下拉触发按钮内的箭头（与「音效」「挂件主体」同一路径）。 */
  function caretSvg() {
    return (
      '<svg class="picker-caret" viewBox="0 0 12 8" aria-hidden="true">' +
      '<path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    );
  }

  /** 模型映射行的删除图标（与卡片上的删除按钮同一路径，避免引入新素材）。 */
  function trashSvg() {
    return (
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
      'stroke-linejoin="round"/></svg>'
    );
  }

  // ===== 模型路由（按客户端布局渲染）=====
  //
  // 两个客户端的模型配置结构差异很大，注册表用 `routingLayout` 指明形态：
  // - `roles`（Claude）：固定角色表（模型角色 / 显示名称 / 实际请求模型 / 支持1M）+ 上下文窗口；
  // - `catalog`（Codex）：单个「默认模型」+「支持1M」+ 可增删的「模型映射」表。
  // 角色、文案、思考档位全部取自注册表，前端不硬编码任何客户端的字段名。

  /** 1M 能力标记：判定 / 剥离 / 拼接（与后端 `supplier_service` 同一套规则）。 */
  function hasOneM(model) {
    return /\[1m\]$/i.test(String(model == null ? "" : model).trim());
  }

  function stripOneM(model) {
    return String(model == null ? "" : model)
      .replace(/\[1m\]\s*$/i, "")
      .trim();
  }

  function setOneM(model, enabled) {
    var base = stripOneM(model);
    if (!base) return "";
    return enabled ? base + ONE_M_MARKER : base;
  }

  /** 当前表单是不是「模型映射」式布局（Codex）。 */
  function isCatalogLayout() {
    return !!formClient && formClient.routingLayout === "catalog";
  }

  /** 「应用通用配置」开关的键（与后端注册表同一字符串）。 */
  var SWITCH_APPLY_COMMON_CONFIG = "apply_common_config";

  /** 当前客户端是否支持「通用配置片段」：判据是注册表里登记了「应用通用配置」开关。 */
  function supportsCommonConfig() {
    return formClientSwitches().some(function (item) {
      return item.key === SWITCH_APPLY_COMMON_CONFIG;
    });
  }

  /** 当前客户端的布尔配置项（未选客户端时为空）。 */
  function formClientSwitches() {
    return (formClient && formClient.switches) || [];
  }

  /** 解析正整数，非法 / 空串一律返回 0（0 在后端表示「不写该键」）。 */
  function parsePositiveInt(text) {
    var value = parseInt(text, 10);
    return isFinite(value) && value > 0 ? value : 0;
  }

  /** 销毁模型路由分区里的全部下拉实例（宿主即将被重建 / 表单即将清空）。 */
  function destroyRoutingPickers() {
    Object.keys(routingOptionPickers).forEach(function (key) {
      var stale = routingOptionPickers[key];
      if (stale && stale.destroy) stale.destroy();
    });
    routingOptionPickers = {};
    modelRowPickers.forEach(function (picker) {
      if (picker && picker.destroy) picker.destroy();
    });
    modelRowPickers = [];
    if (!supCatalogRowsEl) return;
    supCatalogRowsEl.querySelectorAll(".sup-model-row").forEach(function (row) {
      destroyRowPickers(row);
    });
  }

  /** 销毁某一行的下拉实例（删除该行时调用）。 */
  function destroyRowPickers(row) {
    (row.__pickers || []).forEach(function (picker) {
      if (picker && picker.destroy) picker.destroy();
      var index = modelRowPickers.indexOf(picker);
      if (index !== -1) modelRowPickers.splice(index, 1);
    });
    row.__pickers = [];
  }

  /** 模块标题行右侧的操作按钮（按布局给出不同组合，按钮不换行、不被压缩）。 */
  function renderRoutingActions() {
    if (!supRoutingActionsEl || !supCatalogActionsEl) return;
    if (isCatalogLayout()) {
      supRoutingActionsEl.innerHTML = "";
      supCatalogActionsEl.innerHTML =
        '<button type="button" class="sup-mini-btn" id="supFetchModels">获取模型列表</button>' +
        '<button type="button" class="sup-mini-btn" id="supAddCatalogModel">添加模型</button>';
      return;
    }
    supCatalogActionsEl.innerHTML = "";
    supRoutingActionsEl.innerHTML =
      '<button type="button" class="sup-mini-btn" id="supQuickSet">一键配置</button>' +
      '<button type="button" class="sup-mini-btn" id="supFetchModels">获取模型列表</button>';
  }

  /** 「实际请求模型」格：输入框 + 右侧下拉触发按钮（未取到模型列表时按钮隐藏）。 */
  function modelCell(key, value, placeholder, kind, inputClass) {
    return (
      '<div class="picker sup-model-cell" data-role="' +
      escapeHtml(kind) +
      '"><input class="' +
      escapeHtml(inputClass) +
      '" data-key="' +
      escapeHtml(key || "") +
      '" type="text" placeholder="' +
      escapeHtml(placeholder || "") +
      '" value="' +
      escapeHtml(value || "") +
      '" autocomplete="off"><button type="button" class="picker-toggle sup-model-toggle" ' +
      'aria-label="选择模型" aria-expanded="false"' +
      (fetchedModels.length ? "" : " hidden") +
      ">" +
      caretSvg() +
      '</button><div class="picker-list" role="listbox" hidden></div></div>'
    );
  }

  /** 模型下拉的条目：取列表所得的原始模型名。 */
  function modelPickerItems() {
    return fetchedModels.map(function (name) {
      return { value: name, text: name };
    });
  }

  /** 思考档位下拉的条目（多选，取值即落盘值）。 */
  function levelPickerItems() {
    return (formClient.catalogReasoningLevels || []).map(function (choice) {
      return { value: choice.value, text: choice.label };
    });
  }

  /**
   * 为一个「实际请求模型」格装配可搜索下拉。
   *
   * 触发按钮紧贴输入框右侧；模型列表动辄上百条，因此列表带搜索框。
   * `fitContent`：触发按钮只是一个 26px 的小箭头，若列表按按钮宽度展开（下限
   * 120px），「deepseek-ai/DeepSeek-V3.2-Exp」这类长模型名会被省略号截掉；
   * 改为按内容自适应后名字完整展示，长到超过视口时也不会横向溢出。
   */
  function createModelPicker(cell) {
    if (!cell || !CFG.createPicker) return null;
    var cellKind = cell.dataset.role || "";
    var picker = CFG.createPicker(
      cell,
      function (picked) {
        if (picked) fillModelIntoCell(cell, cellKind, picked);
      },
      null,
      null,
      {
        searchable: true,
        fitContent: true,
        searchPlaceholder: "搜索模型",
        emptyText: "没有匹配的模型",
      },
    );
    // 列表内容在创建时就装好：按钮是在取到模型之后才出现的，此时列表已经是最终内容。
    picker.setItems(modelPickerItems(), "");
    return picker;
  }

  /** 选中某个模型后回填本行：显示名称 + 实际请求模型（1M 勾选态保持不变）。 */
  function fillModelIntoCell(cell, kind, picked) {
    var row = cell.closest(".sup-model-row");
    var base = stripOneM(picked);
    var box = row ? row.querySelector(".sup-one-m-box") : null;
    var input =
      cell.querySelector(".sup-slot") ||
      cell.querySelector(".sup-catalog-model");
    if (input) input.value = box && box.checked ? setOneM(base, true) : base;
    var display = row
      ? row.querySelector(".sup-display, .sup-catalog-display")
      : null;
    if (display) display.value = base;
    schedulePreview();
  }

  /** 取到模型列表后：显示各行的下拉按钮并装配实例（不重建 DOM，保住用户已填的值）。 */
  function showModelPickers() {
    if (!supRoutingSectionEl) return;
    supRoutingSectionEl
      .querySelectorAll(".sup-model-toggle")
      .forEach(function (btn) {
        btn.hidden = false;
      });
    supRoutingSectionEl
      .querySelectorAll(".sup-model-cell")
      .forEach(function (cell) {
        if (cell.__picker) {
          // 重新取过列表：把新的一批模型换进已有下拉（宿主没变，不必重建）。
          cell.__picker.setItems(modelPickerItems(), "");
          return;
        }
        cell.__picker = createModelPicker(cell);
        if (cell.__picker) modelRowPickers.push(cell.__picker);
      });
  }

  /** 角色表（Claude）：模型角色 / 显示名称 / 实际请求模型 / 支持1M。 */
  function renderRoleRows(map, display) {
    var slots = formClient.modelSlots || [];
    var head =
      '<div class="sup-model-head"><span>模型角色</span><span>显示名称</span>' +
      '<span>实际请求模型</span><span class="sup-head-center">支持1M</span></div>';
    var rows = slots.map(function (slot) {
      var model = map[slot.key] || "";
      var displayCell = slot.displayName
        ? '<input class="sup-display" data-key="' +
          escapeHtml(slot.key) +
          '" type="text" placeholder="' +
          escapeHtml(slot.placeholder) +
          '" value="' +
          escapeHtml(display[slot.key] || "") +
          '" autocomplete="off">'
        : '<span class="sup-model-empty">不显示在 /model 菜单</span>';
      // 不支持 1M 的档位（如 Haiku）勾选框禁用：用户看得见规则，但改不了。
      var oneM = slot.supportsOneM
        ? '<label class="sup-one-m"><input class="sup-one-m-box" data-key="' +
          escapeHtml(slot.key) +
          '" type="checkbox"' +
          (hasOneM(model) ? " checked" : "") +
          "></label>"
        : '<label class="sup-one-m disabled"><input class="sup-one-m-box" data-key="' +
          escapeHtml(slot.key) +
          '" type="checkbox" disabled></label>';
      return (
        '<div class="sup-model-row" data-key="' +
        escapeHtml(slot.key) +
        '"><span class="sup-model-role">' +
        escapeHtml(slot.label) +
        "</span>" +
        displayCell +
        modelCell(slot.key, model, slot.placeholder, "role", "sup-slot") +
        oneM +
        "</div>"
      );
    });
    supModelSlotsEl.innerHTML =
      '<div class="sup-model-table" data-layout="roles">' +
      head +
      rows.join("") +
      "</div>";
  }

  /** 默认模型行（Codex）：单个输入框，右侧同样是模型列表下拉。 */
  function renderDefaultModelRow(map) {
    var slots = formClient.modelSlots || [];
    var slot = slots[0] || {
      key: "primary",
      label: "默认模型",
      placeholder: "deepseek-chat",
    };
    supModelSlotsEl.innerHTML =
      '<div class="sup-default-row"><span class="sup-default-label">' +
      escapeHtml(slot.label) +
      "</span>" +
      modelCell(
        slot.key,
        map[slot.key] || "",
        slot.placeholder,
        "default",
        "sup-slot",
      ) +
      "</div>";
  }

  /**
   * Codex 专属的两个布尔项：「支持1M」与「压缩阈值」。
   *
   * 勾选「支持1M」写入顶层 `model_context_window = 1000000`；「压缩阈值」另存
   * `model_auto_compact_token_limit`（默认 900000，可改）。两者都未勾选时后端不写任何键。
   */
  function oneMFlagsHtml(routing) {
    var oneM = !!routing && routing.contextWindow === CODEX_1M_WINDOW;
    var limit = (routing && routing.compactTokenLimit) || 0;
    var compact = limit > 0;
    return (
      '<label class="sup-flag"><input id="supOneMBox" type="checkbox"' +
      (oneM ? " checked" : "") +
      "><span>支持1M</span></label>" +
      '<label class="sup-flag' +
      (oneM ? "" : " disabled") +
      '"><input id="supCompactBox" type="checkbox"' +
      (compact ? " checked" : "") +
      (oneM ? "" : " disabled") +
      "><span>压缩阈值</span>" +
      '<input id="supCompactLimit" class="sup-flag-num" type="text" inputmode="numeric" placeholder="' +
      CODEX_1M_COMPACT +
      '" value="' +
      escapeHtml(limit ? String(limit) : "") +
      '"' +
      (compact ? "" : " disabled") +
      "></label>"
    );
  }

  /**
   * 同步两个 Codex 布尔项的联动状态。
   *
   * 「支持1M」是总开关：未勾选时压缩阈值整项置灰、清空、不写盘；勾选后默认带上 900000。
   * 「压缩阈值」自身再决定要不要写 `model_auto_compact_token_limit`。
   */
  function syncOneMInputs() {
    var oneMBox = el("supOneMBox");
    var compactBox = el("supCompactBox");
    var input = el("supCompactLimit");
    if (!oneMBox || !compactBox || !input) return;
    var oneM = !!oneMBox.checked;
    compactBox.disabled = !oneM;
    var wrap = compactBox.closest(".sup-flag");
    if (wrap) wrap.classList.toggle("disabled", !oneM);
    if (!oneM) {
      compactBox.checked = false;
      input.value = "";
    } else if (!compactBox.checked && !input.value.trim()) {
      // 首次勾选「支持1M」：压缩阈值默认一起勾上并带上默认值。
      compactBox.checked = true;
    }
    // 判定必须在「补勾」之后：否则第一次勾选会算成「不写压缩阈值」而把输入框禁用。
    var compact = oneM && !!compactBox.checked;
    input.disabled = !compact;
    if (compact && !input.value.trim()) input.value = String(CODEX_1M_COMPACT);
  }

  /**
   * 模型映射的一个「标签 + 控件」行：标签固定宽度在左，控件占满右侧。
   *
   * 必填项（显示名称 / 实际请求模型）的报错节点作为该行的**兄弟节点**紧随其后，
   * 与表单里其它字段的报错方式一致：报错独占一行、正好在对应输入框下方，
   * 不会被挤进标签与控件之间破坏列对齐。
   */
  function catalogFieldHtml(label, control, required) {
    return (
      '<div class="sup-model-field"><span class="field-label">' +
      escapeHtml(label) +
      "</span>" +
      control +
      "</div>" +
      (required ? '<div class="field-error" hidden></div>' : "")
    );
  }

  /** 单条模型映射行：每个配置项各自一行（标签 + 控件同行），不再两行一组。 */
  function catalogRowHtml(row) {
    return (
      '<div class="sup-model-row" data-levels="' +
      escapeHtml((row.reasoningLevels || []).join(",")) +
      '">' +
      catalogFieldHtml(
        "显示名称",
        '<input class="sup-catalog-display" type="text" placeholder="例如：DeepSeek V4" value="' +
          escapeHtml(row.displayName || "") +
          '" autocomplete="off"><button type="button" class="sup-catalog-del" ' +
          'aria-label="删除该模型">' +
          trashSvg() +
          "</button>",
        true,
      ) +
      catalogFieldHtml(
        "实际请求模型",
        modelCell(
          "",
          row.model || "",
          "deepseek-chat",
          "catalog",
          "sup-catalog-model",
        ),
        true,
      ) +
      catalogFieldHtml(
        "上下文窗口",
        '<input class="sup-catalog-window" type="text" inputmode="numeric" placeholder="' +
          CATALOG_DEFAULT_WINDOW +
          '" value="' +
          escapeHtml(row.contextWindow ? String(row.contextWindow) : "") +
          '" autocomplete="off">',
      ) +
      catalogFieldHtml(
        "思考等级",
        '<div class="picker sup-levels"><button type="button" ' +
          'class="picker-toggle" aria-haspopup="listbox" aria-expanded="false">' +
          '<span class="picker-label"></span>' +
          caretSvg() +
          '</button><div class="picker-list" role="listbox" hidden></div></div>',
      ) +
      "</div>"
    );
  }

  /** 行内已选的思考档位（存在 `data-levels` 上：下拉的取值、预览与保存都读它）。 */
  function levelsOf(row) {
    return (row.dataset.levels || "").split(",").filter(function (value) {
      return !!value;
    });
  }

  /** 为一条模型映射行装配两个下拉：模型列表（可搜索）+ 思考等级（多选）。 */
  function bindCatalogRow(row) {
    var pickers = [];
    var cell = row.querySelector(".sup-model-cell");
    if (cell && !cell.__picker) {
      cell.__picker = createModelPicker(cell);
      if (cell.__picker) pickers.push(cell.__picker);
    }
    var levels = row.querySelector(".sup-levels");
    if (levels && !levels.__picker && CFG.createPicker) {
      var levelPicker = CFG.createPicker(
        levels,
        function (values) {
          row.dataset.levels = (values || []).join(",");
          schedulePreview();
        },
        null,
        null,
        { multi: true, placeholder: "未选择" },
      );
      levelPicker.setItems(levelPickerItems(), levelsOf(row));
      levels.__picker = levelPicker;
      pickers.push(levelPicker);
    }
    row.__pickers = pickers;
  }

  /** 追加一条模型映射行（「添加模型」）。 */
  function appendCatalogRow(row) {
    var table = supCatalogRowsEl.querySelector(".sup-model-table");
    if (!table) return;
    var empty = table.querySelector(".sup-catalog-empty");
    if (empty) empty.remove();
    table.insertAdjacentHTML(
      "beforeend",
      catalogRowHtml(
        row || {
          displayName: "",
          model: "",
          contextWindow: 0,
          reasoningLevels: [],
        },
      ),
    );
    var rows = table.querySelectorAll(".sup-model-row");
    var last = rows[rows.length - 1];
    if (last) {
      // 打上「用户新加的」标记：这一行即使一个字都没填也必须补全才能保存，
      // 否则「点了添加模型却没填」会被当成空行静默丢弃，用户以为存上了。
      last.dataset.added = "1";
      bindCatalogRow(last);
    }
    schedulePreview();
  }

  /** 删除一条模型映射行（连同它的下拉实例）。 */
  function removeCatalogRow(btn) {
    var row = btn.closest(".sup-model-row");
    if (!row) return;
    destroyRowPickers(row);
    row.remove();
    var table = supCatalogRowsEl.querySelector(".sup-model-table");
    if (table && !table.querySelector(".sup-model-row")) {
      table.insertAdjacentHTML(
        "beforeend",
        '<div class="sup-catalog-empty">还没有添加模型</div>',
      );
    }
    schedulePreview();
  }

  /** 渲染模型映射区（Codex）：空态给出占位提示，否则逐行装配。 */
  function renderCatalogBlock(rows) {
    supCatalogRowsEl.innerHTML =
      '<div class="sup-model-table" data-layout="catalog">' +
      (rows.length
        ? ""
        : '<div class="sup-catalog-empty">还没有添加模型</div>') +
      "</div>";
    var table = supCatalogRowsEl.querySelector(".sup-model-table");
    if (!rows.length) return;
    table.insertAdjacentHTML("beforeend", rows.map(catalogRowHtml).join(""));
    table.querySelectorAll(".sup-model-row").forEach(bindCatalogRow);
  }

  /**
   * 布尔配置（按注册表登记渲染）：一律「左侧勾选框 + 右侧文字」，整行 flex-wrap 排布。
   *
   * Codex 的「支持1M / 压缩阈值」是专属项，排在登记项之前，与它们同处一行。
   */
  function renderSwitchRows(routing) {
    var switches = (routing && routing.switches) || {};
    var html = isCatalogLayout() ? oneMFlagsHtml(routing) : "";
    html += (formClient.switches || [])
      .map(function (item) {
        var checked = Object.prototype.hasOwnProperty.call(switches, item.key)
          ? switches[item.key]
          : item.default;
        return (
          '<label class="sup-flag"><input class="sup-switch" data-key="' +
          escapeHtml(item.key) +
          '" type="checkbox"' +
          (checked ? " checked" : "") +
          "><span>" +
          escapeHtml(item.label) +
          "</span></label>"
        );
      })
      .join("");
    supSwitchesEl.innerHTML = html;
    if (isCatalogLayout()) syncOneMInputs();
  }

  /** 枚举选项（用自定义下拉渲染，与表单内其它下拉同一种样式）。 */
  function renderOptionRows(options) {
    var optionList = formClient.options || [];
    supOptionsEl.innerHTML = optionList
      .map(function (item) {
        return (
          '<div class="field"><span class="field-label short">' +
          escapeHtml(item.label) +
          '</span><div class="picker" data-option="' +
          escapeHtml(item.key) +
          '"><button type="button" class="picker-toggle" aria-haspopup="listbox" ' +
          'aria-expanded="false"><span class="picker-label"></span>' +
          caretSvg() +
          '</button><div class="picker-list" role="listbox" hidden></div></div></div>'
        );
      })
      .join("");
    supOptionsEl
      .querySelectorAll(".picker[data-option]")
      .forEach(function (root) {
        var key = root.dataset.option;
        var item = optionList.filter(function (candidate) {
          return candidate.key === key;
        })[0];
        if (!item || !CFG.createPicker) return;
        var picker = CFG.createPicker(root);
        picker.setItems(
          (item.choices || []).map(function (choice) {
            return { value: choice.value, text: choice.label };
          }),
          options[item.key] || item.default,
        );
        routingOptionPickers[key] = picker;
      });
  }

  /** 按客户端注册表渲染模型路由分区（新增客户端无需改前端）。 */
  function renderRoutingFields(routing) {
    supRoutingSectionEl.hidden = !formClient;
    destroyRoutingPickers();
    if (!formClient) return;
    var map = (routing && routing.modelMap) || {};
    var display = (routing && routing.displayMap) || {};
    var options = (routing && routing.options) || {};
    var catalog = isCatalogLayout();

    // 两种布局的专属区块互斥：角色表（Claude）用四列角色表，目录式（Codex）用默认模型 + 模型映射。
    supModelCatalogEl.hidden = !catalog;
    supCatalogRowsEl.innerHTML = "";
    // 「编辑通用设置」入口随「应用通用配置」开关出现（只有 Codex 登记了它）。
    supEditCommonEl.hidden = !supportsCommonConfig();

    if (catalog) {
      renderDefaultModelRow(map);
      renderCatalogBlock((routing && routing.modelCatalog) || []);
    } else {
      renderRoleRows(map, display);
    }
    renderRoutingActions();
    renderSwitchRows(routing);
    renderOptionRows(options);
    if (fetchedModels.length) showModelPickers();
  }

  /**
   * 按当前 scope 与「令牌用量统计」开关决定表单里各字段的可见性。
   *
   * - 「平台令牌」只服务于**余额配置**的官网用量取数：客户端列表只做模型路由，
   *   实验性开关关闭时更是整块隐藏（表单里不留任何用量查询 / 统计相关配置项），
   *   但**不会**清空已保存的取值；
   * - API 格式 / 认证字段 / 备注只服务于「写客户端配置文件」，余额配置列表下无意义。
   */
  function applyFormVisibility() {
    var client = !!formClient;
    supUsageTokenRowEl.hidden = !CFG.tokenUsageEnabled() || client;
    supApiFormatRowEl.hidden = !client;
    // 「认证字段」按客户端注册表决定：Codex 的密钥固定写 auth.json，没有这一项。
    supAuthFieldRowEl.hidden = !client || !authFieldOptions().length;
    supNoteRowEl.hidden = !client;
    // 「配置预览」只对客户端列表有意义：只有它们才会把配置写进客户端配置文件；
    // 余额配置列表不写任何外部文件（后端也会拒绝这类 scope 的预览请求）。
    supPreviewSectionEl.hidden = !client;
    if (!client) clearPreview();
  }

  // ===== 通用配置片段（Codex 专属）=====
  //
  // 片段跨供应商共享（存在数据目录里），只有勾选「应用通用配置」的供应商才会在渲染
  // `config.toml` 时把它合并进去；因此这里的保存与表单保存是两件独立的事。

  /** 错误提示（TOML 语法错误由后端给原文，直接展示）。 */
  function showCommonConfigError(message) {
    if (!commonConfigErrorEl) return;
    commonConfigErrorEl.textContent = message || "";
    commonConfigErrorEl.hidden = !message;
  }

  /**
   * 通用配置文本域随内容自适应高度。
   *
   * 它与「配置预览」里的 json / toml 展示框是同一套样式，而预览框**纵向完整展示**
   * （不设高度上限、内容多长就多高）。文本域要保持一致，就不能把内容藏在内部滚动条
   * 后面，因此高度跟着内容走；横向仍由文本域自己的滚动条承担（`wrap="off"`），
   * 长行既不折行也不被裁掉。
   */
  function syncCommonConfigHeight() {
    if (!commonConfigTextEl) return;
    var el = commonConfigTextEl;
    // 归零再量，这一步会让内容**瞬间变矮**：外层已经在滚时，浏览器会把 scrollTop
    // 夹到新的最大值，高度恢复后滚动位置就回不去了——表现就是「一编辑窗口就往上滚」。
    // 因此量之前记下滚动位置，量完立刻写回。
    var scroller = nearestScroller(el);
    var top = scroller ? scroller.scrollTop : 0;
    el.style.height = "auto";
    // 补上边框与可能出现的横向滚动条占掉的高度：宁可底部多留一点空白，
    // 也不能把最后一行裁掉。
    el.style.height =
      el.scrollHeight + (el.offsetHeight - el.clientHeight) + "px";
    if (scroller) scroller.scrollTop = top;
  }

  /** 最近的「真的能滚」的祖先节点（没有则返回 null）。 */
  function nearestScroller(node) {
    var parent = node ? node.parentElement : null;
    while (parent) {
      var overflowY = window.getComputedStyle(parent).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  /**
   * 打开「编辑Codex通用配置片段」页面：先读已保存的片段，读失败也允许继续编辑。
   *
   * 它是叠加在客户端配置页之上的**全局页面**：打开时不再收起供应商表单页，
   * 底层页面（codex 具体配置）的状态、滚动位置与已填内容全程保留，
   * 关闭后依旧停在同一个客户端配置页。
   */
  function openCommonConfigPage() {
    if (!commonConfigPageEl) return;
    showCommonConfigError("");
    commonConfigTextEl.value = "";
    commonConfigPageEl.hidden = false;
    syncCommonConfigHeight();
    CFG.callApi("get_common_config", { scope: scope }, { silent: true })
      .then(function (snippet) {
        commonConfigTextEl.value = snippet || "";
        syncCommonConfigHeight();
      })
      .catch(function (err) {
        showCommonConfigError("读取通用配置失败：" + errText(err));
      });
  }

  /** 关闭通用配置页面：只收起自己，底层客户端配置页原样保留。 */
  function closeCommonConfigPage() {
    if (!commonConfigPageEl || commonConfigPageEl.hidden) return;
    commonConfigPageEl.hidden = true;
    if (CFG.closePickers) CFG.closePickers();
  }

  /** 保存片段：后端先校验 TOML 语法，非法时把原文交给用户改。 */
  function saveCommonConfig() {
    var snippet = commonConfigTextEl.value;
    showCommonConfigError("");
    CFG.callApi(
      "save_common_config",
      { scope: scope, snippet: snippet },
      { silent: true },
    )
      .then(function () {
        CFG.notify("success", "通用配置已保存");
        closeCommonConfigPage();
        // 勾选了「应用通用配置」的供应商会把它合并进 config.toml：预览要跟着变。
        schedulePreview();
      })
      .catch(function (err) {
        showCommonConfigError(errText(err));
      });
  }

  /**
   * 「从编辑内容提取」：从当前预览的 `config.toml` 里剔除供应商私有的键（模型 / provider
   * 段 / MCP / 密钥…），把剩下的部分作为通用片段保存——与 cc-switch 的提取口径一致。
   */
  function extractCommonConfig() {
    var target = null;
    previewFiles.forEach(function (file) {
      if (!target && /\.toml$/i.test(file.path || "")) target = file;
    });
    if (!target) {
      showCommonConfigError("当前没有可提取的 config.toml 内容");
      return;
    }
    showCommonConfigError("");
    CFG.callApi(
      "extract_common_config",
      { scope: scope, configText: target.content },
      { silent: true },
    )
      .then(function (snippet) {
        if (!snippet) {
          showCommonConfigError("当前编辑内容没有可提取的通用配置");
          return;
        }
        commonConfigTextEl.value = snippet;
        syncCommonConfigHeight();
        CFG.callApi(
          "save_common_config",
          { scope: scope, snippet: snippet },
          { silent: true },
        )
          .then(function () {
            CFG.notify("success", "已从编辑内容提取并保存通用配置");
          })
          .catch(function (err) {
            showCommonConfigError(errText(err));
          });
      })
      .catch(function (err) {
        showCommonConfigError(errText(err));
      });
  }

  // ===== 配置预览（claude / codex 客户端页）=====
  //
  // 预览用**当前表单草稿**渲染（后端 preview_supplier_config，不落盘），因此用户改
  // 任何字段都能马上看到「保存后会写进客户端配置文件的内容」，不必先存再看。
  // 请求做了防抖 + 序号保护：连续输入只发最后一次，迟到的响应一律丢弃。

  var previewSeq = 0;
  var previewTimer = null;
  var previewBusy = false;

  function clearPreview() {
    // 序号自增：把在途响应作废，避免它把已清空的面板又填回来。
    previewSeq += 1;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
    previewFiles = [];
    previewActive = 0;
    if (supPreviewTabsEl) supPreviewTabsEl.innerHTML = "";
    if (supPreviewFilesEl) supPreviewFilesEl.innerHTML = "";
  }

  /** 文件名的最后一段（选择框组上只显示文件名，完整路径仍在文件头里）。 */
  function fileNameOf(path) {
    var parts = String(path == null ? "" : path).split(/[\\/]/);
    return parts[parts.length - 1] || String(path || "");
  }

  /** 顶部文件选择框组：横向切换查看每个将要写入的文件。 */
  function renderPreviewTabs() {
    if (!supPreviewTabsEl) return;
    supPreviewTabsEl.innerHTML = previewFiles
      .map(function (file, index) {
        return (
          '<button type="button" class="preview-tab' +
          (index === previewActive ? " active" : "") +
          '" data-index="' +
          index +
          '">' +
          escapeHtml(fileNameOf(file.path)) +
          "</button>"
        );
      })
      .join("");
  }

  /** 当前查看的文件内容（完整展示，不截断、不出现内部滚动条）。 */
  function renderPreviewBody() {
    if (!supPreviewFilesEl) return;
    var file = previewFiles[previewActive];
    if (!file) {
      supPreviewFilesEl.innerHTML =
        '<div class="preview-empty">暂无可预览的文件</div>';
      return;
    }
    supPreviewFilesEl.innerHTML =
      '<div class="preview-file">' +
      '<div class="preview-file-head">' +
      '<span class="preview-file-path" title="' +
      escapeHtml(file.path) +
      '">' +
      escapeHtml(file.path) +
      "</span>" +
      '<span class="preview-file-lang">' +
      escapeHtml(file.language || "json") +
      "</span>" +
      "</div>" +
      '<pre class="preview-file-body">' +
      escapeHtml(file.content) +
      "</pre>" +
      "</div>";
  }

  function renderPreviewFiles(files) {
    previewFiles = files || [];
    // 文件数量会随「模型映射」的出现 / 清空变化：越界时回到第一个文件。
    if (!previewFiles.length || previewActive >= previewFiles.length) {
      previewActive = 0;
    }
    renderPreviewTabs();
    renderPreviewBody();
  }

  /** 点顶部文件选择框组切换查看的文件。 */
  function onPreviewTabClick(e) {
    var tab = e.target.closest(".preview-tab");
    if (!tab) return;
    var index = parseInt(tab.dataset.index, 10);
    if (!isFinite(index) || index === previewActive) return;
    previewActive = index;
    renderPreviewTabs();
    renderPreviewBody();
  }

  function refreshPreview() {
    previewTimer = null;
    // 表单已关 / 非客户端列表：都不必再发请求。
    if (!formClient || formModalEl.hidden) return;
    if (previewBusy) {
      // 上一轮尚未返回：稍后重试，保证「最后一次编辑」一定会被渲染出来。
      previewTimer = setTimeout(refreshPreview, 120);
      return;
    }
    previewBusy = true;
    var seq = ++previewSeq;
    CFG.callApi(
      "preview_supplier_config",
      { payload: buildPayload() },
      { silent: true },
    )
      .then(function (files) {
        if (seq !== previewSeq || formModalEl.hidden) return;
        renderPreviewFiles(files);
      })
      .catch(function (err) {
        if (seq !== previewSeq) return;
        renderPreviewFiles([]);
        console.error("预览客户端配置失败", err);
      })
      .then(function () {
        previewBusy = false;
      });
  }

  /** 防抖调度预览：表单里任何输入 / 选择都走这里。 */
  function schedulePreview() {
    if (!formClient || formModalEl.hidden) return;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshPreview, 240);
  }

  /**
   * 表单外壳复位：清掉上一次渲染留下的内容（模型路由槽位 / 枚举选项 / 开关 / 报错）。
   *
   * 必须在**打开表单之前同步**执行：编辑既有供应商要先等 `get_supplier` 返回，
   * 若不先清空，从「模型路由」的供应商切到「余额配置」的供应商时，上一次的主模型 /
   * Haiku 模型等字段会短暂留在表单里（几百毫秒后才被覆盖），看起来就像余额配置的
   * 表单里出现了模型路由配置。
   */
  function resetFormShell() {
    destroyRoutingPickers();
    supModelSlotsEl.innerHTML = "";
    supSwitchesEl.innerHTML = "";
    supOptionsEl.innerHTML = "";
    supCatalogRowsEl.innerHTML = "";
    supModelCatalogEl.hidden = true;
    supRoutingActionsEl.innerHTML = "";
    supCatalogActionsEl.innerHTML = "";
    supEditCommonEl.hidden = true;
    closeCommonConfigPage();
    // 模型列表属于「上一份地址 + 密钥」的取数结果：换一个供应商必须重新获取，
    // 否则下拉里会出现上一个供应商的模型名。
    fetchedModels = [];
    supRoutingSectionEl.hidden = true;
    supApiKeyEl.type = "password";
    supUsageTokenEl.type = "password";
    supToggleKeyEl.textContent = "显示";
    supToggleTokenEl.textContent = "显示";
    keyLinkFallback = "";
    presetModelsUrl = "";
    clearFormErrors();
    updateKeyLink(null);
    clearPreview();
  }

  function openCreateForm(preset) {
    editing = null;
    editingMeta = preset || null;
    closeOverlay(supplierOverlayEl, presetModalEl);
    resetFormShell();
    formTitleEl.textContent = "添加供应商 · " + scopeLabel(scope);

    var createFormat = clientApiFormat(
      (preset && preset.apiFormat) || defaultApiFormatOfScope(),
    );
    // 模型列表地址只能来自预设目录（cc-switch 同源），随表单一起带进「获取模型列表」。
    presetModelsUrl = (preset && preset.modelsUrl) || "";
    fillPicker(pickers.apiFormat, API_FORMATS, createFormat);
    fillPicker(
      pickers.authField,
      authFieldOptions(),
      defaultAuthFieldOfScope(preset, createFormat),
    );
    supNameEl.value = (preset && preset.name) || "";
    supApiKeyEl.value = "";
    supUsageTokenEl.value = "";
    supBaseUrlEl.value = (preset && preset.baseUrl) || "";
    supNoteEl.value = (preset && preset.note) || "";
    updateKeyLink(preset);

    applyFormVisibility();
    renderRoutingFields(null);
    openOverlay(supplierOverlayEl, formModalEl);
    // 预览按当前草稿渲染：新建页一打开就有内容，与编辑页表现一致。
    refreshPreview();
    supNameEl.focus();
  }

  /**
   * 打开编辑表单。
   *
   * 先把表单外壳复位再请求详情：请求期间表单是隐藏的，复位保证它「再次出现」时
   * 只会是当前供应商的内容，绝不会残留上一个供应商的模型路由字段。
   */
  function openEditForm(card) {
    editing = { slug: card.slug };
    editingMeta = {
      logo: card.logo,
      category: card.category,
      homepage: card.homepage,
      apiKeyUrl: card.apiKeyUrl,
    };
    resetFormShell();
    // 预设目录里带着各家官网的「获取 API Key」地址与「模型列表地址」：老供应商
    // （早期版本迁移出来的）没有存这些字段，按标识 / 名称回查一次补齐，
    // 保证编辑页与新建页表现一致。
    loadPresetMeta().then(function (map) {
      if (!editing) return;
      var entry = map[editing.slug] || {};
      keyLinkFallback = entry.apiKeyUrl || "";
      presetModelsUrl = entry.modelsUrl || "";
      refreshKeyLink();
    });
    CFG.callApi(
      "get_supplier",
      { scope: scope, slug: card.slug },
      { silent: true },
    )
      .then(function (detail) {
        closeOverlay(supplierOverlayEl, presetModalEl);
        formTitleEl.textContent = "编辑供应商 · " + scopeLabel(scope);

        // 历史数据里可能落盘的是该客户端讲不了的协议（早期版本沿用 Anthropic），
        // 表单统一按客户端能力回落，避免一打开就显示成 Anthropic。
        var editFormat = clientApiFormat(detail.apiFormat);
        fillPicker(pickers.apiFormat, API_FORMATS, editFormat);
        fillPicker(
          pickers.authField,
          authFieldOptions(),
          detail.authField || defaultAuthFieldOfScope(null, editFormat),
        );
        supNameEl.value = detail.name || "";
        supApiKeyEl.value = detail.apiKey || "";
        // 平台令牌始终回填（即使当前开关关闭）：否则保存会把已存的令牌清空。
        supUsageTokenEl.value = detail.usageToken || "";
        supBaseUrlEl.value = detail.baseUrl || "";
        supNoteEl.value = detail.note || "";
        updateKeyLink({ apiKeyUrl: detail.apiKeyUrl });
        applyFormVisibility();
        renderRoutingFields(detail.routing);
        openOverlay(supplierOverlayEl, formModalEl);
        refreshPreview();
      })
      .catch(function (err) {
        CFG.notify("error", "读取配置失败：" + errText(err));
      });
  }

  /**
   * 「获取 API Key」链接的地址来源，两级：详情里读到的最优先，预设目录回查的兜底。
   *
   * 分开存是因为两者到达时间不同：详情要等 IPC，预设回查要等文件读盘，
   * 谁先到都先把这一行显示出来，不会出现「先隐藏、几百毫秒后才冒出来」的闪动。
   */
  var keyLinkUrl = "";
  var keyLinkFallback = "";

  function updateKeyLink(source) {
    keyLinkUrl = source && source.apiKeyUrl ? String(source.apiKeyUrl) : "";
    refreshKeyLink();
  }

  function refreshKeyLink() {
    var url = keyLinkUrl || keyLinkFallback;
    supKeyLinkRowEl.hidden = !url;
    supKeyLinkEl.dataset.url = url;
  }

  /** 预设目录的元数据缓存：供应商标识 / 名称 → `{ apiKeyUrl, modelsUrl }`。 */
  var presetMeta = null;
  /**
   * 当前表单所用供应商的「模型列表地址」。
   *
   * 少数网关的模型列表不在 `{base}/v1/models`（如 DeepSeek 是 `{base}/models`、
   * ppio / novita / jiekou 走 `/openai/v1/models`），cc-switch 因此在预设里显式声明
   * `modelsUrl`；带上它就不会先撞一记 404（个别网关会把它回成 401，那样就永远取不到列表）。
   */
  var presetModelsUrl = "";

  /**
   * 按供应商标识从预设目录回查官网的 API Key 页面地址与模型列表地址。
   *
   * 预设文件里本来就带着 `apiKeyUrl` / `modelsUrl`（cc-switch 同源），因此不必在后端
   * 再维护一份；标识与展示名都作为键，兼容「目录名按 host 推断」与「预设 id」不一致的供应商。
   */
  function loadPresetMeta() {
    if (presetMeta) return Promise.resolve(presetMeta);
    return loadPresetManifest()
      .then(function () {
        return Promise.all(allPresetFiles().map(loadPresetFile));
      })
      .then(function (groups) {
        var map = {};
        groups.forEach(function (list) {
          list.forEach(function (preset) {
            var entry = {
              apiKeyUrl: preset.apiKeyUrl || preset.websiteUrl || "",
              modelsUrl: preset.modelsUrl || "",
            };
            if (!entry.apiKeyUrl && !entry.modelsUrl) return;
            [preset.id, preset.name].forEach(function (key) {
              var name = String(key || "")
                .trim()
                .toLowerCase();
              if (name && !map[name]) map[name] = entry;
            });
          });
        });
        presetMeta = map;
        return map;
      })
      .catch(function () {
        presetMeta = {};
        return presetMeta;
      });
  }

  /** 读取下拉取值；实例缺失（降级）时回落默认值，保证请求体始终合法。 */
  function pickerValue(picker, fallback) {
    return picker ? picker.getValue() : fallback;
  }

  /** 表单 → 保存请求体（与后端 SupplierSaveDto 字段一一对应）。 */
  function buildPayload() {
    var meta = editingMeta || {};
    var routing = null;
    if (formClient) {
      var modelMap = {};
      // 每行的「实际请求模型」：1M 标记以勾选框为准（用户手打的标记按勾选态校正），
      // 与后端渲染时的规则一致，避免「界面显示不带标记、落盘却带」。
      supModelSlotsEl.querySelectorAll(".sup-slot").forEach(function (input) {
        var raw = input.value.trim();
        if (!raw) return;
        var row = input.closest(".sup-model-row");
        var box = row ? row.querySelector(".sup-one-m-box") : null;
        modelMap[input.dataset.key] = box
          ? box.checked
            ? setOneM(raw, true)
            : stripOneM(raw)
          : raw;
      });
      var displayMap = {};
      supModelSlotsEl
        .querySelectorAll(".sup-display")
        .forEach(function (input) {
          var value = stripOneM(input.value);
          if (value) displayMap[input.dataset.key] = value;
        });
      var switches = {};
      supSwitchesEl.querySelectorAll(".sup-switch").forEach(function (input) {
        switches[input.dataset.key] = !!input.checked;
      });
      var options = {};
      Object.keys(routingOptionPickers).forEach(function (key) {
        var picked = routingOptionPickers[key].getValue();
        if (picked) options[key] = picked;
      });
      var catalogLayout = isCatalogLayout();
      var oneMBox = el("supOneMBox");
      var oneM = catalogLayout && !!(oneMBox && oneMBox.checked);
      var compactBox = el("supCompactBox");
      var compactInput = el("supCompactLimit");
      var compact = oneM && !!(compactBox && compactBox.checked);
      routing = {
        clientId: scope,
        modelMap: modelMap,
        displayMap: displayMap,
        // 「支持1M」是 Codex 上下文的唯一开关：勾选写 1M 窗口，未勾选一律不写
        // （Claude 的上下文窗口配置项已移除，同样不写）。
        contextWindow: oneM ? CODEX_1M_WINDOW : 0,
        compactTokenLimit: compact
          ? parsePositiveInt(compactInput && compactInput.value) ||
            CODEX_1M_COMPACT
          : 0,
        modelCatalog: catalogLayout ? collectCatalogRows() : [],
        switches: switches,
        options: options,
      };
    }

    return {
      scope: scope,
      slug: editing ? editing.slug : "",
      name: supNameEl.value.trim(),
      note: supNoteEl.value.trim(),
      category:
        meta.category || (scope === BALANCE_SCOPE ? "自定义" : "第三方"),
      logo: meta.logo || "",
      homepage: meta.homepage || "",
      apiKeyUrl: meta.apiKeyUrl || "",
      apiKey: supApiKeyEl.value.trim(),
      usageToken: supUsageTokenEl.value.trim(),
      baseUrl: supBaseUrlEl.value.trim().replace(/\/+$/, ""),
      fullUrl: false,
      apiFormat: pickerValue(pickers.apiFormat, "openai"),
      // 客户端列表下认证字段由注册表定词表（Codex 没有该项，取空串，后端按 scope 收敛）。
      authField: pickerValue(pickers.authField, ""),
      endpointCandidates: [],
      routing: routing,
    };
  }

  /** 读取模型映射表格的当前内容（空模型名的行不落盘，等同未添加）。 */
  function collectCatalogRows() {
    var rows = [];
    if (!supCatalogRowsEl) return rows;
    supCatalogRowsEl.querySelectorAll(".sup-model-row").forEach(function (row) {
      var modelInput = row.querySelector(".sup-catalog-model");
      var model = modelInput ? modelInput.value.trim() : "";
      if (!model) return;
      var displayInput = row.querySelector(".sup-catalog-display");
      var windowInput = row.querySelector(".sup-catalog-window");
      rows.push({
        displayName: displayInput ? displayInput.value.trim() : "",
        model: model,
        contextWindow: parsePositiveInt(windowInput ? windowInput.value : ""),
        reasoningLevels: levelsOf(row),
      });
    });
    return rows;
  }

  /** 模型映射行里某个必填输入框对应的报错节点（字段行的下一个兄弟）。 */
  function catalogErrorOf(input) {
    var field = input ? input.closest(".sup-model-field") : null;
    var next = field ? field.nextElementSibling : null;
    return next && next.classList.contains("field-error") ? next : null;
  }

  /**
   * 模型映射（Codex）的必填校验：「显示名称」「实际请求模型」都要填写。
   *
   * 二者只填一个时，保存会把这一行**静默丢掉**（空模型名等同「未添加」），用户以为存
   * 进去了、/model 里却始终看不到；反过来缺显示名称则会写出一个没有名字的目录项。
   * 因此：
   * - 某一行开始填了（四个配置项里任意一项有内容）→ 两项必须齐全；
   * - **用户点了「添加模型」新加的行**（`data-added`）→ 即使一个字没填也要补齐，
   *   不能让「点了添加却没填」被当成空行悄悄丢掉；
   * - 只有表单初始化出来的空行（没有新加标记、四项全空）才视为「还没添加」，不拦保存。
   * 报错落在各自输入框正下方。
   */
  function validateCatalogRows() {
    var result = { ok: true, first: null };
    if (!isCatalogLayout() || !supCatalogRowsEl) return result;
    supCatalogRowsEl.querySelectorAll(".sup-model-row").forEach(function (row) {
      var displayInput = row.querySelector(".sup-catalog-display");
      var modelInput = row.querySelector(".sup-catalog-model");
      var windowInput = row.querySelector(".sup-catalog-window");
      var display = displayInput ? displayInput.value.trim() : "";
      var model = modelInput ? modelInput.value.trim() : "";
      var windowValue = windowInput ? windowInput.value.trim() : "";
      var untouched =
        !display && !model && !windowValue && !levelsOf(row).length;
      if (untouched && row.dataset.added !== "1") return;
      if (!display) {
        setFieldError(
          displayInput,
          catalogErrorOf(displayInput),
          "请填写显示名称",
        );
        result.ok = false;
        result.first = result.first || displayInput;
      }
      if (!model) {
        setFieldError(
          modelInput,
          catalogErrorOf(modelInput),
          "请填写实际请求模型",
        );
        result.ok = false;
        result.first = result.first || modelInput;
      }
    });
    return result;
  }

  /** 清掉模型映射行自身的报错态（重新校验前、以及用户正在补全时）。 */
  function clearCatalogErrors() {
    if (!supCatalogRowsEl) return;
    supCatalogRowsEl.querySelectorAll(".sup-model-row").forEach(function (row) {
      row.querySelectorAll(".sup-model-field").forEach(function (field) {
        var input = field.querySelector(
          ".sup-catalog-display, .sup-catalog-model",
        );
        if (input) setFieldError(input, catalogErrorOf(input), "");
      });
    });
  }

  /** 强校验：必填项为空或格式非法时，输入框进入错误态并给出原因。 */
  function validateForm() {
    clearFormErrors();
    var ok = true;
    var firstInvalid = null;

    if (!supNameEl.value.trim()) {
      setFieldError(supNameEl, supNameErrorEl, "请填写供应商名称");
      ok = false;
      firstInvalid = firstInvalid || supNameEl;
    }
    if (!supApiKeyEl.value.trim()) {
      setFieldError(supApiKeyEl, supApiKeyErrorEl, "请填写 API Key");
      ok = false;
      firstInvalid = firstInvalid || supApiKeyEl;
    }
    var baseUrl = supBaseUrlEl.value.trim();
    if (!baseUrl) {
      setFieldError(supBaseUrlEl, supBaseUrlErrorEl, "请填写请求地址");
      ok = false;
      firstInvalid = firstInvalid || supBaseUrlEl;
    } else if (!/^https?:\/\//i.test(baseUrl)) {
      setFieldError(
        supBaseUrlEl,
        supBaseUrlErrorEl,
        "请求地址必须以 http:// 或 https:// 开头",
      );
      ok = false;
      firstInvalid = firstInvalid || supBaseUrlEl;
    }

    var catalog = validateCatalogRows();
    if (!catalog.ok) {
      ok = false;
      firstInvalid = firstInvalid || catalog.first;
    }

    if (!ok && firstInvalid) firstInvalid.focus();
    return ok;
  }

  /** 把后端校验错误定位到对应输入框，避免用户只能看一条笼统文案。 */
  function locateBackendError(message) {
    var text = String(message || "");
    if (text.indexOf("名称") !== -1) {
      setFieldError(supNameEl, supNameErrorEl, text);
      return;
    }
    if (text.indexOf("API-KEY") !== -1 || text.indexOf("API Key") !== -1) {
      setFieldError(supApiKeyEl, supApiKeyErrorEl, text);
      return;
    }
    if (text.indexOf("请求地址") !== -1) {
      setFieldError(supBaseUrlEl, supBaseUrlErrorEl, text);
      return;
    }
  }

  function saveForm() {
    if (busy) return;
    if (!validateForm()) return;
    busy = true;
    setBusy(supplierSaveEl, true, "保存中");
    // 保存成功后表单就关了，提醒语要在这里先算好（模型映射非空时 Codex 需要重启才看得到新模型）。
    var hint =
      isCatalogLayout() && collectCatalogRows().length
        ? restartHint(scope)
        : "";
    CFG.callApi(
      "save_supplier",
      { payload: buildPayload() },
      { silent: true, errorPrefix: "保存供应商失败" },
    )
      .then(function (detail) {
        setBusy(supplierSaveEl, false);
        busy = false;
        closeSupplierOverlay();
        CFG.notify("success", "已保存「" + detail.name + "」" + hint);
        renderList();
      })
      .catch(function (err) {
        setBusy(supplierSaveEl, false);
        busy = false;
        var message = errText(err);
        locateBackendError(message);
        CFG.notify("error", message);
      });
  }

  // ===== 模型路由：取模型列表 / 一键配置 =====
  //
  // 「获取模型列表」按**当前草稿**（请求地址 / API Key / 认证字段）取供应商的可用模型，
  // 因此用户不必先保存；取到之后各行的「实际请求模型」右侧才出现可搜索下拉。

  /** 文字按钮的处理中态（图标按钮用的是另一套 setBusy，二者观感一致）。 */
  function setMiniBusy(btn, flag, busyText) {
    if (!btn) return;
    btn.disabled = flag;
    btn.classList.toggle("busy", flag);
    if (flag) {
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.textContent = busyText;
    } else if (btn.dataset.label) {
      btn.textContent = btn.dataset.label;
      delete btn.dataset.label;
    }
  }

  /** 取模型列表：未填 / 填错密钥一律提示「API Key无效或无权限」（与后端同一句文案）。 */
  function fetchModels(btn) {
    if (fetchingModels) return;
    var baseUrl = supBaseUrlEl.value.trim().replace(/\/+$/, "");
    var apiKey = supApiKeyEl.value.trim();
    if (!baseUrl) {
      setFieldError(supBaseUrlEl, supBaseUrlErrorEl, "请先填写请求地址");
      supBaseUrlEl.focus();
      return;
    }
    if (!apiKey) {
      setFieldError(supApiKeyEl, supApiKeyErrorEl, MSG_INVALID_API_KEY);
      CFG.notify("error", MSG_INVALID_API_KEY);
      supApiKeyEl.focus();
      return;
    }
    fetchingModels = true;
    setMiniBusy(btn, true, "获取中");
    CFG.callApi(
      "fetch_models",
      {
        payload: {
          baseUrl: baseUrl,
          apiKey: apiKey,
          apiFormat: pickerValue(pickers.apiFormat, "openai"),
          fullUrl: false,
          modelsUrl: presetModelsUrl,
        },
      },
      { silent: true },
    )
      .then(function (models) {
        fetchedModels = Array.isArray(models) ? models : [];
        setFieldError(supApiKeyEl, supApiKeyErrorEl, "");
        if (!fetchedModels.length) {
          CFG.notify("warn", "未找到可用模型");
          return;
        }
        showModelPickers();
        CFG.notify("success", "已获取 " + fetchedModels.length + " 个模型");
      })
      .catch(function (err) {
        var message = errText(err);
        if (message.indexOf(MSG_INVALID_API_KEY) !== -1) {
          setFieldError(supApiKeyEl, supApiKeyErrorEl, MSG_INVALID_API_KEY);
        }
        CFG.notify("error", message);
      })
      .then(function () {
        fetchingModels = false;
        setMiniBusy(btn, false);
      });
  }

  /**
   * 一键配置：取**第一个已填的档位模型**（Sonnet → Opus → Fable → Haiku → 子代理），
   * 批量填充到所有角色的「显示名称」与「实际请求模型」；各行自己的 1M 勾选态保持不变。
   */
  function quickSet() {
    var rows = [];
    supModelSlotsEl.querySelectorAll(".sup-model-row").forEach(function (row) {
      rows.push({
        row: row,
        input: row.querySelector(".sup-slot"),
        box: row.querySelector(".sup-one-m-box"),
      });
    });
    var source = "";
    rows.forEach(function (item) {
      if (!source && item.input && item.input.value.trim()) {
        source = stripOneM(item.input.value);
      }
    });
    if (!source) {
      CFG.notify("warn", "请先填写至少一个模型");
      return;
    }
    rows.forEach(function (item) {
      if (!item.input) return;
      item.input.value =
        item.box && item.box.checked ? setOneM(source, true) : source;
      var display = item.row.querySelector(".sup-display");
      if (display) display.value = source;
    });
    schedulePreview();
    CFG.notify("success", "已将模型应用到所有角色");
  }

  /** 模型路由分区内的按钮统一用事件委托处理（按钮宿主会被重建）。 */
  function onRoutingClick(e) {
    var btn = e.target.closest("button");
    if (!btn) return;
    if (btn.id === "supFetchModels") {
      fetchModels(btn);
      return;
    }
    if (btn.id === "supQuickSet") {
      quickSet();
      return;
    }
    if (btn.id === "supAddCatalogModel") {
      appendCatalogRow(null);
      return;
    }
    if (btn.classList.contains("sup-catalog-del")) {
      removeCatalogRow(btn);
      return;
    }
    if (btn.id === "supEditCommon") openCommonConfigPage();
  }

  /** 模型路由分区内的勾选：1M 标记跟随勾选态拼到 / 剥出模型名。 */
  function onRoutingChange(e) {
    var target = e.target;
    if (!target || !target.classList) return;
    if (target.classList.contains("sup-one-m-box")) {
      if (target.disabled) return;
      var row = target.closest(".sup-model-row");
      var input = row ? row.querySelector(".sup-slot") : null;
      if (input) input.value = setOneM(input.value, target.checked);
      schedulePreview();
      return;
    }
    if (target.id === "supOneMBox" || target.id === "supCompactBox") {
      syncOneMInputs();
      schedulePreview();
    }
  }

  /**
   * 模型映射必填项的即时提示消除：用户正在补全的字段不必再挂着「请填写…」。
   * 用 `input`（不是 `change`）——`change` 要等失焦才触发，提示会一直留到那时。
   */
  function onCatalogInput(e) {
    var target = e.target;
    if (!target || !target.classList) return;
    if (
      target.classList.contains("sup-catalog-display") ||
      target.classList.contains("sup-catalog-model")
    ) {
      setFieldError(target, catalogErrorOf(target), "");
    }
  }

  // ===== 用量统计面板 =====
  //
  // 与官网用量页一致：顶部一个日期筛选下拉，选「自定义」时右侧平滑展开自建日历；
  // 柱状图的聚合步长由筛选口径决定；下方账单固定展示**最近一年**的每日消费明细。
  //
  // 打开面板分两步取数：先读本地历史（`get_supplier_usage_cached`，一次文件读取，
  // 立刻出图与账单），再用在线结果覆盖（`get_supplier_usage`）。两步**严格串行**，
  // 并行会让先到的在线结果被更慢的缓存响应盖回旧数据。因此用户不必盯着空白面板
  // 等官网接口往返，账单与柱状图在同一帧里就渲染完了。

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  /** 今天（本地零点）。 */
  function todayDate() {
    var now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  /** `Date` → `YYYY-MM-DD`。 */
  function keyOf(date) {
    return (
      date.getFullYear() +
      "-" +
      pad2(date.getMonth() + 1) +
      "-" +
      pad2(date.getDate())
    );
  }

  /** `YYYY-MM-DD` → 本地零点的 `Date`；非法输入返回 `null`。 */
  function dateOf(key) {
    var text = String(key || "");
    if (text.length !== 10) return null;
    var parts = text.split("-");
    var date = new Date(
      Number(parts[0]),
      Number(parts[1]) - 1,
      Number(parts[2]),
    );
    return isNaN(date.getTime()) ? null : date;
  }

  /** 在某个日期上加减天数（返回新对象，不改动入参）。 */
  function shiftDays(date, days) {
    var next = new Date(date.getTime());
    next.setDate(next.getDate() + days);
    return next;
  }

  /** 两个日期相差的天数（双方都是本地零点，忽略夏令时的亚小时误差）。 */
  function daysBetween(from, to) {
    return Math.round((to.getTime() - from.getTime()) / 86400000);
  }

  /**
   * 当前筛选对应的取数区间与聚合步长。
   *
   * 「本月」是「当月 1 日 → 今天」，因此跨天后展示范围会自动跟着变长。
   */
  function activeRange() {
    var meta =
      USAGE_RANGES.filter(function (item) {
        return item.value === usageRange;
      })[0] || USAGE_RANGES[2];
    var today = todayDate();
    var start = today;
    var end = today;
    if (meta.value === "yesterday") {
      start = shiftDays(today, -1);
      end = start;
    } else if (meta.value === "last7") {
      start = shiftDays(today, -6);
    } else if (meta.value === "last30") {
      start = shiftDays(today, -29);
    } else if (meta.value === "thisMonth") {
      start = new Date(today.getFullYear(), today.getMonth(), 1);
    } else if (meta.value === "lastMonth") {
      start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      end = new Date(today.getFullYear(), today.getMonth(), 0);
    } else if (meta.value === "lastYear") {
      // 近一年 = 含本月在内的 12 个自然月（按月聚合，横轴按季度取标签）。
      start = new Date(today.getFullYear(), today.getMonth() - 11, 1);
      end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    } else if (meta.value === "custom") {
      start = dateOf(usageCustom.start) || shiftDays(today, -6);
      end = dateOf(usageCustom.end) || today;
    }
    return { meta: meta, start: start, end: end };
  }

  /** 逐日用量索引：日期 → 金额。 */
  function usageByDate() {
    var map = {};
    ((usageReport && usageReport.points) || []).forEach(function (point) {
      var date = String(point.date || "");
      if (date.length !== 10) return;
      map[date] = Number(point.usage) || 0;
    });
    return map;
  }

  /**
   * 逐桶的模型明细索引（每个模型的金额 + 三类 Token）。
   *
   * 刻意分成「天」与「小时」两套：同一份官方数据既按天下发（`points`）又按小时下发
   * （`hourly`），混进一张索引会把同一天**重复累加**（今天既是 1 个天桶又是 24 个小时桶）。
   */
  function modelBuckets() {
    var days = {};
    var hours = {};
    function absorb(store, key, models) {
      if (!key || !models || !models.length) return;
      var bucket = store[key] || (store[key] = []);
      models.forEach(function (item) {
        var name = String(item.model || "");
        if (!name) return;
        var row = bucket.filter(function (entry) {
          return entry.model === name;
        })[0];
        if (!row) {
          row = { model: name, cost: 0, hit: 0, miss: 0, out: 0 };
          bucket.push(row);
        }
        row.cost += Number(item.cost) || 0;
        row.hit += Number(item.hit) || 0;
        row.miss += Number(item.miss) || 0;
        row.out += Number(item.out) || 0;
      });
    }
    ((usageReport && usageReport.points) || []).forEach(function (point) {
      absorb(days, String(point.date || ""), point.models);
    });
    ((usageReport && usageReport.hourly) || []).forEach(function (item) {
      absorb(
        hours,
        String(item.date || "") + " " + pad2(Number(item.hour) || 0),
        item.models,
      );
    });
    return { days: days, hours: hours };
  }

  /** 把某个月份下所有天的模型明细汇总成一份（月桶用）。 */
  function monthModels(days, month) {
    var merged = [];
    Object.keys(days).forEach(function (date) {
      if (date.slice(0, 7) !== month) return;
      days[date].forEach(function (item) {
        var row = merged.filter(function (entry) {
          return entry.model === item.model;
        })[0];
        if (!row) {
          row = { model: item.model, cost: 0, hit: 0, miss: 0, out: 0 };
          merged.push(row);
        }
        row.cost += item.cost;
        row.hit += item.hit;
        row.miss += item.miss;
        row.out += item.out;
      });
    });
    return merged;
  }

  /** 千分位 Token 数字（Token 动辄上亿，逗号分组才读得出来）。 */
  function tokenText(value) {
    var num = Number(value);
    if (!isFinite(num) || num <= 0) return "0";
    var text = String(Math.round(num));
    return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  /** 逐日刻度：区间内每一天都占一个刻度。 */
  function dailySeries(active) {
    var usage = usageByDate();
    var buckets = modelBuckets().days;
    var series = { labels: [], values: [], names: [], models: [] };
    for (
      var cursor = new Date(active.start.getTime());
      cursor.getTime() <= active.end.getTime();
      cursor = shiftDays(cursor, 1)
    ) {
      var key = keyOf(cursor);
      var amount = usage[key] || 0;
      series.labels.push(key.slice(5));
      series.names.push(key);
      series.values.push(hasSpend(amount) ? amount : null);
      series.models.push(buckets[key] || []);
    }
    return series;
  }

  /** 逐月刻度：区间内每个自然月都占一个刻度（标签写成 `26-09`）。 */
  function monthlySeries(active) {
    var totals = {};
    var usage = usageByDate();
    Object.keys(usage).forEach(function (date) {
      var month = date.slice(0, 7);
      totals[month] = (totals[month] || 0) + usage[date];
    });
    var series = { labels: [], values: [], names: [], models: [] };
    var days = modelBuckets().days;
    var cursor = new Date(
      active.start.getFullYear(),
      active.start.getMonth(),
      1,
    );
    while (cursor.getTime() <= active.end.getTime()) {
      var month = cursor.getFullYear() + "-" + pad2(cursor.getMonth() + 1);
      var amount = totals[month] || 0;
      series.labels.push(month.slice(2));
      series.names.push(
        cursor.getFullYear() + " 年 " + (cursor.getMonth() + 1) + " 月",
      );
      series.values.push(hasSpend(amount) ? amount : null);
      // 月桶的模型明细 = 该月各天之和（只从「天」索引汇总，避免与小时桶重复）。
      series.models.push(monthModels(days, month));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
    return series;
  }

  /**
   * 按当前筛选组装柱状序列（每个刻度都要占位，否则横轴标签会错位）。
   *
   * 没有消费的日期 / 时段取值为 `null`：**不画柱子**，但刻度与标签照常保留——
   * 这正是「消费为 0 的日期不渲染柱状图，但 x 轴标签不受影响」。
   */
  function buildBars() {
    var active = activeRange();
    var bucket = active.meta.bucket;
    var series;
    if (bucket === "hour") {
      // 单日按小时：24 个刻度，数据来自官网单日窗口回传的逐小时明细。
      var dayKey = keyOf(active.start);
      var hours = {};
      ((usageReport && usageReport.hourly) || []).forEach(function (item) {
        if (String(item.date || "") !== dayKey) return;
        hours[Number(item.hour)] = Number(item.usage) || 0;
      });
      if (!Object.keys(hours).length) {
        // 没有逐小时明细时退化为「当日合计」一根柱：官方接口只在**单日窗口**才回传
        // 小时桶，未开启「令牌用量统计」时根本没有小时口径——这时画一根当日合计柱，
        // 比留一张只有刻度的空图更有信息量（数据仍与面板其它口径同源）。
        var dayAmount = usageByDate()[dayKey] || 0;
        series = {
          labels: [dayKey.slice(5)],
          names: [dayKey],
          values: [hasSpend(dayAmount) ? dayAmount : null],
          models: [modelBuckets().days[dayKey] || []],
          fallbackDay: true,
        };
        series.range = active;
        return series;
      }
      var hourBuckets = modelBuckets().hours;
      series = { labels: [], values: [], names: [], models: [] };
      for (var hour = 0; hour < 24; hour += 1) {
        var amount = hours[hour] || 0;
        series.labels.push(pad2(hour));
        series.names.push(
          pad2(hour) + ":00 ~ " + pad2((hour + 1) % 24) + ":00",
        );
        series.values.push(hasSpend(amount) ? amount : null);
        series.models.push(hourBuckets[dayKey + " " + pad2(hour)] || []);
      }
    } else {
      series = bucket === "month" ? monthlySeries(active) : dailySeries(active);
    }
    series.range = active;
    return series;
  }

  /** 悬浮提示的标题行：时间段 + 金额 / Token 合计。 */
  function tipHead(name, value) {
    return (
      '<div class="usage-tip-head"><span>' +
      escapeHtml(name) +
      '</span><span class="usage-tip-num">' +
      escapeHtml(value) +
      "</span></div>"
    );
  }

  /**
   * 悬浮提示的一行：左侧名称 + 右侧数字（数字统一走全局颜色）。
   *
   * 传入 `dot` 时在名称左侧补一个色块，与「模型 Token 消耗」标题行右侧图例的小方块
   * 同款（hit / miss / out），让提示框里的三行与图上的三根柱子一眼对得上。
   */
  function tipRow(name, value, dot) {
    return (
      '<div class="usage-tip-row"><span class="usage-tip-name">' +
      (dot ? '<i class="usage-tip-dot usage-tip-dot-' + dot + '"></i>' : "") +
      '<span class="usage-tip-text">' +
      escapeHtml(name) +
      '</span></span><span class="usage-tip-num">' +
      escapeHtml(value) +
      "</span></div>"
    );
  }

  /**
   * 悬浮提示的公共外壳。
   *
   * 外框必须**由 ECharts 自己落色**：它把 tooltip 的底色 / 边框 / 内边距写成行内样式，
   * 样式表压不过行内（曾经把 background 交给 `.usage-tip`，结果行内的 `transparent`
   * 一路把提示框刷成透明，数字直接压在柱子上看不清）。因此这里按当前主题解析出具体色值：
   * 浅色纯白、深色面板色、毛玻璃近白（见 `--tip-bg` / `--tip-border`）。
   * `appendToBody` 让提示框挂在 <body> 上，不会被页面滚动容器裁掉。
   */
  function tipShell() {
    return {
      backgroundColor: themeColor("--tip-bg", "#ffffff"),
      borderColor: themeColor("--tip-border", "rgba(32, 49, 112, 0.14)"),
      borderWidth: 1,
      padding: [8, 10],
      textStyle: {
        color: themeColor("--text", "#203170"),
        fontSize: 12,
        lineHeight: 20,
      },
      // 圆角与阴影没有对应的 tooltip 选项，只能走行内样式（不要在这里写 background：
      // 那会把上面解析好的底色覆盖掉）。
      extraCssText:
        "border-radius:8px;box-shadow:0 8px 24px rgba(15,23,42,0.16);",
      appendToBody: true,
    };
  }

  /**
   * 竖轴数值标签「均分 3 个」：只保留首 / 中 / 末三个刻度的标签，其余一律返回空串。
   *
   * 只改**标签可见性**——刻度数量、步长、刻度间距、网格位置全部照旧交给 ECharts
   * 自行计算（与 x 轴「interval: 0 + formatter 返回空串」是同一套做法）。
   * 不用 axisLabel.interval 是因为它在数值轴（type: "value"）上不生效（实测
   * interval: 0/1/2/99 均为 8 个标签，毫无变化）。
   * 刻度总数在 formatter 被调用时向图表实例回读，因此每次重绘都按真实刻度重新
   * 挑选，三个标签始终铺满竖轴全高度，且随图表高度自适应。
   */
  function yAxisThreeLabels(chart, base) {
    return function (value, index) {
      var total = 0;
      try {
        total = chart
          .getModel()
          .getComponent("yAxis", 0)
          .axis.scale.getTicks().length;
      } catch (err) {
        total = 0;
      }
      var text =
        typeof base === "function" ? base(value, index) : String(value);
      if (total <= 3) return text;
      var middle = Math.round((total - 1) / 2);
      return index === 0 || index === middle || index === total - 1 ? text : "";
    };
  }

  function renderUsageChart(series, animate) {
    if (typeof window.echarts === "undefined") return;
    if (!usageChart) {
      usageChart = window.echarts.init(usageChartEl, null, {
        renderer: "canvas",
      });
    } else {
      // 图可能刚从 hidden 里露出来（上一段区间没有金额数据），画布尺寸得先量一次；
      // 但**必须在 setOption 之前**量：setOption 之后立刻 resize 会把刚起步的入场动画
      // 掐断（实测只剩 4 帧，柱子看着是直接出现的）。
      usageChart.resize();
    }
    // 退化为「当日合计」时按天口径展示坐标轴与悬浮文案。
    var hourBucket = series.range.meta.bucket === "hour" && !series.fallbackDay;
    var step = series.range.meta.labelStep;
    usageChart.setOption(
      {
        // 入场动画：柱子从横轴升起。每次打开、以及每次换日期区间后的第一份数据各播一次
        // （见 usageAnimated）。notMerge 才会重放，复用实例靠这一下重新升起。
        animation: !!animate,
        animationDuration: 620,
        animationEasing: "cubicOut",
        grid: { left: 8, right: 12, top: 24, bottom: 4, containLabel: true },
        tooltip: Object.assign(
          {
            trigger: "axis",
            className: "usage-tip",
            // 悬浮口径与渲染步长一致：小时桶写「00:00 ~ 01:00」，天桶写日期，月桶写月份。
            // 第一行固定是「时间段 + 总金额」，之后**按接口实际用到的模型**逐行列出金额，
            // 行数完全由数据决定（某个时间段只用了 1 个模型就只有 1 行）。
            formatter: function (params) {
              if (!params || !params.length) return "";
              var item = params[0];
              var index = Number(item.dataIndex);
              var name = series.names[index] || item.axisValue;
              var currency = usageReport && usageReport.currency;
              // 没有柱（该时间段消费为 0）时金额显示 ￥0.00，而不是一句「无消费」：
              // 与官网用量页一致，也让「0」这件事一眼可比。
              var total =
                item.value === null || item.value === undefined
                  ? 0
                  : Number(item.value) || 0;
              var rows = (series.models && series.models[index]) || [];
              var used = rows
                .filter(function (row) {
                  return hasSpend(row.cost);
                })
                .sort(function (a, b) {
                  return b.cost - a.cost;
                });
              return (
                tipHead(name, money(total, currency)) +
                used
                  .map(function (row) {
                    return tipRow(row.model, money(row.cost, currency));
                  })
                  .join("")
              );
            },
          },
          tipShell(),
        ),
        xAxis: {
          type: "category",
          data: series.labels,
          axisLine: {
            lineStyle: {
              color: themeColor("--border", "rgba(32,49,112,0.16)"),
            },
          },
          axisTick: { show: false },
          axisLabel: {
            color: themeColor("--muted", "#7a87b0"),
            fontSize: 11,
            // interval 设 0 让每个刻度都参与判定，再由 formatter 决定显示哪些：
            // 按小时固定显示 00 / 08 / 15 / 23，按天 / 月每 step 个显示一个。
            interval: 0,
            formatter: hourBucket
              ? function (value) {
                  return HOUR_LABELS.indexOf(value) === -1 ? "" : value + ":00";
                }
              : function (value, index) {
                  return index % step === 0 ? value : "";
                },
          },
        },
        yAxis: {
          type: "value",
          splitLine: {
            lineStyle: {
              color: themeColor("--chart-grid", "rgba(32,49,112,0.08)"),
            },
          },
          axisLabel: {
            color: themeColor("--muted", "#7a87b0"),
            fontSize: 11,
            // 竖轴数值标签只显示 3 个（首 / 中 / 末），见 yAxisThreeLabels。
            formatter: yAxisThreeLabels(usageChart),
          },
        },
        series: [
          {
            type: "bar",
            data: series.values,
            barMaxWidth: 22,
            itemStyle: {
              color: themeColor("--chart-bar", "#2f4699"),
              borderRadius: [4, 4, 0, 0],
            },
          },
        ],
      },
      // 播入场动画的那一次用整体替换（柱子从零升起）；之后的重绘走合并，
      // ECharts 只做「旧值 → 新值」的过渡，不会把正在上升的动画打断、也不会重放一遍。
      !!animate,
    );
  }

  /** 销毁并清空全部模型 Token 图表（重新渲染前、关闭面板时都要）。 */
  function destroyUsageTokenCharts() {
    Object.keys(usageTokenCharts).forEach(function (model) {
      var chart = usageTokenCharts[model];
      if (chart && !chart.isDisposed()) chart.dispose();
    });
    usageTokenCharts = {};
    if (usageTokenChartsEl) usageTokenChartsEl.innerHTML = "";
  }

  /** 单块模型 Token 图表的配置（三个维度各自一根柱）。 */
  function tokenOption(chart, model, series, animate) {
    var buckets = series.models || [];
    var pick = function (field) {
      return buckets.map(function (rows) {
        var row = (rows || []).filter(function (entry) {
          return entry.model === model;
        })[0];
        var value = row ? Number(row[field]) || 0 : 0;
        return value > 0 ? value : null;
      });
    };
    var hourBucket = series.range.meta.bucket === "hour" && !series.fallbackDay;
    var step = series.range.meta.labelStep;
    // 纵轴单位按本图最大用量选定，一条轴只用一种单位（见下方 axisText）。
    var hit = pick("hit");
    var miss = pick("miss");
    var out = pick("out");
    var maxValue = hit.concat(miss, out).reduce(function (max, value) {
      return value && value > max ? value : max;
    }, 0);
    var axisUnit = maxValue >= 1e6 ? "M" : maxValue >= 1e3 ? "K" : "";
    var axisScale = axisUnit === "M" ? 1e6 : axisUnit === "K" ? 1e3 : 1;
    /** 纵轴刻度文案：`64M` / `1.5M` / `200K`（整数不带 `.0`）；量级不够时给裸数字。 */
    var axisText = function (value) {
      var num = Number(value) || 0;
      if (!num) return "0";
      var scaled = num / axisScale;
      if (!axisUnit) return String(Math.round(scaled));
      var text = scaled.toFixed(1);
      return (text.slice(-2) === ".0" ? text.slice(0, -2) : text) + axisUnit;
    };
    return {
      // 与金额图同一套入场动画：每次打开、每次换区间后的第一份数据各播一次。
      animation: !!animate,
      animationDuration: 620,
      animationEasing: "cubicOut",
      grid: { left: 8, right: 12, top: 12, bottom: 4, containLabel: true },
      tooltip: Object.assign(
        {
          trigger: "axis",
          className: "usage-tip",
          // 固定四行：时间段 + 总 Token、命中缓存、未命中缓存、输出。
          formatter: function (params) {
            if (!params || !params.length) return "";
            var index = Number(params[0].dataIndex);
            var name = series.names[index] || params[0].axisValue;
            var rows = (series.models && series.models[index]) || [];
            var row = rows.filter(function (entry) {
              return entry.model === model;
            })[0] || { hit: 0, miss: 0, out: 0 };
            return (
              tipHead(
                name,
                tokenText(row.hit + row.miss + row.out) + " Token",
              ) +
              tipRow("输入（命中缓存）", tokenText(row.hit), "hit") +
              tipRow("输入（未命中缓存）", tokenText(row.miss), "miss") +
              tipRow("输出", tokenText(row.out), "out")
            );
          },
        },
        tipShell(),
      ),
      xAxis: {
        type: "category",
        data: series.labels,
        axisLine: {
          lineStyle: { color: themeColor("--border", "rgba(32,49,112,0.16)") },
        },
        axisTick: { show: false },
        axisLabel: {
          color: themeColor("--muted", "#7a87b0"),
          fontSize: 11,
          interval: 0,
          formatter: hourBucket
            ? function (value) {
                return HOUR_LABELS.indexOf(value) === -1 ? "" : value + ":00";
              }
            : function (value, index) {
                return index % step === 0 ? value : "";
              },
        },
      },
      yAxis: {
        type: "value",
        splitLine: {
          lineStyle: {
            color: themeColor("--chart-grid", "rgba(32,49,112,0.08)"),
          },
        },
        axisLabel: {
          color: themeColor("--muted", "#7a87b0"),
          fontSize: 11,
          // Token 动辄上亿：纵轴统一按「M（百万）/ K（千）」缩写，且单位按本图的
          // 最大用量选定（多的时候刻度是 20M / 40M，少的时候降到 200K / 400K），
          // 一条轴只用一个单位，不会出现 500K 与 1M 混排。刻度步长由 ECharts
          // 按量级自适应，即「多了步长大、少了步长小」；单位缩写之上再套
          // 「只显示 3 个标签」（见 yAxisThreeLabels）。
          formatter: yAxisThreeLabels(chart, axisText),
        },
      },
      series: [
        {
          name: "输入（命中缓存）",
          type: "bar",
          data: hit,
          // 柱宽尽量向金额图看齐（金额图 barMaxWidth = 22）：三个维度同处一组，
          // 一组最多占满整个刻度，装不下时由 ECharts 自行收窄，绝不横向溢出。
          barMaxWidth: 22,
          barGap: "8%",
          barCategoryGap: "18%",
          itemStyle: {
            color: themeColor("--chart-bar", "#2f4699"),
            borderRadius: [3, 3, 0, 0],
          },
        },
        {
          name: "输入（未命中缓存）",
          type: "bar",
          data: miss,
          barMaxWidth: 22,
          barGap: "8%",
          barCategoryGap: "18%",
          itemStyle: {
            color: themeColor("--chart-bar-2", "#6b7cab"),
            borderRadius: [3, 3, 0, 0],
          },
        },
        {
          name: "输出",
          type: "bar",
          data: out,
          barMaxWidth: 22,
          barGap: "8%",
          barCategoryGap: "18%",
          itemStyle: {
            color: themeColor("--chart-bar-3", "#a3aecb"),
            borderRadius: [3, 3, 0, 0],
          },
        },
      ],
    };
  }

  /**
   * 汇总当前区间里真正用到过的模型（按 Token 总量降序）。
   *
   * 画几块、每块里有哪些刻度，全部由接口返回的数据决定：某个时间段只用过一个模型就
   * 只有一项；三个维度都为 0 的模型（官方接口会把所有模型都回一遍，绝大多数是 0）
   * 一律不算，免得界面上排出一串空图。金额图与 Token 图共用这一份判定，
   * 用于决定「画图」还是「显示一行暂无」。
   */
  function tokenModelsOf(series) {
    var totals = {};
    (series.models || []).forEach(function (rows) {
      (rows || []).forEach(function (row) {
        var token = Number(row.hit) + Number(row.miss) + Number(row.out);
        if (!(token > 0)) return;
        var item =
          totals[row.model] ||
          (totals[row.model] = {
            model: row.model,
            token: 0,
          });
        item.token += token;
      });
    });
    // 用量大的模型排在前面：从上到下的顺序与「谁更费」一致。
    return Object.keys(totals)
      .map(function (name) {
        return totals[name];
      })
      .sort(function (a, b) {
        return b.token - a.token;
      });
  }

  /**
   * 模型 Token 柱状图：**每个模型一块独立图表**，自上而下依次排列。
   *
   * 模型集合没变时**复用已有实例**（只 `setOption` 换数据）：取数分「本地缓存 → 在线」
   * 两步，重建实例会让入场动画重放一次，界面上就是柱子连着上升两遍。
   */
  function renderUsageTokenCharts(series, models, animate) {
    if (!usageTokenChartsEl) return;
    if (typeof window.echarts === "undefined") return;
    // 先把不再需要的模型（换区间 / 换供应商后消失的）连同实例一起清掉。
    var alive = {};
    models.forEach(function (item) {
      alive[item.model] = true;
    });
    // 先把不再需要的模型（换区间 / 换供应商后消失的）连同实例与 DOM **一起**清掉。
    // 只 dispose 实例是不够的：块自身还带着二级标题与 128px 高的图容器，留在页面上
    // 就是一块「残留空白」（实测近30天 → 今天 会留下两个 145px 的空块）。
    Array.prototype.slice
      .call(usageTokenChartsEl.querySelectorAll(".usage-token-block"))
      .forEach(function (block) {
        if (alive[block.getAttribute("data-model")]) return;
        block.parentNode.removeChild(block);
      });
    Object.keys(usageTokenCharts).forEach(function (model) {
      if (alive[model]) return;
      var chart = usageTokenCharts[model];
      if (chart && !chart.isDisposed()) chart.dispose();
      delete usageTokenCharts[model];
    });

    var index = 0;
    models.forEach(function (item) {
      var block = usageTokenChartsEl.querySelector(
        '.usage-token-block[data-model="' + modelSelector(item.model) + '"]',
      );
      if (!block) {
        block = document.createElement("div");
        block.className = "usage-token-block";
        block.setAttribute("data-model", item.model);
        var head = document.createElement("div");
        head.className = "usage-token-block-head";
        var name = document.createElement("span");
        name.className = "usage-token-name";
        name.textContent = item.model;
        var total = document.createElement("span");
        total.className = "usage-token-total";
        head.appendChild(name);
        head.appendChild(total);
        var box = document.createElement("div");
        box.className = "usage-token-chart";
        block.appendChild(head);
        block.appendChild(box);
        usageTokenChartsEl.appendChild(block);
      }
      // 二级标题右侧的合计随数据更新（同一个模型换区间后数字会变）。
      block.querySelector(".usage-token-total").textContent =
        tokenText(item.token) + " Token";
      // 顺序按用量从多到少：复用实例时靠 DOM 位置调整，而不是重建。
      var expected = usageTokenChartsEl.children[index];
      if (expected !== block) usageTokenChartsEl.insertBefore(block, expected);
      index += 1;

      var box = block.querySelector(".usage-token-chart");
      var chart = usageTokenCharts[item.model];
      if (!chart || chart.isDisposed()) {
        chart = window.echarts.init(box, null, { renderer: "canvas" });
        usageTokenCharts[item.model] = chart;
      }
      // animate 为真时（本次打开 / 刚换过区间）走整体替换：柱子重新升起一次；
      // 为假时（同一个区间的第二次重绘，如「本地缓存 → 在线」）走合并，
      // ECharts 只做旧值 → 新值的过渡，不会把柱子上升两遍。
      chart.setOption(
        tokenOption(chart, item.model, series, animate),
        !!animate,
      );
    });
  }

  /** 模型名进 CSS 选择器前的转义（模型名可能带 `/`、`.`、空格等）。 */
  function modelSelector(model) {
    return String(model).replace(/["\\]/g, "\\$&");
  }

  /**
   * 逐日账单：固定展示**最近一年**内真正产生消费的日期（新的在前）。
   *
   * 与日期筛选无关（筛选只影响柱状图）：消费为 0 的日期没有信息量
   * （余额一整天没动也会留下一条 0.00），一律不列出。
   */
  function renderDailyBill() {
    var currency = (usageReport && usageReport.currency) || "CNY";
    var floor = keyOf(shiftDays(todayDate(), -(BILL_DAYS - 1)));
    var rows = ((usageReport && usageReport.points) || [])
      .filter(function (point) {
        var date = String(point.date || "");
        return date.length === 10 && date >= floor && hasSpend(point.usage);
      })
      .reverse();
    usageDailyListEl.innerHTML =
      '<div class="usage-daily-head"><span>日期</span><span>消费</span></div>' +
      (rows.length
        ? rows
            .map(function (point) {
              return (
                '<div class="usage-daily-row"><span>' +
                escapeHtml(point.date) +
                "</span><span>" +
                escapeHtml(money(point.usage, currency)) +
                "</span></div>"
              );
            })
            .join("")
        : '<div class="usage-empty">暂无详细账单</div>');
  }

  // ----- 自建日历（自定义区间）-----

  /** 区间摘要：`MM-DD ~ MM-DD（N 天）`。 */
  function calendarFootText() {
    if (!calendar.start)
      return "请选择开始日期（最多 " + CUSTOM_MAX_DAYS + " 天）";
    if (!calendar.end)
      return "起点 " + calendar.start.slice(5) + "，请选择结束日期";
    var from = dateOf(calendar.start);
    var to = dateOf(calendar.end);
    var span = from && to ? daysBetween(from, to) + 1 : 0;
    return (
      calendar.start.slice(5) +
      " ~ " +
      calendar.end.slice(5) +
      "（" +
      span +
      " 天）"
    );
  }

  /**
   * 该日期能否点选。
   *
   * 两条限制：不能选未来（还没发生的消费没有账单），以及**选定起点后最多只能跨
   * `CUSTOM_MAX_DAYS` 天**——超出跨度的日期直接置灰，用户不可能选出比一个月更长的区间。
   */
  function calendarDayDisabled(date) {
    if (date.getTime() > todayDate().getTime()) return true;
    if (!calendar.start || calendar.end) return false;
    var anchor = dateOf(calendar.start);
    if (!anchor) return false;
    return Math.abs(daysBetween(anchor, date)) > CUSTOM_MAX_DAYS - 1;
  }

  /** `YYYY-MM` → 该月 1 日（本地零点）；非法值回落到本月。 */
  function monthOf(key) {
    var text = String(key || "");
    var year = Number(text.slice(0, 4));
    var month = Number(text.slice(5, 7)) - 1;
    if (!isFinite(year) || !isFinite(month) || month < 0 || month > 11) {
      var now = todayDate();
      year = now.getFullYear();
      month = now.getMonth();
    }
    return new Date(year, month, 1);
  }

  /** `Date` → `YYYY-MM`。 */
  function monthKey(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1);
  }

  /**
   * 日历池的首月：让连续日期池覆盖给定起点所在的区间。
   *
   * 池子固定是**两个连续自然月**（首月 + 次月）。起点落在本月时首月取上月，
   * 默认视野因此正好是「上月至当月」；起点在更早的月份时首月取起点所在月，
   * 保证跨月选择的起止两端都落在池子里。
   */
  function calendarAnchorFor(startKey) {
    var start = dateOf(startKey) || todayDate();
    var startMonth = new Date(start.getFullYear(), start.getMonth(), 1);
    var now = todayDate();
    var thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    var anchor =
      startMonth.getTime() === thisMonth.getTime()
        ? new Date(startMonth.getFullYear(), startMonth.getMonth() - 1, 1)
        : startMonth;
    return monthKey(anchor);
  }

  /** 池首月还能否再往后推一格：池尾月不得越过本月（未来没有账单可看）。 */
  function canShiftCalendarForward() {
    var anchor = monthOf(calendar.month);
    var nextTail = new Date(anchor.getFullYear(), anchor.getMonth() + 2, 1);
    var now = todayDate();
    return (
      nextTail.getFullYear() * 12 + nextTail.getMonth() <=
      now.getFullYear() * 12 + now.getMonth()
    );
  }

  /**
   * 渲染日历（纯 DOM，无原生日期控件）。
   *
   * 一个 7 列网格里连续铺开**两个自然月**（首月 1 日 → 次月末日），而不是原来的
   * 单月表：日期跨月无缝续排，选一个跨月的区间不必先翻月。月份切换处插入一条整行
   * 分隔标题，免得把月末与次月初当成相邻两天。
   */
  function renderCalendar() {
    if (!usageCalendarInnerEl) return;
    // 首次打开还没有池首月：默认取「上月」，于是默认视野就是「上月至当月」。
    var anchor = monthOf(calendar.month || calendarAnchorFor(""));
    calendar.month = monthKey(anchor);
    var tail = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    var lastDay = new Date(tail.getFullYear(), tail.getMonth() + 1, 0);

    var html =
      '<div class="usage-calendar-head">' +
      '<button type="button" class="usage-calendar-nav" data-step="-1" aria-label="前两个月">‹</button>' +
      '<span class="usage-calendar-title">' +
      anchor.getFullYear() +
      " 年 " +
      (anchor.getMonth() + 1) +
      " 月 ~ " +
      (tail.getMonth() + 1) +
      " 月</span>" +
      '<button type="button" class="usage-calendar-nav" data-step="1" aria-label="后两个月"' +
      (canShiftCalendarForward() ? "" : " disabled") +
      ">›</button>" +
      "</div>" +
      '<div class="usage-calendar-grid">';
    ["一", "二", "三", "四", "五", "六", "日"].forEach(function (label) {
      html += '<span class="usage-calendar-week">' + label + "</span>";
    });
    // 周一为一周起点：首月 1 日之前的格子留空。
    var column = (anchor.getDay() + 6) % 7;
    for (var blank = 0; blank < column; blank += 1) {
      html += '<span class="usage-calendar-week"></span>';
    }

    var monthSeen = anchor.getMonth();
    for (
      var cursor = new Date(anchor.getTime());
      cursor.getTime() <= lastDay.getTime();
      cursor = shiftDays(cursor, 1)
    ) {
      if (cursor.getMonth() !== monthSeen) {
        // 先补满当前行，再插一条独占整行的月份分隔标题：月份边界才清晰。
        for (; column % 7 !== 0; column += 1) {
          html += '<span class="usage-calendar-week"></span>';
        }
        monthSeen = cursor.getMonth();
        html +=
          '<span class="usage-calendar-month">' +
          cursor.getFullYear() +
          " 年 " +
          (cursor.getMonth() + 1) +
          " 月</span>";
        // 分隔行独占一整行，之后要重新按星期对齐次月的 1 日，
        // 否则「周几」会整整错开，用户会把日期看歪。
        column = (cursor.getDay() + 6) % 7;
        for (var pad = 0; pad < column; pad += 1) {
          html += '<span class="usage-calendar-week"></span>';
        }
      }
      var key = keyOf(cursor);
      var classes = "usage-calendar-day";
      if (key === calendar.start || key === calendar.end) {
        classes += " edge";
      } else if (
        calendar.start &&
        calendar.end &&
        key > calendar.start &&
        key < calendar.end
      ) {
        classes += " in-range";
      }
      html +=
        '<button type="button" class="' +
        classes +
        '" data-date="' +
        key +
        '"' +
        (calendarDayDisabled(cursor) ? " disabled" : "") +
        ">" +
        cursor.getDate() +
        "</button>";
      column += 1;
    }
    html +=
      '</div><div class="usage-calendar-foot">' +
      escapeHtml(calendarFootText()) +
      "</div>";
    usageCalendarInnerEl.innerHTML = html;
  }

  /**
   * 把日历浮层贴合到筛选下拉下方。
   *
   * 与下拉列表同一套「默认向下」规则：下方装不下才翻到上方，必要时再夹取到视口
   * 内。日历是脱离文档流的定尺浮层，所以每次展开 / 翻月 / 窗口变化重算一次即可。
   */
  function placeCalendar() {
    if (!usageCalendarEl || !usageCalendarEl.classList.contains("open")) return;
    var toggle = usageRangePickerEl
      ? usageRangePickerEl.querySelector(".picker-toggle")
      : null;
    var rect = toggle
      ? toggle.getBoundingClientRect()
      : { left: 0, top: 0, bottom: 0 };
    var height = usageCalendarEl.offsetHeight;
    var width = usageCalendarEl.offsetWidth;
    var below = rect.bottom + CALENDAR_GAP;
    var above = rect.top - CALENDAR_GAP - height;
    var top =
      below + height > window.innerHeight - CALENDAR_MARGIN ? above : below;
    top = Math.max(
      CALENDAR_MARGIN,
      Math.min(top, window.innerHeight - CALENDAR_MARGIN - height),
    );
    var maxLeft = Math.max(
      CALENDAR_MARGIN,
      window.innerWidth - width - CALENDAR_MARGIN,
    );
    usageCalendarEl.style.left =
      Math.max(CALENDAR_MARGIN, Math.min(Math.round(rect.left), maxLeft)) +
      "px";
    usageCalendarEl.style.top = Math.round(top) + "px";
  }

  function openCalendar() {
    // 先渲染再展开：过渡一开始就带着完整内容，不会看到格子逐个冒出来。
    renderCalendar();
    usageCalendarEl.classList.add("open");
    placeCalendar();
  }

  function closeCalendar() {
    if (usageCalendarEl) usageCalendarEl.classList.remove("open");
  }

  /** 点选某一天：未选满时依次落「起点 / 终点」，选满后重新开始。 */
  function pickCalendarDay(key) {
    if (!calendar.start || calendar.end) {
      calendar.start = key;
      calendar.end = "";
      renderCalendar();
      return;
    }
    calendar.end = key;
    // 允许倒着选（先点后一天再点前一天）：按时间先后归一化。
    if (calendar.end < calendar.start) {
      var swap = calendar.start;
      calendar.start = calendar.end;
      calendar.end = swap;
    }
    usageCustom = { start: calendar.start, end: calendar.end };
    usageRange = "custom";
    if (usageRangePicker) usageRangePicker.setValue(usageRange);
    closeCalendar();
    // 换区间 = 换一份数据：下一次真正画出数据时重新播一次入场动画。
    usageAnimated = false;
    renderUsage();
    // 区间变了就按新区间重新取数（本地数据只够画已有的那部分）。
    scheduleUsageRefresh();
  }

  /** 连续日期池整体前 / 后挪一个月；已经含本月时不允许再往后（未来没有账单）。 */
  function shiftCalendarMonth(step) {
    if (step > 0 && !canShiftCalendarForward()) return;
    var anchor = monthOf(calendar.month);
    calendar.month = monthKey(
      new Date(anchor.getFullYear(), anchor.getMonth() + step, 1),
    );
    renderCalendar();
    placeCalendar();
  }

  /** 切换筛选口径：选「自定义」时展开日历，其余口径收起日历。 */
  function pickUsageRange(value) {
    usageRange = value;
    if (value === "custom") {
      // 首次进入自定义时先用「最近 7 天」占位，避免图表与账单是空的。
      if (!usageCustom.start || !usageCustom.end) {
        var today = todayDate();
        usageCustom = {
          start: keyOf(shiftDays(today, -6)),
          end: keyOf(today),
        };
      }
      calendar.start = usageCustom.start;
      calendar.end = usageCustom.end;
      // 池首月跟着区间起点走，保证起点与终点都落在两月连续池里。
      calendar.month = calendarAnchorFor(usageCustom.start);
      openCalendar();
    } else {
      closeCalendar();
    }
    // 换区间 = 换一份数据：下一次真正画出数据时重新播一次入场动画。
    usageAnimated = false;
    renderUsage();
    // 换口径就按新区间重新取数。选「自定义」时先按占位的近 7 天展示，
    // 等用户点完起止日期再取数——此时多打一次请求纯属浪费。
    if (value !== "custom") scheduleUsageRefresh();
  }

  function applySourceLabel() {
    var currency = (usageReport && usageReport.currency) || "CNY";
    var sourceLabel =
      usageReport && usageReport.source === "remote"
        ? "账单来源：平台令牌用量" + (currency ? " · " + currency : "")
        : "账单来源：本地余额差值";
    // 回落本地时把原因一并说明（例如「未配置平台令牌」「令牌已失效」），
    // 否则用户只会看到一份与官网对不上的账单，却不知道是取数失败。
    var reason = (usageReport && usageReport.remoteError) || "";
    usageSourceEl.textContent = reason
      ? sourceLabel + "（" + reason + "）"
      : sourceLabel;
    usageSourceEl.title = reason ? "平台令牌用量取数失败：" + reason : "";
    if (usageLoading) {
      // 换筛选条件会真去官网拉对应时间段（「近一年」要按月切片，不是一次请求），
      // 这里给一行提示，免得用户以为界面卡住了。
      usageSourceEl.textContent += " · 正在拉取所选时间段的账单…";
    }
  }

  function setUsageLoading(loading) {
    usageLoading = !!loading;
    applySourceLabel();
  }

  /**
   * 日期筛选联动：换区间后**重新拉取对应时间段的接口数据**并整体重绘。
   *
   * 只对已落盘的数据做本地重聚合是不够的：用户选「近一年」时，跨年那几个月的官方数据
   * 可能从来没取过（回填只覆盖当年），柱子会凭空缺一段。因此这里按所选区间真去取数，
   * 防抖 260ms 避免连点筛选打出一串请求。
   */
  function scheduleUsageRefresh() {
    if (!usageTarget || usageModalEl.hidden) return;
    if (usageRefreshTimer) clearTimeout(usageRefreshTimer);
    usageRefreshTimer = setTimeout(function () {
      usageRefreshTimer = null;
      var active = activeRange();
      var seq = ++usageSeq;
      setUsageLoading(true);
      CFG.callApi(
        "refresh_supplier_usage",
        {
          scope: usageTarget.scope,
          slug: usageTarget.slug,
          start: keyOf(active.start),
          end: keyOf(active.end),
        },
        { silent: true },
      )
        .then(function (report) {
          if (seq !== usageSeq || usageModalEl.hidden) return;
          usageReport = report || {};
          renderUsage();
        })
        .catch(function (err) {
          if (seq !== usageSeq || usageModalEl.hidden) return;
          // 取数失败保留已有数据（本地重聚合的结果仍在图上），只在来源行说明原因。
          usageReport = usageReport || {};
          usageReport.remoteError = errText(err);
        })
        .finally(function () {
          if (seq !== usageSeq) return;
          setUsageLoading(false);
        });
    }, 260);
  }

  /** 在「画图」与「一行暂无」两种形态之间切换：没有数据时收起图，只留一行小字。 */
  function setUsageEmpty(chartEl, blankEl, empty) {
    if (chartEl) chartEl.hidden = !!empty;
    if (blankEl) blankEl.hidden = !empty;
  }

  /** 数据到位前把图与「暂无」一起收起来，只留区块标题。 */
  function hideUsageCharts() {
    [
      usageChartEl,
      usageMoneyEmptyEl,
      usageTokenChartsEl,
      usageTokenEmptyEl,
    ].forEach(function (node) {
      if (node) node.hidden = true;
    });
  }

  function renderUsage() {
    if (usageModalEl.hidden) return;
    var series = buildBars();
    var models = tokenModelsOf(series);
    var hasMoney = series.values.some(function (value) {
      return value !== null && value !== undefined;
    });
    // 换区间后的第一份数据才播入场动画：取数是「本地缓存 → 在线」两步，每步一次重绘，
    // 每次都播就会看到柱子上升两遍。`usageAnimated` 在打开面板、以及每次切换日期
    // 区间时复位，因此「打开一次 + 每个区间各一次」的节奏都能得到一次干净的上升。
    var animate = (hasMoney || models.length > 0) && !usageAnimated;
    if (animate) usageAnimated = true;
    // 顺序要紧：先把有数据的区块「露出来」（没有数据的收到一行小字），再画图。
    // 图必须**在容器可见时**才初始化 / 才量得到尺寸。
    setUsageEmpty(usageChartEl, usageMoneyEmptyEl, !hasMoney);
    setUsageEmpty(usageTokenChartsEl, usageTokenEmptyEl, !models.length);
    if (hasMoney) renderUsageChart(series, animate);
    // 空集合也要走一遍：除了「有则画」，还负责「没有则清」——把上一区间残留的
    // 模型块连同实例一起摘掉，界面上不会留下半块空图。
    renderUsageTokenCharts(series, models, animate);
    renderDailyBill();
  }

  function openUsage(card) {
    usageTitleEl.textContent = "详细账单 · " + card.name;
    // 换一个供应商就是换一份账：筛选与日历区间一并回到初始状态。
    usageReport = null;
    usageRange = DEFAULT_USAGE_RANGE;
    usageCustom = { start: "", end: "" };
    calendar = { month: "", start: "", end: "" };
    usageLoading = false;
    // 新一次打开 = 新一次入场动画：等第一份真的有数据的报表到位再播（只播一次）。
    usageAnimated = false;
    if (usageRefreshTimer) {
      clearTimeout(usageRefreshTimer);
      usageRefreshTimer = null;
    }
    closeCalendar();
    if (usageRangePicker) usageRangePicker.setValue(usageRange);
    usageSourceEl.textContent = "正在加载…";
    usageDailyListEl.innerHTML = "";
    openOverlay(usageOverlayEl, usageModalEl);
    // 数据没到之前两块都收起来（图与「暂无」都不显示），让位给「正在加载…」，
    // 免得先闪一行空态文案又被真实数据顶掉。图表实例也留到真有数据时再建：
    // 入场动画只在「元素第一次被创建」时播，提前建一个空实例会把这次动画吃掉。
    destroyUsageTokenCharts();
    hideUsageCharts();

    var target = { scope: scope, slug: card.slug };
    // 日期筛选联动要按「当前供应商」重新取数，因此把目标记下来。
    usageTarget = target;
    // 每次打开都领一个序号：迟到的旧响应（换了供应商、或面板已关闭）一律丢弃，
    // 否则会把已经画好的图覆盖成别的供应商 / 更旧的一份数据。
    var seq = ++usageSeq;
    var stale = function () {
      return seq !== usageSeq || usageModalEl.hidden;
    };
    var apply = function (report) {
      usageReport = report || {};
      applySourceLabel();
      renderUsage();
    };

    // 两步取数**串行**：先本地缓存立刻出图与账单（「即时显示」的来源），
    // 再让在线结果覆盖。并行会形成竞态——在线结果先回来、随后被较慢的本地
    // 缓存盖回旧数据，表现就是「换了筛选条件，柱状图还是旧的」。
    CFG.callApi("get_supplier_usage_cached", target, { silent: true })
      .catch(function () {
        // 读取失败不提示：紧接着的在线请求还会再试一次，没必要为此报错。
        return null;
      })
      .then(function (report) {
        if (report && !stale()) apply(report);
        return CFG.callApi("get_supplier_usage", target, { silent: true });
      })
      .then(function (report) {
        if (stale()) return;
        apply(report);
      })
      .catch(function (err) {
        if (stale()) return;
        usageSourceEl.textContent = "加载失败：" + errText(err);
        usageSourceEl.title = "";
        // 取数失败：清掉旧报表，两块图都收起来，账单位置改放失败原因——
        // 留着半张上一次的旧图更误导人。
        usageReport = null;
        destroyUsageTokenCharts();
        hideUsageCharts();
        usageDailyListEl.innerHTML =
          '<div class="usage-empty">' + escapeHtml(errText(err)) + "</div>";
      });
  }

  // ===== 事件绑定 =====

  function bindEvents() {
    scopeBalanceEl.addEventListener("click", function () {
      switchScope(BALANCE_SCOPE);
    });
    addSupplierEl.addEventListener("click", openPresetPicker);

    presetSearchEl.addEventListener("input", function () {
      renderPresetList(filterPresets(presetSearchEl.value));
    });
    presetCancelEl.addEventListener("click", closeSupplierOverlay);
    presetCustomEl.addEventListener("click", function () {
      openCreateForm(null);
    });

    supToggleKeyEl.addEventListener("click", function () {
      var showing = supApiKeyEl.type === "text";
      supApiKeyEl.type = showing ? "password" : "text";
      supToggleKeyEl.textContent = showing ? "显示" : "隐藏";
    });
    // 平台令牌与 API Key 用同一套显示 / 隐藏交互。
    supToggleTokenEl.addEventListener("click", function () {
      var showing = supUsageTokenEl.type === "text";
      supUsageTokenEl.type = showing ? "password" : "text";
      supToggleTokenEl.textContent = showing ? "显示" : "隐藏";
    });
    supKeyLinkEl.addEventListener("click", function () {
      openExternal(supKeyLinkEl.dataset.url, "打开 API Key 页面失败");
    });

    supplierSaveEl.addEventListener("click", saveForm);
    supplierCancelEl.addEventListener("click", cancelSupplierForm);
    // 模型路由分区内的按钮 / 勾选都用事件委托：按钮宿主（角色表 / 模型映射）会被重建。
    supRoutingSectionEl.addEventListener("click", onRoutingClick);
    supRoutingSectionEl.addEventListener("change", onRoutingChange);
    supRoutingSectionEl.addEventListener("input", onCatalogInput);
    // 配置预览顶部的文件选择框组：切换查看将要写入的哪个文件。
    if (supPreviewTabsEl) {
      supPreviewTabsEl.addEventListener("click", onPreviewTabClick);
    }
    // 表单里任何输入 / 选择都让预览跟上：input / change 覆盖文本框与开关，
    // click 覆盖自定义下拉的条目选择（它的选中不触发 input 事件）。
    formModalEl.addEventListener("input", schedulePreview);
    formModalEl.addEventListener("change", schedulePreview);
    formModalEl.addEventListener("click", schedulePreview);
    // 通用配置窗口自己的三个动作（窗口不在模型路由分区里，用直接绑定）。
    if (commonConfigSaveEl) {
      commonConfigSaveEl.addEventListener("click", saveCommonConfig);
    }
    if (commonConfigCancelEl) {
      commonConfigCancelEl.addEventListener("click", function () {
        closeCommonConfigPage();
      });
    }
    if (commonConfigExtractEl) {
      commonConfigExtractEl.addEventListener("click", extractCommonConfig);
    }
    if (commonConfigTextEl) {
      commonConfigTextEl.addEventListener("input", syncCommonConfigHeight);
    }
    supplierToggleEl.addEventListener("click", toggleSupplierList);
    // 整行折叠：点击标题行的空白处同样收起 / 展开，与「挂件状态」「高级设置」的
    // 整行按钮交互一致；行内的标签组、添加、官网链接等控件各自处理点击，不在此触发。
    if (supplierHeadEl) {
      supplierHeadEl.addEventListener("click", function (e) {
        if (e.target.closest("button, a")) return;
        toggleSupplierList();
      });
    }

    // 自建日历：翻月与选日期都由事件委托处理（日历内容是整块重绘的）。
    usageCalendarEl.addEventListener("click", function (e) {
      var nav = e.target.closest(".usage-calendar-nav");
      if (nav) {
        shiftCalendarMonth(Number(nav.dataset.step) || 0);
        return;
      }
      var day = e.target.closest(".usage-calendar-day");
      if (day && !day.disabled) pickCalendarDay(day.dataset.date);
    });
    // 日历是固定浮层：点空白处或按 Esc 收起，与下拉列表的交互保持一致。
    // 注意必须放过下拉自身的点击——列表浮层已被挂到 <body>，此时点击的 target
    // 既不在 usageRangePickerEl 里、也不在日历里，若不放行会在「选中自定义」的
    // 那一刻把刚展开的日历立刻关掉。
    document.addEventListener("click", function (e) {
      if (!usageCalendarEl.classList.contains("open")) return;
      // 「点在哪里」必须按**事件派发时**的路径判断：日历选完一天会整块重绘、下拉
      // 选中条目也会整块重绘，被点的元素随即脱离文档树，此时 e.target.closest 与
      // contains 都已找不到祖先，会把刚展开的浮层立刻关掉。
      var path = typeof e.composedPath === "function" ? e.composedPath() : [];
      var inside =
        path.indexOf(usageCalendarEl) !== -1 ||
        path.some(function (node) {
          return (
            node.classList &&
            (node.classList.contains("picker-list") ||
              node.classList.contains("picker-toggle"))
          );
        });
      if (inside) return;
      closeCalendar();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeCalendar();
    });
    usageCloseEl.addEventListener("click", function () {
      closeOverlay(usageOverlayEl, usageModalEl);
      usageReport = null;
      // 关掉面板就收掉联动状态：此后换筛选条件不该再去取数，
      // 已建的 Token 图表也一并销毁，避免留在内存里。
      usageTarget = null;
      usageLoading = false;
      if (usageRefreshTimer) {
        clearTimeout(usageRefreshTimer);
        usageRefreshTimer = null;
      }
      destroyUsageTokenCharts();
      hideUsageCharts();
    });
    // 弹窗 / 页面一律只由显式按钮关闭：不再监听遮罩上的点击，
    // 避免误触空白处导致表单数据丢失。
    // 日历贴在下拉下方：弹窗滚动 / 窗口缩放都会改变触发按钮位置，需重新贴合。
    window.addEventListener("scroll", placeCalendar, true);

    window.addEventListener("resize", function () {
      if (usageChart && !usageModalEl.hidden) usageChart.resize();
      if (!usageModalEl.hidden) {
        Object.keys(usageTokenCharts).forEach(function (model) {
          var chart = usageTokenCharts[model];
          if (chart && !chart.isDisposed()) chart.resize();
        });
      }
      placeCalendar();
    });

    // 全局颜色 / 主题一变就重绘用量页的柱状图：图表把颜色写进 canvas，
    // 认不出 var(--x)，不重绘就会一直停留在上一个主题的配色上。
    // 拖色相滑杆会连续触发，这里做 120ms 防抖——否则每帧都重建一遍 canvas。
    document.addEventListener("dsw:palette-changed", function () {
      if (usageModalEl.hidden) return;
      if (paletteRedrawTimer) clearTimeout(paletteRedrawTimer);
      paletteRedrawTimer = setTimeout(function () {
        paletteRedrawTimer = null;
        if (!usageModalEl.hidden) renderUsage();
      }, 120);
    });
  }

  // ===== 启动 =====

  function bootstrap() {
    if (!supplierCardEl) return;
    // 日历浮层摘到 <body>：否则毛玻璃主题的弹窗（带 backdrop-filter）会成为它的
    // 定位基准，fixed 定位将相对弹窗而非视口，贴合位置就全错了。
    if (usageCalendarEl && usageCalendarEl.parentNode !== document.body) {
      document.body.appendChild(usageCalendarEl);
    }
    bindEvents();
    // 账单的日期筛选下拉复用全局自定义下拉：界面一直在，装配一次即可。
    if (usageRangePickerEl && CFG.createPicker) {
      usageRangePicker = CFG.createPicker(usageRangePickerEl, pickUsageRange);
      usageRangePicker.setItems(
        USAGE_RANGES.map(function (item) {
          return { value: item.value, text: item.label };
        }),
        DEFAULT_USAGE_RANGE,
      );
    }
    CFG.callApi("list_supplier_clients", undefined, { silent: true })
      .then(function (list) {
        clients = Array.isArray(list) ? list : [];
      })
      .catch(function (err) {
        clients = [];
        console.error("读取客户端列表失败", err);
      })
      .then(function () {
        renderScopeTabs();
        formClient = clientById(scope);
        renderList();
      });
  }

  bootstrap();
})();

// 小鲸鱼余额挂件 · 模块化气泡控制器（配置页）
//
// 「气泡管理」卡片在 config.html 里只有静态骨架，模块列表、可选模块区、
// 编辑区拖拽吸附与预览气泡全部由本文件驱动。
//
// 数据形状与后端 `BubbleConfig` 完全一致（camelCase）：
//   { rows: [ { blocks: [ { id, kind, text, linkName, linkUrl, media, mediaWidth,
//                           supplier, fontFamily, fontSize, color, bold, italic,
//                           underline, background, backgroundColor, glow } ] } ] }
// 保存走 config.js 的 `save_bubble`（后端规范化后再落盘）：编辑内容是一份**草稿**，
// 只驱动右侧预览气泡，不广播给桌面挂件。要让桌宠用上它，必须点「应用」
// （另存 / 覆写气泡组）或在下拉栏切换到某个组——那时后端才把该组广播给挂件。
//
// 渲染复用 bubble-blocks.js（window.DSWH）：右侧预览与桌面气泡是同一份代码，
// 预览里看到的排版、字号、颜色与桌面上完全一致。
//
// 依赖：config.js（window.CFG：提示 / IPC / 自定义下拉）、bubble-blocks.js（window.DSWH）。

(function () {
  "use strict";

  var CFG = window.CFG;
  var DSWH = window.DSWH;
  if (!CFG || !DSWH) return;

  // ===== DOM =====
  var bubbleCardEl = document.getElementById("bubbleCard");
  var toggleBubbleEl = document.getElementById("toggleBubble");
  var modularCardEl = document.getElementById("modularCard");
  var modularToggleEl = document.getElementById("modularToggle");
  var bubbleColorEl = document.getElementById("bubbleColor");
  var paletteEl = document.getElementById("bubblePalette");
  var rowsEl = document.getElementById("bubbleRows");
  var emptyEl = document.getElementById("bubbleEmpty");
  var previewEl = document.getElementById("bubblePreview");
  var previewBubbleEl = document.querySelector(".dsb-preview-bubble");
  var groupPickerEl = document.getElementById("bubbleGroupPicker");
  var applyGroupEl = document.getElementById("bubbleApply");
  var groupModalEl = document.getElementById("bubbleGroupModal");
  var groupInputEl = document.getElementById("bubbleGroupInput");
  var groupErrorEl = document.getElementById("bubbleGroupError");
  var groupOkEl = document.getElementById("bubbleGroupOk");
  var groupCancelEl = document.getElementById("bubbleGroupCancel");

  var modalOverlayEl = document.getElementById("modalOverlay");
  var modalEl = document.getElementById("blockModal");
  var titleEl = document.getElementById("blockTitle");
  var blockTextEl = document.getElementById("blockText");
  var linkNameEl = document.getElementById("blockLinkName");
  var linkUrlEl = document.getElementById("blockLinkUrl");
  var mediaPickEl = document.getElementById("blockMediaPick");
  var mediaThumbEl = document.getElementById("blockMediaThumb");
  var mediaNameEl = document.getElementById("blockMediaName");
  var mediaWidthEl = document.getElementById("blockMediaWidth");
  var mediaWidthValEl = document.getElementById("blockMediaWidthVal");
  var supplierPickerEl = document.getElementById("blockSupplierPicker");
  var fontPickerEl = document.getElementById("blockFontPicker");
  var fontPickEl = document.getElementById("blockFontPick");
  var fontSizeEl = document.getElementById("blockFontSize");
  var fontSizeValEl = document.getElementById("blockFontSizeVal");
  var colorEl = document.getElementById("blockColor");
  var bgRowEl = document.getElementById("blockBgRow");
  var bgColorEl = document.getElementById("blockBgColor");
  var glowEl = document.getElementById("blockGlow");
  var errorEl = document.getElementById("blockError");
  var applyEl = document.getElementById("blockApply");
  var cancelEl = document.getElementById("blockCancel");

  if (!rowsEl || !previewEl || !modalEl) return;

  // ===== 状态 =====
  /** 当前气泡配置（唯一的可编辑数据源）。 */
  var bubble = { rows: [], currentGroup: "" };
  /** 数据目录里现存的气泡组名（下拉列表用，不含内置的「默认」组）。 */
  var groups = [];
  /** 内置气泡组：配置里 currentGroup 缺失时的落点，不可删除。 */
  var DEFAULT_GROUP = "默认";
  /** 组名上限（与后端规范化、输入框 maxlength 三处一致）。 */
  var GROUP_NAME_MAX = 16;
  /**
   * 一行最多并排几个模块。
   *
   * 挂件气泡的一行不会换行（超出部分会被裁掉），编辑区因此也必须给一行封顶，
   * 否则用户能拖出气泡里根本显示不下的排列。
   */
  var MAX_ROW_BLOCKS = 5;
  /**
   * 当前组「载入时的样子」：组名 + 行内容快照。
   *
   * 编辑会即时自动保存进当前组，所以磁盘上的这一组会随编辑漂移。用户点「应用」
   * 把编辑区内容另存为新组时，要靠这份快照把源组还原回去（见 restoreSourceGroup），
   * 否则源组被这次另存顺带改写，各组内容越改越像、下拉切换就失去意义。
   */
  var baseline = { group: "", rowsJson: "" };
  /** 余额供应商（余额 / 今日已用模块的数据来源下拉）。 */
  var suppliers = [];
  /** 已上传的字体文件名（字体下拉）。 */
  var fonts = [];
  /** 渲染用的动态数据，形状见 DSWH.renderBlock 的 values 参数。 */
  var values = {
    balance: {},
    today: {},
    countdown: "",
    peak: false,
    media: {},
  };
  /** 媒体 / 字体的内存缓存：同一份资源不重复往返 IPC。 */
  var mediaCache = {};
  var fontLoaded = {};
  var fontStyleEl = null;
  var saveTimer = null;
  var dropEl = null;
  /** 正在配置的模块：`{ block, draft }`。draft 是草稿，取消时整体丢弃。 */
  var editing = null;
  /** 拖拽会话：null 表示未在拖拽。 */
  var drag = null;
  /** 拖拽刚结束：吞掉紧随其后由指针手势带出的那次 click，避免误开配置弹窗。 */
  var ignoreClickUntil = 0;

  var DRAG_THRESHOLD = 4; // 位移阈值（px）：超过才认为是拖拽而不是点击
  var SAVE_DEBOUNCE_MS = 400;
  /**
   * 本地编辑计数器：每次改动配置都 +1。
   *
   * 保存是异步的，回包可能在「又改了一轮」之后才到。用发送时的计数与当前计数比对，
   * 就能识别出过期回包——否则回包里的旧快照会覆盖内存，让编辑区/拖拽基于旧数据工作
   *（实测表现为「拖一次多出一个副本」）。
   */
  var editSeq = 0;

  /** 标记配置被改动（所有写内存的地方都要调用）。 */
  function markEdited() {
    editSeq += 1;
  }

  // ===== 通用小工具 =====

  /**
   * 关键路径兜底：任何异常都不该让整块「气泡管理」崩掉。
   *
   * 提示 + 记录，不向外冒泡（渲染 / 拖拽 / 动画这类高频路径尤其不能被一次异常打断）。
   */
  function guard(label, fn) {
    try {
      return fn();
    } catch (err) {
      console.error("模块化气泡「" + label + "」异常", err);
      if (CFG.notify) {
        CFG.notify(
          "error",
          "模块化气泡「" + label + "」出现异常，已跳过本次操作",
        );
      }
      return undefined;
    }
  }

  /** 深拷贝一个模块（弹窗草稿从它开始改，取消即丢弃）。 */
  function cloneBlock(block) {
    var copy = {};
    for (var key in block) {
      if (Object.prototype.hasOwnProperty.call(block, key))
        copy[key] = block[key];
    }
    return copy;
  }

  /** 全局查找模块。 */
  function findBlock(id) {
    for (var i = 0; i < bubble.rows.length; i++) {
      var blocks = bubble.rows[i].blocks;
      for (var k = 0; k < blocks.length; k++) {
        if (blocks[k].id === id) return blocks[k];
      }
    }
    return null;
  }

  /**
   * 补齐模块标识。
   *
   * 配置来源不止本界面（旧配置、手工编辑过的 config.json 都可能缺少 id），
   * 而删改 / 拖拽定位都依赖 id：缺失或重复时补一个，随后的保存会把它写回配置。
   */
  function ensureBlockIds(rows) {
    var seen = [];
    (rows || []).forEach(function (row) {
      (row.blocks || []).forEach(function (block) {
        if (!block.id || seen.indexOf(block.id) !== -1) block.id = DSWH.newId();
        seen.push(block.id);
      });
    });
  }

  /** 供应商名称（下拉与条目摘要都展示名称，不展示 slug）。 */
  function supplierName(slug) {
    for (var i = 0; i < suppliers.length; i++) {
      if (suppliers[i].slug === slug) return suppliers[i].name;
    }
    return "";
  }

  /** 按 balance.js 的同一规则格式化金额（预览与桌面气泡数字完全一致）。 */
  function fmtMoney(value, currency) {
    var num = Number(value);
    var fixed = isFinite(num) ? num.toFixed(2) : "--";
    var symbol = CFG.currencySymbol(currency);
    if (symbol) return symbol + " " + fixed;
    return currency ? fixed + " " + currency : fixed;
  }

  /** 余额载荷 → 展示文本；取不到（或失败）统一回落占位符 `--`。 */
  function payloadText(payload, field) {
    if (!payload || !payload.ok) return "--";
    var raw = payload[field];
    if (raw === null || raw === undefined) return "--";
    var num = Number(raw);
    if (!isFinite(num)) return "--";
    return fmtMoney(num * (Number(payload.rate) || 1), payload.displayCurrency);
  }

  /** 编辑区条目右侧的内容摘要。 */
  function summaryOf(block) {
    if (block.kind === "text") return block.text || "（空文本）";
    if (block.kind === "link")
      return block.linkName || block.linkUrl || "未设置";
    if (block.kind === "media") return block.media || "未选择图片";
    if (block.kind === "balance" || block.kind === "today") {
      return supplierName(block.supplier) || "默认供应商";
    }
    if (block.kind === "countdown") return "峰谷倒计时";
    return "";
  }

  function modalTitle(kind) {
    if (kind === "balance") return "余额编辑";
    if (kind === "today") return "今日已用编辑";
    if (kind === "countdown") return "倒计时编辑";
    if (kind === "link") return "超链接编辑";
    if (kind === "media") return "媒体编辑";
    return "文本编辑";
  }

  // ===== 保存 =====

  /** 防抖保存：拖动排序 / 改样式时避免逐次落盘。 */
  function save() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      // 记下发送时的编辑计数：回包若已过期（期间又改过）就整份丢弃。
      var seqAtSend = editSeq;
      CFG.callApi(
        "save_bubble",
        { bubble: bubble },
        { errorPrefix: "保存气泡失败" },
      )
        .then(function (saved) {
          if (!saved || !Array.isArray(saved.rows)) return;
          // 拖拽 / 编辑弹窗进行中：整体替换配置会让拖拽引用失效、打断交互。
          if (drag || editing) return;
          // 期间又改过配置：这份回包是旧快照，套上去会把新改动吞掉。
          if (editSeq !== seqAtSend) return;
          bubble = saved;
          // id 是拖拽 / 删除的定位依据：回包缺 id 时补齐，避免后续定位失效。
          ensureBlockIds(bubble.rows);
          renderGroupOptions();
        })
        .catch(function () {
          /* 错误提示已由 callApi 统一弹出 */
        });
    }, SAVE_DEBOUNCE_MS);
  }

  // ===== 气泡组 =====

  /** 当前组名（配置里缺失时按内置「默认」组展示）。 */
  function currentGroupName() {
    return bubble.currentGroup || DEFAULT_GROUP;
  }

  /** 下拉条目：内置「默认」组不可删除，其余自定义组都可删除。 */
  function groupItems() {
    var items = [
      { value: DEFAULT_GROUP, text: DEFAULT_GROUP, deletable: false },
    ];
    groups.forEach(function (name) {
      if (!name || name === DEFAULT_GROUP) return;
      items.push({ value: name, text: name, deletable: true });
    });
    // 当前组不在列表里（列表还没回来 / 刚被删）：补一个不可删的占位项，
    // 避免下拉把选中项错误地显示成「默认」。
    var current = currentGroupName();
    var has = items.some(function (item) {
      return item.value === current;
    });
    if (!has) items.push({ value: current, text: current, deletable: false });
    return items;
  }

  /** 刷新气泡组下拉（选中项始终是当前组）。 */
  function renderGroupOptions() {
    if (!groupPickerEl) return;
    groupPicker.setItems(groupItems(), currentGroupName());
  }

  /** 读取数据目录里的气泡组列表并刷新下拉。 */
  function loadGroups() {
    return CFG.callApi("list_bubble_groups", undefined, {
      errorPrefix: "加载气泡组失败",
    })
      .then(function (list) {
        groups = Array.isArray(list) ? list : [];
        renderGroupOptions();
      })
      .catch(function (err) {
        console.error("加载气泡组失败", err);
        groups = [];
        renderGroupOptions();
      });
  }

  /**
   * 立即落地在途的防抖保存（切组 / 删组前调用）。
   *
   * 编辑后的保存有 400ms 防抖，若用户紧接着切组，这份保存在途时切组请求可能先到后端：
   * 保存回包随后到达，又会把「当前组」改回源组——桌面气泡会当场弹回旧内容，
   * 重启后看到的当前组也不是用户刚选的那个。所以切组 / 删组前必须先把保存落下去，
   * 并且等它回来再发下一个请求（顺序反了同样会被回包覆盖）。
   */
  function flushSave() {
    if (!saveTimer) return Promise.resolve();
    clearTimeout(saveTimer);
    saveTimer = null;
    var seqAtSend = editSeq;
    return CFG.callApi(
      "save_bubble",
      { bubble: bubble },
      { silent: true, errorPrefix: "保存气泡失败" },
    )
      .then(function (saved) {
        if (!saved || !Array.isArray(saved.rows)) return;
        if (editSeq !== seqAtSend) return;
        bubble = saved;
        ensureBlockIds(bubble.rows);
      })
      .catch(function (err) {
        // 保存失败不该挡住切组：错误提示已由 callApi 弹出，这里继续走切换流程。
        console.error("切组前保存气泡失败", err);
      });
  }

  /** 切换气泡组：内容由后端搬进配置，这里只负责回填与提示。 */
  function switchGroup(name) {
    if (!name || name === currentGroupName()) return;
    flushSave()
      .then(function () {
        return CFG.callApi(
          "switch_bubble_group",
          { name: name },
          { errorPrefix: "切换气泡组失败" },
        );
      })
      .then(function (cfg) {
        if (!cfg) return;
        applyBubbleConfig(cfg);
        CFG.notify("success", "已切换到气泡组「" + currentGroupName() + "」");
      })
      .catch(function (err) {
        console.error("切换气泡组失败", err);
        // 切换失败时把下拉拉回真实的当前组，避免界面与配置不一致。
        renderGroupOptions();
      });
  }

  /** 删除气泡组（内置「默认」组不可删）。 */
  function askDeleteGroup(name) {
    if (!name || name === DEFAULT_GROUP) {
      CFG.notify("warn", "默认气泡组不能删除");
      return;
    }
    CFG.showConfirm(
      "删除气泡组「" + name + "」？该组内容将被永久删除。",
      function () {
        // 同切组：先落地在途保存，避免回包晚于删除请求、把已删的组名又写回配置。
        flushSave()
          .then(function () {
            return CFG.callApi(
              "delete_bubble_group",
              { name: name },
              { errorPrefix: "删除气泡组失败" },
            );
          })
          .then(function (cfg) {
            if (!cfg) return;
            applyBubbleConfig(cfg);
            return loadGroups().then(function () {
              CFG.notify("success", "气泡组已删除");
            });
          })
          .catch(function (err) {
            console.error("删除气泡组失败", err);
          });
      },
    );
  }

  function showGroupError(message) {
    groupErrorEl.textContent = message;
    groupErrorEl.hidden = false;
  }

  /** 打开「自定义气泡组」弹窗（把当前编辑内容存成一个新组）。 */
  function openGroupModal() {
    if (!groupModalEl) return;
    groupInputEl.value = "";
    groupErrorEl.textContent = "";
    groupErrorEl.hidden = true;
    groupModalEl.hidden = false;
    modalOverlayEl.hidden = false;
    groupInputEl.focus();
  }

  function closeGroupModal() {
    if (!groupModalEl) return;
    groupModalEl.hidden = true;
    // 模块配置弹窗同时开着时不收起遮罩（两个弹窗不共存，这里只是稳妥处理）。
    if (modalEl.hidden) modalOverlayEl.hidden = true;
  }

  /**
   * 名称校验。
   *
   * 与已有组重名一律阻断，只有一个例外：填的就是当前组名——那表示「把这些改动
   * 存回当前组」，是正常操作（编辑期的自动保存已经落盘，这里只是显式确认一次）。
   */
  function validateGroupName(name) {
    if (!name) return "请输入气泡组名称";
    if (name.length > GROUP_NAME_MAX)
      return "名称最多 " + GROUP_NAME_MAX + " 个字符";
    if (name !== currentGroupName() && groups.indexOf(name) !== -1) {
      return "名称已存在，请换一个";
    }
    return "";
  }

  /**
   * 把源组还原成「载入时的样子」。
   *
   * 编辑期的自动保存会把编辑区内容写进当前组（这是「改动不丢」的代价），
   * 若不做还原，用户点「应用」把这份内容另存为新组时，源组会被顺带改写，
   * 各组内容越改越像——下拉切到哪一组都看到编辑区最新的内容，切换就形同虚设。
   * 还原走静默写入：不动当前配置、不广播，挂件不会闪一下。
   *
   * 注意：覆写当前组（名称填的就是当前组名）时不要调用——那种情况源组就是要被写的那一组。
   */
  function restoreSourceGroup() {
    if (!baseline.group) return Promise.resolve();
    if (baseline.rowsJson === JSON.stringify(bubble.rows || [])) {
      // 编辑区内容与基线一致：源组本来就没被改过，无需还原。
      return Promise.resolve();
    }
    var rows;
    try {
      rows = JSON.parse(baseline.rowsJson);
    } catch (err) {
      console.error("气泡组基线快照损坏", err);
      return Promise.resolve();
    }
    return CFG.callApi(
      "write_bubble_group",
      {
        name: baseline.group,
        bubble: { rows: rows, currentGroup: baseline.group },
      },
      { silent: true, errorPrefix: "还原气泡组失败" },
    ).catch(function (err) {
      console.error("还原气泡组失败", err);
    });
  }

  /**
   * 「应用」：把编辑区内容存成气泡组。
   *
   * - 名称是当前组 → 覆写当前组（显式确认这次编辑），源组即目标，不做还原；
   * - 名称是新的 → 先把源组还原成编辑前的样子，再把这份内容另存为新组并切过去。
   */
  function applyGroupModal() {
    var name = String(groupInputEl.value || "").trim();
    var error = validateGroupName(name);
    if (error) {
      showGroupError(error);
      groupInputEl.focus();
      return;
    }
    var overwrite = name === currentGroupName();
    (overwrite ? Promise.resolve() : restoreSourceGroup())
      .then(function () {
        return CFG.callApi(
          "save_bubble_group",
          { name: name, bubble: bubble },
          { errorPrefix: "保存气泡组失败" },
        );
      })
      .then(function (cfg) {
        if (!cfg) return;
        applyBubbleConfig(cfg);
        // 这次写入就是这一组的新基准：刷新基线，避免之后另存新组时
        // 把刚才显式保存的内容又还原掉。
        baseline.group = currentGroupName();
        baseline.rowsJson = JSON.stringify(bubble.rows || []);
        return loadGroups().then(function () {
          closeGroupModal();
          CFG.notify(
            "success",
            overwrite
              ? "已保存到气泡组「" + currentGroupName() + "」"
              : "气泡组「" + currentGroupName() + "」已保存",
          );
        });
      })
      .catch(function (err) {
        console.error("保存气泡组失败", err);
      });
  }

  function bindGroupEvents() {
    // 「应用」按钮与弹窗是两回事：先绑按钮，再绑弹窗内部控件。
    if (applyGroupEl) applyGroupEl.addEventListener("click", openGroupModal);
    if (!groupModalEl) return;
    groupOkEl.addEventListener("click", function () {
      guard("保存气泡组", applyGroupModal);
    });
    groupCancelEl.addEventListener("click", closeGroupModal);
    groupInputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        guard("保存气泡组", applyGroupModal);
      } else if (e.key === "Escape") {
        closeGroupModal();
      }
    });
    groupInputEl.addEventListener("input", function () {
      groupErrorEl.hidden = true;
    });
  }

  // ===== 编辑区渲染 =====

  /** 生成一个模块条目。 */
  function buildChip(block) {
    var chip = document.createElement("div");
    chip.className = "dsb-chip";
    chip.setAttribute("data-block-id", block.id || "");
    chip.setAttribute("data-kind", block.kind || "");

    var handle = document.createElement("span");
    handle.className = "dsb-drag";
    handle.title = "拖动调整位置";
    handle.setAttribute("role", "button");
    handle.setAttribute("aria-label", "拖动调整位置");
    handle.innerHTML =
      '<span class="icon" style="--icon: url(\'../assets/icons/drag.svg\')"></span>';
    handle.addEventListener("pointerdown", function (e) {
      startDrag(e, block, chip);
    });
    // 手柄只负责拖拽：点它不应该打开配置弹窗。
    handle.addEventListener("click", function (e) {
      e.stopPropagation();
    });

    var kind = document.createElement("span");
    kind.className = "dsb-chip-kind";
    kind.textContent = DSWH.kindLabel(block.kind);

    var text = document.createElement("span");
    text.className = "dsb-chip-text";
    text.textContent = summaryOf(block);

    var del = document.createElement("button");
    del.type = "button";
    del.className = "dsb-chip-del";
    del.title = "删除模块";
    del.setAttribute("aria-label", "删除模块");
    del.textContent = "×";
    del.addEventListener("click", function (e) {
      e.stopPropagation();
      removeBlock(block.id);
    });

    chip.appendChild(handle);
    chip.appendChild(kind);
    chip.appendChild(text);
    chip.appendChild(del);
    chip.addEventListener("click", function () {
      // 拖拽松手会附带一次 click：此时不打开弹窗。
      if (Date.now() < ignoreClickUntil) return;
      openBlockModal(block);
    });
    return chip;
  }

  /**
   * 渲染编辑区。
   *
   * @param rows 要渲染的行数组，缺省用当前配置（拖拽过程中传入「已摘掉被拖模块」
   *             的临时行数组，命中判定与落位才能直接使用同一个下标）。
   */
  function renderRows(rows) {
    return guard("重绘编辑区", function () {
      var next = rows || bubble.rows;
      Array.prototype.slice
        .call(rowsEl.querySelectorAll(".dsb-row"))
        .forEach(function (node) {
          node.parentNode.removeChild(node);
        });
      var count = 0;
      next.forEach(function (row, rowIndex) {
        var blocks = (row && row.blocks) || [];
        if (!blocks.length) return;
        count += blocks.length;
        var rowEl = document.createElement("div");
        rowEl.className = "dsb-row";
        rowEl.setAttribute("data-row", String(rowIndex));
        blocks.forEach(function (block) {
          rowEl.appendChild(buildChip(block));
        });
        rowsEl.appendChild(rowEl);
      });
      emptyEl.hidden = count > 0;
      return count;
    });
  }

  /** 采集当前所有条目元素与位置（FLIP 动画的前后快照）。 */
  function captureChips() {
    var map = new Map();
    rowsEl.querySelectorAll(".dsb-chip").forEach(function (el) {
      var rect = el.getBoundingClientRect();
      map.set(el.getAttribute("data-block-id"), {
        el: el,
        left: rect.left,
        top: rect.top,
      });
    });
    return map;
  }

  /** FLIP：把重排前的位置补成 transform，再在下一帧归零，形成吸附滑动效果。 */
  function flip(before, after) {
    after.forEach(function (entry, id) {
      var prev = before.get(id);
      if (!prev || !entry.el) return;
      var dx = prev.left - entry.left;
      var dy = prev.top - entry.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      var el = entry.el;
      el.style.transition = "none";
      el.style.transform = "translate(" + dx + "px," + dy + "px)";
      requestAnimationFrame(function () {
        el.style.transition = "";
        el.style.transform = "";
      });
    });
  }

  // ===== 添加 / 删除 =====

  /**
   * 点可选模块区：新增一个**独立的**模块实例。
   *
   * 每次点击都生成全新的 id 与全新对象（不复制任何已有模块的内容），
   * 因此同一类型的模块可以重复添加任意多个，彼此互不影响——删掉其中一个，
   * 其余实例照旧；拖动也只改变自己那一个的位置。
   */
  function addBlock(kind) {
    guard("添加模块", function () {
      var block = DSWH.newBlock(kind);
      // 余额 / 今日已用默认取第一个已配置的余额供应商（下拉里也能再改）。
      if ((kind === "balance" || kind === "today") && suppliers.length) {
        block.supplier = suppliers[0].slug;
      }
      // 默认自上而下堆叠：每添加一个模块就新起一行。
      bubble.rows.push({ blocks: [block] });
      markEdited();
      renderRows();
      renderPreview();
      refreshValues();
      save();
    });
  }

  function removeBlock(id) {
    guard("删除模块", function () {
      bubble.rows.forEach(function (row) {
        row.blocks = row.blocks.filter(function (block) {
          return block.id !== id;
        });
      });
      // 空行不留：行是「并排关系」的载体，空行只会留出多余的纵向间距。
      bubble.rows = bubble.rows.filter(function (row) {
        return row.blocks.length > 0;
      });
      markEdited();
      renderRows();
      renderPreview();
      save();
    });
  }

  // ===== 预览气泡 =====

  /** 预览用的行数组：弹窗打开时用草稿替换原模块，实现「编辑即所见」。 */
  function previewRows() {
    if (!editing) return bubble.rows;
    return bubble.rows.map(function (row) {
      return {
        blocks: row.blocks.map(function (block) {
          return block.id === editing.block.id ? editing.draft : block;
        }),
      };
    });
  }

  /**
   * 预览气泡的描边颜色跟随「气泡颜色」（与桌面挂件同一份配置）。
   *
   * @param color 可选：挂件实际使用的那份颜色（十六进制）。缺省时按色相滑杆推导
   *   ——滑杆拖动时二者等价；但「恢复默认设置」「首次加载」这类回填路径上，
   *   配置里的颜色未必落在滑杆的 HSL 映射上（例如内置默认色），
   *   此时必须以配置里的实际颜色为准，否则预览描边会与桌面气泡差一点点。
   */
  function syncPreviewStroke(color) {
    if (!previewBubbleEl) return;
    var stroke = color;
    if (typeof stroke !== "string" || !stroke) {
      var hue = Number(bubbleColorEl && bubbleColorEl.value);
      if (!isFinite(hue)) hue = 220;
      stroke = CFG.hexFromHue(hue);
    }
    previewBubbleEl.querySelectorAll("path, ellipse").forEach(function (node) {
      node.setAttribute("stroke", stroke);
    });
  }

  function renderPreview() {
    guard("重绘预览", function () {
      previewEl.innerHTML = "";
      var rows = previewRows();
      if (!DSWH.hasBlocks(rows)) {
        var hint = document.createElement("div");
        hint.className = "dsb-preview-hint";
        hint.textContent = "未设置模块时，桌面沿用内置气泡";
        previewEl.appendChild(hint);
        return;
      }
      previewEl.appendChild(
        DSWH.renderRows(rows, values, { onClickLink: openExternal }),
      );
    });
  }

  function openExternal(url) {
    if (!url) return;
    CFG.callApi(
      "open_external",
      { url: url },
      { errorPrefix: "打开链接失败" },
    ).catch(function () {});
  }

  // ===== 动态数据（余额 / 今日已用 / 倒计时 / 媒体 / 字体） =====

  /** 当前配置里用到的供应商标识（含空串：表示跟随当前启用供应商）。 */
  function usedSlugs() {
    var list = [];
    bubble.rows.forEach(function (row) {
      row.blocks.forEach(function (block) {
        if (block.kind !== "balance" && block.kind !== "today") return;
        var slug = block.supplier || "";
        if (list.indexOf(slug) === -1) list.push(slug);
      });
    });
    // 弹窗里刚切换的供应商也要一起取回来（草稿还没写回配置）。
    if (
      editing &&
      (editing.draft.kind === "balance" || editing.draft.kind === "today")
    ) {
      var draftSlug = editing.draft.supplier || "";
      if (list.indexOf(draftSlug) === -1) list.push(draftSlug);
    }
    return list;
  }

  /** 当前配置里用到的媒体文件名。 */
  function usedMedia() {
    var list = [];
    bubble.rows.forEach(function (row) {
      row.blocks.forEach(function (block) {
        if (block.kind !== "media" || !block.media) return;
        if (list.indexOf(block.media) === -1) list.push(block.media);
      });
    });
    return list;
  }

  /** 当前配置里用到的字体文件名（模块的 fontFamily 就是文件名）。 */
  function usedFonts() {
    var list = [];
    bubble.rows.forEach(function (row) {
      row.blocks.forEach(function (block) {
        if (!block.fontFamily) return;
        if (list.indexOf(block.fontFamily) === -1) list.push(block.fontFamily);
      });
    });
    return list;
  }

  function loadMedia(name) {
    if (!name || mediaCache[name]) {
      if (name && mediaCache[name]) values.media[name] = mediaCache[name];
      return Promise.resolve();
    }
    return CFG.callApi("read_bubble_media", { name: name }, { silent: true })
      .then(function (dataUrl) {
        mediaCache[name] = dataUrl;
        values.media[name] = dataUrl;
      })
      .catch(function () {
        // 资源被删除 / 读不到：气泡里不渲染该图片（不阻塞其它模块）。
      });
  }

  /** 注入 @font-face：上传的字体在预览气泡里就能立即生效。 */
  function injectFontFace(family, dataUrl) {
    if (!fontStyleEl) {
      fontStyleEl = document.createElement("style");
      fontStyleEl.id = "dsbFontFaces";
      document.head.appendChild(fontStyleEl);
    }
    fontStyleEl.appendChild(
      document.createTextNode(
        '@font-face{font-family:"' +
          family +
          '";src:url("' +
          dataUrl +
          '");font-display:swap;}',
      ),
    );
  }

  function loadFont(name) {
    if (!name || fontLoaded[name]) return Promise.resolve();
    // 先占位：同一份字体在多个模块里同时被解析时不会重复请求。
    fontLoaded[name] = true;
    return CFG.callApi("read_bubble_font", { name: name }, { silent: true })
      .then(function (dataUrl) {
        injectFontFace(DSWH.fontFamilyOf(name), dataUrl);
      })
      .catch(function () {
        fontLoaded[name] = false;
      });
  }

  /** 刷新全部动态数据，然后重绘预览（数据只影响预览，不影响编辑区条目）。 */
  function refreshValues() {
    var jobs = [];
    usedSlugs().forEach(function (slug) {
      jobs.push(
        CFG.callApi(
          "get_supplier_balance",
          { scope: "balance", slug: slug },
          { silent: true },
        )
          .then(function (payload) {
            values.balance[slug] = payloadText(payload, "totalBalance");
            values.today[slug] = payloadText(payload, "todayUsage");
          })
          .catch(function () {
            values.balance[slug] = "--";
            values.today[slug] = "--";
          }),
      );
    });
    usedMedia().forEach(function (name) {
      jobs.push(loadMedia(name));
    });
    usedFonts().forEach(function (name) {
      jobs.push(loadFont(name));
    });
    tickCountdown();
    return Promise.all(jobs).then(renderPreview);
  }

  /** 每秒只刷新倒计时的文本节点（不重建 DOM，气泡内容不会闪）。 */
  function tickCountdown() {
    var info = DSWH.periodInfo(new Date());
    values.countdown = DSWH.fmtCountdown(info.target - Date.now());
    values.peak = info.isPeak;
  }

  function hasCountdownBlock() {
    return bubble.rows.some(function (row) {
      return row.blocks.some(function (block) {
        return block.kind === "countdown";
      });
    });
  }

  function countdownTick() {
    if (!hasCountdownBlock()) return;
    // 折叠时不空转：内容不可见，刷新没有意义。
    if (modularCardEl && modularCardEl.classList.contains("collapsed")) return;
    tickCountdown();
    var next = DSWH.countdownText(values);
    previewEl
      .querySelectorAll('[data-kind="countdown"] .dshw-btext')
      .forEach(function (node) {
        if (node.textContent !== next) node.textContent = next;
      });
  }

  // ===== 供应商 / 字体清单 =====

  function loadSuppliers() {
    return CFG.callApi("list_suppliers", { scope: "balance" }, { silent: true })
      .then(function (list) {
        suppliers = Array.isArray(list) ? list : [];
        supplierPicker.setItems(
          suppliers.map(function (item) {
            return { value: item.slug, text: item.name };
          }),
          "",
        );
      })
      .catch(function () {
        suppliers = [];
      });
  }

  function fontItems() {
    var items = [{ value: "", text: "默认字体" }];
    fonts.forEach(function (name) {
      items.push({ value: name, text: name });
    });
    return items;
  }

  function loadFonts() {
    return CFG.callApi("list_bubble_fonts", undefined, { silent: true })
      .then(function (list) {
        fonts = Array.isArray(list) ? list : [];
        fontPicker.setItems(fontItems(), "");
      })
      .catch(function () {
        fonts = [];
      });
  }

  // ===== 可选模块区 =====

  function buildPalette() {
    paletteEl.innerHTML = "";
    DSWH.KINDS.forEach(function (item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dsb-palette-btn";
      btn.setAttribute("data-kind", item.kind);
      btn.textContent = item.label;
      btn.addEventListener("click", function () {
        addBlock(item.kind);
      });
      paletteEl.appendChild(btn);
    });
  }

  // ===== 模块配置弹窗 =====

  // 气泡组下拉：与「挂件本体 / 音效」同一个自定义下拉组件（条目内带删除叉号）。
  var groupPicker = groupPickerEl
    ? CFG.createPicker(
        groupPickerEl,
        function (value) {
          guard("切换气泡组", function () {
            switchGroup(value);
          });
        },
        function (item) {
          guard("删除气泡组", function () {
            askDeleteGroup(item && item.value);
          });
        },
      )
    : { setItems: function () {} };

  var supplierPicker = CFG.createPicker(supplierPickerEl, function (slug) {
    if (!editing) return;
    editing.draft.supplier = slug;
    refreshValues();
  });

  var fontPicker = CFG.createPicker(fontPickerEl, function (name) {
    if (!editing) return;
    editing.draft.fontFamily = name;
    if (name) loadFont(name).then(renderPreview);
    renderPreview();
  });

  /** 按模块类型显隐表单行（与该类型无关的行整行隐藏，不留空行）。 */
  function applyFormRows(kind) {
    modalEl.querySelectorAll(".dsb-only").forEach(function (row) {
      var kinds = (row.getAttribute("data-only") || "").split(" ");
      row.hidden = kinds.indexOf(kind) === -1;
    });
  }

  function setFmtButton(btn, active) {
    btn.classList.toggle("active", !!active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }

  /** 把草稿写进弹窗表单。 */
  function fillModal(draft) {
    applyFormRows(draft.kind);
    titleEl.textContent = modalTitle(draft.kind);
    errorEl.hidden = true;
    errorEl.textContent = "";

    if (draft.kind === "text") blockTextEl.value = draft.text || "";
    if (draft.kind === "link") {
      linkNameEl.value = draft.linkName || "";
      linkUrlEl.value = draft.linkUrl || "";
    }
    if (draft.kind === "media") {
      var thumb = mediaCache[draft.media] || "";
      mediaThumbEl.hidden = !thumb;
      mediaThumbEl.src = thumb;
      mediaNameEl.textContent = draft.media || "未选择";
      mediaWidthEl.value = String(draft.mediaWidth);
      mediaWidthValEl.textContent = Math.round(draft.mediaWidth) + "px";
      var wanted = draft.media;
      if (wanted) {
        loadMedia(wanted).then(function () {
          // 期间可能已经关掉 / 换了模块：只在仍是同一个模块时补缩略图。
          if (!editing || editing.draft.media !== wanted) return;
          mediaThumbEl.src = mediaCache[wanted] || "";
          mediaThumbEl.hidden = !mediaCache[wanted];
        });
      }
    }
    if (draft.kind === "balance" || draft.kind === "today") {
      var items = suppliers.map(function (item) {
        return { value: item.slug, text: item.name };
      });
      var current = draft.supplier || "";
      var exists = items.some(function (item) {
        return item.value === current;
      });
      if (!exists) current = items.length ? items[0].value : "";
      supplierPicker.setItems(items, current);
      draft.supplier = current;
    }
    if (draft.kind !== "media") {
      fontPicker.setItems(fontItems(), draft.fontFamily || "");
      fontSizeEl.value = String(draft.fontSize);
      fontSizeValEl.textContent = String(Math.round(draft.fontSize));
      colorEl.value = String(CFG.hueFromHex(draft.color));
      // 「背景色」只在勾选「底色」时才出现（见下方 bgRowEl.hidden）。
      bgRowEl.hidden = !draft.background;
      bgColorEl.value = String(
        CFG.hueFromHex(draft.backgroundColor || DSWH.DEFAULT_BG),
      );
    }
    setFmtButton(document.getElementById("blockBold"), draft.bold);
    setFmtButton(document.getElementById("blockBg"), draft.background);
    setFmtButton(document.getElementById("blockUnderline"), draft.underline);
    setFmtButton(document.getElementById("blockItalic"), draft.italic);
    glowEl.checked = !!draft.glow;
  }

  function openBlockModal(block) {
    editing = { block: block, draft: cloneBlock(block) };
    fillModal(editing.draft);
    modalEl.hidden = false;
    modalOverlayEl.hidden = false;
  }

  function closeBlockModal() {
    CFG.closePickers();
    modalEl.hidden = true;
    modalOverlayEl.hidden = true;
    if (editing) {
      editing = null;
      // 取消：草稿丢弃，预览恢复成配置里的内容。
      renderPreview();
    }
  }

  function showBlockError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  /** 应用草稿：写回配置 → 重绘编辑区与预览 → 落盘（后端再广播给挂件）。 */
  function applyBlockModal() {
    if (!editing) return;
    var draft = editing.draft;
    var kind = draft.kind;

    if (kind === "text" && !String(draft.text || "").trim()) {
      showBlockError("请填写文本内容");
      return;
    }
    if (kind === "media" && !draft.media) {
      showBlockError("请先选择图片或动图");
      return;
    }
    if (kind === "link") {
      var url = String(draft.linkUrl || "").trim();
      if (!url) {
        showBlockError("请填写跳转地址");
        return;
      }
      // 缺协议头时补 https://：explorer 拿到裸域名会当成搜索词。
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) url = "https://" + url;
      draft.linkUrl = url;
      if (!String(draft.linkName || "").trim()) draft.linkName = url;
    }

    var target = findBlock(draft.id);
    if (target) {
      for (var key in draft) {
        if (Object.prototype.hasOwnProperty.call(draft, key))
          target[key] = draft[key];
      }
    }
    markEdited();
    editing = null;
    CFG.closePickers();
    modalEl.hidden = true;
    modalOverlayEl.hidden = true;
    renderRows();
    renderPreview();
    refreshValues();
    save();
  }

  /** 把草稿同步到预览（不落盘）。 */
  function draftChanged() {
    if (!editing) return;
    renderPreview();
  }

  /**
   * 调用是否只是「用户取消了选择」。
   *
   * 文件对话框被取消时后端会返回「未选择…」，这不是错误，不该弹红色失败提示。
   */
  function isCancelled(err) {
    return String(err || "").indexOf("未选择") !== -1;
  }

  /** 上传失败：取消静默返回，真正的失败给红色轻提示。 */
  function reportUploadError(prefix, err) {
    if (isCancelled(err)) return;
    console.error(prefix + "失败", err);
    CFG.notify("error", prefix + "失败：" + String(err || "未知错误"));
  }

  function bindModalEvents() {
    modalEl.querySelectorAll(".dsb-only").forEach(function (row) {
      row.hidden = true;
    });

    blockTextEl.addEventListener("input", function (e) {
      if (!editing) return;
      editing.draft.text = e.target.value;
      draftChanged();
    });
    linkNameEl.addEventListener("input", function (e) {
      if (!editing) return;
      editing.draft.linkName = e.target.value;
      draftChanged();
    });
    linkUrlEl.addEventListener("input", function (e) {
      if (!editing) return;
      editing.draft.linkUrl = e.target.value;
      draftChanged();
    });

    fontSizeEl.addEventListener("input", function (e) {
      if (!editing) return;
      var size = Number(e.target.value) || DSWH.FONT_SIZE.value;
      editing.draft.fontSize = size;
      fontSizeValEl.textContent = String(Math.round(size));
      draftChanged();
    });
    colorEl.addEventListener("input", function (e) {
      if (!editing) return;
      editing.draft.color = CFG.hexFromHue(Number(e.target.value) || 0);
      draftChanged();
    });
    bgColorEl.addEventListener("input", function (e) {
      if (!editing) return;
      editing.draft.backgroundColor = CFG.hexFromHue(
        Number(e.target.value) || 0,
      );
      draftChanged();
    });
    mediaWidthEl.addEventListener("input", function (e) {
      if (!editing) return;
      var width = Number(e.target.value) || DSWH.MEDIA_WIDTH.value;
      editing.draft.mediaWidth = width;
      mediaWidthValEl.textContent = Math.round(width) + "px";
      draftChanged();
    });
    glowEl.addEventListener("change", function (e) {
      if (!editing) return;
      editing.draft.glow = e.target.checked;
      draftChanged();
    });

    // 加粗 / 文字底色 / 下划线 / 斜体：四个图标按钮都是开关，
    // 「文字底色」同时控制「背景色」这一行的显隐。
    var FMT_BUTTONS = {
      bold: "blockBold",
      background: "blockBg",
      underline: "blockUnderline",
      italic: "blockItalic",
    };
    Object.keys(FMT_BUTTONS).forEach(function (flag) {
      var btn = document.getElementById(FMT_BUTTONS[flag]);
      if (!btn) return;
      btn.addEventListener("click", function () {
        if (!editing) return;
        var next = !editing.draft[flag];
        editing.draft[flag] = next;
        setFmtButton(btn, next);
        if (flag === "background") bgRowEl.hidden = !next;
        draftChanged();
      });
    });

    mediaPickEl.addEventListener("click", function () {
      if (!editing) return;
      CFG.callApi("pick_bubble_media", undefined, {
        // 上传期间黄色进度提示；成功 / 失败 / 取消在这里分别处理。
        busy: "正在上传图片…",
        silent: true,
      })
        .then(function (asset) {
          if (!asset || !asset.name) return;
          mediaCache[asset.name] = asset.dataUrl;
          values.media[asset.name] = asset.dataUrl;
          editing.draft.media = asset.name;
          mediaThumbEl.src = asset.dataUrl;
          mediaThumbEl.hidden = false;
          mediaNameEl.textContent = asset.name;
          draftChanged();
          CFG.notify("success", "图片已上传：" + asset.name);
        })
        .catch(function (err) {
          reportUploadError("上传图片", err);
        });
    });

    fontPickEl.addEventListener("click", function () {
      if (!editing) return;
      CFG.callApi("pick_bubble_font", undefined, {
        busy: "正在上传字体…",
        silent: true,
      })
        .then(function (asset) {
          if (!asset || !asset.name) return;
          editing.draft.fontFamily = asset.name;
          if (fonts.indexOf(asset.name) === -1) fonts.push(asset.name);
          fonts.sort();
          fontPicker.setItems(fontItems(), asset.name);
          CFG.notify("success", "字体已上传：" + asset.name);
          return loadFont(asset.name).then(draftChanged);
        })
        .catch(function (err) {
          reportUploadError("上传字体", err);
        });
    });

    applyEl.addEventListener("click", applyBlockModal);
    cancelEl.addEventListener("click", closeBlockModal);
  }

  // ===== 拖拽（指针事件 + 边缘吸附） =====

  function ensureDropEl() {
    if (!dropEl || dropEl.parentNode !== rowsEl) {
      dropEl = document.createElement("div");
      dropEl.className = "dsb-drop";
      rowsEl.appendChild(dropEl);
    }
    return dropEl;
  }

  function placeDrop(x, y) {
    dropEl.style.transform = "translate(" + x + "px," + y + "px)";
  }

  function hideDrop() {
    if (dropEl) dropEl.classList.remove("dsb-drop-on");
  }

  /**
   * 行 / 条目的布局盒（相对 `.dsb-rows` 的内边距盒）。
   *
   * 用 offset* 而不是 getBoundingClientRect：拖拽激活时其余条目正带着 FLIP 的
   * transform 位移（下一帧才归零），按视觉矩形取坐标会整体偏移，落点判断随之出错。
   * offset* 取的是布局位置，天然不受 transform 影响，也与吸附指示器的绝对定位同一坐标系。
   */
  function rowBox(rowEl) {
    return {
      top: rowEl.offsetTop,
      bottom: rowEl.offsetTop + rowEl.offsetHeight,
      left: rowEl.offsetLeft,
      right: rowEl.offsetLeft + rowEl.offsetWidth,
      width: rowEl.offsetWidth,
      height: rowEl.offsetHeight,
    };
  }

  /** 行的上 / 下边缘：横条指示「单独成行，插到该行上方 / 下方」。 */
  function showDropHorizontal(box, below) {
    var el = ensureDropEl();
    el.style.width = Math.max(24, box.width) + "px";
    el.style.height = "3px";
    placeDrop(0, below ? box.bottom + 2 : box.top - 5);
    el.classList.add("dsb-drop-on");
  }

  /**
   * 行的中间：竖条指示「与这一视觉行并排，插到某个模块的左 / 右侧」。
   *
   * 一行里的条目可能因为放不下而换到下一视觉行（见 .dsb-row 的 flex-wrap），
   * 因此指示条要贴着「插入位置所在的那一视觉行」，而不是整行的外框。
   */
  function showDropVertical(chips, index) {
    var prev = index > 0 ? chips[index - 1] : null;
    var next = index < chips.length ? chips[index] : null;
    var x;
    var top;
    var height;
    if (prev && next && prev.offsetTop === next.offsetTop) {
      x = (prev.offsetLeft + prev.offsetWidth + next.offsetLeft) / 2;
      top = prev.offsetTop;
      height = Math.max(18, prev.offsetHeight);
    } else if (next) {
      x = next.offsetLeft + 2;
      top = next.offsetTop;
      height = Math.max(18, next.offsetHeight);
    } else if (prev) {
      x = prev.offsetLeft + prev.offsetWidth - 2;
      top = prev.offsetTop;
      height = Math.max(18, prev.offsetHeight);
    } else {
      return;
    }
    var el = ensureDropEl();
    el.style.width = "3px";
    el.style.height = height + "px";
    placeDrop(x - 1.5, top);
    el.classList.add("dsb-drop-on");
  }

  /**
   * 计算落点（指针坐标 → 编辑区内的落点）。
   *
   * 规则（与需求一一对应）：
   * - 落在某一行的上边缘 → 该行上方单独成行；
   * - 落在某一行的下边缘 → 该行下方单独成行；
   * - 落在某一行的中间 → 与这一行并排，按各模块的中心线决定插到谁的前面
   *   （因此「拖到某模块左边缘 = 插到它左侧、右边缘 = 插到它右侧」自动成立）。
   */
  function computeTarget(clientX, clientY) {
    var host = rowsEl.getBoundingClientRect();
    // 视口坐标 → 编辑区内容坐标（减去边框，和 offset* 的基准一致）。
    var x = clientX - host.left - rowsEl.clientLeft;
    var y = clientY - host.top - rowsEl.clientTop;
    var slack = 16;
    if (
      x < -slack ||
      x > rowsEl.clientWidth + slack ||
      y < -slack ||
      y > rowsEl.clientHeight + slack
    ) {
      return null;
    }
    var rowEls = Array.prototype.slice.call(
      rowsEl.querySelectorAll(".dsb-row"),
    );
    if (!rowEls.length) return { row: 0, index: 0, mode: "below" };

    var best = null;
    rowEls.forEach(function (rowEl, index) {
      var box = rowBox(rowEl);
      var dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
      if (!best || dy < best.dy) {
        best = { el: rowEl, index: index, box: box, dy: dy };
      }
    });

    var box = best.box;
    var band = Math.min(11, Math.max(7, box.height * 0.3));
    if (y < box.top + band) {
      showDropHorizontal(box, false);
      return { row: best.index, index: 0, mode: "above" };
    }
    if (y > box.bottom - band) {
      showDropHorizontal(box, true);
      return { row: best.index, index: 0, mode: "below" };
    }

    var chips = Array.prototype.slice.call(
      best.el.querySelectorAll(".dsb-chip"),
    );
    // 一行最多并排 MAX_ROW_BLOCKS 个：这一行已经满了就把落点顺延到它下面新起一行
    //（拖拽期间被拖模块已从布局里摘除，所以这里数到的正是落位后该行的数量）。
    if (chips.length >= MAX_ROW_BLOCKS) {
      showDropHorizontal(box, true);
      return { row: best.index, index: 0, mode: "below", capped: true };
    }
    // 条目放不下时会换到下一视觉行：先在「指针所在的那一视觉行」里定位，
    // 再按中心线决定插到谁的前面。不区分视觉行的话，换行后会把条目插到行首。
    var lineTop = null;
    chips.forEach(function (chip) {
      if (y >= chip.offsetTop && y <= chip.offsetTop + chip.offsetHeight) {
        lineTop = chip.offsetTop;
      }
    });
    if (lineTop === null) {
      // 指针落在条目之间的空隙：取纵向最近的那一视觉行
      var bestDy = Infinity;
      chips.forEach(function (chip) {
        var top = chip.offsetTop;
        var dy =
          y < top
            ? top - y
            : y > top + chip.offsetHeight
              ? y - top - chip.offsetHeight
              : 0;
        if (dy < bestDy) {
          bestDy = dy;
          lineTop = top;
        }
      });
    }
    var index = 0;
    chips.forEach(function (chip, i) {
      if (chip.offsetTop < lineTop) {
        // 更靠上的视觉行：整体排在插入点之前
        index = i + 1;
        return;
      }
      if (chip.offsetTop > lineTop) return; // 更靠下的视觉行：整体排在插入点之后
      if (x > chip.offsetLeft + chip.offsetWidth / 2) index = i + 1;
    });
    showDropVertical(chips, index);
    return { row: best.index, index: index, mode: "inline" };
  }

  /** 把模块插进（已摘掉自己的）行数组，返回新的行数组。 */
  function insertBlock(rows, target, block) {
    if (target.mode === "above") {
      rows.splice(target.row, 0, { blocks: [block] });
      return rows;
    }
    if (target.mode === "below") {
      rows.splice(target.row + 1, 0, { blocks: [block] });
      return rows;
    }
    if (!rows.length) {
      rows.push({ blocks: [block] });
      return rows;
    }
    var rowIndex = Math.max(0, Math.min(target.row, rows.length - 1));
    var blocks = rows[rowIndex].blocks;
    blocks.splice(Math.max(0, Math.min(target.index, blocks.length)), 0, block);
    return rows;
  }

  /**
   * 摘掉指定模块后的行数组（拖拽落位判定的基准）。
   *
   * 同时按对象引用与 id 排除：引用永远唯一，id 则能在配置被整体替换过之后继续命中。
   */
  function rowsWithout(rows, id, block) {
    return rows
      .map(function (row) {
        return {
          blocks: (row.blocks || []).filter(function (item) {
            return item !== block && item.id !== id;
          }),
        };
      })
      .filter(function (row) {
        return row.blocks.length > 0;
      });
  }

  /**
   * 从当前配置里「唯一地」取出一个模块（原地摘除，返回取出结果）。
   *
   * 拖拽期间配置可能被一次保存回包整体替换（对象引用全变），因此不能依赖拖拽开始时
   * 抓到的引用：按 id 在当前配置里重新定位。命中多份时只取第一份并把多出的份数报出来，
   * 由调用方决定放弃本次落位——**宁可原地不动，也绝不复制出一份**。
   */
  function takeBlock(id, fallback) {
    var found = null;
    var extra = 0;
    bubble.rows.forEach(function (row) {
      var keep = [];
      row.blocks.forEach(function (item) {
        var hit = id ? item.id === id : item === fallback;
        if (hit) {
          if (found) extra += 1;
          else found = item;
          return;
        }
        keep.push(item);
      });
      row.blocks = keep;
    });
    bubble.rows = bubble.rows.filter(function (row) {
      return row.blocks.length > 0;
    });
    return { block: found, extra: extra };
  }

  function startDrag(e, block, chipEl) {
    if (e.button !== 0 || drag) return;
    e.preventDefault();
    var rect = chipEl.getBoundingClientRect();
    drag = {
      id: block.id,
      block: block,
      chip: chipEl,
      startX: e.clientX,
      startY: e.clientY,
      rect: rect,
      active: false,
      target: null,
      ghost: null,
      rows: null,
    };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    window.addEventListener("pointercancel", onDragCancel);
    window.addEventListener("keydown", onDragKey);
  }

  /** 真正开始拖拽：把条目摘出布局（并复制一份浮层副本跟随指针）。 */
  function activateDrag() {
    drag.active = true;
    // 先复制副本，再摘掉原件（顺序反了就取不到样式与尺寸）。
    drag.ghost = drag.chip.cloneNode(true);
    drag.ghost.classList.add("dsb-ghost");
    drag.ghost.style.width = drag.rect.width + "px";
    drag.ghost.style.left = drag.rect.left + "px";
    drag.ghost.style.top = drag.rect.top + "px";
    document.body.appendChild(drag.ghost);

    // 「摘掉被拖模块」后的行数组：命中判定与落位下标都基于它，无需再做补偿。
    drag.rows = rowsWithout(bubble.rows, drag.id, drag.block);

    var before = captureChips();
    renderRows(drag.rows);
    flip(before, captureChips());
  }

  function moveGhost(x, y) {
    if (!drag.ghost) return;
    drag.ghost.style.left = drag.rect.left + (x - drag.startX) + "px";
    drag.ghost.style.top = drag.rect.top + (y - drag.startY) + "px";
  }

  function onDragMove(e) {
    if (!drag) return;
    guard("拖拽", function () {
      if (!drag.active) {
        if (
          Math.abs(e.clientX - drag.startX) < DRAG_THRESHOLD &&
          Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD
        ) {
          return;
        }
        activateDrag();
      }
      moveGhost(e.clientX, e.clientY);
      drag.target = computeTarget(e.clientX, e.clientY);
      if (!drag.target) hideDrop();
    });
  }

  function onDragEnd() {
    if (!drag) return;
    var session = drag;
    var active = session.active;
    var ghostRect = session.ghost
      ? session.ghost.getBoundingClientRect()
      : null;
    var target = session.target;
    // 先收摊：即便落位过程抛异常，浮层副本与监听器也不会留在页面上。
    cleanupDrag();
    if (!active) return;

    // 拖拽结束会附带一次 click：极短时间内不让它打开配置弹窗（只吞掉手势带出的那一次）。
    ignoreClickUntil = Date.now() + 180;

    guard("拖拽落位", function () {
      var before = captureChips();
      // 被拖模块的起点 = 浮层副本的当前位置，落位后由它「飞」回编辑区。
      if (ghostRect) {
        before.set(session.id, {
          el: null,
          left: ghostRect.left,
          top: ghostRect.top,
        });
      }
      if (target) {
        // 先「唯一地摘出」被拖模块，再插到目标位置：拖动只改位置，永不产生副本。
        var taken = takeBlock(session.id, session.block);
        if (!taken.block || taken.extra > 0) {
          // 定位不到 / 有多份（拖拽期间配置被整体替换过）：放弃本次落位，
          // 模块留在原处，绝不插出第二份。
          renderRows();
          renderPreview();
          return;
        }
        bubble.rows = insertBlock(bubble.rows, target, taken.block);
        markEdited();
        save();
        // 目标行已满：落点被顺延成新的一行，明确告诉用户为什么没并排进去。
        if (target.capped) {
          CFG.notify(
            "warn",
            "一行最多 " + MAX_ROW_BLOCKS + " 个模块，已放到下一行",
          );
        }
      }
      renderRows();
      renderPreview();
      flip(before, captureChips());
    });
  }

  function onDragCancel() {
    if (!drag) return;
    var active = drag.active;
    cleanupDrag();
    if (!active) return;
    ignoreClickUntil = Date.now() + 180;
    guard("取消拖拽", function () {
      renderRows();
      renderPreview();
    });
  }

  function onDragKey(e) {
    if (e.key === "Escape") onDragCancel();
  }

  function cleanupDrag() {
    if (!drag) return;
    if (drag.ghost && drag.ghost.parentNode) {
      drag.ghost.parentNode.removeChild(drag.ghost);
    }
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    window.removeEventListener("pointercancel", onDragCancel);
    window.removeEventListener("keydown", onDragKey);
    hideDrop();
    drag = null;
  }

  // ===== 折叠交互（与「高级设置」「台词管理」同一套） =====

  function bindCollapse() {
    if (toggleBubbleEl && bubbleCardEl) {
      toggleBubbleEl.addEventListener("click", function () {
        var collapsed = bubbleCardEl.classList.toggle("collapsed");
        toggleBubbleEl.textContent = collapsed ? "展开" : "收起";
        toggleBubbleEl.setAttribute(
          "aria-expanded",
          collapsed ? "false" : "true",
        );
      });
    }
    if (modularToggleEl && modularCardEl) {
      modularToggleEl.addEventListener("click", function () {
        var collapsed = modularCardEl.classList.toggle("collapsed");
        modularToggleEl.setAttribute(
          "aria-expanded",
          collapsed ? "false" : "true",
        );
        if (!collapsed) {
          // 展开时刷新一次外部数据：供应商 / 字体 / 气泡组可能刚在别处改过。
          loadSuppliers().then(loadFonts);
          // 先用本地已知的组名渲染，读盘结果回来后再覆盖（下拉不会空一下）。
          renderGroupOptions();
          loadGroups();
          refreshValues();
        }
      });
    }
  }

  // ===== 对外接口 =====

  /**
   * 应用一份气泡配置（首次加载、切换组、删除组、恢复默认设置都走这里）。
   *
   * @param cfg 后端 `BubbleConfig` 形状的对象：`{ rows, currentGroup }`。
   */
  function applyBubbleConfig(cfg) {
    return guard("应用配置", function () {
      var next = cfg && Array.isArray(cfg.rows) ? cfg : { rows: [] };
      if (!next.currentGroup) next.currentGroup = DEFAULT_GROUP;
      ensureBlockIds(next.rows);
      // 同一份配置重复回填时跳过重绘（config.js 的回填钩子与本文件的首次读取
      // 可能各来一次），避免重复取数、无谓重绘。组名变化不算「同一份」。
      var changed = JSON.stringify(next) !== JSON.stringify(bubble);
      var prevGroup = currentGroupName();
      bubble = next;
      // 这份配置是「某个组载入时的样子」时，刷新基线快照：
      //   - 切到别的组（哪怕内容一模一样）→ 基线必须跟着换组；
      //   - 内容确实被整体替换（恢复默认设置等）→ 基线跟着换内容；
      // 而自己那次防抖保存的广播回包（同组、同内容）不算重新载入，不能覆盖基线，
      // 不然基线会被编辑后的内容刷新，另存新组时就还原不出源组的原样了。
      if (currentGroupName() !== prevGroup || changed) {
        baseline.group = currentGroupName();
        baseline.rowsJson = JSON.stringify(next.rows || []);
      }
      // 配置被整体替换（首次加载 / 切组 / 删组 / 恢复默认）：此刻在途的保存回包
      // 一律视为过期，不能再套回内存。
      markEdited();
      renderGroupOptions();
      if (!changed) return;
      if (editing) {
        editing = null;
        modalEl.hidden = true;
        modalOverlayEl.hidden = true;
      }
      renderRows();
      renderPreview();
      syncPreviewStroke();
      refreshValues();
    });
  }

  /**
   * 应用一份气泡配置（config.js 在首次加载与「恢复默认设置」后调用）。
   *
   * @param cfg 后端 `BubbleConfig` 形状的对象。
   */
  window.DSB = {
    applyConfig: function (cfg, strokeColor) {
      applyBubbleConfig(cfg);
      // 描边颜色取自「气泡颜色」，而它的值由 config.js 回填（本次回填可能刚把它改回
      // 默认色）。只靠滑杆的 input 事件同步会漏掉这种「值被动变化」的路径——
      // 「恢复默认设置」后预览气泡会一直留着旧颜色，直到用户再碰一下滑杆。
      // 回填路径优先用配置里的实际颜色：它未必落在滑杆的 HSL 映射上。
      syncPreviewStroke(strokeColor);
      // 气泡组列表可能刚被别处改动（例如「恢复默认设置」把当前组切回「默认」），
      // 每次回填都同步一次，下拉与磁盘保持一致。
      loadGroups();
    },
  };

  // ===== 启动 =====
  buildPalette();
  bindModalEvents();
  bindGroupEvents();
  bindCollapse();
  // 气泡组下拉在任何 IPC 之前先渲染一次：内置「默认」组是本地常量，
  // 不依赖磁盘上的自定义组，因此首次打开（尚无任何自定义组）时，
  // 「气泡组」标题与右侧下拉栏第一帧就是完整可用的，
  // 不会出现「要等读盘 / 加过组之后才出现」的空窗期。
  renderGroupOptions();
  syncPreviewStroke();
  if (bubbleColorEl) bubbleColorEl.addEventListener("input", syncPreviewStroke);
  loadSuppliers();
  loadFonts();
  loadGroups();
  renderRows();
  renderPreview();
  setInterval(function () {
    guard("倒计时刷新", countdownTick);
  }, 1000);

  // 首次加载：自己读一次气泡配置。
  // 不依赖 config.js 的回填钩子——脚本执行顺序与 IPC 响应的到达顺序无法严格保证
  // （config.js 的 get_config 有可能在 bubble-config.js 执行前就已返回，
  //   那一瞬间 window.DSB 还不存在，钩子会被静默跳过）。
  CFG.callApi("get_config", undefined, { silent: true })
    .then(function (cfg) {
      if (!cfg) return;
      applyBubbleConfig(cfg.bubble);
      // 首屏同样按配置里的实际颜色取描边（不一定落在滑杆的 HSL 映射上）。
      syncPreviewStroke(cfg.widget && cfg.widget.bubbleColor);
    })
    .catch(function () {
      /* 读取失败：保持空态，用户仍可重新编辑 */
    });
})();

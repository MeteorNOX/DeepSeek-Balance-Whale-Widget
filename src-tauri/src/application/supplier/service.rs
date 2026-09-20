//! 供应商用例
//!
//! 编排供应商存储、客户端配置渲染与旧配置迁移；本层不依赖 Tauri，
//! 命令层（`api::supplier_api`）只做线缆转换与事件广播。
//!
//! 供应商按「列表」组织，列表用 scope 标识：`balance` 为余额配置列表（只查余额/用量），
//! 其余 scope 名即客户端 id（用于写客户端配置文件做模型路由）。两套列表数据完全独立。
//!
//! # 入口一览
//! - 读取：[`list_suppliers`] / [`list_cards`] / [`get_detail`] / [`read_active`]；
//! - 写入：[`save_supplier`]（含 slug 分配）/ [`delete_supplier`] / [`apply_supplier`]；
//! - 预览：[`preview_supplier`]（界面草稿渲染，不落盘）；
//! - 升级：[`migrate_legacy_config`]（启动时无条件调用，幂等）。
//!
//! slug 分配与模型路由归属都是纯规则（[`allocate_slug`] / [`resolve_routing`]），
//! 占用现状 / 目标列表由调用方传入，因此可以在不触碰磁盘的前提下单测。

use crate::application::routing;
use crate::domain::client::model::valobj::{ClientRenderInput, ClientWriteOutcome, RenderedFile};
use crate::domain::client::service::client_service::{self, ClientDescriptor};
use crate::domain::supplier::model::{
    SupplierIndexEntry, SupplierProfile, SupplierRouting,
};
use crate::domain::supplier::service::supplier_service::{self, BALANCE_SCOPE};
use crate::types::exception::{AppError, AppResult};
use crate::application::registry;
use crate::application::supplier::command::SupplierSaveInput;
use crate::application::supplier::result::{SupplierCard, SupplierDetail, SupplierSaveOutcome};

/// 新建供应商标识时的冲突规避尝试次数（`基名-2`…`基名-101`）。
pub const SLUG_ATTEMPTS: u32 = 100;

/// 列出某个列表下的全部供应商（索引条目，不含密钥）。
///
/// 索引按磁盘目录现状重建，因此外部增删目录也能被正确反映。
pub fn list_suppliers(scope: &str) -> AppResult<Vec<SupplierIndexEntry>> {
    registry::supplier().list_suppliers(scope)
}

/// 列出已接入的客户端（UI 标签页与 logo 的唯一来源）。
pub fn list_clients() -> Vec<ClientDescriptor> {
    client_service::list_clients()
}

/// 列出某个列表下的全部供应商卡片（列表展示用，不含密钥）。
///
/// 单个供应商损坏时跳过并留日志：一张列表不应被一个坏目录整体拖垮
/// （与存储层重建索引的策略一致）。
pub fn list_cards(scope: &str) -> AppResult<Vec<SupplierCard>> {
    let scope = supplier_service::validate_scope(scope)?;
    let mut cards = Vec::new();
    for entry in list_suppliers(&scope)? {
        match read_card(&scope, &entry) {
            Ok(card) => cards.push(card),
            Err(err) => log::warn!("跳过无法读取的供应商 {}/{}：{}", scope, entry.slug, err),
        }
    }
    Ok(cards)
}

/// 读取某个供应商的完整详情（编辑弹窗预填）。
pub fn get_detail(scope: &str, slug: &str) -> AppResult<SupplierDetail> {
    let scope = supplier_service::validate_scope(scope)?;
    let profile = registry::supplier().read_profile(&scope, slug)?;
    // 目录名是唯一事实来源：后续读取一律用目录名，避免入参与磁盘漂移。
    let dir_name = profile.slug.clone();
    let credential = registry::supplier().read_credential(&scope, &dir_name)?;
    let endpoint = registry::supplier().read_endpoint(&scope, &dir_name)?;
    let routing = read_routing(&scope, &dir_name)?;
    let active = read_active(&scope)?.as_deref() == Some(dir_name.as_str());
    Ok(SupplierDetail {
        scope,
        profile,
        credential,
        endpoint,
        routing,
        active,
    })
}

/// 新建或编辑供应商。
///
/// slug 分配见 [`allocate_slug`]；保存顺序固定为
/// profile → credential → endpoint →（客户端列表）routing，每步都落盘。
/// `created_at` 由存储层在首次落盘时写入，编辑时沿用原值（不得变成「最后修改时间」）。
pub fn save_supplier(input: SupplierSaveInput) -> AppResult<SupplierSaveOutcome> {
    let scope = supplier_service::validate_scope(&input.scope)?;
    let taken = registry::supplier().list_slugs(&scope);
    let slug = allocate_slug(&input.slug, &input.profile.name, &taken)?;
    let editing = taken.contains(&slug);

    let mut profile = input.profile;
    profile.slug = slug.clone();
    if editing {
        // 编辑：排序与创建时间保持不变。
        let existing = registry::supplier().read_profile(&scope, &slug)?;
        profile.order = existing.order;
        profile.created_at = existing.created_at;
    } else {
        profile.order = next_order(&scope)?;
    }

    // 余额数据源的新旧对比必须在覆盖旧值之前完成。
    let previous_source = previous_source(&scope, &slug)?;

    registry::supplier().save_profile(&scope, &profile)?;
    registry::supplier().save_credential(&scope, &slug, &input.credential)?;
    registry::supplier().save_endpoint(&scope, &slug, &input.endpoint)?;
    if scope == BALANCE_SCOPE && input.routing.is_some() {
        // 余额配置列表不参与模型路由：前端多传字段不视为错误，忽略即可。
        log::warn!(
            "余额配置列表不支持模型路由，已忽略 routing：{}/{}",
            scope,
            slug
        );
    }
    if let Some(routing) = resolve_routing(&scope, input.routing) {
        registry::supplier().save_routing(&scope, &slug, &routing)?;
    }

    // 回读归一化后的实际值：返回给界面的就是磁盘现状。
    let detail = get_detail(&scope, &slug)?;
    // 只有「当前启用项」的密钥或请求地址变了才需要让界面重新拉取余额：
    // 这两项一变，上一个数值就不再代表当前数据源，前端必须把它作废。
    let next_source = BalanceSource {
        api_key: detail.credential.api_key.clone(),
        base_url: detail.endpoint.base_url.clone(),
    };
    let balance_source_changed =
        previous_source.is_some_and(|previous| source_changed(&previous, &next_source));
    Ok(SupplierSaveOutcome {
        detail,
        balance_source_changed,
    })
}

/// 分配标识（纯规则：该列表内已占用的目录名由调用方传入，便于单测）。
///
/// - `requested` 非空且同名目录已存在 → 视为编辑，沿用该 slug；
/// - 否则视为新建：基名取 `requested`（非空时）或由名称派生（纯中文名会派生出空串）；
/// - 基名为空 → 取该列表内第一个未占用的 `custom-N`；
/// - 基名被占用 → 依次尝试 `基名-2`、`基名-3`…（最多 [`SLUG_ATTEMPTS`] 次），
///   仍然全部冲突时报冲突错误，而不是无限试探。
pub fn allocate_slug(requested: &str, name: &str, taken: &[String]) -> AppResult<String> {
    let requested = requested.trim();
    let base = if requested.is_empty() {
        supplier_service::slugify(name)
    } else {
        let slug = supplier_service::validate_slug(requested)?;
        // 目录已存在 → 编辑：沿用该 slug（新建时不会命中此分支）。
        if taken.contains(&slug) {
            return Ok(slug);
        }
        slug
    };

    if base.is_empty() {
        return Ok(first_free_custom_slug(taken));
    }
    if !taken.contains(&base) {
        return Ok(base);
    }
    for index in 2..=SLUG_ATTEMPTS + 1 {
        let candidate = format!("{}-{}", base, index);
        if !taken.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(AppError::conflict(format!("供应商标识已被占用：{}", base)))
}

/// 决定要落盘的模型路由（纯规则）。
///
/// 余额配置列表不参与模型路由：前端多传的 routing 一律忽略（返回 `None`，不算错误）；
/// 客户端列表没有 routing 时补一个「属于该客户端」的默认值。
pub fn resolve_routing(scope: &str, routing: Option<SupplierRouting>) -> Option<SupplierRouting> {
    if scope == BALANCE_SCOPE {
        return None;
    }
    Some(routing.unwrap_or_else(|| SupplierRouting {
        client_id: scope.to_string(),
        ..SupplierRouting::default()
    }))
}

/// 应用：把该供应商设为所属列表的当前启用项。
///
/// 余额配置列表只切换启用项、不写任何客户端文件；客户端列表先写客户端配置文件、
/// 成功后才标记启用（见 `routing::service::apply`）。
pub fn apply_supplier(scope: &str, slug: &str) -> AppResult<ClientWriteOutcome> {
    let scope = supplier_service::validate_scope(scope)?;
    if scope == BALANCE_SCOPE {
        set_active(&scope, slug)?;
        return Ok(ClientWriteOutcome {
            files: Vec::new(),
            backups: Vec::new(),
        });
    }
    routing::service::apply(&scope, slug)
}

/// 用界面草稿渲染客户端配置文件的预览（不落盘）。
///
/// 与 `routing::service::preview_saved` 是同一段渲染代码，因此「预览看到什么，
/// 应用后就是什么」；余额配置列表不参与模型路由，由 `preview_draft` 拒绝。
pub fn preview_supplier(input: &SupplierSaveInput) -> AppResult<Vec<RenderedFile>> {
    let scope = supplier_service::validate_scope(&input.scope)?;
    let routing = resolve_routing(&scope, input.routing.clone()).unwrap_or(SupplierRouting {
        client_id: scope.clone(),
        ..SupplierRouting::default()
    });
    routing::service::preview_draft(
        &scope,
        &ClientRenderInput {
            base_url: input.endpoint.base_url.clone(),
            api_key: input.credential.api_key.clone(),
            api_format: input.endpoint.api_format.clone(),
            auth_field: input.endpoint.auth_field.clone(),
            routing,
            supplier_name: input.profile.name.clone(),
            common_config: registry::supplier().read_common_config(&scope)?,
        },
    )
}

/// 删除某个列表下的一个供应商及其全部子文件。
pub fn delete_supplier(scope: &str, slug: &str) -> AppResult<()> {
    registry::supplier().delete_supplier(scope, slug)
}

/// 设置某个列表的当前启用项。
pub fn set_active(scope: &str, slug: &str) -> AppResult<()> {
    registry::supplier().set_active(scope, slug)
}

/// 读取某个列表的当前启用项（未启用时为 `None`）。
pub fn read_active(scope: &str) -> AppResult<Option<String>> {
    registry::supplier().read_active(scope)
}

/// 旧配置迁移：把 `config.json` 里的 API Key / 请求地址迁移为供应商。
///
/// 幂等：已迁移过（索引存在）或没有 API Key 时返回 `None`，
/// 因此可以在每次启动时无条件调用（启动流程见 `lib.rs`）。
///
/// 迁移成功后追加一步：把旧全局账本 `usage.json` 的本地记账数据导入
/// **余额配置列表**的新供应商，避免升级后用量曲线从零开始。
pub fn migrate_legacy_config() -> AppResult<Option<SupplierProfile>> {
    let legacy = registry::config().get();
    let migrated = registry::supplier().migrate_legacy_config(&legacy)?;
    if let Some(profile) = &migrated {
        if let Err(err) = import_legacy_ledger(&profile.slug) {
            // 导入失败不影响迁移结果：新供应商已可用，只是历史曲线暂缺。
            log::warn!("导入旧记账账本失败（{}）：{}", profile.slug, err);
        }
    }
    Ok(migrated)
}

/// 启动清理：删除已经下线的用量文件（`usage_query.json`、客户端列表下的
/// `usage_history.json`）。幂等，返回删除的文件数。
pub fn cleanup_usage_files() -> AppResult<usize> {
    registry::usage_history().cleanup_usage_files()
}

/// 由索引条目读出列表卡片（目录名是唯一事实来源，展示信息与地址都按目录名读）。
fn read_card(scope: &str, entry: &SupplierIndexEntry) -> AppResult<SupplierCard> {
    Ok(SupplierCard {
        scope: scope.to_string(),
        profile: registry::supplier().read_profile(scope, &entry.slug)?,
        endpoint: registry::supplier().read_endpoint(scope, &entry.slug)?,
        active: entry.active,
    })
}

/// 读取模型路由：余额配置列表没有（也不允许有）路由文件。
fn read_routing(scope: &str, slug: &str) -> AppResult<Option<SupplierRouting>> {
    if scope == BALANCE_SCOPE {
        return Ok(None);
    }
    Ok(Some(registry::supplier().read_routing(scope, slug)?))
}

/// 新建时的排序权重：取该列表内现有最大 `order` + 1。
fn next_order(scope: &str) -> AppResult<i64> {
    Ok(registry::supplier().list_suppliers(scope)?
        .iter()
        .map(|entry| entry.order)
        .max()
        .unwrap_or(0)
        + 1)
}

/// 该列表内第一个未占用的自定义标识（`custom-1`、`custom-2`…）。
fn first_free_custom_slug(taken: &[String]) -> String {
    let mut index = 1u32;
    loop {
        let candidate = supplier_service::custom_slug(index);
        if !taken.contains(&candidate) {
            return candidate;
        }
        index += 1;
    }
}

/// 余额数据源指纹：决定「同一个供应商是否仍指向同一个余额来源」的两个字段。
///
/// 只比较这两项是因为余额取数只依赖它们：请求由供应商目录名选定内置来源模板，
/// 用请求地址定位服务、用密钥鉴权；其余字段（备注、模型路由等）不影响余额数值。
#[derive(Debug, Clone, PartialEq)]
struct BalanceSource {
    /// 密钥。
    api_key: String,
    /// 请求地址。
    base_url: String,
}

/// 余额数据源是否变化（纯规则，便于单测）。
///
/// 密钥或请求地址任一不同即视为变化：两者都会让「上一个数值」不再代表当前来源，
/// 前端必须作废已显示的余额，而不是继续展示上一个供应商的数字。
fn source_changed(previous: &BalanceSource, next: &BalanceSource) -> bool {
    previous.api_key != next.api_key || previous.base_url != next.base_url
}

/// 读取余额数据源的旧值（密钥 + 请求地址）：仅当该供应商正是余额配置列表的
/// 当前启用项时返回。
///
/// 非启用项的变化不影响余额展示，因此不必读盘对比。
fn previous_source(scope: &str, slug: &str) -> AppResult<Option<BalanceSource>> {
    if scope != BALANCE_SCOPE || read_active(scope)?.as_deref() != Some(slug) {
        return Ok(None);
    }
    let credential = registry::supplier().read_credential(scope, slug)?;
    let endpoint = registry::supplier().read_endpoint(scope, slug)?;
    Ok(Some(BalanceSource {
        api_key: credential.api_key,
        base_url: endpoint.base_url,
    }))
}

/// 把旧全局账本导入余额配置列表下新迁移出的供应商。
///
/// 只在目标 `usage_history.json` **尚不存在**时导入：该文件一旦存在，
/// 说明新体系已经在自己记账，覆盖它会把新数据冲掉。
fn import_legacy_ledger(slug: &str) -> AppResult<()> {
    let ledger = registry::ledger().read_ledger();
    if ledger.history.is_empty() && ledger.today_usage <= 0.0 && ledger.last_balance.is_none() {
        // 没有可导入的内容：连文件都不建，保持「缺失即未配置」的语义。
        return Ok(());
    }
    if registry::usage_history().usage_history_exists(BALANCE_SCOPE, slug)? {
        return Ok(());
    }

    // 文件缺失 → 默认值，因此这里拿到的一定是空历史。
    let mut history = registry::usage_history().read_usage_history(BALANCE_SCOPE, slug)?;
    for (date, usage) in &ledger.history {
        history.daily.entry(date.clone()).or_default().local = *usage;
    }
    // 当日用量归属于账本记录的那一天，不能硬塞给「今天」（跨天后日期会不同）。
    if ledger.today_usage > 0.0 && !ledger.date.is_empty() {
        history.daily.entry(ledger.date.clone()).or_default().local = ledger.today_usage;
    }
    // 基准一并带过来：否则下一次观测被当成「首次观测」，白白丢掉一段差值。
    history.last_balance = ledger.last_balance;
    registry::usage_history().save_usage_history(BALANCE_SCOPE, slug, &history)?;
    log::info!("已把旧记账账本导入供应商 {}/{}", BALANCE_SCOPE, slug);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 非法标识必须在触碰磁盘之前被拒绝（用例层不额外绕过领域校验）。
    #[test]
    fn delete_rejects_illegal_slug() {
        for bad in ["../escape", "", "a/b"] {
            assert!(
                delete_supplier("balance", bad).is_err(),
                "「{}」应被拒绝",
                bad
            );
            assert!(
                delete_supplier(bad, "deepseek").is_err(),
                "「{}」应被拒绝",
                bad
            );
        }
    }

    /// 客户端清单由注册表转发，供界面标签页与迁移时铺开 scope 共用。
    #[test]
    fn list_clients_forwards_registry() {
        let clients = list_clients();
        assert!(clients.iter().any(|client| client.id == "claude"));
        assert!(clients.iter().any(|client| client.id == "codex"));
    }

    /// 余额数据源指纹只认「密钥 + 请求地址」：任一变化都必须判定为换源，
    /// 否则前端会继续显示上一个数据源（如 DeepSeek）的余额与今日已用。
    #[test]
    fn source_changed_detects_key_and_endpoint() {
        let base = BalanceSource {
            api_key: "sk-a".to_string(),
            base_url: "https://api.deepseek.com".to_string(),
        };
        assert!(!source_changed(&base, &base.clone()), "完全一致不算换源");
        assert!(
            source_changed(
                &base,
                &BalanceSource {
                    api_key: "sk-b".to_string(),
                    ..base.clone()
                }
            ),
            "密钥变化算换源"
        );
        assert!(
            source_changed(
                &base,
                &BalanceSource {
                    base_url: "https://proxy.example.com".to_string(),
                    ..base.clone()
                }
            ),
            "请求地址变化同样算换源（否则气泡会继续显示旧来源的数字）"
        );
    }
}

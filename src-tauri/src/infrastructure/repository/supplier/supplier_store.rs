//! 供应商存储
//!
//! 目录布局（`<数据目录>/supplier/`）：
//! ```text
//! supplier/
//!   ├── index.json                       全量索引缓存（不含密钥）
//!   ├── balance/                         「余额配置」列表（scope = balance）
//!   │     ├── active.json                当前启用项
//!   │     └── <slug>/                    每个已配置供应商一个独立子目录
//!   │           ├── profile.json         名称 / 备注 / 官网 / 分类 / logo / 创建时间 / 排序
//!   │           ├── credential.json      API 密钥（明文，与 config.json 同级安全策略）
//!   │           ├── endpoint.json        请求地址 / 是否完整 URL / 协议格式 / 认证字段 / 候选端点
//!   │           └── usage_history.json   按日聚合的历史用量（账单的唯一数据源）
//!   └── <scope>/                         客户端列表（scope 名即客户端 id，可动态扩展）
//!         ├── active.json
//!         └── <slug>/
//!               ├── profile.json credential.json endpoint.json
//!               └── routing.json        面向该 scope 对应客户端的模型路由
//! ```
//!
//! 在线用量来源（余额接口 / 用量接口）由 `supplier_service::builtin_usage_preset`
//! 按供应商目录名内置提供，**不落盘、不由用户编辑**，因此磁盘上没有对应文件；
//! 历史用量也只属于「余额配置」列表：客户端列表只负责模型路由。
//!
//! 约定：
//! - **两套列表数据完全独立**：同一个供应商可以在 `balance` 与 `claude` 下各存一条、
//!   各存一份 API Key，互不影响；scope 既是一级目录名，也是「这个列表属于谁」的标识
//!   （`balance` 是保留字，其余 scope 名即客户端 id）；
//! - **磁盘格式统一 snake_case**，与前端契约（camelCase）分离：磁盘结构不随前端
//!   字段改名而变，前端转换留在 `api` 层（与 `usage.json` 的做法一致）；
//! - **目录名是唯一事实来源**：供应商目录名即 slug、scope 目录名即客户端标识，
//!   文件内的 `slug` / `client_id` 读取时一律以目录名为准，避免两者漂移后
//!   出现「指向不存在的目录」；
//! - **`active.json` 是每个 scope 独立的一份真实状态**（不是可推导数据）：
//!   没有该文件、或它指向的供应商目录已不存在，都表示该列表当前未启用任何供应商；
//! - **文件缺失视为「尚未配置」并取默认值，JSON 损坏则返回错误**：缺失是正常的
//!   渐进式配置过程，而损坏往往是用户数据受损，静默回退会掩盖问题；
//! - `balance` 列表不参与模型路由，因此其供应商目录下没有 `routing.json`；
//! - 每个供应商的文件都在自己的目录内，删除即整体移除目录，不存在跨供应商引用。

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::domain::client::service::client_service;
use crate::domain::config::model::AppConfig;
use crate::domain::supplier::model::{
    ScopeActive, SupplierCredential, SupplierEndpoint, SupplierIndex, SupplierIndexEntry,
    SupplierProfile, SupplierRouting, SupplierUsageHistory, INDEX_VERSION,
};
use crate::domain::supplier::service::supplier_service as rules;
use crate::infrastructure::system::paths;
use crate::types::exception::{AppError, AppResult};
use crate::types::utils::fs as fs_utils;

/// 索引文件名：它的存在同时是「已启用供应商体系」的迁移哨兵。
const INDEX_FILE: &str = "index.json";
/// 当前启用项文件名（每个 scope 一份）。
const ACTIVE_FILE: &str = "active.json";
/// 展示信息文件名。
const PROFILE_FILE: &str = "profile.json";
/// 密钥文件名。
const CREDENTIAL_FILE: &str = "credential.json";
/// 请求地址文件名。
const ENDPOINT_FILE: &str = "endpoint.json";
/// 历史用量文件名（只有余额配置列表使用）。
const USAGE_HISTORY_FILE: &str = "usage_history.json";
/// 旧版在线用量查询配置文件名：已下线，启动时清理（见 [`cleanup_usage_files`]）。
const LEGACY_USAGE_QUERY_FILE: &str = "usage_query.json";
/// 模型路由文件名：客户端由 scope 目录确定，故无需再把客户端编进文件名。
const ROUTING_FILE: &str = "routing.json";
/// 通用配置片段文件名（与各供应商目录同级，因此不会被当作供应商）。
const COMMON_CONFIG_FILE: &str = "common_config.toml";

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/// 供应商根目录：`<数据目录>/supplier`。
///
/// 三个路径入口（本函数与下面两个）当前只由回归测试消费：生产路径一律在本模块内部
/// 经 `*_at(root, ..)` 私有实现完成。保留它们是因为「供应商文件在哪」是存储层
/// 对外的位置契约（人工排查、后续命令需要定位文件时直接用）。
#[allow(dead_code)]
pub fn supplier_root() -> PathBuf {
    paths::supplier_root()
}

/// 某个列表（scope）的目录：`<root>/<scope>`。
#[allow(dead_code)]
pub fn scope_dir(scope: &str) -> AppResult<PathBuf> {
    scope_dir_at(&paths::supplier_root(), scope)
}

/// 某个供应商的目录：`<root>/<scope>/<slug>`。
#[allow(dead_code)]
pub fn supplier_dir(scope: &str, slug: &str) -> AppResult<PathBuf> {
    dir_at(&paths::supplier_root(), scope, slug)
}

fn scope_dir_at(root: &Path, scope: &str) -> AppResult<PathBuf> {
    Ok(root.join(rules::validate_scope(scope)?))
}

/// 拼接供应商目录：scope 与 slug 都只允许 `[a-z0-9-]`，拼出的路径必然在根目录之下。
fn dir_at(root: &Path, scope: &str, slug: &str) -> AppResult<PathBuf> {
    Ok(scope_dir_at(root, scope)?.join(rules::validate_slug(slug)?))
}

/// 已存在的供应商目录；不存在时报「供应商不存在」。
fn existing_dir_at(root: &Path, scope: &str, slug: &str) -> AppResult<PathBuf> {
    let scope = rules::validate_scope(scope)?;
    let slug = rules::validate_slug(slug)?;
    let dir = root.join(&scope).join(&slug);
    if !dir.is_dir() {
        return Err(AppError::not_found(format!("供应商不存在：{}", slug)));
    }
    Ok(dir)
}

// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

/// 读取供应商索引（全量，覆盖所有 scope）；文件缺失时返回空索引。
///
/// 索引的读写都由存储层内部完成（读取走 `rebuild_index`、写入走 `save_*` 后的刷新），
/// 因此本函数与 [`write_index`] 当前只由回归测试消费（保留原因同 [`supplier_root`]）。
#[allow(dead_code)]
pub fn read_index() -> AppResult<SupplierIndex> {
    read_index_at(&paths::supplier_root())
}

/// 写入供应商索引（原子写盘）。
#[allow(dead_code)]
pub fn write_index(index: &SupplierIndex) -> AppResult<()> {
    write_index_at(&paths::supplier_root(), index)
}

/// 扫描全部 scope 按磁盘现状重建索引并返回（目录是唯一事实来源）。
pub fn rebuild_index() -> AppResult<SupplierIndex> {
    rebuild_index_at(&paths::supplier_root())
}

/// 列出磁盘上全部合法的 scope 目录名（排序后返回）。
///
/// `balance` 与各客户端 id 都在此列；新增客户端只要建出目录就会被识别，
/// 存储层无需知道具体有哪些客户端。
///
/// 生产路径不直接调用它（各入口都自带 scope 校验），因此当前只由回归测试消费
/// （保留原因同 [`supplier_root`]）。
#[allow(dead_code)]
pub fn list_scopes() -> Vec<String> {
    list_scopes_at(&paths::supplier_root())
}

/// 列出某个列表下的供应商（索引条目，不含密钥）。
///
/// 每次调用都按目录现状重建索引，因此「手动增删目录」「上一次写入中断」等情况
/// 都会在读取时自愈，调用方无需自行维护索引。
pub fn list_suppliers(scope: &str) -> AppResult<Vec<SupplierIndexEntry>> {
    let scope = rules::validate_scope(scope)?;
    Ok(rebuild_index()?
        .suppliers
        .into_iter()
        .filter(|entry| entry.scope == scope)
        .collect())
}

/// 列出某个列表下磁盘上存在的供应商标识（排序后返回，过滤非法目录名）。
pub fn list_slugs(scope: &str) -> Vec<String> {
    list_slugs_at(&paths::supplier_root(), scope)
}

fn read_index_at(root: &Path) -> AppResult<SupplierIndex> {
    let mut index = read_json_at::<SupplierIndex>(&root.join(INDEX_FILE))?.unwrap_or_default();
    rules::normalize_index(&mut index);
    Ok(index)
}

fn write_index_at(root: &Path, index: &SupplierIndex) -> AppResult<()> {
    let mut next = index.clone();
    rules::normalize_index(&mut next);
    write_json_at(&root.join(INDEX_FILE), &next)
}

fn rebuild_index_at(root: &Path) -> AppResult<SupplierIndex> {
    let mut entries = Vec::new();
    for scope in list_scopes_at(root) {
        let active = match read_active_at(root, &scope) {
            Ok(active) => active,
            Err(err) => {
                // 启用项损坏不该让整张列表不可用：视为未启用并留日志，便于用户定位修复。
                log::warn!("读取 {}/active.json 失败，视为未启用：{}", scope, err);
                None
            }
        };
        for slug in list_slugs_at(root, &scope) {
            match read_profile_at(root, &scope, &slug) {
                Ok(profile) => entries.push(SupplierIndexEntry::new(
                    &scope,
                    &profile,
                    active.as_deref() == Some(slug.as_str()),
                )),
                // 单个供应商损坏不应让整张列表不可用：跳过并留日志，便于用户定位修复。
                Err(err) => log::warn!("跳过无法读取的供应商目录 {}/{}：{}", scope, slug, err),
            }
        }
    }
    let mut index = SupplierIndex {
        version: INDEX_VERSION,
        suppliers: entries,
    };
    rules::normalize_index(&mut index);

    // 空索引 + 索引文件不存在时不落盘：否则会在旧配置迁移之前「抢先」创建
    // index.json，使迁移条件（index.json 不存在）永远不成立。
    if !root.join(INDEX_FILE).is_file() && index.suppliers.is_empty() {
        return Ok(index);
    }

    let needs_write = match read_index_at(root) {
        Ok(current) => current != index,
        Err(err) => {
            log::warn!("现有供应商索引不可用，将按磁盘现状重建：{}", err);
            true
        }
    };
    if needs_write {
        write_index_at(root, &index)?;
    }
    Ok(index)
}

fn list_scopes_at(root: &Path) -> Vec<String> {
    // scope 目录名必须能通过校验才会被当作列表，避免把无关目录卷进来。
    list_dirs_at(root, |name| rules::validate_scope(name).is_ok())
}

fn list_slugs_at(root: &Path, scope: &str) -> Vec<String> {
    let Ok(scope) = rules::validate_scope(scope) else {
        return Vec::new();
    };
    list_dirs_at(&root.join(scope), |name| rules::validate_slug(name).is_ok())
}

/// 列出目录下的子目录名（过滤掉文件与不接受的名字），排序后返回。
fn list_dirs_at(dir: &Path, accept: impl Fn(&str) -> bool) -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if accept(&name) {
                names.push(name);
            }
        }
    }
    names.sort();
    names
}

// ---------------------------------------------------------------------------
// 展示信息
// ---------------------------------------------------------------------------

/// 读取供应商展示信息；目录不存在时返回「供应商不存在」。
pub fn read_profile(scope: &str, slug: &str) -> AppResult<SupplierProfile> {
    read_profile_at(&paths::supplier_root(), scope, slug)
}

/// 保存供应商展示信息：规范化 + 必填校验 + 原子写盘，并同步刷新索引。
pub fn save_profile(scope: &str, profile: &SupplierProfile) -> AppResult<SupplierProfile> {
    save_profile_at(&paths::supplier_root(), scope, profile)
}

fn read_profile_at(root: &Path, scope: &str, slug: &str) -> AppResult<SupplierProfile> {
    let dir = existing_dir_at(root, scope, slug)?;
    let mut profile = read_json_at::<SupplierProfile>(&dir.join(PROFILE_FILE))?.unwrap_or_default();
    // 目录名是唯一事实来源：文件内的 slug 只作展示副本。
    profile.slug = rules::validate_slug(slug)?;
    rules::normalize_profile(&mut profile);
    Ok(profile)
}

fn save_profile_at(
    root: &Path,
    scope: &str,
    profile: &SupplierProfile,
) -> AppResult<SupplierProfile> {
    let mut next = profile.clone();
    rules::normalize_profile(&mut next);
    rules::validate_profile(&next)?;
    // 创建时间只在首次落盘时写入：重复保存不得刷新它，否则「创建时间」会变成
    // 「最后修改时间」，索引排序也随之漂移。
    if next.created_at.is_empty() {
        next.created_at = rules::now_timestamp();
    }

    let dir = dir_at(root, scope, &next.slug)?;
    fs::create_dir_all(&dir).map_err(|e| AppError::io(format!("创建供应商目录失败：{}", e)))?;
    write_json_at(&dir.join(PROFILE_FILE), &next)?;

    // 索引由目录现状推导，保存后立即刷新，保证列表与磁盘一致。
    rebuild_index_at(root)?;
    Ok(next)
}

// ---------------------------------------------------------------------------
// 密钥 / 请求地址 / 用量查询 / 历史用量
// ---------------------------------------------------------------------------

/// 读取 API 密钥；文件缺失时返回默认（空密钥）。
pub fn read_credential(scope: &str, slug: &str) -> AppResult<SupplierCredential> {
    read_credential_at(&paths::supplier_root(), scope, slug)
}

/// 保存 API 密钥（原子写盘）。
pub fn save_credential(scope: &str, slug: &str, credential: &SupplierCredential) -> AppResult<()> {
    save_credential_at(&paths::supplier_root(), scope, slug, credential)
}

/// 读取请求地址配置；文件缺失时返回默认值。
pub fn read_endpoint(scope: &str, slug: &str) -> AppResult<SupplierEndpoint> {
    read_endpoint_at(&paths::supplier_root(), scope, slug)
}

/// 保存请求地址配置（规范化 + 必填校验 + 原子写盘）。
pub fn save_endpoint(scope: &str, slug: &str, endpoint: &SupplierEndpoint) -> AppResult<()> {
    save_endpoint_at(&paths::supplier_root(), scope, slug, endpoint)
}

/// 读取历史用量；文件缺失时返回默认值。仅余额配置列表有历史用量。
pub fn read_usage_history(scope: &str, slug: &str) -> AppResult<SupplierUsageHistory> {
    read_usage_history_at(&paths::supplier_root(), scope, slug)
}

/// 保存历史用量（原子写盘）。仅余额配置列表有历史用量。
pub fn save_usage_history(
    scope: &str,
    slug: &str,
    history: &SupplierUsageHistory,
) -> AppResult<()> {
    save_usage_history_at(&paths::supplier_root(), scope, slug, history)
}

/// 历史用量文件是否已存在。
///
/// 存在的含义是「该供应商已有自己的用量数据」，调用方据此决定是否还要导入旧账本
/// （避免把历史积累覆盖掉）。
pub fn usage_history_exists(scope: &str, slug: &str) -> AppResult<bool> {
    let dir = existing_dir_at(&paths::supplier_root(), scope, slug)?;
    Ok(dir.join(USAGE_HISTORY_FILE).is_file())
}

/// 清理已经下线的用量文件，返回删除的文件数。
///
/// 两件事：
/// - 在线用量来源改为**内置**（按供应商目录名匹配 `builtin_usage_preset`，不落盘、
///   不由用户编辑），因此磁盘上的 `usage_query.json` 已无任何读取方，留着只会误导
///   「可以自己配接口」；
/// - 客户端列表只负责模型路由，不做余额 / 用量，其 `usage_history.json` 同样无用。
///
/// 幂等（文件不存在即跳过），可在每次启动时调用。
pub fn cleanup_usage_files() -> AppResult<usize> {
    cleanup_usage_files_at(&paths::supplier_root())
}

fn cleanup_usage_files_at(root: &Path) -> AppResult<usize> {
    let mut removed = 0usize;
    for scope in list_scopes_at(root) {
        let stale = if scope == rules::BALANCE_SCOPE {
            // 余额配置列表保留 `usage_history.json`（它现在是账单的唯一数据源），
            // 只删已下线的在线查询配置。
            &[LEGACY_USAGE_QUERY_FILE][..]
        } else {
            &[LEGACY_USAGE_QUERY_FILE, USAGE_HISTORY_FILE][..]
        };
        for slug in list_slugs_at(root, &scope) {
            let dir = root.join(&scope).join(&slug);
            for name in stale {
                let path = dir.join(name);
                if !path.is_file() {
                    continue;
                }
                match fs::remove_file(&path) {
                    Ok(()) => {
                        removed += 1;
                        log::info!("已删除过期的用量文件：{}/{}/{}", scope, slug, name);
                    }
                    Err(err) => log::warn!(
                        "删除过期用量文件失败（{}/{}/{}）：{}",
                        scope,
                        slug,
                        name,
                        err
                    ),
                }
            }
        }
    }
    Ok(removed)
}

fn read_credential_at(root: &Path, scope: &str, slug: &str) -> AppResult<SupplierCredential> {
    let dir = existing_dir_at(root, scope, slug)?;
    let mut credential =
        read_json_at::<SupplierCredential>(&dir.join(CREDENTIAL_FILE))?.unwrap_or_default();
    rules::normalize_credential(&mut credential);
    Ok(credential)
}

fn save_credential_at(
    root: &Path,
    scope: &str,
    slug: &str,
    credential: &SupplierCredential,
) -> AppResult<()> {
    let dir = existing_dir_at(root, scope, slug)?;
    let mut next = credential.clone();
    rules::normalize_credential(&mut next);
    write_json_at(&dir.join(CREDENTIAL_FILE), &next)
}

fn read_endpoint_at(root: &Path, scope: &str, slug: &str) -> AppResult<SupplierEndpoint> {
    let dir = existing_dir_at(root, scope, slug)?;
    let mut endpoint =
        read_json_at::<SupplierEndpoint>(&dir.join(ENDPOINT_FILE))?.unwrap_or_default();
    rules::normalize_endpoint(scope, &mut endpoint);
    Ok(endpoint)
}

fn save_endpoint_at(
    root: &Path,
    scope: &str,
    slug: &str,
    endpoint: &SupplierEndpoint,
) -> AppResult<()> {
    let dir = existing_dir_at(root, scope, slug)?;
    let mut next = endpoint.clone();
    rules::normalize_endpoint(scope, &mut next);
    rules::validate_endpoint(&next)?;
    write_json_at(&dir.join(ENDPOINT_FILE), &next)
}

fn read_usage_history_at(root: &Path, scope: &str, slug: &str) -> AppResult<SupplierUsageHistory> {
    let dir = existing_dir_at(root, scope, slug)?;
    let mut history =
        read_json_at::<SupplierUsageHistory>(&dir.join(USAGE_HISTORY_FILE))?.unwrap_or_default();
    rules::normalize_usage_history(&mut history);
    Ok(history)
}

fn save_usage_history_at(
    root: &Path,
    scope: &str,
    slug: &str,
    history: &SupplierUsageHistory,
) -> AppResult<()> {
    let dir = existing_dir_at(root, scope, slug)?;
    let mut next = history.clone();
    rules::normalize_usage_history(&mut next);
    if next.updated_at.is_empty() {
        next.updated_at = rules::now_timestamp();
    }
    write_json_at(&dir.join(USAGE_HISTORY_FILE), &next)
}

// ---------------------------------------------------------------------------
// 模型路由（客户端由 scope 目录确定，一供应商一文件）
// ---------------------------------------------------------------------------

/// 读取某供应商的模型路由（文件 `routing.json`）。scope == `BALANCE_SCOPE` 时报错。
pub fn read_routing(scope: &str, slug: &str) -> AppResult<SupplierRouting> {
    read_routing_at(&paths::supplier_root(), scope, slug)
}

/// 保存模型路由（规范化 + 必填校验 + 原子写盘）。scope == `BALANCE_SCOPE` 时报错。
pub fn save_routing(scope: &str, slug: &str, routing: &SupplierRouting) -> AppResult<()> {
    save_routing_at(&paths::supplier_root(), scope, slug, routing)
}

/// 校验该 scope 是否参与模型路由：余额配置列表只查余额/用量，不写客户端配置。
fn routable_scope(scope: &str) -> AppResult<String> {
    let scope = rules::validate_scope(scope)?;
    if scope == rules::BALANCE_SCOPE {
        return Err(AppError::invalid("余额配置列表不参与模型路由"));
    }
    Ok(scope)
}

fn read_routing_at(root: &Path, scope: &str, slug: &str) -> AppResult<SupplierRouting> {
    let scope = routable_scope(scope)?;
    let dir = existing_dir_at(root, &scope, slug)?;
    let mut routing = read_json_at::<SupplierRouting>(&dir.join(ROUTING_FILE))?.unwrap_or_default();
    // scope 目录名是唯一事实来源：文件内的 client_id 只作展示副本。
    routing.client_id = scope;
    rules::normalize_routing(&mut routing);
    Ok(routing)
}

fn save_routing_at(
    root: &Path,
    scope: &str,
    slug: &str,
    routing: &SupplierRouting,
) -> AppResult<()> {
    let scope = routable_scope(scope)?;
    let dir = existing_dir_at(root, &scope, slug)?;
    let mut next = routing.clone();
    // 同上：写入的 client_id 一律以 scope 目录名为准，杜绝字段与目录漂移。
    next.client_id = scope;
    rules::normalize_routing(&mut next);
    rules::validate_routing(&next)?;
    write_json_at(&dir.join(ROUTING_FILE), &next)
}

// ---------------------------------------------------------------------------
// 当前启用项（每个 scope 独立一份）
// ---------------------------------------------------------------------------

/// 读取 scope 的当前启用项；无 `active.json`、或该供应商目录已不存在时返回 `None`（自愈）。
pub fn read_active(scope: &str) -> AppResult<Option<String>> {
    read_active_at(&paths::supplier_root(), scope)
}

/// 设置 scope 的当前启用项（该供应商必须已存在，否则报 not_found）。
pub fn set_active(scope: &str, slug: &str) -> AppResult<()> {
    set_active_at(&paths::supplier_root(), scope, slug)
}

fn read_active_at(root: &Path, scope: &str) -> AppResult<Option<String>> {
    let dir = scope_dir_at(root, scope)?;
    let Some(active) = read_json_at::<ScopeActive>(&dir.join(ACTIVE_FILE))? else {
        return Ok(None);
    };
    let mut active = active;
    rules::normalize_scope_active(&mut active);
    // 用户手工删掉供应商目录后不能卡在「启用了不存在的供应商」：目录不在即视为未启用。
    let Ok(slug) = rules::validate_slug(&active.active_slug) else {
        return Ok(None);
    };
    if !dir.join(&slug).is_dir() {
        return Ok(None);
    }
    Ok(Some(slug))
}

fn set_active_at(root: &Path, scope: &str, slug: &str) -> AppResult<()> {
    let scope = rules::validate_scope(scope)?;
    existing_dir_at(root, &scope, slug)?;
    let mut active = ScopeActive {
        active_slug: rules::validate_slug(slug)?,
    };
    rules::normalize_scope_active(&mut active);
    write_json_at(&scope_dir_at(root, &scope)?.join(ACTIVE_FILE), &active)?;

    // 索引里带着 `active` 快照，状态变化后立即刷新缓存；失败不阻断（下次列表会自愈）。
    if let Err(err) = rebuild_index_at(root) {
        log::warn!("刷新供应商索引失败：{}", err);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

/// 删除一个供应商：整体移除其目录（含全部子文件），并同步索引。
///
/// 正在使用中的供应商必须先切换再删除，否则余额展示 / 客户端配置会立刻失去数据源。
pub fn delete_supplier(scope: &str, slug: &str) -> AppResult<()> {
    delete_supplier_at(&paths::supplier_root(), scope, slug)
}

fn delete_supplier_at(root: &Path, scope: &str, slug: &str) -> AppResult<()> {
    let dir = existing_dir_at(root, scope, slug)?;
    let scope = rules::validate_scope(scope)?;
    let slug = rules::validate_slug(slug)?;
    if read_active_at(root, &scope)? == Some(slug.clone()) {
        return Err(AppError::invalid("该供应商正在使用中，请先切换后再删除"));
    }
    fs::remove_dir_all(&dir).map_err(|e| AppError::io(format!("删除供应商失败：{}", e)))?;

    // 索引刷新失败不阻断删除（目录已删，下次列表会自愈），仅留日志。
    if let Err(err) = rebuild_index_at(root) {
        log::warn!("刷新供应商索引失败：{}", err);
    }
    log::info!("已删除供应商：{}/{}（{}）", scope, slug, dir.display());
    Ok(())
}

// ---------------------------------------------------------------------------
// 旧配置迁移
// ---------------------------------------------------------------------------

/// 把旧配置（`config.json`）中的 API Key / 请求地址迁移为供应商。
///
/// 迁移条件（同时满足才执行）：
/// 1. `supplier/index.json` 不存在——索引是「已启用供应商体系」的哨兵；
/// 2. 旧配置里存在 API Key——没有密钥就没有可迁移的实质内容。
///
/// 因此本函数天然幂等：重复调用（含启动竞态）最多只会创建一批供应商。
///
/// 旧配置的密钥与地址**同时**供余额展示与 Claude / Codex 写配置使用，因此这里
/// 在余额配置与各客户端列表下各建一份同等配置（密钥各存一份），并把三个列表的
/// 当前启用项都指向它，使升级后既有行为不中断。
pub fn migrate_legacy_config(legacy: &AppConfig) -> AppResult<Option<SupplierProfile>> {
    migrate_legacy_config_at(&paths::supplier_root(), legacy)
}

fn migrate_legacy_config_at(root: &Path, legacy: &AppConfig) -> AppResult<Option<SupplierProfile>> {
    let api_key = legacy.api_key.trim();
    if api_key.is_empty() || root.join(INDEX_FILE).is_file() {
        return Ok(None);
    }

    let mut balance_profile = None;
    for scope in migration_scopes() {
        // 与旧配置等价的展示信息；`custom-<n>` 的序号按**该 scope 内**已占用的目录名分配，
        // 因此各列表的序号彼此独立，不会因为别的列表占了号而错位。
        let (slug, name, category) = match rules::infer_supplier(&legacy.base_url) {
            rules::InferredSupplier::Known(known) => (
                known.slug.to_string(),
                known.name.to_string(),
                known.category.to_string(),
            ),
            rules::InferredSupplier::Custom => (
                next_custom_slug(root, &scope),
                rules::CUSTOM_SUPPLIER_NAME.to_string(),
                rules::CUSTOM_SUPPLIER_CATEGORY.to_string(),
            ),
        };
        // 目录已存在说明上次迁移只完成了一半（如进程中断、用户删掉了 index.json）：
        // 此时跳过该 scope，避免覆盖已有目录或叠加出第二个同品牌供应商。
        if root.join(&scope).join(&slug).is_dir() {
            continue;
        }

        let profile = save_profile_at(
            root,
            &scope,
            &SupplierProfile {
                slug: slug.clone(),
                name,
                category,
                ..SupplierProfile::default()
            },
        )?;
        save_credential_at(
            root,
            &scope,
            &slug,
            &SupplierCredential {
                api_key: api_key.to_string(),
                ..SupplierCredential::default()
            },
        )?;
        save_endpoint_at(
            root,
            &scope,
            &slug,
            &SupplierEndpoint {
                base_url: legacy.base_url.trim().to_string(),
                ..SupplierEndpoint::default()
            },
        )?;
        // 升级后各列表立即有可用数据源：既不中断余额展示，也不中断客户端配置写入。
        set_active_at(root, &scope, &slug)?;

        if scope == rules::BALANCE_SCOPE {
            balance_profile = Some(profile);
        }
    }

    let Some(balance_profile) = balance_profile else {
        return Ok(None);
    };
    log::info!(
        "已把旧配置迁移为供应商：{}/{}（{}）",
        rules::BALANCE_SCOPE,
        balance_profile.slug,
        balance_profile.name
    );
    Ok(Some(balance_profile))
}

/// 迁移覆盖的 scope：余额配置列表 + 全部已登记客户端。
fn migration_scopes() -> Vec<String> {
    let mut scopes = vec![rules::BALANCE_SCOPE.to_string()];
    scopes.extend(
        client_service::list_clients()
            .iter()
            .map(|client| client.id.to_string()),
    );
    scopes
}

/// 分配未占用的自定义供应商标识：`custom-1`、`custom-2`…
///
/// 从 1 递增取第一个未占用的序号，使结果只取决于该 scope 的磁盘现状（可重复、可预期）。
fn next_custom_slug(root: &Path, scope: &str) -> String {
    let taken = list_slugs_at(root, scope);
    let mut index = 1u32;
    loop {
        let candidate = rules::custom_slug(index);
        if !taken.contains(&candidate) {
            return candidate;
        }
        index += 1;
    }
}

// ---------------------------------------------------------------------------
// JSON 读写
// ---------------------------------------------------------------------------

/// 读取 JSON：文件缺失返回 `None`（由调用方给默认值），损坏返回错误。
///
/// 「缺失」与「损坏」必须区分处理：缺失是用户尚未配置（正常），
/// 损坏则意味着数据受损，静默回退会把用户的配置悄悄换掉。
fn read_json_at<T: DeserializeOwned>(path: &Path) -> AppResult<Option<T>> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| {
            AppError::serde(format!("解析供应商配置失败（{}）：{}", path.display(), e))
        }),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(AppError::io(format!(
            "读取供应商配置失败（{}）：{}",
            path.display(),
            err
        ))),
    }
}

/// 原子写入 JSON（必要时先建目录），避免半写损坏。
fn write_json_at<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::io(format!("创建供应商目录失败：{}", e)))?;
    }
    let json = serde_json::to_string_pretty(value).map_err(|e| AppError::serde(e.to_string()))?;
    fs_utils::write_atomic(
        path,
        json.as_bytes(),
        |e| AppError::io(format!("写入供应商配置失败：{}", e)),
        |e| AppError::io(format!("保存供应商配置失败：{}", e)),
    )
}

// ---------------------------------------------------------------------------
// 通用配置片段（客户端列表专属）
// ---------------------------------------------------------------------------

/// 读取某个列表的「通用配置片段」（TOML 文本）。
///
/// 文件缺失 = 尚未配置，返回空串（不是错误）；读盘失败才报错——
/// 与其它供应商文件同一套策略（缺失是渐进式配置的常态，损坏要暴露）。
pub fn read_common_config(scope: &str) -> AppResult<String> {
    let path = common_config_path(&paths::supplier_root(), scope)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(AppError::io(format!(
            "读取通用配置片段失败（{}）：{}",
            path.display(),
            err
        ))),
    }
}

/// 保存某个列表的「通用配置片段」（原子写；空串表示清空内容）。
pub fn save_common_config(scope: &str, snippet: &str) -> AppResult<()> {
    let path = common_config_path(&paths::supplier_root(), scope)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::io(format!("创建供应商目录失败：{}", e)))?;
    }
    fs_utils::write_atomic(
        &path,
        snippet.as_bytes(),
        |e| AppError::io(format!("写入通用配置片段失败：{}", e)),
        |e| AppError::io(format!("保存通用配置片段失败：{}", e)),
    )
}

/// 通用配置片段的路径：`<root>/<scope>/common_config.toml`。
///
/// 与各供应商目录同级，因此 `list_slugs`（只认目录）不会把它当成一个供应商。
fn common_config_path(root: &Path, scope: &str) -> AppResult<PathBuf> {
    Ok(scope_dir_at(root, scope)?.join(COMMON_CONFIG_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::supplier::model::DailyUsage;
    use std::collections::BTreeMap;

    /// 独立临时目录：供应商存储的测试一律不碰真实数据目录。
    fn unique_root(tag: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("dsw-supplier-test-{}-{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn sample_profile(slug: &str) -> SupplierProfile {
        SupplierProfile {
            slug: slug.to_string(),
            name: "示例供应商".to_string(),
            ..SupplierProfile::default()
        }
    }

    fn create_supplier(root: &Path, scope: &str, slug: &str) {
        save_profile_at(root, scope, &sample_profile(slug)).expect("创建供应商应成功");
    }

    fn write_credential(root: &Path, scope: &str, slug: &str, api_key: &str) {
        save_credential_at(
            root,
            scope,
            slug,
            &SupplierCredential {
                api_key: api_key.to_string(),
                ..SupplierCredential::default()
            },
        )
        .expect("保存密钥应成功");
    }

    /// 测试用的路径入口：与公开入口同构，但显式传入根目录并只取某个 scope。
    fn list_suppliers_at(root: &Path, scope: &str) -> AppResult<Vec<SupplierIndexEntry>> {
        let scope = rules::validate_scope(scope)?;
        Ok(rebuild_index_at(root)?
            .suppliers
            .into_iter()
            .filter(|entry| entry.scope == scope)
            .collect())
    }

    /// 两个 scope 下同名供应商各存一份互不影响的配置。
    #[test]
    fn scopes_hold_independent_copies() {
        let root = unique_root("scopes");
        create_supplier(&root, rules::BALANCE_SCOPE, "deepseek");
        create_supplier(&root, "claude", "deepseek");
        write_credential(&root, rules::BALANCE_SCOPE, "deepseek", "sk-balance");
        write_credential(&root, "claude", "deepseek", "sk-claude");

        assert_eq!(
            read_credential_at(&root, rules::BALANCE_SCOPE, "deepseek")
                .unwrap()
                .api_key,
            "sk-balance"
        );
        assert_eq!(
            read_credential_at(&root, "claude", "deepseek")
                .unwrap()
                .api_key,
            "sk-claude",
            "同名供应商在两个列表下的密钥互不影响"
        );
        assert!(root.join(rules::BALANCE_SCOPE).join("deepseek").is_dir());
        assert!(root.join("claude").join("deepseek").is_dir());
        assert_eq!(
            list_scopes_at(&root),
            vec!["balance".to_string(), "claude".to_string()]
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// 单个供应商的全部子文件写入 → 读取往返。
    #[test]
    fn supplier_files_roundtrip() {
        let root = unique_root("roundtrip");
        let saved = save_profile_at(&root, "claude", &sample_profile("deepseek")).unwrap();
        assert_eq!(saved.slug, "deepseek");
        assert!(!saved.created_at.is_empty(), "创建时间应在首次落盘时写入");

        write_credential(&root, "claude", "deepseek", "  sk-test  ");
        save_endpoint_at(
            &root,
            "claude",
            "deepseek",
            &SupplierEndpoint {
                base_url: " https://api.deepseek.com/anthropic/ ".to_string(),
                full_url: false,
                api_format: "anthropic".to_string(),
                auth_field: "x-api-key".to_string(),
                endpoint_candidates: vec!["https://api.deepseek.com/anthropic".to_string()],
            },
        )
        .unwrap();
        save_usage_history_at(
            &root,
            "claude",
            "deepseek",
            &SupplierUsageHistory {
                updated_at: String::new(),
                last_balance: Some(9.5),
                currency: "cny".to_string(),
                daily: BTreeMap::from([(
                    "2026-01-01".to_string(),
                    DailyUsage {
                        local: 1.25,
                        remote: 2.5,
                        ..DailyUsage::default()
                    },
                )]),
                ..SupplierUsageHistory::default()
            },
        )
        .unwrap();

        assert_eq!(
            read_profile_at(&root, "claude", "deepseek").unwrap(),
            saved,
            "展示信息读回应一致"
        );
        assert_eq!(
            read_credential_at(&root, "claude", "deepseek")
                .unwrap()
                .api_key,
            "sk-test"
        );
        let endpoint = read_endpoint_at(&root, "claude", "deepseek").unwrap();
        assert_eq!(endpoint.base_url, "https://api.deepseek.com/anthropic");
        assert_eq!(endpoint.api_format, "anthropic");
        let history = read_usage_history_at(&root, "claude", "deepseek").unwrap();
        assert!(!history.updated_at.is_empty(), "保存时应补上更新时间");
        assert_eq!(history.daily.get("2026-01-01").unwrap().local, 1.25);
        assert_eq!(history.last_balance, Some(9.5), "差值记账基准应往返一致");
        assert_eq!(history.currency, "CNY", "币种落盘前应统一大写");

        let _ = fs::remove_dir_all(&root);
    }

    /// 模型路由：一个供应商一份 `routing.json`，客户端由 scope 目录确定。
    #[test]
    fn routing_file_is_bound_to_scope() {
        let root = unique_root("routing");
        create_supplier(&root, "claude", "deepseek");
        create_supplier(&root, "codex", "deepseek");

        assert!(
            read_routing_at(&root, rules::BALANCE_SCOPE, "deepseek").is_err(),
            "余额配置列表不参与模型路由"
        );
        assert!(save_routing_at(
            &root,
            rules::BALANCE_SCOPE,
            "deepseek",
            &SupplierRouting::default()
        )
        .is_err());

        // 写盘时故意传错 client_id：文件内的字段必须以 scope 目录名为准。
        save_routing_at(
            &root,
            "claude",
            "deepseek",
            &SupplierRouting {
                client_id: "codex".to_string(),
                model_map: BTreeMap::from([(
                    "claude-3-5-sonnet".to_string(),
                    "deepseek-chat".to_string(),
                )]),
                ..SupplierRouting::default()
            },
        )
        .unwrap();
        let path = root.join("claude").join("deepseek").join(ROUTING_FILE);
        assert_eq!(ROUTING_FILE, "routing.json");
        assert!(path.is_file(), "路由文件必须叫 routing.json");
        assert!(!root
            .join("claude")
            .join("deepseek")
            .join("routing.codex.json")
            .exists());

        let routing = read_routing_at(&root, "claude", "deepseek").unwrap();
        assert_eq!(routing.client_id, "claude", "client_id 由 scope 目录名覆盖");
        assert_eq!(
            routing
                .model_map
                .get("claude-3-5-sonnet")
                .map(String::as_str),
            Some("deepseek-chat")
        );

        // 同一供应商在另一个客户端列表下的路由互不干扰。
        save_routing_at(
            &root,
            "codex",
            "deepseek",
            &SupplierRouting {
                client_id: "claude".to_string(),
                context_window: 128_000,
                ..SupplierRouting::default()
            },
        )
        .unwrap();
        let codex = read_routing_at(&root, "codex", "deepseek").unwrap();
        assert_eq!(codex.client_id, "codex");
        assert_eq!(codex.context_window, 128_000);
        assert!(
            codex.model_map.is_empty(),
            "另一个列表下的路由文件不会被串读"
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// 当前启用项往返：写入 → 读回 → 索引里只有它 active。
    #[test]
    fn active_marks_exactly_one_entry_per_scope() {
        let root = unique_root("active");
        create_supplier(&root, "claude", "deepseek");
        create_supplier(&root, "claude", "kimi");
        create_supplier(&root, rules::BALANCE_SCOPE, "deepseek");

        assert_eq!(
            read_active_at(&root, "claude").unwrap(),
            None,
            "没有 active.json 表示该列表未启用任何供应商"
        );

        set_active_at(&root, "claude", "kimi").unwrap();
        assert_eq!(
            read_active_at(&root, "claude").unwrap(),
            Some("kimi".to_string())
        );
        assert!(root.join("claude").join(ACTIVE_FILE).is_file());
        assert_eq!(
            read_active_at(&root, rules::BALANCE_SCOPE).unwrap(),
            None,
            "active.json 是每个 scope 独立的一份"
        );

        let entries = list_suppliers_at(&root, "claude").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.active)
                .map(|entry| entry.slug.as_str())
                .collect::<Vec<_>>(),
            vec!["kimi"],
            "同一列表内只有当前启用项 active"
        );

        // 切换启用项后旧项不再 active。
        set_active_at(&root, "claude", "deepseek").unwrap();
        assert_eq!(
            list_suppliers_at(&root, "claude")
                .unwrap()
                .iter()
                .filter(|entry| entry.active)
                .map(|entry| entry.slug.as_str())
                .collect::<Vec<_>>(),
            vec!["deepseek"]
        );

        // 指向不存在的供应商：必须报 not_found，而不是写入一个悬空标记。
        let err = set_active_at(&root, "claude", "nope").unwrap_err();
        assert_eq!(err.message(), "供应商不存在：nope");

        let _ = fs::remove_dir_all(&root);
    }

    /// active 指向已删除 / 非法的目录时自愈为「未启用」。
    #[test]
    fn active_is_self_healing() {
        let root = unique_root("active-heal");
        create_supplier(&root, "claude", "kimi");
        set_active_at(&root, "claude", "kimi").unwrap();

        fs::remove_dir_all(root.join("claude").join("kimi")).unwrap();
        assert_eq!(
            read_active_at(&root, "claude").unwrap(),
            None,
            "用户手工删目录后不得卡在「启用了不存在的供应商」"
        );
        assert!(list_suppliers_at(&root, "claude").unwrap().is_empty());

        // 手工写入的非法 slug 同样视为未启用。
        create_supplier(&root, "claude", "kimi");
        write_json_at(
            &root.join("claude").join(ACTIVE_FILE),
            &ScopeActive {
                active_slug: "../escape".to_string(),
            },
        )
        .unwrap();
        assert_eq!(read_active_at(&root, "claude").unwrap(), None);
        assert!(!root.parent().unwrap().join("escape").exists());

        let _ = fs::remove_dir_all(&root);
    }

    /// 删除：当前启用项被拦截；非启用项删除后目录整体消失且索引同步。
    #[test]
    fn delete_blocks_active_supplier_and_cleans_dir() {
        let root = unique_root("delete");
        create_supplier(&root, "claude", "deepseek");
        create_supplier(&root, "claude", "kimi");
        create_supplier(&root, "claude", "modelscope");
        write_credential(&root, "claude", "kimi", "sk-kimi");
        set_active_at(&root, "claude", "kimi").unwrap();

        let err = delete_supplier_at(&root, "claude", "kimi").unwrap_err();
        assert_eq!(err.message(), "该供应商正在使用中，请先切换后再删除");
        assert!(
            root.join("claude").join("kimi").is_dir(),
            "被拦截时不得删除任何文件"
        );

        delete_supplier_at(&root, "claude", "deepseek").unwrap();
        assert!(
            !root.join("claude").join("deepseek").exists(),
            "供应商目录必须整体消失"
        );
        assert_eq!(
            list_slugs_at(&root, "claude"),
            vec!["kimi".to_string(), "modelscope".to_string()]
        );
        let index = read_index_at(&root).unwrap();
        assert_eq!(index.suppliers.len(), 2, "索引不应残留已删除的供应商");
        assert!(index.suppliers.iter().all(|entry| entry.slug != "deepseek"));
        assert!(
            delete_supplier_at(&root, "claude", "deepseek").is_err(),
            "重复删除应报「供应商不存在」"
        );

        // 切换到另一个供应商后，原启用项即可删除。
        set_active_at(&root, "claude", "modelscope").unwrap();
        delete_supplier_at(&root, "claude", "kimi").unwrap();
        let list = list_suppliers_at(&root, "claude").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].slug, "modelscope");
        assert!(list[0].active);

        let _ = fs::remove_dir_all(&root);
    }

    /// 文件缺失取默认值（渐进式配置），目录缺失则报「供应商不存在」。
    #[test]
    fn missing_files_fall_back_to_defaults() {
        let root = unique_root("missing");
        create_supplier(&root, "claude", "deepseek");

        assert_eq!(
            read_credential_at(&root, "claude", "deepseek").unwrap(),
            SupplierCredential::default()
        );
        // 认证字段按 scope 归一化：Claude 的取值是注册表登记的环境变量名（默认 AUTH_TOKEN）。
        let mut expected_endpoint = SupplierEndpoint::default();
        expected_endpoint.auth_field = "ANTHROPIC_AUTH_TOKEN".to_string();
        assert_eq!(
            read_endpoint_at(&root, "claude", "deepseek").unwrap(),
            expected_endpoint
        );
        assert_eq!(
            read_usage_history_at(&root, "claude", "deepseek").unwrap(),
            SupplierUsageHistory::default()
        );
        assert_eq!(
            read_routing_at(&root, "claude", "deepseek").unwrap(),
            SupplierRouting {
                client_id: "claude".to_string(),
                ..SupplierRouting::default()
            },
            "缺失的路由文件应给出「属于该客户端」的默认值"
        );
        assert_eq!(read_active_at(&root, "claude").unwrap(), None);
        assert_eq!(
            read_index_at(&root).unwrap(),
            SupplierIndex {
                version: INDEX_VERSION,
                suppliers: vec![SupplierIndexEntry::new(
                    "claude",
                    &sample_profile("deepseek"),
                    false
                )],
            }
        );

        // 目录不存在：明确报错而不是返回一个「空供应商」。
        let err = read_profile_at(&root, "claude", "nope").unwrap_err();
        assert_eq!(err.message(), "供应商不存在：nope");
        assert!(read_credential_at(&root, "claude", "nope").is_err());

        let _ = fs::remove_dir_all(&root);
    }

    /// 损坏的 JSON 必须返回错误而不是 panic，也不能被静默覆盖成默认值。
    #[test]
    fn corrupted_json_returns_error() {
        let root = unique_root("corrupt");
        create_supplier(&root, "claude", "deepseek");
        let dir = root.join("claude").join("deepseek");

        // 索引损坏：读取报错，但列表可按目录现状自愈重建。
        fs::write(root.join(INDEX_FILE), b"broken").unwrap();
        assert!(read_index_at(&root).is_err());
        let rebuilt = rebuild_index_at(&root).unwrap();
        assert_eq!(rebuilt.suppliers.len(), 1);
        assert!(read_index_at(&root).is_ok(), "重建后索引应恢复可读");

        // 供应商子文件损坏：读取报错，绝不回退默认值。
        fs::write(dir.join(PROFILE_FILE), b"{ not json").unwrap();
        assert!(read_profile_at(&root, "claude", "deepseek")
            .unwrap_err()
            .message()
            .starts_with("解析供应商配置失败"));

        fs::write(dir.join(CREDENTIAL_FILE), b"{\"api_key\": 123}").unwrap();
        assert!(
            read_credential_at(&root, "claude", "deepseek").is_err(),
            "类型不符也属于损坏"
        );

        // 损坏的供应商只是从列表中消失，不影响其它数据与调用方。
        assert!(list_suppliers_at(&root, "claude").unwrap().is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    /// 非法目录名（含目录穿越）必须在触碰磁盘之前被拒绝。
    #[test]
    fn illegal_names_are_rejected_without_touching_disk() {
        let root = unique_root("traversal");
        create_supplier(&root, "claude", "deepseek");

        for bad in ["../escape", "..", "a/b", "a\\b", ""] {
            assert!(
                read_profile_at(&root, "claude", bad).is_err(),
                "「{}」应被拒绝",
                bad
            );
            assert!(save_profile_at(&root, "claude", &sample_profile(bad)).is_err());
            assert!(read_credential_at(&root, "claude", bad).is_err());
            assert!(read_profile_at(&root, bad, "deepseek").is_err());
            assert!(save_profile_at(&root, bad, &sample_profile("deepseek")).is_err());
            assert!(delete_supplier_at(&root, bad, "deepseek").is_err());
        }
        assert!(
            !root.join("escape").exists() && !root.parent().unwrap().join("escape").exists(),
            "不得在供应商根目录之外创建任何内容"
        );
        assert!(read_routing_at(&root, "../claude", "deepseek").is_err());
        assert_eq!(
            list_slugs_at(&root, "claude"),
            vec!["deepseek".to_string()],
            "只有合法目录名会被识别为供应商"
        );
        assert_eq!(list_scopes_at(&root), vec!["claude".to_string()]);

        let _ = fs::remove_dir_all(&root);
    }

    /// `list_scopes` / `list_slugs` 只识别合法目录名。
    #[test]
    fn listings_ignore_illegal_directory_names() {
        let root = unique_root("illegal-dirs");
        create_supplier(&root, "claude", "deepseek");
        fs::create_dir_all(root.join("Bad_Name")).unwrap();
        fs::create_dir_all(root.join("claude").join("Bad_Name")).unwrap();
        fs::write(root.join("not-a-dir"), b"x").unwrap();

        assert_eq!(
            list_scopes_at(&root),
            vec!["claude".to_string()],
            "非法 scope 目录名必须被忽略"
        );
        assert_eq!(list_slugs_at(&root, "claude"), vec!["deepseek".to_string()]);
        assert!(list_slugs_at(&root, "../escape").is_empty());
        assert_eq!(rebuild_index_at(&root).unwrap().suppliers.len(), 1);

        let _ = fs::remove_dir_all(&root);
    }

    /// 单个供应商损坏时，列表仍应可用（跳过并留日志），而不是整表失败。
    #[test]
    fn list_skips_corrupted_supplier() {
        let root = unique_root("skip");
        create_supplier(&root, "claude", "deepseek");
        create_supplier(&root, "claude", "kimi");
        fs::write(
            root.join("claude").join("kimi").join(PROFILE_FILE),
            b"broken",
        )
        .unwrap();

        assert_eq!(
            list_slugs_at(&root, "claude"),
            vec!["deepseek".to_string(), "kimi".to_string()]
        );
        let list = list_suppliers_at(&root, "claude").unwrap();
        assert_eq!(list.len(), 1, "损坏的供应商应被跳过");
        assert_eq!(list[0].slug, "deepseek");

        let _ = fs::remove_dir_all(&root);
    }

    /// 索引先按 scope，再按 profile 的 `order` / 名称排序。
    #[test]
    fn index_is_ordered_by_scope_then_profile() {
        let root = unique_root("order");
        let profile = |slug: &str, order: i64| SupplierProfile {
            order,
            ..sample_profile(slug)
        };
        save_profile_at(&root, "claude", &profile("third", 30)).unwrap();
        save_profile_at(&root, rules::BALANCE_SCOPE, &profile("only", 5)).unwrap();
        save_profile_at(&root, "claude", &profile("first", 10)).unwrap();
        save_profile_at(&root, "claude", &profile("second", 20)).unwrap();

        let entries: Vec<(String, String)> = read_index_at(&root)
            .unwrap()
            .suppliers
            .into_iter()
            .map(|entry| (entry.scope, entry.slug))
            .collect();
        assert_eq!(
            entries,
            vec![
                ("balance".to_string(), "only".to_string()),
                ("claude".to_string(), "first".to_string()),
                ("claude".to_string(), "second".to_string()),
                ("claude".to_string(), "third".to_string()),
            ]
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// 索引去重键是 `(scope, slug)`：两个 scope 下的同名供应商各占一条。
    #[test]
    fn index_deduplicates_by_scope_and_slug() {
        let root = unique_root("dedupe");
        create_supplier(&root, rules::BALANCE_SCOPE, "deepseek");
        create_supplier(&root, "claude", "deepseek");

        let index = read_index_at(&root).unwrap();
        assert_eq!(index.suppliers.len(), 2, "同名供应商在不同列表下是两条");
        assert_eq!(index.suppliers[0].scope, "balance");
        assert_eq!(index.suppliers[1].scope, "claude");

        // 完全相同的条目才会在归一化时被去重。
        let duplicated = SupplierIndex {
            version: 0,
            suppliers: vec![index.suppliers[0].clone(), index.suppliers[0].clone()],
        };
        write_index_at(&root, &duplicated).unwrap();
        assert_eq!(read_index_at(&root).unwrap().suppliers.len(), 1);

        let _ = fs::remove_dir_all(&root);
    }

    /// 磁盘键名是 snake_case 契约（与前端 camelCase 契约分离），
    /// 且旧的手写 snake_case JSON 必须能读出来。
    #[test]
    fn disk_format_keeps_snake_case_keys() {
        let root = unique_root("snake_case");
        create_supplier(&root, "claude", "deepseek");
        let dir = root.join("claude").join("deepseek");
        write_credential(&root, "claude", "deepseek", "sk-x");
        save_endpoint_at(
            &root,
            "claude",
            "deepseek",
            &SupplierEndpoint {
                base_url: "https://api.deepseek.com".to_string(),
                ..SupplierEndpoint::default()
            },
        )
        .unwrap();
        save_routing_at(
            &root,
            "claude",
            "deepseek",
            &SupplierRouting {
                context_window: 128_000,
                ..SupplierRouting::default()
            },
        )
        .unwrap();
        set_active_at(&root, "claude", "deepseek").unwrap();

        let expected = [
            (PROFILE_FILE, "\"api_key_url\""),
            (CREDENTIAL_FILE, "\"api_key\""),
            (ENDPOINT_FILE, "\"base_url\""),
            (ENDPOINT_FILE, "\"endpoint_candidates\""),
            (ROUTING_FILE, "\"client_id\""),
            (ROUTING_FILE, "\"model_map\""),
            (ROUTING_FILE, "\"context_window\""),
        ];
        for (file, key) in expected {
            let text = fs::read_to_string(dir.join(file)).unwrap();
            assert!(text.contains(key), "{} 缺少字段 {}：{}", file, key, text);
        }
        // 在线用量查询已改为内置（不落盘），磁盘上不得再出现该文件。
        assert!(
            !dir.join(LEGACY_USAGE_QUERY_FILE).exists(),
            "在线用量查询不再落盘，供应商目录里不应有 usage_query.json"
        );
        // 已被 scope 目录取代的字段不得再落盘。
        let profile_text = fs::read_to_string(dir.join(PROFILE_FILE)).unwrap();
        assert!(
            !profile_text.contains("clients") && !profile_text.contains("balance_source"),
            "profile 不再包含列表 / 余额来源字段：{}",
            profile_text
        );

        let active = fs::read_to_string(root.join("claude").join(ACTIVE_FILE)).unwrap();
        assert!(active.contains("\"active_slug\""), "{}", active);

        let index = fs::read_to_string(root.join(INDEX_FILE)).unwrap();
        for key in ["\"suppliers\"", "\"scope\"", "\"slug\"", "\"active\""] {
            assert!(index.contains(key), "索引缺少字段 {}：{}", key, index);
        }
        assert!(
            !index.contains("api_key"),
            "索引不得包含任何密钥字段：{}",
            index
        );

        // 手写 snake_case（历史/人工编辑）必须能读回。
        fs::write(
            dir.join(ENDPOINT_FILE),
            br#"{"base_url":"https://example.com/v1/","full_url":true,"api_format":"openai","auth_field":"authorization","endpoint_candidates":[]}"#,
        )
        .unwrap();
        let endpoint = read_endpoint_at(&root, "claude", "deepseek").unwrap();
        assert_eq!(endpoint.base_url, "https://example.com/v1");
        assert!(endpoint.full_url);
        assert_eq!(endpoint.api_format, "openai");

        let _ = fs::remove_dir_all(&root);
    }

    /// 旧配置迁移：三个 scope 各建一份、各自 active，且幂等。
    #[test]
    fn migrate_legacy_config_copies_into_every_scope() {
        let root = unique_root("migrate");
        let legacy = AppConfig {
            api_key: " sk-legacy ".to_string(),
            base_url: "https://api.deepseek.com/anthropic/".to_string(),
            ..AppConfig::default()
        };

        let created = migrate_legacy_config_at(&root, &legacy)
            .unwrap()
            .expect("有 API Key 时应迁移");
        assert_eq!(created.slug, "deepseek");
        assert_eq!(created.name, "DeepSeek");
        assert_eq!(created.category, "官方");
        assert!(!created.created_at.is_empty());

        for scope in migration_scopes() {
            let dir = root.join(&scope).join("deepseek");
            assert!(
                dir.join(PROFILE_FILE).is_file(),
                "{} 应有一份 profile",
                scope
            );
            assert!(dir.join(CREDENTIAL_FILE).is_file());
            assert!(dir.join(ENDPOINT_FILE).is_file());
            assert_eq!(
                read_profile_at(&root, &scope, "deepseek").unwrap().name,
                "DeepSeek"
            );
            assert_eq!(
                read_credential_at(&root, &scope, "deepseek")
                    .unwrap()
                    .api_key,
                "sk-legacy",
                "{} 应有一份独立的密钥文件",
                scope
            );
            assert_eq!(
                read_endpoint_at(&root, &scope, "deepseek")
                    .unwrap()
                    .base_url,
                "https://api.deepseek.com/anthropic"
            );
            assert_eq!(
                read_active_at(&root, &scope).unwrap(),
                Some("deepseek".to_string()),
                "{} 应把迁移出的供应商设为当前启用项",
                scope
            );
        }
        assert_eq!(
            migration_scopes(),
            vec![
                "balance".to_string(),
                "claude".to_string(),
                "codex".to_string()
            ],
            "迁移覆盖余额配置与全部已登记客户端"
        );
        assert!(
            !root
                .join(rules::BALANCE_SCOPE)
                .join("deepseek")
                .join(ROUTING_FILE)
                .exists(),
            "余额配置列表不产生路由文件"
        );
        let index = read_index_at(&root).unwrap();
        assert_eq!(index.suppliers.len(), 3, "索引里三条各属一个 scope");
        assert!(index.suppliers.iter().all(|entry| entry.active));

        // 幂等：索引已存在 → 不再迁移，磁盘上每个 scope 仍只有一个供应商。
        assert!(migrate_legacy_config_at(&root, &legacy).unwrap().is_none());
        for scope in migration_scopes() {
            assert_eq!(list_slugs_at(&root, &scope), vec!["deepseek".to_string()]);
        }

        // 没有 API Key 时不迁移，也不会创建索引哨兵。
        let empty_root = unique_root("migrate-empty");
        let no_key = AppConfig {
            api_key: "   ".to_string(),
            ..legacy.clone()
        };
        assert!(migrate_legacy_config_at(&empty_root, &no_key)
            .unwrap()
            .is_none());
        assert!(!empty_root.join(INDEX_FILE).exists());
        assert!(list_scopes_at(&empty_root).is_empty());

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&empty_root);
    }

    /// 迁移按 base_url 的 host 推断供应商：已知品牌各自落到固定 slug，
    /// 无法识别时分配 `custom-<n>`。
    #[test]
    fn migrate_infers_supplier_from_base_url() {
        let cases = [
            ("https://api.deepseek.com/anthropic", "deepseek", "DeepSeek"),
            ("https://api.moonshot.cn/v1", "kimi", "Kimi"),
            (
                "https://api-inference.modelscope.cn/v1",
                "modelscope",
                "ModelScope",
            ),
            ("https://aihubmix.com/v1", "aihubmix", "AiHubMix"),
            ("https://api.shengsuanyun.com", "shengsuanyun", "神算云"),
            ("https://api.xiaomimimo.com/v1", "xiaomimimo", "小米MiMo"),
            ("https://proxy.example.com/v1", "custom-1", "自定义供应商"),
        ];
        for (base_url, slug, name) in cases {
            let root = unique_root(&format!("infer-{}", slug));
            let legacy = AppConfig {
                api_key: "sk-x".to_string(),
                base_url: base_url.to_string(),
                ..AppConfig::default()
            };
            let profile = migrate_legacy_config_at(&root, &legacy).unwrap().unwrap();
            assert_eq!(profile.slug, slug, "{}", base_url);
            assert_eq!(profile.name, name, "{}", base_url);
            // 三个 scope 使用同一个 slug（同样的推断输入 → 同样的结果）。
            for scope in migration_scopes() {
                assert!(
                    root.join(&scope).join(slug).join(PROFILE_FILE).is_file(),
                    "{} 应在 {} 下创建",
                    base_url,
                    scope
                );
            }
            // 在线用量查询已改为内置（不落盘）：迁移也不得再写出任何 usage_query.json。
            for scope in migration_scopes() {
                assert!(
                    !root
                        .join(&scope)
                        .join(slug)
                        .join(LEGACY_USAGE_QUERY_FILE)
                        .exists(),
                    "{} 不应再写出在线用量查询文件",
                    base_url
                );
            }
            let _ = fs::remove_dir_all(&root);
        }
    }

    /// 启动清理：删除已下线的 `usage_query.json`（所有 scope），
    /// 以及客户端列表下已无用途的 `usage_history.json`；余额列表的历史用量必须保留。
    #[test]
    fn cleanup_removes_legacy_usage_files_only() {
        let root = unique_root("cleanup");
        for scope in [rules::BALANCE_SCOPE, "claude"] {
            create_supplier(&root, scope, "deepseek");
            let dir = root.join(scope).join("deepseek");
            fs::write(dir.join(LEGACY_USAGE_QUERY_FILE), b"{}").unwrap();
            save_usage_history_at(
                &root,
                scope,
                "deepseek",
                &SupplierUsageHistory {
                    last_balance: Some(9.5),
                    ..SupplierUsageHistory::default()
                },
            )
            .unwrap();
        }
        // 没有内置配置的自定义供应商同样要清掉遗留文件。
        create_supplier(&root, rules::BALANCE_SCOPE, "custom-1");
        fs::write(
            root.join(rules::BALANCE_SCOPE)
                .join("custom-1")
                .join(LEGACY_USAGE_QUERY_FILE),
            b"{}",
        )
        .unwrap();

        assert_eq!(
            cleanup_usage_files_at(&root).unwrap(),
            4,
            "balance: 2 个 usage_query；claude: usage_query + usage_history"
        );

        let balance = root.join(rules::BALANCE_SCOPE).join("deepseek");
        assert!(
            !balance.join(LEGACY_USAGE_QUERY_FILE).exists(),
            "在线用量查询已下线，文件必须删除"
        );
        assert!(
            balance.join(USAGE_HISTORY_FILE).is_file(),
            "余额列表的历史用量是账单的唯一数据源，必须保留"
        );
        let claude = root.join("claude").join("deepseek");
        assert!(!claude.join(LEGACY_USAGE_QUERY_FILE).exists());
        assert!(
            !claude.join(USAGE_HISTORY_FILE).exists(),
            "客户端列表只做模型路由，历史用量无用"
        );

        // 幂等：第二次运行不再删任何东西。
        assert_eq!(cleanup_usage_files_at(&root).unwrap(), 0);

        let _ = fs::remove_dir_all(&root);
    }

    /// 自定义序号取「该 scope 内第一个未占用」的值；已存在的目录不会被重复迁移覆盖。
    #[test]
    fn custom_slug_avoids_existing_directories() {
        let root = unique_root("custom");
        create_supplier(&root, "claude", "custom-1");
        create_supplier(&root, "claude", "custom-2");
        assert_eq!(next_custom_slug(&root, "claude"), "custom-3");
        assert_eq!(
            next_custom_slug(&root, "codex"),
            "custom-1",
            "序号按 scope 内已占用目录名分配，各 scope 彼此独立"
        );

        // 半迁移残留（目录已存在、索引却缺失）：不得重复创建同名供应商。
        let half = unique_root("custom-half");
        fs::create_dir_all(half.join(rules::BALANCE_SCOPE).join("deepseek")).unwrap();
        let legacy = AppConfig {
            api_key: "sk-x".to_string(),
            base_url: "https://api.deepseek.com/anthropic".to_string(),
            ..AppConfig::default()
        };
        assert!(migrate_legacy_config_at(&half, &legacy).unwrap().is_none());
        assert!(
            !half
                .join(rules::BALANCE_SCOPE)
                .join("deepseek")
                .join(PROFILE_FILE)
                .exists(),
            "已存在的目录不应被迁移写入"
        );
        assert!(
            half.join("claude")
                .join("deepseek")
                .join(PROFILE_FILE)
                .is_file(),
            "其余列表照常补齐"
        );

        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&half);
    }

    /// 存储层的公开入口必须都落在 `<数据目录>/supplier` 之下。
    #[test]
    fn public_paths_live_under_supplier_root() {
        let root = supplier_root();
        assert_eq!(root, paths::app_data_dir().join("supplier"));
        assert_eq!(
            scope_dir(rules::BALANCE_SCOPE).unwrap(),
            root.join("balance")
        );
        assert_eq!(
            supplier_dir("claude", "deepseek").unwrap(),
            root.join("claude").join("deepseek")
        );
        assert!(supplier_dir("../escape", "deepseek").is_err());
        assert!(supplier_dir("claude", "../escape").is_err());
        assert!(scope_dir("../escape").is_err());
    }
}

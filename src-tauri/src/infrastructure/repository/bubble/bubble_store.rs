//! 模块化气泡资源存储
//!
//! 三类用户资源：
//! - 气泡里的图片 / 动图：`<数据目录>/bubble/<原文件名主干>-<内容哈希>.<扩展名>`；
//! - 自定义字体：`<数据目录>/fonts/`；
//! - 气泡组：`<数据目录>/bubble/<组名>/group.json`（一组一目录，与 `audio/<组名>/` 同一套约定）。
//!
//! 文件名规则：`<原文件名主干>-<内容哈希>.<扩展名>`。
//! - 带哈希：同一个文件重复上传不会产生副本，也天然避免了同名覆盖；
//! - 保留原主干：用户在数据目录里能一眼认出自己传的是什么。
//!
//! 读取时只接受「纯文件名」：任何带目录成分的入参都会被拒绝，
//! 避免配置被改动后越权读取数据目录以外的文件。

use std::fs;
use std::path::PathBuf;

use crate::domain::config::service::config_service;
use crate::domain::bubble::model::entity::bubble_config::{BubbleConfig, DEFAULT_BUBBLE_GROUP};
use crate::infrastructure::system::paths;
use crate::types::exception::{AppError, AppResult};
use crate::types::utils::fs as fs_utils;

/// 允许的气泡媒体扩展名（与文件对话框、前端提示保持一致）。
pub const MEDIA_EXTENSIONS: [&str; 17] = [
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "ico", "avif", "apng", "mng", "tif", "tiff",
    "heic", "heif", "raw", "psd",
];

/// 允许的字体扩展名（浏览器可用的四种）。
pub const FONT_EXTENSIONS: [&str; 4] = ["ttf", "otf", "woff", "woff2"];

/// 文件名主干的最大长度（避免超长文件名打不开）。
const MAX_STEM_LEN: usize = 40;

/// 保存一份气泡媒体，返回落盘后的文件名。
pub fn save_media(source: &str, bytes: &[u8]) -> AppResult<String> {
    save_asset(
        &paths::bubble_media_root(),
        source,
        bytes,
        &MEDIA_EXTENSIONS,
        "气泡图片",
    )
}

/// 读取一份气泡媒体（只接受纯文件名）。
pub fn read_media(name: &str) -> AppResult<Vec<u8>> {
    read_asset(&paths::bubble_media_root(), name, "气泡图片")
}

/// 保存一份字体文件，返回落盘后的文件名。
pub fn save_font(source: &str, bytes: &[u8]) -> AppResult<String> {
    save_asset(&paths::font_root(), source, bytes, &FONT_EXTENSIONS, "字体")
}

/// 读取一份字体文件（只接受纯文件名）。
pub fn read_font(name: &str) -> AppResult<Vec<u8>> {
    read_asset(&paths::font_root(), name, "字体")
}

/// 列出已上传的字体文件名（供配置页的字体下拉选择）。
pub fn list_fonts() -> Vec<String> {
    list_assets(&paths::font_root(), &FONT_EXTENSIONS)
}

// ---------------------------------------------------------------------------
// 气泡组：<数据目录>/bubble/<组名>/group.json
// ---------------------------------------------------------------------------

/// 组内容文件名（与 `audio/<组名>/meta.json` 同一套约定）。
pub const GROUP_FILE: &str = "group.json";

/// 某个气泡组的目录：`bubble/<组名>`。
///
/// 组名先过领域规则（去空白、限长、挡住目录分隔符），
/// 因此拼出来的路径必然落在气泡目录内，不存在越权写入的可能。
pub fn group_dir(name: &str) -> AppResult<PathBuf> {
    Ok(paths::bubble_group_root().join(config_service::sanitize_group_name(name)?))
}

/// 该组是否已落盘（「默认」组的一次性补写迁移据此判断）。
pub fn group_exists(name: &str) -> bool {
    group_file(name).is_ok_and(|path| path.is_file())
}

/// 列出现存的气泡组（按名排序）。
///
/// 只认「含 group.json 的目录」：同一目录下还有大量媒体文件，
/// 它们既不是组、也不该出现在下拉里。
pub fn list_groups() -> Vec<String> {
    let root = paths::bubble_group_root();
    let mut names: Vec<String> = match fs::read_dir(&root) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_dir())
            .filter(|entry| entry.path().join(GROUP_FILE).is_file())
            .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

/// 读取一个气泡组的模块行。
pub fn read_group(name: &str) -> AppResult<BubbleConfig> {
    let path = group_file(name)?;
    let text = fs::read_to_string(&path)
        .map_err(|e| AppError::io(format!("读取气泡组失败（{}）：{}", path.display(), e)))?;
    let mut cfg: BubbleConfig = serde_json::from_str(&text)
        .map_err(|e| AppError::serde(format!("解析气泡组失败：{}", e)))?;
    // 以目录名为准：文件内的组名与目录不一致时，目录名才是事实来源。
    cfg.current_group = config_service::sanitize_group_name(name)?;
    config_service::normalize_bubble(&mut cfg);
    Ok(cfg)
}

/// 写入一个气泡组（目录不存在则创建），返回规范化后的内容。
pub fn save_group(name: &str, bubble: &BubbleConfig) -> AppResult<BubbleConfig> {
    let mut cfg = bubble.clone();
    cfg.current_group = config_service::sanitize_group_name(name)?;
    config_service::normalize_bubble(&mut cfg);

    let dir = group_dir(&cfg.current_group)?;
    fs::create_dir_all(&dir).map_err(|e| AppError::io(format!("创建气泡组失败：{}", e)))?;
    let text = serde_json::to_vec_pretty(&cfg)
        .map_err(|e| AppError::serde(format!("序列化气泡组失败：{}", e)))?;
    fs_utils::write_atomic_plain(&dir.join(GROUP_FILE), &text)?;
    Ok(cfg)
}

/// 删除一个气泡组（连同目录与其中的内容）。
///
/// 「默认」是内置兜底项（配置里 currentGroup 缺失时的落点），不允许删除。
pub fn delete_group(name: &str) -> AppResult<()> {
    let clean = config_service::sanitize_group_name(name)?;
    if clean == DEFAULT_BUBBLE_GROUP {
        return Err(AppError::invalid("默认气泡组不可删除"));
    }
    let dir = group_dir(&clean)?;
    if !dir.is_dir() {
        return Err(AppError::not_found(format!("气泡组不存在：{}", clean)));
    }
    fs::remove_dir_all(&dir).map_err(|e| AppError::io(format!("删除气泡组失败：{}", e)))?;
    Ok(())
}

/// 组内容文件路径。
fn group_file(name: &str) -> AppResult<PathBuf> {
    Ok(group_dir(name)?.join(GROUP_FILE))
}

/// 列出目录下扩展名允许的文件名；目录不存在（从未上传过）时返回空列表。
fn list_assets(root: &std::path::Path, allowed: &[&str]) -> Vec<String> {
    let mut names: Vec<String> = match fs::read_dir(root) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().is_file())
            .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
            .filter(|name| has_extension(name, allowed))
            .collect(),
        Err(_) => Vec::new(),
    };
    // 排序：下拉列表顺序稳定，不随文件系统枚举顺序变化。
    names.sort();
    names
}

/// 文件名扩展名（小写）是否在允许列表内。
fn has_extension(name: &str, allowed: &[&str]) -> bool {
    std::path::Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .is_some_and(|ext| allowed.contains(&ext.as_str()))
}

/// 落盘公共实现：校验扩展名 → 生成带哈希的文件名 → 原子写入。
fn save_asset(
    root: &std::path::Path,
    source: &str,
    bytes: &[u8],
    allowed: &[&str],
    label: &str,
) -> AppResult<String> {
    if bytes.is_empty() {
        return Err(AppError::invalid(format!("{}文件为空", label)));
    }
    let ext = extension_of(source)?;
    if !allowed.contains(&ext.as_str()) {
        return Err(AppError::invalid(format!(
            "不支持的{}格式：.{}",
            label, ext
        )));
    }
    let name = build_file_name(source, &ext, bytes);
    let dir = root.to_path_buf();
    if let Err(err) = fs::create_dir_all(&dir) {
        return Err(AppError::io(format!(
            "创建{}目录失败（{}）：{}",
            label,
            dir.display(),
            err
        )));
    }
    let path = dir.join(&name);
    // 内容一致时无需重写（哈希相同即同一份文件）。
    if path.is_file() {
        return Ok(name);
    }
    fs_utils::write_atomic(
        &path,
        bytes,
        |e| AppError::io(format!("写入{}失败：{}", label, e)),
        |e| AppError::io(format!("保存{}失败：{}", label, e)),
    )?;
    log::info!("{}已保存：{}", label, path.display());
    Ok(name)
}

/// 读取公共实现：拒绝目录成分，缺失时给出明确文案。
fn read_asset(root: &std::path::Path, name: &str, label: &str) -> AppResult<Vec<u8>> {
    let safe = sanitize_name(name)?;
    let path = root.join(&safe);
    if !path.is_file() {
        return Err(AppError::not_found(format!("{}不存在：{}", label, safe)));
    }
    fs_utils::read_bytes(&path, label)
}

/// 生成 `主干-哈希.扩展名`。
fn build_file_name(source: &str, ext: &str, bytes: &[u8]) -> String {
    format!("{}-{:016x}.{}", stem_of(source), fnv1a64(bytes), ext)
}

/// 取原文件名主干并做安全化处理（去掉路径成分与非法字符）。
fn stem_of(source: &str) -> String {
    let raw = std::path::Path::new(source)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("asset");
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_alphanumeric() || ch == '-' || ch == '_' || ch == ' ' {
            out.push(ch);
        }
        if out.chars().count() >= MAX_STEM_LEN {
            break;
        }
    }
    let trimmed = out.trim().replace(' ', "_");
    if trimmed.is_empty() {
        "asset".to_string()
    } else {
        trimmed
    }
}

/// 取小写扩展名；没有扩展名直接报错（无法判定类型）。
fn extension_of(source: &str) -> AppResult<String> {
    std::path::Path::new(source)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::invalid("文件缺少扩展名，无法识别格式"))
}

/// 只保留纯文件名：含目录成分或空值一律拒绝。
fn sanitize_name(name: &str) -> AppResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::invalid("资源文件名不能为空"));
    }
    let path = std::path::Path::new(trimmed);
    match path.file_name().and_then(|s| s.to_str()) {
        Some(file) if file == trimmed => Ok(file.to_string()),
        _ => Err(AppError::invalid("资源文件名不合法")),
    }
}

/// FNV-1a 64 位哈希：只为「同一份文件得到同一个名字」，不用于安全用途。
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 测试用：临时资源目录。
#[cfg(test)]
pub(crate) fn test_dir(name: &str) -> std::path::PathBuf {
    let base = std::env::temp_dir().join(format!("dsw-bubble-{}-{}", std::process::id(), name));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).unwrap();
    base
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_name_keeps_stem_and_dedupes_by_content() {
        let a = build_file_name("C:/x/我的猫.png", "png", b"same-bytes");
        let b = build_file_name("D:/other/我的猫.png", "png", b"same-bytes");
        assert_eq!(a, b, "同内容同扩展名应得到同一个文件名");
        let c = build_file_name("我的猫.png", "png", b"other-bytes");
        assert_ne!(a, c, "内容不同必须区分");
        assert!(a.ends_with(".png"));
        assert!(a.starts_with("我的猫-"), "保留原主干便于识别：{}", a);
    }

    #[test]
    fn stem_is_sanitized() {
        let name = build_file_name("a/b\\c:d*e?.gif", "gif", b"x");
        assert!(name.starts_with("cde-"), "非法字符应被剔除：{}", name);
        assert!(!name.contains(['/', '\\', ':', '*', '?']));
        // 主干被过滤为空时回落 asset，绝不产生以 `-` 开头的文件名。
        assert!(build_file_name("***.gif", "gif", b"x").starts_with("asset-"));
        // 中文主干是合法字符，应保留（用户能认出自己传的文件）。
        assert!(build_file_name("我的猫.gif", "gif", b"x").starts_with("我的猫-"));
    }

    #[test]
    fn extension_is_required_and_lowercased() {
        assert_eq!(extension_of("A.PNG").unwrap(), "png");
        assert!(extension_of("noext").is_err());
    }

    #[test]
    fn unsupported_extension_is_rejected() {
        let err = save_asset(&test_dir("ext"), "a.exe", b"x", &MEDIA_EXTENSIONS, "气泡图片")
            .unwrap_err();
        assert!(err.message().contains("不支持"), "{}", err.message());
        let err = save_asset(&test_dir("ext2"), "a.png", b"", &MEDIA_EXTENSIONS, "气泡图片")
            .unwrap_err();
        assert!(err.message().contains("为空"), "{}", err.message());
    }

    #[test]
    fn save_then_read_roundtrip_dedupes() {
        let root = test_dir("roundtrip");
        let first = save_asset(&root, "猫.gif", b"GIF89a-data", &MEDIA_EXTENSIONS, "气泡图片")
            .unwrap();
        // 同一个文件（同名同内容）再传一次：命中同一份资源，不产生副本。
        let second = save_asset(
            &root,
            "C:/somewhere/猫.gif",
            b"GIF89a-data",
            &MEDIA_EXTENSIONS,
            "气泡图片",
        )
        .unwrap();
        assert_eq!(first, second);
        assert_eq!(read_asset(&root, &first, "气泡图片").unwrap(), b"GIF89a-data");
    }

    /// 带目录成分的文件名必须被拒绝（防止配置被改写后越权读取）。
    #[test]
    fn path_traversal_is_rejected() {
        assert!(sanitize_name("../config.json").is_err());
        assert!(sanitize_name("sub/a.png").is_err());
        assert!(sanitize_name("").is_err());
        assert_eq!(sanitize_name(" a.png ").unwrap(), "a.png");
    }

    /// 字体清单：只列字体扩展名，且目录不存在时返回空列表（不是错误）。
    #[test]
    fn fonts_are_listed_by_extension() {
        // 目录不存在 → 空列表（从未上传过字体是正常状态）。
        let missing = test_dir("fonts-missing").join("nope");
        assert!(list_assets(&missing, &FONT_EXTENSIONS).is_empty());

        let root = test_dir("fonts");
        for name in ["b.WOFF2", "a.ttf", "d.woff"] {
            save_asset(&root, name, name.as_bytes(), &FONT_EXTENSIONS, "字体").unwrap();
        }
        // 用户手动丢进目录的非字体文件不得出现在下拉里。
        fs::write(root.join("note.txt"), b"x").unwrap();
        let listed = list_assets(&root, &FONT_EXTENSIONS);
        assert_eq!(listed.len(), 3, "{:?}", listed);
        assert!(listed.iter().all(|n| !n.ends_with(".txt")));
        // 扩展名大小写不敏感；列表按名称排序（下拉顺序稳定，与枚举顺序无关）。
        assert!(listed[0].starts_with("a-"), "{:?}", listed);
        assert!(listed[1].starts_with("b-"), "{:?}", listed);
        assert!(has_extension("a.TTF", &FONT_EXTENSIONS));
        assert!(!has_extension("a.png", &FONT_EXTENSIONS));
    }

    /// 气泡组：写入 → 列出 → 读回 → 删除，全链路落在 `bubble/<组名>/group.json`。
    ///
    /// 与 `bubble_app_service` 的保存用例同一套做法：真写一次数据目录，结束时清干净，
    /// 不留痕迹影响用户配置。组名带进程号，避免并行用例互相踩。
    #[test]
    fn group_roundtrip_lives_under_bubble_root() {
        let name = format!("单测组{}", std::process::id());
        // 上一次跑挂了留下的残留：先清掉，保证断言从干净状态出发。
        let _ = delete_group(&name);

        let cfg = BubbleConfig {
            rows: vec![crate::domain::bubble::model::entity::bubble_config::BubbleRow {
                blocks: vec![crate::domain::bubble::model::entity::bubble_config::BubbleBlock {
                    kind: "text".to_string(),
                    text: "组内容".to_string(),
                    ..Default::default()
                }],
            }],
            current_group: name.clone(),
        };
        let saved = save_group(&name, &cfg).unwrap();
        assert_eq!(saved.current_group, name);
        assert_eq!(saved.rows.len(), 1);

        // 目录与文件都在气泡目录下（与媒体文件同一个根，但独立成目录）。
        let dir = group_dir(&name).unwrap();
        assert!(dir.starts_with(paths::bubble_group_root()));
        assert!(dir.join(GROUP_FILE).is_file(), "应写入 group.json");
        assert!(group_exists(&name));
        assert!(list_groups().contains(&name));

        let back = read_group(&name).unwrap();
        assert_eq!(back.rows[0].blocks[0].text, "组内容");
        assert_eq!(back.current_group, name);

        delete_group(&name).unwrap();
        assert!(!group_exists(&name));
        assert!(!list_groups().contains(&name));
        assert!(read_group(&name).is_err(), "已删除的组不能再读到内容");
    }

    /// 「默认」组是内置兜底项：删不掉，避免用户在配置里留下悬空的组名。
    #[test]
    fn default_group_cannot_be_deleted() {
        let err = delete_group(DEFAULT_BUBBLE_GROUP).unwrap_err();
        assert!(err.message().contains("不可删除"), "{}", err.message());
    }

    /// 组名即目录名：非法 / 超长 / 空值一律拒绝，绝不拼出越权路径。
    #[test]
    fn group_name_rejects_illegal_values() {
        for bad in ["", "   ", "a/b", "a\\b", "a:b", ".", ".."] {
            assert!(group_dir(bad).is_err(), "应拒绝：{:?}", bad);
        }
        let long = "字".repeat(crate::domain::bubble::model::entity::bubble_config::MAX_BUBBLE_GROUP_NAME_LEN + 1);
        assert!(group_dir(&long).is_err(), "超长组名应被拒绝");
        // 合法值与空白：去空白后原样落到气泡目录下。
        assert_eq!(
            group_dir(" 我的组 ").unwrap(),
            paths::bubble_group_root().join("我的组")
        );
    }
}

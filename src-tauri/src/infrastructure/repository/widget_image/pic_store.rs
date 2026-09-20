//! 挂件图片组存储
//!
//! 管理用户上传的自定义挂件图片组：存储目录、状态文件名映射、元数据、读写与枚举。
//! 每个图片组目录内维护 `meta.json`（与音频组同一规范），记录组名与各状态资源文件名。
//!
//! 磁盘是唯一事实来源：无论资源是新增、覆盖还是被外部改动，读取 meta 时都会
//! 以磁盘现状自愈，保证「元数据 == 真实存在的资源」。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::domain::widget_image::model::{PicAsset, PicGroupMeta};
use crate::domain::widget_image::service::widget_image_service as widget_image;
use crate::infrastructure::system::paths;
use crate::types::enums::WidgetState;
use crate::types::exception::{AppError, AppResult};
use crate::types::utils::fs as fs_utils;

/// `meta.json` 路径。
fn meta_path(dir: &Path) -> PathBuf {
    dir.join("meta.json")
}

/// 读取组目录内的 `meta.json` 原文。
fn read_group_meta_at(dir: &Path) -> AppResult<PicGroupMeta> {
    let path = meta_path(dir);
    let text = fs::read_to_string(&path)
        .map_err(|e| AppError::io(format!("读取图片组元数据失败（{}）：{}", path.display(), e)))?;
    serde_json::from_str(&text).map_err(|e| AppError::serde(format!("解析图片组元数据失败：{}", e)))
}

/// 原子写入 `meta.json`（先写临时文件再替换，避免半写损坏）。
fn write_group_meta(dir: &Path, meta: &PicGroupMeta) -> AppResult<()> {
    let json = serde_json::to_string_pretty(meta).map_err(|e| AppError::serde(e.to_string()))?;
    fs_utils::write_atomic(
        &meta_path(dir),
        json.as_bytes(),
        |e| AppError::io(format!("写入图片组元数据失败：{}", e)),
        |e| AppError::io(format!("保存图片组元数据失败：{}", e)),
    )
}

/// 以磁盘现状刷新 `meta.json`：缺失或与磁盘不一致时补写，随后返回最新元数据。
///
/// 磁盘是唯一事实来源：历史组（无 meta）会在此自愈。
pub fn sync_group_meta(group: &str) -> AppResult<PicGroupMeta> {
    let group = widget_image::sanitize_group(group)?;
    let dir = paths::pic_root().join(&group);
    if !dir.is_dir() {
        return Err(AppError::not_found(format!("挂件组不存在：{}", group)));
    }
    let mut states = BTreeMap::new();
    for state in WidgetState::ALL {
        if dir.join(state.file_name()).is_file() {
            states.insert(
                state.key().to_string(),
                PicAsset {
                    file: state.file_name().to_string(),
                },
            );
        }
    }
    let meta = PicGroupMeta {
        name: group,
        states,
    };
    if read_group_meta_at(&dir).ok().as_ref() != Some(&meta) {
        write_group_meta(&dir, &meta)?;
    }
    Ok(meta)
}

/// 读取图片组元数据（缺失或过期时按磁盘现状自动补写）。
pub fn group_meta(group: &str) -> AppResult<PicGroupMeta> {
    sync_group_meta(group)
}

/// 列出所有自定义挂件组名（按名称排序）。
///
/// 仅收录至少存在一个已知状态资源的目录：空目录无法渲染，
/// 不应出现在挂件本体列表中，避免前端回退到其他挂件组或内置素材。
pub fn list_groups() -> Vec<String> {
    let root = paths::pic_root();
    let mut groups = Vec::new();
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let has_asset = WidgetState::ALL
                .iter()
                .any(|state| dir.join(state.file_name()).is_file());
            if !has_asset {
                continue;
            }
            if let Some(name) = entry.file_name().to_str() {
                groups.push(name.to_string());
            }
        }
    }
    groups.sort();
    groups
}

/// 列出某个挂件组已存在的状态键（按 [`WidgetState::ALL`] 顺序）。
///
/// 前端据此决定「显示对应状态图」还是「立即回退本组 main.png」，
/// 保证任何状态切换都只在本组资源内进行。
pub fn group_states(group: &str) -> AppResult<Vec<String>> {
    // 读取状态清单的同时按磁盘现状维护 `meta.json`（历史组在此自愈）。
    let meta = sync_group_meta(group)?;
    Ok(WidgetState::ALL
        .iter()
        .filter(|state| meta.states.contains_key(state.key()))
        .map(|state| state.key().to_string())
        .collect())
}

/// 保存图片字节到 `pic/{group}/{state}.png`。
pub fn save_image(group: &str, state: WidgetState, bytes: &[u8]) -> AppResult<()> {
    let group = widget_image::sanitize_group(group)?;
    widget_image::validate_image_bytes(bytes)?;

    let dir = paths::pic_root().join(&group);
    fs::create_dir_all(&dir).map_err(|e| AppError::io(format!("创建图片目录失败: {}", e)))?;

    let path = dir.join(state.file_name());
    fs_utils::write_atomic(
        &path,
        bytes,
        |e| AppError::io(format!("写入图片失败: {}", e)),
        |e| AppError::io(format!("保存图片失败：{}", e)),
    )?;

    // 资源落盘后同步元数据，确保 meta.json 始终与磁盘现状一致；
    // 元数据写入失败不影响图片保存（下次读取会自愈）。
    if let Err(err) = sync_group_meta(&group) {
        log::warn!("刷新图片组元数据失败：{}", err);
    }
    log::info!("已保存挂件图片：{}（{} 字节）", path.display(), bytes.len());
    Ok(())
}

/// 删除自定义挂件组：整体移除组目录，连带其中的全部状态图片资源。
///
/// 默认挂件组使用内置资源、不落盘，`sanitize_group` 会直接拒绝该组名。
pub fn delete_group(group: &str) -> AppResult<()> {
    let group = widget_image::sanitize_group(group)?;
    let dir = paths::pic_root().join(&group);
    if !dir.is_dir() {
        return Err(AppError::not_found(format!("挂件组不存在：{}", group)));
    }
    fs::remove_dir_all(&dir).map_err(|e| AppError::io(format!("删除挂件组失败：{}", e)))?;
    log::info!("已删除挂件组：{}（{}）", group, dir.display());
    Ok(())
}

/// 读取某个组某个状态的图片字节。
pub fn read_image_bytes(group: &str, state: WidgetState) -> AppResult<Vec<u8>> {
    let group = widget_image::sanitize_group(group)?;
    let path = paths::pic_root().join(&group).join(state.file_name());
    fs::read(&path).map_err(|e| {
        log::warn!("读取挂件图片失败：{}（{}）", path.display(), e);
        AppError::io(format!("读取图片失败: {}", e))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(img: &image::DynamicImage, format: image::ImageFormat) -> Vec<u8> {
        let mut out = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut out), format)
            .expect("编码测试图片应成功");
        out
    }

    fn sample(w: u32, h: u32) -> image::DynamicImage {
        image::DynamicImage::ImageRgb8(image::RgbImage::new(w, h))
    }

    #[test]
    fn save_and_read_roundtrip() {
        let group = format!("测试组-{}", std::process::id());
        let bytes = encode(&sample(32, 32), image::ImageFormat::Png);
        save_image(&group, WidgetState::Main, &bytes).expect("保存合规图片应成功");
        let read = read_image_bytes(&group, WidgetState::Main).expect("读取应成功");
        assert_eq!(read, bytes, "读回内容应与写入一致");
        let _ = fs::remove_dir_all(paths::pic_root().join(&group));
    }

    #[test]
    fn save_rejects_invalid_image_without_creating_dir() {
        let group = format!("非法组-{}", std::process::id());
        assert!(save_image(&group, WidgetState::Main, b"broken-bytes").is_err());
        assert!(
            !paths::pic_root().join(&group).exists(),
            "非法图片不应产生落盘目录"
        );
    }

    /// 图片组根目录必须位于便携数据目录的 `pic` 子目录下，
    /// 即 `<安装目录>/data/pic`，各组以独立文件夹维护。
    #[test]
    fn pic_path_layout_is_portable_and_per_group() {
        let root = paths::pic_root();
        assert!(
            root.ends_with(Path::new("data/pic")),
            "图片根目录应为 <数据目录>/pic，实际：{}",
            root.display()
        );

        let group_a = paths::pic_root()
            .join("组A")
            .join(WidgetState::Main.file_name());
        let group_b = paths::pic_root()
            .join("组B")
            .join(WidgetState::Main.file_name());
        assert_ne!(group_a, group_b, "不同挂件组必须落在不同目录");
        assert!(group_a.ends_with(Path::new("data/pic/组A/main.png")));
        assert!(group_b.ends_with(Path::new("data/pic/组B/main.png")));
    }

    /// 磁盘层面的严格隔离：组 B 未写入的状态必须读取失败，
    /// 绝不允许回退/串读到组 A 的同名状态文件。
    #[test]
    fn read_never_leaks_between_groups() {
        let pid = std::process::id();
        let group_a = format!("隔离甲-{}", pid);
        let group_b = format!("隔离乙-{}", pid);
        let bytes_a = encode(&sample(24, 24), image::ImageFormat::Png);

        save_image(&group_a, WidgetState::Main, &bytes_a).expect("组A 写入应成功");
        // 组 B 只写入 angry，不写 main。
        save_image(&group_b, WidgetState::Angry, &bytes_a).expect("组B 写入应成功");

        assert_eq!(
            read_image_bytes(&group_a, WidgetState::Main).expect("组A/main 应可读"),
            bytes_a
        );
        let leaked = read_image_bytes(&group_b, WidgetState::Main);
        assert!(
            leaked.is_err(),
            "组B 未写入 main，必须读取失败而不是串读到其他组的资源"
        );

        let _ = fs::remove_dir_all(paths::pic_root().join(&group_a));
        let _ = fs::remove_dir_all(paths::pic_root().join(&group_b));
    }

    /// 状态清单只报告真实存在的资源，且顺序与 WIDGET_STATES 一致。
    #[test]
    fn group_states_reports_only_existing_assets() {
        let group = format!("状态枚举-{}", std::process::id());
        let bytes = encode(&sample(16, 16), image::ImageFormat::Png);
        save_image(&group, WidgetState::Main, &bytes).unwrap();
        save_image(&group, WidgetState::CloseEyes, &bytes).unwrap();

        let states = group_states(&group).expect("枚举应成功");
        assert_eq!(
            states,
            vec!["main".to_string(), "close_eyes".to_string()],
            "只应报告已存在的状态，并按预设顺序返回"
        );

        let _ = fs::remove_dir_all(paths::pic_root().join(&group));
    }

    /// 仅存在 main.png 的组：清单必须只有 main，供前端把其余状态全部兜底到 main。
    #[test]
    fn group_states_main_only_scenario() {
        let group = format!("仅主图-{}", std::process::id());
        let bytes = encode(&sample(16, 16), image::ImageFormat::Png);
        save_image(&group, WidgetState::Main, &bytes).unwrap();

        let states = group_states(&group).expect("枚举应成功");
        assert_eq!(states, vec!["main".to_string()]);

        let _ = fs::remove_dir_all(paths::pic_root().join(&group));
    }

    #[test]
    fn group_states_errors_for_unknown_group() {
        let err = group_states("不存在的挂件组-xyz").unwrap_err();
        assert!(
            err.message().starts_with("挂件组不存在："),
            "错误文案应与历史一致：{}",
            err.message()
        );
    }

    /// 删除挂件组必须连带清理该组的全部状态图片资源。
    #[test]
    fn delete_group_removes_all_images() {
        let group = format!("待删除组-{}", std::process::id());
        let bytes = encode(&sample(20, 20), image::ImageFormat::Png);
        save_image(&group, WidgetState::Main, &bytes).unwrap();
        save_image(&group, WidgetState::Angry, &bytes).unwrap();

        let dir = paths::pic_root().join(&group);
        assert!(dir.join("main.png").is_file() && dir.join("angry.png").is_file());

        delete_group(&group).expect("删除应成功");
        assert!(!dir.exists(), "删除后组目录必须整体消失，不得残留图片资源");
        assert!(!list_groups().contains(&group), "列表不应再包含已删除组");
    }

    /// 默认挂件组使用内置资源、不落盘，不可删除；不存在的组给出明确错误。
    #[test]
    fn delete_group_rejects_default_and_missing() {
        assert!(
            delete_group(widget_image::DEFAULT_BODY).is_err(),
            "默认挂件组不应可删除"
        );
        assert!(delete_group("不存在的挂件组-xyz").is_err());
    }

    /// 列表只收录含资源的目录，空目录（无法渲染）不得成为可选挂件本体。
    #[test]
    fn list_groups_skips_dirs_without_assets() {
        let pid = std::process::id();
        let empty_name = format!("空组-{}", pid);
        let filled_name = format!("有图组-{}", pid);
        let empty_dir = paths::pic_root().join(&empty_name);
        fs::create_dir_all(&empty_dir).unwrap();
        let bytes = encode(&sample(16, 16), image::ImageFormat::Png);
        save_image(&filled_name, WidgetState::Main, &bytes).unwrap();

        let groups = list_groups();
        assert!(
            !groups.contains(&empty_name),
            "无任何状态资源的目录不应出现在挂件本体列表中"
        );
        assert!(groups.contains(&filled_name));

        let _ = fs::remove_dir_all(&empty_dir);
        let _ = fs::remove_dir_all(paths::pic_root().join(&filled_name));
    }

    /// 保存图片后应生成与音频组同规范的 `meta.json`，并随状态变化实时更新。
    #[test]
    fn meta_json_is_created_and_kept_in_sync() {
        let group = format!("元数据组-{}", std::process::id());
        let bytes = encode(&sample(16, 16), image::ImageFormat::Png);
        save_image(&group, WidgetState::Main, &bytes).unwrap();

        let dir = paths::pic_root().join(&group);
        let meta_file = dir.join("meta.json");
        assert!(meta_file.is_file(), "保存图片后应生成 meta.json");

        // 规范与音频组 meta 对齐：camelCase 字段 + 逐个资源记录 file。
        let text = fs::read_to_string(&meta_file).unwrap();
        assert!(text.contains("\"name\""), "meta 应记录组名：{}", text);
        assert!(text.contains("\"states\""), "meta 应记录状态清单：{}", text);
        assert!(
            text.contains("\"file\": \"main.png\""),
            "meta 应逐个记录资源文件名：{}",
            text
        );

        let meta = group_meta(&group).expect("读取元数据应成功");
        assert_eq!(meta.name, group, "meta 中的组名应与目录名一致");
        assert_eq!(meta.states.len(), 1);
        assert_eq!(meta.states.get("main").unwrap().file, "main.png");

        // 新增状态后元数据同步扩展。
        save_image(&group, WidgetState::Angry, &bytes).unwrap();
        let meta2 = group_meta(&group).unwrap();
        assert_eq!(meta2.states.len(), 2, "新增状态应同步写入元数据");
        assert_eq!(meta2.states.get("angry").unwrap().file, "angry.png");

        // 与磁盘一致性：元数据状态清单 == 磁盘上真实存在的状态资源。
        let on_disk = WidgetState::ALL
            .iter()
            .filter(|state| dir.join(state.file_name()).is_file())
            .count();
        assert_eq!(meta2.states.len(), on_disk);

        let _ = fs::remove_dir_all(&dir);
    }

    /// 历史图片组（无 meta.json）在读取时应自动补写，实现自愈。
    #[test]
    fn meta_json_is_self_healed_for_legacy_groups() {
        let group = format!("历史组-{}", std::process::id());
        let bytes = encode(&sample(16, 16), image::ImageFormat::Png);
        save_image(&group, WidgetState::Main, &bytes).unwrap();

        let dir = paths::pic_root().join(&group);
        fs::remove_file(dir.join("meta.json")).unwrap();
        assert!(
            !dir.join("meta.json").exists(),
            "先模拟旧数据：无 meta.json"
        );

        let states = group_states(&group).expect("枚举状态应成功");
        assert_eq!(states, vec!["main".to_string()]);
        assert!(
            dir.join("meta.json").is_file(),
            "读取时应自动补写 meta.json"
        );
        let meta = group_meta(&group).unwrap();
        assert_eq!(meta.states.get("main").unwrap().file, "main.png");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 组目录被删除时 meta.json 随目录一并不留残余。
    #[test]
    fn meta_json_is_removed_with_group() {
        let group = format!("元数据删除-{}", std::process::id());
        let bytes = encode(&sample(16, 16), image::ImageFormat::Png);
        save_image(&group, WidgetState::Main, &bytes).unwrap();
        let dir = paths::pic_root().join(&group);
        assert!(dir.join("meta.json").is_file());

        delete_group(&group).expect("删除应成功");
        assert!(!dir.join("meta.json").exists(), "meta.json 不应残留");
    }
}

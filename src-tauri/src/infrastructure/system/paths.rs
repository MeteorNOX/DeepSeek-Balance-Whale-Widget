//! 便携数据目录与数据迁移
//!
//! 数据目录解析策略（保证「绿色版」可整体拷贝迁移）：
//! 1. 优先 `<exe 同级>/data`；
//! 2. 安装目录不可写时回退 `%APPDATA%/DS Desktop Whale`；
//! 3. 启动时自动迁移旧版目录（`DSW-Data`、旧 `%APPDATA%` 目录）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 便携数据目录名：位于主程序 exe 同级的专属文件夹。
pub const PORTABLE_DATA_DIR: &str = "data";

/// 旧版便携数据目录名（与主程序同级，用于自动迁移）。
pub const LEGACY_PORTABLE_DIR_NAME: &str = "DSW-Data";

/// 旧版数据目录名（`%APPDATA%` 下，用于自动迁移）。
pub const LEGACY_DIR_NAME: &str = "DS Desktop Whale";

/// 进程内缓存的数据目录（启动时解析一次，避免每次读写重复探测）。
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 应用数据目录：优先主程序 exe 同级的专属目录；安装目录不可写时回退旧版用户目录。
pub fn app_data_dir() -> PathBuf {
    DATA_DIR.get_or_init(resolve_data_dir).clone()
}

/// 启动时初始化存储：解析并校验路径，自动迁移旧版数据。
pub fn init_storage() {
    let target = app_data_dir();
    // 旧版便携目录更名：`DSW-Data` → `data`（同盘整体更名，不产生数据副本）。
    if let Some(base) = install_dir() {
        rename_legacy_portable_dir(&base, &target);
    }
    if let Err(err) = fs::create_dir_all(&target) {
        log::error!("创建数据目录失败：{}（{}）", target.display(), err);
    }
    migrate_legacy_data(&legacy_data_dir(), &target);
    if crate::types::utils::fs::dir_writable(&target) {
        log::info!("数据目录已就绪：{}", target.display());
    } else {
        log::error!("数据目录不可写，配置可能无法保存：{}", target.display());
    }
}

// ---------------------------------------------------------------------------
// 目录内的固定路径
// ---------------------------------------------------------------------------

/// 配置文件路径。
pub fn config_path() -> PathBuf {
    app_data_dir().join("config.json")
}

/// 账本文件路径（小鲸鱼记账数据）。
pub fn ledger_path() -> PathBuf {
    app_data_dir().join("usage.json")
}

/// 汇率日缓存文件路径。
pub fn rate_cache_path() -> PathBuf {
    app_data_dir().join("rate_cache.json")
}

/// 自定义音效组根目录：`<数据目录>/audio`。
pub fn audio_root() -> PathBuf {
    app_data_dir().join("audio")
}

/// 自定义挂件图片组根目录：`<数据目录>/pic`。
pub fn pic_root() -> PathBuf {
    app_data_dir().join("pic")
}

/// 供应商配置根目录：`<数据目录>/supplier`（每个供应商一个独立子目录）。
pub fn supplier_root() -> PathBuf {
    app_data_dir().join("supplier")
}

/// 模块化气泡的图片 / 动图资源目录：`<数据目录>/bubble`。
///
/// 媒体以文件形式落盘（而不是塞进 config.json）：动图动辄数 MB，
/// 写配置时反复搬运会把每次保存都拖成一次大文件写入。
pub fn bubble_media_root() -> PathBuf {
    app_data_dir().join("bubble")
}

/// 气泡组根目录：`<数据目录>/bubble`（与媒体目录同一个文件夹）。
///
/// 同一目录下并存两类内容，靠「文件 / 目录」天然区分：
/// - 媒体文件：`bubble/<原文件名>-<内容哈希>.<扩展名>`；
/// - 气泡组：`bubble/<组名>/group.json`（一组一目录，与 `audio/<组名>/` 同一套约定）。
pub fn bubble_group_root() -> PathBuf {
    bubble_media_root()
}

/// 用户上传字体目录：`<数据目录>/fonts`。
pub fn font_root() -> PathBuf {
    app_data_dir().join("fonts")
}

/// 抠图运行时与模型目录：`<数据目录>/ort`。
pub fn ort_dir() -> PathBuf {
    app_data_dir().join("ort")
}

/// 节假日数据的国家/地区代码（决定缓存文件名前缀）。
pub const HOLIDAY_COUNTRY_CODE: &str = "CN";

/// 节假日缓存目录：`<数据目录>/holiday`。
///
/// 一年一个文件，命名 `CN-<年份>.json`：既便于人工查看/删除某一年，
/// 也让「过期与否」完全由文件内容（`fetched_at`）决定，不依赖文件时间戳。
pub fn holiday_root() -> PathBuf {
    app_data_dir().join("holiday")
}

/// 某年的节假日缓存文件：`<数据目录>/holiday/CN-<年份>.json`。
pub fn holiday_cache_path(year: i32) -> PathBuf {
    holiday_root().join(format!("{}-{}.json", HOLIDAY_COUNTRY_CODE, year))
}

// ---------------------------------------------------------------------------
// 目录解析与迁移
// ---------------------------------------------------------------------------

/// 旧版应用数据目录：`%APPDATA%/DS Desktop Whale`。
fn legacy_data_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(LEGACY_DIR_NAME)
}

/// 主程序所在目录（绿色启动 / 多实例部署各自独立）。
fn install_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// 解析数据目录：安装目录可写则用便携目录，否则回退用户目录，保证读写始终有落点。
fn resolve_data_dir() -> PathBuf {
    if let Some(base) = install_dir() {
        let candidate = base.join(PORTABLE_DATA_DIR);
        if crate::types::utils::fs::dir_writable(&candidate) {
            return candidate;
        }
        log::warn!("安装目录不可写，回退用户数据目录：{}", candidate.display());
    }
    let fallback = legacy_data_dir();
    if let Err(err) = fs::create_dir_all(&fallback) {
        log::error!("创建用户数据目录失败：{}（{}）", fallback.display(), err);
    }
    fallback
}

/// 便携数据目录更名（`DSW-Data` → `data`）。
///
/// 目标目录为空时直接整体重命名：同盘原子操作，不会复制出第二份数据
/// （抠图模型可达数百 MB）。目标已有数据或重命名失败时退化为逐项补齐迁移。
fn rename_legacy_portable_dir(base: &Path, target: &Path) {
    let legacy = base.join(LEGACY_PORTABLE_DIR_NAME);
    if legacy == target || !legacy.is_dir() {
        return;
    }
    if crate::types::utils::fs::is_dir_empty(target) {
        // 目标通常只是探测阶段创建的空占位目录，删除它不影响任何数据。
        let _ = fs::remove_dir(target);
        match fs::rename(&legacy, target) {
            Ok(()) => {
                log::info!(
                    "数据目录已更名：{} → {}",
                    legacy.display(),
                    target.display()
                );
                return;
            }
            Err(err) => log::warn!("数据目录更名失败，改为逐项迁移：{}", err),
        }
    }
    migrate_legacy_data(&legacy, target);
}

/// 将旧版数据目录中缺失的条目迁移到新目录（已存在的条目保留新数据，避免覆盖）。
fn migrate_legacy_data(legacy: &Path, target: &Path) {
    if legacy == target || !legacy.is_dir() {
        return;
    }
    let entries = match fs::read_dir(legacy) {
        Ok(entries) => entries,
        Err(err) => {
            log::warn!("读取旧数据目录失败：{}（{}）", legacy.display(), err);
            return;
        }
    };
    let mut migrated = 0usize;
    for entry in entries.flatten() {
        let src = entry.path();
        let dst = target.join(entry.file_name());
        if dst.exists() {
            continue;
        }
        let ok = if src.is_dir() {
            crate::types::utils::fs::copy_dir_all(&src, &dst).is_ok()
        } else {
            fs::copy(&src, &dst).is_ok()
        };
        if ok {
            migrated += 1;
        } else {
            log::warn!("迁移旧数据失败：{}", src.display());
        }
    }
    if migrated > 0 {
        log::info!("已从 {} 迁移 {} 项旧数据", legacy.display(), migrated);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 创建独立临时目录（避免测试间相互干扰）。
    fn unique_dir(name: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("dsw-paths-test-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn migrate_copies_missing_entries_and_keeps_existing() {
        let root = unique_dir("migrate");
        let legacy = root.join("legacy");
        let target = root.join("target");
        fs::create_dir_all(legacy.join("pic")).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(legacy.join("config.json"), b"legacy-config").unwrap();
        fs::write(legacy.join("pic").join("main.png"), b"legacy-pic").unwrap();
        // 目标已存在同名文件时不得被旧数据覆盖。
        fs::write(target.join("usage.json"), b"new-usage").unwrap();
        fs::write(legacy.join("usage.json"), b"legacy-usage").unwrap();

        migrate_legacy_data(&legacy, &target);

        assert_eq!(
            fs::read(target.join("config.json")).unwrap(),
            b"legacy-config".to_vec()
        );
        assert_eq!(
            fs::read(target.join("usage.json")).unwrap(),
            b"new-usage".to_vec()
        );
        assert_eq!(
            fs::read(target.join("pic").join("main.png")).unwrap(),
            b"legacy-pic".to_vec()
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_is_noop_for_same_or_missing_dir() {
        let root = unique_dir("noop");
        fs::write(root.join("config.json"), b"x").unwrap();
        // 同目录：不迁移也不破坏。
        migrate_legacy_data(&root, &root);
        assert_eq!(fs::read(root.join("config.json")).unwrap(), b"x".to_vec());
        // 源目录不存在：静默返回。
        migrate_legacy_data(&root.join("not-exist"), &root.join("target"));
        let _ = fs::remove_dir_all(&root);
    }

    /// 便携数据目录名固定为 `data`，旧名 `DSW-Data` 仅作为迁移来源保留。
    #[test]
    fn portable_dir_name_is_data() {
        assert_eq!(PORTABLE_DATA_DIR, "data");
        assert_eq!(LEGACY_PORTABLE_DIR_NAME, "DSW-Data");
    }

    /// 旧便携目录 `DSW-Data` 的缺失项（含整目录）应补齐到新目录 `data`，
    /// 已存在的新数据不得被覆盖。
    #[test]
    fn legacy_portable_dir_migrates_into_data() {
        let root = unique_dir("portable");
        let legacy = root.join(LEGACY_PORTABLE_DIR_NAME);
        let target = root.join(PORTABLE_DATA_DIR);
        fs::create_dir_all(legacy.join("audio").join("我的音效")).unwrap();
        fs::write(legacy.join("config.json"), b"legacy-config").unwrap();
        fs::write(
            legacy.join("audio").join("我的音效").join("press.mp3"),
            b"legacy-mp3",
        )
        .unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("config.json"), b"new-config").unwrap();

        migrate_legacy_data(&legacy, &target);

        assert_eq!(
            fs::read(target.join("config.json")).unwrap(),
            b"new-config".to_vec(),
            "已存在的新配置不得被旧数据覆盖"
        );
        assert_eq!(
            fs::read(target.join("audio").join("我的音效").join("press.mp3")).unwrap(),
            b"legacy-mp3".to_vec(),
            "旧目录中的音效资源应整体补齐到新目录"
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// 目标目录为空时（探测阶段创建的占位目录），旧目录应被整体更名，
    /// 而不是复制出一份副本（抠图模型可达数百 MB）。
    #[test]
    fn empty_target_is_replaced_by_rename() {
        let root = unique_dir("rename");
        let legacy = root.join(LEGACY_PORTABLE_DIR_NAME);
        let target = root.join(PORTABLE_DATA_DIR);
        fs::create_dir_all(legacy.join("ort")).unwrap();
        fs::write(legacy.join("config.json"), b"moved").unwrap();
        fs::write(legacy.join("ort").join("model.onnx"), b"heavy").unwrap();
        // 模拟 app_data_dir() 探测时创建的空占位目录。
        fs::create_dir_all(&target).unwrap();

        rename_legacy_portable_dir(&root, &target);

        assert_eq!(
            fs::read(target.join("config.json")).unwrap(),
            b"moved".to_vec(),
            "更名后配置应出现在新目录"
        );
        assert_eq!(
            fs::read(target.join("ort").join("model.onnx")).unwrap(),
            b"heavy".to_vec(),
            "更名应保留嵌套目录内容"
        );
        assert!(!legacy.exists(), "更名后旧目录不应残留（避免重复占用磁盘）");

        let _ = fs::remove_dir_all(&root);
    }

    /// 目标目录已有数据时不得整体更名，改为逐项补齐，旧目录保持原样。
    #[test]
    fn non_empty_target_keeps_legacy_dir() {
        let root = unique_dir("rename-keep");
        let legacy = root.join(LEGACY_PORTABLE_DIR_NAME);
        let target = root.join(PORTABLE_DATA_DIR);
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(legacy.join("usage.json"), b"legacy-usage").unwrap();
        fs::write(target.join("config.json"), b"new-config").unwrap();

        rename_legacy_portable_dir(&root, &target);

        assert!(legacy.is_dir(), "目标非空时必须保留旧目录，不得整体更名");
        assert_eq!(
            fs::read(target.join("usage.json")).unwrap(),
            b"legacy-usage".to_vec(),
            "缺失项应被补齐"
        );
        assert_eq!(
            fs::read(target.join("config.json")).unwrap(),
            b"new-config".to_vec(),
            "已有数据不得被覆盖"
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// 数据目录内的固定路径必须都落在数据目录之下。
    #[test]
    fn data_paths_live_under_data_dir() {
        let dir = app_data_dir();
        for path in [
            config_path(),
            ledger_path(),
            rate_cache_path(),
            audio_root(),
            pic_root(),
            supplier_root(),
            ort_dir(),
            bubble_media_root(),
            font_root(),
        ] {
            assert!(
                path.starts_with(&dir),
                "{} 应位于数据目录内",
                path.display()
            );
        }
        assert_eq!(config_path().file_name().unwrap(), "config.json");
        assert_eq!(ledger_path().file_name().unwrap(), "usage.json");
        assert_eq!(audio_root().file_name().unwrap(), "audio");
        assert_eq!(pic_root().file_name().unwrap(), "pic");
        assert_eq!(supplier_root().file_name().unwrap(), "supplier");
        assert_eq!(ort_dir().file_name().unwrap(), "ort");
        assert_eq!(bubble_media_root().file_name().unwrap(), "bubble");
        assert_eq!(font_root().file_name().unwrap(), "fonts");
    }
}

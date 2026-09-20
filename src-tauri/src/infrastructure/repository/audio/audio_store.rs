//! 音效组存储
//!
//! 所有音效文件统一存放于 `<数据目录>/audio/<音效组名>/`：
//! - 仅按下（`press`）：`press.<ext>`，鼠标按下时播放一次；
//! - 仅松开（`release`）：`release.<ext>`，鼠标松开时播放一次；
//! - 按下 + 松开（`dual`）：`press.<ext>` + `release.<ext>`，两路独立播放。
//!
//! 同目录下的 `meta.json` 记录模式、启用槽位的音频文件名与裁剪 / 变速参数，
//! 使音效组自包含、可整体迁移，且无需重新编码即可无损裁剪。
//!
//! **一致性约束**：模式决定启用哪些槽位，未被启用的槽位既不写进 `meta.json`，
//! 其历史音频文件也会在保存时被清理——不残留孤儿文件，也不留下失效引用。
//!
//! 命名与参数值域规则见 `domain::audio`。

use std::fs;
use std::path::{Path, PathBuf};

use crate::domain::audio::service::audio_service::{self as audio, is_preset};
use crate::domain::audio::model::{AudioClip, AudioGroup, ResolvedAudioGroup, ResolvedClip};
use crate::infrastructure::system::paths;
use crate::types::enums::AudioMode;
use crate::types::exception::{AppError, AppResult};
use crate::types::utils::fs as fs_utils;

/// 音效组目录。
pub fn group_dir(name: &str) -> AppResult<PathBuf> {
    Ok(paths::audio_root().join(audio::sanitize_group(name)?))
}

/// `meta.json` 路径。
fn meta_path(dir: &Path) -> PathBuf {
    dir.join("meta.json")
}

/// 列出全部音效组（按名称排序）。
pub fn list_groups() -> Vec<AudioGroup> {
    let root = paths::audio_root();
    let mut groups = Vec::new();
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let name = match entry.file_name().to_str() {
                Some(n) => n.to_string(),
                None => continue,
            };
            if let Ok(group) = read_group(&name) {
                groups.push(group);
            }
        }
    }
    groups.sort_by(|a, b| a.name.cmp(&b.name));
    groups
}

/// 读取某个音效组定义。
pub fn read_group(name: &str) -> AppResult<AudioGroup> {
    let dir = group_dir(name)?;
    let path = meta_path(&dir);
    let text = fs::read_to_string(&path)
        .map_err(|e| AppError::io(format!("读取音效配置失败（{}）：{}", path.display(), e)))?;
    let group: AudioGroup = serde_json::from_str(&text)
        .map_err(|e| AppError::serde(format!("解析音效配置失败：{}", e)))?;
    // 以文件夹名为准，避免 meta 内名称与目录不一致。
    let mut group = audio::normalize_group(group);
    group.name = audio::sanitize_group(name)?;
    Ok(group)
}

/// 解析音效组为可直接播放的形式（含绝对路径，校验文件存在）。
pub fn resolve_group(name: &str) -> AppResult<ResolvedAudioGroup> {
    let group = read_group(name)?;
    let dir = group_dir(name)?;

    let resolve = |clip: Option<AudioClip>| -> AppResult<Option<ResolvedClip>> {
        let clip = match clip {
            Some(c) => c,
            None => return Ok(None),
        };
        let path = dir.join(&clip.file);
        if !path.is_file() {
            return Err(AppError::not_found(format!(
                "音效文件缺失：{}",
                path.display()
            )));
        }
        Ok(Some(ResolvedClip {
            path: path.to_string_lossy().to_string(),
            file: clip.file,
            start: clip.start,
            end: clip.end,
            rate: clip.rate,
        }))
    };

    Ok(ResolvedAudioGroup {
        name: group.name,
        mode: group.mode,
        press: resolve(group.press)?,
        release: resolve(group.release)?,
    })
}

/// 覆盖式写入音效组：把新选择的音频文件复制进组目录，并写入 `meta.json`。
///
/// 槽位由 `mode` 决定（仅按下 / 仅松开 / 按下 + 松开）：
/// - **启用**的槽位：优先使用新选择的源文件，其次沿用组内已有文件；两者都没有
///   则报错，避免写出一个「有配置却没有音频」的失声音效组；
/// - **未启用**的槽位：连同其历史音频文件一起清理，`meta.json` 中不再保留该
///   字段，避免「文件残留但配置不引用」或「配置引用但文件已删」的不一致。
///
/// `press_src` / `release_src` 为系统文件选择器返回的源路径，`None` 表示沿用已有文件。
pub fn save_group(
    name: &str,
    mode: AudioMode,
    press_src: Option<String>,
    release_src: Option<String>,
    press: Option<AudioClip>,
    release: Option<AudioClip>,
) -> AppResult<AudioGroup> {
    let name = audio::sanitize_group(name)?;
    if is_preset(&name) {
        return Err(AppError::conflict("音效名称与内置音效重名，请换一个名称"));
    }
    let dir = paths::audio_root().join(&name);
    fs::create_dir_all(&dir).map_err(|e| AppError::io(format!("创建音效目录失败：{}", e)))?;

    let mut next = AudioGroup {
        name: name.clone(),
        mode: mode.as_str().to_string(),
        press: None,
        release: None,
    };
    next.press = save_slot(
        &dir,
        "press",
        mode.needs_press(),
        press_src,
        press,
        "请为「按下」上传音频文件",
    )?;
    next.release = save_slot(
        &dir,
        "release",
        mode.needs_release(),
        release_src,
        release,
        "请为「松开」上传音频文件",
    )?;

    let group = audio::normalize_group(next);
    write_meta(&dir, &group)?;
    log::info!(
        "已保存音效组：{}（{}，槽位：{}）",
        name,
        group.mode,
        if group.press.is_some() && group.release.is_some() {
            "按下+松开"
        } else if group.release.is_some() {
            "松开"
        } else {
            "按下"
        }
    );
    Ok(group)
}

/// 处理单个槽位：启用则导入 / 沿用音频文件，未启用则清理该槽位的全部文件。
fn save_slot(
    dir: &Path,
    slot: &str,
    enabled: bool,
    src: Option<String>,
    clip: Option<AudioClip>,
    missing_msg: &str,
) -> AppResult<Option<AudioClip>> {
    if !enabled {
        // 未启用：文件与配置一处都不保留，保证组目录与 meta.json 严格对应。
        remove_slot_files(dir, slot);
        return Ok(None);
    }

    let next = match src {
        Some(src) => Some(import_audio(dir, slot, &src, clip)?),
        None => match clip {
            Some(mut clip) => {
                clip.file = existing_file(dir, &clip.file, slot)?;
                Some(clip)
            }
            None => None,
        },
    };
    next.map(Some).ok_or_else(|| AppError::invalid(missing_msg))
}

/// 删除音效组：整体移除组目录，连带其中的全部音频文件与 `meta.json`。
///
/// 内置音效 id 不落盘，不属于可删除的自定义音效组。
pub fn delete_group(name: &str) -> AppResult<()> {
    let name = audio::sanitize_group(name)?;
    if is_preset(&name) {
        return Err(AppError::invalid("内置音效不可删除"));
    }
    let dir = paths::audio_root().join(&name);
    if !dir.is_dir() {
        return Err(AppError::not_found(format!("音效组不存在：{}", name)));
    }
    fs::remove_dir_all(&dir).map_err(|e| AppError::io(format!("删除音效组失败：{}", e)))?;
    log::info!("已删除音效组：{}（{}）", name, dir.display());
    Ok(())
}

/// 复制源文件到组目录并返回片段定义。
fn import_audio(
    dir: &Path,
    slot: &str,
    src: &str,
    clip: Option<AudioClip>,
) -> AppResult<AudioClip> {
    let src_path = Path::new(src);
    if !src_path.is_file() {
        return Err(AppError::not_found(format!("音频文件不存在：{}", src)));
    }
    let ext = src_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "mp3".to_string());
    let filename = format!("{}.{}", slot, ext);
    // 先清理该槽位的历史文件（扩展名可能不同）。
    remove_slot_files(dir, slot);
    let dest = dir.join(&filename);
    fs::copy(src_path, &dest).map_err(|e| AppError::io(format!("复制音频文件失败：{}", e)))?;

    let mut out = clip.unwrap_or(AudioClip {
        file: filename.clone(),
        start: 0.0,
        end: 0.0,
        rate: crate::domain::audio::model::default_rate(),
    });
    out.file = filename;
    Ok(out)
}

/// 沿用旧文件时校验其仍然存在，否则报错并给出提示。
fn existing_file(dir: &Path, file: &str, slot: &str) -> AppResult<String> {
    if !file.is_empty() && dir.join(file).is_file() {
        return Ok(file.to_string());
    }
    // 兼容扩展名变化：按槽位前缀查找。
    let mut found: Option<String> = None;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("{}.", slot)) {
                found = Some(name);
                break;
            }
        }
    }
    found.ok_or_else(|| {
        AppError::not_found(format!("缺少「{}」音频文件，请重新上传", slot_label(slot)))
    })
}

/// 槽位中文名（用于错误提示）。
fn slot_label(slot: &str) -> &'static str {
    if slot == "release" {
        "松开"
    } else {
        "按下"
    }
}

/// 删除某槽位的历史音频文件。
fn remove_slot_files(dir: &Path, slot: &str) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("{}.", slot)) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// 原子写入 `meta.json`。
fn write_meta(dir: &Path, group: &AudioGroup) -> AppResult<()> {
    let json = serde_json::to_string_pretty(group).map_err(|e| AppError::serde(e.to_string()))?;
    fs_utils::write_atomic(
        &meta_path(dir),
        json.as_bytes(),
        |e| AppError::io(format!("写入音效配置失败：{}", e)),
        |e| AppError::io(format!("保存音效配置失败：{}", e)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_name(tag: &str) -> String {
        format!("测试音效{}{}", tag, std::process::id())
    }

    fn write_src(tag: &str, bytes: &[u8]) -> String {
        let path = std::env::temp_dir().join(format!(
            "dsw-audio-src-{}-{}-{}",
            std::process::id(),
            tag,
            bytes.len()
        ));
        fs::write(&path, bytes).unwrap();
        path.to_string_lossy().to_string()
    }

    #[test]
    fn group_dir_lives_under_audio_root() {
        let dir = group_dir("甲组").unwrap();
        assert!(
            dir.ends_with(Path::new("data/audio/甲组")),
            "音效组目录应为 <数据目录>/audio/<组名>，实际：{}",
            dir.display()
        );
        assert_eq!(paths::audio_root().file_name().unwrap(), "audio");
    }

    #[test]
    fn save_press_only_group_copies_file_and_writes_meta() {
        let name = unique_name("单");
        let src = write_src("single", b"FAKE-MP3-BYTES");
        let group = save_group(
            &name,
            AudioMode::Press,
            Some(src),
            None,
            Some(AudioClip {
                file: String::new(),
                start: 0.5,
                end: 1.5,
                rate: 1.3,
            }),
            None,
        )
        .expect("保存仅按下音效组应成功");

        assert_eq!(group.mode, "press");
        assert!(group.release.is_none());
        let clip = group.press.clone().expect("应有按下音效");
        assert_eq!(clip.file, "press.mp3");
        assert_eq!(clip.start, 0.5);
        assert_eq!(clip.end, 1.5);
        assert_eq!(clip.rate, 1.3);

        let dir = group_dir(&name).unwrap();
        assert!(dir.join("press.mp3").is_file(), "音频文件应复制进组目录");
        assert!(dir.join("meta.json").is_file(), "应写入 meta.json");

        // 解析结果应包含绝对路径与编辑参数。
        let resolved = resolve_group(&name).expect("解析应成功");
        assert_eq!(resolved.mode, "press");
        let press = resolved.press.expect("应有按下音效");
        assert!(press.path.ends_with("press.mp3"));
        assert_eq!(press.file, "press.mp3", "解析结果应带组内文件名供编辑沿用");
        assert_eq!(press.rate, 1.3);
        assert!(resolved.release.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    /// 三种模式的槽位一致性：启用槽位必须有音频，未启用槽位的文件不得残留。
    #[test]
    fn mode_decides_slots_and_cleans_unused_files() {
        let name = unique_name("三模");
        let press_src = write_src("tripress", b"PRESS");
        let release_src = write_src("trirelease", b"RELEASE");

        // 组合模式缺少松开音频时应报错。
        let err = save_group(
            &name,
            AudioMode::Dual,
            Some(press_src.clone()),
            None,
            None,
            None,
        )
        .expect_err("缺少松开音频应报错");
        assert!(
            err.message().contains("松开"),
            "错误信息应指明缺少松开音频：{}",
            err.message()
        );

        // 按下 + 松开：两个文件都落盘，meta 两个槽位都有引用。
        let dual = save_group(
            &name,
            AudioMode::Dual,
            Some(press_src.clone()),
            Some(release_src.clone()),
            None,
            None,
        )
        .expect("组合模式保存应成功");
        assert_eq!(dual.mode, "dual");
        assert!(dual.press.is_some() && dual.release.is_some());

        let dir = group_dir(&name).unwrap();
        assert!(dir.join("press.mp3").is_file());
        assert!(dir.join("release.mp3").is_file());

        // 切到「仅松开」：按下沿用失败（未提供源文件与旧片段）应报错。
        let err = save_group(&name, AudioMode::Release, None, None, None, None)
            .expect_err("仅松开模式缺少松开音频应报错");
        assert!(err.message().contains("松开"), "{}", err.message());

        // 切到「仅松开」：按下文件被清理，meta 不再引用按下槽位。
        let release_only = save_group(
            &name,
            AudioMode::Release,
            None,
            None,
            None,
            dual.release.clone(),
        )
        .expect("切换为仅松开应成功");
        assert_eq!(release_only.mode, "release");
        assert!(release_only.press.is_none() && release_only.release.is_some());
        assert!(!dir.join("press.mp3").exists(), "未启用的按下文件应被清理");
        let meta = fs::read_to_string(dir.join("meta.json")).unwrap();
        assert!(
            meta.contains("\"press\": null"),
            "未启用槽位应在 meta.json 中显式置空：{}",
            meta
        );
        assert!(
            !meta.contains("\"press\": {"),
            "未启用槽位不应保留文件引用：{}",
            meta
        );

        // 切到「仅按下」：松开文件被清理，且必须提供按下音频。
        let err = save_group(&name, AudioMode::Press, None, None, None, None)
            .expect_err("仅按下模式缺少按下音频应报错");
        assert!(err.message().contains("按下"), "{}", err.message());

        let press_only = save_group(&name, AudioMode::Press, Some(press_src), None, None, None)
            .expect("切换为仅按下应成功");
        assert_eq!(press_only.mode, "press");
        assert!(press_only.press.is_some() && press_only.release.is_none());
        assert!(
            !dir.join("release.mp3").exists(),
            "未启用的松开文件应被清理"
        );

        // 解析结果必须与磁盘一致：未启用槽位不可解析出引用。
        let resolved = resolve_group(&name).expect("解析应成功");
        assert_eq!(resolved.mode, "press");
        assert!(resolved.press.is_some() && resolved.release.is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    /// 仅松开模式：只上传松开音频即可保存（历史实现强制要求必须有按下音频）。
    #[test]
    fn release_only_group_saves_without_press_file() {
        let name = unique_name("仅松开");
        let src = write_src("releaseonly", b"RELEASE-ONLY");
        let group = save_group(
            &name,
            AudioMode::Release,
            None,
            Some(src),
            None,
            Some(AudioClip {
                file: String::new(),
                start: 0.2,
                end: 0.9,
                rate: 1.4,
            }),
        )
        .expect("仅松开保存应成功");

        assert_eq!(group.mode, "release");
        assert!(group.press.is_none(), "仅松开模式不应有按下槽位");
        let clip = group.release.clone().expect("应有松开音效");
        assert_eq!(clip.file, "release.mp3");
        assert_eq!(clip.start, 0.2);
        assert_eq!(clip.end, 0.9);
        assert_eq!(clip.rate, 1.4);

        let dir = group_dir(&name).unwrap();
        assert!(dir.join("release.mp3").is_file(), "松开音频应复制进组目录");
        assert!(!dir.join("press.mp3").exists(), "不应凭空产生按下音频");
        let meta = fs::read_to_string(dir.join("meta.json")).unwrap();
        assert!(
            meta.contains("\"press\": null"),
            "未启用槽位应在 meta.json 中显式置空：{}",
            meta
        );
        assert!(
            !meta.contains("\"press\": {"),
            "未启用槽位不应保留文件引用：{}",
            meta
        );

        let resolved = resolve_group(&name).expect("解析应成功");
        assert_eq!(resolved.mode, "release");
        assert!(resolved.press.is_none() && resolved.release.is_some());
        let release = resolved.release.unwrap();
        assert!(release.path.ends_with("release.mp3"));
        assert_eq!(release.file, "release.mp3");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rate_is_clamped_to_supported_range() {
        let name = unique_name("速");
        let src = write_src("rate", b"RATE");
        let group = save_group(
            &name,
            AudioMode::Press,
            Some(src),
            None,
            Some(AudioClip {
                file: String::new(),
                start: -1.0,
                end: 0.0,
                rate: 5.0,
            }),
            None,
        )
        .expect("保存应成功");
        let clip = group.press.unwrap();
        assert_eq!(clip.rate, 1.0, "超出范围应回落默认倍速");
        assert_eq!(clip.start, 0.0, "负起点应归零");

        let _ = fs::remove_dir_all(group_dir(&name).unwrap());
    }

    #[test]
    fn list_groups_includes_saved_group_only() {
        let name = unique_name("列");
        let src = write_src("list", b"LIST");
        assert!(!list_groups().iter().any(|g| g.name == name));
        save_group(&name, AudioMode::Press, Some(src), None, None, None).expect("保存应成功");
        let groups = list_groups();
        assert!(
            groups.iter().any(|g| g.name == name),
            "列表应包含新保存的组"
        );
        let _ = fs::remove_dir_all(group_dir(&name).unwrap());
        assert!(!list_groups().iter().any(|g| g.name == name));
    }

    /// 删除音效组必须连带清理组目录内的全部音频文件与 `meta.json`。
    #[test]
    fn delete_group_removes_all_audio_assets() {
        let name = unique_name("删");
        let press_src = write_src("delpress", b"PRESS");
        let release_src = write_src("delrelease", b"RELEASE");
        save_group(
            &name,
            AudioMode::Dual,
            Some(press_src),
            Some(release_src),
            None,
            None,
        )
        .expect("保存双音效组应成功");

        let dir = group_dir(&name).unwrap();
        assert!(dir.join("press.mp3").is_file() && dir.join("release.mp3").is_file());
        assert!(dir.join("meta.json").is_file());

        delete_group(&name).expect("删除应成功");
        assert!(!dir.exists(), "删除后组目录必须整体消失，不得残留音频文件");
        assert!(!list_groups().iter().any(|g| g.name == name));
    }

    /// 内置音效不落盘，既不可删除，也不允许创建重名的自定义音效组。
    #[test]
    fn delete_group_rejects_presets_and_missing() {
        for id in audio::PRESET_IDS {
            assert!(delete_group(id).is_err(), "内置音效 {} 不应可删除", id);
        }
        assert!(delete_group("不存在的音效组-xyz").is_err());

        let src = write_src("presetname", b"X");
        let err = save_group("duck", AudioMode::Press, Some(src), None, None, None)
            .expect_err("与内置音效重名应被拒绝");
        assert!(
            err.message().contains("重名"),
            "错误信息应说明原因：{}",
            err.message()
        );
    }

    #[test]
    fn resolve_group_reports_missing_file() {
        let name = unique_name("缺");
        let src = write_src("missing", b"MISS");
        save_group(&name, AudioMode::Press, Some(src), None, None, None).expect("保存应成功");
        let dir = group_dir(&name).unwrap();
        fs::remove_file(dir.join("press.mp3")).unwrap();
        assert!(resolve_group(&name).is_err(), "文件缺失时解析应失败");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 仅松开组同样受文件完整性保护：松开音频缺失时解析必须失败。
    #[test]
    fn resolve_group_reports_missing_release_file() {
        let name = unique_name("缺松");
        let src = write_src("missingrelease", b"MISS-RELEASE");
        save_group(&name, AudioMode::Release, None, Some(src), None, None).expect("保存应成功");
        let dir = group_dir(&name).unwrap();
        assert!(resolve_group(&name).is_ok(), "文件齐备时应可解析");
        fs::remove_file(dir.join("release.mp3")).unwrap();
        assert!(resolve_group(&name).is_err(), "松开文件缺失时解析应失败");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 沿用旧文件时，若扩展名变化（如 press.wav → press.mp3）也能找回。
    #[test]
    fn existing_file_falls_back_to_slot_prefix() {
        let name = unique_name("沿用");
        let src = write_src("reuse", b"WAV");
        save_group(&name, AudioMode::Press, Some(src), None, None, None).expect("保存应成功");
        let dir = group_dir(&name).unwrap();

        let resolved = existing_file(&dir, "stale-name.wav", "press").expect("应回落到实际文件");
        assert_eq!(resolved, "press.mp3");

        let _ = fs::remove_dir_all(&dir);
    }
}

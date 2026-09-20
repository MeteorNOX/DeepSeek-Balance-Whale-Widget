//! 模块化气泡用例
//!
//! 气泡配置的读写、气泡组管理，以及客户端字体 / 图片动图的上传与读取。
//!
//! 资源以文件形式落在数据目录（`bubble/` 与 `fonts/`），配置里只保存文件名：
//! 动图动辄数 MB，若塞进 `config.json`，每次保存挂件配置都要搬运一遍大文件。
//!
//! # 气泡组与配置的关系
//! 组内容存在 `<数据目录>/bubble/<组名>/group.json`，而 `config.bubble.rows`
//! 始终是**当前组**的镜像。保存配置时同步写一份组文件（编辑即自动保存到当前组），
//! 切换组则是反向搬运。
//!
//! # 草稿与「已应用」
//! `config.bubble` 是编辑区草稿：随改随存，只喂给配置页的实时预览；
//! 桌面挂件只认 `config.bubble_applied`，它只在用户**明确应用**时更新
//! （点「应用」另存 / 覆写当前组、在下拉栏切换气泡组、恢复默认设置）。
//! 这样编辑到一半的半成品不会实时闪到桌面上。

use crate::domain::config::service::config_service;
use crate::domain::bubble::model::entity::bubble_config::DEFAULT_BUBBLE_GROUP;
use crate::domain::bubble::model::entity::bubble_config::{BubbleConfig, PickedBubbleAsset};
use crate::types::exception::{AppError, AppResult};
use crate::types::utils::base64 as b64;
use crate::types::utils::fs as fs_utils;
use crate::application::registry;

/// 保存模块化气泡草稿（落盘 + 返回规范化后的结果）。
///
/// 同时把内容写进当前组：组文件与草稿因此始终一致，切换组不会读到旧内容。
///
/// **不动「已应用」的那一份**：草稿只服务配置页的预览，桌面挂件的更新只发生在
/// 用户明确应用时（见 [`save_group`] / [`switch_group`]）。
pub fn save_bubble(bubble: BubbleConfig) -> AppResult<BubbleConfig> {
    let mut next = bubble;
    // 组名是目录名：非法值统一回落到默认组（与配置规范化同一套规则）。
    let target = config_service::sanitize_group_name(&next.current_group)
        .unwrap_or_else(|_| DEFAULT_BUBBLE_GROUP.to_string());
    next.current_group = target.clone();

    // 先写组文件，再写配置：任一步失败即整体失败，不产生「配置新、组文件旧」的分歧。
    // 已存在的组才回写——否则刚被删除的组会被一次防抖保存原地复活。
    if target == DEFAULT_BUBBLE_GROUP || registry::bubble().group_exists(&target) {
        registry::bubble().save_group(&target, &next)?;
    }

    let cfg = registry::config().mutate(Box::new(move |c| c.bubble = next))?;
    Ok(cfg.bubble)
}

/// 列出全部气泡组（配置页下拉）。
///
/// 「默认」组不存在时按当前配置补写一次：气泡组是后加的概念，
/// 老配置里那一份 `bubble.rows` 就是用户原本的「默认」组。
pub fn list_groups() -> Vec<String> {
    ensure_default_group();
    registry::bubble().list_groups()
}

/// 切换气泡组：把该组的内容搬进配置，并**同时设为已应用**（挂件随之刷新）。
pub fn switch_group(name: &str) -> AppResult<BubbleConfig> {
    let clean = config_service::sanitize_group_name(name)?;
    if clean == DEFAULT_BUBBLE_GROUP {
        ensure_default_group();
    }
    let group = registry::bubble().read_group(&clean)?;
    let cfg = registry::config().mutate(Box::new(move |c| {
        c.bubble = group.clone();
        c.bubble_applied = Some(group);
    }))?;
    Ok(cfg.bubble)
}

/// 把当前编辑内容另存为一个新组（「应用」按钮），该组同时成为草稿与已应用气泡。
pub fn save_group(name: &str, bubble: &BubbleConfig) -> AppResult<BubbleConfig> {
    let group = registry::bubble().save_group(name, bubble)?;
    let cfg = registry::config().mutate(Box::new(move |c| {
        c.bubble = group.clone();
        c.bubble_applied = Some(group);
    }))?;
    Ok(cfg.bubble)
}

/// 静默回写某个气泡组的内容：只落盘组文件，不动当前配置、不广播。
///
/// 用途：编辑期的自动保存会把编辑区内容写进「当前组」，若用户随后点「应用」
/// 把这份内容另存为新组，源组就被这次另存顺带改写了——各组内容越改越像，
/// 下拉切换也就失去意义。前端在另存之前用本命令把源组还原成编辑前的样子。
pub fn write_group(name: &str, bubble: &BubbleConfig) -> AppResult<()> {
    let clean = config_service::sanitize_group_name(name)?;
    // 与 save_bubble 同一套保护：已存在的组才回写，绝不凭空造组
    //（否则刚被删掉的组会被一次还原调用原地复活）。
    if clean != DEFAULT_BUBBLE_GROUP && !registry::bubble().group_exists(&clean) {
        return Ok(());
    }
    registry::bubble().save_group(&clean, bubble)?;
    Ok(())
}

/// 删除气泡组；被删的正好是当前组时，回落到「默认」组。
pub fn delete_group(name: &str) -> AppResult<BubbleConfig> {
    let clean = config_service::sanitize_group_name(name)?;
    registry::bubble().delete_group(&clean)?;

    let current = registry::config().get().bubble;
    if current.current_group != clean {
        return Ok(current);
    }
    ensure_default_group();
    switch_group(DEFAULT_BUBBLE_GROUP)
}

/// 「默认」组缺失时按当前配置补写（迁移 + 兜底，幂等）。
fn ensure_default_group() {
    if registry::bubble().group_exists(DEFAULT_BUBBLE_GROUP) {
        return;
    }
    let bubble = registry::config().get().bubble;
    if let Err(err) = registry::bubble().save_group(DEFAULT_BUBBLE_GROUP, &bubble) {
        // 补写失败不该让「列出组」整体失败：下拉里仍会显示内置的「默认」项。
        log::warn!("补写默认气泡组失败：{}", err.message());
    }
}

/// 系统对话框选择图片 / 动图：落盘到 `<数据目录>/bubble/` 并返回文件名与 Data URL。
pub fn pick_media() -> AppResult<PickedBubbleAsset> {
    let path = registry::asset_picker()
        .pick_media()
        .ok_or_else(|| AppError::invalid("未选择文件"))?;
    let source = path.to_string_lossy().to_string();
    let bytes = fs_utils::read_bytes(&path, "图片文件")?;
    let name = registry::bubble().save_media(&source, &bytes)?;
    Ok(PickedBubbleAsset {
        data_url: b64::media_data_url(&name, &bytes),
        name,
    })
}

/// 读取气泡媒体为 Data URL（配置页与挂件窗口共用）。
pub fn read_media(name: &str) -> AppResult<String> {
    let bytes = registry::bubble().read_media(name)?;
    Ok(b64::media_data_url(name, &bytes))
}

/// 系统对话框选择字体：落盘到 `<数据目录>/fonts/` 并返回文件名与 Data URL。
pub fn pick_font() -> AppResult<PickedBubbleAsset> {
    let path = registry::asset_picker()
        .pick_font()
        .ok_or_else(|| AppError::invalid("未选择字体"))?;
    let source = path.to_string_lossy().to_string();
    let bytes = fs_utils::read_bytes(&path, "字体文件")?;
    let name = registry::bubble().save_font(&source, &bytes)?;
    Ok(PickedBubbleAsset {
        data_url: b64::font_data_url(&name, &bytes),
        name,
    })
}

/// 读取字体为 Data URL（前端据此注入 `@font-face`，两个窗口都能立即用上）。
pub fn read_font(name: &str) -> AppResult<String> {
    let bytes = registry::bubble().read_font(name)?;
    Ok(b64::font_data_url(name, &bytes))
}

/// 列出已上传的字体（配置页字体下拉：让用户能在已传过的字体之间切换）。
pub fn list_fonts() -> Vec<String> {
    registry::bubble().list_fonts()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::bubble::model::entity::bubble_config::{BubbleBlock, BubbleRow};

    /// 用例级互斥锁。
    ///
    /// 本模块的用例都会真写同一份 `config.json`（原子写要经过同一个临时文件），
    /// 并发执行时会在 Windows 上撞出「拒绝访问（os error 5）」。
    /// 串行化这几条用例即可，生产代码不受影响。
    static CONFIG_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 拿锁：前一条用例 panic 过也不连坐后面的用例。
    ///
    /// 顺带完成仓储装配：用例走的是真实落盘路径（与生产同一套实现）。
    fn lock_config() -> std::sync::MutexGuard<'static, ()> {
        crate::install_test_repositories();
        CONFIG_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 保存后必须能从配置里原样读回（前端重启后靠它还原编辑内容）。
    #[test]
    fn saved_bubble_is_persisted_and_normalized() {
        let _guard = lock_config();
        // 用例会真写一次 config.json：先记住原值，结束时还原，避免影响用户配置。
        let original = registry::config().get().bubble;
        let block = |kind: &str| BubbleBlock {
            kind: kind.to_string(),
            ..BubbleBlock::default()
        };
        let bubble = BubbleConfig {
            rows: vec![
                BubbleRow {
                    blocks: vec![block("text")],
                },
                // 空行 / 未知类型必须被规范化丢掉。
                BubbleRow { blocks: vec![] },
                BubbleRow {
                    blocks: vec![block("不存在的类型")],
                },
            ],
            current_group: DEFAULT_BUBBLE_GROUP.to_string(),
        };
        let saved = save_bubble(bubble).unwrap();
        assert_eq!(saved.rows.len(), 1, "空行与未知模块应被丢弃");
        assert_eq!(saved.rows[0].blocks[0].kind, "text");
        assert_eq!(registry::config().get().bubble.rows.len(), 1);

        let _ = save_bubble(original);
    }

    /// 保存配置必须同步写进当前组：「编辑即自动保存到当前组」的落点。
    #[test]
    fn saving_bubble_also_writes_current_group() {
        let _guard = lock_config();
        let original = registry::config().get().bubble;
        let name = format!("保存组{}", std::process::id());
        let _ = registry::bubble().delete_group(&name);

        let mut bubble = BubbleConfig {
            rows: vec![BubbleRow {
                blocks: vec![BubbleBlock {
                    kind: "text".to_string(),
                    text: "组里的内容".to_string(),
                    ..BubbleBlock::default()
                }],
            }],
            current_group: name.clone(),
        };
        // 新建组必须走 save_group（下拉里的「应用」），否则防抖保存不会凭空造组。
        bubble = save_group(&name, &bubble).unwrap();

        // 再改一次内容并走普通保存：组文件应同步更新。
        bubble.rows[0].blocks[0].text = "改过的内容".to_string();
        save_bubble(bubble).unwrap();
        assert_eq!(
            registry::bubble().read_group(&name).unwrap().rows[0].blocks[0].text,
            "改过的内容"
        );

        // 收尾：删掉用例组并把配置还原成「默认」组。
        let _ = delete_group(&name);
        let _ = save_bubble(original);
    }

    /// 切换组：把组内容搬进配置，并把当前组名一起带过去。
    #[test]
    fn switching_group_moves_content_into_config() {
        let _guard = lock_config();
        let original = registry::config().get().bubble;
        let name = format!("切换组{}", std::process::id());
        let _ = registry::bubble().delete_group(&name);

        let group = BubbleConfig {
            rows: vec![BubbleRow {
                blocks: vec![BubbleBlock {
                    kind: "balance".to_string(),
                    ..BubbleBlock::default()
                }],
            }],
            current_group: name.clone(),
        };
        save_group(&name, &group).unwrap();

        let next = switch_group(&name).unwrap();
        assert_eq!(next.current_group, name);
        assert_eq!(next.rows[0].blocks[0].kind, "balance");
        assert_eq!(registry::config().get().bubble.current_group, name);

        // 收尾：回到「默认」组并还原用户配置。
        let _ = delete_group(&name);
        let restored = switch_group(DEFAULT_BUBBLE_GROUP).unwrap();
        assert_eq!(restored.current_group, DEFAULT_BUBBLE_GROUP);
        let _ = save_bubble(original);
    }

    /// 编辑期草稿不得动「已应用气泡」——这正是「桌宠只在应用 / 切组时更新」的落点：
    /// 编辑区随改随存，但桌宠读的是另一份，半成品不会闪到桌面上。
    #[test]
    fn draft_save_never_touches_applied_bubble() {
        let _guard = lock_config();
        let original = registry::config().get().bubble;
        let name = format!("草稿组{}", std::process::id());
        let _ = registry::bubble().delete_group(&name);
        let text_of = |bubble: &BubbleConfig| bubble.rows[0].blocks[0].text.clone();

        // 点「应用」建组：该组同时成为草稿与已应用气泡。
        let group = BubbleConfig {
            rows: vec![BubbleRow {
                blocks: vec![BubbleBlock {
                    kind: "text".to_string(),
                    text: "一".to_string(),
                    ..BubbleBlock::default()
                }],
            }],
            current_group: name.clone(),
        };
        save_group(&name, &group).unwrap();
        assert_eq!(
            text_of(&registry::config().get().bubble_applied.unwrap()),
            "一"
        );

        // 继续在编辑区改：组文件与草稿都跟着变，已应用的那一份原封不动。
        let mut draft = group.clone();
        draft.rows[0].blocks[0].text = "二".to_string();
        save_bubble(draft).unwrap();
        let cfg = registry::config().get();
        assert_eq!(text_of(&cfg.bubble), "二", "草稿要随改随存");
        assert_eq!(
            text_of(&cfg.bubble_applied.clone().unwrap()),
            "一",
            "编辑期的草稿不得外发到桌宠"
        );

        // 在下拉栏切到这个组（用户明确应用）：已应用气泡才跟着更新。
        switch_group(&name).unwrap();
        assert_eq!(
            text_of(&registry::config().get().bubble_applied.unwrap()),
            "二"
        );

        // 收尾：删掉用例组、回到「默认」组并还原用户配置。
        let _ = delete_group(&name);
        let _ = switch_group(DEFAULT_BUBBLE_GROUP);
        let _ = save_bubble(original);
    }

    /// 静默回写组：只改组文件，当前配置与当前组名都不许被带偏；
    /// 不存在的组也不许被凭空造出来。
    #[test]
    fn write_group_only_touches_that_group_file() {
        let _guard = lock_config();
        let original = registry::config().get().bubble;
        let name = format!("静写组{}", std::process::id());
        let ghost = format!("幽灵组{}", std::process::id());
        let _ = registry::bubble().delete_group(&name);
        let _ = registry::bubble().delete_group(&ghost);

        // 先建一个组并切过去，让「当前组」指向它。
        let group = BubbleConfig {
            rows: vec![BubbleRow {
                blocks: vec![BubbleBlock {
                    kind: "text".to_string(),
                    text: "组里的内容".to_string(),
                    ..BubbleBlock::default()
                }],
            }],
            current_group: name.clone(),
        };
        save_group(&name, &group).unwrap();
        switch_group(&name).unwrap();

        // 静默回写另外一份内容：组文件变了，配置一点没动。
        let restored = BubbleConfig {
            rows: vec![BubbleRow {
                blocks: vec![BubbleBlock {
                    kind: "countdown".to_string(),
                    ..BubbleBlock::default()
                }],
            }],
            current_group: name.clone(),
        };
        write_group(&name, &restored).unwrap();
        assert_eq!(
            registry::bubble().read_group(&name).unwrap().rows[0].blocks[0].kind,
            "countdown"
        );
        let current = registry::config().get().bubble;
        assert_eq!(current.current_group, name, "静默回写不得改变当前组名");
        assert_eq!(current.rows[0].blocks[0].kind, "text", "静默回写不得改写当前配置");

        // 不存在的组：直接跳过，不建目录。
        write_group(&ghost, &restored).unwrap();
        assert!(!registry::bubble().group_exists(&ghost), "不得凭空造组");

        // 收尾：回到「默认」组并还原用户配置。
        let _ = delete_group(&name);
        let _ = switch_group(DEFAULT_BUBBLE_GROUP);
        let _ = save_bubble(original);
    }

    /// 删掉当前组后必须回落到「默认」组，不能让配置指向一个不存在的组。
    #[test]
    fn deleting_current_group_falls_back_to_default() {
        let _guard = lock_config();
        let original = registry::config().get().bubble;
        let name = format!("待删组{}", std::process::id());
        let _ = registry::bubble().delete_group(&name);

        let group = BubbleConfig {
            rows: vec![BubbleRow {
                blocks: vec![BubbleBlock {
                    kind: "countdown".to_string(),
                    ..BubbleBlock::default()
                }],
            }],
            current_group: name.clone(),
        };
        save_group(&name, &group).unwrap();

        let after = delete_group(&name).unwrap();
        assert_eq!(after.current_group, DEFAULT_BUBBLE_GROUP);
        assert!(list_groups().contains(&DEFAULT_BUBBLE_GROUP.to_string()));
        assert!(!list_groups().contains(&name));

        let _ = save_bubble(original);
    }

    /// 读取不存在的资源必须给出明确错误，而不是返回空内容。
    #[test]
    fn missing_asset_reports_error() {
        let err = read_media("not-exist-0000.png").unwrap_err();
        assert!(err.message().contains("不存在"), "{}", err.message());
        let err = read_font("not-exist-0000.woff2").unwrap_err();
        assert!(err.message().contains("不存在"), "{}", err.message());
    }

    /// 读取入参不接受目录成分（配置被改写也不能越权）。
    #[test]
    fn read_rejects_path_components() {
        assert!(read_media("../config.json").is_err());
        assert!(read_font("sub/a.ttf").is_err());
    }
}

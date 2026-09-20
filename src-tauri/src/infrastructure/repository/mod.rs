//! 仓储实现层
//!
//! 各领域的仓储实现（对应 `domain/<领域>/repository` 的 trait）与持久化对象（`po/`）：
//! 领域层只认识模型与 trait，落盘格式、目录布局、原子写等细节全部收在这一层。
//! 依赖方向恒为 `infrastructure -> domain`，本层不得反向依赖 `api` / `application`。

pub mod config;
pub mod bubble;
pub mod pricing;
pub mod supplier;
pub mod ledger;
pub mod widget_image;
pub mod audio;
pub mod asset;
pub mod balance;
pub mod client;
pub mod system;
pub mod update;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::system::paths;

    /// 真实数据目录的只读连通性：仓储层必须能在真实环境下完成
    /// 「配置读取 → 音效组枚举 → 图片组枚举」的完整路径（不写盘、不 panic）。
    #[test]
    fn real_data_dir_is_readable_through_new_layers() {
        let dir = paths::app_data_dir();
        assert!(!dir.as_os_str().is_empty(), "数据目录必须可解析");

        // 配置：读取真实配置（normalize 保证字段合法）。
        let cfg = config::config_store::get_config();
        assert!(!cfg.base_url.is_empty(), "请求地址必须非空");
        assert!(!cfg.widget.sound_set.is_empty(), "音效组必须非空");

        // 音效组 / 图片组：目录不存在时返回空列表，存在时必须能逐个读出。
        for group in audio::audio_store::list_groups() {
            assert!(!group.name.is_empty());
            assert!(["press", "release", "dual"].contains(&group.mode.as_str()));
        }
        for name in widget_image::pic_store::list_groups() {
            assert!(!name.is_empty());
        }

        // 关键路径必须都落在数据目录下。
        for path in [
            paths::config_path(),
            paths::ledger_path(),
            paths::rate_cache_path(),
            paths::audio_root(),
            paths::pic_root(),
            paths::supplier_root(),
            paths::bubble_media_root(),
            paths::font_root(),
            paths::ort_dir(),
        ] {
            assert!(path.starts_with(&dir), "{}", path.display());
        }
    }
}

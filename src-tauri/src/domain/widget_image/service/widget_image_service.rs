//! 挂件图片组领域规则
//!
//! 命名与素材校验规则（与存储无关），文件读写见
//! `infrastructure::repository::widget_image::pic_store`。

use image::GenericImageView;

use crate::types::exception::{AppError, AppResult};

/// 默认挂件组名（对应内置资源，不走磁盘目录）。
pub const DEFAULT_BODY: &str = "小鲸鱼";

/// 单张图片最大边长（像素），超出直接拒绝，避免非法素材导致渲染异常。
pub const MAX_IMAGE_DIM: u32 = 8192;
/// 单张图片最大体积（字节）。
pub const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
/// 挂件组名长度上限（字符数）。
pub const MAX_NAME_LEN: usize = 64;

/// 校验挂件组名：去首尾空白，禁止路径分隔符 / `..` / 冒号，限制长度；
/// 默认组名使用内置资源，不可作为自定义组。
pub fn sanitize_group(name: &str) -> AppResult<String> {
    let n = name.trim();
    if n.is_empty() {
        return Err(AppError::invalid("挂件名称不能为空"));
    }
    if n.len() > MAX_NAME_LEN {
        return Err(AppError::invalid("挂件名称过长"));
    }
    if n.contains('/') || n.contains('\\') || n == "." || n == ".." || n.contains(':') {
        return Err(AppError::invalid("挂件名称包含非法字符"));
    }
    if n == DEFAULT_BODY {
        return Err(AppError::invalid("不能使用默认挂件名称"));
    }
    Ok(n.to_string())
}

/// 校验图片字节：非空、体积、可解码格式与尺寸范围。
///
/// 覆盖 PNG / JPEG / GIF / BMP / WebP 等主流格式；无法解码的文件直接拒绝，
/// 避免非法素材写入后在挂件端渲染异常。
pub fn validate_image_bytes(bytes: &[u8]) -> AppResult<()> {
    if bytes.is_empty() {
        return Err(AppError::invalid("图片数据为空"));
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(AppError::invalid(format!(
            "图片体积过大（{:.1}MB，上限 {}MB）",
            bytes.len() as f64 / 1_048_576.0,
            MAX_IMAGE_BYTES / 1_048_576
        )));
    }
    let img = image::load_from_memory(bytes)
        .map_err(|e| AppError::invalid(format!("图片格式不支持或文件已损坏：{}", e)))?;
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return Err(AppError::invalid("图片尺寸无效"));
    }
    if w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM {
        return Err(AppError::invalid(format!(
            "图片尺寸过大（{}×{}，单边上限 {} 像素）",
            w, h, MAX_IMAGE_DIM
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(w: u32, h: u32) -> image::DynamicImage {
        image::DynamicImage::ImageRgb8(image::RgbImage::new(w, h))
    }

    fn encode(img: &image::DynamicImage, format: image::ImageFormat) -> Vec<u8> {
        let mut out = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut out), format)
            .expect("编码测试图片应成功");
        out
    }

    #[test]
    fn sanitize_rule_set_matches_legacy() {
        assert!(sanitize_group("").is_err());
        assert!(sanitize_group("   ").is_err());
        assert!(sanitize_group("a/b").is_err());
        assert!(sanitize_group("a\\b").is_err());
        assert!(sanitize_group("a:b").is_err());
        assert!(sanitize_group("..").is_err());
        assert!(
            sanitize_group(DEFAULT_BODY).is_err(),
            "默认组名不可用于自定义组"
        );
        assert!(sanitize_group(&"超".repeat(MAX_NAME_LEN + 1)).is_err());
        assert_eq!(sanitize_group("  我的组 ").unwrap(), "我的组");

        // 错误文案（前端可见）。
        assert_eq!(
            sanitize_group("").unwrap_err().message(),
            "挂件名称不能为空"
        );
        assert_eq!(
            sanitize_group(DEFAULT_BODY).unwrap_err().message(),
            "不能使用默认挂件名称"
        );
    }

    #[test]
    fn validate_accepts_mainstream_formats() {
        for format in [
            image::ImageFormat::Png,
            image::ImageFormat::Jpeg,
            image::ImageFormat::Gif,
            image::ImageFormat::Bmp,
            image::ImageFormat::WebP,
        ] {
            let bytes = encode(&sample(64, 48), format);
            assert!(
                validate_image_bytes(&bytes).is_ok(),
                "应接受格式 {:?}",
                format
            );
        }
    }

    #[test]
    fn validate_accepts_non_square_and_transparency() {
        let rgba = image::DynamicImage::ImageRgba8(image::RgbaImage::new(300, 120));
        assert!(validate_image_bytes(&encode(&rgba, image::ImageFormat::Png)).is_ok());
    }

    #[test]
    fn validate_rejects_empty_invalid_and_oversize() {
        assert_eq!(
            validate_image_bytes(&[]).unwrap_err().message(),
            "图片数据为空"
        );
        assert!(validate_image_bytes(b"not an image at all").is_err());

        let big = encode(&sample(MAX_IMAGE_DIM + 1, 1), image::ImageFormat::Png);
        let err = validate_image_bytes(&big).expect_err("超限尺寸应被拒绝");
        assert!(
            err.message().contains("尺寸过大"),
            "错误信息应说明原因：{}",
            err.message()
        );
    }
}

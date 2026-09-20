//! Base64 / Data URL 工具
//!
//! 统一前后端之间的二进制传输格式（`data:<mime>;base64,<payload>`），
//! 并集中维护 MIME 推断规则，避免各处重复实现。

use base64::Engine as _;

use crate::types::exception::{AppError, AppResult};

/// 解码 base64 Data URL（兼容 `data:...;base64,` 前缀与纯 base64）。
///
/// `label` 用于拼装与历史一致的错误文案（如 `图片数据解码失败: ...`）。
pub fn decode_data_url(data: &str, label: &str) -> AppResult<Vec<u8>> {
    let payload = match data.find("base64,") {
        Some(idx) => &data[idx + 7..],
        None => data,
    };
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| AppError::invalid(format!("{}数据解码失败: {}", label, e)))
}

/// 按文件魔数推断图片 MIME（无法识别时按 PNG 处理，与历史行为一致）。
pub fn image_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") {
        "image/webp"
    } else {
        "image/png"
    }
}

/// 图片字节 → Data URL。
pub fn image_data_url(bytes: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{};base64,{}", image_mime(bytes), b64)
}

/// 按扩展名推断音频 MIME。
pub fn audio_mime(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" | "alac" => "audio/mp4",
        "aac" => "audio/aac",
        "wma" => "audio/x-ms-wma",
        "ape" => "audio/ape",
        "caf" => "audio/x-caf",
        _ => "application/octet-stream",
    }
}

/// 音频字节 → Data URL（MIME 由文件路径扩展名决定）。
pub fn audio_data_url(path: &str, bytes: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{};base64,{}", audio_mime(path), b64)
}

/// 按扩展名推断气泡媒体（图片 / 动图）MIME。
///
/// 覆盖前端允许上传的全部格式；无法识别时回落 `application/octet-stream`
/// （浏览器仍会按内容嗅探，动图不会被破坏）。
pub fn media_mime(path: &str) -> &'static str {
    let ext = extension_of(path);
    match ext.as_str() {
        "png" => "image/png",
        "apng" => "image/apng",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "mng" => "video/x-mng",
        "tif" | "tiff" => "image/tiff",
        "heic" | "heif" => "image/heic",
        "raw" => "image/x-raw",
        "psd" => "image/vnd.adobe.photoshop",
        _ => "application/octet-stream",
    }
}

/// 气泡媒体字节 → Data URL（保留原始字节，动图仍可播放）。
pub fn media_data_url(path: &str, bytes: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{};base64,{}", media_mime(path), b64)
}

/// 按扩展名推断字体 MIME（`@font-face` 的 format 由前端按同一张表给出）。
pub fn font_mime(path: &str) -> &'static str {
    match extension_of(path).as_str() {
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// 字体字节 → Data URL。
pub fn font_data_url(path: &str, bytes: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{};base64,{}", font_mime(path), b64)
}

/// 取小写扩展名（无扩展名时为空串）。
fn extension_of(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_url_roundtrip_accepts_prefix_and_raw_base64() {
        let raw = b"hello-audio";
        let encoded = base64::engine::general_purpose::STANDARD.encode(raw);
        let with_prefix = format!("data:audio/mpeg;base64,{}", encoded);
        assert_eq!(decode_data_url(&with_prefix, "音频").unwrap(), raw);
        assert_eq!(decode_data_url(&encoded, "音频").unwrap(), raw);
    }

    #[test]
    fn decode_failure_uses_caller_label() {
        let err = decode_data_url("!!!not-base64!!!", "图片").unwrap_err();
        assert!(
            err.message().starts_with("图片数据解码失败: "),
            "错误文案应与历史一致：{}",
            err.message()
        );
    }

    #[test]
    fn image_mime_sniffs_magic_numbers() {
        assert_eq!(image_mime(b"\x89PNG\r\n\x1a\n...."), "image/png");
        assert_eq!(image_mime(b"\xff\xd8\xff\xe0...."), "image/jpeg");
        assert_eq!(image_mime(b"GIF89a...."), "image/gif");
        assert_eq!(image_mime(b"GIF87a...."), "image/gif");
        assert_eq!(image_mime(b"RIFF....WEBP"), "image/webp");
        // 无法识别时回落 png（历史行为）。
        assert_eq!(image_mime(b"unknown"), "image/png");
    }

    #[test]
    fn audio_mime_maps_extensions_case_insensitively() {
        assert_eq!(audio_mime("C:/a/b/press.MP3"), "audio/mpeg");
        assert_eq!(audio_mime("press.wav"), "audio/wav");
        assert_eq!(audio_mime("press.opus"), "audio/ogg");
        assert_eq!(audio_mime("press.m4a"), "audio/mp4");
        assert_eq!(audio_mime("press.alac"), "audio/mp4");
        assert_eq!(audio_mime("press.caf"), "audio/x-caf");
        assert_eq!(audio_mime("press.unknown"), "application/octet-stream");
        assert_eq!(audio_mime("无扩展名"), "application/octet-stream");
    }

    #[test]
    fn data_url_builder_matches_payload() {
        let png = b"\x89PNG\r\n\x1a\n-data";
        let url = image_data_url(png);
        assert!(url.starts_with("data:image/png;base64,"));
        assert_eq!(decode_data_url(&url, "图片").unwrap(), png);

        let url = audio_data_url("x.flac", b"flac-data");
        assert!(url.starts_with("data:audio/flac;base64,"));
    }

    /// 气泡媒体的 MIME 按扩展名判定：动图 / SVG / 专业格式都不能被降级成 PNG。
    #[test]
    fn media_mime_covers_upload_formats() {
        assert_eq!(media_mime("a.PNG"), "image/png");
        assert_eq!(media_mime("a.gif"), "image/gif");
        assert_eq!(media_mime("a.apng"), "image/apng");
        assert_eq!(media_mime("a.webp"), "image/webp");
        assert_eq!(media_mime("a.svg"), "image/svg+xml");
        assert_eq!(media_mime("a.avif"), "image/avif");
        assert_eq!(media_mime("a.MNG"), "video/x-mng");
        assert_eq!(media_mime("a.heic"), "image/heic");
        assert_eq!(media_mime("a.psd"), "image/vnd.adobe.photoshop");
        assert_eq!(media_mime("a.unknown"), "application/octet-stream");
        // 动图字节原样保留（不会被重新编码）。
        let gif = b"GIF89a-animated";
        let url = media_data_url("a.gif", gif);
        assert!(url.starts_with("data:image/gif;base64,"));
        assert_eq!(decode_data_url(&url, "媒体").unwrap(), gif);
    }

    /// 字体 MIME 与 `@font-face` 的 format 一一对应。
    #[test]
    fn font_mime_covers_web_formats() {
        assert_eq!(font_mime("a.ttf"), "font/ttf");
        assert_eq!(font_mime("a.OTF"), "font/otf");
        assert_eq!(font_mime("a.woff"), "font/woff");
        assert_eq!(font_mime("a.woff2"), "font/woff2");
        assert_eq!(font_mime("a.exe"), "application/octet-stream");
        let url = font_data_url("x.woff2", b"woff2-data");
        assert!(url.starts_with("data:font/woff2;base64,"));
    }
}

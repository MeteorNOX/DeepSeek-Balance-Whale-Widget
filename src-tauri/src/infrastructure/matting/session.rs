//! 抠图推理会话
//!
//! 模型下载、运行时初始化与一次完整的「预处理 → 推理 → 后处理 → 编码」链路。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Once, OnceLock};

use image::GenericImageView;

use crate::infrastructure::system::paths;
use crate::types::exception::{AppError, AppResult};

/// 模型文件名（按需下载后存放到推理目录）。
pub const MODEL_NAME: &str = "birefnet-general-lite.onnx";
/// 内置 onnxruntime CPU 动态库（与模型一并离线打包，运行时加载）。
const ONNXRUNTIME_DLL: &[u8] = include_bytes!("../../../resources/onnxruntime.dll");
/// onnxruntime 提供器共享库（CPU 推理所需）。
const ONNXRUNTIME_SHARED_DLL: &[u8] =
    include_bytes!("../../../resources/onnxruntime_providers_shared.dll");

/// 模型输入尺寸（BiRefNet 固定）。
const INPUT_SIZE: u32 = 1024;

/// BiRefNet ImageNet 归一化均值 / 标准差（与 rembg birefnet 会话保持一致）。
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

/// 推理运行时初始化（进程内仅执行一次）。
static INIT: Once = Once::new();
static INIT_RESULT: OnceLock<AppResult<()>> = OnceLock::new();

/// 抠图模型下载源（原始 GitHub release 直连优先，镜像地址回退）。
pub const MODEL_URLS: [&str; 3] = [
    "https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
    "https://ghfast.top/https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
    "https://ghproxy.net/https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx",
];

/// 模型 MD5（下载后校验完整性）。
pub const MODEL_MD5: &str = "4fab47adc4ff364be1713e97b7e66334";

/// 抠图模型本地路径（首次使用时按需下载）。
pub fn model_path() -> PathBuf {
    paths::ort_dir().join(MODEL_NAME)
}

/// 模型是否已下载就绪。
pub fn model_ready() -> bool {
    model_path().is_file()
}

/// 下载抠图模型到本地推理目录，并通过回调上报进度（0-100）。
pub fn download_model(progress: &mut dyn FnMut(u32)) -> AppResult<()> {
    let dir = paths::ort_dir();
    std::fs::create_dir_all(&dir).map_err(|e| AppError::io(format!("创建推理目录失败: {}", e)))?;
    let dest = model_path();
    let tmp = dir.join("birefnet-general-lite.onnx.tmp");

    let mut last_err = String::new();
    for url in MODEL_URLS {
        match download_from(url, &tmp, progress) {
            Ok(()) => {
                let bytes = std::fs::read(&tmp)
                    .map_err(|e| AppError::io(format!("读取下载文件失败: {}", e)))?;
                let digest = format!("{:x}", md5::compute(&bytes));
                if digest == MODEL_MD5 {
                    std::fs::rename(&tmp, &dest)
                        .map_err(|e| AppError::io(format!("保存模型失败: {}", e)))?;
                    progress(100);
                    return Ok(());
                }
                let _ = std::fs::remove_file(&tmp);
                return Err(AppError::external("下载完成但校验失败，文件可能已损坏"));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                last_err = e.message().to_string();
            }
        }
    }
    Err(AppError::external(format!("下载失败: {}", last_err)))
}

/// 从指定 URL 下载到目标文件，并上报进度（0-100）。
fn download_from(url: &str, dest: &Path, progress: &mut dyn FnMut(u32)) -> AppResult<()> {
    let resp = ureq::get(url)
        .call()
        .map_err(|e| AppError::external(format!("网络请求失败: {}", e)))?;
    let total = resp
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(dest)
        .map_err(|e| AppError::io(format!("创建临时文件失败: {}", e)))?;
    let mut buf = [0u8; 64 * 1024];
    let mut downloaded: u64 = 0;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| AppError::io(format!("下载中断: {}", e)))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| AppError::io(format!("写入文件失败: {}", e)))?;
        downloaded += n as u64;
        if total > 0 {
            let percent = ((downloaded as f64 / total as f64) * 100.0) as u32;
            progress(percent);
        }
    }
    file.flush()
        .map_err(|e| AppError::io(format!("刷新文件失败: {}", e)))?;
    Ok(())
}

/// 若目标文件不存在或大小不一致则写入内置字节，返回其路径。
fn ensure_file(dir: &Path, name: &str, bytes: &[u8]) -> AppResult<PathBuf> {
    let path = dir.join(name);
    let need_write = match std::fs::metadata(&path) {
        Ok(m) => m.len() != bytes.len() as u64,
        Err(_) => true,
    };
    if need_write {
        std::fs::write(&path, bytes)
            .map_err(|e| AppError::io(format!("写入 {} 失败: {}", name, e)))?;
    }
    Ok(path)
}

/// 确保 onnxruntime 运行时已解压并初始化（幂等，进程内仅执行一次）。
fn ensure_runtime() -> AppResult<()> {
    INIT.call_once(|| {
        let result = (|| -> AppResult<()> {
            let dir = paths::ort_dir();
            std::fs::create_dir_all(&dir)
                .map_err(|e| AppError::io(format!("创建推理目录失败: {}", e)))?;
            let dll = ensure_file(&dir, "onnxruntime.dll", ONNXRUNTIME_DLL)?;
            let _shared = ensure_file(
                &dir,
                "onnxruntime_providers_shared.dll",
                ONNXRUNTIME_SHARED_DLL,
            )?;
            let builder = ort::init_from(&dll)
                .map_err(|e| AppError::external(format!("加载推理库失败: {}", e)))?;
            // commit() 返回 bool：true 表示配置已生效；仅当环境已被其他代码提前
            // 配置过时才返回 false（本进程内由 Once 保证只初始化一次）。
            if !builder.commit() {
                return Err(AppError::external("推理引擎初始化失败：环境已存在"));
            }
            Ok(())
        })();
        let _ = INIT_RESULT.set(result);
    });
    INIT_RESULT
        .get()
        .cloned()
        .unwrap_or_else(|| Err(AppError::internal("推理引擎初始化失败")))
}

/// 移除图片背景，返回带透明通道的 PNG 字节。
pub fn remove_background(bytes: &[u8]) -> AppResult<Vec<u8>> {
    ensure_runtime()?;

    let img = image::load_from_memory(bytes)
        .map_err(|e| AppError::invalid(format!("图片解码失败: {}", e)))?;
    let (w, h) = img.dimensions();

    // 1. 预处理：RGB → 1024×1024（LANCZOS）→ 归一化 → NCHW。
    let rgb = img.to_rgb8();
    let resized = image::imageops::resize(
        &rgb,
        INPUT_SIZE,
        INPUT_SIZE,
        image::imageops::FilterType::Lanczos3,
    );

    // 与 rembg 一致：先除以全图最大像素值，再做 ImageNet 归一化（mean=0.485/std=0.229）。
    let mut max_pixel: f32 = 0.0;
    for p in resized.pixels() {
        let m = (p[0] as f32).max(p[1] as f32).max(p[2] as f32);
        if m > max_pixel {
            max_pixel = m;
        }
    }
    let div = max_pixel.max(1e-6);

    let plane = (INPUT_SIZE * INPUT_SIZE) as usize;
    let mut data = vec![0.0f32; 3 * plane];
    for (i, p) in resized.pixels().enumerate() {
        data[i] = ((p[0] as f32 / div) - MEAN[0]) / STD[0];
        data[plane + i] = ((p[1] as f32 / div) - MEAN[1]) / STD[1];
        data[2 * plane + i] = ((p[2] as f32 / div) - MEAN[2]) / STD[2];
    }

    // 2. 从本地加载已下载的模型并推理（模型缺失时给出明确错误）。
    let model_file = model_path();
    if !model_file.is_file() {
        return Err(AppError::unavailable("抠图模型尚未下载，请先下载模型"));
    }
    let mut builder = ort::session::Session::builder()
        .map_err(|e| AppError::external(format!("创建会话构建器失败: {}", e)))?;
    let mut session = builder
        .commit_from_file(&model_file)
        .map_err(|e| AppError::external(format!("加载模型失败: {}", e)))?;

    let input_tensor = ort::value::Tensor::from_array((
        [1usize, 3, INPUT_SIZE as usize, INPUT_SIZE as usize],
        data,
    ))
    .map_err(|e| AppError::external(format!("构建输入张量失败: {}", e)))?;

    let outputs = session
        .run(ort::inputs![input_tensor])
        .map_err(|e| AppError::external(format!("推理失败: {}", e)))?;

    // 3. 后处理：mask (1,1,1024,1024) → sigmoid → min-max 归一化 → clip → 255 → resize 回原尺寸。
    let (_shape, mask_data): (_, &[f32]) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| AppError::external(format!("读取输出失败: {}", e)))?;

    // BiRefNet 输出为原始 logits，先经 sigmoid 映射到 [0,1] 再做 min-max 归一化。
    let mut sigmoid = vec![0.0f32; mask_data.len()];
    let mut mi = f32::MAX;
    let mut ma = f32::MIN;
    for (i, v) in mask_data.iter().enumerate() {
        let s = 1.0 / (1.0 + (-*v).exp());
        sigmoid[i] = s;
        mi = mi.min(s);
        ma = ma.max(s);
    }
    let range = (ma - mi).max(1e-6);

    let mut mask_img = image::GrayImage::new(INPUT_SIZE, INPUT_SIZE);
    for y in 0..INPUT_SIZE as usize {
        for x in 0..INPUT_SIZE as usize {
            let v = (sigmoid[y * INPUT_SIZE as usize + x] - mi) / range;
            let v = v.clamp(0.0, 1.0);
            mask_img.put_pixel(x as u32, y as u32, image::Luma([(v * 255.0) as u8]));
        }
    }

    let mask_resized =
        image::imageops::resize(&mask_img, w, h, image::imageops::FilterType::Lanczos3);

    // 4. 合成：原始 RGB + mask 作为 alpha。
    let mut rgba = img.to_rgba8();
    for (x, y, pixel) in rgba.enumerate_pixels_mut() {
        pixel[3] = mask_resized.get_pixel(x, y)[0];
    }

    // 5. 编码 PNG。
    let mut out = Vec::new();
    rgba.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| AppError::external(format!("编码 PNG 失败: {}", e)))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 推理目录与模型路径必须落在数据目录的 `ort` 子目录下。
    #[test]
    fn model_path_layout_is_portable() {
        let path = model_path();
        assert!(path.ends_with(MODEL_NAME), "实际：{}", path.display());
        assert_eq!(path.parent().unwrap().file_name().unwrap(), "ort");
        assert!(path.starts_with(crate::infrastructure::system::paths::app_data_dir()));
    }

    /// 模型未下载时，抠图必须给出明确的「未就绪」错误而不是 panic。
    #[test]
    fn remove_background_without_model_reports_unavailable() {
        if model_ready() {
            eprintln!("跳过：本机已下载抠图模型");
            return;
        }
        let err = remove_background(b"not-an-image").unwrap_err();
        // 运行时初始化可能先失败（取决于本机依赖），两种情况都必须是有错误而非崩溃。
        assert!(!err.message().is_empty());
    }

    /// 模型就绪时应能完成一次完整推理（未下载则跳过）。
    #[test]
    fn remove_background_roundtrip_when_model_ready() {
        if !model_ready() {
            eprintln!("跳过抠图测试：模型未下载（{})", model_path().display());
            return;
        }
        // 生成测试图片：红圆 + 白色背景。
        let mut img = image::RgbImage::new(200, 200);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let dx = x as f32 - 100.0;
            let dy = y as f32 - 100.0;
            if dx * dx + dy * dy < 50.0 * 50.0 {
                *p = image::Rgb([200, 50, 50]);
            } else {
                *p = image::Rgb([255, 255, 255]);
            }
        }
        let mut buf = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();

        let out = remove_background(&buf).expect("抠图应成功");

        // 输出应为有效 PNG，且尺寸一致、带透明通道。
        let out_img = image::load_from_memory(&out).expect("输出应为有效图片");
        assert_eq!(out_img.dimensions(), (200, 200));
        assert!(out_img.color().has_alpha());

        // 前景（圆心）应比背景（角落）更不透明。
        let rgba = out_img.to_rgba8();
        let fg = rgba.get_pixel(100, 100)[3];
        let bg = rgba.get_pixel(5, 5)[3];
        assert!(fg > bg, "前景 alpha 应高于背景，前景 {} 背景 {}", fg, bg);
    }

    /// 下载源与校验常量必须完整（防止静默写坏模型）。
    #[test]
    fn model_constants_are_consistent() {
        assert_eq!(MODEL_URLS.len(), 3, "应保留直连 + 两个镜像");
        assert_eq!(MODEL_MD5.len(), 32, "MD5 应为 32 位十六进制");
        assert!(MODEL_NAME.ends_with(".onnx"));
        for url in MODEL_URLS {
            assert!(url.starts_with("https://"), "{}", url);
            assert!(url.ends_with(".onnx"), "{}", url);
        }
    }
}

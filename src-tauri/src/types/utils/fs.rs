//! 文件系统工具
//!
//! 统一「原子写盘」与目录操作，避免各处重复实现（半写损坏是配置/账本类
//! 数据最典型的故障，必须只有一处实现）。

use std::fs;
use std::path::{Path, PathBuf};

use crate::types::exception::{AppError, AppResult};

/// 临时文件路径：`config.json` → `config.json.tmp`（与历史实现一致，便于排查残留）。
fn tmp_path(path: &Path) -> PathBuf {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("tmp")
        .to_string();
    path.with_extension(format!("{}.tmp", ext))
}

/// 原子写文件：先写临时文件，再整体替换，避免进程异常退出留下半写内容。
///
/// `on_write_fail` / `on_replace_fail` 由调用方提供错误文案构造函数，
/// 以便各业务保持自己原有的、面向用户的错误信息。
pub fn write_atomic(
    path: &Path,
    bytes: &[u8],
    on_write_fail: impl FnOnce(std::io::Error) -> AppError,
    on_replace_fail: impl FnOnce(std::io::Error) -> AppError,
) -> AppResult<()> {
    let tmp = tmp_path(path);
    fs::write(&tmp, bytes).map_err(on_write_fail)?;
    fs::rename(&tmp, path).map_err(on_replace_fail)?;
    Ok(())
}

/// 原子写文件（无自定义文案），错误使用系统原始描述。
pub fn write_atomic_plain(path: &Path, bytes: &[u8]) -> AppResult<()> {
    write_atomic(
        path,
        bytes,
        |e| AppError::io(e.to_string()),
        |e| AppError::io(e.to_string()),
    )
}

/// 读取文件全部字节；失败时错误文案为「读取<label>失败：<原因>」。
///
/// 供应用层读取用户选定文件使用，避免业务代码直接触碰文件系统。
pub fn read_bytes(path: &Path, label: &str) -> AppResult<Vec<u8>> {
    fs::read(path).map_err(|e| AppError::io(format!("读取{}失败：{}", label, e)))
}

/// 递归复制目录（用于旧数据整体迁移）。
pub fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// 校验目录可用：可创建且可写入（探测文件用后即删）。
pub fn dir_writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".dsw-write-probe");
    match fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 目录不存在或为空时返回 true。
pub fn is_dir_empty(dir: &Path) -> bool {
    match fs::read_dir(dir) {
        Ok(mut entries) => entries.next().is_none(),
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_dir(name: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("dsw-fs-test-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    /// 原子写盘：内容正确且不残留临时文件。
    #[test]
    fn write_atomic_replaces_content_without_leaving_tmp() {
        let dir = unique_dir("atomic");
        let file = dir.join("config.json");

        write_atomic_plain(&file, b"first").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"first".to_vec());

        write_atomic_plain(&file, b"second").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"second".to_vec());
        assert!(
            !dir.join("config.json.tmp").exists(),
            "替换后不应残留临时文件"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// 自定义文案：失败时对外错误信息由调用方决定。
    #[test]
    fn write_atomic_uses_caller_message() {
        let dir = unique_dir("msg");
        // 目标路径的父目录是文件而非目录 → 写入必然失败。
        let blocker = dir.join("blocker");
        fs::write(&blocker, b"x").unwrap();
        let err = write_atomic(
            &blocker.join("nested.json"),
            b"data",
            |e| AppError::io(format!("写入音效配置失败：{}", e)),
            |e| AppError::io(format!("保存音效配置失败：{}", e)),
        )
        .unwrap_err();
        assert!(
            err.message().starts_with("写入音效配置失败："),
            "错误文案应来自调用方：{}",
            err.message()
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// 读取字节：成功返回内容，失败文案由调用方 label 决定。
    #[test]
    fn read_bytes_reports_caller_label() {
        let dir = unique_dir("read");
        let file = dir.join("a.bin");
        fs::write(&file, b"payload").unwrap();
        assert_eq!(read_bytes(&file, "图片文件").unwrap(), b"payload".to_vec());

        let err = read_bytes(&dir.join("missing.bin"), "图片文件").unwrap_err();
        assert!(
            err.message().starts_with("读取图片文件失败："),
            "{}",
            err.message()
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dir_helpers_report_expected_state() {
        let dir = unique_dir("dirs");
        assert!(dir_writable(&dir));
        assert!(!dir.join(".dsw-write-probe").exists());
        assert!(is_dir_empty(&dir));

        fs::write(dir.join("a.txt"), b"x").unwrap();
        assert!(!is_dir_empty(&dir));

        // 不存在的目录视为空。
        assert!(is_dir_empty(&dir.join("missing")));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_dir_all_is_recursive() {
        let src = unique_dir("copy-src");
        let dst = src
            .parent()
            .unwrap()
            .join(format!("dsw-fs-test-{}-copy-dst", std::process::id()));
        let _ = fs::remove_dir_all(&dst);

        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("a.txt"), b"a").unwrap();
        fs::write(src.join("nested").join("b.txt"), b"b").unwrap();

        copy_dir_all(&src, &dst).unwrap();
        assert_eq!(fs::read(dst.join("a.txt")).unwrap(), b"a".to_vec());
        assert_eq!(
            fs::read(dst.join("nested").join("b.txt")).unwrap(),
            b"b".to_vec()
        );

        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dst);
    }
}

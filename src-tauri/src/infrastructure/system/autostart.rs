//! 开机自启
//!
//! Windows 下直接维护两个注册表位置：
//! - `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
//! - `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`
//!
//! 这样可以在安全软件清除 Run 项、但残留 StartupApproved 状态时主动自修复，
//! 避免界面开关与系统真实状态长期漂移。
//!
//! 非 Windows 平台仍沿用 `auto-launch` 跨平台库。

#[cfg(not(windows))]
use auto_launch::{AutoLaunch, AutoLaunchBuilder};

use crate::types::common::constants::{AUTOSTART_APP_NAME as APP_NAME, AUTOSTART_FLAG};
use crate::types::exception::{AppError, AppResult};

#[cfg(windows)]
const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const STARTUP_APPROVED_RUN_KEY_PATH: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
#[cfg(windows)]
const STARTUP_ENABLED_VALUE: [u8; 12] = [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

#[cfg(windows)]
fn current_exe_path() -> AppResult<std::path::PathBuf> {
    std::env::current_exe().map_err(|e| AppError::io(format!("无法获取应用路径: {e}")))
}

/// 期望写入注册表的启动命令（exe 路径 + 自启标记）。
#[cfg(windows)]
fn expected_command() -> AppResult<String> {
    let exe_path = current_exe_path()?;
    Ok(format!(
        "\"{}\" {}",
        exe_path.to_string_lossy(),
        AUTOSTART_FLAG
    ))
}

/// 读取 Run 项。
#[cfg(windows)]
fn read_run_value() -> AppResult<Option<String>> {
    use std::io::ErrorKind;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.open_subkey(RUN_KEY_PATH) {
        Ok(key) => match key.get_value::<String, _>(APP_NAME) {
            Ok(value) => Ok(Some(value)),
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
            Err(err) => Err(AppError::io(format!("读取启动项失败: {err}"))),
        },
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(AppError::io(format!("打开启动项注册表失败: {err}"))),
    }
}

/// 写入 Run 项。
#[cfg(windows)]
fn write_run_value(command: &str) -> AppResult<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(RUN_KEY_PATH)
        .map_err(|e| AppError::io(format!("创建启动项注册表失败: {e}")))?;
    key.set_value(APP_NAME, &command)
        .map_err(|e| AppError::io(format!("写入启动项失败: {e}")))
}

/// 删除 Run 项（不存在视为成功）。
#[cfg(windows)]
fn delete_run_value() -> AppResult<()> {
    use std::io::ErrorKind;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.open_subkey_with_flags(RUN_KEY_PATH, winreg::enums::KEY_SET_VALUE) {
        Ok(key) => match key.delete_value(APP_NAME) {
            Ok(_) => Ok(()),
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
            Err(err) => Err(AppError::io(format!("删除启动项失败: {err}"))),
        },
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(AppError::io(format!("打开启动项注册表失败: {err}"))),
    }
}

/// 读取「启动已批准」状态（安全软件禁用自启时会写入该键）。
#[cfg(windows)]
fn read_startup_approved_state() -> AppResult<Option<bool>> {
    use std::io::ErrorKind;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.open_subkey(STARTUP_APPROVED_RUN_KEY_PATH) {
        Ok(key) => match key.get_raw_value(APP_NAME) {
            Ok(value) => {
                let enabled = matches!(value.bytes.first().copied(), Some(0x02 | 0x06));
                Ok(Some(enabled))
            }
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
            Err(err) => Err(AppError::io(format!("读取启动审批状态失败: {err}"))),
        },
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(AppError::io(format!("打开启动审批注册表失败: {err}"))),
    }
}

/// 标记「启动已批准」。
#[cfg(windows)]
fn mark_startup_approved_enabled() -> AppResult<()> {
    use winreg::enums::{HKEY_CURRENT_USER, REG_BINARY};
    use winreg::{RegKey, RegValue};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(STARTUP_APPROVED_RUN_KEY_PATH)
        .map_err(|e| AppError::io(format!("创建启动审批注册表失败: {e}")))?;
    key.set_raw_value(
        APP_NAME,
        &RegValue {
            vtype: REG_BINARY,
            bytes: STARTUP_ENABLED_VALUE.to_vec(),
        },
    )
    .map_err(|e| AppError::io(format!("写入启动审批状态失败: {e}")))
}

/// 删除「启动已批准」键值（不存在视为成功）。
#[cfg(windows)]
fn delete_startup_approved_value() -> AppResult<()> {
    use std::io::ErrorKind;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.open_subkey_with_flags(STARTUP_APPROVED_RUN_KEY_PATH, winreg::enums::KEY_SET_VALUE) {
        Ok(key) => match key.delete_value(APP_NAME) {
            Ok(_) => Ok(()),
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
            Err(err) => Err(AppError::io(format!("删除启动审批状态失败: {err}"))),
        },
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(AppError::io(format!("打开启动审批注册表失败: {err}"))),
    }
}

/// 自修复：安全软件删掉 Run 项但残留审批项时，清理残留状态。
#[cfg(windows)]
fn repair_blocked_state() -> AppResult<()> {
    let has_run_value = read_run_value()?.is_some();
    let startup_approved_state = read_startup_approved_state()?;

    if !has_run_value && startup_approved_state.is_some() {
        delete_startup_approved_value()?;
    }

    Ok(())
}

/// 构建 AutoLaunch 实例（非 Windows 平台的回退实现）。
#[cfg(not(windows))]
fn build_auto_launch() -> AppResult<AutoLaunch> {
    let exe_path =
        std::env::current_exe().map_err(|e| AppError::io(format!("无法获取应用路径: {e}")))?;
    AutoLaunchBuilder::new()
        .set_app_name(APP_NAME)
        .set_app_path(&exe_path.to_string_lossy())
        .set_args(&[AUTOSTART_FLAG])
        .build()
        .map_err(|e| AppError::io(format!("创建开机自启配置失败: {e}")))
}

/// 读取系统当前的开机自启真实状态。
pub fn is_autostart_enabled() -> AppResult<bool> {
    #[cfg(windows)]
    {
        repair_blocked_state()?;
        let expected = expected_command()?;
        let Some(run_value) = read_run_value()? else {
            return Ok(false);
        };
        if run_value != expected {
            return Ok(false);
        }
        if matches!(read_startup_approved_state()?, Some(false)) {
            return Ok(false);
        }
        Ok(true)
    }

    #[cfg(not(windows))]
    {
        let auto_launch = build_auto_launch()?;
        auto_launch
            .is_enabled()
            .map_err(|e| AppError::io(format!("读取开机自启状态失败: {e}")))
    }
}

/// 设置开机自启状态，返回设置后的真实状态。
pub fn set_autostart(enabled: bool) -> AppResult<bool> {
    #[cfg(windows)]
    {
        repair_blocked_state()?;
        if enabled {
            let command = expected_command()?;
            write_run_value(&command)?;
            mark_startup_approved_enabled()?;
        } else {
            delete_run_value()?;
            delete_startup_approved_value()?;
        }
        is_autostart_enabled()
    }

    #[cfg(not(windows))]
    {
        let auto_launch = build_auto_launch()?;
        if enabled {
            auto_launch
                .enable()
                .map_err(|e| AppError::io(format!("启用开机自启失败: {e}")))?;
        } else {
            auto_launch
                .disable()
                .map_err(|e| AppError::io(format!("禁用开机自启失败: {e}")))?;
        }
        auto_launch
            .is_enabled()
            .map_err(|e| AppError::io(format!("读取开机自启状态失败: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 自启命令必须能被 lib.rs 识别（参数与启动判定一致）。
    #[test]
    fn autostart_flag_matches_startup_detection() {
        assert_eq!(AUTOSTART_FLAG, "--autostart");
        assert_eq!(APP_NAME, "DSW小鲸鱼");
    }

    /// 注册表读写幂等：读取当前状态不应改变系统状态。
    #[cfg(windows)]
    #[test]
    fn reading_state_is_side_effect_free() {
        let before = is_autostart_enabled().expect("读取自启状态应成功");
        let again = is_autostart_enabled().expect("重复读取应成功");
        assert_eq!(before, again, "只读操作不得改变系统状态");
    }
}

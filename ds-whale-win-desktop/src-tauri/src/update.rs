//! 版本检查模块
//!
//! 提供两个 Tauri 命令：
//! 1. `check_update`：请求远端版本清单，与当前编译版本比较。
//! 2. `open_external`：调用系统默认浏览器打开外链。

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

/// 远端版本清单地址。
const VERSION_URL: &str = "https://www.xiaolin.help/update/dswDesktopVersion.json";

/// 版本检查结果（前端读取 currentVersion / latestVersion / upToDate）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub up_to_date: bool,
}

/// 检查更新：请求远端版本清单，与当前版本字符串比较。
#[tauri::command]
pub async fn check_update() -> Result<UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {}", e))?;

    let resp = client
        .get(VERSION_URL)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("版本检查请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("版本检查请求失败: HTTP {}", resp.status().as_u16()));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("读取版本响应失败: {}", e))?;

    let latest_version = body
        .get("latestVersion")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "版本接口返回结构异常".to_string())?
        .to_string();

    let up_to_date = latest_version == current_version;

    Ok(UpdateCheckResult {
        current_version,
        latest_version,
        up_to_date,
    })
}

/// 用系统默认浏览器打开外部链接（Windows 下经 explorer 打开，规避 shell 特殊字符问题）。
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if url.trim().is_empty() {
        return Err("链接为空".to_string());
    }
    std::process::Command::new("explorer")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("打开浏览器失败: {}", e))?;
    Ok(())
}

//! Tauri 构建脚本
//!
//! 负责在编译期执行 Tauri 所需的资源与配置生成步骤。

/// 构建脚本入口：调用 `tauri_build` 完成编译期准备。
fn main() {
    tauri_build::build();

    // 前端资源是**编译期**嵌进二进制里的（tauri.conf.json 的 frontendDist），
    // 但它不在 Cargo 的依赖指纹里：只改前端文件时 Cargo 会认为 crate 无需重编，
    // 页面就会一直停留在旧资源上（表现为「改了前端却不生效」）。
    // 这里把 frontend 目录整棵树显式声明为构建依赖，保证改前端后必然重新编译并重新嵌入。
    watch_frontend();
}

/// 递归声明 `../frontend` 为构建依赖。
///
/// 逐文件声明而不是只声明目录：Cargo 对目录的变更检测依赖目录自身的时间戳，
/// 修改目录内已有文件不会改变它，必须逐个文件声明才可靠。
fn watch_frontend() {
    fn walk(dir: &std::path::Path) {
        println!("cargo:rerun-if-changed={}", dir.display());
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path);
            } else {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
    walk(std::path::Path::new("../frontend"));
}

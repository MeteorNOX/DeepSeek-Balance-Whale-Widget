// Windows 发布版不弹出控制台窗口（必须保留，勿删）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ds_desktop_whale_lib::run();
}

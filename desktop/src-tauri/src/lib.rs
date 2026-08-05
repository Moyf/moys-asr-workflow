// MOSE Tauri 应用入口。
//
// Week 2：server 级能力（IPC commands + Settings + tauri bridge）。
// - 构建时把 web/编辑器与 bridge 固化到 index.html
// - 注册 IPC commands：工程、设置、媒体、波形与表情包能力
// - tauri_bridge.js 把 web/editor.js 的 fetch 透明路由到 invoke

mod server;

use std::sync::Mutex;

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
use tauri::{Emitter, Manager, RunEvent};

use server::{
    extract_waveform, get_settings, open_project, open_project_at_path, pick_and_scan_stickers,
    pick_media, prepare_media, remember_project, resolve_media, save_project, settings_path,
    take_initial_project_path, update_settings, AppState, ServerSettings,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 1. 加载 settings
    let s_path = settings_path();
    let settings = ServerSettings::load(&s_path);

    // 启动 Tauri（注册 commands + dialog plugin + 共享状态）
    // 检查命令行参数（双击 .mosp 文件时 OS 传入路径）
    let init_file = std::env::args().nth(1).filter(|p| {
        let ext = std::path::Path::new(p)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        ext == "mosp" || ext == "json"
    });

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            initial_project_path: Mutex::new(init_file.map(std::path::PathBuf::from)),
            current_project_path: Mutex::new(None),
            settings: Mutex::new(settings),
            settings_path: s_path,
        })
        .invoke_handler(tauri::generate_handler![
            open_project,
            open_project_at_path,
            take_initial_project_path,
            get_settings,
            pick_media,
            save_project,
            remember_project,
            update_settings,
            resolve_media,
            prepare_media,
            pick_and_scan_stickers,
            extract_waveform,
        ])
        .build(tauri::generate_context!())
        .expect("MOSE 启动失败");

    app.run(|app_handle, event| {
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        if let RunEvent::Opened { urls } = event {
            for url in urls {
                let Ok(path) = url.to_file_path() else {
                    continue;
                };
                let is_project = path
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(|value| matches!(value.to_ascii_lowercase().as_str(), "mosp" | "json"))
                    .unwrap_or(false);
                if !is_project {
                    continue;
                }

                // Finder can deliver an Opened event before the webview has
                // installed its listener. Keep the path in state as well as
                // emitting the event so the frontend can consume either path.
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Ok(mut initial) = state.initial_project_path.lock() {
                        *initial = Some(path.clone());
                    }
                }
                let _ = app_handle.emit("open-file", path.to_string_lossy().into_owned());
                break;
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
        let _ = (app_handle, event);
    });
}

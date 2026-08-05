// MOSE Tauri 应用入口。
//
// Week 2：server 级能力（IPC commands + Settings + tauri bridge）。
// - 构建时把 web/编辑器与 bridge 固化到 index.html
// - 注册 IPC commands：工程、设置、媒体、波形与表情包能力
// - tauri_bridge.js 把 web/editor.js 的 fetch 透明路由到 invoke

mod server;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{Emitter, Manager};
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
use tauri::RunEvent;

use server::{
    extract_waveform, get_settings, open_project, open_project_at_path, pick_and_scan_stickers,
    pick_media, prepare_media, remember_project, resolve_media, save_project, settings_path,
    take_initial_project_path, update_settings, AppState, ServerSettings,
};

fn project_paths_from_args(args: &[String], cwd: &str) -> Vec<PathBuf> {
    args.iter()
        .filter_map(|arg| {
            let candidate = PathBuf::from(arg);
            let is_project = candidate
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| matches!(value.to_ascii_lowercase().as_str(), "mosp" | "json"))
                .unwrap_or(false);
            if !is_project {
                return None;
            }
            let path = if candidate.is_absolute() {
                candidate
            } else if cwd.is_empty() {
                candidate
            } else {
                Path::new(cwd).join(candidate)
            };
            Some(path.canonicalize().unwrap_or(path))
        })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 1. 加载 settings
    let s_path = settings_path();
    let settings = ServerSettings::load(&s_path);

    // 启动 Tauri（注册 commands + dialog plugin + 共享状态）
    // 检查命令行参数（双击 .mosp 文件时 OS 传入路径）。不要假定
    // 工程一定是 nth(1)：启动器/打包器可能会在它前面附加参数。
    let init_files: Vec<PathBuf> = std::env::args().skip(1).find(|p| {
        let ext = std::path::Path::new(p)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        matches!(ext.as_str(), "mosp" | "json")
    }).map(PathBuf::from).into_iter().collect();

    let app = tauri::Builder::default()
        // The plugin must be registered first so a second launch is forwarded
        // before any other plugin handles its command-line arguments.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = project_paths_from_args(&argv, &cwd);
            if let Some(state) = app.try_state::<AppState>() {
                for path in &paths {
                    state.queue_project_path(path.clone());
                }
            }
            for path in paths {
                let _ = app.emit("open-file", path.to_string_lossy().into_owned());
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            initial_project_path: Mutex::new(init_files),
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
                    state.queue_project_path(path.clone());
                }
                let _ = app_handle.emit("open-file", path.to_string_lossy().into_owned());
                break;
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
        let _ = (app_handle, event);
    });
}

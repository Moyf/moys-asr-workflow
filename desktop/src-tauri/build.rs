use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const BLANK_DATA: &str = r#"{"segments":[],"media":"","language":"","model":""}"#;
const BLANK_MEDIA_HTML: &str =
    r#"<audio id="player" preload="metadata" style="width:100%;display:block;"></audio>"#;
const SERVER_CONFIG: &str = r#"{"saveUrl":"mose://save-project","canSave":false,"recentProjectsUrl":"mose://recent-projects","settingsUrl":"mose://settings","recentProjects":[],"autoOpenLastProject":true,"savedWorkspaces":{},"presetWorkspaces":{},"activeWorkspaceName":""}"#;

fn read(path: &Path) -> String {
    fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("无法读取 {}：{}", path.display(), error))
}

fn replace_all(page: &mut String, replacements: &[(&str, &str)]) {
    for (token, value) in replacements {
        *page = page.replace(token, value);
    }
}

fn editor_script_manifest(web_dir: &Path) -> Vec<String> {
    let manifest_path = web_dir.join("editor-scripts.txt");
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for (line_number, raw_line) in read(&manifest_path).lines().enumerate() {
        let entry = raw_line.split('#').next().unwrap_or("").trim();
        if entry.is_empty() {
            continue;
        }
        let path = Path::new(entry);
        if path.file_name().and_then(|value| value.to_str()) != Some(entry)
            || path.extension().and_then(|value| value.to_str()) != Some("js")
        {
            panic!(
                "无效的编辑器脚本清单项（第 {} 行）：{}",
                line_number + 1,
                entry
            );
        }
        if !seen.insert(entry.to_string()) {
            panic!(
                "编辑器脚本清单存在重复项（第 {} 行）：{}",
                line_number + 1,
                entry
            );
        }
        if !web_dir.join(entry).is_file() {
            panic!("编辑器脚本清单项不存在：{}", entry);
        }
        entries.push(entry.to_string());
    }
    if entries.is_empty() {
        panic!("编辑器脚本清单为空：{}", manifest_path.display());
    }
    entries
}

fn read_editor_scripts(web_dir: &Path) -> String {
    editor_script_manifest(web_dir)
        .into_iter()
        .map(|entry| read(&web_dir.join(entry)))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn render_frontend() {
    let manifest_dir =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR 未设置"));
    let repository_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("无法定位 MAW 仓库根目录");
    let web_dir = repository_root.join("web");
    let mut page = read(&web_dir.join("editor-template.html"));
    let bridge = read(&manifest_dir.join("src").join("tauri_bridge.js"));
    let editor_css = read(&web_dir.join("editor.css"));
    let waveform_css = read(&web_dir.join("waveform.css"));
    let editor_scripts = read_editor_scripts(&web_dir);

    replace_all(
        &mut page,
        &[
            ("__EDITOR_CSS__", editor_css.as_str()),
            ("__WAVEFORM_CSS__", waveform_css.as_str()),
            ("__EDITOR_SCRIPTS_JS__", editor_scripts.as_str()),
            ("__DATA_JSON__", BLANK_DATA),
            ("__SERVER_CONFIG_JSON__", SERVER_CONFIG),
            ("__FILENAME_BASE_JSON__", r#""untitled""#),
            ("__STICKERS_JSON__", "[]"),
            ("__STICKER_ROOT_JSON__", r#""""#),
            ("__STICKER_URL_PREFIX_JSON__", r#""""#),
            ("__UI_LANGUAGE_JSON__", "null"),
            ("__TITLE__", "MOSE — Moy's Open Subtitle Editor"),
            ("__MEDIA_HTML__", BLANK_MEDIA_HTML),
            ("__GENERATED_AT__", ""),
            ("__JSON_DISPLAY__", "未加载工程"),
            ("__JSON_NAME_CLASS__", "empty"),
            ("__MEDIA_NAME_DISPLAY__", "未加载媒体"),
            ("__MEDIA_NAME_TITLE__", ""),
            ("__MEDIA_NAME_CLASS__", "empty"),
        ],
    );
    page = page.replace(
        "</body>",
        &format!("<script>\n{}\n</script>\n</body>", bridge),
    );

    let output_dir = manifest_dir
        .parent()
        .expect("无法定位 desktop 目录")
        .join("src");
    fs::create_dir_all(&output_dir).expect("无法创建 desktop/src");
    fs::write(output_dir.join("index.html"), page).expect("无法写入 desktop/src/index.html");

    println!("cargo:rerun-if-changed={}", web_dir.display());
    println!(
        "cargo:rerun-if-changed={}",
        web_dir.join("editor-scripts.txt").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("src").join("tauri_bridge.js").display()
    );
}

fn main() {
    render_frontend();
    tauri_build::build()
}

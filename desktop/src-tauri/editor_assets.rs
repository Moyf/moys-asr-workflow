//! Ordered source assets shared by the portable, server and desktop editors.
use std::collections::HashSet;
use std::fs;
use std::path::Path;

fn valid_entry(entry: &str) -> bool {
    !entry.contains(['\\', ':'])
        && entry.ends_with(".js")
        && entry
            .split('/')
            .all(|part| !matches!(part, "" | "." | ".."))
}

pub fn editor_script_manifest(web_dir: &Path) -> Result<Vec<String>, String> {
    let root = web_dir.canonicalize().map_err(|error| error.to_string())?;
    let manifest =
        fs::read_to_string(root.join("editor-scripts.txt")).map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for (index, raw_line) in manifest.lines().enumerate() {
        let entry = raw_line.split('#').next().unwrap_or("").trim();
        if entry.is_empty() {
            continue;
        }
        if !valid_entry(entry) {
            return Err(format!(
                "Invalid editor script manifest entry at line {}: {entry}",
                index + 1
            ));
        }
        if !seen.insert(entry.to_string()) {
            return Err(format!("Duplicate editor script manifest entry: {entry}"));
        }
        let path = root
            .join(entry)
            .canonicalize()
            .map_err(|_| format!("Editor script manifest entry does not exist: {entry}"))?;
        if !path.starts_with(&root) {
            return Err(format!(
                "Editor script manifest entry escapes web directory: {entry}"
            ));
        }
        if !path.is_file() {
            return Err(format!(
                "Editor script manifest entry is not a file: {entry}"
            ));
        }
        entries.push(entry.to_string());
    }
    if entries.is_empty() {
        return Err("Editor script manifest is empty".to_string());
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root =
                std::env::temp_dir().join(format!("maw-manifest-{}-{unique}", std::process::id()));
            fs::create_dir_all(root.join("editor/boot")).unwrap();
            fs::write(root.join("editor/boot/start.js"), "const start = true;\n").unwrap();
            fs::write(root.join("editor.js"), "const entry = true;\n").unwrap();
            Self(root)
        }
        fn manifest(&self, text: &str) -> Result<Vec<String>, String> {
            fs::write(self.0.join("editor-scripts.txt"), text).unwrap();
            editor_script_manifest(&self.0)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn shared_path_cases() {
        for line in include_str!("../../tests/fixtures/editor_manifest_cases.txt").lines() {
            let (expected, entry) = line.split_once(' ').unwrap();
            assert_eq!(valid_entry(entry), expected == "ok", "{entry}");
        }
    }

    #[test]
    fn nested_sources_preserve_order_and_comments() {
        let fixture = Fixture::new();
        assert_eq!(
            fixture
                .manifest("# order\neditor/boot/start.js # boot\n\neditor.js\n")
                .unwrap(),
            vec!["editor/boot/start.js", "editor.js"]
        );
    }

    #[test]
    fn rejects_empty_duplicate_missing_and_directory_entries() {
        let fixture = Fixture::new();
        for manifest in ["# empty\n", "editor.js\neditor.js\n", "missing.js\n"] {
            assert!(fixture.manifest(manifest).is_err(), "{manifest}");
        }
        fs::create_dir(fixture.0.join("directory.js")).unwrap();
        assert!(fixture.manifest("directory.js\n").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let fixture = Fixture::new();
        let outside = Fixture::new();
        std::os::unix::fs::symlink(outside.0.join("editor.js"), fixture.0.join("escape.js"))
            .unwrap();
        assert!(fixture
            .manifest("escape.js\n")
            .unwrap_err()
            .contains("escapes"));
    }
}

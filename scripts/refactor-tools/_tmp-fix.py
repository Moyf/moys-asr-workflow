// 契约更新：manifest 元组替换为实际清单 + sticker_rel 断言重指向。
import fs from "node:fs";
import { execSync } from "node:child_process";
const manifest = execSync('uv run --no-sync python -c "import sys;sys.path.insert(0,\'..\');import edit;print(\'\\n\'.join(edit.read_editor_script_manifest()))"',
  { encoding: "utf8", cwd: path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..") });
import path from "node:path";

"""
MAW 模型下载工作子进程 —— 由 maw/model_downloader.py 的 start_download 启动。
可用 proc.kill() 强制终止。
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path


def run_download(key: str, info_path: str) -> int:
    """执行模型下载流程。返回 0 成功，1 失败。"""
    try:
        with open(info_path, "r") as f:
            info = json.load(f)

        dest = Path(info["local_dir"])
        dest.mkdir(parents=True, exist_ok=True)

        source = info.get("source", "modelscope")

        if source == "modelscope":
            from modelscope.hub.snapshot_download import snapshot_download
            snapshot_download(model_id=info["model_id"], cache_dir=str(dest))

            for p in Path(dest).rglob("config.json"):
                src_dir = p.parent
                if src_dir != dest:
                    for f in src_dir.iterdir():
                        shutil.copy2(str(f), str(dest / f.name))
                    print(f"[download] moved files from {src_dir}", flush=True)
                    break

            for sub in list(dest.iterdir()):
                if sub.is_dir() and not sub.name.startswith("."):
                    try:
                        from send2trash import send2trash
                        send2trash(str(sub))
                    except Exception:
                        print(f"[download] WARNING: 无法删除临时目录 {sub.name}，请手动清理", flush=True)
                    print(f"[download] cleaned {sub.name}", flush=True)
        else:
            os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
            from huggingface_hub import snapshot_download
            snapshot_download(
                repo_id=info["model_id"],
                local_dir=str(dest),
                resume_download=True,
            )
        print("[download] OK", flush=True)
        # 写入文件清单（用于完整性校验）
        manifest = {}
        for f in dest.rglob("*"):
            if f.is_file() and f.name != ".download_ok" and f.name != "manifest.json":
                manifest[str(f.relative_to(dest))] = f.stat().st_size
        (dest / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        # 写入完成标记
        (dest / ".download_ok").write_text("ok", encoding="utf-8")
        return 0
    except Exception as e:
        print(f"[download] FAILED: {e}", flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(run_download(sys.argv[1], sys.argv[2]))

"""
MAW 模型下载工作子进程
由 web-console/server.py 的 _start_download 启动，可被 proc.kill() 取消。
"""
import sys, os, json, shutil
from pathlib import Path

key = sys.argv[1]
info_path = sys.argv[2]

with open(info_path, "r") as f:
    info = json.load(f)

dest = Path(info["local_dir"])
dest.mkdir(parents=True, exist_ok=True)

source = info.get("source", "modelscope")

try:
    if source == "modelscope":
        from modelscope.hub.snapshot_download import snapshot_download
        snapshot_download(model_id=info["model_id"], cache_dir=str(dest))
        # 文件迁移：modelscope 的 cache_dir 会创建嵌套目录
        for p in Path(dest).rglob("config.json"):
            src_dir = p.parent
            if src_dir != dest:
                for f in src_dir.iterdir():
                    shutil.copy2(str(f), str(dest / f.name))
                print(f"[download] moved files from {src_dir}", flush=True)
                break
        # 清理嵌套缓存（P0-5: 使用 send2trash 移入回收站）
        for sub in list(dest.iterdir()):
            if sub.is_dir() and not sub.name.startswith("."):
                try:
                    from send2trash import send2trash
                    send2trash(str(sub))
                    print(f"[download] sent redundant dir to trash: {sub.name}", flush=True)
                except Exception:
                    import shutil
                    shutil.rmtree(sub, ignore_errors=False)
                    print(f"[download] removed redundant dir: {sub.name}", flush=True)
    else:
        os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
        from huggingface_hub import snapshot_download
        snapshot_download(
            repo_id=info["model_id"],
            local_dir=str(dest),
            resume_download=True,
        )
    print("[download] OK", flush=True)
    sys.exit(0)
except Exception as e:
    print(f"[download] FAILED: {e}", flush=True)
    sys.exit(1)

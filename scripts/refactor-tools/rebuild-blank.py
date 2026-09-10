# 会话内专用：blank-editor.html 被外部查看器句柄锁住时，先删旧 inode 再重建。
import os, subprocess, sys
p = 'blank-editor.html'
if os.path.exists(p): os.remove(p)
sys.exit(subprocess.call(['uv', 'run', 'python', 'edit.py', '--blank']))

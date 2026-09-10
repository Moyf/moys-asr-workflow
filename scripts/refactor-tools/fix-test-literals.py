# 一次性辅助：测试里 assertIn 钉住的实现字面量随拆分合法变化后，
# 按模块导出表自动把缺失字面量改写为「命名空间前缀」后的新形态。
# 只有当改写后的字面量真实存在于重建页面时才写入测试文件；其余人工处理。
import ast
import re
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import edit  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"

# 1. 从各拆分模块的 freeze 块导出 name -> namespace
name_ns = {}
for mod in WEB.glob("editor-*.js"):
    text = mod.read_text(encoding="utf-8")
    m = re.search(r"global\.(\w+) = Object\.freeze\(\{(.*?)\n  \}\);", text, re.S)
    if not m:
        continue
    ns, block = m.group(1), m.group(2)
    for line in block.splitlines():
        shorthand = re.match(r"\s{4}(\w+),?$", line)
        accessor = re.match(r"\s{4}get (\w+)\(", line)
        name = shorthand.group(1) if shorthand else (accessor.group(1) if accessor else None)
        if name:
            name_ns[name] = ns

page = edit.build_blank_html()

# 2. 逐个测试文件修正 assertIn 缺失字面量
# server-align 测试断言的是对齐页（独立页面），不能拿编辑器页面当参照。
EXCLUDE_TESTS = {"test_server_align.py"}
for test_file in sorted((ROOT / "tests").glob("test_*.py")):
    if test_file.name in EXCLUDE_TESTS:
        continue
    source = test_file.read_text(encoding="utf-8")
    tree = ast.parse(source)
    literals = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "assertIn":
            if node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                literals.append((node.args[0].lineno, node.args[0].value))
    changed = 0
    missing = []
    for lineno, lit in literals:
        if lit in page:
            continue
        fixed = lit
        for name, ns in name_ns.items():
            fixed = re.sub(rf"(?<![\w.$]){name}(?![\w$])", f"{ns}.{name}", fixed)
        if fixed != lit and fixed in page:
            source = source.replace(lit, fixed)
            changed += 1
        else:
            missing.append((lineno, lit))
    if changed or missing:
        test_file.write_text(source, encoding="utf-8", newline="\n")
    print(f"{test_file.name}: 自动修正 {changed} 处；需人工 {len(missing)} 处")
    for lineno, lit in missing:
        print(f"  行{lineno}: {lit[:90]}")

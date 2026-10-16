"""Generate or refresh a standalone verification checklist; no server required."""

import argparse
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import tempfile


TEMPLATE = Path(__file__).parent / "templates" / "verification-checklist.html"
SOURCE_SCHEMA = "maw.verification-checklist.source.v1"


def object_fields(value, required, optional, path):
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected an object")
    missing = set(required) - value.keys()
    unknown = value.keys() - set(required) - set(optional)
    if missing:
        raise ValueError(f"{path}: missing fields: {', '.join(sorted(missing))}")
    if unknown:
        raise ValueError(f"{path}: unknown fields: {', '.join(sorted(unknown))}")


def text_field(value, path, allow_empty=False):
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ValueError(f"{path}: expected {'a string' if allow_empty else 'a non-empty string'}")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError(f"{path}: invalid Unicode surrogate") from error
    if "\0" in value:
        raise ValueError(f"{path}: NUL characters cannot be represented in HTML")
    return value


def array_field(value, path, allow_empty=False):
    if not isinstance(value, list) or (not allow_empty and not value):
        raise ValueError(f"{path}: expected {'an array' if allow_empty else 'a non-empty array'}")
    return value


def source_sections(source):
    """Validate the JSON authoring contract and render only escaped text."""
    object_fields(source, ("schema", "title", "subtitle", "sections"), (), "source")
    if source["schema"] != SOURCE_SCHEMA:
        raise ValueError(f"source.schema: expected {SOURCE_SCHEMA} (authoring data, not exported results)")
    text_field(source["title"], "source.title")
    text_field(source["subtitle"], "source.subtitle", allow_empty=True)
    # Reserve static template IDs and names inherited by the template's JS state objects.
    template_ids = ChecklistValidator()
    template_ids.validate(TEMPLATE.read_text(encoding="utf-8"))
    ids = template_ids.ids | {
        "constructor", "toString", "toLocaleString", "valueOf", "hasOwnProperty",
        "isPrototypeOf", "propertyIsEnumerable",
    }

    def stable_id(value, path):
        text_field(value, path)
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", value):
            raise ValueError(f"{path}: use an ASCII letter followed by letters, digits, '_' or '-'")
        if value in ids or value.startswith("checklist-note-"):
            raise ValueError(f"{path}: duplicate or reserved id: {value}")
        ids.add(value)
        return value

    def escaped(value, path):
        return html.escape(text_field(value, path))

    def prose(value, path, allow_empty=False):
        return html.escape(text_field(value, path, allow_empty=allow_empty)).replace("\n", "<br>")

    sections = []
    fields_by_type = {
        "text": ("text",), "note": ("text",), "command": ("text",),
        "list": ("items",), "table": ("headers", "rows"),
        "check": ("id", "entry", "action", "expected"),
    }
    for index, section in enumerate(array_field(source["sections"], "source.sections")):
        path = f"source.sections[{index}]"
        object_fields(section, ("id", "title", "blocks"), ("badge", "open"), path)
        section_id = stable_id(section["id"], f"{path}.id")
        title = escaped(section["title"], f"{path}.title")
        opened = section.get("open", True)
        if not isinstance(opened, bool):
            raise ValueError(f"{path}.open: expected a boolean")
        badge = ""
        if "badge" in section:
            value = section["badge"]
            object_fields(value, ("kind", "text"), (), f"{path}.badge")
            if value["kind"] not in ("pass", "fixed", "todo"):
                raise ValueError(f"{path}.badge.kind: expected pass, fixed or todo")
            badge = f'<span class="badge {value["kind"]}">{escaped(value["text"], f"{path}.badge.text")}</span>'
        blocks = []
        for block_index, block in enumerate(array_field(section["blocks"], f"{path}.blocks")):
            block_path = f"{path}.blocks[{block_index}]"
            if not isinstance(block, dict) or not isinstance(block.get("type"), str):
                raise ValueError(f"{block_path}.type: expected a block type")
            kind = block["type"]
            if kind not in fields_by_type:
                raise ValueError(f"{block_path}.type: unknown block type: {kind}")
            optional = ("ordered",) if kind == "list" else ()
            object_fields(block, ("type", *fields_by_type[kind]), optional, block_path)
            if kind in ("text", "note"):
                css = "plain" if kind == "text" else "note"
                blocks.append(f'<p class="{css}">{prose(block["text"], f"{block_path}.text")}</p>')
            elif kind == "command":
                # A code child prevents HTML's pre parser from dropping a leading newline.
                blocks.append(f'<pre class="cmd"><code>{escaped(block["text"], f"{block_path}.text")}</code></pre>')
            elif kind == "list":
                ordered = block.get("ordered", False)
                if not isinstance(ordered, bool):
                    raise ValueError(f"{block_path}.ordered: expected a boolean")
                tag = "ol" if ordered else "ul"
                items = [f'<li>{prose(item, f"{block_path}.items[{i}]")}</li>'
                         for i, item in enumerate(array_field(block["items"], f"{block_path}.items"))]
                blocks.append(f'<{tag} class="plain">{"".join(items)}</{tag}>')
            elif kind == "table":
                headers = array_field(block["headers"], f"{block_path}.headers")
                cells = [f'<th scope="col">{escaped(cell, f"{block_path}.headers[{i}]")}</th>'
                         for i, cell in enumerate(headers)]
                rows = []
                for row_index, row in enumerate(array_field(block["rows"], f"{block_path}.rows", allow_empty=True)):
                    row_path = f"{block_path}.rows[{row_index}]"
                    array_field(row, row_path)
                    if len(row) != len(headers):
                        raise ValueError(f"{row_path}: expected {len(headers)} cells")
                    values = [f'<td>{prose(cell, f"{row_path}[{i}]", allow_empty=True)}</td>'
                              for i, cell in enumerate(row)]
                    rows.append(f'<tr>{"".join(values)}</tr>')
                blocks.append('<div style="overflow-x:auto"><table><thead><tr>' + "".join(cells)
                              + '</tr></thead><tbody>' + "".join(rows) + '</tbody></table></div>')
            else:
                item_id = stable_id(block["id"], f"{block_path}.id")
                label = " → ".join(prose(block[key], f"{block_path}.{key}")
                                   for key in ("entry", "action", "expected"))
                blocks.append(f'<div class="item"><input type="checkbox" id="{item_id}">'
                              f'<label for="{item_id}">{label}</label></div>')
        sections.append(f'<details class="section" id="{section_id}"' + (' open' if opened else '')
                        + f'><summary><span class="sec-title">{title}</span>{badge}</summary>'
                        + '<div class="body">' + "\n".join(blocks) + '</div></details>')
    return "\n".join(sections)


def render_source(source):
    sections = source_sections(source)
    return render(source["title"], source["subtitle"], sections)


def unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON field: {key}")
        result[key] = value
    return result


# === Markdown 源格式（v1）：与 JSON 同一 source 契约的便携载体，可贴 PR 评论 ===

MD_FRONT_KEYS = ("task", "pr", "date", "status", "updated")
MD_FRONT_STATUS = ("pending", "partial", "passed")
MD_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
MD_SECTION_ID_RE = re.compile(r"^<!-- id: ([A-Za-z][A-Za-z0-9_-]*) -->$")
MD_BADGE_RE = re.compile(r"^<!-- badge: (pass|fixed|todo) (.+?) -->$")
MD_CHECK_RE = re.compile(r"^- \[([ xX])\] \*\*(.+?)\*\*：(.+)$")
MD_CHECK_TRAILING_ID_RE = re.compile(r"<!-- id: ([A-Za-z][A-Za-z0-9_-]*) -->\s*$")
MD_HEADING_SPLIT_RE = re.compile(r"^(\d+)\. (.+)$")


def validate_front_matter(meta, path_label="front-matter"):
    """校验 --meta 与 MD front-matter 共用的元数据字段（status 为追踪核心）。"""
    unknown = set(meta) - set(MD_FRONT_KEYS)
    if unknown:
        raise ValueError(f"{path_label} 未知字段: {', '.join(sorted(unknown))}")
    if "status" not in meta:
        raise ValueError(f"{path_label} 缺少 status（pending / partial / passed）")
    if meta["status"] not in MD_FRONT_STATUS:
        raise ValueError(f"{path_label}.status: expected one of {MD_FRONT_STATUS}")
    if "pr" in meta and not re.fullmatch(r"\d+", meta["pr"]):
        raise ValueError(f"{path_label}.pr: expected an integer")
    for key in ("date", "updated"):
        if key in meta and not MD_DATE_RE.fullmatch(meta[key]):
            raise ValueError(f"{path_label}.{key}: expected YYYY-MM-DD")
    return meta


def parse_front_matter(text):
    """拆出文件头部的扁平 key: value front-matter；没有时返回 (None, 原文)。"""
    if not text.startswith("---\n"):
        return None, text
    head, separator, body = text[4:].partition("\n---\n")
    if not separator:
        raise ValueError("front-matter 未闭合：缺少收尾的 --- 行")
    meta = {}
    for line in head.splitlines():
        if not line.strip():
            continue
        key, colon, value = line.partition(":")
        if not colon:
            raise ValueError(f"front-matter 行无效（需要 key: value）: {line!r}")
        if key.strip() in meta:
            raise ValueError(f"front-matter 重复字段: {key.strip()}")
        meta[key.strip()] = value.strip()
    validate_front_matter(meta)
    return meta, body


def escape_markdown_paragraph(text):
    """段落是普通行；行首恰好是列表/引用/标题/围栏标记时转义，避免被读成块。"""
    if text.startswith("- "):
        return "\\- " + text[2:]
    numbered = MD_HEADING_SPLIT_RE.match(text)
    if numbered:
        return f"{numbered.group(1)}\\. {numbered.group(2)}"
    if re.match(r"^(>|#|```)", text):
        return "\\" + text
    return text


def unescape_markdown_paragraph(text):
    if text.startswith("\\- "):
        return "- " + text[3:]
    numbered = re.match(r"^(\d+)\\. ", text)
    if numbered:
        return f"{numbered.group(1)}. " + text[numbered.end():]
    for marker in ("\\> ", "\\# ", "\\```"):
        if text.startswith(marker):
            return text[1:]
    return text


def parse_markdown_source(text):
    """把 Markdown 源格式还原为 source 契约 dict（front-matter 单独返回）。"""
    meta, body = parse_front_matter(text)
    title = subtitle = None
    sections, current = [], None
    list_items = list_context = None
    table_start = table_lines = None
    fence_open = command_lines = None

    def flush_list():
        nonlocal list_items, list_context
        if list_items is not None:
            block = {"type": "list", "items": list_items}
            if list_context:
                block["ordered"] = True
            current["blocks"].append(block)
            list_items = None

    def flush_table():
        nonlocal table_lines
        if table_lines is not None:
            if len(table_lines) < 2 or not re.fullmatch(r"\|(\s*:?-+:?\s*\|)+", table_lines[1]):
                raise ValueError(f"第 {table_start} 行: 表格第二行必须是 | --- | 分隔行")
            headers = split_markdown_row(table_lines[0])
            rows = [split_markdown_row(line) for line in table_lines[2:]]
            for row in rows:
                if len(row) != len(headers):
                    raise ValueError(f"第 {table_start} 行: 表格行单元格数与表头不一致")
            current["blocks"].append({"type": "table", "headers": headers, "rows": rows})
            table_lines = None

    def flush_command():
        nonlocal command_lines
        if command_lines is not None:
            current["blocks"].append({"type": "command", "text": "\n".join(command_lines)})
            command_lines = None

    def flush_all():
        flush_list()
        flush_table()
        flush_command()

    for line_no, raw in enumerate(body.splitlines(), start=1):
        line = raw.rstrip()
        if fence_open:
            if line.strip() == "```":
                flush_command()
                fence_open = None
            else:
                command_lines.append(raw)
            continue
        if line.strip().startswith("```"):
            stripped = line.strip()
            flush_all()
            if len(stripped) > 6 and stripped.endswith("```"):
                current["blocks"].append({"type": "command", "text": stripped[3:-3]})
                continue
            fence_open = True
            command_lines = []
            continue
        if not line.strip():
            flush_all()
            continue
        if line.startswith("## "):
            flush_all()
            current = {"id": None, "title": line[3:].strip(), "blocks": []}
            sections.append(current)
            continue
        if current is None:
            if line.startswith("# "):
                if title is not None:
                    raise ValueError(f"第 {line_no} 行: 出现第二个 H1 标题")
                title = line[2:].strip()
                continue
            if line.startswith(">"):
                if subtitle is not None:
                    raise ValueError(f"第 {line_no} 行: 出现第二行副标题")
                subtitle = line[1:].strip()
                continue
            raise ValueError(f"第 {line_no} 行: 标题区之外无法解析的内容")
        if current["id"] is None:
            section_id = MD_SECTION_ID_RE.match(line.strip())
            if section_id:
                current["id"] = section_id.group(1)
                continue
        badge = MD_BADGE_RE.match(line.strip())
        if badge:
            current["badge"] = {"kind": badge.group(1), "text": badge.group(2)}
            continue
        check = MD_CHECK_RE.match(line)
        if check:
            flush_all()
            entry, tail = check.group(2), check.group(3)
            id_match = MD_CHECK_TRAILING_ID_RE.search(tail)
            if not id_match:
                raise ValueError(f"第 {line_no} 行: check 行结尾缺少 <!-- id: stable-id -->")
            rest = tail[:id_match.start()].rstrip()
            action, separator, expected = rest.partition("；预期：")
            if not separator:
                raise ValueError(f"第 {line_no} 行: check 行缺少「；预期：」分隔")
            for name, value in (("entry", entry), ("action", action), ("expected", expected)):
                if "**" in value or "<!--" in value:
                    raise ValueError(f"第 {line_no} 行: check {name} 不能包含 ** 或 <!--")
            if "；预期：" in action:
                raise ValueError(f"第 {line_no} 行: check action 不能包含「；预期：」分隔符")
            current["blocks"].append({"type": "check", "id": id_match.group(1),
                "entry": entry.strip(), "action": action.strip(), "expected": expected.strip()})
            continue
        if line.startswith("| "):
            flush_list()
            flush_command()
            if table_lines is None:
                table_start = line_no
                table_lines = []
            table_lines.append(line)
            continue
        numbered = MD_HEADING_SPLIT_RE.match(line)
        if line.startswith("- ") or numbered:
            flush_table()
            flush_command()
            item = numbered.group(2).strip() if numbered else line[2:].strip()
            ordered = bool(numbered)
            if list_items is None or list_context != ordered:
                flush_list()
                list_items, list_context = [], ordered
            list_items.append(item)
            continue
        flush_all()
        current["blocks"].append({"type": "note", "text": unescape_markdown_paragraph(line.strip())})
    flush_all()
    if title is None:
        raise ValueError("缺少 `# 页面标题`（H1）")
    if subtitle is None:
        raise ValueError("缺少 `> 副标题` 行")
    if not sections:
        raise ValueError("没有 `## ` 分区")
    for index, section in enumerate(sections):
        if section["id"] is None:
            raise ValueError(f"分区 {section['title']!r} 缺少 <!-- id: stable-id --> 注释")
    return meta, {"schema": SOURCE_SCHEMA, "title": title, "subtitle": subtitle,
                  "sections": sections}


def split_markdown_row(line):
    body = line.strip().removeprefix("|").removesuffix("|")
    return [cell.replace("\\|", "|").strip() for cell in re.split(r"(?<!\\)\|", body)]


def source_to_markdown(source, meta=None):
    """把 source 契约转成 Markdown 源格式；meta 提供时写入 front-matter。"""
    if meta is not None:
        validate_front_matter(meta)
    for key in ("title", "subtitle"):
        if "\n" in str(source.get(key, "")):
            raise ValueError(f"source.{key}: MD v1 标题与副标题必须是单行")
    lines = []
    if meta:
        lines.append("---")
        lines.extend(f"{key}: {meta[key]}" for key in MD_FRONT_KEYS if key in meta)
        lines.extend(("---", ""))
    lines.extend((f"# {source['title']}", "", f"> {source['subtitle']}", ""))
    for section in source["sections"]:
        if section.get("open") is False:
            raise ValueError(f"分区 {section['title']!r}: MD v1 不支持折叠分区（去掉 open: false）")
        lines.append(f"## {section['title']}")
        lines.append(f"<!-- id: {section['id']} -->")
        badge = section.get("badge")
        if badge:
            lines.append(f"<!-- badge: {badge['kind']} {badge['text']} -->")
        lines.append("")
        for block in section["blocks"]:
            kind = block["type"]
            if kind == "note":
                if "\n" in block["text"]:
                    raise ValueError(f"note {block['text'][:24]!r}: MD v1 说明必须是单行（其余拆成多条）")
                lines.extend((escape_markdown_paragraph(block["text"]), ""))
            elif kind == "command":
                if "```" in block["text"]:
                    raise ValueError("command 文本不能包含 ``` 围栏")
                lines.extend(("```", block["text"], "```", ""))
            elif kind == "list":
                marker = "1." if block.get("ordered") else "-"
                lines.extend((f"{marker} {item}" for item in block["items"]))
                lines.append("")
            elif kind == "table":
                def escape_cell(cell):
                    return str(cell).replace("|", "\\|")
                for cell in [cell for row in block["rows"] for cell in row] + list(block["headers"]):
                    if "\n" in str(cell):
                        raise ValueError("表格单元格不能包含换行")
                lines.append("| " + " | ".join(escape_cell(cell) for cell in block["headers"]) + " |")
                lines.append("| " + " | ".join(["---"] * len(block["headers"])) + " |")
                for row in block["rows"]:
                    lines.append("| " + " | ".join(escape_cell(cell) for cell in row) + " |")
                lines.append("")
            elif kind == "check":
                for name in ("entry", "action", "expected"):
                    value = str(block[name])
                    if "**" in value or "<!--" in value or "\n" in value:
                        raise ValueError(f"check {block['id']} 的 {name} 不能包含 **、<!-- 或换行")
                if "；预期：" in str(block["action"]):
                    raise ValueError(f"check {block['id']} 的 action 不能包含「；预期：」分隔符")
                lines.append(f"- [ ] **{block['entry']}**：{block['action']}；预期：{block['expected']}"
                             f" <!-- id: {block['id']} -->")
            else:
                raise ValueError(f"MD v1 暂不支持块类型: {kind}（text 块请改用 note）")
        lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"


def load_authoring_data(path):
    """读取 JSON 或 Markdown 授权数据；返回 (front_matter|None, source)。"""
    text = path.read_text(encoding="utf-8-sig")
    if path.suffix.lower() == ".json":
        return None, json.loads(text, object_pairs_hook=unique_json_object)
    if path.suffix.lower() == ".md":
        return parse_markdown_source(text)
    raise ValueError(f"不支持的清单数据格式: {path.name}（.json 或 .md）")


def parse_meta_args(pairs):
    if not pairs:
        return None
    meta = {}
    for pair in pairs:
        key, separator, value = pair.partition("=")
        if not separator or not key.strip() or not value.strip():
            raise ValueError(f"--meta 需要 KEY=VALUE: {pair!r}")
        if key.strip() in meta:
            raise ValueError(f"--meta 重复字段: {key.strip()}")
        meta[key.strip()] = value
    return meta


def scan_checklists(root):
    """汇总目录下全部 *.checklist.md 的 front-matter 状态与勾选进度。"""
    files = sorted(root.rglob("*.checklist.md"))
    if not files:
        return [f"未找到 *.checklist.md：{root}"]
    rows = []
    for path in files:
        try:
            meta, body = parse_front_matter(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as error:
            rows.append(f"{'invalid':>8}  {path}：{error}")
            continue
        meta = meta or {}
        checked = sum(1 for line in body.splitlines() if line.startswith("- [x]"))
        unchecked = sum(1 for line in body.splitlines() if line.startswith("- [ ]"))
        display = path.relative_to(root) if path.is_relative_to(root) else path
        rows.append(f"{meta.get('status', '—'):>8}  {checked}/{checked + unchecked:<3}  "
                    f"pr={meta.get('pr', '—'):<6} {meta.get('task', '—'):<26} {display}")
    return rows


def write_page(output, content):
    """Replace a page only after its complete UTF-8 content has been written."""
    encoded = content.encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, prefix=f".{output.name}.",
                                         suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(encoded)
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class ChecklistValidator(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.checkboxes = []
        self.labels = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        item_id = attrs.get("id")
        if item_id:
            if item_id in self.ids:
                raise ValueError(f"Duplicate HTML id: {item_id}")
            self.ids.add(item_id)
        if tag == "input" and attrs.get("type") == "checkbox":
            if not item_id:
                raise ValueError("Every checkbox needs a stable, unique id")
            self.checkboxes.append(item_id)
        if tag == "label" and attrs.get("for"):
            self.labels.add(attrs["for"])

    def validate(self, content):
        self.feed(content)
        missing = set(self.checkboxes) - self.labels
        if missing:
            raise ValueError(f"Checkboxes missing labels: {', '.join(sorted(missing))}")


def render(title, subtitle, sections, heading=None):
    values = {"TITLE": html.escape(title), "SUBTITLE": html.escape(subtitle), "SECTIONS": sections.strip()}
    template = TEMPLATE.read_text(encoding="utf-8")
    # One pass: inserted content is never treated as another template placeholder.
    result = re.sub(r"\{\{(TITLE|SUBTITLE|SECTIONS)\}\}", lambda match: values[match[1]], template)
    if heading is not None:
        result = result.replace(f"<h1>{values['TITLE']}</h1>", f"<h1>{heading}</h1>", 1)
    ChecklistValidator().validate(result)
    return result


def extract_page(content):
    patterns = {
        "title": r"<title>(.*?)</title>",
        "heading": r"<h1>(.*?)</h1>",
        "subtitle": r'<div class="sub">(.*?)</div>',
        "sections": r'<main class="content">(.*?)</main>',
    }
    fields = {}
    for name, pattern in patterns.items():
        match = re.search(pattern, content, re.DOTALL)
        if not match:
            raise ValueError(f"Cannot refresh: missing template field {name}")
        fields[name] = match[1]
    fields["title"] = html.unescape(fields["title"])
    fields["subtitle"] = html.unescape(fields["subtitle"])
    fields["sections"] = fields["sections"].strip()
    return fields


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, help="UTF-8 JSON/Markdown checklist authoring data")
    parser.add_argument("--check", type=Path, help="Validate a JSON/Markdown checklist without writing output")
    parser.add_argument("--to-md", type=Path, dest="to_md",
                        help="Convert a JSON checklist into the Markdown source format")
    parser.add_argument("--meta", action="append", default=[], metavar="KEY=VALUE",
                        help="Front-matter for --to-md: task/pr/date/status/updated")
    parser.add_argument("--scan", type=Path, help="Summarize *.checklist.md status under a directory")
    parser.add_argument("--title", help="Plain-text page title (also the persistence identity)")
    parser.add_argument("--subtitle", help="Plain-text scope and verification context")
    parser.add_argument("--sections", type=Path, help="UTF-8 HTML containing the section cards")
    parser.add_argument("--output", type=Path, help="Output HTML/MD; defaults to refresh input")
    parser.add_argument("--refresh", type=Path, help="Apply latest template to an existing checklist")
    args = parser.parse_args(argv)
    try:
        if args.scan:
            if any(value is not None for value in (args.data, args.check, args.to_md, args.refresh,
                                                   args.title, args.subtitle, args.sections, args.output)) \
                    or args.meta:
                parser.error("--scan cannot be combined with other generation flags")
            print("\n".join(scan_checklists(args.scan)))
            return
        if args.check:
            if any(value is not None for value in (args.data, args.to_md, args.refresh, args.title,
                                                   args.subtitle, args.sections, args.output)) or args.meta:
                parser.error("--check cannot be combined with other generation flags")
            _, source = load_authoring_data(args.check)
            source_sections(source)
            print(f"Checklist OK: {args.check}")
            return
        if args.to_md:
            if any(value is not None for value in (args.data, args.check, args.refresh, args.title,
                                                   args.subtitle, args.sections)):
                parser.error("--to-md cannot be combined with other generation flags")
            if args.to_md.suffix.lower() != ".json":
                raise ValueError("--to-md 输入必须是 .json")
            if args.output is None:
                parser.error("--to-md requires --output")
            if args.output.resolve() == args.to_md.resolve():
                parser.error("Output must not overwrite the JSON source")
            meta = parse_meta_args(args.meta)
            source = json.loads(args.to_md.read_text(encoding="utf-8-sig"),
                                object_pairs_hook=unique_json_object)
            source_sections(source)
            write_page(args.output, source_to_markdown(source, meta))
            print(f"Updated checklist: {args.output}")
            return
        if args.data:
            if any(value is not None for value in (args.refresh, args.title, args.subtitle, args.sections)) \
                    or args.meta:
                parser.error("--data cannot be combined with --refresh, --title, --subtitle, --sections or --meta")
            if args.output is None:
                parser.error("JSON/Markdown generation requires --output")
            if args.output.suffix.lower() == ".md":
                parser.error("--data 生成 HTML 时 --output 请使用 .html（导出 MD 请用 --to-md）")
            _, source = load_authoring_data(args.data)
            result = render_source(source)
            output = args.output
        elif args.refresh:
            if any(value is not None for value in (args.title, args.subtitle, args.sections)):
                parser.error("--refresh cannot be combined with --title, --subtitle or --sections")
            fields = extract_page(args.refresh.read_text(encoding="utf-8"))
            result = render(**fields)
            output = args.output or args.refresh
        else:
            if any(value is None for value in (args.title, args.subtitle, args.sections, args.output)):
                parser.error("Generation requires --title, --subtitle, --sections and --output")
            result = render(args.title, args.subtitle, args.sections.read_text(encoding="utf-8"))
            output = args.output
        if output.resolve() == TEMPLATE.resolve():
            parser.error("Output must not overwrite the template")
        if args.sections and output.resolve() == args.sections.resolve():
            parser.error("Output must not overwrite the sections source")
        if args.data and output.resolve() == args.data.resolve():
            parser.error("Output must not overwrite the JSON source")
        write_page(output, result)
        print(f"Updated checklist: {output}")
    except (OSError, ValueError) as error:
        parser.exit(1, f"Checklist error: {error}\n")


if __name__ == "__main__":
    main()

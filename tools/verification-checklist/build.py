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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, help="UTF-8 JSON checklist authoring data")
    parser.add_argument("--title", help="Plain-text page title (also the persistence identity)")
    parser.add_argument("--subtitle", help="Plain-text scope and verification context")
    parser.add_argument("--sections", type=Path, help="UTF-8 HTML containing the section cards")
    parser.add_argument("--output", type=Path, help="Output HTML; defaults to refresh input")
    parser.add_argument("--refresh", type=Path, help="Apply latest template to an existing checklist")
    args = parser.parse_args()
    try:
        if args.data:
            if any(value is not None for value in (args.refresh, args.title, args.subtitle, args.sections)):
                parser.error("--data cannot be combined with --refresh, --title, --subtitle or --sections")
            if args.output is None:
                parser.error("JSON generation requires --output")
            source = json.loads(args.data.read_text(encoding="utf-8-sig"), object_pairs_hook=unique_json_object)
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

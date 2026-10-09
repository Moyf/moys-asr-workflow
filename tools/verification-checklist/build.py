"""Generate or refresh a standalone verification checklist; no server required."""

import argparse
import html
from html.parser import HTMLParser
from pathlib import Path
import re


TEMPLATE = Path(__file__).parent / "templates" / "verification-checklist.html"


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
    parser.add_argument("--title", help="Plain-text page title (also the persistence identity)")
    parser.add_argument("--subtitle", help="Plain-text scope and verification context")
    parser.add_argument("--sections", type=Path, help="UTF-8 HTML containing the section cards")
    parser.add_argument("--output", type=Path, help="Output HTML; defaults to refresh input")
    parser.add_argument("--refresh", type=Path, help="Apply latest template to an existing checklist")
    args = parser.parse_args()
    try:
        if args.refresh:
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
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(result, encoding="utf-8", newline="\n")
        print(f"Updated checklist: {output}")
    except (OSError, ValueError) as error:
        parser.exit(1, f"Checklist error: {error}\n")


if __name__ == "__main__":
    main()

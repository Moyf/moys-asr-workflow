"""Render an offline comparison from two MOSP/JSON project snapshots."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from maw.postprocess_comparison import comparison_data, render_comparison
from maw.postprocess_io import _atomic_write, read_project


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before", type=Path)
    parser.add_argument("after", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--operation", default="AI 处理")
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    if output in {args.before.resolve(), args.after.resolve()} or output.suffix.lower() != ".html":
        parser.error("output must be a separate .html file")
    _atomic_write(output, render_comparison(comparison_data(read_project(args.before), read_project(args.after), args.operation)))
    print(output)


if __name__ == "__main__":
    main()

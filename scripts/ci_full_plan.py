"""Dedicated v1 full-inspection plan. Never used for PR/main blocking selection."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess

VERSION = 1
PROFILES = ("full",)
SHA = re.compile(r"[0-9a-f]{40}")
BROWSER_FILES = {"full": []}


def plan(profile, reason, *, base="", head="", trusted=False):
    if profile != "full":
        raise ValueError("auxiliary inspection requires full coverage")
    return {"version": VERSION, "mode": "full", "profile": "full", "light": False,
            "reason": reason, "base": base, "head": head, "trusted_diff": trusted}


def main():
    if __package__:
        from .ci_acceptance import inventory
    else:
        from ci_acceptance import inventory
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=Path('.artifacts/auxiliary/ci-plan.json'))
    args = parser.parse_args()
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode('ascii').strip()
    if not SHA.fullmatch(head):
        raise ValueError('invalid checkout HEAD')
    value = plan('full', 'scheduled or explicitly requested full inspection', head=head)
    args.plan.parent.mkdir(parents=True, exist_ok=True)
    args.plan.write_text(json.dumps(value) + '\n', encoding='utf-8', newline='\n')
    (args.plan.parent / 'inventory.json').write_text(json.dumps(inventory(), indent=2) + '\n',
                                                  encoding='utf-8', newline='\n')
    with Path(os.environ['GITHUB_OUTPUT']).open('a', encoding='utf-8', newline='\n') as stream:
        stream.write(f'mode=full\nplan={json.dumps(value)}\nhead={head}\n')


if __name__ == '__main__':
    main()

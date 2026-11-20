"""Run an auxiliary layer with the preparation available in this CI job."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

if __package__:
    from .ci_inputs import auxiliary_flags
else:
    from ci_inputs import auxiliary_flags


def unavailable_preparation(steps, requirements):
    return {name for name, step in requirements.items()
            if steps.get(step, {}).get('outcome') != 'success'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--layer', choices=('python', 'node', 'browser'), required=True)
    parser.add_argument('--plan', default='.artifacts/auxiliary/plan.json')
    parser.add_argument('--report-dir', required=True)
    parser.add_argument('--shard', default='1/1', help='browser shard CURRENT/TOTAL')
    args = parser.parse_args(argv)
    steps = json.loads(os.environ['CI_PREPARATION'])
    plan = json.loads(Path(args.plan).read_text(encoding='utf-8'))
    flags = auxiliary_flags(plan)
    node = flags['node'] or flags['browser'] or flags['application']
    preparation = {
        'node-runtime': ('node', node),
        'node-dependencies': ('js_install', node),
        'python-dependencies': ('py_install', flags['python_dependencies']),
        'ffmpeg': ('ffmpeg', flags['real_media']),
        'chromium': ('chromium', flags['browser'] or flags['node_browser']),
        'build': ('build_editor', flags['editor_bundle']),
        'build-launcher': ('build_launcher', flags['launcher_bundle']),
        'website': ('website_build', flags['website']),
    }
    # A skipped optional step gives no evidence that the capability is absent.
    required = {name: step for name, (step, selected) in preparation.items()
                if selected or steps.get(step, {}).get('outcome') == 'failure'}
    unavailable = unavailable_preparation(steps, required)
    venv = Path('.venv/Scripts/python.exe' if os.name == 'nt' else '.venv/bin/python')
    # POSIX venv executables are symlinks. Keep the venv entry point.
    python = str(venv.absolute()) if steps.get('py_install', {}).get('outcome') == 'success' else sys.executable
    env = {**os.environ, 'MAW_TEST_PYTHON': python, 'MAW_E2E_PYTHON': python}
    command = [python, 'scripts/test_workflow.py', '--stage', 'merge', '--selection-plan', args.plan,
               '--layer', args.layer, '--report-dir', args.report_dir, '--shard', args.shard]
    for preparation in sorted(unavailable):
        command.extend(('--blocked-preparation', preparation))
    return subprocess.run(command, env=env, check=False).returncode


if __name__ == '__main__':
    raise SystemExit(main())

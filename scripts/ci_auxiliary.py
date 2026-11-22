"""Prepare the unadmitted, impact-selected tests for separate CI feedback."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

if __package__:
    from . import ci_acceptance
    from .ci_inputs import auxiliary_flags
    from .local_test_impact import select_packs
else:
    import ci_acceptance
    from ci_inputs import auxiliary_flags
    from local_test_impact import select_packs


def auxiliary_plan(blocking: dict, *, impact=None, validated=False) -> dict:
    if not validated:
        ci_acceptance.validate_plan(blocking)
    if not blocking['trusted_diff']:
        return {'mode': 'targeted', 'packs': [], 'python_tests': [], 'node_tests': [], 'e2e_specs': [],
                'tools_scope': 'all', 'preparation': {}, 'head': blocking['head'],
                'reasons': ['Untrusted diff: auxiliary tests require manual selection.']}
    impact = impact if impact is not None else select_packs(blocking['paths'], base_ref=blocking['base'])
    if impact['mode'] == 'full':
        return {'mode': 'targeted', 'packs': [], 'python_tests': [], 'node_tests': [], 'e2e_specs': [],
                'tools_scope': 'all', 'preparation': {}, 'head': blocking['head'],
                'reasons': ['Impact is not narrow enough for automatic auxiliary selection; review manually.']}
    # A method-level admission does not cover its whole file. Only subtract
    # complete files actually selected in this admission plan.
    admitted_python = {target for check in blocking['checks'] for target in ci_acceptance.PYTHON.get(check, [])
                       if target.endswith('.py')}
    admitted_node = {target for check in blocking['checks'] for target in ci_acceptance.NODE.get(check, [])}
    return {**impact, 'head': blocking['head'],
            'python_tests': [p for p in impact['python_tests'] if p not in admitted_python],
            'node_tests': [p for p in impact['node_tests'] if p not in admitted_node]}


def write_plan(plan: dict, output: Path) -> None:
    specs = plan['e2e_specs']
    # A job already uses two Playwright workers. Keep a pair in one job.
    groups = [specs] if specs else []
    if len(specs) > 2:
        groups = [specs[::2], specs[1::2]]
    plan = {**plan, 'browser_file_groups': groups}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(plan, ensure_ascii=True, indent=2) + '\n', encoding='utf-8', newline='\n')
    values = auxiliary_flags(plan)
    if output := os.environ.get('GITHUB_OUTPUT'):
        with Path(output).open('a', encoding='utf-8', newline='\n') as stream:
            for name, value in values.items():
                stream.write(f'aux_{name}={str(value).lower()}\n')
            browser_shards = '[1,2]' if len(groups) == 2 else '[1]'
            stream.write(f'aux_browser_shards={browser_shards}\n')
            stream.write('aux_error=false\n')
    message = 'Targeted auxiliary scope: ' + ', '.join(
        f'{layer}={len(plan[field])}' for layer, field in
        (('Python', 'python_tests'), ('Node', 'node_tests'), ('browser', 'e2e_specs')))
    print(message)
    print('; '.join(plan['reasons']))
    if summary := os.environ.get('GITHUB_STEP_SUMMARY'):
        with Path(summary).open('a', encoding='utf-8') as stream:
            stream.write(message + '\n\n' + '; '.join(plan['reasons']) + '\n')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--blocking-plan', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    write_plan(auxiliary_plan(json.loads(args.blocking_plan.read_text(encoding='utf-8'))), args.output)


if __name__ == '__main__':
    main()

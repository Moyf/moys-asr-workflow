"""Informational Chinese CI summaries. Never decides whether tests passed."""
from __future__ import annotations

import argparse
import html
import json
import os
from pathlib import Path
import re

MAX_REPORT = 32 * 1024 * 1024
MAX_ITEMS = 12
# Exact identifiers/titles only. These describe intent, never the failure cause.
DESCRIPTIONS = {
    "test_prproj_generation_route_refuses_without_writing": (
        "拒绝不支持的 PRPROJ 导出请求", "返回不支持状态，且不写工程文件"),
    "long compact checklist preserves 15px text and bounded layout across breakpoints": (
        "长核验清单在不同主题和窗口宽度下显示", "文字可读、正文保持 15px，布局不横向溢出"),
    "shows disabled secondary export entries when bilingual mode has no second track": (
        "双语模式下没有副字幕轨", "副字幕导出入口保持禁用"),
}


def description(identity):
    # Python IDs include module/class; Playwright title paths use this separator.
    candidates = {identity, identity.rsplit('.', 1)[-1], *identity.split(' › ')}
    return next((value for key, value in DESCRIPTIONS.items() if key in candidates), None)


def safe(value, limit=1600):
    """Treat report text as text, not Markdown/HTML or workflow commands."""
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', str(value))
    text = ''.join(c for c in text if c in '\n\t' or ord(c) >= 32 and ord(c) != 127)
    text = re.sub(r'(?i)[A-Z]:[\\/]Users[\\/][^\\/\s]+', '<用户目录>', text)
    text = re.sub(r'/(?:home|Users)/[^/\s]+', '<用户目录>', text)
    if len(text) > limit:
        text = text[:limit] + '\n…（已截断，完整内容见日志）'
    return html.escape(text)


def load(path):
    if path.stat().st_size > MAX_REPORT:
        raise ValueError('报告超过摘要读取上限')
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError('报告不是对象')
    return value


def python_issues(report):
    details = report.get('failure_details')
    if not isinstance(details, list):
        raise ValueError('缺少逐项失败详情，不能据此判断没有失败')
    return [(item['id'], item['kind'], item['message']) for item in details]


def browser_issues(report):
    if not isinstance(report.get('suites'), list) or not isinstance(report.get('stats'), dict):
        raise ValueError('缺少浏览器测试结果')
    issues = []

    def walk(suites, parents=()):
        for suite in suites:
            titles = parents + (suite.get('title', ''),)
            for spec in suite.get('specs', []):
                for test in spec.get('tests', []):
                    results = test.get('results', [])
                    bad = [r for r in results if r.get('status') not in ('passed', 'skipped') or r.get('errors')]
                    if bad or test.get('status') in ('unexpected', 'flaky') or not results:
                        messages = []
                        for result in bad:
                            messages.extend(e.get('message', str(e)) for e in result.get('errors', []))
                            if not result.get('errors'):
                                messages.append('执行状态：' + str(result.get('status')))
                        title = ' › '.join((*titles, spec.get('title', ''), test.get('projectName', '')))
                        location = f"{spec.get('file', '?')}:{spec.get('line', '?')}"
                        issues.append((title, location, '\n'.join(messages) or '没有完整结果，请查看原始报告。'))
            walk(suite.get('suites', []), titles)
    walk(report['suites'])
    for error in report.get('errors', []):
        issues.append(('测试运行器错误', '全局错误', error.get('message', str(error))))
    return issues


def render(kind, label, outcome, paths, needs=None, role='standard'):
    lines = [f'## CI 检查说明：<code>{safe(label, 200)}</code>', '',
             f'执行步骤状态：<code>{safe(outcome, 80)}</code>。本文仅辅助读取，不改变执行结果或报告校验。',
             '这里只描述本次执行集合，不推断 GitHub 分支保护或远端必需检查配置。', '']
    if role == 'advisory':
        status = {'failure': '本次完整巡检验收失败，失败保持原状。',
                  'cancelled': '本次完整巡检验收被取消，不能视为完成。',
                  'skipped': '本次完整巡检验收未执行，不能视为完成。'}.get(
                      outcome, '本次完整巡检验收状态以上方执行结果为准。')
        lines += [status,
                  '这是辅助（advisory）结果，不传播到 Change acceptance；不是全仓通过的声明，相关异常仍需 review。', '']
    if kind == 'python':
        lines += ['--required 是测试运行器的严格执行集合约束，不代表 GitHub 远端必需状态或合并要求。', '']
    if kind == 'gate':
        lines += ['这是本次执行集合的汇总验收，不是另一组测试。上游失败会导致本次验收失败；',
                  '报告缺失、被取消或校验失败也不能认定本次验收通过，不能简单当作新增产品故障。', '']
        for key, value in (needs or {}).items():
            lines.append(f'- <code>{safe(key, 200)}</code>：<code>{safe(value.get("result", "未知"), 80)}</code>')
        return '\n'.join(lines) + '\n'
    if kind == 'node':
        lines += ['本版尚未解析 Node TAP；请查看本任务的 Node 测试日志。', '']
        return '\n'.join(lines)
    if outcome in ('cancelled', 'skipped'):
        lines += ['本步骤被取消或未执行；已有报告也不代表本次完整验证。', '']
    if not paths:
        lines += ['未找到结构化报告。可能尚未开始测试、准备失败或执行中断；不能当作“零失败”。', '']
    for path in paths:
        lines += [f'### 报告：<code>{safe(path.name, 200)}</code>', '']
        try:
            report = load(path)
            issues = python_issues(report) if kind == 'python' else browser_issues(report)
            if kind == 'python':
                lines.append(f"执行 {safe(report.get('run', '?'), 20)} 项；断言失败 {safe(report.get('failures', '?'), 20)}；错误 {safe(report.get('errors', '?'), 20)}；跳过 {len(report.get('skips', []))}。")
                lines.append(f"预期失败 {safe(report.get('expected_failures', '?'), 20)}；意外通过 {safe(report.get('unexpected_successes', '?'), 20)}。")
                if report.get('unexpected_successes'):
                    lines.append('意外通过：标记为 expectedFailure 的测试实际通过。unittest 仍判为不符合预期，会导致本次执行集合验收失败；需核对标记与行为，而非直接认定产品有故障。')
                if report.get('expected_failures'):
                    lines.append('预期失败：测试按 expectedFailure 标记失败。普通运行允许此状态，但 --required 严格执行集合不允许；请以本次执行状态为准。')
            else:
                stats = report['stats']
                lines.append('浏览器报告计数：' + '；'.join(f'{name} {safe(stats.get(key, "?"), 20)}' for key, name in [('expected', '符合预期'), ('unexpected', '不符合预期'), ('flaky', '重试后通过'), ('skipped', '跳过')]) + '。')
            if not issues:
                lines.append('报告中未列出失败详情；仍以执行步骤及本次执行集合验收为准（缺失用例、跳过等可能另行导致本次验收失败）。')
            for title, location, message in issues[:MAX_ITEMS]:
                intent = description(title)
                explanation = ('场景：' + safe(intent[0]) + '；预期：' + safe(intent[1])) if intent else '场景与预期：尚未提供中文说明，请结合测试名称及下方原始错误。'
                lines += ['', f'- 测试：<code>{safe(title, 500)}</code>',
                          f'  - 位置 / 类型：<code>{safe(location, 300)}</code>',
                          '  - ' + explanation,
                          '  - 原因：尚未定位；以下是错误摘录，不等于产品故障结论。',
                          '<pre>' + safe(message) + '</pre>']
            if len(issues) > MAX_ITEMS:
                lines.append(f'另有 {len(issues) - MAX_ITEMS} 条详情未展开，请查看完整报告。')
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
            lines.append('报告缺失或无法解析，不能判断通过：<code>' + safe(error, 300) + '</code>')
        lines.append('')
    lines += ['完整错误与附件：打开本次运行的失败步骤日志，或下载对应任务的报告 artifact。',
              '摘要不自动判定根因，也不把不同失败合并成同一个问题。', '']
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kind', choices=('python', 'browser', 'gate', 'node'), required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('--outcome', default='unknown')
    parser.add_argument('--role', choices=('standard', 'advisory'), default='standard')
    parser.add_argument('--root', type=Path, default=Path('.artifacts/matrix'))
    args = parser.parse_args()
    names = {'python': ('python.json', 'media-required.json'), 'browser': ('browser-results.json',), 'node': (), 'gate': ()}
    paths = [args.root / name for name in names[args.kind] if (args.root / name).is_file()]
    needs = json.loads(os.environ.get('CI_NEEDS', '{}')) if args.kind == 'gate' else None
    summary = render(args.kind, args.label, args.outcome, paths, needs, role=args.role)
    destination = os.environ.get('GITHUB_STEP_SUMMARY')
    if destination:
        with Path(destination).open('a', encoding='utf-8', newline='\n') as stream:
            stream.write(summary)
    else:
        # No GitHub workflow commands: printing only outside GitHub avoids untrusted annotations.
        if not os.environ.get('GITHUB_ACTIONS'):
            print(summary)


if __name__ == '__main__':
    main()

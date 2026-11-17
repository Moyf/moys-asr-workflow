"""Find explicit and bounded runtime consumers of changed repository files."""
from __future__ import annotations

import ast
from collections import defaultdict, deque
from functools import lru_cache
from pathlib import Path
import re
import sys

# These application shells import many unrelated features. Loading the shell
# alone does not establish that every shell test exercises each imported feature.
PYTHON_SHELLS = {'edit.py', 'maw_gui.py', 'maw/cli.py', 'maw/gui_web.py',
                 'maw/gui_workflow.py', 'server-editor/serve.py'}
READ = re.compile(r'\b(?:read_text|read_bytes|readFileSync|readFile|loadEditorModule|invokedInitModuleSource|import|require)\b')


@lru_cache(maxsize=128)
def _syntax_tree(source: str):
    """Cache immutable parse trees only within this process, keyed by content."""
    try:
        return ast.parse(source)
    except SyntaxError:
        return None


@lru_cache(maxsize=4096)
def _imports(name: str, source: str) -> tuple[tuple[str, bool, str], ...] | None:
    tree = _syntax_tree(source)
    if tree is None:
        return None
    package = name[:-3].replace('/', '.').rpartition('.')[0]
    result = set()

    class Visitor(ast.NodeVisitor):
        scopes = []
        def visit_FunctionDef(self, item):
            self.scopes.append(item.name)
            self.generic_visit(item)
            self.scopes.pop()
        visit_AsyncFunctionDef = visit_FunctionDef
        def visit_Import(self, item):
            result.update((alias.name, bool(self.scopes), self.scopes[-1] if self.scopes else '') for alias in item.names)
        def visit_ImportFrom(self, item):
            prefix = package.split('.') if package else []
            if item.level:
                prefix = prefix[:max(0, len(prefix) - item.level + 1)]
                base = '.'.join(prefix + ([item.module] if item.module else []))
            else:
                base = item.module or ''
            result.add((base, bool(self.scopes), self.scopes[-1] if self.scopes else ''))
            result.update((f'{base}.{alias.name}', bool(self.scopes), self.scopes[-1] if self.scopes else '') for alias in item.names)
    Visitor().visit(tree)
    return tuple(result)


def _texts(root: Path, paths) -> dict[str, str]:
    output = {}
    for path in paths:
        try:
            output[path.relative_to(root).as_posix()] = path.read_text(encoding='utf-8')
        except (OSError, UnicodeError):
            continue
    return output


@lru_cache(maxsize=256)
def _function_indexes(name: str, source: str):
    """Index import bindings, function references and calls once per source."""
    tree = _syntax_tree(source)
    if tree is None:
        return None
    imported, from_imported = [], []
    declarations = []
    for item in ast.walk(tree):
        if isinstance(item, ast.ImportFrom):
            if item.level:
                package = name[:-3].replace('/', '.').rpartition('.')[0]
                prefix = package.split('.') if package else []
                prefix = prefix[:max(0, len(prefix) - item.level + 1)]
                base = '.'.join(prefix + ([item.module] if item.module else []))
            else:
                base = item.module or ''
            from_imported.extend((base, alias.name, alias.asname or alias.name) for alias in item.names)
        elif isinstance(item, ast.Import):
            imported.extend((alias.name, alias.asname or alias.name.split('.')[0]) for alias in item.names)
        elif isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names, calls = set(), set()
            for part in ast.walk(item):
                if isinstance(part, ast.Name):
                    names.add(part.id)
                elif isinstance(part, ast.Call):
                    called = part.func.id if isinstance(part.func, ast.Name) else part.func.attr if isinstance(part.func, ast.Attribute) else ''
                    if called:
                        calls.add(called)
            declarations.append((item.name, frozenset(names), frozenset(calls)))
    top_names = frozenset(part.id for item in tree.body
                          if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                          for part in ast.walk(item) if isinstance(part, ast.Name))
    return tuple(imported), tuple(from_imported), tuple(declarations), top_names


@lru_cache(maxsize=2048)
def _affected_functions(name: str, source: str, owner: str, functions: tuple[str, ...]) -> tuple[bool, frozenset[str]]:
    """Find import bindings and actual uses of affected function(s)."""
    indexes = _function_indexes(name, source)
    if indexes is None:
        return False, frozenset()
    imported, from_imported, declarations, top_names = indexes
    bindings = {alias for base, symbol, alias in from_imported
                if base == owner and (symbol in functions or symbol == '*' or '*' in functions)
                or base and owner.startswith(base + '.') and symbol == owner[len(base) + 1:]}
    bindings.update(alias for module, alias in imported if module == owner)
    if not bindings:
        return False, frozenset()
    callers = {function for function, names, _ in declarations if names & bindings}
    if top_names & bindings:
        callers.add('*')
    return True, frozenset(callers)


@lru_cache(maxsize=2048)
def _local_callers(name: str, source: str, functions: tuple[str, ...]) -> frozenset[str]:
    """Close over same-module functions that call an affected function."""
    indexes = _function_indexes(name, source)
    if indexes is None:
        return frozenset(functions)
    found = set(functions)
    reverse_calls = defaultdict(set)
    for caller, _, calls in indexes[2]:
        for callee in calls:
            reverse_calls[callee].add(caller)
    queue = deque(found)
    while queue:
        for caller in reverse_calls[queue.popleft()] - found:
            found.add(caller)
            queue.append(caller)
    return frozenset(found)


def python_consumers(root: Path, changed: list[str]) -> tuple[set[str], bool]:
    files = []
    for folder in ('maw', 'scripts', 'tests', 'server-editor'):
        base = root / folder
        if base.is_dir():
            files.extend(path for path in base.rglob('*.py') if '__pycache__' not in path.parts)
    files.extend(root / name for name in ('edit.py', 'maw_gui.py') if (root / name).is_file())
    texts = _texts(root, files)
    targets = set(texts) | {path for path in changed if path.endswith('.py')}
    modules = {path[:-3].replace('/', '.'): path for path in targets if path.endswith('.py')}
    modules.update({path[:-12].replace('/', '.'): path for path in targets if path.endswith('/__init__.py')})
    reverse = defaultdict(set)
    deferred = defaultdict(lambda: defaultdict(set))
    bad = False
    for name, text in texts.items():
        imports = _imports(name, text)
        if imports is None:
            bad = True
            continue
        for module, lazy, scope in imports:
            if module in modules:
                if lazy:
                    deferred[modules[module]][name].add(scope)
                else:
                    reverse[modules[module]].add(name)
    found = set(changed)
    queue = deque(changed)
    while queue:
        current = queue.popleft()
        # Propagate a function-local import through actual imported symbols and
        # callers, instead of fanning out to every user of the containing module.
        pending = deque((owner, functions) for owner, functions in deferred[current].items())
        traced = set()
        while pending:
            owner, functions = pending.popleft()
            functions = _local_callers(owner, texts[owner], tuple(sorted(functions)))
            marker = (owner, tuple(sorted(functions)))
            if marker in traced:
                continue
            traced.add(marker)
            if owner.startswith('tests/test_'):
                found.add(owner)
                continue
            module = owner[:-3].replace('/', '.')
            for consumer in reverse[owner] | set(deferred[owner]):
                if consumer in PYTHON_SHELLS:
                    continue
                imported, calls = _affected_functions(consumer, texts[consumer], module, tuple(sorted(functions)))
                if not imported:
                    continue
                if consumer.startswith('tests/test_'):
                    if calls:
                        found.add(consumer)
                elif calls:
                    pending.append((consumer, calls))
        for name in reverse[current] - found:
            found.add(name)
            if name not in PYTHON_SHELLS and not name.startswith('tests/test_'):
                queue.append(name)
    return {p for p in found if p.startswith('tests/test_') and p.endswith('.py') and (root / p).is_file()}, bad


def file_consumers(root: Path, changed: list[str]) -> set[str]:
    """Trace literal helper imports and explicit test reads, not incidental names."""
    tests = root / 'tests'
    paths = list(tests.rglob('*.mjs')) + list(tests.rglob('*.py')) if tests.is_dir() else []
    texts = _texts(root, paths)
    changed_set = set(changed)
    reverse = defaultdict(set)
    for name, text in texts.items():
        parent = (root / name).parent
        # A path must be used by a read/import operation, not merely appear as a
        # mock filename or an assertion about selector output.
        for line in text.splitlines():
            if not READ.search(line):
                continue
            for target in changed_set:
                suffix = target.removeprefix('web/')
                if (target in line or len(suffix.split('/')) > 1 and suffix in line) and target != name:
                    reverse[target].add(name)
        for reference in re.findall(r'''(?:from\s*|import\s*\(|require\s*\()\s*["'](\.{1,2}/[^"']+)["']''', text):
            target = (parent / reference).resolve()
            try:
                relative = target.relative_to(root.resolve()).as_posix()
            except ValueError:
                continue
            reverse[relative].add(name)
    found = set(changed)
    queue = deque(changed)
    while queue:
        for name in reverse[queue.popleft()] - found:
            found.add(name)
            # Runnable tests are endpoints. Test helpers do propagate to actual
            # importers, but a general application loader is never inferred
            # merely because it happens to load the same assembled bundle.
            if not (name.startswith('tests/test_') or name.endswith('.spec.mjs')):
                queue.append(name)
    return {p for p in found if (p.startswith('tests/test_') or p.endswith('.spec.mjs')) and (root / p).is_file()}


def document_consumers(root: Path, changed: list[str]) -> set[str]:
    """Find tests that actually read an explicit repository document."""
    selected = set()
    tests = root / 'tests'
    if not tests.is_dir():
        return selected
    for path in list(tests.glob('test_*.py')) + list(tests.glob('test_*.mjs')) + list((tests / 'e2e').glob('*.spec.mjs')):
        try:
            text = path.read_text(encoding='utf-8')
        except (OSError, UnicodeError):
            continue
        relevant = [item for item in changed if item in text]
        if not relevant:
            continue
        if path.suffix == '.mjs':
            if any(item in line and re.search(r'\b(?:readFileSync|readFile)\s*\(', line)
                   for item in relevant for line in text.splitlines()):
                selected.add(path.relative_to(root).as_posix())
            continue
        try:
            tree = ast.parse(text)
        except SyntaxError:
            continue
        assigned = set()
        for node in ast.walk(tree):
            if not isinstance(node, (ast.Assign, ast.AnnAssign)) or node.value is None:
                continue
            parts = list(ast.walk(node.value))
            if (any(isinstance(part, ast.Name) and part.id == 'ROOT' for part in parts)
                    and any(isinstance(part, ast.Constant) and part.value in relevant for part in parts)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                assigned.update(target.id for target in targets if isinstance(target, ast.Name))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute) or node.func.attr not in {'read_text', 'read_bytes'}:
                continue
            value = node.func.value
            if isinstance(value, ast.Name) and value.id in assigned:
                selected.add(path.relative_to(root).as_posix())
                break
            parts = list(ast.walk(value))
            if (any(isinstance(part, ast.Name) and part.id == 'ROOT' for part in parts)
                    and any(isinstance(part, ast.Constant) and part.value in relevant for part in parts)):
                selected.add(path.relative_to(root).as_posix())
                break
    return selected


def python_test_dependencies(root: Path, tests: set[str]) -> bool:
    """Follow real Python imports, without interpreting source inside strings."""
    pending = [root / name for name in tests]
    direct = set(pending)
    seen = set()
    while pending:
        path = pending.pop()
        if path in seen:
            continue
        seen.add(path)
        try:
            imports = _imports(path.relative_to(root).as_posix(), path.read_text(encoding='utf-8'))
        except (OSError, UnicodeError, ValueError):
            continue
        if imports is None:
            continue
        for module, lazy, _ in imports:
            if lazy and path not in direct:
                continue
            parts = module.split('.')
            top = parts[0]
            if not top or top in sys.stdlib_module_names:
                continue
            local = None
            while parts and local is None:
                rel = Path(*parts)
                for base in (root, path.parent, root / 'tests'):
                    for candidate in (base / rel.with_suffix('.py'), base / rel / '__init__.py'):
                        if candidate.is_file():
                            local = candidate
                            break
                    if local:
                        break
                parts.pop()
            if local:
                pending.append(local)
            elif not (root / top).is_dir() and not (root / 'tests' / top).is_dir():
                return True
    return False


def bundle_consumed(root: Path, tests: set[str]) -> bool:
    """Look for real repository bundle reads or application rendering calls."""
    for name in tests:
        try:
            source = (root / name).read_text(encoding='utf-8')
        except (OSError, UnicodeError):
            continue
        if name.endswith('.py'):
            try:
                tree = ast.parse(source)
            except SyntaxError:
                continue
            roots = set()
            for node in ast.walk(tree):
                if isinstance(node, (ast.Assign, ast.AnnAssign)) and node.value is not None:
                    if any(isinstance(child, ast.Name) and child.id == '__file__' for child in ast.walk(node.value)):
                        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                        roots.update(target.id for target in targets if isinstance(target, ast.Name))
            for node in ast.walk(tree):
                if isinstance(node, ast.Call):
                    name_ = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id if isinstance(node.func, ast.Name) else ''
                    if name_ in {'render_empty_editor_page', 'ensure_editor_bundle'}:
                        return True
                if isinstance(node, ast.BinOp):
                    parts = list(ast.walk(node))
                    if (any(isinstance(part, ast.Name) and part.id in roots for part in parts)
                            and any(isinstance(part, ast.Constant) and isinstance(part.value, str)
                                    and ('editor-bundle.js' in part.value or 'launcher-bundle.js' in part.value) for part in parts)):
                        return True
        elif name.endswith('.mjs'):
            bundle = r'(?:editor|launcher)-bundle\.js'
            if re.search(r"(?:readFileSync|readFile)\s*\(\s*[\"']web/[^\"']*" + bundle, source):
                return True
            roots = re.findall(r"(?:const|let)\s+(\w+)\s*=\s*fileURLToPath\s*\(\s*new\s+URL\([^;]*import\.meta\.url", source)
            if any(re.search(r"(?:join|resolve)\s*\(\s*" + re.escape(var) + r"\s*,\s*[\"']web/[^\"']*" + bundle, source) for var in roots):
                return True
    return False


def node_python_dependencies(root: Path, tests: set[str]) -> bool:
    """Follow Python modules explicitly invoked by Node cross-language tests."""
    modules = set()
    for name in tests:
        try:
            source = (root / name).read_text(encoding='utf-8')
        except (OSError, UnicodeError):
            continue
        if 'MAW_TEST_PYTHON' not in source:
            continue
        modules.update(re.findall(r'\b(?:from|import)\s+(maw(?:\.[A-Za-z_]\w*)+)', source))
    seen = set()
    while modules:
        module = modules.pop()
        if module in seen:
            continue
        seen.add(module)
        path = root.joinpath(*module.split('.')).with_suffix('.py')
        if not path.is_file():
            continue
        try:
            imports = _imports(path.relative_to(root).as_posix(), path.read_text(encoding='utf-8'))
        except (OSError, UnicodeError):
            continue
        if imports is None:
            continue
        for dependency, lazy, _ in imports:
            if lazy:
                continue
            top = dependency.split('.', 1)[0]
            if top == 'maw':
                modules.add(dependency)
            elif top and top not in sys.stdlib_module_names and not (root / top).is_dir():
                return True
    return False


def web_behavior_consumers(root: Path, changed: list[str]) -> set[str]:
    """Discover tests exercising a module's DOM IDs or published facade."""
    tests = root / 'tests'
    paths = list(tests.glob('test_*.mjs')) + list((tests / 'e2e').glob('*.spec.mjs')) if tests.is_dir() else []
    texts = _texts(root, paths)
    selected = set()
    for path in changed:
        file = root / path
        if not file.is_file():
            continue
        try:
            source = file.read_text(encoding='utf-8')
        except (OSError, UnicodeError):
            continue
        ids = set(re.findall(r'''(?:const|let|var)\s+\w+\s*=\s*document\.getElementById\(\s*["']([\w-]+)["']''', source))
        facades = set(re.findall(r'\b(?:global|window)\.(Mawe\w+)\s*=\s*Object\.freeze', source))
        # Shared ESM factories publish their returned methods through an
        # aggregate facade. Match actual calls, not every test loading it.
        exposed = set()
        parents = set()
        if path.startswith('web/shared/utils/'):
            functions = set(re.findall(r'\bfunction\s+(\w+)\s*\(', source))
            for body in re.findall(r'return\s+(?:Object\.freeze\s*\(\s*)?\{([^{}]*)\}', source, re.S):
                exposed.update(name for name in re.findall(r'\b[A-Za-z_]\w*\b', body) if name in functions)
            for parent in (root / 'web/shared').glob('*.js'):
                try:
                    parent_text = parent.read_text(encoding='utf-8')
                    if re.search(r"(?:from|import)\s*[\"\']\./utils/" + re.escape(Path(path).name) + r"[\"\']", parent_text):
                        parents.add(parent.relative_to(root / 'web').as_posix())
                except (OSError, UnicodeError):
                    pass
        web_path = path.removeprefix('web/')
        for name, text in texts.items():
            # Project saving is a widely shared helper action. Preserve the
            # suites whose primary purpose is saving/project lifecycle rather
            # than every unrelated feature suite that happens to save once.
            matched_facades = {facade for facade in facades if re.search(r'\b' + re.escape(facade) + r'\.\w+', text)}
            if 'MaweProjectSave' in matched_facades:
                primary = (re.search(r'(?:project|save|editor-transactions|editor-session)', Path(name).name)
                           or re.search(r"\btest(?:\.\w+)?\s*\(\s*[\"'](?:sav(?:e|ing)|保存|存盘)", text, re.I))
                if not primary:
                    matched_facades.remove('MaweProjectSave')
            dom_match = any(f'#{ident}' in text for ident in ids)
            # Project-name widgets are shared with open/attach flows; matching
            # their IDs alone does not show a test exercises project saving.
            if 'MaweProjectSave' in facades and not matched_facades and 'save' not in Path(name).name:
                dom_match = False
            if name.endswith('.spec.mjs') and (dom_match or matched_facades):
                selected.add(name)
            if exposed and any(parent in text for parent in parents) and any(
                    re.search(r'\.\s*' + re.escape(symbol) + r'\s*\(', text) for symbol in exposed):
                selected.add(name)
            # Structural import tests read each manifest entry under this prefix.
            if 'readFileSync' in text and any(web_path.startswith(prefix) for prefix in re.findall(
                    r'''\.startsWith\(\s*["'](editor/[^"']+/)["']''', text)):
                selected.add(name)
    return selected

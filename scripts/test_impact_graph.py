"""Find explicit and bounded runtime consumers of changed repository files."""
from __future__ import annotations

import ast
from collections import defaultdict, deque
from functools import lru_cache
from pathlib import Path, PurePosixPath
import posixpath
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


def python_consumers(root: Path, changed: list[str]) -> tuple[dict[str, set[str]], bool]:
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
    endpoints = {name: name for name in texts if name.startswith('tests/test_')}
    for test, source in _texts(root, (root / 'tests').glob('test_*.mjs')).items():
        for index, script in enumerate(_node_python_scripts(source)):
            name = f'{test}#{index}'
            endpoints[name] = test
            texts[name] = script
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
    selected = {}
    for path in changed:
        found = {path}
        queue = deque([path])
        while queue:
            current = queue.popleft()
            # Propagate function-local imports through actual symbol uses.
            pending = deque(deferred[current].items())
            traced = set()
            while pending:
                owner, functions = pending.popleft()
                functions = _local_callers(owner, texts[owner], tuple(sorted(functions)))
                marker = (owner, tuple(sorted(functions)))
                if marker in traced:
                    continue
                traced.add(marker)
                if owner in endpoints:
                    found.add(owner)
                    continue
                module = owner[:-3].replace('/', '.')
                for consumer in reverse[owner] | set(deferred[owner]):
                    if consumer in PYTHON_SHELLS:
                        continue
                    imported, calls = _affected_functions(consumer, texts[consumer], module, marker[1])
                    if imported and calls:
                        if consumer in endpoints:
                            found.add(consumer)
                        else:
                            pending.append((consumer, calls))
            for name in reverse[current] - found:
                found.add(name)
                if name not in PYTHON_SHELLS and name not in endpoints:
                    queue.append(name)
        selected[path] = {endpoints[name] for name in found if name in endpoints}
    return selected, bad


def _relative_import(name: str, reference: str) -> str:
    return posixpath.normpath(posixpath.join(posixpath.dirname(name), reference))


@lru_cache(maxsize=512)
def _python_file_reads(name: str, source: str) -> frozenset[str]:
    """Resolve literal Path expressions from the working directory or __file__."""
    tree = _syntax_tree(source)
    if tree is None:
        return frozenset()
    repo = PurePosixPath('/repository')
    reads = set()

    class Visitor(ast.NodeVisitor):
        bindings = {'__file__': repo / name}

        def path(self, node):
            if isinstance(node, ast.Name):
                return self.bindings.get(node.id)
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                path = PurePosixPath(node.value.replace('\\', '/'))
                if not path.is_absolute() and ':' not in node.value:
                    return path
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
                base, child = self.path(node.left), self.path(node.right)
                if base is not None and child is not None and not child.is_absolute():
                    return base / child
            if isinstance(node, ast.Attribute) and node.attr == 'parent':
                base = self.path(node.value)
                if base is not None:
                    return (repo / base).parent
            if (isinstance(node, ast.Subscript) and isinstance(node.value, ast.Attribute)
                    and node.value.attr == 'parents' and isinstance(node.slice, ast.Constant)
                    and type(node.slice.value) is int):
                base = self.path(node.value.value)
                if base is not None and 0 <= node.slice.value < len((repo / base).parents):
                    return (repo / base).parents[node.slice.value]
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name) and node.func.id == 'Path' and len(node.args) == 1:
                    return self.path(node.args[0])
                if isinstance(node.func, ast.Attribute):
                    base = self.path(node.func.value)
                    if base is not None and node.func.attr == 'resolve' and not node.args:
                        return PurePosixPath(posixpath.normpath(repo / base))
                    if base is not None and node.func.attr == 'joinpath':
                        parts = [self.path(arg) for arg in node.args]
                        if all(part is not None and not part.is_absolute() for part in parts):
                            return base.joinpath(*parts)
            return None

        def visit_Assign(self, node):
            self.generic_visit(node)
            value = self.path(node.value)
            for target in node.targets if isinstance(node, ast.Assign) else (node.target,):
                if isinstance(target, ast.Name):
                    self.bindings[target.id] = value
        visit_AnnAssign = visit_Assign

        def visit_FunctionDef(self, node):
            enclosing = self.bindings
            self.bindings = enclosing.copy()
            for arg in ast.iter_child_nodes(node.args):
                if isinstance(arg, ast.arg):
                    self.bindings.pop(arg.arg, None)
            for statement in node.body:
                self.visit(statement)
            self.bindings = enclosing
        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_ClassDef(self, node):
            enclosing = self.bindings
            self.bindings = enclosing.copy()
            self.generic_visit(node)
            self.bindings = enclosing

        def visit_Call(self, node):
            if isinstance(node.func, ast.Attribute) and node.func.attr in {'read_text', 'read_bytes'}:
                base = self.path(node.func.value)
                if base is not None:
                    target = PurePosixPath(posixpath.normpath(repo / base))
                    if target.is_relative_to(repo):
                        reads.add(target.relative_to(repo).as_posix())
            self.generic_visit(node)

    Visitor().visit(tree)
    return frozenset(reads)


def file_consumers(root: Path, changed: list[str]) -> dict[str, set[str]]:
    """Trace paths through literal repository reads and local test imports."""
    tests = root / 'tests'
    paths = list(tests.rglob('*.mjs')) + list(tests.rglob('*.py')) if tests.is_dir() else []
    texts = _texts(root, paths)
    reverse = defaultdict(set)
    for name, source in texts.items():
        if name.endswith('.py'):
            if 'read_text' in source or 'read_bytes' in source:
                for target in _python_file_reads(name, source):
                    reverse[target].add(name)
            continue
        # Node test fixtures also have established loader helpers that accept
        # paths relative to web/, such as loadEditorModule().
        for line in source.splitlines():
            if READ.search(line):
                for target in changed:
                    suffix = target.removeprefix('web/')
                    if target in line or '/' in suffix and suffix in line:
                        reverse[target].add(name)
        for reference in re.findall(r'''(?:from\s*|import\s*\(|require\s*\()\s*["'](\.{1,2}/[^"']+)["']''', source):
            reverse[_relative_import(name, reference)].add(name)

    selected = {}
    for path in changed:
        found, pending = {path}, [path]
        consumers = set()
        while pending:
            for name in reverse[pending.pop()] - found:
                found.add(name)
                if name.startswith('tests/test_') or name.endswith('.spec.mjs'):
                    consumers.add(name)
                else:
                    pending.append(name)
        selected[path] = consumers
    return selected


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


def bundles_consumed(root: Path, tests: set[str]) -> set[str]:
    """Look for repository bundle reads or application rendering."""
    needed = set()
    components = ('editor', 'launcher')
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
                        needed.add('editor')
                if isinstance(node, ast.BinOp):
                    parts = list(ast.walk(node))
                    if any(isinstance(part, ast.Name) and part.id in roots for part in parts):
                        needed.update(component for component in components
                                      if any(isinstance(part, ast.Constant) and isinstance(part.value, str)
                                             and f'{component}-bundle.js' in part.value for part in parts))
        elif name.endswith('.mjs'):
            roots = re.findall(r"(?:const|let)\s+(\w+)\s*=\s*fileURLToPath\s*\(\s*new\s+URL\([^;]*import\.meta\.url", source)
            for component in components:
                bundle = rf'[\"\']web/[^\"\']*{component}-bundle\.js'
                if (re.search(r"(?:readFileSync|readFile)\s*\(\s*" + bundle, source)
                        or any(re.search(r"(?:join|resolve)\s*\(\s*" + re.escape(var) + r"\s*,\s*" + bundle, source)
                               for var in roots)):
                    needed.add(component)
            if _js_opens_launcher(source):
                needed.add('launcher')
    return needed


JS_TOKEN = re.compile(
    r"""\s+|//[^\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60|[$\w]+|[^\s]"""
)
JS_PROCESS_CALLS = {'spawn', 'spawnSync', 'execFile', 'execFileSync'}


def _js_tokens(source: str) -> list[str]:
    return [token for token in JS_TOKEN.findall(source)
            if not token.isspace() and not token.startswith(('//', '/*'))]


def _js_end(tokens: list[str], start: int) -> int:
    opening = tokens[start]
    closing = {'(': ')', '[': ']', '{': '}'}[opening]
    depth = 1
    for i in range(start + 1, len(tokens)):
        token = tokens[i]
        if token == opening:
            depth += 1
        elif token == closing:
            depth -= 1
            if not depth:
                return i
    return len(tokens)


def _js_string(token: str) -> str | None:
    if len(token) < 2 or token[0] not in "'\"":
        return None
    try:
        return ast.literal_eval(token)
    except (ValueError, SyntaxError):
        return None


@lru_cache(maxsize=128)
def _js_module_specifiers(source: str) -> frozenset[str]:
    """Read literal imports without matching comments or embedded programs."""
    tokens = _js_tokens(source)
    specifiers = set()
    for index, token in enumerate(tokens[:-1]):
        position = index + 1
        if token in {'import', 'require'} and tokens[position] == '(':
            position += 1
        elif token not in {'from', 'import'}:
            continue
        if position < len(tokens) and (value := _js_string(tokens[position])):
            specifiers.add(value)
    return frozenset(specifiers)


def node_uses_packages(root: Path, test: str, packages: set[str]) -> bool:
    """Follow local module imports to discover installed package consumers."""
    pending = [test]
    seen = set()
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.add(name)
        try:
            source = (root / name).read_text(encoding='utf-8')
        except (OSError, UnicodeError):
            continue
        for reference in _js_module_specifiers(source):
            if any(reference == package or reference.startswith(package + '/') for package in packages):
                return True
            if reference.startswith(('./', '../')):
                path = _relative_import(name, reference)
                if path != '..' and not path.startswith('../'):
                    pending.append(path)
    return False


def _js_expression(tokens: list[str], start: int, stop: set[str]) -> list[str]:
    end = start
    while end < len(tokens) and tokens[end] not in stop:
        end = _js_end(tokens, end) + 1 if tokens[end] in ('(', '[', '{') else end + 1
    return tokens[start:end]


def _js_const_bindings(tokens: list[str]):
    for i, token in enumerate(tokens[:-3]):
        if token == 'const' and tokens[i + 2] == '=':
            yield tokens[i + 1], _js_expression(tokens, i + 3, {';', ','})


def _js_ffmpeg_executable(argument: list[str]) -> bool:
    if argument[:5] == ['process', '.', 'env', '.', 'FFMPEG_PATH']:
        if len(argument) == 5:
            return True
        if argument[5:7] not in (['|', '|'], ['?', '?']):
            return False
        argument = argument[7:]
    return len(argument) == 1 and _js_string(argument[0]) in {'ffmpeg', 'ffprobe', 'ffmpeg.exe', 'ffprobe.exe'}


@lru_cache(maxsize=128)
def browser_ffmpeg_consumed(source: str) -> bool:
    """Find FFmpeg or FFprobe used as the executable in a subprocess call."""
    if not any(name in source for name in ('ffmpeg', 'ffprobe', 'FFMPEG_PATH')):
        return False
    tokens = _js_tokens(source)
    bindings = {name for name, argument in _js_const_bindings(tokens) if _js_ffmpeg_executable(argument)}
    for i, token in enumerate(tokens[:-2]):
        if token not in JS_PROCESS_CALLS or tokens[i + 1] != '(':
            continue
        argument = _js_expression(tokens, i + 2, {',', ')'})
        if _js_ffmpeg_executable(argument) or len(argument) == 1 and argument[0] in bindings:
            return True
    return False


def _js_launcher_path(tokens: list[str]) -> bool:
    paths = [_js_string(token) for token in tokens if token.startswith(('"', "'"))]
    return (any(path and not path.startswith(('http://', 'https://'))
                and ('/' + path).endswith('/web/launcher/index.html') for path in paths)
            or any(paths[i:i + 3] == ['web', 'launcher', 'index.html'] for i in range(len(paths) - 2)))


@lru_cache(maxsize=128)
def _js_opens_launcher(source: str) -> bool:
    """Recognize page navigation to Launcher, via a literal or local URL binding."""
    if 'launcher' not in source or 'goto' not in source:
        return False
    tokens = _js_tokens(source)
    bindings = {name for name, argument in _js_const_bindings(tokens) if _js_launcher_path(argument)}
    for i, token in enumerate(tokens[:-3]):
        if token != 'page' or tokens[i + 1:i + 4] != ['.', 'goto', '(']:
            continue
        argument = _js_expression(tokens, i + 4, {',', ')'})
        fragments = [part for item in argument if item.startswith('`')
                     for expression in re.findall(r'\$\{([^{}]+)\}', item)
                     for part in _js_tokens(expression)]
        if _js_launcher_path(argument + fragments) or bindings.intersection(argument + fragments):
            return True
    return False


@lru_cache(maxsize=64)
def _node_python_scripts(source: str) -> tuple[str, ...]:
    """Find literal Python -c programs passed to a subprocess in a Node test."""
    if 'MAW_TEST_PYTHON' not in source and 'MAW_E2E_PYTHON' not in source:
        return ()
    tokens = _js_tokens(source)
    scripts = set()
    for i, token in enumerate(tokens[:-1]):
        if token not in JS_PROCESS_CALLS or tokens[i + 1] != '(':
            continue
        args = tokens[i + 2:_js_end(tokens, i + 1)]
        for j, option in enumerate(args[:-2]):
            if option not in {"'-c'", '"-c"'} or args[j + 1] != ',':
                continue
            value = args[j + 2]
            script = _js_string(value)
            if value == '[':
                end = _js_end(args, j + 2)
                tail = args[end + 1:end + 6]
                if len(tail) == 5 and tail[:3] == ['.', 'join', '('] and tail[4] == ')':
                    separator = _js_string(tail[3])
                    lines = [_js_string(part) for part in args[j + 3:end] if part != ',']
                    if separator is not None and all(line is not None for line in lines):
                        script = separator.join(lines)
            if script and _syntax_tree(script) is not None:
                scripts.add(script)
    return tuple(sorted(scripts))


def _js_call_names(tokens: list[str]) -> frozenset[str]:
    return frozenset(token for i, token in enumerate(tokens[:-1])
                     if token.isidentifier() and tokens[i + 1] == '('
                     and (i == 0 or tokens[i - 1] not in {'.', 'function'}))


@lru_cache(maxsize=128)
def _js_fixture_calls(name: str, source: str):
    """Index local named imports and declared helper functions."""
    tokens = _js_tokens(source)
    imports = {}
    functions = {}
    for i, token in enumerate(tokens[:-3]):
        if token == 'import' and tokens[i + 1] == '{':
            end = _js_end(tokens, i + 1)
            if tokens[end + 1:end + 2] != ['from'] or end + 2 >= len(tokens):
                continue
            reference = _js_string(tokens[end + 2])
            if not reference or not reference.startswith('.'):
                continue
            target = _relative_import(name, reference)
            for item in ' '.join(tokens[i + 2:end]).split(','):
                parts = item.split()
                if len(parts) == 1 or len(parts) == 3 and parts[1] == 'as':
                    imports[parts[-1]] = (target, parts[0])
        elif token == 'function' and tokens[i + 2] == '(':
            end = _js_end(tokens, i + 2)
            if tokens[end + 1:end + 2] == ['{']:
                functions[tokens[i + 1]] = _js_call_names(tokens[end + 2:_js_end(tokens, end + 1)])
    return imports, functions, _js_call_names(tokens)


def browser_application_consumed(root: Path, specs: set[str]) -> bool:
    """Follow invoked fixture functions to application process/render entry points."""
    pending = [(name, None) for name in specs]
    seen = set()
    indexes = {}
    while pending:
        name, function = pending.pop()
        if (name, function) in seen:
            continue
        seen.add((name, function))
        if (name, function) in {
            ('tests/e2e/server-process.mjs', 'spawnServerProcess'),
            ('tests/e2e/helpers.mjs', 'buildBrowserEditorFixture'),
        }:
            return True
        if name not in indexes:
            texts = _texts(root, [root / name])
            indexes[name] = _js_fixture_calls(name, texts[name]) if name in texts else ({}, {}, ())
        imports, functions, all_calls = indexes[name]
        for call in functions.get(function, ()) if function else all_calls:
            if call in imports:
                pending.append(imports[call])
            elif call in functions:
                pending.append((name, call))
    return False


def node_python_dependencies(root: Path, tests: set[str]) -> bool:
    """Follow Python modules explicitly invoked by Node cross-language tests."""
    modules = set()
    for name in tests:
        try:
            source = (root / name).read_text(encoding='utf-8')
        except (OSError, UnicodeError):
            continue
        for script in _node_python_scripts(source):
            for module, lazy, _ in _imports(name, script) or ():
                if not lazy:
                    modules.add(module)
    seen = set()
    while modules:
        module = modules.pop()
        if module in seen:
            continue
        seen.add(module)
        top = module.split('.', 1)[0]
        if top and top not in sys.stdlib_module_names and not (root / top).exists() and not (root / (top + '.py')).is_file():
            return True
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


def web_behavior_consumers(root: Path, changed: list[str]) -> dict[str, set[str]]:
    """Discover tests exercising a module's DOM IDs or published facade."""
    tests = root / 'tests'
    paths = list(tests.glob('test_*.mjs')) + list((tests / 'e2e').glob('*.spec.mjs')) if tests.is_dir() else []
    texts = _texts(root, paths)
    selected = {path: set() for path in changed}
    for path in changed:
        consumers = selected[path]
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
                consumers.add(name)
            if exposed and any(parent in text for parent in parents) and any(
                    re.search(r'\.\s*' + re.escape(symbol) + r'\s*\(', text) for symbol in exposed):
                consumers.add(name)
            # Structural import tests read each manifest entry under this prefix.
            if 'readFileSync' in text and any(web_path.startswith(prefix) for prefix in re.findall(
                    r'''\.startsWith\(\s*["'](editor/[^"']+/)["']''', text)):
                consumers.add(name)
    return selected

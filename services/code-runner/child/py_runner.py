"""Runs one Code node snippet (Python) inside the process the code runner starts for it.

    python3 -I -S -B py_runner.py      (CPython, standard library only: no site-packages)

The job arrives as JSON on stdin; answers go out as JSON lines on fd 3, so nothing the snippet prints can forge one:
{"type": "log", ...} per printed line, then one {"type": "result", "items": [...]} or {"type": "error", "error": {...}}.

The snippet becomes the body of a function, so a bare `return` works as in n8n, and keeps its own line numbers.
Globals follow n8n's Python Code node: _input (all/first/last/item/item_matching), _json, _helpers (files), _items, _item, _('Node'), _vars,
_execution, _workflow, _now, _today, _itemIndex. Items are dicts that also allow attribute access
(item.json.name as well as item["json"]["name"]).

With guards on, an audit hook refuses network access, new processes, signals, ctypes and file writes outside the
work directory. Audit hooks are not a security boundary (n8n's runner uses the same idea as a first line); the OS
sandbox and limits the runner applies, and in Docker the container, are what actually contain the snippet.
"""

import ast
import base64
import datetime
import decimal
import io
import json
import linecache
import math
import os
import sys
import traceback
import types

FILE = '<code>'
_channel = os.fdopen(3, 'w', encoding='utf-8', buffering=1 << 16)
_finished = False


def send(message):
    _channel.write(message if isinstance(message, str) else json.dumps(message, ensure_ascii=False))
    _channel.write('\n')
    _channel.flush()


def finish(message):
    global _finished
    if _finished:
        return
    _finished = True
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, LogStream):
            stream.close_out()
    send(message)
    # Skip interpreter shutdown: threads the snippet started don't hold the answer back.
    os._exit(0)


class LogStream(io.TextIOBase):
    """sys.stdout / sys.stderr: each complete line becomes a node log."""

    def __init__(self, level):
        super().__init__()
        self.level = level
        self.pending = ''

    def writable(self):
        return True

    def write(self, text):
        text = str(text)
        self.pending += text
        while '\n' in self.pending:
            line, self.pending = self.pending.split('\n', 1)
            send({'type': 'log', 'level': self.level, 'message': line})
        return len(text)

    def close_out(self):
        if self.pending:
            send({'type': 'log', 'level': self.level, 'message': self.pending})
            self.pending = ''


class Obj(dict):
    """A dict that also allows attribute access, for keys that aren't dict methods."""

    __slots__ = ()

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name) from None

    def __setattr__(self, name, value):
        self[name] = value

    def __delattr__(self, name):
        try:
            del self[name]
        except KeyError:
            raise AttributeError(name) from None


class Accessor:
    """_input and _('Node'): all(), first(), last(), item_matching(i), and .item / .json / .binary following the
    current item. `items` None is a node that hasn't run: is_executed is False and reading anything else raises."""

    def __init__(self, name, items, current):
        self._name = name
        self._list = items
        self._current = current

    @property
    def _items(self):
        if self._list is None:
            raise KeyError(f'Node "{self._name}" has not run yet (or produced no output)')
        return self._list

    def all(self):
        return self._items

    def first(self):
        return self._items[0] if self._items else None

    def last(self):
        return self._items[-1] if self._items else None

    def item_matching(self, index):
        items = self._items
        if not 0 <= index < len(items):
            raise IndexError(f'Node "{self._name}" has no item matching input item {index}')
        return items[index]

    itemMatching = item_matching

    @property
    def item(self):
        items = self._items
        index = self._current()
        return items[index] if 0 <= index < len(items) else self.first()

    @property
    def json(self):
        item = self.item
        return item.get('json') if item is not None else None

    @property
    def binary(self):
        item = self.item
        return item.get('binary') if item is not None else None

    @property
    def is_executed(self):
        return self._list is not None

    isExecuted = is_executed


class Helpers:
    """_helpers: the input files the host sent (bytes) and files created, as base64 for the host to store."""

    def __init__(self, items, files, skipped, limit):
        self._items = items
        self._files = files
        self._skipped = skipped
        self._limit = limit
        self._created = 0

    def assert_binary_data(self, item_index, property_name='data'):
        item = self._items[item_index] if 0 <= item_index < len(self._items) else None
        ref = (item.get('binary') or {}).get(property_name) if item is not None else None
        if not isinstance(ref, dict):
            available = list((item.get('binary') or {}).keys()) if item is not None else []
            hint = f" (its files: {', '.join(available)})" if available else ''
            raise KeyError(f'Item {item_index} has no binary file "{property_name}"{hint}')
        return ref

    def get_binary_data_buffer(self, item_index, property_name='data'):
        self.assert_binary_data(item_index, property_name)
        key = f'{item_index}:{property_name}'
        if key in self._skipped:
            raise ValueError(self._skipped[key])
        if key not in self._files:
            raise KeyError(f'The bytes of item {item_index}\'s file "{property_name}" were not sent to the code sandbox')
        return base64.b64decode(self._files[key])

    def prepare_binary_data(self, data, file_name=None, mime_type=None):
        if isinstance(data, str):
            data = data.encode('utf-8')
        elif isinstance(data, (bytearray, memoryview)):
            data = bytes(data)
        elif not isinstance(data, bytes):
            raise TypeError('prepare_binary_data needs bytes, a bytearray or a str')
        self._created += len(data)
        if self._created > self._limit:
            raise ValueError(f'Files created by the code are over the {self._limit / 1024 / 1024:.1f} MB limit ({self._created} bytes so far)'.replace('.0 MB', ' MB'))
        ref = Obj({'data': base64.b64encode(data).decode('ascii')})
        if mime_type:
            ref['mimeType'] = mime_type
        if file_name:
            ref['fileName'] = file_name
            extension = os.path.splitext(file_name)[1].lstrip('.')
            if extension and extension.isalnum() and len(extension) <= 10:
                ref['fileExtension'] = extension.lower()
        ref['fileSize'] = len(data)
        return ref

    getBinaryDataBuffer = get_binary_data_buffer
    prepareBinaryData = prepare_binary_data
    assertBinaryData = assert_binary_data


# --------------------------------------------------------------------------------------------- guards

_NETWORK = {
    'socket.connect', 'socket.bind', 'socket.sendto', 'socket.sendmsg', 'socket.getaddrinfo', 'socket.gethostbyname',
    'socket.gethostbyaddr', 'socket.getnameinfo', 'socket.sethostname',
}
_PROCESS = {'subprocess.Popen', 'os.system', 'os.exec', 'os.posix_spawn', 'os.spawn', 'os.fork', 'os.forkpty', 'os.startfile'}
_SIGNALS = {'os.kill', 'os.killpg', 'signal.pthread_kill'}
_NATIVE = {'ctypes', '_ctypes'}
_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC
# Events whose leading arguments are paths the call creates, changes or removes.
_PATH_EVENTS = {
    'os.remove': 1, 'os.rmdir': 1, 'os.mkdir': 1, 'os.chmod': 1, 'os.chown': 1, 'os.truncate': 1, 'os.utime': 1,
    'os.rename': 2, 'os.link': 2, 'os.symlink': 2, 'shutil.copyfile': 2, 'shutil.rmtree': 1,
}


def install_guards(work_dir):
    work = os.path.realpath(work_dir)

    def inside(path):
        if isinstance(path, int):
            return True
        try:
            path = os.fsdecode(os.fspath(path))
        except TypeError:
            return True
        if path in ('/dev/null', '/dev/stdout', '/dev/stderr'):
            return True
        resolved = os.path.realpath(os.path.join(work, path))
        return resolved == work or resolved.startswith(work + os.sep)

    def denied(what):
        return PermissionError(f'{what} is disabled in the code sandbox')

    def hook(event, args):
        if event in _NETWORK:
            raise denied('Network access')
        if event in _PROCESS:
            raise denied('Starting processes')
        if event in _SIGNALS:
            raise denied('Sending signals')
        if event == 'import' and args[0] in _NATIVE or event.startswith('ctypes.'):
            raise denied('ctypes')
        if event == 'open':
            path, mode, flags = (tuple(args) + (None, None))[:3]
            writes = (isinstance(flags, int) and flags & _WRITE_FLAGS) or (isinstance(mode, str) and any(c in mode for c in 'wax+'))
            if writes and not inside(path):
                raise denied(f'Writing outside the work directory ({path})')
        elif event in _PATH_EVENTS:
            for path in tuple(args)[:_PATH_EVENTS[event]]:
                if path is not None and not inside(path):
                    raise denied(f'Changing files outside the work directory ({path})')

    sys.addaudithook(hook)


# --------------------------------------------------------------------------------------------- errors and results

def describe(error, item_index=None, kind='error'):
    """{kind, name, message, line, column, itemIndex, stack} with the snippet's frames only."""
    name = type(error).__name__
    if isinstance(error, MemoryError):
        kind = 'memory'
    if isinstance(error, SyntaxError) and error.filename == FILE:
        kind = 'syntax'
        line, column, message = error.lineno, error.offset, error.msg
        stack = ''.join(traceback.format_exception_only(type(error), error)).rstrip()
    else:
        frames = [frame for frame in traceback.extract_tb(error.__traceback__) if frame.filename == FILE]
        last = frames[-1] if frames else None
        line = last.lineno if last else None
        column = last.colno + 1 if last is not None and getattr(last, 'colno', None) is not None else None
        message = str(error) if not isinstance(error, SystemExit) else 'The code called exit()'
        stack = ''.join(
            (['Traceback (most recent call last):\n'] + traceback.format_list(frames) if frames else [])
            + traceback.format_exception_only(type(error), error)
        ).rstrip()
    result = {'kind': kind, 'name': name, 'message': message, 'stack': stack}
    if line is not None:
        result['line'] = line
    if column is not None:
        result['column'] = column
    if item_index is not None:
        result['itemIndex'] = item_index
    return result


def to_items(result):
    """n8n's return contract: items ({"json": ...}) or plain dicts; a primitive becomes {"json": {"value": ...}}."""
    if result is None:
        return []
    if isinstance(result, dict):
        result = [result]
    elif isinstance(result, (str, bytes, int, float, bool)):
        result = [result]
    elif not isinstance(result, (list, tuple)):
        result = list(result) if isinstance(result, types.GeneratorType) or hasattr(result, '__iter__') else [result]
    items = []
    for entry in result:
        if isinstance(entry, dict) and isinstance(entry.get('json'), dict):
            item = {'json': entry['json']}
            for key in ('pairedItem', 'binary'):
                if key in entry:
                    item[key] = entry[key]
            items.append(item)
        elif isinstance(entry, dict):
            items.append({'json': entry})
        else:
            items.append({'json': {'value': entry}})
    return items


def _default(value):
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (set, frozenset, tuple)):
        return list(value)
    if isinstance(value, (bytes, bytearray)):
        return value.decode('utf-8', 'replace')
    raise TypeError(f'Object of type {type(value).__name__} is not JSON serializable')


def _finite(value):
    """NaN and infinities become null, as JSON.stringify does."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: _finite(entry) for key, entry in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_finite(entry) for entry in value]
    return value


def dump(items):
    try:
        return json.dumps(items, default=_default, allow_nan=False, ensure_ascii=False, separators=(',', ':'))
    except ValueError:
        return json.dumps(_finite(items), default=_default, allow_nan=False, ensure_ascii=False, separators=(',', ':'))


def compile_snippet(code):
    """The snippet as the body of a function named `<code>` (so tracebacks read `in <code>`), line numbers unchanged."""
    tree = ast.parse(code, FILE, 'exec')
    wrapper = ast.parse('def snippet():\n    pass\n', FILE, 'exec')
    function = wrapper.body[0]
    function.name = FILE
    if tree.body:
        function.body = tree.body
    ast.fix_missing_locations(wrapper)
    return compile(wrapper, FILE, 'exec')


# --------------------------------------------------------------------------------------------- main

def main():
    job = json.loads(sys.stdin.buffer.read(), object_hook=Obj)
    sys.stdin = io.StringIO('')
    sys.stdout = LogStream('info')
    sys.stderr = LogStream('warn')
    if job.get('guards'):
        install_guards(job['workDir'])

    code = job.get('code') or ''
    linecache.cache[FILE] = (len(code), None, code.splitlines(True), FILE)
    items = job.get('items') or []
    outputs = job.get('nodeOutputs') or {}
    current = [0]

    try:
        from zoneinfo import ZoneInfo
        zone = ZoneInfo(job['timezone']) if job.get('timezone') else datetime.timezone.utc
    except Exception:
        zone = datetime.timezone.utc
    now = datetime.datetime.now(zone)

    def node_output(name):
        return Accessor(name, outputs[name] if name in outputs else None, lambda: current[0])

    limit = job.get('maxBinaryBytes') or float('inf')

    namespace = {
        '__name__': '__landflow__',
        '_input': Accessor(None, items, lambda: current[0]),
        '_helpers': Helpers(items, job.get('binary') or {}, job.get('binarySkipped') or {}, limit),
        '_items': items,
        '_': node_output,
        '_vars': Obj(job.get('variables') or {}),
        '_execution': job.get('execution') or Obj(),
        '_workflow': job.get('workflow') or Obj(),
        '_now': now,
        '_today': now.replace(hour=0, minute=0, second=0, microsecond=0),
        '_runIndex': 0,
    }

    def set_item(index):
        current[0] = index
        item = items[index] if index < len(items) else None
        namespace['_itemIndex'] = index
        namespace['_item'] = item
        namespace['_json'] = item.get('json', Obj()) if item is not None else Obj()

    try:
        exec(compile_snippet(code), namespace)
    except SyntaxError as error:
        return finish({'type': 'error', 'error': describe(error, kind='syntax')})
    run = namespace.pop(FILE)

    output = []
    if job.get('mode') == 'each':
        for index in range(len(items)):
            set_item(index)
            try:
                result = to_items(run())
            except BaseException as error:  # noqa: B036 - SystemExit and KeyboardInterrupt are the snippet's errors too
                return finish({'type': 'error', 'error': describe(error, index)})
            for item in result:
                item['pairedItem'] = {'item': index}
                output.append(item)
    else:
        set_item(0)
        try:
            output = to_items(run())
        except BaseException as error:  # noqa: B036
            return finish({'type': 'error', 'error': describe(error)})

    try:
        payload = dump(output)
    except (TypeError, ValueError, RecursionError) as error:
        return finish({'type': 'error', 'error': {'kind': 'error', 'name': type(error).__name__, 'message': f"The returned data isn't JSON: {error}"}})
    finish('{"type":"result","items":' + payload + '}')


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:  # noqa: B036
        finish({'type': 'error', 'error': describe(error)})

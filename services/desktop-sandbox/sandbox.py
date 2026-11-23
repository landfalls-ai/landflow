#!/usr/bin/env python3
"""Landflow desktop sandbox: one container is one session (docs/specs/18-desktop-agent-node.md).

  sandbox.py serve   PID 1: starts Xvfb and a window manager, launches the start app, watches windows against the app
                     allow-list, serves the control socket and exits at its deadline or when idle.
  sandbox.py ctl     reads one JSON request on stdin, asks the server on the control socket, prints one JSON reply.
                     The plugin runs it with `docker exec -i`; the container has no network port at all.

Everything the model can do is a member action below. There is no shell, no terminal and no way to start a program that
is not on the allow-list. Arguments reach xdotool one per word, never through a shell.
"""
import base64
import hashlib
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time

SOCK = os.environ.get('SANDBOX_SOCKET', '/tmp/sandbox.sock')
DISPLAY = os.environ.get('DISPLAY', ':99')
WIDTH = int(os.environ.get('SANDBOX_WIDTH', '1280'))
HEIGHT = int(os.environ.get('SANDBOX_HEIGHT', '800'))
WORK = os.path.realpath(os.environ.get('SANDBOX_WORK', '/work'))
MAX_STEPS = int(os.environ.get('SANDBOX_MAX_STEPS', '40'))
DEADLINE = float(os.environ.get('SANDBOX_DEADLINE', '0')) or time.time() + 600
IDLE_SECONDS = float(os.environ.get('SANDBOX_IDLE_SECONDS', '180'))
MAX_FILE = 1024 * 1024

# What an app name in the node's Apps setting starts, and the process names and window classes it owns.
APPS = {
    'browser': {
        'argv': ['firefox-esr', '--no-remote', '--new-instance', '--profile', '/tmp/profile'],
        'procs': {'firefox-esr', 'firefox', 'Web Content', 'GeckoMain', 'Isolated Web Co'},
        'classes': {'firefox-esr', 'firefox', 'navigator'},
    },
    'editor': {'argv': ['mousepad'], 'procs': {'mousepad'}, 'classes': {'mousepad'}},
}
ALLOWED = [a for a in re.split(r'[\s,]+', os.environ.get('SANDBOX_APPS', 'editor')) if a in APPS]
START_APP = os.environ.get('SANDBOX_START_APP', '')
if START_APP not in ALLOWED:
    START_APP = ''

KEY_RE = re.compile(r'^[A-Za-z0-9_+]{1,40}$')
BUTTONS = {'left': '1', 'middle': '2', 'right': '3'}
SCROLL = {'up': '4', 'down': '5', 'left': '6', 'right': '7'}
ENV = {**os.environ, 'DISPLAY': DISPLAY}


class Refused(Exception):
    pass


def run(argv, check=True, data=None, timeout=20):
    p = subprocess.run(argv, env=ENV, input=data, capture_output=True, timeout=timeout)
    if check and p.returncode != 0:
        raise Refused(f"{argv[0]} failed: {p.stderr.decode(errors='replace')[:200]}")
    return p.stdout


def shot_file(pointer):
    path = '/tmp/shot.png'
    run(['scrot', '-o', '-z'] + (['-p'] if pointer else []) + [path])
    with open(path, 'rb') as f:
        return f.read()


def thumb(data):
    try:
        return run(['convert', 'png:-', '-resize', '320x', '-quality', '55', 'jpg:-'], data=data)
    except Exception:
        return b''


def windows():
    """Visible windows as [{id, title, class, pid}]; titles are untrusted screen content."""
    out = []
    ids = run(['xdotool', 'search', '--onlyvisible', '--class', '.'], check=False).decode().split()
    for wid in ids[:40]:
        def q(sub):
            return run(['xdotool', sub, wid], check=False).decode(errors='replace').strip()
        out.append({'id': wid, 'title': q('getwindowname')[:120], 'class': q('getwindowclassname'), 'pid': q('getwindowpid')})
    return out


def proc_name(pid):
    try:
        with open(f'/proc/{pid}/comm') as f:
            return f.read().strip()
    except Exception:
        return ''


def allowed_window(w):
    names, classes = set(), set()
    for a in ALLOWED:
        names |= APPS[a]['procs']
        classes |= APPS[a]['classes']
    if w['pid'].isdigit() and proc_name(w['pid']) in names:
        return True
    return w['class'].lower() in classes


class State:
    def __init__(self):
        self.steps = 0
        self.violations = []
        self.hashes = []  # (action signature, screen hash) after each step
        self.stuck = False
        self.last = time.time()
        self.lock = threading.Lock()
        self.stop = threading.Event()


S = State()


def watch():
    """Close any window that does not belong to an allowed app and record the violation."""
    seen = set()  # a window must be disallowed on two passes in a row (its class can arrive a moment after it maps)
    while not S.stop.is_set():
        try:
            now = set()
            for w in windows():
                if not allowed_window(w):
                    now.add(w['id'])
                    if w['id'] not in seen:
                        continue
                    run(['xdotool', 'windowclose', w['id']], check=False)
                    if w['pid'].isdigit() and proc_name(w['pid']) not in ('', 'openbox'):
                        try:
                            os.kill(int(w['pid']), signal.SIGKILL)
                        except Exception:
                            pass
                    S.violations.append({'at': time.time(), 'class': w['class'], 'title': w['title'], 'closed': True})
            seen = now
        except Exception:
            pass
        S.stop.wait(1.0)


def check_xy(x, y):
    if not (isinstance(x, int) and isinstance(y, int)) or isinstance(x, bool) or isinstance(y, bool):
        raise Refused('x and y must be integers')
    if not (0 <= x < WIDTH and 0 <= y < HEIGHT):
        raise Refused(f'({x}, {y}) is outside the {WIDTH}x{HEIGHT} screen')
    return str(x), str(y)


def xdo(*a):
    run(['xdotool', *map(str, a)])


def to_int(v, default, lo, hi):
    try:
        return max(lo, min(int(v), hi))
    except (TypeError, ValueError):
        return default


def do_action(req):
    a = req.get('action')
    if a == 'screenshot':
        return
    if a == 'click':
        x, y = check_xy(req.get('x'), req.get('y'))
        button = BUTTONS.get(req.get('button', 'left'))
        if not button:
            raise Refused('button is left, middle or right')
        xdo('mousemove', x, y)
        xdo('click', '--repeat', to_int(req.get('count'), 1, 1, 3), '--delay', 80, button)
    elif a == 'move':
        x, y = check_xy(req.get('x'), req.get('y'))
        xdo('mousemove', x, y)
    elif a == 'type':
        text = req.get('text')
        if not isinstance(text, str) or not text:
            raise Refused('text is required')
        if len(text) > 2000:
            raise Refused('text is over 2000 characters')
        run(['xdotool', 'type', '--delay', '12', '--', text], timeout=60)
    elif a == 'key':
        key = req.get('key')
        if not isinstance(key, str) or not KEY_RE.match(key):
            raise Refused('key is a key name such as Return, Tab, ctrl+s, alt+F4')
        xdo('key', '--', key)
    elif a == 'scroll':
        x, y = check_xy(req.get('x', WIDTH // 2), req.get('y', HEIGHT // 2))
        b = SCROLL.get(req.get('direction', 'down'))
        if not b:
            raise Refused('direction is up, down, left or right')
        xdo('mousemove', x, y)
        xdo('click', '--repeat', to_int(req.get('amount'), 3, 1, 30), '--delay', 30, b)
    elif a == 'drag':
        x1, y1 = check_xy(req.get('x'), req.get('y'))
        x2, y2 = check_xy(req.get('x2'), req.get('y2'))
        xdo('mousemove', x1, y1)
        xdo('mousedown', 1)
        xdo('mousemove', x2, y2)
        xdo('mouseup', 1)
    elif a == 'wait':
        time.sleep(to_int(req.get('ms'), 1000, 0, 10000) / 1000)
    elif a == 'launch':
        name = req.get('app')
        if name not in ALLOWED:
            raise Refused(f'{name!r} is not an allowed app (allowed: {", ".join(ALLOWED) or "none"})')
        subprocess.Popen(APPS[name]['argv'], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        time.sleep(1.5)
    else:
        raise Refused(f'unknown action {a!r}')


def safe_path(name):
    p = os.path.realpath(os.path.join(WORK, str(name)))
    if p != WORK and not p.startswith(WORK + os.sep):
        raise Refused('file paths stay inside /work')
    return p


def handle(req):
    a = req.get('action', 'info')
    S.last = time.time()
    if time.time() > DEADLINE:
        return {'ok': False, 'error': 'time limit reached'}
    base = {'width': WIDTH, 'height': HEIGHT}
    if a == 'info':
        return {'ok': True, **base, 'steps': S.steps, 'maxSteps': MAX_STEPS, 'stuck': S.stuck, 'allowed': ALLOWED,
                'violations': S.violations, 'windows': windows(), 'secondsLeft': int(DEADLINE - time.time())}
    if a == 'file_list':
        out = []
        for root, _, files in os.walk(WORK):
            for n in files:
                p = os.path.join(root, n)
                out.append({'path': os.path.relpath(p, WORK), 'size': os.path.getsize(p)})
        return {'ok': True, 'files': out[:200]}
    if a == 'file_get':
        p = safe_path(req.get('path'))
        if not os.path.isfile(p) or os.path.getsize(p) > MAX_FILE:
            raise Refused('no such file, or it is over 1 MB')
        with open(p, 'rb') as f:
            return {'ok': True, 'path': req['path'], 'data': base64.b64encode(f.read()).decode()}
    if a == 'file_put':
        p = safe_path(req.get('path'))
        raw = base64.b64decode(req.get('data', ''))
        if len(raw) > MAX_FILE:
            raise Refused('file is over 1 MB')
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'wb') as f:
            f.write(raw)
        return {'ok': True, 'path': req['path'], 'size': len(raw)}
    # Everything else is a step: counted, limited, and answered with the screen after it.
    if S.stuck:
        return {'ok': False, 'stuck': True, 'error': 'The screen did not change over three different actions: the run is stuck. Stop and report what you see.'}
    if a != 'screenshot':
        if S.steps >= MAX_STEPS:
            return {'ok': False, 'error': f'step budget of {MAX_STEPS} used'}
        S.steps += 1
    before = len(S.violations)
    try:
        do_action(req)
    except Refused as e:
        return {'ok': False, 'error': str(e), 'steps': S.steps}
    except subprocess.TimeoutExpired:
        return {'ok': False, 'error': 'the action timed out', 'steps': S.steps}
    if a != 'screenshot':
        time.sleep(0.4)
        sig = json.dumps({k: req.get(k) for k in ('action', 'x', 'y', 'text', 'key', 'direction', 'app')}, sort_keys=True)
        S.hashes.append((sig, hashlib.sha256(shot_file(False)).hexdigest()))
        last = S.hashes[-3:]
        if len(last) == 3 and len({x[1] for x in last}) == 1 and len({x[0] for x in last}) == 3:
            S.stuck = True
    data = shot_file(True)
    return {
        'ok': True, **base, 'steps': S.steps, 'maxSteps': MAX_STEPS, 'stuck': S.stuck,
        'png': base64.b64encode(data).decode(), 'thumb': base64.b64encode(thumb(data)).decode(),
        'windows': windows(), 'newViolations': S.violations[before:], 'violations': len(S.violations),
    }


def serve():
    for d in (WORK, '/tmp/profile'):
        os.makedirs(d, exist_ok=True)
    xvfb = subprocess.Popen(['Xvfb', DISPLAY, '-screen', '0', f'{WIDTH}x{HEIGHT}x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        if subprocess.run(['xdpyinfo'], env=ENV, capture_output=True).returncode == 0:
            break
        time.sleep(0.1)
    wm = subprocess.Popen(['openbox', '--config-file', '/opt/sandbox/openbox-rc.xml'], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.5)
    prefs = ['browser.shell.checkDefaultBrowser', 'false'], ['browser.aboutwelcome.enabled', 'false'], ['datareporting.policy.dataSubmissionEnabled', 'false']
    lines = [f'user_pref("{k}", {v});' for k, v in prefs]
    lines.append('user_pref("browser.startup.homepage", "about:blank");')
    proxy = os.environ.get('SANDBOX_PROXY')
    if proxy:
        host, _, port = proxy.partition(':')
        lines += ['user_pref("network.proxy.type", 1);', f'user_pref("network.proxy.http", "{host}");', f'user_pref("network.proxy.http_port", {int(port)});',
                  f'user_pref("network.proxy.ssl", "{host}");', f'user_pref("network.proxy.ssl_port", {int(port)});', 'user_pref("network.proxy.no_proxies_on", "");']
    with open('/tmp/profile/user.js', 'w') as f:
        f.write('\n'.join(lines) + '\n')
    if START_APP:
        subprocess.Popen(APPS[START_APP]['argv'], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        for _ in range(100):
            if any(allowed_window(w) for w in windows()):
                break
            time.sleep(0.2)
    threading.Thread(target=watch, daemon=True).start()
    try:
        os.unlink(SOCK)
    except FileNotFoundError:
        pass
    srv = socket.socket(socket.AF_UNIX)
    srv.bind(SOCK)
    srv.listen(4)
    srv.settimeout(1.0)
    S.last = time.time()
    with open('/tmp/ready', 'w') as f:
        f.write('1')
    print('sandbox ready', flush=True)
    while time.time() < DEADLINE and time.time() - S.last < IDLE_SECONDS:
        try:
            c, _ = srv.accept()
        except socket.timeout:
            continue
        with c:
            try:
                buf = b''
                while not buf.endswith(b'\n'):
                    chunk = c.recv(1 << 20)
                    if not chunk:
                        break
                    buf += chunk
                with S.lock:
                    reply = handle(json.loads(buf))
            except Exception as e:  # never take the sandbox down on a bad request
                reply = {'ok': False, 'error': f'{type(e).__name__}: {e}'}
            c.sendall(json.dumps(reply).encode() + b'\n')
    S.stop.set()
    for p in (wm, xvfb):
        p.terminate()
    print('sandbox done (deadline or idle)', flush=True)


def ctl():
    payload = sys.stdin.read().strip() or '{"action":"info"}'
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(120)
    s.connect(SOCK)
    s.sendall(payload.encode() + b'\n')
    buf = b''
    while not buf.endswith(b'\n'):
        chunk = s.recv(1 << 20)
        if not chunk:
            break
        buf += chunk
    sys.stdout.write(buf.decode())


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'serve':
        serve()
    elif cmd == 'ctl':
        ctl()
    else:
        sys.exit('usage: sandbox.py serve|ctl')

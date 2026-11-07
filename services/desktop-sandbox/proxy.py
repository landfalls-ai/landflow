#!/usr/bin/env python3
"""A small allow-list proxy (HTTP and CONNECT) for the desktop sandbox's egress: only the named hosts, everything else 403.

  PROXY_ALLOWED_HOSTS="example.com,*.example.org" proxy.py [port]

The sandbox container sits on an internal Docker network with no route out; this proxy sits on that network and on the
bridge. DNS for the sandbox never leaves it: the proxy resolves the allowed host itself.
"""
import os
import select
import socket
import sys
import threading
from urllib.parse import urlsplit


def parse(text):
    return [h.strip().lower() for h in (text or '').replace(',', ' ').split() if h.strip()]


def allowed(host, patterns):
    host = host.lower().rstrip('.')
    for p in patterns:
        if p.startswith('*.'):
            if host == p[2:] or host.endswith(p[1:]):
                return True
        elif host == p:
            return True
    return False


def pipe(a, b):
    socks = [a, b]
    try:
        while True:
            r, _, _ = select.select(socks, [], [], 60)
            if not r:
                return
            for s in r:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        return


def handle(c, patterns):
    try:
        head = b''
        while b'\r\n\r\n' not in head and len(head) < 65536:
            chunk = c.recv(4096)
            if not chunk:
                return
            head += chunk
        line = head.split(b'\r\n', 1)[0].decode('latin1')
        method, target, _ = line.split(' ', 2)
        if method == 'CONNECT':
            host, _, port = target.rpartition(':')
            port = int(port or 443)
        else:
            u = urlsplit(target)
            host, port = u.hostname or '', u.port or 80
        if not host or not allowed(host, patterns):
            c.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 20\r\nConnection: close\r\n\r\nhost not allow-listed')
            print('deny', host, flush=True)
            return
        up = socket.create_connection((host, port), timeout=15)
        print('allow', host, flush=True)
        if method == 'CONNECT':
            c.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
        else:
            up.sendall(head)
        pipe(c, up)
        up.close()
    except Exception as e:
        print('error', e, flush=True)
    finally:
        c.close()


def main():
    patterns = parse(os.environ.get('PROXY_ALLOWED_HOSTS'))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3128
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('0.0.0.0', port))
    srv.listen(64)
    print('proxy on', port, 'allowing', patterns, flush=True)
    while True:
        c, _ = srv.accept()
        threading.Thread(target=handle, args=(c, patterns), daemon=True).start()


if __name__ == '__main__':
    main()

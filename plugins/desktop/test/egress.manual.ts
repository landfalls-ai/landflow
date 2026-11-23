/** Manual check of the egress boundary against the real image: `LANDFLOW_DESKTOP_DOCKER_CONTEXT=orbstack npx tsx test/egress.manual.ts` */
import { execFileSync } from 'node:child_process';
import { DockerDriver } from '../src/sandbox';

process.env.LANDFLOW_DESKTOP_DOCKER_CONTEXT ??= 'orbstack';
const d = new DockerDriver();
const id = await d.start({ apps: ['browser'], allowedHosts: ['example.org'], maxSteps: 5, timeLimitSeconds: 120, idleSeconds: 60, width: 1280, height: 800 });
const sh = (code: string) => {
  try {
    return execFileSync('docker', ['--context', 'orbstack', 'exec', `landflow-desktop-${id}`, 'python3', '-c', code], { encoding: 'utf8', timeout: 40_000 }).trim();
  } catch (e) {
    return `FAILED: ${String((e as Error).message).split('\n').slice(-2).join(' ').slice(0, 160)}`;
  }
};
const via = (url: string) => `import urllib.request as r;p=r.ProxyHandler({'http':'http://landflow-desktop-proxy-${id}:3128','https':'http://landflow-desktop-proxy-${id}:3128'});o=r.build_opener(p)
try:
    print(o.open(r.Request('${url}',headers={'User-Agent':'Mozilla/5.0'}),timeout=15).status)
except Exception as e:
    print('blocked:',e)`;
console.log('direct to the internet :', sh("import socket\ntry:\n    socket.create_connection(('1.1.1.1',80),timeout=5);print('REACHED')\nexcept Exception as e:\n    print('blocked:',e)"));
console.log('proxy, allowed host    :', sh(via('http://example.org/')));
console.log('proxy, other host      :', sh(via('http://example.com/')));
console.log(execFileSync('docker', ['--context', 'orbstack', 'logs', `landflow-desktop-proxy-${id}`], { encoding: 'utf8' }));
await d.end(id);
console.log('swept after end        :', await d.sweep(true));

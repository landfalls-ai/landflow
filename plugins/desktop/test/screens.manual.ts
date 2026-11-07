/** Manual: real screenshots of the real sandbox. `npx tsx test/screens.manual.ts <outdir>` (Docker context orbstack, image built). */
import { writeFile } from 'node:fs/promises';
import { DockerDriver } from '../src/sandbox';

process.env.LANDFLOW_DESKTOP_DOCKER_CONTEXT ??= 'orbstack';
const out = process.argv[2] ?? '.';
const d = new DockerDriver();
const id = await d.start({ apps: ['editor', 'browser'], startApp: 'editor', allowedHosts: [], maxSteps: 20, timeLimitSeconds: 180, idleSeconds: 60, width: 1280, height: 800 });
const shot = async (name: string, request: Record<string, unknown>) => {
  const r = await d.send(id, request);
  if (r.png) await writeFile(`${out}/desktop-${name}.png`, Buffer.from(r.png, 'base64'));
  console.log(name, r.ok, r.error ?? '', r.steps, r.windows?.map((w) => w.title));
};
try {
  await shot('1-start-editor', { action: 'screenshot' });
  await shot('2-typed', { action: 'click', x: 400, y: 300 });
  await shot('2-typed', { action: 'type', text: 'Typed by xdotool in a disposable, read-only, no-network container.' });
  await shot('3-launch-browser', { action: 'launch', app: 'browser' });
  await shot('4-launch-refused', { action: 'launch', app: 'terminal' });
  console.log(JSON.stringify(await d.send(id, { action: 'info' })).slice(0, 300));
} finally {
  await d.end(id);
}

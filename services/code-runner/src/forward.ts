/**
 * A plain TCP forwarder that publishes the code runner on the Mac (deploy/compose.yml's `code-runner-port`).
 *
 * The runner sits only on an internal network, and Docker publishes no ports for such a container. This sidecar
 * joins that network and an ordinary one, listens on one port and forwards every connection to the runner and
 * nowhere else, so snippets gain no way out through it.
 *
 *   CODE_RUNNER_FORWARD_TARGET=code-runner:7300 CODE_RUNNER_FORWARD_PORT=7300 node dist/forward.mjs
 */
import net from 'node:net';

const target = process.env.CODE_RUNNER_FORWARD_TARGET?.trim() || 'code-runner:7300';
const separator = target.lastIndexOf(':');
const [host, port] = [target.slice(0, separator), Number(target.slice(separator + 1))];
const listen = Number(process.env.CODE_RUNNER_FORWARD_PORT ?? 7300);
if (!host || !Number.isInteger(port)) throw new Error(`CODE_RUNNER_FORWARD_TARGET must be host:port (got "${target}")`);

const server = net.createServer((client) => {
  const upstream = net.connect(port, host);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close).on('close', close);
  upstream.on('error', close).on('close', close);
  client.pipe(upstream).pipe(client);
});
server.listen(listen, '0.0.0.0', () => console.log(`[code-runner-port] :${listen} → ${host}:${port}`));
process.once('SIGTERM', () => server.close(() => process.exit(0)));

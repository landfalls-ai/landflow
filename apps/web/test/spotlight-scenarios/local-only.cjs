'use strict';
/**
 * Spotlight live checks never reach outside this machine (backbone/carryover-sb1.md §0: the httpbin incident).
 *
 * Contract file: backbone/contracts/sb1/local-only.cjs (owner SB00). SB00 copies it byte for byte to
 * apps/web/test/spotlight-scenarios/local-only.cjs; every other package loads it from the contracts folder by its
 * absolute path. Two ways to use it:
 *   - a host:   NODE_OPTIONS="--require <path>/local-only.cjs" npx next start ...  (Next's workers inherit it)
 *   - a test:   require('<path>/local-only.cjs') before anything opens a socket (the scenario suite's live form)
 *
 * It patches net.Socket.prototype.connect (undici's fetch, http, https and tls all connect through it) and dns.lookup,
 * so a connection to any host that is not this machine fails with ECONNREFUSED before a byte leaves, and a lookup of
 * any other name fails with ENOTFOUND. Each refusal is written to stderr as "[local-only] refused <host>:<port>", so a
 * live check greps the host log for it; each process that loads it writes "[local-only] installed in pid <pid>" once.
 * Unix sockets and loopback (localhost, *.localhost, 127.0.0.0/8, ::1) pass.
 */
const net = require('node:net');
const dns = require('node:dns');

const INSTALLED = Symbol.for('landflow.localOnly');

function isLocal(host) {
  if (host === undefined || host === null || host === '') return true; // net's default host is localhost
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'ip6-localhost' || h === 'ip6-loopback') return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

const refused = [];

function refusal(host, port, code) {
  const where = `${host}${port !== undefined && port !== null ? `:${port}` : ''}`;
  refused.push(where);
  process.stderr.write(`[local-only] refused ${where}\n`);
  const error = new Error(`local-only: refused ${where} (a Spotlight live check may only reach this machine)`);
  error.code = code;
  return error;
}

function install() {
  if (globalThis[INSTALLED]) return;
  globalThis[INSTALLED] = true;

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function localOnlyConnect(...args) {
    // net.connect() hands the socket its normalized arguments as [options, callback].
    let first = args[0];
    if (Array.isArray(first)) first = first[0];
    let host;
    let port;
    let path;
    if (first && typeof first === 'object') {
      host = first.host;
      port = first.port;
      path = first.path;
    } else if (typeof first === 'string' && Number.isNaN(Number(first))) {
      path = first;
    } else {
      port = first;
      host = typeof args[1] === 'string' ? args[1] : undefined;
    }
    if (!path && !isLocal(host)) {
      const error = refusal(host, port, 'ECONNREFUSED');
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return connect.apply(this, args);
  };

  const lookup = dns.lookup;
  dns.lookup = function localOnlyLookup(hostname, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    if (!isLocal(hostname) && net.isIP(String(hostname)) === 0) {
      const error = refusal(hostname, undefined, 'ENOTFOUND');
      process.nextTick(() => done(error));
      return {};
    }
    return lookup.apply(this, arguments);
  };

  const promisesLookup = dns.promises.lookup;
  dns.promises.lookup = function localOnlyPromisesLookup(hostname, ...rest) {
    if (!isLocal(hostname) && net.isIP(String(hostname)) === 0) return Promise.reject(refusal(hostname, undefined, 'ENOTFOUND'));
    return promisesLookup.call(this, hostname, ...rest);
  };
  // One line per process, so a live check can see in the host log that the guard is on.
  process.stderr.write(`[local-only] installed in pid ${process.pid}\n`);
}

install();

module.exports = {
  isLocal,
  /** Every host:port refused since the process started, oldest first. */
  refused: () => [...refused],
};

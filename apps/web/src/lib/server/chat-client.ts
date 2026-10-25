/**
 * The browser side of public chats, served as /chat/widget.js: one dependency-free script that renders either the
 * hosted chat page (`data-mode="fullscreen"`, what /chat/<key> loads) or a chat bubble on any site:
 *
 *   <script src="https://landflow.example.com/chat/widget.js" data-workflow="support"></script>
 *
 * `data-workflow` is the trigger's Path or the workflow id. The widget renders in a shadow root (the page's styles
 * don't leak in), talks to /chat/<key>/config, /chat/<key>/session and POST /chat/<key> on the script's own origin
 * (CORS: the trigger's Allowed Origins), keeps the session id in localStorage, streams replies (SSE), shows tool
 * calls as they run, and attaches files when the trigger allows uploads.
 */

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.lf { --bg: #ffffff; --fg: #18181b; --muted: #71717a; --line: #e4e4e7; --bubble: #f4f4f5; --accent: #7c3aed; --accent-fg: #ffffff;
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); }
@media (prefers-color-scheme: dark) { .lf { --bg: #18181b; --fg: #f4f4f5; --muted: #a1a1aa; --line: #3f3f46; --bubble: #27272a; --accent: #a78bfa; --accent-fg: #18181b; } }
.panel { display: flex; flex-direction: column; background: var(--bg); overflow: hidden; }
.fullscreen .panel { position: fixed; inset: 0; }
.window .panel { position: fixed; right: 20px; bottom: 88px; width: min(400px, calc(100vw - 32px)); height: min(600px, calc(100vh - 120px)); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.18); z-index: 2147483000; }
.window .panel[hidden] { display: none; }
.toggle { position: fixed; right: 20px; bottom: 20px; width: 56px; height: 56px; border-radius: 50%; border: 0; background: var(--accent); color: var(--accent-fg); cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.25); z-index: 2147483000; display: grid; place-items: center; }
.toggle svg { width: 26px; height: 26px; }
header { padding: 16px 18px; border-bottom: 1px solid var(--line); display: flex; gap: 12px; align-items: flex-start; }
header .titles { flex: 1; min-width: 0; }
header h1 { margin: 0; font-size: 17px; font-weight: 650; }
header p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
header button { border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 8px; padding: 4px 8px; font: inherit; font-size: 12px; cursor: pointer; }
.fullscreen .inner { width: 100%; max-width: 760px; margin: 0 auto; }
.log { flex: 1; overflow-y: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
.msg { max-width: 85%; padding: 9px 13px; border-radius: 14px; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: anywhere; }
.msg.bot { background: var(--bubble); align-self: flex-start; border-bottom-left-radius: 4px; }
.msg.user { background: var(--accent); color: var(--accent-fg); align-self: flex-end; border-bottom-right-radius: 4px; }
.msg.error { background: #fee2e2; color: #991b1b; align-self: flex-start; }
.msg code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; background: rgba(127,127,127,.15); padding: 1px 4px; border-radius: 4px; }
.msg a { color: inherit; }
.files { font-size: 12px; opacity: .85; margin-top: 4px; }
.tool { align-self: flex-start; font-size: 12px; color: var(--muted); display: flex; gap: 6px; align-items: center; }
.tool::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
.tool.running::before { background: var(--accent); animation: pulse 1s infinite; }
.tool.failed::before { background: #dc2626; }
.typing { align-self: flex-start; color: var(--muted); font-size: 13px; }
@keyframes pulse { 50% { opacity: .3; } }
form { border-top: 1px solid var(--line); padding: 10px 12px; display: flex; gap: 8px; align-items: flex-end; }
textarea { flex: 1; resize: none; border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px; font: inherit; color: var(--fg); background: var(--bg); max-height: 140px; min-height: 40px; }
textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.send, .attach { border: 0; border-radius: 10px; height: 40px; min-width: 40px; padding: 0 12px; cursor: pointer; font: inherit; }
.send { background: var(--accent); color: var(--accent-fg); font-weight: 600; }
.send:disabled { opacity: .5; cursor: default; }
.attach { background: var(--bubble); color: var(--fg); }
.picked { padding: 0 14px 8px; font-size: 12px; color: var(--muted); }
`;

const CLIENT = `(function () {
  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute('data-workflow');
  if (!key) { console.warn('Landflow chat: set data-workflow on the script tag'); return; }
  var mode = script.getAttribute('data-mode') === 'fullscreen' ? 'fullscreen' : 'window';
  var base = new URL(script.src, location.href).origin + '/chat/' + encodeURIComponent(key);
  var storageKey = 'landflow-chat:' + key;
  var STYLE = __STYLE__;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    for (var name in attrs || {}) {
      if (name === 'text') node.textContent = attrs[name];
      else if (name === 'html') node.innerHTML = attrs[name];
      else if (name.slice(0, 2) === 'on') node.addEventListener(name.slice(2), attrs[name]);
      else node.setAttribute(name, attrs[name]);
    }
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }
  function escapeHtml(text) { return String(text).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  /** A little Markdown: code, bold, links. */
  function render(text) {
    return escapeHtml(text)
      .replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>')
      .replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>')
      .replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  }
  function store(value) { try { if (value) localStorage.setItem(storageKey, value); else localStorage.removeItem(storageKey); } catch (e) {} }
  function stored() { try { return localStorage.getItem(storageKey); } catch (e) { return null; } }
  function newId() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^\\w-]/g, ''); }

  var host = el('div', { 'data-landflow-chat': key });
  (mode === 'fullscreen' ? (document.getElementById('landflow-chat') || document.body) : document.body).appendChild(host);
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  root.appendChild(el('style', { text: STYLE }));
  var wrap = el('div', { class: 'lf ' + mode });
  root.appendChild(wrap);

  var config = null;
  var sessionId = stored() || newId();
  var busy = false;
  var picked = [];
  var log, input, sendButton, fileInput, pickedLine, titleNode, subtitleNode;

  function scroll() { log.scrollTop = log.scrollHeight; }
  function bubble(role, text, files) {
    var node = el('div', { class: 'msg ' + role });
    node.innerHTML = render(text || '');
    if (files && files.length) node.appendChild(el('div', { class: 'files', text: '📎 ' + files.map(function (f) { return f.fileName; }).join(', ') }));
    log.appendChild(node);
    scroll();
    return node;
  }
  function toolLine(name, state) {
    var node = el('div', { class: 'tool ' + state, text: (state === 'running' ? 'Using ' : state === 'approval' ? 'Waiting for approval: ' : state === 'failed' ? 'Failed: ' : 'Used ') + name });
    log.appendChild(node);
    scroll();
    return node;
  }
  function setBusy(value) { busy = value; sendButton.disabled = value; }

  function start() {
    log.innerHTML = '';
    (config.initialMessages || []).forEach(function (text) { bubble('bot', text); });
    if (!config.loadPreviousSession || !stored()) return;
    fetch(base + '/session?sessionId=' + encodeURIComponent(sessionId), { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : { messages: [] }; })
      .then(function (data) { (data.messages || []).forEach(function (m) { bubble(m.role === 'assistant' ? 'bot' : 'user', m.text, m.files); }); })
      .catch(function () {});
  }

  function readStream(response, onChunk) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    function pump() {
      return reader.read().then(function (result) {
        if (result.done) { if (buffer.trim()) line(buffer); return; }
        buffer += decoder.decode(result.value, { stream: true });
        var parts = buffer.split('\\n');
        buffer = parts.pop();
        parts.forEach(line);
        return pump();
      });
    }
    function line(text) {
      text = text.trim();
      if (text.indexOf('data:') === 0) text = text.slice(5).trim();
      if (!text) return;
      var chunk;
      try { chunk = JSON.parse(text); } catch (e) { return; }
      onChunk(chunk);
    }
    return pump();
  }

  function send(event) {
    if (event) event.preventDefault();
    var text = input.value.trim();
    if (busy || (!text && !picked.length)) return;
    store(sessionId);
    var files = picked;
    bubble('user', text, files.map(function (f) { return { fileName: f.name }; }));
    input.value = '';
    picked = [];
    pickedLine.textContent = '';
    setBusy(true);
    var typing = el('div', { class: 'typing', text: '…' });
    log.appendChild(typing);
    scroll();
    var body, headers = { accept: config.responseMode === 'streaming' ? 'text/event-stream' : 'application/json' };
    if (files.length) {
      body = new FormData();
      body.append('sessionId', sessionId);
      body.append('message', text);
      files.forEach(function (file) { body.append('files', file, file.name); });
    } else {
      body = JSON.stringify({ sessionId: sessionId, message: text });
      headers['content-type'] = 'application/json';
    }
    var reply = null, streamed = '', tools = {};
    function replyNode() { if (!reply) { typing.remove(); reply = bubble('bot', ''); } return reply; }
    fetch(base, { method: 'POST', body: body, headers: headers, credentials: 'omit' })
      .then(function (response) {
        var type = response.headers.get('content-type') || '';
        if (!response.ok && type.indexOf('json') >= 0) return response.json().then(function (data) { throw new Error(data.error || ('HTTP ' + response.status)); });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        if (type.indexOf('event-stream') >= 0 || type.indexOf('ndjson') >= 0) {
          return readStream(response, function (chunk) {
            if (chunk.type === 'item' && chunk.content) { streamed += chunk.content; replyNode().innerHTML = render(streamed); scroll(); }
            else if (chunk.type === 'tool' && chunk.tool) {
              var known = tools[chunk.tool.id];
              var state = chunk.tool.status === 'started' ? 'running' : chunk.tool.status;
              if (known) { known.className = 'tool ' + state; known.textContent = (state === 'failed' ? 'Failed: ' : state === 'approval' ? 'Waiting for approval: ' : 'Used ') + chunk.tool.name; }
              else tools[chunk.tool.id] = toolLine(chunk.tool.name, state);
            } else if (chunk.type === 'done') {
              if (chunk.status === 'error') throw new Error((chunk.error && chunk.error.message) || 'Something went wrong');
              var output = typeof chunk.output === 'string' ? chunk.output : '';
              if (output) { streamed = output; replyNode().innerHTML = render(output); }
              else if (!streamed) replyNode().innerHTML = render(chunk.status === 'waiting' ? 'Waiting for someone to approve a step…' : '(no reply)');
            }
          });
        }
        return response.json().then(function (data) { replyNode().innerHTML = render(typeof data.output === 'string' ? data.output : JSON.stringify(data.output)); });
      })
      .catch(function (error) { typing.remove(); bubble('error', error.message || 'Could not reach the chat'); })
      .then(function () { typing.remove(); setBusy(false); scroll(); input.focus(); });
  }

  function build() {
    titleNode = el('h1', { text: config.title || '' });
    subtitleNode = config.subtitle ? el('p', { text: config.subtitle }) : null;
    var reset = el('button', { type: 'button', text: 'New chat', title: 'Start a new conversation', onclick: function () { sessionId = newId(); store(null); start(); } });
    log = el('div', { class: 'log', role: 'log', 'aria-live': 'polite' });
    input = el('textarea', { rows: '1', placeholder: config.inputPlaceholder || 'Type your question…', 'aria-label': 'Message' });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) send(e); });
    sendButton = el('button', { class: 'send', type: 'submit', text: 'Send' });
    pickedLine = el('div', { class: 'picked' });
    var controls = [input];
    if (config.allowFileUploads) {
      fileInput = el('input', { type: 'file', multiple: 'multiple', accept: config.allowedFilesMimeTypes || '', hidden: 'hidden', onchange: function () {
        picked = Array.prototype.slice.call(fileInput.files || []);
        pickedLine.textContent = picked.length ? '📎 ' + picked.map(function (f) { return f.name; }).join(', ') : '';
        fileInput.value = '';
      } });
      controls.unshift(el('button', { class: 'attach', type: 'button', title: 'Attach files', 'aria-label': 'Attach files', text: '📎', onclick: function () { fileInput.click(); } }), fileInput);
    }
    controls.push(sendButton);
    var panel = el('div', { class: 'panel' }, [
      el('div', { class: 'inner', style: 'display:flex;flex-direction:column;height:100%;min-height:0' }, [
        el('header', {}, [el('div', { class: 'titles' }, [titleNode, subtitleNode]), reset]),
        log,
        pickedLine,
        el('form', { onsubmit: send }, controls),
      ]),
    ]);
    if (mode === 'window') {
      panel.hidden = true;
      var icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      var toggle = el('button', { class: 'toggle', type: 'button', 'aria-label': 'Open chat', html: icon, onclick: function () { panel.hidden = !panel.hidden; if (!panel.hidden) input.focus(); } });
      wrap.appendChild(toggle);
      if (script.getAttribute('data-open') === 'true') panel.hidden = false;
    } else document.title = config.title || document.title;
    wrap.appendChild(panel);
    start();
  }

  fetch(base + '/config', { credentials: 'omit' })
    .then(function (r) { if (!r.ok) throw new Error('This chat is not available'); return r.json(); })
    .then(function (data) { config = data; build(); })
    .catch(function (error) {
      if (mode === 'fullscreen') wrap.appendChild(el('div', { class: 'panel' }, [el('div', { class: 'log' }, [el('div', { class: 'msg error', text: error.message })])]));
      else console.warn('Landflow chat:', error.message);
    });
})();
`;

/** The script served at /chat/widget.js. */
export const CHAT_CLIENT_JS = CLIENT.replace('__STYLE__', JSON.stringify(STYLE));

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** The hosted chat page: the same script, full screen. */
export function chatPageHtml(options: { key: string; title: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)}</title>
<style>html,body{margin:0;height:100%;background:#fff}@media (prefers-color-scheme: dark){html,body{background:#18181b}}</style>
</head>
<body>
<div id="landflow-chat"></div>
<script src="/chat/widget.js" data-workflow="${escapeHtml(options.key)}" data-mode="fullscreen"></script>
</body>
</html>`;
}

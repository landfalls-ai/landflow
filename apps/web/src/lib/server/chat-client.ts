/**
 * The browser side of public chats, served as /chat/widget.js: one dependency-free script that renders either the
 * hosted chat page (`data-mode="fullscreen"`, what /chat/<key> loads) or a chat bubble on any site:
 *
 *   <script src="https://landflow.example.com/chat/widget.js" data-workflow="support"></script>
 *
 * `data-workflow` is the trigger's Path or the workflow id. The widget renders in a shadow root (the page's styles
 * don't leak in), talks to /chat/<key>/config, /chat/<key>/session and POST /chat/<key> on the script's own origin
 * (CORS: the trigger's Allowed Origins), keeps the session id in localStorage, streams replies (SSE), shows tool
 * calls as they run, and attaches files when the trigger allows uploads. For a chat with Basic Auth it shows a sign-in
 * form and sends the credentials as an Authorization header (kept in sessionStorage: gone when the tab closes). Each
 * answer has thumbs up/down buttons (a thumbs down also asks for an optional comment), and the trigger's Custom CSS
 * (sanitized by the server) is added to the shadow root after the built-in styles.
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
.who { align-self: flex-start; display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); margin-bottom: -6px; }
.who .face { width: 20px; height: 20px; border-radius: 50%; background: var(--bubble); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; }
.ask { align-self: flex-start; font-size: 12px; color: var(--muted); font-style: italic; }
.typing { align-self: flex-start; color: var(--muted); font-size: 13px; }
@keyframes pulse { 50% { opacity: .3; } }
form { border-top: 1px solid var(--line); padding: 10px 12px; display: flex; gap: 8px; align-items: flex-end; }
textarea { flex: 1; resize: none; border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px; font: inherit; color: var(--fg); background: var(--bg); max-height: 140px; min-height: 40px; }
textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.send, .attach { border: 0; border-radius: 10px; height: 40px; min-width: 40px; padding: 0 12px; cursor: pointer; font: inherit; }
.send { background: var(--accent); color: var(--accent-fg); font-weight: 600; }
.send:disabled { opacity: .5; cursor: default; }
.attach { background: var(--bubble); color: var(--fg); }
.roster { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 0; border-top: 1px solid var(--line); }
.roster .hint { width: 100%; font-size: 12px; color: var(--muted); }
.chip { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 14px; border: 1px solid var(--line); border-radius: 20px; background: var(--bubble); color: var(--fg); font: inherit; cursor: pointer; }
.chip .face { width: 22px; height: 22px; border-radius: 50%; background: var(--bg); display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; }
.chip[aria-pressed="true"] { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
@media (max-width: 600px) { .roster { flex-direction: column; } .chip { width: 100%; min-height: 48px; font-size: 15px; } }
.picked { padding: 0 14px 8px; font-size: 12px; color: var(--muted); }
.fb { align-self: flex-start; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: -4px; }
.thumb { border: 1px solid transparent; background: transparent; border-radius: 8px; padding: 2px 7px; cursor: pointer; font: inherit; font-size: 13px; color: var(--muted); opacity: .7; }
.thumb:hover, .thumb.on { opacity: 1; background: var(--bubble); border-color: var(--line); }
.fbnote { display: flex; gap: 6px; align-items: center; width: 100%; }
.fbnote input { flex: 1; min-width: 0; border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; font: inherit; font-size: 12.5px; color: var(--fg); background: var(--bg); }
.fb [hidden] { display: none; }
.thanks { font-size: 12px; color: var(--muted); }
.signin { display: flex; flex-direction: column; align-items: stretch; gap: 10px; padding: 18px; border-top: 0; }
.signin p { margin: 0; color: var(--muted); }
.signin input { border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px; font: inherit; color: var(--fg); background: var(--bg); }
.signin input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.signin button { border: 0; border-radius: 10px; height: 40px; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; }
.signin .err { color: #b91c1c; font-size: 13px; }
`;

const CLIENT = `(function () {
  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute('data-workflow');
  if (!key) { console.warn('Landflow chat: set data-workflow on the script tag'); return; }
  var mode = script.getAttribute('data-mode') === 'fullscreen' ? 'fullscreen' : 'window';
  var base = new URL(script.src, location.href).origin + '/chat/' + encodeURIComponent(key);
  var storageKey = 'landflow-chat:' + key;
  var authKey = 'landflow-chat-auth:' + key;
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
  /** The Basic Auth header, once someone signed in (the page session only: sessionStorage, never localStorage). */
  var authHeader = (function () { try { return sessionStorage.getItem(authKey) || ''; } catch (e) { return ''; } })();
  function setAuth(value) { authHeader = value || ''; try { if (authHeader) sessionStorage.setItem(authKey, authHeader); else sessionStorage.removeItem(authKey); } catch (e) {} }
  function basic(user, password) { return 'Basic ' + btoa(unescape(encodeURIComponent(user + ':' + password))); }
  /** fetch against this chat, with the Authorization header when signed in (same-origin cookies only, never other sites'). */
  function request(path, options) {
    options = options || {};
    var headers = options.headers || {};
    if (authHeader) headers.authorization = authHeader;
    options.headers = headers;
    options.credentials = 'same-origin';
    return fetch(base + path, options);
  }
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
  var agentKey = '';
  var log, input, sendButton, fileInput, pickedLine, titleNode, subtitleNode, panelNode;
  var customStyle = null;
  function applyCss(css) {
    if (!customStyle) { customStyle = el('style'); root.appendChild(customStyle); }
    customStyle.textContent = css || '';
  }

  function scroll() { log.scrollTop = log.scrollHeight; }
  /** Who answers, above a bubble: a face (an emoji, else the first letter of the name) and the name. */
  function who(agent) {
    var face = typeof agent.face === 'string' && agent.face && !/^(https?:|data:|\\/)/.test(agent.face) ? agent.face : String(agent.name).charAt(0).toUpperCase();
    return el('div', { class: 'who' }, [el('span', { class: 'face', text: face }), el('span', { text: String(agent.name) })]);
  }
  function bubble(role, text, files, agent) {
    if (role === 'bot' && agent && agent.name) log.appendChild(who(agent));
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
  /** Thumbs up/down under an answer; a thumbs down offers a comment. Pressing the chosen thumb again takes the rating back. */
  function feedbackRow(executionId, current) {
    var rating = current && current.rating || null;
    var up = el('button', { class: 'thumb', type: 'button', title: 'Good answer', 'aria-label': 'Good answer', text: '\ud83d\udc4d' });
    var down = el('button', { class: 'thumb', type: 'button', title: 'Bad answer', 'aria-label': 'Bad answer', text: '\ud83d\udc4e' });
    var field = el('input', { type: 'text', maxlength: '2000', placeholder: 'Tell us more (optional)', 'aria-label': 'Comment' });
    var thanks = el('span', { class: 'thanks' });
    var note = el('div', { class: 'fbnote' }, [field, el('button', { class: 'thumb', type: 'button', text: 'Send', onclick: function () { send(rating, field.value); } })]);
    var row = el('div', { class: 'fb' }, [up, down, thanks, note]);
    function paint() {
      up.className = 'thumb' + (rating === 'up' ? ' on' : '');
      down.className = 'thumb' + (rating === 'down' ? ' on' : '');
      up.setAttribute('aria-pressed', String(rating === 'up'));
      down.setAttribute('aria-pressed', String(rating === 'down'));
      note.hidden = true;
    }
    function send(value, comment) {
      var body = { sessionId: sessionId, executionId: executionId, rating: value };
      if (comment) body.comment = comment;
      request('/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); rating = value; paint(); thanks.textContent = value ? 'Thanks for the feedback' : ''; })
        .catch(function () { thanks.textContent = 'Could not send feedback'; });
    }
    function choose(value) {
      if (rating === value) return send(null);
      send(value);
      if (value === 'down') { note.hidden = false; field.focus(); }
    }
    up.addEventListener('click', function () { choose('up'); });
    down.addEventListener('click', function () { choose('down'); });
    paint();
    log.appendChild(row);
    scroll();
    return row;
  }
  function setBusy(value) { busy = value; sendButton.disabled = value; }

  function start() {
    log.innerHTML = '';
    (config.initialMessages || []).forEach(function (text) { bubble('bot', text); });
    if (!config.loadPreviousSession || !stored()) return;
    request('/session?sessionId=' + encodeURIComponent(sessionId))
      .then(function (r) { return r.ok ? r.json() : { messages: [] }; })
      .then(function (data) { (data.messages || []).forEach(function (m) { bubble(m.role === 'assistant' ? 'bot' : 'user', m.text, m.files, m.agentName ? { id: m.agentKey, name: m.agentName } : null); if (m.role === 'assistant' && m.executionId) feedbackRow(m.executionId, m.feedback); }); })
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
      if (agentKey) body.append('agentKey', agentKey);
      files.forEach(function (file) { body.append('files', file, file.name); });
    } else {
      var payload = { sessionId: sessionId, message: text };
      if (agentKey) payload.agentKey = agentKey;
      body = JSON.stringify(payload);
      headers['content-type'] = 'application/json';
    }
    var reply = null, streamed = '', tools = {}, answerId = '', speaker = null, anyLabel = false;
    function replyNode() { if (!reply) { typing.remove(); reply = bubble('bot', '', null, speaker); } return reply; }
    /** A delegation (a tool call with a reason) reads "asked <Agent>: <reason>". */
    function askLine(name, reason) {
      var node = el('div', { class: 'ask', text: 'asked ' + String(name).replace(/_/g, ' ') + ': ' + reason });
      log.appendChild(node);
      scroll();
      return node;
    }
    request('', { method: 'POST', body: body, headers: headers })
      .then(function (response) {
        var type = response.headers.get('content-type') || '';
        if (response.status === 401) { setAuth(''); showSignIn(null, 'Your sign-in no longer works. Sign in again.'); throw new Error('Sign in to use this chat'); }
        if (!response.ok && type.indexOf('json') >= 0) return response.json().then(function (data) { throw new Error(data.error || ('HTTP ' + response.status)); });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        if (type.indexOf('event-stream') >= 0 || type.indexOf('ndjson') >= 0) {
          return readStream(response, function (chunk) {
            if (chunk.type === 'item' && chunk.content) {
              if (chunk.agent && chunk.agent.name) anyLabel = true;
              // Once agents are labelled, a change of speaker starts a new bubble.
              if (anyLabel && reply && (chunk.agent ? chunk.agent.id : '') !== (speaker ? speaker.id : '')) { reply = null; streamed = ''; }
              speaker = chunk.agent && chunk.agent.name ? chunk.agent : null;
              streamed += chunk.content; replyNode().innerHTML = render(streamed); scroll(); }
            else if (chunk.type === 'tool' && chunk.tool) {
              var known = tools[chunk.tool.id];
              var reason = chunk.tool.input && typeof chunk.tool.input.reason === 'string' ? chunk.tool.input.reason : '';
              if (known && known.className === 'ask') { if (chunk.tool.status === 'failed' && known.textContent.indexOf('(failed)') < 0) known.textContent += ' (failed)'; return; }
              if (!known && reason) { tools[chunk.tool.id] = askLine(chunk.tool.name, reason); return; }
              var state = chunk.tool.status === 'started' ? 'running' : chunk.tool.status;
              if (known) { known.className = 'tool ' + state; known.textContent = (state === 'failed' ? 'Failed: ' : state === 'approval' ? 'Waiting for approval: ' : 'Used ') + chunk.tool.name; }
              else tools[chunk.tool.id] = toolLine(chunk.tool.name, state);
            } else if (chunk.type === 'done') {
              if (chunk.executionId) answerId = chunk.executionId;
              if (chunk.status === 'error') throw new Error((chunk.error && chunk.error.message) || 'Something went wrong');
              var output = typeof chunk.output === 'string' ? chunk.output : '';
              if (output) { streamed = output; replyNode().innerHTML = render(output); }
              else if (!streamed) replyNode().innerHTML = render(chunk.status === 'waiting' ? 'Waiting for someone to approve a step…' : '(no reply)');
            }
          });
        }
        return response.json().then(function (data) { if (data.executionId) answerId = data.executionId; replyNode().innerHTML = render(typeof data.output === 'string' ? data.output : JSON.stringify(data.output)); });
      })
      .catch(function (error) { typing.remove(); bubble('error', error.message || 'Could not reach the chat'); })
      .then(function () { typing.remove(); if (reply && answerId) feedbackRow(answerId); setBusy(false); scroll(); input.focus(); });
  }

  var inner = null;
  var signInfo = null;
  /** The panel (and the bubble that opens it, in window mode), created once; returns its emptied content area. */
  function frame() {
    if (inner) { inner.textContent = ''; return inner; }
    inner = el('div', { class: 'inner', style: 'display:flex;flex-direction:column;height:100%;min-height:0' });
    var panel = el('div', { class: 'panel' }, [inner]);
    if (mode === 'window') {
      panel.hidden = true;
      var icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
      var toggle = el('button', { class: 'toggle', type: 'button', 'aria-label': 'Open chat', html: icon, onclick: function () { panel.hidden = !panel.hidden; if (!panel.hidden && input) input.focus(); } });
      wrap.appendChild(toggle);
      if (script.getAttribute('data-open') === 'true') panel.hidden = false;
    }
    wrap.appendChild(panel);
    return inner;
  }

  /** The sign-in form of a chat with Basic Auth: the credentials go out as an Authorization header, nothing else. */
  function showSignIn(info, message) {
    signInfo = info || signInfo || config || {};
    if (signInfo.customCss) applyCss(signInfo.customCss);
    var area = frame();
    var user = el('input', { type: 'text', autocomplete: 'username', placeholder: 'User', 'aria-label': 'User' });
    var pass = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password', 'aria-label': 'Password' });
    var err = el('div', { class: 'err', role: 'alert', text: message || '' });
    var form = el('form', { class: 'signin', onsubmit: function (e) {
      e.preventDefault();
      if (!user.value) return;
      setAuth(basic(user.value, pass.value));
      load(function (text) { err.textContent = text; pass.value = ''; });
    } }, [el('p', { text: 'Sign in to use this chat.' }), user, pass, err, el('button', { type: 'submit', text: 'Sign in' })]);
    area.appendChild(el('header', {}, [el('div', { class: 'titles' }, [el('h1', { text: signInfo.title || 'Sign in' }), signInfo.subtitle ? el('p', { text: signInfo.subtitle }) : null])]));
    area.appendChild(form);
    if (mode === 'fullscreen') document.title = signInfo.title || document.title;
    setTimeout(function () { user.focus(); }, 0);
  }

  function build() {
    titleNode = el('h1', { text: config.title || '' });
    subtitleNode = config.subtitle ? el('p', { text: config.subtitle }) : null;
    var reset = el('button', { type: 'button', text: 'New chat', title: 'Start a new conversation', onclick: function () { sessionId = newId(); store(null); start(); } });
    var buttons = [reset];
    if (authHeader) buttons.push(el('button', { type: 'button', text: 'Sign out', title: 'Forget the password', onclick: function () { setAuth(''); showSignIn(signInfo || config); } }));
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
    var rosterRow = null;
    if (config.agents && config.agents.length) {
      rosterRow = el('div', { class: 'roster', role: 'group', 'aria-label': 'Who do you want to ask?' });
      var chips = config.agents.map(function (agent) {
        var face = typeof agent.face === 'string' && agent.face ? agent.face : String(agent.label).charAt(0).toUpperCase();
        var chip = el('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', 'data-agent': agent.key }, [el('span', { class: 'face', text: face }), el('span', { text: agent.label })]);
        chip.addEventListener('click', function () { agentKey = agentKey === agent.key ? '' : agent.key; chips.forEach(function (c) { c.setAttribute('aria-pressed', String(c.getAttribute('data-agent') === agentKey)); }); input.focus(); });
        return chip;
      });
      chips.forEach(function (chip) { rosterRow.appendChild(chip); });
    }
    var area = frame();
    [el('header', {}, [el('div', { class: 'titles' }, [titleNode, subtitleNode]), el('div', { style: 'display:flex;gap:6px' }, buttons)]), log, rosterRow, pickedLine, el('form', { onsubmit: send }, controls)].forEach(function (node) { if (node) area.appendChild(node); });
    if (mode === 'fullscreen') document.title = config.title || document.title;
    applyCss(config.customCss);
    start();
  }

  /** Load the config; a 401 means Basic Auth: show the sign-in form (onFail gets the message when a sign-in attempt failed). */
  function load(onFail) {
    request('/config')
      .then(function (r) {
        if (r.status === 401) {
          return r.json().catch(function () { return {}; }).then(function (data) {
            if (authHeader) { setAuth(''); if (onFail) { onFail('Wrong user or password'); return; } }
            showSignIn(data, '');
          });
        }
        if (!r.ok) throw new Error('This chat is not available');
        return r.json().then(function (data) { config = data; build(); });
      })
      .catch(function (error) {
        if (mode === 'fullscreen') wrap.appendChild(el('div', { class: 'panel' }, [el('div', { class: 'log' }, [el('div', { class: 'msg error', text: error.message })])]));
        else console.warn('Landflow chat:', error.message);
      });
  }
  load();
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

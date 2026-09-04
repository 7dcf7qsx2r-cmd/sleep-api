export const IOT_WATCH_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>小眠 · MQTT 监听</title>
  <style>
    :root {
      --bg: #071018;
      --panel: #0f1c28;
      --line: #1e3346;
      --text: #e8f1f8;
      --muted: #8aa0b5;
      --idle: #7d93a8;
      --occ: #3ee0a3;
      --cmd: #7ab8ff;
      --ota: #ffb547;
      --sleep: #c9a6ff;
      --other: #9fb3c8;
      --danger: #ff7b7b;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; }
    body { display: flex; flex-direction: column; }
    header {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 12px 16px; border-bottom: 1px solid var(--line); background: #0b1620;
    }
    h1 { margin: 0; font-size: 16px; font-weight: 650; }
    .muted { color: var(--muted); }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    input, select, button {
      background: var(--panel); color: var(--text); border: 1px solid var(--line);
      border-radius: 8px; padding: 8px 10px; font: inherit;
    }
    button { cursor: pointer; }
    button.primary { background: #1d4d3b; border-color: #2e7a5c; }
    button:disabled { opacity: .55; cursor: default; }
    main { flex: 1; display: grid; grid-template-rows: auto 1fr; min-height: 0; }
    .toolbar { padding: 10px 16px; border-bottom: 1px solid var(--line); }
    .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .chip {
      border: 1px solid var(--line); border-radius: 999px; padding: 5px 10px; cursor: pointer;
      background: var(--panel); color: var(--text);
    }
    .chip.on { border-color: #3ee0a3; color: var(--occ); }
    .chip .dot, .hit .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; background: #44586a; }
    .chip .dot.live, .hit .dot.live { background: var(--occ); }
    .hits { margin-top: 8px; display: grid; gap: 6px; max-height: 240px; overflow: auto; }
    .hit {
      display: block; width: 100%; text-align: left; border: 1px solid var(--line);
      border-radius: 10px; padding: 8px 10px; background: var(--panel); color: var(--text);
    }
    .hit.on { border-color: #3ee0a3; }
    .hit .acc { color: var(--muted); font-size: 12px; margin-top: 2px; }
    input#q { min-width: 240px; flex: 1; }
    .status {
      padding: 10px 16px; border-bottom: 1px solid var(--line);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
    }
    .log {
      margin: 0; padding: 12px 16px; overflow: auto; min-height: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
      white-space: pre-wrap; word-break: break-all;
    }
    .line { padding: 1px 0; color: var(--other); }
    .line.idle { color: var(--idle); }
    .line.occupied { color: var(--occ); }
    .line.command { color: var(--cmd); }
    .line.ota { color: var(--ota); }
    .line.sleep { color: var(--sleep); }
    .err { color: var(--danger); }
    #login {
      position: fixed; inset: 0; display: grid; place-items: center; background: rgba(4,10,16,.86);
    }
    #login.hidden { display: none; }
    .card { width: min(360px, 92vw); background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 20px; }
    .card h2 { margin: 0 0 12px; font-size: 18px; }
    .card label { display: block; margin: 10px 0 6px; color: var(--muted); }
    .card input { width: 100%; }
    .card button { width: 100%; margin-top: 14px; }
    .remember { display: flex; align-items: center; gap: 8px; margin-top: 12px; color: var(--muted); }
    .remember input { width: auto; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>MQTT 实时监听</h1>
      <div class="muted">只读云端入库包 · 不抢 MQTT 桥接</div>
    </div>
    <div class="row">
      <span id="who" class="muted"></span>
      <button id="logout">退出</button>
    </div>
  </header>
  <main>
    <div class="toolbar">
      <div class="row">
        <input id="sn" placeholder="设备 SN" size="18" />
        <button id="start" class="primary">开始监听</button>
        <button id="pause">暂停</button>
        <button id="clear">清屏</button>
        <span id="meta" class="muted"></span>
      </div>
      <div class="row" style="margin-top:8px">
        <input id="q" placeholder="搜设备 SN / 手机号 / 微信号 / 昵称" />
        <button id="search">搜索</button>
      </div>
      <div id="hits" class="hits"></div>
      <div id="chips" class="chips"></div>
    </div>
    <div id="status" class="status muted">等待开始…</div>
    <div id="sleep" class="status muted"></div>
    <pre id="log" class="log"></pre>
  </main>
  <div id="login">
    <form class="card" id="loginForm">
      <h2>运营登录</h2>
      <p class="muted">使用小眠后台账号。数据仅管理员可见。</p>
      <label>用户名</label>
      <input id="user" autocomplete="username" />
      <label>密码</label>
      <input id="pass" type="password" autocomplete="current-password" />
      <label class="remember"><input id="remember" type="checkbox" checked /> 记住账号密码</label>
      <button class="primary" type="submit">进入监听</button>
      <p id="loginErr" class="err"></p>
    </form>
  </div>
  <script>
    const API_BASE = location.hostname === 'api.xmianai.com' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      ? '' : 'https://api.xmianai.com';
    const TOKEN_KEY = 'sleep_admin_token';
    const CRED_KEY = 'iot_watch_cred';
    const logEl = document.getElementById('log');
    const statusEl = document.getElementById('status');
    const sleepEl = document.getElementById('sleep');
    const metaEl = document.getElementById('meta');
    const chipsEl = document.getElementById('chips');
    const hitsEl = document.getElementById('hits');
    const snEl = document.getElementById('sn');
    const qEl = document.getElementById('q');
    const loginEl = document.getElementById('login');
    const loginErr = document.getElementById('loginErr');
    let token = localStorage.getItem(TOKEN_KEY) || '';
    let afterId = '0';
    let timer = 0;
    let paused = false;
    let currentSn = '';
    let sleepPolls = 0;

    function hm(mins) {
      mins = Number(mins) || 0;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return h ? (h + 'h' + String(m).padStart(2, '0') + 'm') : (m + 'm');
    }

    function clock(iso) {
      if (!iso) return '--';
      try {
        return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
      } catch (e) { return '--'; }
    }

    async function refreshSleep() {
      if (!currentSn || !sleepEl) return;
      try {
        const data = await api('/admin/iot-watch/sleep-summary?sn=' + encodeURIComponent(currentSn));
        const s = data.summary;
        if (!s || !s.durationMinutes) {
          sleepEl.textContent = '睡眠估计  尚无入睡（枕头 30s epoch，最多 3 天）';
          return;
        }
        sleepEl.textContent =
          '睡眠估计 ' + s.nightDate +
          ' 估 ' + hm(s.durationMinutes) +
          '  入睡 ' + clock(s.sleepStart) +
          ' 起 ' + clock(s.sleepEnd) +
          '  深 ' + hm(s.deepMinutes) +
          ' 浅 ' + hm(s.lightMinutes) +
          ' 醒 ' + hm(s.awakeMinutes) +
          ' ×' + (s.awakenings || 0) +
          '  置信 ' + s.confidence;
      } catch (e) {
        sleepEl.textContent = '';
      }
    }

    function api(path, opts) {
      opts = opts || {};
      const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      if (token) headers.Authorization = 'Bearer ' + token;
      return fetch(API_BASE + path, Object.assign({}, opts, { headers })).then(async (res) => {
        const data = await res.json().catch(function () { return {}; });
        if (res.status === 401) {
          token = '';
          localStorage.removeItem(TOKEN_KEY);
          loginEl.classList.remove('hidden');
          throw new Error(data.message || '请先登录');
        }
        if (!res.ok) throw new Error(data.message || ('请求失败 ' + res.status));
        return data;
      });
    }

    function fmtTime(iso) {
      try {
        return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
      } catch (e) { return iso; }
    }

    function append(msg) {
      const line = document.createElement('div');
      line.className = 'line ' + (msg.highlight || 'other');
      line.textContent = '[' + fmtTime(msg.receivedAt) + '] ' + msg.shortTopic + '  ' + (msg.summary || '');
      logEl.appendChild(line);
      if (logEl.childNodes.length > 800) logEl.removeChild(logEl.firstChild);
      if (!paused) logEl.scrollTop = logEl.scrollHeight;
      if (msg.summary) statusEl.textContent = msg.shortTopic + '  ' + msg.summary;
      statusEl.className = 'status ' + (msg.highlight || '');
    }

    function setMeta(text) { metaEl.textContent = text; }

    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function shortId(s) {
      if (!s) return '';
      if (s.length <= 18) return s;
      return s.slice(0, 8) + '…' + s.slice(-6);
    }

    function accountLine(d) {
      if (!d.bound) return '未绑定账号';
      const bits = [];
      if (d.nickname) bits.push(d.nickname);
      else if (d.username) bits.push(d.username);
      if (d.phone) bits.push(d.phone);
      if (d.wechatUnionId) bits.push('union ' + shortId(d.wechatUnionId));
      else if (d.wechatOpenId) bits.push('openid ' + shortId(d.wechatOpenId));
      return bits.length ? '绑定：' + bits.join(' · ') : '已绑定';
    }

    function renderHits(items) {
      hitsEl.innerHTML = '';
      if (!items || !items.length) {
        if (qEl.value.trim()) hitsEl.innerHTML = '<div class="muted">没有匹配的设备或绑定账号</div>';
        return;
      }
      items.forEach(function (d) {
        const b = document.createElement('button');
        b.className = 'hit' + (d.sn === snEl.value ? ' on' : '');
        b.innerHTML = '<div><span class="dot' + (d.online ? ' live' : '') + '"></span>' +
          esc(d.label) + ' <strong>' + esc(d.sn) + '</strong>' +
          (d.alias ? ' · ' + esc(d.alias) : '') + '</div>' +
          '<div class="acc">' + esc(accountLine(d)) + '</div>';
        b.onclick = function () {
          snEl.value = d.sn;
          startWatch();
        };
        hitsEl.appendChild(b);
      });
    }

    async function searchDevices() {
      const q = (qEl.value || '').trim();
      const data = await api('/admin/iot-watch/search?q=' + encodeURIComponent(q));
      renderHits(data.items || []);
    }

    function loadCred() {
      try {
        const raw = localStorage.getItem(CRED_KEY);
        if (!raw) {
          document.getElementById('user').value = 'admin';
          return false;
        }
        const c = JSON.parse(raw);
        document.getElementById('user').value = c.username || 'admin';
        document.getElementById('pass').value = c.password || '';
        document.getElementById('remember').checked = true;
        return Boolean(c.username && c.password);
      } catch (e) {
        document.getElementById('user').value = 'admin';
        return false;
      }
    }

    function saveCred(username, password) {
      if (document.getElementById('remember').checked) {
        localStorage.setItem(CRED_KEY, JSON.stringify({ username: username, password: password }));
      } else {
        localStorage.removeItem(CRED_KEY);
      }
    }

    async function loginWith(username, password) {
      const data = await api('/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: username, password: password }),
      });
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      saveCred(username, password);
      await boot(true);
    }

    async function loadDevices() {
      const data = await api('/admin/iot-watch/devices');
      chipsEl.innerHTML = '';
      (data.devices || []).forEach(function (d) {
        const b = document.createElement('button');
        b.className = 'chip' + (d.sn === snEl.value ? ' on' : '');
        b.innerHTML = '<span class="dot' + (d.online ? ' live' : '') + '"></span>' + d.label + ' ' + d.sn;
        b.onclick = function () {
          snEl.value = d.sn;
          startWatch();
        };
        chipsEl.appendChild(b);
      });
    }

    async function poll() {
      if (paused || !currentSn) return;
      try {
        const data = await api('/admin/iot-watch/messages?sn=' + encodeURIComponent(currentSn) + '&afterId=' + encodeURIComponent(afterId));
        const msgs = data.messages || [];
        msgs.forEach(function (m) {
          afterId = m.id;
          append(m);
        });
        setMeta(currentSn + (msgs.length ? '  +' + msgs.length : '  等待新包') + (paused ? '  已暂停' : ''));
        sleepPolls += 1;
        if (sleepPolls === 1 || sleepPolls % 10 === 0) refreshSleep().catch(function () {});
      } catch (e) {
        setMeta(e.message || String(e));
      }
    }

    async function startWatch() {
      currentSn = (snEl.value || '').trim().toUpperCase();
      if (!currentSn) return;
      afterId = '0';
      paused = false;
      document.getElementById('pause').textContent = '暂停';
      logEl.textContent = '';
      if (sleepEl) sleepEl.textContent = '睡眠估计  计算中…';
      sleepPolls = 0;
      statusEl.textContent = '连接 ' + currentSn + '…';
      await poll();
      if (timer) clearInterval(timer);
      timer = setInterval(poll, 800);
      loadDevices().catch(function () {});
    }

    async function boot(skipAuto) {
      try {
        const me = await api('/admin/auth/me');
        document.getElementById('who').textContent = (me.admin && (me.admin.displayName || me.admin.username)) || '';
        loginEl.classList.add('hidden');
        await loadDevices();
        if (!snEl.value) snEl.value = '68EE8F4740BC';
      } catch (e) {
        loginEl.classList.remove('hidden');
        const hasCred = loadCred();
        if (!skipAuto && hasCred) {
          try {
            await loginWith(document.getElementById('user').value, document.getElementById('pass').value);
          } catch (err) {
            loginErr.textContent = err.message || '自动登录失败，请手动登录';
          }
        }
      }
    }

    document.getElementById('loginForm').onsubmit = async function (ev) {
      ev.preventDefault();
      loginErr.textContent = '';
      try {
        await loginWith(document.getElementById('user').value, document.getElementById('pass').value);
      } catch (e) {
        loginErr.textContent = e.message || '登录失败';
      }
    };
    document.getElementById('logout').onclick = function () {
      token = '';
      localStorage.removeItem(TOKEN_KEY);
      if (timer) clearInterval(timer);
      loginEl.classList.remove('hidden');
    };
    document.getElementById('start').onclick = startWatch;
    document.getElementById('pause').onclick = function () {
      paused = !paused;
      this.textContent = paused ? '继续' : '暂停';
    };
    document.getElementById('clear').onclick = function () { logEl.textContent = ''; };
    document.getElementById('search').onclick = function () { searchDevices().catch(function (e) { setMeta(e.message || String(e)); }); };
    qEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') searchDevices().catch(function (err) { setMeta(err.message || String(err)); }); });
    snEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') startWatch(); });
    loadCred();
    boot();
  </script>
</body>
</html>
`;

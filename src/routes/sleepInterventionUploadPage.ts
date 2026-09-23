export const SLEEP_INTERVENTION_UPLOAD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>睡眠干预音频</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; background: #10131c; color: #f2f3f8; }
    main { max-width: 980px; margin: 0 auto; padding: 28px 16px 72px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { color: #b7bdd0; line-height: 1.6; font-size: 14px; }
    form.login, .panel { background: #181c28; border: 1px solid rgba(174,181,214,0.16); border-radius: 16px; padding: 16px; margin-top: 16px; }
    label { display: block; font-size: 13px; margin: 12px 0 6px; }
    input, textarea, button { box-sizing: border-box; border-radius: 10px; border: 1px solid rgba(174,181,214,0.22); background: #10131c; color: inherit; padding: 10px 12px; font-size: 14px; }
    textarea { width: 100%; min-height: 72px; resize: vertical; }
    button { background: #6d78e8; border: 0; font-weight: 600; cursor: pointer; }
    button.ghost { background: transparent; border: 1px solid rgba(174,181,214,0.28); }
    button.warn { background: #8a3d4b; }
    button:disabled { opacity: 0.55; cursor: default; }
    .status { min-height: 1.4em; margin-top: 12px; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; vertical-align: top; padding: 10px 8px; border-bottom: 1px solid rgba(174,181,214,0.12); font-size: 13px; }
    th { color: #9aa3bd; font-weight: 600; }
    td input, td textarea { width: 100%; }
    .switch { display: flex; align-items: center; gap: 8px; min-height: 42px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .file { color: #9aa3bd; font-size: 12px; margin-top: 6px; word-break: break-all; }
    .add { display: grid; grid-template-columns: 120px 1fr; gap: 8px 12px; align-items: center; }
    .add label { margin: 0; }
    .add input, .add textarea { width: 100%; }
    .add .full { grid-column: 1 / -1; }
    code { color: #d7dcf8; }
    @media (max-width: 720px) {
      .add { grid-template-columns: 1fr; }
      table, thead, tbody, tr, th, td { display: block; }
      thead { display: none; }
      tr { padding: 8px 0; }
    }
  </style>
</head>
<body>
  <main>
    <h1>睡眠干预音频</h1>
    <p>这里是曲目列表，数量不限。每首单独有编号、名称、说明和启用开关。App 只播放已启用、并且已经有音频文件的条目。再次新增不会覆盖其它曲目。</p>
    <p>匹配约定：公开列表是 <code>GET /sleep-intervention/tracks</code>，只含启用中的曲目。字段为 <code>code</code> 编号、<code>title</code> 名称、<code>summary</code> 说明、<code>audioUrl</code> 音频、<code>coverUrl</code> 封面、<code>playable</code> 是否可播。以 <code>/uploads/</code> 开头的地址由 App 拼到接口域名上。</p>
    <form class="login" id="login">
      <label>管理员账号</label>
      <input name="username" autocomplete="username" required />
      <label>密码</label>
      <input name="password" type="password" autocomplete="current-password" required />
      <button type="submit">登录</button>
    </form>
    <div id="workspace" hidden>
      <div class="panel">
        <table>
          <thead>
            <tr><th>编号</th><th>名称</th><th>说明</th><th>启用</th><th>音频</th><th></th></tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
        <p id="empty">还没有曲目。</p>
      </div>
      <form class="panel add" id="create">
        <label>编号</label>
        <input name="code" required maxlength="32" placeholder="例如 001" />
        <label>名称</label>
        <input name="title" required maxlength="160" placeholder="例如 脑波干预" />
        <label>说明</label>
        <textarea name="summary" maxlength="500" placeholder="这段音频在做什么"></textarea>
        <label>启用</label>
        <label class="switch"><input name="enabled" type="checkbox" checked /> 在 App 中显示并允许播放</label>
        <label>音频</label>
        <input name="file" type="file" accept="audio/mpeg,audio/mp4,audio/aac,audio/wav,.mp3,.m4a,.aac,.wav" required />
        <label>封面</label>
        <input name="cover" type="file" accept="image/jpeg,image/png,image/webp" />
        <button class="full" type="submit">新增一首</button>
      </form>
    </div>
    <div class="status" id="status"></div>
  </main>
  <script>
    const statusEl = document.getElementById('status');
    const loginForm = document.getElementById('login');
    const workspace = document.getElementById('workspace');
    const rowsEl = document.getElementById('rows');
    const emptyEl = document.getElementById('empty');
    const createForm = document.getElementById('create');
    let token = '';

    function say(text) { statusEl.textContent = text; }
    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[ch]));
    }
    async function api(path, options) {
      const headers = new Headers(options && options.headers || {});
      headers.set('Authorization', 'Bearer ' + token);
      const res = await fetch(path, Object.assign({}, options, { headers }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || '请求失败');
      return data;
    }
    function render(tracks) {
      emptyEl.hidden = tracks.length > 0;
      rowsEl.innerHTML = tracks.map((track) => \`
        <tr data-id="\${esc(track.id)}">
          <td><input name="code" maxlength="32" value="\${esc(track.code)}" /></td>
          <td><input name="title" maxlength="160" value="\${esc(track.title)}" /></td>
          <td><textarea name="summary" maxlength="500">\${esc(track.summary)}</textarea></td>
          <td><label class="switch"><input name="enabled" type="checkbox" \${track.enabled ? 'checked' : ''} /> 启用</label></td>
          <td>
            <div class="file">\${esc(track.audioUrl || '还没有音频')}</div>
            <input name="file" type="file" accept="audio/mpeg,audio/mp4,audio/aac,audio/wav,.mp3,.m4a,.aac,.wav" />
          </td>
          <td class="actions">
            <button type="button" data-action="save">保存</button>
            <button type="button" class="ghost" data-action="audio">更换音频</button>
            <button type="button" class="warn" data-action="delete">删除</button>
          </td>
        </tr>\`).join('');
    }
    async function loadTracks() {
      const data = await api('/admin/sleep-intervention/tracks');
      render(data.tracks || []);
    }
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      say('正在登录…');
      const res = await fetch('/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: loginForm.elements.username.value,
          password: loginForm.elements.password.value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) {
        say(data.message || '登录失败');
        return;
      }
      token = data.token;
      loginForm.hidden = true;
      workspace.hidden = false;
      say('已登录');
      try { await loadTracks(); } catch (error) { say(error.message); }
    });
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = createForm.querySelector('button');
      button.disabled = true;
      say('正在新增…');
      try {
        const body = new FormData(createForm);
        if (!body.get('enabled')) body.set('enabled', 'false');
        await api('/admin/sleep-intervention/tracks', { method: 'POST', body });
        createForm.reset();
        createForm.elements.enabled.checked = true;
        await loadTracks();
        say('已新增。启用后，App 睡眠干预页会多出这一首。');
      } catch (error) {
        say(error.message);
      } finally {
        button.disabled = false;
      }
    });
    rowsEl.addEventListener('change', async (event) => {
      const input = event.target;
      if (input.name !== 'enabled') return;
      const row = input.closest('tr');
      say('正在更新启用状态…');
      try {
        await api('/admin/sleep-intervention/tracks/' + row.dataset.id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: input.checked }),
        });
        say(input.checked ? '已启用' : '已停用，App 里不会再出现这一首');
      } catch (error) {
        input.checked = !input.checked;
        say(error.message);
      }
    });
    rowsEl.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const row = button.closest('tr');
      const id = row.dataset.id;
      button.disabled = true;
      try {
        if (button.dataset.action === 'save') {
          await api('/admin/sleep-intervention/tracks/' + id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code: row.querySelector('[name=code]').value,
              title: row.querySelector('[name=title]').value,
              summary: row.querySelector('[name=summary]').value,
              enabled: row.querySelector('[name=enabled]').checked,
            }),
          });
          await loadTracks();
          say('已保存');
        } else if (button.dataset.action === 'audio') {
          const file = row.querySelector('[name=file]').files[0];
          if (!file) throw new Error('请先选择新的音频文件');
          const body = new FormData();
          body.set('file', file);
          await api('/admin/sleep-intervention/tracks/' + id + '/audio', { method: 'POST', body });
          await loadTracks();
          say('音频已更换');
        } else if (button.dataset.action === 'delete') {
          if (!confirm('删除这一首？App 里也会一起消失。')) return;
          await api('/admin/sleep-intervention/tracks/' + id, { method: 'DELETE' });
          await loadTracks();
          say('已删除');
        }
      } catch (error) {
        say(error.message);
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;

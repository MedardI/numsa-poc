(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '');

  let me = null;
  let tab = 'pending';
  let docs = [];

  async function api(url, opts = {}) {
    const headers = { 'X-Requested-With': 'fetch', ...(opts.headers || {}) };
    let body = opts.body;
    if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    const res = await fetch(url, { ...opts, headers, body });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== '/api/auth/login') { showLogin(); throw new Error(data.error || 'Please sign in.'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg, error = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (error ? ' toast--error' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  // ---------------- auth ----------------
  function showLogin() {
    me = null;
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    $('#login-form [name=email]').focus();
  }

  async function showApp(user) {
    me = user;
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#me-name').textContent = user.name;
    $('#me-role').textContent = user.role;
    $$('[data-approver-only]').forEach((el) => (el.hidden = user.role !== 'approver'));
    const cats = await api('/api/categories');
    $$('select[data-categories]').forEach((sel) => (sel.innerHTML = cats.map((c) => `<option>${esc(c)}</option>`).join('')));
    switchTab(tab);
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = $('#login-error');
    err.hidden = true;
    try {
      await api('/api/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } });
      f.password.value = '';
      showApp(await api('/api/auth/me'));
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });

  $('#logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });

  // ---------------- tabs ----------------
  const TITLES = {
    pending: ['Review queue', 'Documents waiting for approval. Approving a document publishes it on the website immediately.'],
    approved: ['Published', 'Live on the website now.'],
    rejected: ['Rejected', 'Sent back to the uploader with a reason. Editors can fix the details and resubmit.'],
    archived: ['Unpublished', 'Previously published documents that have been taken off the website.'],
  };

  function switchTab(name) {
    tab = name;
    $$('#tabs button').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
    $('#list-view').hidden = !TITLES[name];
    $('#upload-view').hidden = name !== 'upload';
    $('#users-view').hidden = name !== 'users';
    if (TITLES[name]) {
      $('#list-title').textContent = TITLES[name][0];
      $('#list-sub').textContent = TITLES[name][1];
      loadDocs();
    }
    if (name === 'users') loadUsers();
    refreshStats();
  }
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) switchTab(b.dataset.tab); });

  async function refreshStats() {
    const s = await api('/api/admin/stats').catch(() => null);
    if (s) $$('[data-count]').forEach((el) => (el.textContent = s[el.dataset.count] ?? 0));
  }

  // ---------------- documents ----------------
  async function loadDocs() {
    const list = $('#doc-list');
    list.innerHTML = '<p class="muted">Loading…</p>';
    docs = await api(`/api/admin/documents?status=${tab}`);
    if (!docs.length) {
      const icons = { pending: 'fa-circle-check', approved: 'fa-globe', rejected: 'fa-ban', archived: 'fa-box-archive' };
      const msg = { pending: 'Nothing waiting for review.', approved: 'Nothing published yet.', rejected: 'No rejected documents.', archived: 'No unpublished documents.' };
      list.innerHTML = `<div class="empty"><i class="fa-solid ${icons[tab]}"></i>${msg[tab]}</div>`;
      return;
    }
    list.innerHTML = docs.map(row).join('');
  }

  function row(d) {
    const approver = me.role === 'approver';
    const own = d.uploaded_by === me.id;
    const canEdit = approver || (own && d.status !== 'approved');
    const selfBlocked = !me.allowSelfApproval && own;
    const b = (act, label, cls = 'btn--ghost', extra = '') => `<button class="btn btn--xs ${cls}" data-act="${act}" data-id="${d.id}" ${extra}>${label}</button>`;
    const acts = [`<a class="btn btn--xs btn--ghost" href="/api/admin/documents/${d.id}/file?inline=1" target="_blank" rel="noopener"><i class="fa-regular fa-eye"></i> Preview</a>`];
    if (d.status === 'approved') acts.push(`<a class="btn btn--xs btn--ghost" href="/#documents" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square"></i> On site</a>`);
    if (approver && d.status === 'pending') {
      acts.push(b('approve', '<i class="fa-solid fa-check"></i> Approve &amp; publish', 'btn--green', selfBlocked ? 'disabled title="Another approver must approve your uploads"' : ''));
      acts.push(b('reject', '<i class="fa-solid fa-xmark"></i> Reject', 'btn--red'));
    }
    if (approver && (d.status === 'rejected' || d.status === 'archived')) acts.push(b('approve', d.status === 'archived' ? 'Republish' : 'Approve &amp; publish', 'btn--green', selfBlocked ? 'disabled' : ''));
    if (approver && d.status === 'approved') acts.push(b('unpublish', '<i class="fa-solid fa-eye-slash"></i> Unpublish'));
    if (d.status === 'rejected' && (own || approver)) acts.push(b('resubmit', 'Resubmit'));
    if (canEdit) acts.push(b('edit', '<i class="fa-solid fa-pen"></i> Edit'));
    if (canEdit) acts.push(b('delete', '<i class="fa-regular fa-trash-can"></i>', 'btn--ghost', 'aria-label="Delete" title="Delete"'));

    let note = '';
    if (d.review_note && d.status === 'rejected') note = `<div class="note"><b>Rejected by ${esc(d.reviewed_by_name || 'an approver')}:</b> ${esc(d.review_note)}</div>`;
    else if (d.review_note) note = `<div class="note note--ok"><b>Note from ${esc(d.reviewed_by_name || 'an approver')}:</b> ${esc(d.review_note)}</div>`;

    return `<article class="row">
      <span class="ftype ftype--${esc(d.ext)}">${esc(d.ext)}</span>
      <div>
        <h3>${esc(d.title)} <span class="status status--${d.status}">${d.status === 'archived' ? 'unpublished' : d.status}</span></h3>
        <div class="meta">
          <span><b>${esc(d.category)}</b></span>
          <span>${esc(d.original_name)} · ${fmtSize(d.size)}</span>
          <span>Uploaded by ${esc(d.uploaded_by_name || 'deleted user')} · ${fmtDate(d.uploaded_at)}</span>
          ${d.published_at && d.status === 'approved' ? `<span>Published ${fmtDate(d.published_at)} by ${esc(d.reviewed_by_name || '')}</span>` : ''}
        </div>
        ${d.description ? `<p class="desc">${esc(d.description)}</p>` : ''}
        ${note}
      </div>
      <div class="actions">${acts.join('')}</div>
    </article>`;
  }

  function askNote({ title, help, label, ok, required }) {
    const dlg = $('#note-dialog');
    $('#note-title').textContent = title;
    $('#note-help').textContent = help;
    $('#note-label').textContent = label;
    $('#note-ok').textContent = ok;
    const ta = dlg.querySelector('textarea');
    ta.value = '';
    ta.required = !!required;
    dlg.showModal();
    return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? ta.value.trim() : null), { once: true }));
  }

  function editDialog(d) {
    const dlg = $('#edit-dialog');
    const f = dlg.querySelector('form');
    f.title.value = d.title;
    f.category.value = d.category;
    f.description.value = d.description;
    dlg.showModal();
    return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'
      ? { title: f.title.value, category: f.category.value, description: f.description.value } : null), { once: true }));
  }

  $('#doc-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const d = docs.find((x) => x.id === Number(btn.dataset.id));
    const act = btn.dataset.act;
    try {
      if (act === 'approve') {
        btn.disabled = true;
        await api(`/api/admin/documents/${d.id}/approve`, { method: 'POST', body: {} });
        toast(`“${d.title}” is now live on the website.`);
      } else if (act === 'reject') {
        const note = await askNote({ title: 'Reject document', help: `“${d.title}” will be sent back to the uploader.`, label: 'Reason (shown to the uploader)', ok: 'Reject', required: true });
        if (note === null) return;
        await api(`/api/admin/documents/${d.id}/reject`, { method: 'POST', body: { note } });
        toast('Document rejected.');
      } else if (act === 'unpublish') {
        const note = await askNote({ title: 'Unpublish document', help: `“${d.title}” will be removed from the website. You can republish it later.`, label: 'Note (optional)', ok: 'Unpublish' });
        if (note === null) return;
        await api(`/api/admin/documents/${d.id}/unpublish`, { method: 'POST', body: { note } });
        toast('Removed from the website.');
      } else if (act === 'resubmit') {
        await api(`/api/admin/documents/${d.id}/resubmit`, { method: 'POST', body: {} });
        toast('Sent back to the review queue.');
      } else if (act === 'edit') {
        const body = await editDialog(d);
        if (!body) return;
        await api(`/api/admin/documents/${d.id}`, { method: 'PATCH', body });
        toast('Saved.');
      } else if (act === 'delete') {
        if (!confirm(`Permanently delete “${d.title}” and its file? This cannot be undone.`)) return;
        await api(`/api/admin/documents/${d.id}`, { method: 'DELETE' });
        toast('Deleted.');
      }
      loadDocs();
      refreshStats();
    } catch (ex) { toast(ex.message, true); btn.disabled = false; }
  });

  // ---------------- upload ----------------
  const drop = $('#drop');
  const fileInput = $('#file-input');
  const uploadForm = $('#upload-form');
  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    drop.classList.toggle('has-file', !!f);
    $('#drop-label').textContent = f ? `${f.name} (${fmtSize(f.size)})` : 'Drop a file here or click to choose';
    if (f && !uploadForm.title.value) uploadForm.title.value = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, () => drop.classList.add('is-over')));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('is-over')));

  uploadForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('#upload-error');
    const bar = $('#upload-progress');
    const btn = uploadForm.querySelector('button[type=submit]');
    err.hidden = true;
    // XHR (not fetch) so we can show upload progress.
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/admin/documents');
    xhr.setRequestHeader('X-Requested-With', 'fetch');
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) bar.firstElementChild.style.width = `${(ev.loaded / ev.total) * 100}%`; };
    xhr.onloadend = () => {
      btn.disabled = false;
      bar.hidden = true;
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 201) {
        uploadForm.reset();
        fileInput.dispatchEvent(new Event('change'));
        toast(me.role === 'approver' ? 'Uploaded. Approve it in the review queue to publish.' : 'Uploaded and sent for approval.');
        switchTab('pending');
      } else if (xhr.status === 401) {
        showLogin();
      } else {
        err.textContent = data.error || 'Upload failed.';
        err.hidden = false;
      }
    };
    btn.disabled = true;
    bar.hidden = false;
    bar.firstElementChild.style.width = '0';
    xhr.send(new FormData(uploadForm));
  });

  // ---------------- users ----------------
  async function loadUsers() {
    const users = await api('/api/admin/users');
    $('#users-table tbody').innerHTML = users.map((u) => `<tr>
      <td>${esc(u.name)}${u.id === me.id ? ' <span class="muted">(you)</span>' : ''}</td>
      <td>${esc(u.email)}</td>
      <td><span class="status ${u.role === 'approver' ? 'status--approved' : 'status--archived'}">${u.role}</span></td>
      <td style="text-align:right">${u.id === me.id ? '' : `<button class="btn btn--xs btn--ghost" data-del-user="${u.id}" data-name="${esc(u.name)}">Remove</button>`}</td>
    </tr>`).join('');
  }
  $('#users-table').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-user]');
    if (!b || !confirm(`Remove ${b.dataset.name}? Their documents stay on the system.`)) return;
    try { await api(`/api/admin/users/${b.dataset.delUser}`, { method: 'DELETE' }); toast('User removed.'); loadUsers(); }
    catch (ex) { toast(ex.message, true); }
  });
  $('#user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = $('#user-error');
    err.hidden = true;
    try {
      await api('/api/admin/users', { method: 'POST', body: Object.fromEntries(new FormData(f)) });
      f.reset();
      toast('User added. Share the temporary password with them securely.');
      loadUsers();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });

  // ---------------- boot ----------------
  api('/api/auth/me').then(showApp).catch(() => showLogin());
})();

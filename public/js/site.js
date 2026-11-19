(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- header ----------
  const header = $('#header');
  const onScroll = () => header.classList.toggle('is-scrolled', scrollY > 40);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const toggle = $('.nav-toggle');
  const nav = $('#main-nav');
  const setNav = (open) => { nav.classList.toggle('is-open', open); toggle.setAttribute('aria-expanded', open); };
  toggle.addEventListener('click', () => setNav(!nav.classList.contains('is-open')));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) setNav(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setNav(false); });

  // ---------- reveal on scroll (staggered within each group) ----------
  for (const group of $$('.news__list, .video-grid')) {
    $$('.reveal', group).forEach((el, i) => el.style.setProperty('--d', `${(i % 4) * 0.08}s`));
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      io.unobserve(e.target);
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  $$('.reveal').forEach((el) => io.observe(el));

  // ---------- news carousel ----------
  const track = $('.carousel__track');
  const navBtns = $$('.carousel__nav button');
  if (track) {
    const step = () => (track.firstElementChild?.getBoundingClientRect().width || 300) + 24;
    navBtns.forEach((b) => b.addEventListener('click', () => track.scrollBy({ left: Number(b.dataset.dir) * step(), behavior: reduceMotion ? 'auto' : 'smooth' })));
    const update = () => {
      navBtns[0].disabled = track.scrollLeft <= 2;
      navBtns[1].disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
    };
    track.addEventListener('scroll', update, { passive: true });
    addEventListener('resize', update);
    update();
  }

  // ---------- videos: load the YouTube player only when asked ----------
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.video__play');
    if (!btn) return;
    const id = btn.dataset.yt;
    if (!/^[\w-]{6,20}$/.test(id)) return;
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
    frame.title = btn.getAttribute('aria-label').replace(/^Play: /, '');
    frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    frame.allowFullscreen = true;
    btn.replaceWith(frame);
  });

  // ---------- header search jumps to the document search ----------
  $('#search-btn')?.addEventListener('click', () => {
    $('#documents').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
    setTimeout(() => $('#doc-search').focus({ preventScroll: true }), reduceMotion ? 0 : 600);
  });

  // ---------- "Get In Touch" form ----------
  const form = $('#contact-form');
  const status = $('#contact-status');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const showStatus = (msg, error) => { status.textContent = msg; status.classList.toggle('is-error', !!error); status.hidden = false; };
    let firstBad = null;
    for (const el of $$('input[required]', form)) {
      const bad = !el.value.trim() || (el.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value.trim()));
      el.setAttribute('aria-invalid', bad);
      if (bad && !firstBad) firstBad = el;
    }
    if (firstBad) { showStatus('Please fill in your name, surname and a valid email address.', true); firstBad.focus(); return; }
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const res = await fetch('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Your message could not be sent. Please try again.');
      form.reset();
      showStatus('Thank you. Your message has been sent to the NUM.');
    } catch (ex) {
      showStatus(ex.message, true);
    } finally {
      btn.disabled = false;
    }
  });
  form?.addEventListener('input', (e) => { if (e.target.getAttribute('aria-invalid') === 'true') e.target.setAttribute('aria-invalid', 'false'); });

  const year = $('#year');
  if (year) year.textContent = new Date().getFullYear();

  // ---------- documents (approved only, from /api/documents) ----------
  const grid = $('#doc-grid');
  const chips = $('#doc-chips');
  const search = $('#doc-search');
  const more = $('#doc-more');
  const empty = $('#doc-empty');
  const PAGE = 6;
  const state = { category: '', q: '', offset: 0, total: 0 };
  let reqId = 0;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const fmtDate = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });

  function card(d) {
    return `<article class="doc">
      <div class="doc__top">
        <span class="doc__type doc__type--${esc(d.ext)}">${esc(d.ext)}</span>
        <div><div class="doc__cat">${esc(d.category)}</div><div class="doc__date">${esc(fmtDate(d.published_at))}</div></div>
      </div>
      <h3>${esc(d.title)}</h3>
      <p>${esc(d.description)}</p>
      <div class="doc__actions">
        ${d.view_url ? `<a class="btn btn--ghost" href="${esc(d.view_url)}" target="_blank" rel="noopener"><i class="fa-regular fa-eye"></i> View</a>` : ''}
        <a class="btn btn--red" href="${esc(d.url)}"><i class="fa-solid fa-download"></i> Download</a>
        <span class="doc__size">${fmtSize(d.size)}</span>
      </div>
    </article>`;
  }

  async function load(append = false) {
    const id = ++reqId;
    if (!append) {
      state.offset = 0;
      grid.innerHTML = '<div class="doc doc--skeleton"></div>'.repeat(3);
    }
    const params = new URLSearchParams({ limit: PAGE, offset: state.offset });
    if (state.category) params.set('category', state.category);
    if (state.q) params.set('q', state.q);
    try {
      const res = await fetch(`/api/documents?${params}`);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      if (id !== reqId) return; // a newer request superseded this one
      state.total = data.total;
      const html = data.items.map(card).join('');
      grid.innerHTML = append ? grid.innerHTML + html : html;
      state.offset += data.items.length;
      empty.hidden = state.total > 0;
      empty.textContent = state.q || state.category ? 'No documents match your filter.' : 'No documents have been published yet.';
      more.hidden = state.offset >= state.total;
    } catch {
      if (id !== reqId) return;
      grid.innerHTML = '';
      empty.hidden = false;
      empty.textContent = 'Documents could not be loaded. Please try again later.';
      more.hidden = true;
    }
  }

  function setCategory(cat) {
    state.category = cat;
    $$('.chip', chips).forEach((c) => {
      const on = c.dataset.category === cat;
      c.classList.toggle('is-active', on);
      c.setAttribute('aria-selected', on);
    });
    load();
  }

  fetch('/api/categories').then((r) => r.json()).then((cats) => {
    chips.insertAdjacentHTML('beforeend', cats.map((c) => `<button class="chip" data-category="${esc(c)}" role="tab" aria-selected="false">${esc(c)}</button>`).join(''));
  }).catch(() => {});

  chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) setCategory(chip.dataset.category);
  });
  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.q = search.value.trim(); load(); }, 250);
  });
  more.addEventListener('click', () => load(true));

  // Menu/footer links that point at a document category.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-doc-category]');
    if (a) setCategory(a.dataset.docCategory);
  });

  // Pick up newly approved documents when the visitor comes back to the tab.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });

  load();
})();

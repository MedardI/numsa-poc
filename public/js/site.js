(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- hero slideshow with progress dots ----------
  const slides = $$('.hero__slide');
  const dotsWrap = $('.hero__dots');
  let slide = 0;
  let timer;
  const dots = slides.map((_, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Show image ${i + 1}`);
    b.addEventListener('click', () => go(i));
    dotsWrap.append(b);
    return b;
  });
  function go(i) {
    slides[slide].classList.remove('is-active');
    dots[slide].classList.remove('is-active');
    slide = i;
    slides[slide].classList.add('is-active');
    void dots[slide].offsetWidth; // restart the progress animation
    dots[slide].classList.add('is-active');
    clearTimeout(timer);
    if (!reduceMotion) timer = setTimeout(() => go((slide + 1) % slides.length), 6000);
  }
  if (slides.length) go(0);

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

  // ---------- reveal (staggered within each group) + counters ----------
  for (const group of $$('.bento, .industries, .partner-groups')) {
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

  const fmt = (n) => n.toLocaleString('en-ZA');
  const countIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      countIO.unobserve(e.target);
      const el = e.target;
      const to = Number(el.dataset.count);
      if (reduceMotion) { el.textContent = fmt(to); continue; }
      const start = performance.now();
      const dur = 2200;
      const tick = (t) => {
        const p = Math.min((t - start) / dur, 1);
        el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - p, 4))));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }, { threshold: 0.5 });
  $$('[data-count]').forEach((el) => countIO.observe(el));

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

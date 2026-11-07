/* Roomtone core logic: library, device files, playlists, spatial audio. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const audio = $('#audio');

  /* ---------- State ---------- */
  const tracks = new Map();            // id -> track
  let libraryIds = [], deviceIds = [];
  let queue = [], qIndex = -1;
  let playlists = load('rt.playlists', []);
  let pendingAddId = null;

  function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = t => isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}` : '0:00';

  /* ---------- Device file storage (IndexedDB) ---------- */
  const idb = {
    db: null,
    open() {
      return new Promise(res => {
        const r = indexedDB.open('roomtone', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => res();
      });
    },
    tx(mode) { return this.db?.transaction('files', mode).objectStore('files'); },
    put(rec) { return new Promise(res => { const s = this.tx('readwrite'); if (!s) return res(); s.put(rec).onsuccess = res; }); },
    del(id) { return new Promise(res => { const s = this.tx('readwrite'); if (!s) return res(); s.delete(id).onsuccess = res; }); },
    all() { return new Promise(res => { const s = this.tx('readonly'); if (!s) return res([]); const q = s.getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); }); }
  };

  /* ---------- Library (songs you uploaded and own) ---------- */
  async function loadLibrary() {
    try {
      const r = await fetch('library.json', { cache: 'no-cache' });
      const data = await r.json();
      libraryIds = [];
      (data.tracks || []).forEach(t => {
        const tr = { id: 'lib:' + t.id, title: t.title, artist: t.artist || 'Unknown artist', src: t.src, cover: t.cover || '', source: 'library' };
        tracks.set(tr.id, tr); libraryIds.push(tr.id);
      });
    } catch { /* offline or no catalog */ }
    renderList('#libraryList', libraryIds, 'No songs in the library yet. Add files to /songs and list them in library.json.');
  }

  /* ---------- Device files ---------- */
  function parseName(name) {
    const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    const [a, ...rest] = base.split(' - ');
    return rest.length ? { artist: a.trim(), title: rest.join(' - ').trim() } : { artist: 'This device', title: base.trim() };
  }
  function addDeviceTrack(rec) {
    const url = URL.createObjectURL(rec.blob);
    const tr = { id: rec.id, title: rec.title, artist: rec.artist, src: url, cover: '', source: 'device' };
    tracks.set(tr.id, tr);
    if (!deviceIds.includes(tr.id)) deviceIds.push(tr.id);
  }
  async function loadDevice() {
    await idb.open();
    (await idb.all()).forEach(addDeviceTrack);
    renderList('#deviceList', deviceIds, 'No songs yet. Add some above.');
  }
  $('#filePick').addEventListener('change', async e => {
    for (const f of e.target.files) {
      const { title, artist } = parseName(f.name);
      const rec = { id: 'dev:' + crypto.randomUUID(), title, artist, blob: f };
      await idb.put(rec); addDeviceTrack(rec);
    }
    e.target.value = '';
    renderList('#deviceList', deviceIds, 'No songs yet. Add some above.');
  });

  /* ---------- Rendering ---------- */
  const moreIcon = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
  function renderList(sel, ids, emptyMsg) {
    const ul = $(sel);
    ul.innerHTML = ids.length ? '' : `<li class="empty">${esc(emptyMsg)}</li>`;
    ids.forEach(id => ul.append(trackRow(tracks.get(id), ids)));
    markPlaying();
  }
  function trackRow(t, ctxIds, opts = {}) {
    const li = document.createElement('li');
    li.className = 'track'; li.dataset.id = t.id;
    const art = t.cover ? `style="background-image:url('${esc(t.cover)}')"` : '';
    li.innerHTML = `
      <button class="play-hit" aria-label="Play ${esc(t.title)}">
        <span class="art" ${art}>${t.cover ? '' : esc(t.title.charAt(0).toUpperCase())}</span>
        <span class="t-text"><div class="t-title">${esc(t.title)}</div><div class="t-artist">${esc(t.artist)}</div></span>
      </button>
      <button class="more" aria-label="${opts.remove ? 'Remove from playlist' : 'Add to playlist'}">${opts.remove ? '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>' : moreIcon}</button>`;
    $('.play-hit', li).onclick = () => playFrom(ctxIds, ctxIds.indexOf(t.id));
    $('.more', li).onclick = () => opts.remove ? opts.remove() : openPicker(t.id);
    return li;
  }
  function markPlaying() {
    const cur = queue[qIndex];
    $$('.track').forEach(li => li.classList.toggle('playing', li.dataset.id === cur));
  }

  function renderPlaylists() {
    const area = $('#playlistArea');
    area.innerHTML = playlists.length ? '' : '<p class="empty">No playlists yet. Name one above, then add songs with the + button.</p>';
    playlists.forEach(p => {
      const ids = p.trackIds.filter(id => tracks.has(id));
      const wrap = document.createElement('div'); wrap.className = 'pl';
      wrap.innerHTML = `<div class="pl-head"><h3>${esc(p.name)}</h3><button data-act="play">Play</button><button data-act="del">Delete</button></div><ul class="tracks"></ul>`;
      const ul = $('ul', wrap);
      if (!ids.length) ul.innerHTML = '<li class="empty">Empty. Add songs with the + button.</li>';
      ids.forEach(id => ul.append(trackRow(tracks.get(id), ids, { remove: () => { p.trackIds = p.trackIds.filter(x => x !== id); save('rt.playlists', playlists); renderPlaylists(); } })));
      $('[data-act=play]', wrap).onclick = () => ids.length && playFrom(ids, 0);
      $('[data-act=del]', wrap).onclick = () => { playlists = playlists.filter(x => x !== p); save('rt.playlists', playlists); renderPlaylists(); };
      area.append(wrap);
    });
    markPlaying();
  }
  $('#newListForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('#newListName').value.trim();
    if (!name) return;
    playlists.push({ id: crypto.randomUUID(), name, trackIds: [] });
    save('rt.playlists', playlists); $('#newListName').value = ''; renderPlaylists();
  });

  /* ---------- Sheets ---------- */
  function openSheet(el) { el.hidden = false; $('button,input', el)?.focus(); }
  function closeSheet(el) { el.hidden = true; }
  $$('.sheet').forEach(s => {
    s.addEventListener('click', e => { if (e.target === s || e.target.hasAttribute('data-close')) closeSheet(s); });
    s.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(s); });
  });
  $('#soundBtn').onclick = () => openSheet($('#soundSheet'));
  function openPicker(id) {
    pendingAddId = id;
    const box = $('#pickList');
    if (!playlists.length) { box.innerHTML = '<p class="empty">Create a playlist first in the Playlists tab.</p>'; }
    else {
      box.innerHTML = '';
      playlists.forEach(p => {
        const b = document.createElement('button'); b.className = 'pick-row'; b.textContent = p.name;
        b.onclick = () => {
          if (!p.trackIds.includes(pendingAddId)) p.trackIds.push(pendingAddId);
          save('rt.playlists', playlists); renderPlaylists(); closeSheet($('#pickSheet'));
        };
        box.append(b);
      });
    }
    openSheet($('#pickSheet'));
  }

  /* ---------- Tabs ---------- */
  $$('.tabs button').forEach(b => b.onclick = () => {
    $$('.tabs button').forEach(x => x.setAttribute('aria-selected', x === b));
    $$('.view').forEach(v => v.hidden = v.id !== 'view-' + b.dataset.view);
    if (b.dataset.view === 'playlists') renderPlaylists();
  });

  /* ---------- Playback ---------- */
  function playFrom(ids, i) {
    queue = ids.slice(); qIndex = i; startCurrent();
  }
  async function startCurrent() {
    const t = tracks.get(queue[qIndex]); if (!t) return;
    ensureGraph();
    audio.src = t.src;
    $('#npTitle').textContent = t.title; $('#npArtist').textContent = t.artist;
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, artwork: [{ src: 'logo.svg', type: 'image/svg+xml' }] });
    try { await ctx.resume(); await audio.play(); } catch {}
    markPlaying();
  }
  const step = d => { if (!queue.length) return; qIndex = (qIndex + d + queue.length) % queue.length; startCurrent(); };
  $('#prevBtn').onclick = () => audio.currentTime > 3 ? (audio.currentTime = 0) : step(-1);
  $('#nextBtn').onclick = () => step(1);
  $('#playBtn').onclick = async () => {
    if (!audio.src) { const first = libraryIds[0] ?? deviceIds[0]; if (first) playFrom(libraryIds.includes(first) ? libraryIds : deviceIds, 0); return; }
    ensureGraph(); await ctx.resume(); audio.paused ? audio.play() : audio.pause();
  };
  audio.addEventListener('ended', () => step(1));
  const playPath = 'M9 6.8v10.4a1 1 0 0 0 1.5.9l8.2-5.2a1 1 0 0 0 0-1.8L10.5 5.9A1 1 0 0 0 9 6.8z';
  const pausePath = 'M8 6.5v11M16 6.5v11';
  function syncPlayIcon() {
    $('#playIcon').innerHTML = `<path d="${audio.paused ? playPath : pausePath}"/>`;
    $('#playBtn').setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
    $('#playBtn svg').style.strokeWidth = audio.paused ? 1.5 : 3.5;
  }
  audio.addEventListener('play', syncPlayIcon); audio.addEventListener('pause', syncPlayIcon);
  let seeking = false;
  audio.addEventListener('timeupdate', () => {
    $('#tCur').textContent = fmt(audio.currentTime);
    if (!seeking && audio.duration) $('#seek').value = (audio.currentTime / audio.duration) * 1000;
  });
  audio.addEventListener('loadedmetadata', () => $('#tDur').textContent = fmt(audio.duration));
  $('#seek').addEventListener('input', e => { seeking = true; if (audio.duration) audio.currentTime = (e.target.value / 1000) * audio.duration; });
  $('#seek').addEventListener('change', () => seeking = false);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
  }

  /* ---------- Audio engine ----------
     source -> tone (bass/treble) -> dry ------------------> mix -> compressor -> out
                                  -> spatial (L/R HRTF panners, slow sway) -> mix
                                  -> reverb (room) -----------> mix                      */
  let ctx, g = null, mode = 'studio', swayRaf = 0;

  function makeImpulse(c, seconds = 1.8, decay = 3) {
    const len = Math.floor(c.sampleRate * seconds), buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }
  function ensureGraph() {
    if (g) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
    const src = ctx.createMediaElementSource(audio);
    const bass = ctx.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 120;
    const treble = ctx.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 4500;
    const dry = ctx.createGain(), spatial = ctx.createGain(), wide = ctx.createGain();
    const reverb = ctx.createConvolver(); reverb.buffer = makeImpulse(ctx);
    const wet = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = .01; comp.release.value = .25;
    const out = ctx.createGain();

    src.connect(bass); bass.connect(treble);
    treble.connect(dry); dry.connect(out);

    // Spatial: split channels, place each as a binaural source in front-left / front-right
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    const mk = x => { const p = ctx.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 1; p.setPosition(x, 0.4, -1.4); return p; };
    const pL = mk(-1.6), pR = mk(1.6);
    treble.connect(split);
    split.connect(pL, 0); split.connect(pR, 1);
    pL.connect(spatial); pR.connect(spatial); spatial.connect(out);

    // Wide: Haas-style delayed cross-feed on a mid/side-ish split
    const dl = ctx.createDelay(.05); dl.delayTime.value = .018;
    const dr = ctx.createDelay(.05); dr.delayTime.value = .026;
    const sp2 = ctx.createChannelSplitter(2);
    treble.connect(sp2); sp2.connect(dl, 1); sp2.connect(dr, 0);
    dl.connect(merge, 0, 0); dr.connect(merge, 0, 1);
    merge.connect(wide); wide.connect(out);

    // Room reverb send
    treble.connect(reverb); reverb.connect(wet); wet.connect(out);

    out.connect(comp); comp.connect(ctx.destination);
    g = { bass, treble, dry, spatial, wide, wet, pL, pR };
    applyMode(); applySliders();
  }
  function applyMode() {
    if (!g) return;
    const t = ctx.currentTime, set = (n, v) => n.gain.setTargetAtTime(v, t, .08);
    set(g.dry, mode === 'studio' ? 1 : 0);
    set(g.spatial, mode === 'spatial' ? 1.2 : 0);
    set(g.wide, mode === 'wide' ? .9 : 0);
    cancelAnimationFrame(swayRaf);
    if (mode === 'spatial' && !matchMedia('(prefers-reduced-motion: reduce)').matches) sway();
    else { g.pL.setPosition(-1.6, .4, -1.4); g.pR.setPosition(1.6, .4, -1.4); }
    applySliders();
  }
  function sway() {  // gentle movement so the sound field feels alive
    const a = ctx.currentTime * .35;
    g.pL.setPosition(-1.6 + Math.sin(a) * .5, .4 + Math.sin(a * .7) * .3, -1.4 + Math.cos(a) * .4);
    g.pR.setPosition(1.6 + Math.sin(a + 1) * .5, .4 + Math.cos(a * .7) * .3, -1.4 + Math.cos(a + 1) * .4);
    swayRaf = requestAnimationFrame(sway);
  }
  function applySliders() {
    if (!g) return;
    const t = ctx.currentTime, room = $('#roomAmt').value / 100;
    const base = mode === 'spatial' ? .25 : mode === 'wide' ? .12 : 0;
    g.wet.gain.setTargetAtTime(base + room * (mode === 'studio' ? .5 : .8), t, .1);
    g.bass.gain.setTargetAtTime(+$('#bassAmt').value, t, .05);
    g.treble.gain.setTargetAtTime(+$('#trebleAmt').value, t, .05);
  }
  $$('#modes button').forEach(b => b.onclick = () => {
    mode = b.dataset.mode; save('rt.mode', mode);
    $$('#modes button').forEach(x => x.setAttribute('aria-pressed', x === b));
    $('#modeLabel').textContent = b.querySelector('b').textContent;
    applyMode();
  });
  ['roomAmt', 'bassAmt', 'trebleAmt'].forEach(id => $('#' + id).addEventListener('input', applySliders));
  { const m = load('rt.mode', 'studio'); $(`#modes [data-mode=${m}]`)?.click(); }

  /* ---------- Boot ---------- */
  loadLibrary();
  loadDevice();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) { /* reserved for offline support */ }
})();

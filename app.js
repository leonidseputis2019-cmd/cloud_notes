/* ===== константы ===== */
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const MAXFILE  = 25 * 1024 * 1024;
const LIMITS = {
  basic: { bytes: 50 * 1024 * 1024, folders: 5,  label: '50 МБ' },
  pro:   { bytes: Infinity,         folders: 40, label: 'безлимит' }
};
const ICON = { folder: 'folder.png', file: 'file.png' };
const CELLW = 273, CELLH = 254;

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

/* ===== сессия и тариф ===== */
const DB = {
  get session(){ return localStorage.cn_session || ''; },
  set session(v){ localStorage.cn_session = v || ''; },
  plan(e){ return localStorage['cn_plan_' + e] || 'basic'; },
  setPlan(e, v){ localStorage['cn_plan_' + e] = v; }
};

/* ===== папки ===== */
let MY_UID = '';
const Store = {
  cache: [],
  async load(){
    const { data, error } = await SB.from('folders').select('*');
    if(error){ info('Не удалось загрузить папки: ' + error.message); this.cache = []; return; }
    this.cache = (data || []).map(r => ({ id: r.id, name: r.name, text: r.text || '', pin: !!r.pin, files: r.files || [] }));
  },
  find(id){ return this.cache.find(x => x.id === id); },
  async save(it){
    const { error } = await SB.from('folders').upsert({ id: it.id, owner: MY_UID, name: it.name, text: it.text || '', pin: !!it.pin, files: it.files || [] });
    if(error) info('Не удалось сохранить в облако: ' + error.message);
  },
  async remove(id){
    const { error } = await SB.from('folders').delete().eq('id', id);
    if(error) info('Не удалось удалить из облака: ' + error.message);
  }
};

let saveT = 0;
function saveSoon(it){ clearTimeout(saveT); saveT = setTimeout(() => Store.save(it), 500); }

const OPEN = {
  key(){ return 'cn_open_' + DB.session; },
  get(){ return JSON.parse(sessionStorage.getItem(this.key()) || '[]'); },
  set(v){ sessionStorage.setItem(this.key(), JSON.stringify(v)); },
  has(id){ return this.get().includes(id); },
  add(id){ const v = this.get(); if(!v.includes(id)) v.push(id); this.set(v); },
  remove(id){ this.set(this.get().filter(x => x !== id)); }
};

const ACTIVE = {
  key(){ return 'cn_active_' + DB.session; },
  get(){ return +(sessionStorage.getItem(this.key()) || 0); },
  set(v){ sessionStorage.setItem(this.key(), v || ''); }
};

const POS = {
  get(){ return JSON.parse(localStorage['cn_pos_' + DB.session] || '{}'); },
  set(v){ localStorage['cn_pos_' + DB.session] = JSON.stringify(v); }
};

function clearOpen(em){ sessionStorage.removeItem('cn_open_' + em); sessionStorage.removeItem('cn_active_' + em); }
function currentQ(){ return (document.querySelector('.search input')?.value || '').toLowerCase().trim(); }
function emptyHTML(img, txt){ return `<div class="empty"><img src="icons/${img}" alt=""><p>${txt}</p></div>`; }

function usedBytes(){
  return Store.cache.reduce((s, it) => {
    let b = (it.text || '').length;
    (it.files || []).forEach(f => { b += f.size || 0; });
    return s + b;
  }, 0);
}

function fmtSize(b){
  if(b < 1024 * 1024) return (b / 1024).toFixed(0) + ' КБ';
  if(b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' МБ';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' ГБ';
}

function fitHeaders(){
  document.querySelectorAll('.card header').forEach(h => {
    h.style.fontSize = '';
    let size = parseFloat(getComputedStyle(h).fontSize);
    while(h.scrollWidth > h.clientWidth && size > 12){ size -= 1; h.style.fontSize = size + 'px'; }
  });
}

function info(text){
  if(!$('#info')){
    document.body.insertAdjacentHTML('beforeend',
      `<div class="modal" id="info" hidden><div class="modal-card"><p id="info-text"></p><div class="auth-row"><button class="btn" id="info-ok">понятно</button></div></div></div>`);
    $('#info-ok').addEventListener('click', () => { $('#info').hidden = true; });
  }
  $('#info-text').textContent = text;
  $('#info').hidden = false;
}

function askConfirm(text, onOk){
  if(!$('#confirm')){
    document.body.insertAdjacentHTML('beforeend',
      `<div class="modal" id="confirm" hidden><div class="modal-card"><p id="confirm-text"></p><div class="auth-row"><button class="btn" id="confirm-ok">удалить</button><button class="btn btn-ghost" id="confirm-cancel">отмена</button></div></div></div>`);
    $('#confirm-cancel').addEventListener('click', () => { $('#confirm').hidden = true; });
  }
  $('#confirm-text').textContent = text;
  $('#confirm-ok').onclick = () => { $('#confirm').hidden = true; onOk(); };
  $('#confirm').hidden = false;
}

function busy(btn, on, txt){
  if(!btn) return;
  if(on){ btn.disabled = true; btn.dataset.t = btn.textContent; btn.textContent = txt || '⏳ ...'; }
  else { btn.disabled = false; btn.textContent = btn.dataset.t; }
}

function guardLimits(f){
  if(f.size > MAXFILE){ info('Один файл не может быть больше 25 МБ.'); return false; }
  const L = LIMITS[DB.plan(DB.session)];
  if(Store.cache.length >= L.folders){ info(`На тарифе «${DB.plan(DB.session) === 'basic' ? 'Базовый' : 'PRO'}» не более ${L.folders} папок.`); return false; }
  const need = usedBytes() + f.size;
  if(isFinite(L.bytes) && need > L.bytes){ info('Недостаточно места в хранилище.'); return false; }
  return true;
}

/* ===== облако файлов ===== */
const URL_CACHE = {};
async function uid(){
  const { data } = await SB.auth.getSession();
  if(!data.session || !data.session.user) throw new Error('нет сессии');
  return data.session.user.id;
}

async function uploadFile(f, id){
  const u = await uid();
  const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${u}/${id}/${Date.now()}_${safe}`;
  
  const { data, error } = await SB.storage.from('files').upload(path, f, { upsert: true });
  
  // Обработка ошибки лимита от SQL-триггера
  if (error) {
    if (error.message.includes('limit') || error.message.includes('schema mismatch')) {
      throw new Error('LIMIT_EXCEEDED'); 
    }
    throw error;
  }
  
  return path;
}

async function fileURL(path){
  if(URL_CACHE[path]) return URL_CACHE[path];
  const { data, error } = await SB.storage.from('files').createSignedUrl(path, 3600);
  if(error) return '';
  URL_CACHE[path] = data.signedUrl;
  return data.signedUrl;
}

async function removePaths(paths){ if(paths.length) await SB.storage.from('files').remove(paths); }

/* ===== прогресс-бар ===== */
let progressTimer = null;
function showProgress(filename){
  let el = document.getElementById('upload-progress');
  if(!el){
    document.body.insertAdjacentHTML('beforeend',
      `<div class="upload-progress" id="upload-progress">
        <div class="label"><span id="upload-name">загрузка...</span><span id="upload-pct">0%</span></div>
        <div class="bar"><div class="bar-fill" id="upload-bar-fill"></div></div>
      </div>`);
    el = document.getElementById('upload-progress');
  }
  document.getElementById('upload-name').textContent = filename;
  document.getElementById('upload-pct').textContent = '0%';
  document.getElementById('upload-bar-fill').style.width = '0%';
  el.classList.add('active');
  let pct = 0;
  progressTimer = setInterval(() => {
    pct += Math.random() * 10;
    if(pct > 90) pct = 90;
    document.getElementById('upload-pct').textContent = Math.round(pct) + '%';
    document.getElementById('upload-bar-fill').style.width = pct + '%';
  }, 150);
}

function hideProgress(ok){
  clearInterval(progressTimer);
  const el = document.getElementById('upload-progress');
  if(el){
    document.getElementById('upload-pct').textContent = ok ? '100%' : 'ошибка';
    document.getElementById('upload-bar-fill').style.width = ok ? '100%' : '0%';
    setTimeout(() => el.classList.remove('active'), 600);
  }
}

/* ===== камера ===== */
const view = { x: 0, y: 0, z: 1 };
let justDragged = 0;
let lastTabClick = { id: 0, t: 0 };

function applyView(){
  const c = $('#canvas'); if(!c) return;
  c.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.z})`;
  const ind = $('#view-ind');
  if(ind) ind.textContent = `${Math.round(view.z * 100)}%`;
}

function focusCard(id){
  const card = document.querySelector(`.canvas .card[data-id="${id}"]`);
  const desk = $('#desk');
  if(!card || !desk) return;
  const rect = desk.getBoundingClientRect();
  const cx = (+card.dataset.x || 0) + card.offsetWidth / 2;
  const cy = (+card.dataset.y || 0) + card.offsetHeight / 2;
  const tx = rect.width / 2 - view.z * cx;
  const ty = rect.height / 2 - view.z * cy;
  const sx = view.x, sy = view.y, t0 = performance.now(), dur = 450;
  const step = now => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    view.x = sx + (tx - sx) * e; view.y = sy + (ty - sy) * e;
    applyView();
    if(k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function initCanvas(){
  const desk = $('#desk'); if(!desk || !$('#canvas')) return;
  if(!$('#view-ind')) document.body.insertAdjacentHTML('beforeend','<div id="view-ind"></div>');
  applyView();

  const ptrs = new Map();
  let gesture = '';
  let g = null;
  const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const td2 = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  // ---- POINTER: только ОДИН палец (pan / drag / tap). Во время pinch молчим. ----
 desk.addEventListener('pointerdown', e => {
  if(gesture === 'pinch') return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try{ desk.setPointerCapture(e.pointerId); }catch(_){}
  if(ptrs.size > 1) return;
  const card = e.target.closest('.card');
  if(card && card.dataset.id && mode === 'cursor'){
    gesture = 'card';
    g = { id: +card.dataset.id, card, p0:{ x: +card.dataset.x || 0, y: +card.dataset.y || 0 }, sx: e.clientX, sy: e.clientY, t0: performance.now(), moved: false };
  } else if(card && card.dataset.id && mode === 'rename'){
    const it = Store.find(+card.dataset.id);
    openModal({ id: +card.dataset.id, value: it ? it.name : '' });
    gesture = '';
  } else if(!card){
    gesture = 'pan';
    g = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
  } else gesture = '';
});

  desk.addEventListener('pointermove', e => {
    if(gesture === 'pinch') return;
    if(!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, {x:e.clientX, y:e.clientY});
    if(gesture === 'pan' && ptrs.size === 1){
      view.x = g.ox + (e.clientX - g.sx); view.y = g.oy + (e.clientY - g.sy); applyView(); return;
    }
    if(gesture === 'card' && ptrs.size === 1){
      if(!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 8) return;
      g.moved = true; g.card.classList.add('dragging');
      const nx = g.p0.x + (e.clientX - g.sx) / view.z;
      const ny = g.p0.y + (e.clientY - g.sy) / view.z;
      g.card.style.transform = `translate(${nx}px,${ny}px)`;
      g.card.dataset.x = nx; g.card.dataset.y = ny;
    }
  });

   const pend = e => {
    ptrs.delete(e.pointerId);
    if(gesture === 'pinch'){
      if(ptrs.size < 2){ gesture = ''; g = null; }
      return;
    }
    if(gesture === 'card'){
      g.card.classList.remove('dragging');
      if(g.moved){
        justDragged = performance.now();
        const p = POS.get();
        p[g.id] = {x: Math.round(+g.card.dataset.x), y: Math.round(+g.card.dataset.y)};
        POS.set(p);
      } else if(e.pointerType === 'touch' && performance.now() - g.t0 < 350){
        location.href = 'note.html?id=' + g.id;
      }
    }
    if(ptrs.size === 0){ gesture = ''; g = null; }
  };
  desk.addEventListener('pointerup', pend);
  desk.addEventListener('pointercancel', pend);

  // ---- TOUCH: только ДВА пальца (pinch). На iOS pointer для мультитач — мусор, тут e.touches железный. ----
  desk.addEventListener('touchstart', e => {
    if(e.touches.length === 2){
      gesture = 'pinch';
      g = {d0: td2(e.touches[0], e.touches[1]), z0: view.z};
    }
  }, {passive: true});

  desk.addEventListener('touchmove', e => {
    if(gesture !== 'pinch' || e.touches.length !== 2) return;
    e.preventDefault();
    const a = e.touches[0], b = e.touches[1];
    const r = desk.getBoundingClientRect();
    const cx = (a.clientX + b.clientX) / 2 - r.left;
    const cy = (a.clientY + b.clientY) / 2 - r.top;
    const d = td2(a, b);
    const nz = Math.min(2, Math.max(0.4, g.z0 * (d / g.d0)));
    const ratio = nz / view.z;
    view.x = cx - (cx - view.x) * ratio;
    view.y = cy - (cy - view.y) * ratio;
    view.z = nz;
    applyView();
  }, {passive: false});

  desk.addEventListener('touchend', e => {
    if(gesture === 'pinch' && e.touches.length < 2){ gesture = ''; g = null; }
  }, {passive: true});

  // ---- ctrl+wheel живёт для мыши, pointer его не заменяет ----
  desk.addEventListener('wheel', e => {
    if(!e.ctrlKey) return; e.preventDefault();
    const r = desk.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const nz = Math.min(2, Math.max(0.4, view.z * (e.deltaY < 0 ? 1.1 : 0.9)));
    const ratio = nz / view.z;
    view.x = px - (px - view.x) * ratio;
    view.y = py - (py - view.y) * ratio;
    view.z = nz; applyView();
  }, {passive: false});
  desk.addEventListener('auxclick', e => e.preventDefault());
}
/* ===== рендер ===== */
function cardHTML(it, p){
  const cnt = (it.files || []).length;
  const body = `<img src="icons/${ICON.folder}" alt="" class="folder-icon"><span class="folder-count">${cnt} файл${cnt === 1 ? '' : cnt < 5 ? 'а' : 'ов'}</span>`;
  const act = it.id === ACTIVE.get() ? ' active' : '';
  const place = p ? `data-x="${p.x}" data-y="${p.y}" style="transform:translate(${p.x}px,${p.y}px)"` : '';
  return `<div class="card${act}" data-id="${it.id}"${place}><header>${it.pin ? '<img class="pin-mark" src="icons/pin.png" alt="">' : ''}${esc(it.name)}</header><div class="body">${body}</div></div>`;
}

function renderTabs(items){
  const t = $('#tabs'); if(!t) return;
  t.innerHTML = items.map(it => {
    const open = OPEN.has(it.id);
    const on = open && it.id === ACTIVE.get();
    return `<div class="tab${on ? ' on' : ''}${open ? '' : ' dim'}" data-id="${it.id}"><span class="tab-label">${esc(it.name)}</span><button class="tab-hide" data-hide="${it.id}" title="скрыть">–</button><button class="tab-x" data-del="${it.id}" title="удалить">×</button></div>`;
  }).join('');
}

function applyFilter(q){
  const d = $('#desk'); if(!d) return;
  const items = Store.cache;
  const open = OPEN.get();
  let found = q ? items.filter(it => it.name.toLowerCase().includes(q))
                : items.filter(it => open.includes(it.id));
  const act = ACTIVE.get();
  found = [...found].sort((a, b) => ((b.pin ? 1 : 0) - (a.pin ? 1 : 0)) || (a.id === act ? -1 : b.id === act ? 1 : 0));
  const canvas = $('#canvas'), ew = $('#desk-empty');
  const emptyMsg = q ? emptyHTML('sad.png', 'Ничего не найдено...')
    : items.length ? emptyHTML('folder-x.png', 'Все папки скрыты')
    : emptyHTML('folder-x.png', 'Тут пока пусто — нажмите +');
    
  if(canvas){
    if(!found.length){ canvas.innerHTML = ''; if(ew){ ew.hidden = false; ew.innerHTML = emptyMsg; } }
    else {
      if(ew){ ew.hidden = true; ew.innerHTML = ''; }
      const pos = POS.get();
      const savedKeys = new Set(Object.values(pos).map(p => Math.round(p.x/CELLW)+':'+Math.round(p.y/CELLH)));
      const used = new Set(); let c = 0;
      canvas.innerHTML = found.map(it => {
        let p = pos[it.id];
        if(!p){
          let key, cell;
          do { const col = c%6, row = Math.floor(c/6); key = col+':'+row; cell = {x:40+col*CELLW,y:40+row*CELLH}; c++; }
          while((savedKeys.has(key)||used.has(key))&&c<600);
          used.add(key); p = cell;
        }
        return cardHTML(it, p);
      }).join('');
    }
  } else {
    d.innerHTML = found.length ? found.map(it => cardHTML(it, null)).join('') : emptyMsg;
  }
  renderTabs(items);
  fitHeaders();
}

/* ===== поиск ===== */
function ensureSuggest(){
  let s = $('#suggest');
  if(s) return s;
  const box = document.querySelector('.search');
  if(!box) return null;
  box.insertAdjacentHTML('beforeend', '<ul id="suggest" hidden></ul>');
  s = $('#suggest');
  s.addEventListener('mousedown', e => {
    const li = e.target.closest('li[data-id]');
    if(!li) return;
    e.preventDefault();
    const id = +li.dataset.id;
    const inp = document.querySelector('.search input');
    const it = Store.find(id);
    if(inp && it) inp.value = it.name;
    ACTIVE.set(id); applyFilter(currentQ()); s.hidden = true; focusCard(id);
  });
  return s;
}

function showSuggest(q){
  const s = ensureSuggest(); if(!s) return;
  const found = q ? Store.cache.filter(it => it.name.toLowerCase().includes(q)).slice(0, 8) : [];
  if(!found.length){ s.hidden = true; s.innerHTML = ''; return; }
  s.innerHTML = found.map(it => `<li data-id="${it.id}">${esc(it.name)}</li>`).join('');
  s.hidden = false;
}

function initSearch(){
  const d = $('#desk'); if(!d) return;
  const inp = document.querySelector('.search input'); if(!inp) return;
  const q0 = (new URLSearchParams(location.search).get('q') || '').toLowerCase().trim();
  inp.value = q0; applyFilter(q0); showSuggest(q0);
  inp.addEventListener('input', () => { const q = inp.value.toLowerCase().trim(); applyFilter(q); showSuggest(q); });
  inp.addEventListener('focus', () => showSuggest(inp.value.toLowerCase().trim()));
  inp.addEventListener('keydown', e => { if(e.key === 'Escape'){ const s = $('#suggest'); if(s) s.hidden = true; } });
  const sf = document.querySelector('form.search');
  if(sf) sf.addEventListener('submit', e => { e.preventDefault(); location.href = 'search.html?q=' + encodeURIComponent(inp.value.trim()); });
  document.addEventListener('click', e => { const s = $('#suggest'); if(s && !e.target.closest('.search')) s.hidden = true; });
}

/* ===== модалка создания папки ===== */
function openModal(o = {}){
  const m = $('#modal');
  if(!m){ console.error('нет #modal'); return; }
  m.dataset.renameId = o.id || '';
  $('#new-name').value = o.value || '';
  $('#new-name').classList.remove('err');
  m.hidden = false; $('#new-name').focus();
}
const mok = $('#new-ok');
if(mok) mok.addEventListener('click', async () => {
  const inp = $('#new-name'); const name = inp.value.trim();
  if(!name){ inp.classList.add('err'); return; }
  const m = $('#modal');
  const rid = m ? m.dataset.renameId : '';
  m.hidden = true;
  m.dataset.renameId = '';
  if(rid){
    const it = Store.find(+rid);
    if(it){ it.name = name; await Store.save(it); }
    applyFilter(currentQ());
    return;
  }
  const id = Date.now();
  const it = { id, name, text: '', pin: false, files: [] };
  Store.cache.push(it);
  OPEN.add(id); ACTIVE.set(id);
  await Store.save(it);
  location.href = 'note.html?id=' + id;
});
const modal = $('#modal');
if(modal) modal.addEventListener('mousedown', e => { if(e.target === modal){ modal.hidden = true; modal.dataset.renameId = ''; } });
/* ===== стол ===== */
let mode = '';
document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
  mode = (mode === b.dataset.mode) ? '' : b.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('active', x.dataset.mode === mode));
  document.body.classList.toggle('rename-mode', mode === 'rename');
  document.body.classList.toggle('drag-mode', mode === 'cursor');
}));

function askDelete(id){
  const it = Store.find(id); if(!it) return;
  askConfirm(`Удалить папку «${it.name}»?`, async () => {
    const cb = $('#confirm-ok'); busy(cb, true, ' удаляем...');
    try{
      const paths = (it.files || []).map(f => f.path).filter(Boolean);
      if(paths.length) await removePaths(paths);
      await Store.remove(id);
      Store.cache = Store.cache.filter(x => x.id !== id);
      OPEN.remove(id); if(ACTIVE.get() === id) ACTIVE.set(0);
      const pos = POS.get(); delete pos[id]; POS.set(pos);
      applyFilter(currentQ());
    } finally { busy(cb, false); }
  });
}

document.addEventListener('click', e => {
  if(performance.now() - justDragged < 400) return;
  const del = e.target.closest('[data-del]');
  if(del){ e.preventDefault(); askDelete(+del.dataset.del); return; }
  const hide = e.target.closest('[data-hide]');
  if(hide){ const id = +hide.dataset.hide; OPEN.remove(id); if(ACTIVE.get()===id) ACTIVE.set(0); applyFilter(currentQ()); return; }
  const tab = e.target.closest('.tab');
  if(tab){
    const id = +tab.dataset.id;
    const now = performance.now();
    const dbl = (lastTabClick.id === id && now - lastTabClick.t < 400);
    lastTabClick = { id, t: now };
    OPEN.add(id); ACTIVE.set(id); applyFilter(currentQ());
    if(dbl) focusCard(id);
    return;
  }
  const card = e.target.closest('.card');
  if(card && card.dataset.id && mode === 'pin'){
    const it = Store.find(+card.dataset.id);
    if(!it) return;
    it.pin = !it.pin; Store.save(it); applyFilter(currentQ());
  }
});

document.addEventListener('dblclick', e => {
  if(mode === 'rename') return;
  if (performance.now() - justDragged < 400) return;
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const card = under ? under.closest('.card') : null;
  if (card && card.dataset.id) location.href = 'note.html?id=' + card.dataset.id;
});
/* ===== ХОЛСТ ВНУТРИ ПАПКИ (v2-рез, desk не тронут) ===== */
let nCUR = null, nmode = '', nlinkFrom = null, njustDragged = 0;
const nview = { x: 0, y: 0, z: 1 };

function napplyView(){
  const c = $('#note-canvas'); if(!c) return;
  c.style.transform = `translate(${nview.x}px,${nview.y}px) scale(${nview.z})`;
  const ind = $('#note-ind'); if(ind) ind.textContent = `${Math.round(nview.z*100)}%`;
}
function nnormalize(it){
  if(!it.note) it.note = { x: 40, y: 40, color: '' };
  if(!it.links) it.links = [];
  (it.files||[]).forEach((f,i)=>{ if(f.x==null) f.x = 300 + (i%5)*24; if(f.y==null) f.y = 60 + (i%5)*24; if(f.color==null) f.color = ''; });
}
function ncardObj(kind, id){
  if(kind === 'note') return { ref: nCUR.note, isNote: true };
  const f = (nCUR.files||[]).find(x => x.path === id);
  return f ? { ref: f, isNote: false } : null;
}
function ncardHTML(kind, id, name, x, y, color, bodyHTML){
  const st = color ? ` style="background:${color}"` : '';
  return `<div class="ncard" data-kind="${kind}" data-id="${esc(id)}" data-x="${x}" data-y="${y}" style="transform:translate(${x}px,${y}px)">
    <header${st}>${esc(name)}</header><div class="ncbody">${bodyHTML}</div></div>`;
}
async function nrender(){
  const c = $('#note-canvas'); if(!c || !nCUR) return;
  const q = ($('#note-q')?.value || '').toLowerCase().trim();
  const hit = s => !q || String(s).toLowerCase().includes(q);
  const parts = [];
  const n = nCUR.note, txt = (nCUR.text||'').trim();
  if(hit('заметка ' + txt)){
    parts.push(ncardHTML('note','note','заметка', n.x, n.y, n.color,
      `<div class="nprev">${txt ? esc(txt.length>160?txt.slice(0,160)+'…':txt) : '<span class="ph">пусто — нажми карандаш</span>'}</div>`));
  }
  for(const f of (nCUR.files||[])){
    if(!hit(f.name)) continue;
    let prev;
    if((f.mime||'').startsWith('image/')){ const u = await fileURL(f.path); prev = u ? `<img class="nimg" src="${u}" alt="">` : `<img class="nimg" src="icons/${ICON.file}" alt="">`; }
    else prev = `<img class="nimg" src="icons/${ICON.file}" alt=""><span class="ntag">${esc((f.mime||'файл').split('/').pop())}</span>`;
    parts.push(ncardHTML('file', f.path, f.name, f.x||0, f.y||0, f.color||'',
      `<div class="nfp">${prev}<span class="nfsize">${fmtSize(f.size||0)}</span></div>`));
  }
  c.innerHTML = parts.join('');
  nrenderLinks();
}
function nedgePt(cx,cy,w,h,tx,ty){
  let dx=tx-cx, dy=ty-cy; if(!dx && !dy) return {x:cx,y:cy};
  const sx = dx ? (w/2)/Math.abs(dx) : Infinity, sy = dy ? (h/2)/Math.abs(dy) : Infinity, s = Math.min(sx,sy);
  return {x:cx+dx*s, y:cy+dy*s};
}
function nrenderLinks(){
  const svg = $('#note-links'); if(!svg || !nCUR) return;
  const map = {};
  document.querySelectorAll('#note-canvas .ncard').forEach(c=>{
    const x=+c.dataset.x||0, y=+c.dataset.y||0;
    map[c.dataset.id] = { cx:x+c.offsetWidth/2, cy:y+c.offsetHeight/2, w:c.offsetWidth, h:c.offsetHeight };
  });
  let out='';
  (nCUR.links||[]).forEach((ln,i)=>{
    const a=map[ln.from], b=map[ln.to]; if(!a||!b) return;
    const p1=nedgePt(a.cx,a.cy,a.w,a.h,b.cx,b.cy), p2=nedgePt(b.cx,b.cy,b.w,b.h,a.cx,a.cy), col=ln.color||'#6b6275';
    out += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${col}" stroke-width="2"/>`;
    out += `<line class="nhit" data-i="${i}" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="transparent" stroke-width="18"/>`;
  });
  svg.innerHTML = out;
}
function nsetMode(m){
  nmode = m; nlinkFrom = null;
  ['#nd-cursor','#nd-pencil','#nd-link'].forEach(s=>{ const b=$(s); if(b) b.classList.remove('active'); });
  const on = { cursor:'#nd-cursor', rename:'#nd-pencil', link:'#nd-link' }[m];
  if(on){ const b=$(on); if(b) b.classList.add('active'); }
  const d = $('#note-desk');
  if(d){ d.classList.toggle('n-rename', m==='rename'); d.classList.toggle('n-drag', m==='cursor'); d.classList.toggle('n-link', m==='link'); }
  document.querySelectorAll('.nsrc').forEach(x=>x.classList.remove('nsrc'));
}
function ninitCanvas(){
  const desk = $('#note-desk'); if(!desk || !$('#note-canvas')) return;
  nview.x=0; nview.y=0; nview.z=1; napplyView();
  const ptrs = new Map(); let gesture='', g=null;
  const td2=(a,b)=>Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY);
  desk.addEventListener('pointerdown', e=>{
    if(gesture==='pinch') return;
    ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY});
    try{ desk.setPointerCapture(e.pointerId); }catch(_){}
    if(ptrs.size>1) return;
    const card = e.target.closest('.ncard');
    if(card && nmode==='cursor'){ gesture='card'; g={card, p0:{x:+card.dataset.x||0,y:+card.dataset.y||0}, sx:e.clientX, sy:e.clientY, moved:false}; }
    else if(!card){ gesture='pan'; g={sx:e.clientX,sy:e.clientY,ox:nview.x,oy:nview.y}; }
    else gesture='';
  });
  desk.addEventListener('pointermove', e=>{
    if(gesture==='pinch') return; if(!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(gesture==='pan' && ptrs.size===1){ nview.x=g.ox+(e.clientX-g.sx); nview.y=g.oy+(e.clientY-g.sy); napplyView(); return; }
    if(gesture==='card' && ptrs.size===1){
      if(!g.moved && Math.hypot(e.clientX-g.sx,e.clientY-g.sy)<8) return;
      g.moved=true; g.card.classList.add('ndrag');
      const nx=g.p0.x+(e.clientX-g.sx)/nview.z, ny=g.p0.y+(e.clientY-g.sy)/nview.z;
      g.card.style.transform=`translate(${nx}px,${ny}px)`; g.card.dataset.x=nx; g.card.dataset.y=ny; nrenderLinks();
    }
  });
  const pend = e=>{
    ptrs.delete(e.pointerId);
    if(gesture==='pinch'){ if(ptrs.size<2){gesture='';g=null;} return; }
    if(gesture==='card'){
      g.card.classList.remove('ndrag');
      if(g.moved){ njustDragged=performance.now(); const o=ncardObj(g.card.dataset.kind,g.card.dataset.id); if(o){ o.ref.x=Math.round(+g.card.dataset.x); o.ref.y=Math.round(+g.card.dataset.y); saveSoon(nCUR); } }
    }
    if(ptrs.size===0){ gesture=''; g=null; }
  };
  desk.addEventListener('pointerup', pend); desk.addEventListener('pointercancel', pend);
  desk.addEventListener('touchstart', e=>{ if(e.touches.length===2){ gesture='pinch'; g={d0:td2(e.touches[0],e.touches[1]),z0:nview.z}; } }, {passive:true});
  desk.addEventListener('touchmove', e=>{
    if(gesture!=='pinch'||e.touches.length!==2) return; e.preventDefault();
    const a=e.touches[0],b=e.touches[1],r=desk.getBoundingClientRect();
    const cx=(a.clientX+b.clientX)/2-r.left, cy=(a.clientY+b.clientY)/2-r.top, d=td2(a,b);
    const nz=Math.min(2,Math.max(0.4,g.z0*(d/g.d0))), ratio=nz/nview.z;
    nview.x=cx-(cx-nview.x)*ratio; nview.y=cy-(cy-nview.y)*ratio; nview.z=nz; napplyView();
  }, {passive:false});
  desk.addEventListener('touchend', e=>{ if(gesture==='pinch'&&e.touches.length<2){gesture='';g=null;} }, {passive:true});
  desk.addEventListener('wheel', e=>{
    if(!e.ctrlKey) return; e.preventDefault();
    const r=desk.getBoundingClientRect(), px=e.clientX-r.left, py=e.clientY-r.top;
    const nz=Math.min(2,Math.max(0.4,nview.z*(e.deltaY<0?1.1:0.9))), ratio=nz/nview.z;
    nview.x=px-(px-nview.x)*ratio; nview.y=py-(py-nview.y)*ratio; nview.z=nz; napplyView();
  }, {passive:false});
  desk.addEventListener('auxclick', e=>e.preventDefault());
}
function nopenCard(kind, id){
  const o = ncardObj(kind,id); if(!o) return;
  $('#nc-title').textContent = o.isNote ? 'Заметка папки' : 'Файл';
  $('#nc-name-wrap').hidden = o.isNote; $('#nc-text-wrap').hidden = !o.isNote; $('#nc-acts').hidden = o.isNote;
  $('#nc-name').value = o.isNote ? '' : (o.ref.name||'');
  $('#nc-text').value = o.isNote ? (nCUR.text||'') : '';
  $('#nc-color').value = o.ref.color || '#8f6bab';
  $('#ncform').dataset.kind = kind; $('#ncform').dataset.id = id; $('#ncform').hidden = false;
}
function nopenLink(i){ const ln=(nCUR.links||[])[i]; if(!ln) return; $('#nl-color').value = ln.color||'#6b6275'; $('#nlform').dataset.i=i; $('#nlform').hidden=false; }
function ntapCard(card){
  if(nmode==='link'){
    const id = card.dataset.id;
    if(!nlinkFrom){ nlinkFrom=id; card.classList.add('nsrc'); return; }
    if(nlinkFrom===id){ card.classList.remove('nsrc'); nlinkFrom=null; return; }
    const dup=(nCUR.links||[]).some(l=>(l.from===nlinkFrom&&l.to===id)||(l.from===id&&l.to===nlinkFrom));
    if(!dup){ nCUR.links.push({from:nlinkFrom,to:id,color:''}); saveSoon(nCUR); }
    document.querySelectorAll('.nsrc').forEach(x=>x.classList.remove('nsrc')); nlinkFrom=null; nrenderLinks(); return;
  }
  if(nmode==='rename'){ nopenCard(card.dataset.kind, card.dataset.id); return; }
  if(card.dataset.kind==='note'){ nopenCard('note','note'); return; }
  (async()=>{ const u=await fileURL(card.dataset.id); if(u) window.open(u,'_blank'); else info('Не удалось открыть файл.'); })();
}

async function notePage(){
  const sh = $('#sheet');
  const id = +new URLSearchParams(location.search).get('id');
  const it = Store.find(id);
  if(!it) return location.replace('desk.html');
  nCUR = it; nnormalize(it);
  if(sh) sh.style.display = 'none';
  if(!$('#note-root')){
    document.body.insertAdjacentHTML('beforeend',
      `<div id="note-root">
        <header class="n-top">
          <a class="n-back" href="desk.html" title="назад">↩</a>
          <div class="n-name" id="n-name"></div>
          <div class="n-search"><input id="note-q" type="text" placeholder="поиск по карточкам..." autocomplete="off"></div>
        </header>
        <main id="note-desk"><svg id="note-links"></svg><div id="note-canvas"></div></main>
        <div id="note-ind"></div>
       <nav class="n-bar">
  <button class="ntbtn" id="nd-cursor" title="двигать"><img src="icons/cursor.png" alt=""></button>
  <button class="ntbtn" id="nd-plus" title="добавить файл"><img src="icons/plus.png" alt=""></button>
  <button class="ntbtn" id="nd-pencil" title="править карточку"><img src="icons/pen.png" alt=""></button>
  <button class="ntbtn" id="nd-link" title="связать карточки"><img src="icons/clip.png" alt=""></button>
</nav>
        <div class="modal" id="ncform" hidden><div class="modal-card">
          <h3 id="nc-title">Карточка</h3>
          <div id="nc-name-wrap"><input class="field" id="nc-name" placeholder="имя файла"></div>
          <div id="nc-text-wrap"><textarea class="field" id="nc-text" placeholder="заметка..." style="min-height:120px"></textarea></div>
          <label class="n-crow">цвет <input type="color" id="nc-color" value="#8f6bab"></label>
          <div class="auth-row" id="nc-acts"><button class="btn btn-ghost" id="nc-dl">скачать</button><button class="btn btn-ghost" id="nc-del">удалить</button></div>
          <div class="auth-row"><button class="btn" id="nc-ok">сохранить</button></div>
        </div></div>
        <div class="modal" id="nlform" hidden><div class="modal-card">
          <h3>Линия</h3>
          <label class="n-crow">цвет <input type="color" id="nl-color" value="#6b6275"></label>
          <div class="auth-row"><button class="btn btn-ghost" id="nl-del">удалить</button><button class="btn" id="nl-ok">сохранить</button></div>
        </div></div>
      </div>`);
    $('#n-name').textContent = it.name;
    $('#note-q').addEventListener('input', nrender);
    $('#nd-cursor').addEventListener('click', ()=> nsetMode(nmode==='cursor'?'':'cursor'));
    $('#nd-pencil').addEventListener('click', ()=> nsetMode(nmode==='rename'?'':'rename'));
    $('#nd-link').addEventListener('click', ()=> nsetMode(nmode==='link'?'':'link'));
    $('#nd-plus').addEventListener('click', ()=>{
      const inp = document.createElement('input'); inp.type='file'; inp.accept='*/*'; inp.multiple=true;
      inp.onchange = async ()=>{
        const fs = Array.from(inp.files); if(!fs.length) return;
        for(const f of fs){ if(!guardLimits(f)) return; }
        const addBtn = $('#nd-plus'); busy(addBtn, true, `⏳ ${fs.length}...`);
        let ok=0;
        for(const f of fs){
          showProgress(f.name);
          try{
            const path = await uploadFile(f, id);
            nCUR.files = nCUR.files || [];
            nCUR.files.push({ name:f.name, path, size:f.size, mime:f.type||'', x:300+(nCUR.files.length%5)*24, y:60+(nCUR.files.length%5)*24, color:'' });
            ok++;
          }catch(err){
            if(err.message==='LIMIT_EXCEEDED'){ info('Превышен лимит хранилища. Удалите старые файлы или обновите тариф.'); hideProgress(false); busy(addBtn,false); return; }
            console.error('Ошибка загрузки:', f.name, err); info(`Не удалось загрузить ${f.name}`);
          }
        }
        if(ok) await Store.save(nCUR);
        hideProgress(true); busy(addBtn,false); if(ok) await nrender();
      };
      inp.click();
    });
    $('#nc-ok').addEventListener('click', async ()=>{
      const kind=$('#ncform').dataset.kind, idv=$('#ncform').dataset.id, o=ncardObj(kind,idv); if(!o) return ($('#ncform').hidden=true);
      const color=$('#nc-color').value;
      if(o.isNote){ nCUR.text=$('#nc-text').value; o.ref.color=color; }
      else { o.ref.name=$('#nc-name').value.trim()||o.ref.name; o.ref.color=color; }
      await Store.save(nCUR); $('#ncform').hidden=true; await nrender();
    });
    $('#nc-dl').addEventListener('click', async ()=>{ const u=await fileURL($('#ncform').dataset.id); if(u){ const a=document.createElement('a'); a.href=u; a.download=''; a.click(); } });
    $('#nc-del').addEventListener('click', ()=>{
      const idv=$('#ncform').dataset.id;
      askConfirm('Удалить файл?', async ()=>{
        const cb=$('#confirm-ok'); busy(cb,true,'⏳ удаляем...');
        try{ await removePaths([idv]); nCUR.files=(nCUR.files||[]).filter(f=>f.path!==idv); nCUR.links=(nCUR.links||[]).filter(l=>l.from!==idv&&l.to!==idv); await Store.save(nCUR); $('#ncform').hidden=true; await nrender(); }
        finally{ busy($('#confirm-ok'),false); }
      });
    });
    $('#nl-ok').addEventListener('click', async ()=>{ const i=+$('#nlform').dataset.i, ln=(nCUR.links||[])[i]; if(!ln) return ($('#nlform').hidden=true); ln.color=$('#nl-color').value; await Store.save(nCUR); nrenderLinks(); $('#nlform').hidden=true; });
    $('#nl-del').addEventListener('click', ()=>{ const i=+$('#nlform').dataset.i; askConfirm('Удалить линию?', async ()=>{ nCUR.links.splice(i,1); await Store.save(nCUR); nrenderLinks(); $('#nlform').hidden=true; }); });
    $('#ncform').addEventListener('mousedown', e=>{ if(e.target.id==='ncform') $('#ncform').hidden=true; });
    $('#nlform').addEventListener('mousedown', e=>{ if(e.target.id==='nlform') $('#nlform').hidden=true; });
    $('#note-canvas').addEventListener('click', e=>{ if(performance.now()-njustDragged<350) return; const c=e.target.closest('.ncard'); if(c) ntapCard(c); });
    $('#note-links').addEventListener('click', e=>{ const h=e.target.closest('.nhit'); if(h) nopenLink(+h.dataset.i); });
    $('#note-desk').addEventListener('click', e=>{ if(nmode==='link' && !e.target.closest('.ncard') && !e.target.closest('.nhit')){ nlinkFrom=null; document.querySelectorAll('.nsrc').forEach(x=>x.classList.remove('nsrc')); } });
  } else {
    $('#n-name').textContent = it.name; $('#note-q').value='';
  }
  nsetMode(''); ninitCanvas(); await nrender();
}
/* ===== настройки ===== */
function accountPage(){
  const em = $('#acc-email'); 
  if(em) {
    em.textContent = DB.session;
    // Уменьшаем шрифт и разрешаем перенос, чтобы влезало в рамку
    em.style.fontSize = '14px';
    em.style.wordBreak = 'break-all';
    em.style.lineHeight = '1.3';
  }
  
  const pl = $('#acc-plan'); 
  if(pl) pl.textContent = LIMITS[DB.plan(DB.session)].label;
  
  const da = $('#del-acc');
  if(da) da.addEventListener('click', e => {
    e.preventDefault();
    askConfirm(`Удалить аккаунт «${DB.session}» и все папки в облаке?`, async () => {
      const ids = Store.cache.map(x => x.id);
      if(ids.length) await SB.from('folders').delete().in('id', ids);
      localStorage.removeItem('cn_plan_' + DB.session);
      localStorage.removeItem('cn_pos_' + DB.session);
      clearOpen(DB.session);
      Store.cache = [];
      if(typeof SB !== 'undefined') SB.auth.signOut();
      DB.session = ''; location.href = 'index.html';
    });
  });
  const aa = $('#add-acc');
  if(aa) aa.addEventListener('click', e => { e.preventDefault(); location.href = 'reg.html'; });
}

function storagePage(){
  const wrap = $('#storage-wrap'); if(!wrap) return;
  const em = DB.session, p = DB.plan(em), L = LIMITS[p], used = usedBytes();
  const pct = isFinite(L.bytes) ? Math.min(100, used / L.bytes * 100) : 0;
  $('#storage-bar').style.width = pct + '%';
  $('#storage-cap').textContent = isFinite(L.bytes)
    ? `Использовано ${fmtSize(used)} из ${L.label}`
    : `Использовано ${fmtSize(used)} — безлимит`;
  document.querySelectorAll('[data-plan]').forEach(b => {
    const bp = b.dataset.plan;
    b.classList.toggle('active-plan', bp === p);
    b.textContent = bp === p ? 'текущий тариф' : (bp === 'basic' ? '0 руб/мес' : '500 руб/мес');
   b.onclick = () => {
  if (bp === 'pro') { info('Функция временно недоступна. Пользуйтесь базовым тарифом...'); return; }
  DB.setPlan(em, bp); storagePage();
};
  });
}

/* ===== темы ===== */
(function(){
  const THEMES = [
    { id:'lavender', color:'linear-gradient(135deg,#8f6bab,#b98fd4)' },
    { id:'mint',     color:'linear-gradient(135deg,#2f9c86,#7fd0be)' },
    { id:'peach',    color:'linear-gradient(135deg,#d97e57,#f2b28c)' },
    { id:'night',    color:'linear-gradient(135deg,#241b33,#a678d8)' }
  ];
  const cur = () => localStorage.cn_theme || 'lavender';
  const apply = t => {
    document.documentElement.dataset.theme = t;
    localStorage.cn_theme = t;
    document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('on', s.dataset.theme === t));
  };
  apply(cur());
  const bar = document.querySelector('.topbar');
  if(!bar) return;
 // if(!$('#theme-btn')){
  //  bar.insertAdjacentHTML('beforeend',
   //   `<button class="iconbtn" id="theme-btn" title="темы"><img src="icons/palette.png" alt=""></button><div id="theme-pop" hidden>${THEMES.map(t=>`<button class="swatch" data-theme="${t.id}" style="background:${t.color}"></button>`).join('')}</div>`);
// }
 // const btn = $('#theme-btn'), pop = $('#theme-pop');
 // if(btn) btn.addEventListener('click', e => { e.stopPropagation(); pop.hidden = !pop.hidden; apply(cur()); });
  //if(pop) pop.addEventListener('click', e => { const s = e.target.closest('.swatch'); if(s) apply(s.dataset.theme); });
//  document.addEventListener('click', e => { if(!e.target.closest('#theme-pop')&&!e.target.closest('#theme-btn')) pop.hidden = true; });
})();

/* ===== рандомная капча ===== */
let captchaAnswer = 0;
function generateCaptcha() {
  const a = Math.floor(Math.random() * 10) + 1;
  const b = Math.floor(Math.random() * 10) + 1;
  captchaAnswer = a + b;
  const inp = $('#reg-captcha');
  if (inp) inp.placeholder = `Сколько будет ${a} + ${b}?`;
}
// Генерируем при загрузке
generateCaptcha();

/* ===== auth ===== */
const lf = $('#login-form');
if (lf) lf.addEventListener('submit', async e => {
  e.preventDefault();
  const em = lf.email.value.trim(), ps = lf.pass.value;
  const errEl = lf.querySelector('.err-msg');
  const bad = m => {
    lf.email.classList.add('err');
    lf.pass.classList.add('err');
    if (errEl) { errEl.textContent = m; errEl.hidden = false; }
  };
  if (!em || !ps) return bad('заполните оба поля');
  const lb = lf.querySelector('.btn'); busy(lb, true, ' ⏳ входим... ');
  try {
    const { error } = await SB.auth.signInWithPassword({ email: em, password: ps });
    if (error) {
      const msg = String(error.message || '');
      if (/confirm/i.test(msg)) return bad('почта не подтверждена — откройте письмо и нажмите ссылку, потом вернитесь и введите пароль');
      if (/rate limit|too many/i.test(msg)) return bad('слишком много попыток, подождите минуту');
      return bad(msg || 'неверный email или пароль');
    }
    clearOpen(em); location.href = 'desk.html';
  } finally { busy(lb, false); }
});

const rf = $('#reg-form');
if(rf) rf.addEventListener('submit', async e => {
  e.preventDefault();
  
  // --- 1. ПРОВЕРКА КАПЧИ ---
  const captchaInput = $('#reg-captcha');
  const userAnswer = parseInt(captchaInput.value.trim(), 10);
  
  if (isNaN(userAnswer) || userAnswer !== captchaAnswer) {
    const err = rf.querySelector('.err-msg');
    err.textContent = 'Неверный ответ! Попробуйте ещё раз.';
    err.hidden = false;
    if(captchaInput) captchaInput.classList.add('err');
    generateCaptcha(); // Меняем вопрос
    captchaInput.value = '';
    return;
  }
  if(captchaInput) captchaInput.classList.remove('err');
  // --------------------------

  const em = rf.email.value.trim(), p1 = rf.pass.value, p2 = rf.pass2.value;
  const err = rf.querySelector('.err-msg');
  const bad = m => { err.textContent = m; err.hidden = false; err.style.color = ''; };
  
  if(!em || !p1 || !p2) return bad('заполните все поля');
  if(!EMAIL_RE.test(em)) return bad('похоже, это не почта');
  if(p1 !== p2) return bad('пароли не совпадают');
  
  const rb = rf.querySelector('.btn'); 
  busy(rb, true, ' создаём...');
  
  try {
    const { data, error } = await SB.auth.signUp({
  email: em,
  password: p1,
  options: { emailRedirectTo: 'https://leonidseputis2019-cmd.github.io/cloud_notes/index.html' }
});
if (error) return bad(error.message);
    // --- 2. ПРОВЕРКА НА ПОДТВЕРЖДЕНИЕ EMAIL ---
        if (!data.session) {
      err.innerHTML =
        '✨ Аккаунт создан! Мы отправили письмо на английском.<br>' +
        'Шаг 1 — открой почту и нажми синюю ссылку <b>Confirm email address</b>.<br>' +
        'Шаг 2 — вернись на эту страницу.<br>' +
        'Шаг 3 — войди своим email и паролем.';
      err.style.color = '#2f9c86';
      err.hidden = false;
      rb.textContent = 'Письмо отправлено';
      rb.disabled = true;
      return;
    }
    // ------------------------------------------

    clearOpen(em); 
    location.href = 'desk.html';
    
  } finally { 
    busy(rb, false); 
  }
});

if(typeof SB !== 'undefined') document.querySelectorAll('#logout, .logout-btn').forEach(lo => lo.addEventListener('click', async e => {
  e.preventDefault(); busy(lo, true, ' выходим...');
  try{ clearOpen(DB.session); await SB.auth.signOut(); DB.session = ''; location.href = 'index.html'; }
  finally { busy(lo, false); }
}));

/* ===== ГЛАВНАЯ = СПИСОК (фронт 2, префикс L, note-рез n* не тронут) ===== */
let Lmode = '', Lq = '';
function LcanAddFolder(){
  const L = LIMITS[DB.plan(DB.session)];
  if(Store.cache.length >= L.folders){ info(`На тарифе «${DB.plan(DB.session)==='basic'?'Базовый':'PRO'}» не более ${L.folders} папок.`); return false; }
  return true;
}
function LrowHTML(it){
  const fs = it.files || [];
  const cnt = fs.length;
  const sum = fs.reduce((s,f)=>s+(f.size||0),0);
  const meta = cnt ? `${cnt} файл${cnt===1?'':cnt<5?'а':'ов'} · ${fmtSize(sum)}` : 'пусто';
  return `<div class="lrow" data-id="${it.id}">
    <div class="lrow-photo"><img src="icons/${ICON.folder}" alt=""></div>
    <div class="lrow-main">
      <div class="lrow-name">${esc(it.name)}</div>
      <div class="lrow-desc">${esc(meta)}</div>
    </div>
  </div>`;
}
function LrenderList(){
  const box = $('#l-list'); if(!box) return;
  const q = Lq.toLowerCase().trim();
  const items = q ? Store.cache.filter(it => (it.name+' '+(it.text||'')).toLowerCase().includes(q)) : Store.cache;
  box.innerHTML = items.length ? items.map(LrowHTML).join('') : `<div class="empty"><img src="icons/${q?'sad':'folder-x'}.png" alt=""><p>${q?'Ничего не найдено...':'Тут пока пусто — нажмите +'}</p></div>`;
}
function LopenFolder(o){
  $('#l-title').textContent = o.id ? 'Папка' : 'Новая папка';
  $('#l-name').value = o.name || '';
  $('#l-desc').value = o.text || '';
  $('#l-name').classList.remove('err');
  $('#l-del').hidden = !o.id;
  $('#lform').dataset.edit = o.id || '';
  $('#lform').hidden = false; $('#l-name').focus();
}
function Lboot(){
  // прячем живой холст папок, оставляем живой topbar/поиск/шестерёнку
  ['#desk','#tabs','#modal','#view-ind','#desk-empty'].forEach(s=>{ const e=$(s); if(e) e.style.display='none'; });
  // переиспользуем живой .toolbar: вычищаем мёртвые [data-mode], кладём свои
  const tb = document.querySelector('.toolbar');
  if(tb){ tb.innerHTML = `<button class="tbtn" id="l-plus" title="создать папку"><img src="icons/plus.png" alt="+"></button><button class="tbtn" id="l-pencil" title="переименовать папку"><img src="icons/rename.png" alt="✎"></button>`; }
  // список
  if(!$('#l-list')) document.body.insertAdjacentHTML('beforeend','<main class="l-list" id="l-list"></main>');
  // модалка папки (имя + описание + удалить), на живых классах .modal/.field/.btn
  if(!$('#lform')) document.body.insertAdjacentHTML('beforeend',
    `<div class="modal" id="lform" hidden><div class="modal-card">
      <h3 id="l-title">Новая папка</h3>
      <input class="field" id="l-name" placeholder="название папки">
      <textarea class="field" id="l-desc" placeholder="описание / заметка"></textarea>
      <div class="auth-row" id="l-del-row"><button class="btn btn-ghost" id="l-del">удалить папку</button></div>
      <div class="auth-row"><button class="btn" id="l-ok">сохранить</button></div>
    </div></div>`);
  // поиск живой -> фильтр списка (живой initSearch не запущен, конфликтов нет)
  const si = document.querySelector('.search input');
  if(si){ si.value=''; si.addEventListener('input', ()=>{ Lq = si.value; LrenderList(); }); }
  // бар
  const lp = $('#l-plus'), lpen = $('#l-pencil');
  if(lp) lp.addEventListener('click', ()=>{ if(LcanAddFolder()) LopenFolder({}); });
  if(lpen) lpen.addEventListener('click', ()=>{ Lmode = Lmode==='rename'?'':'rename'; if(lpen) lpen.classList.toggle('active', Lmode==='rename'); document.body.classList.toggle('rename-mode', Lmode==='rename'); });
  // модалка
  if($('#l-ok')) $('#l-ok').addEventListener('click', async ()=>{
    const name = $('#l-name').value.trim(); if(!name){ $('#l-name').classList.add('err'); return; }
    const text = $('#l-desc').value, editId = $('#lform').dataset.edit;
    if(editId){ const it = Store.find(+editId); if(it){ it.name=name; it.text=text; await Store.save(it); } }
    else { const it = { id: Date.now(), name, text, pin:false, files:[] }; Store.cache.push(it); await Store.save(it); }
    $('#lform').hidden = true; LrenderList();
  });
  if($('#l-del')) $('#l-del').addEventListener('click', ()=>{
    const id = +$('#lform').dataset.edit; const it = Store.find(id); if(!it) return;
    askConfirm(`Удалить папку «${it.name}» и все её файлы?`, async ()=>{
      const cb = $('#confirm-ok'); busy(cb, true, '⏳ удаляем...');
      try{ const paths=(it.files||[]).map(f=>f.path).filter(Boolean); if(paths.length) await removePaths(paths); await Store.remove(id); Store.cache=Store.cache.filter(x=>x.id!==id); $('#lform').hidden=true; LrenderList(); }
      finally{ busy($('#confirm-ok'), false); }
    });
  });
  if($('#lform')) $('#lform').addEventListener('mousedown', e=>{ if(e.target.id==='lform') $('#lform').hidden=true; });
  // строки: карандаш -> модалка, иначе -> внутрь папки
  $('#l-list').addEventListener('click', e=>{
    const row = e.target.closest('.lrow'); if(!row) return;
    const id = +row.dataset.id;
    if(Lmode==='rename'){ const it=Store.find(id); if(it) LopenFolder({id:it.id,name:it.name,text:it.text}); return; }
    location.href = 'note.html?id=' + id;
  });
  LrenderList();
}

/* ===== старт ===== */
(async function(){
  if(typeof SB === 'undefined'){ console.error('SB не определён'); return; }
  const page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const closed = ['desk.html','note.html','search.html','settings.html','settings-account.html','settings-storage.html'];
  const { data } = await SB.auth.getSession();
  const u = data.session && data.session.user;
  if(closed.includes(page) && !u){ location.replace('index.html'); return; }
  if(u){ DB.session = u.email; MY_UID = u.id; await Store.load(); }
  if($('#sheet')){ notePage(); return; }
  accountPage();
  storagePage();
 if($('#desk')) Lboot();
if(OB.need() || localStorage.getItem('cn_tour')){ localStorage.removeItem('cn_tour'); setTimeout(() => OB.show(), 400); }
})();
/* ===== ОНБОРДИНГ ===== */
function obEl(tag, id){ const n = document.createElement(tag); if(id) n.id = id.slice(1); return n; }
function obHole(r, pad){
  const x1 = r.left - pad, y1 = r.top - pad, x2 = r.right + pad, y2 = r.bottom + pad, W = innerWidth, H = innerHeight;
  return `polygon(0 0,${W}px 0,${W}px ${H}px,0 ${H}px,0 0,${x1}px ${y1}px,${x1}px ${y2}px,${x2}px ${y2}px,${x2}px ${y1}px,${x1}px ${y1}px)`;
}
const OB = {
  steps: [
    { text: 'Добро пожаловать! Это твой стол — тут живут папки с заметками и файлами.' },
    { sel: '[data-mode="cursor"]', live: true, text: 'Стрелка — двигать папки по столу. Нажми её.' },
    { sel: '[data-mode="rename"]', live: true, text: 'Карандаш — переименовать папку одним кликом. Нажми.' },
    { text: 'Папку открываешь тапом (телефон) или двойным кликом (ПК).' },
    { sel: ['.tbtn[title="создать папку"]', '.tbtn'], text: 'Плюс внизу создаёт новую папку. Попробуй после обучения.' },
    { sel: ['.tab', '#tabs'], text: 'Вкладки сверху — открытые папки: клик открыть, – скрыть, × удалить.' },
    { sel: '.search input', text: 'Поиск сверху находит папки по имени.' },
    { sel: ['a.iconbtn[href="settings.html"]', '.iconbtn'], text: 'Шестерёнка — настройки, тариф и выход.' },
    { sel: '#view-ind', text: 'Уголок справа показывает масштаб; два пальца или Ctrl+колесо — зум.' },
    { text: 'Готово! Забудешь — обучение есть в настройках.' }
  ],
  i: 0, dim: null, ring: null, bub: null, active: false,
  flag(){ return 'cn_onboarded_' + (DB.session || ''); },
  need(){ return !!DB.session && !localStorage.getItem(this.flag()); },
  build(){
    if(this.dim) return;
    this.dim = obEl('div','#ob-dim'); this.ring = obEl('div','#ob-ring'); this.bub = obEl('div','#ob-bubble');
    this.bub.innerHTML = '<p id="ob-txt"></p><div id="ob-row"><button id="ob-skip">пропустить</button><button id="ob-next">далее</button></div>';
    document.body.append(this.dim, this.ring, this.bub);
    this.bub.querySelector('#ob-skip').onclick = () => this.finish();
    this.bub.querySelector('#ob-next').onclick = () => this.next();
    addEventListener('resize', () => { if(this.active) this.place(); });
  },
  show(){ this.build(); this.i = 0; this.active = true; this.place(); },
  resetMode(){ mode = ''; document.querySelectorAll('[data-mode]').forEach(x => x.classList.remove('active')); document.body.classList.remove('rename-mode','drag-mode'); },
  target(s){
    if(!s.sel) return null;
    const list = Array.isArray(s.sel) ? s.sel : [s.sel];
    for(const q of list){ const t = document.querySelector(q); if(t) return t; }
    return null;
  },
  next(){
    const prev = this.steps[this.i];
    if(prev && prev.live) this.resetMode();
    this.i++;
    if(this.i >= this.steps.length){ this.finish(); return; }
    this.place();
  },
  place(){
    const s = this.steps[this.i];
    this.bub.querySelector('#ob-txt').textContent = s.text;
    this.bub.querySelector('#ob-next').textContent = (this.i === this.steps.length - 1) ? 'начать' : 'далее';
    const t = this.target(s);
    if(t){
      const r = t.getBoundingClientRect(), pad = 8;
      this.dim.style.clipPath = s.live ? obHole(r, pad) : 'none';
      Object.assign(this.ring.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: (r.width + pad*2) + 'px', height: (r.height + pad*2) + 'px', display: 'block' });
      const br = this.bub.getBoundingClientRect();
      let bx = r.left + r.width/2 - br.width/2, by = r.bottom + pad + 10;
      if(by + br.height > innerHeight - 8) by = r.top - pad - 10 - br.height;
      bx = Math.max(8, Math.min(bx, innerWidth - br.width - 8)); by = Math.max(8, by);
      Object.assign(this.bub.style, { left: bx + 'px', top: by + 'px' });
    } else {
      this.dim.style.clipPath = 'none'; this.ring.style.display = 'none';
      const br = this.bub.getBoundingClientRect();
      Object.assign(this.bub.style, { left: (innerWidth - br.width)/2 + 'px', top: (innerHeight - br.height)/2 + 'px' });
    }
  },
  finish(){
    this.active = false;
    localStorage.setItem(this.flag(), '1');
    [this.dim, this.ring, this.bub].forEach(n => n && n.remove());
    this.dim = this.ring = this.bub = null;
  }
};
const ab = $('#about');
if(ab) ab.addEventListener('click', e => { e.preventDefault(); info('Облачные заметки — учебный дипломный проект: холст папок на GitHub Pages + Supabase (Auth, Postgres, Storage). Данные изолированы по владельцу, лимиты держит сервер, холст — собственный жестовый слой.'); });
const rp = $('#replay-onboard');
if(rp) rp.addEventListener('click', e => { e.preventDefault(); localStorage.setItem('cn_tour', '1'); location.href = 'desk.html'; });
// сброс для защиты: localStorage.removeItem('cn_onboarded_' + DB.session)
// TODO кнопка «повторить обучение» в settings.html — файл в базе тень, вставлю по скрину зоны кнопки.

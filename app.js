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
    if(error) info('Не удалось удалить из облако: ' + error.message);
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
  
  // Проверяем, не сработал ли наш триггер лимита
  if (error) {
    // Если в тексте ошибки есть слова про лимит или схему - это наша защита
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
  if(!$('#view-ind')) document.body.insertAdjacentHTML('beforeend', '<div id="view-ind"></div>');
  applyView();
  
  desk.addEventListener('mousedown', e => {
    const middle = e.button === 1;
    const onEmpty = e.button === 0 && !e.target.closest('.card');
    if(!middle && !onEmpty) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y;
    const move = ev => { view.x = ox + (ev.clientX - sx); view.y = oy + (ev.clientY - sy); applyView(); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });

  desk.addEventListener('auxclick', e => e.preventDefault());
  
  desk.addEventListener('wheel', e => {
    if(!e.ctrlKey) return;
    e.preventDefault();
    const rect = desk.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const nz = Math.min(2, Math.max(0.4, view.z * (e.deltaY < 0 ? 1.1 : 0.9)));
    view.x = px - (px - view.x) * (nz / view.z);
    view.y = py - (py - view.y) * (nz / view.z);
    view.z = nz; applyView();
  }, { passive: false });

  desk.addEventListener('mousedown', e => {
    if(mode !== 'cursor' || e.button !== 0) return;
    const card = e.target.closest('.card'); if(!card || !card.dataset.id) return;
    e.preventDefault();
    const id = +card.dataset.id;
    const p0 = { x: +card.dataset.x || 0, y: +card.dataset.y || 0 };
    const sx = e.clientX, sy = e.clientY; let moved = false;
    const move = ev => {
      if(!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      moved = true; card.classList.add('dragging');
      const nx = p0.x + (ev.clientX - sx) / view.z;
      const ny = p0.y + (ev.clientY - sy) / view.z;
      card.style.transform = `translate(${nx}px,${ny}px)`;
      card.dataset.x = nx; card.dataset.y = ny;
    };
    const up = () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      card.classList.remove('dragging');
      if(moved){
        justDragged = performance.now();
        const pos = POS.get();
        pos[id] = { x: Math.round(+card.dataset.x), y: Math.round(+card.dataset.y) };
        POS.set(pos);
      }
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  });
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
  $('#new-name').value = o.value || '';
  $('#new-name').classList.remove('err');
  m.hidden = false; $('#new-name').focus();
}

const mok = $('#new-ok');
if(mok) mok.addEventListener('click', async () => {
  const inp = $('#new-name'); const name = inp.value.trim();
  if(!name){ inp.classList.add('err'); return; }
  const id = Date.now();
  const it = { id, name, text: '', pin: false, files: [] };
  Store.cache.push(it);
  OPEN.add(id); ACTIVE.set(id);
  $('#modal').hidden = true;
  await Store.save(it);
  location.href = 'note.html?id=' + id;
});

const modal = $('#modal');
if(modal) modal.addEventListener('mousedown', e => { if(e.target === modal) modal.hidden = true; });

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
    const cb = $('#confirm-ok'); busy(cb, true, '⏳ удаляем...');
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
  if(performance.now() - justDragged < 400) return;
  const card = e.target.closest('.card');
  if(card && card.dataset.id) location.href = 'note.html?id=' + card.dataset.id;
});

/* ===== страница папки ===== */
async function notePage(){
  const sh = $('#sheet'); if(!sh) return;
  const id = +new URLSearchParams(location.search).get('id');
  const it = Store.find(id);
  if(!it) return location.replace('desk.html');

  const ta = `<textarea class="note-text" id="note-text" placeholder="заметка...">${esc(it.text || '')}</textarea><p class="save-hint">сохраняется автоматически</p>`;

  let fileList = '';
  if(!it.files || !it.files.length){
    fileList = `<div class="file-empty"><button class="btn big-plus" id="add-file-btn">+</button><p>пусто — добавьте файл</p></div>`;
  } else {
    const rows = [];
    for(const f of it.files){
      const url = await fileURL(f.path);
      const isImg = (f.mime || '').startsWith('image/');
      const thumb = isImg ? `<img class="file-thumb" src="${url}" alt="">` : `<img class="file-thumb" src="icons/${ICON.file}" alt="">`;
      rows.push(`<div class="file-row">${thumb}<span class="file-name">${esc(f.name)}</span><span class="file-size">${fmtSize(f.size||0)}</span><button class="file-dl" data-dl="${f.path}" title="скачать">⬇</button><button class="file-open" data-open="${f.path}" title="открыть">↗</button><button class="file-del" data-fdel="${f.path}" title="удалить">×</button></div>`);
    }
    fileList = `<div class="file-list">${rows.join('')}</div><button class="btn add-more" id="add-file-btn">+ добавить файл</button>`;
  }

  sh.innerHTML = `<div class="sheet-head"><a class="back" href="desk.html"><img src="icons/back.png" alt="назад"></a><h2>${esc(it.name)}</h2></div>${ta}${fileList}`;

  const textArea = $('#note-text');
  if(textArea) textArea.addEventListener('input', () => {
    const x = Store.find(id);
    if(x){ x.text = textArea.value; saveSoon(x); }
  });

  const addBtn = $('#add-file-btn');
  if(addBtn) addBtn.addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file'; 
    inp.accept = '*/*';
    inp.multiple = true; // Разрешаем выбор нескольких файлов
    
    inp.onchange = async () => {
      const files = Array.from(inp.files);
      if(!files.length) return;

      for(const f of files) {
        if(!guardLimits(f)) return; 
      }

      busy(addBtn, true, `⏳ грузим ${files.length} файл(ов)...`);
      
      let successCount = 0;
      const x = Store.find(id); 
      
      for(const f of files) {
        showProgress(f.name);
        try {
          const path = await uploadFile(f, id);
          if(x) {
            x.files = x.files || [];
            x.files.push({ name: f.name, path, size: f.size, mime: f.type || '' });
          }
          successCount++;
        } catch(err) {
          console.error('Ошибка загрузки:', f.name, err);
          info(`Не удалось загрузить ${f.name}`);
        }
      }

      if(x && successCount > 0) await Store.save(x);

      hideProgress(true);
      busy(addBtn, false);
      
      if(successCount > 0) {
        await notePage(); 
      }
    };
    
    inp.click();
  });

  sh.addEventListener('click', async e => {
    const dl = e.target.closest('[data-dl]');
    if(dl){ e.preventDefault(); const url = await fileURL(dl.dataset.dl); if(url){ const a = document.createElement('a'); a.href = url; a.download = ''; a.click(); } return; }
    const op = e.target.closest('[data-open]');
    if(op){ e.preventDefault(); const url = await fileURL(op.dataset.open); if(url) window.open(url, '_blank'); else info('Не удалось открыть. Попробуйте скачать.'); return; }
    const fd = e.target.closest('[data-fdel]');
    if(fd){
      e.preventDefault();
      const path = fd.dataset.fdel;
      askConfirm('Удалить файл?', async () => {
        const cb = $('#confirm-ok'); busy(cb, true, '⏳ удаляем...');
        try{
          await removePaths([path]);
          const x = Store.find(id);
          if(x){ x.files = (x.files||[]).filter(f => f.path !== path); await Store.save(x); }
          await notePage();
        } finally { busy($('#confirm-ok'), false); }
      });
    }
  });
}

/* ===== настройки ===== */
function accountPage(){
  const em = $('#acc-email'); if(em) em.textContent = DB.session;
  const pl = $('#acc-plan'); if(pl) pl.textContent = LIMITS[DB.plan(DB.session)].label;
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
    b.onclick = () => { DB.setPlan(em, bp); storagePage(); };
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
  if(!$('#theme-btn')){
    bar.insertAdjacentHTML('beforeend',
      `<button class="iconbtn" id="theme-btn" title="темы"><img src="icons/palette.png" alt=""></button><div id="theme-pop" hidden>${THEMES.map(t=>`<button class="swatch" data-theme="${t.id}" style="background:${t.color}"></button>`).join('')}</div>`);
  }
  const btn = $('#theme-btn'), pop = $('#theme-pop');
  if(btn) btn.addEventListener('click', e => { e.stopPropagation(); pop.hidden = !pop.hidden; apply(cur()); });
  if(pop) pop.addEventListener('click', e => { const s = e.target.closest('.swatch'); if(s) apply(s.dataset.theme); });
  document.addEventListener('click', e => { if(!e.target.closest('#theme-pop')&&!e.target.closest('#theme-btn')) pop.hidden = true; });
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
if(lf) lf.addEventListener('submit', async e => {
  e.preventDefault();
  const em = lf.email.value.trim(), ps = lf.pass.value;
  const bad = () => { lf.email.classList.add('err'); lf.pass.classList.add('err'); lf.querySelector('.err-msg').hidden = false; };
  if(!em || !ps) return bad();
  const lb = lf.querySelector('.btn'); busy(lb, true, '⏳ входим...');
  try{
    const { error } = await SB.auth.signInWithPassword({ email: em, password: ps });
    if(error) return bad();
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
  busy(rb, true, '⏳ создаём...');
  
  try {
    const { data, error } = await SB.auth.signUp({ email: em, password: p1 });
    
    if(error) return bad(error.message);

    // --- 2. ПРОВЕРКА НА ПОДТВЕРЖДЕНИЕ EMAIL ---
    if (!data.session) {
      err.textContent = '✨ Аккаунт создан! Проверьте почту для подтверждения.';
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
  e.preventDefault(); busy(lo, true, '⏳ выходим...');
  try{ clearOpen(DB.session); await SB.auth.signOut(); DB.session = ''; location.href = 'index.html'; }
  finally { busy(lo, false); }
}));

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
  initCanvas();
  const d = $('#desk');
  if(d) initSearch();
})();

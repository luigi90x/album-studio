const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const DB_NAME = 'album-studio', STORE = 'projects';

// Item geometry is relative (x/w in slide widths, y/h as a fraction of slide height), so switching
// format only changes the aspect ratio everything is drawn into.
const FORMATS = {
  '4:5':  { w: 1080, h: 1350, label: 'Post 4:5' },
  '1:1':  { w: 1080, h: 1080, label: 'Quadrato' },
  '9:16': { w: 1080, h: 1920, label: 'Storia 9:16' }
};
let OUT_W = FORMATS['4:5'].w, OUT_H = FORMATS['4:5'].h;
const MIN_SLIDES = 1, MAX_SLIDES = 12;
const MIN_W = 0.08, MIN_H = 0.05;   // smallest item, in slide units
const MAX_PHOTO_SIDE = 1800;         // imported photos are downscaled to this

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const clone = v => JSON.parse(JSON.stringify(v));
const pad = n => String(n + 1).padStart(2, '0');

// An item lives on continuous strip coordinates: x/w in slide widths, y/h as a fraction of slide
// height. A photo crossing a slide edge needs no special case — the edge is just a line drawn over it.
// There is only one kind of thing on the strip: an image. What used to be a "background" is just an
// image sitting at the bottom of the stack, and array order is the stack.
const newItem = (src, over) => ({
  id: uid(), src,
  x: 0.15, y: 0.18, w: 0.7, h: 0.5,
  zoom: 100, panX: 50, panY: 50,
  rotation: 0, radius: 12, corners: null, shape: 'rect', frame: 'clean',
  tintColor: '#000000', tintOpacity: 0,
  look: 'none', grain: 0, vignette: 0,
  exposure: 0, contrast: 0, saturation: 0, warmth: 0, shadows: 0,
  ...over
});
const newProject = () => ({
  id: null, title: 'Album fotografico', bgColor: '#1b1b1b',
  format: '4:5',            // one format for the whole carousel
  slideCount: 4,
  items: [], showNumbers: false, updated: Date.now()
});

let project = newProject();
let selectedSlide = 0;
let selectedItem = null;
let slideW = 260;
let mode = 'edit';
let showGuides = true;
let toastTimer;

// The whole carousel shares one format; changing it re-derives the output size and the CSS ratio.
function applyFormat(key) {
  const format = FORMATS[key] || FORMATS['4:5'];
  project.format = FORMATS[key] ? key : '4:5';
  OUT_W = format.w;
  OUT_H = format.h;
  if (typeof document !== 'undefined') document.documentElement.style.setProperty('--slide-ratio', `${format.w} / ${format.h}`);
}

/* ---------------------------------------------------------- undo / redo */

const UNDO_LIMIT = 40;
let undoStack = [], redoStack = [];

// Items are copied one level deep: the base64 photo strings are shared between snapshots rather
// than duplicated, so forty steps of history cost kilobytes instead of hundreds of megabytes.
const snapshot = () => ({
  format: project.format, bgColor: project.bgColor, slideCount: project.slideCount,
  showNumbers: project.showNumbers, items: project.items.map(i => ({ ...i }))
});

function pushUndo() {
  dirty = true;
  undoStack.push(snapshot());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
}

function restore(state) {
  Object.assign(project, { ...state, items: state.items.map(i => ({ ...i })) });
  applyFormat(project.format);
  if (selectedItem && !itemById(selectedItem)) selectedItem = null;
  selectedSlide = clamp(selectedSlide, 0, project.slideCount - 1);
  render();
}

function undo() {
  if (!undoStack.length) { toast('Niente da annullare'); return; }
  redoStack.push(snapshot());
  restore(undoStack.pop());
  toast('Annullato');
}

function redo() {
  if (!redoStack.length) { toast('Niente da ripristinare'); return; }
  undoStack.push(snapshot());
  restore(redoStack.pop());
  toast('Ripristinato');
}

const itemById = id => project.items.find(i => i.id === id);
const selected = () => (selectedItem ? itemById(selectedItem) : null);
const firstSlideOf = item => Math.max(0, Math.floor(item.x + 0.001));
const lastSlideOf = item => Math.min(project.slideCount - 1, Math.ceil(item.x + item.w - 0.001) - 1);
const spanOf = item => Math.max(1, lastSlideOf(item) - firstSlideOf(item) + 1);

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function rgba(hex, alpha) {
  const v = (hex || '#000000').replace('#', '');
  const int = parseInt(v.length === 3 ? v.split('').map(c => c + c).join('') : v, 16);
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
}

const FRAMES = {
  none:     { border: 0,  bottom: 0,  color: '#fff',    filter: '' },
  clean:    { border: 6,  bottom: 6,  color: '#ffffff', filter: '' },
  paper:    { border: 14, bottom: 14, color: '#f4ead9', filter: '' },
  film:     { border: 16, bottom: 16, color: '#111111', filter: 'saturate(.82) contrast(1.08)' },
  tape:     { border: 8,  bottom: 8,  color: '#fbfaf2', filter: '' },
  glass:    { border: 3,  bottom: 3,  color: '#ffffffcc', filter: 'saturate(1.12) contrast(1.05)' },
  polaroid: { border: 12, bottom: 44, color: '#ffffff', filter: '' }
};
// Frame widths are export pixels; on screen they scale with the rendered slide width.
const framePx = (value, w) => value * (w / OUT_W);

// Only fonts that ship with the system: the app must keep working with no network.
const FONTS = {
  sans:    { label: 'Sans',    stack: "'Segoe UI', system-ui, Arial, sans-serif" },
  serif:   { label: 'Serif',   stack: "Georgia, 'Times New Roman', serif" },
  display: { label: 'Titolo',  stack: "Impact, 'Arial Black', 'Segoe UI', sans-serif" },
  narrow:  { label: 'Stretto', stack: "'Arial Narrow', 'Segoe UI', Arial, sans-serif" },
  script:  { label: 'Corsivo', stack: "'Segoe Script', 'Brush Script MT', cursive" },
  mono:    { label: 'Mono',    stack: "'Courier New', ui-monospace, monospace" }
};

// Photo looks, written as CSS filter strings: canvas accepts the very same syntax through
// ctx.filter, so screen and export cannot drift apart.
const LOOKS = {
  none:    { label: 'Naturale', css: '' },
  bw:      { label: 'Bianco e nero', css: 'grayscale(1) contrast(1.08)' },
  bwhard:  { label: 'B/N contrastato', css: 'grayscale(1) contrast(1.45) brightness(1.04)' },
  warm:    { label: 'Caldo', css: 'saturate(1.15) sepia(.28) contrast(1.04)' },
  cold:    { label: 'Freddo', css: 'saturate(1.1) hue-rotate(-12deg) brightness(1.03)' },
  faded:   { label: 'Sbiadito', css: 'saturate(.72) contrast(.9) brightness(1.08)' },
  film:    { label: 'Pellicola', css: 'saturate(.9) contrast(1.18) sepia(.12)' },
  punch:   { label: 'Deciso', css: 'saturate(1.35) contrast(1.15)' },
  sepia:   { label: 'Seppia', css: 'sepia(.75) contrast(1.05) brightness(1.02)' },
  pastel:  { label: 'Pastello', css: 'saturate(.85) brightness(1.12) contrast(.92)' },
  night:   { label: 'Notte', css: 'brightness(.82) contrast(1.2) hue-rotate(-18deg) saturate(1.1)' },
  golden:  { label: 'Ora d’oro', css: 'sepia(.35) saturate(1.3) brightness(1.06) hue-rotate(-8deg)' },
  mono:    { label: 'Monocromo blu', css: 'grayscale(1) sepia(.5) hue-rotate(180deg) saturate(1.6)' }
};

// Free adjustments on top of the chosen look. Neutral is 0 for all of them, which keeps a project
// saved before this feature looking exactly as it did.
function adjustmentCSS(item) {
  const parts = [];
  if (item.exposure) parts.push(`brightness(${1 + item.exposure / 100})`);
  if (item.contrast) parts.push(`contrast(${1 + item.contrast / 100})`);
  if (item.saturation) parts.push(`saturate(${1 + item.saturation / 100})`);
  if (item.warmth) parts.push(item.warmth > 0 ? `sepia(${item.warmth / 140})` : `hue-rotate(${item.warmth * 0.35}deg)`);
  // "ombre": lifting the blacks is a brightness push held back by less contrast
  if (item.shadows) parts.push(`brightness(${1 + item.shadows / 260}) contrast(${1 - item.shadows / 320})`);
  return parts.join(' ');
}

const photoCSS = (item, frameFilter) =>
  [frameFilter, (LOOKS[item.look] || LOOKS.none).css, adjustmentCSS(item)].filter(Boolean).join(' ');

// Shapes an item can be cut to. Everything is expressed as a path so the browser and the export
// canvas can be given the same geometry: CSS gets a clip-path, canvas gets the same points.
const SHAPES = {
  rect:    { label: 'Rettangolo' },
  circle:  { label: 'Cerchio' },
  pill:    { label: 'Pillola' },
  arch:    { label: 'Arco' },
  diamond: { label: 'Rombo', points: [[50, 0], [100, 50], [50, 100], [0, 50]] },
  hexagon: { label: 'Esagono', points: [[25, 0], [75, 0], [100, 50], [75, 100], [25, 100], [0, 50]] },
  leaf:    { label: 'Foglia' }
};

// corners: null means "all the same", otherwise [topLeft, topRight, bottomRight, bottomLeft]
const cornerList = item => (Array.isArray(item.corners) ? item.corners : [item.radius, item.radius, item.radius, item.radius]);

function shapeCSS(item, scale) {
  const shape = item.shape || 'rect';
  if (shape === 'circle') return { clip: '', radius: '50%' };
  if (shape === 'pill') return { clip: '', radius: '999px' };
  if (shape === 'arch') return { clip: '', radius: '50% 50% 8% 8% / 40% 40% 4% 4%' };
  if (shape === 'leaf') return { clip: '', radius: '50% 8% 50% 8%' };
  const spec = SHAPES[shape];
  if (spec && spec.points) return { clip: `polygon(${spec.points.map(([x, y]) => `${x}% ${y}%`).join(', ')})`, radius: '0' };
  return { clip: '', radius: cornerList(item).map(value => `${value * scale}px`).join(' ') };
}

// three shapes of the same item: a photo, a solid block, or a piece of text
const itemKind = item => (item.text !== undefined && item.text !== null ? 'text' : item.src ? 'image' : 'colour');

/* ------------------------------------------------------------- storage */

// Photos are data URLs, so a project runs to megabytes: localStorage (5 MB for the whole origin)
// overflows after a couple of saves. IndexedDB has no such ceiling — but opening it from a
// file:// page never resolves in Chrome, so probe it with a timeout and fall back.
const LOCAL_KEY = 'album-studio-v4';
let storageMode = null;

const withTimeout = (promise, ms) => Promise.race([
  promise, new Promise((_, reject) => setTimeout(() => reject(new Error('storage-timeout')), ms))
]);

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('blocked'));
  });
}

async function useIndexedDB() {
  if (storageMode) return storageMode === 'idb';
  try {
    // From a file:// page Chrome never answers, so give up quickly; from a real address it is
    // expected to work, and a slow phone deserves the wait rather than the cramped fallback.
    const patience = (typeof location !== 'undefined' && location.protocol === 'file:') ? 1500 : 8000;
    const db = await withTimeout(openDB(), patience);
    db.close();
    storageMode = 'idb';
  } catch {
    storageMode = 'local';
  }
  return storageMode === 'idb';
}

function dbRun(mode, run) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(request && request.result); };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

const localList = () => { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch { return []; } };
function localWrite(list) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list)); }
  catch { throw new Error('quota'); }
}

async function putProject(value) {
  if (await useIndexedDB()) return dbRun('readwrite', store => store.put(value));
  const list = localList().filter(p => p.id !== value.id);
  list.unshift(value);
  localWrite(list);
}
async function allProjects() {
  if (await useIndexedDB()) return dbRun('readonly', store => store.getAll());
  return localList();
}
async function deleteProject(id) {
  if (await useIndexedDB()) return dbRun('readwrite', store => store.delete(id));
  localWrite(localList().filter(p => p.id !== id));
}

/* --------------------------------------------------------- image input */

const loadImage = src => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

// Phone photos are 4000px and several MB each; stored raw they blow up both memory and the export.
// ponytail: re-encoded as JPEG, which drops any alpha channel — fine for photographs.
async function importImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readFiles(fileList, callback) {
  const files = [...fileList].filter(f => f.type.startsWith('image/'));
  if (!files.length) { toast('Scegli un file immagine'); return; }
  for (const file of files) {
    try { callback(await importImage(file), file.name); }
    catch { toast(`Non riesco a leggere ${file.name}`); }
  }
}

/* --------------------------------------------------------------- strip */

function buildStrip(host, width, interactive) {
  const count = project.slideCount;
  host.style.width = `${width * count}px`;
  host.style.height = `${width * OUT_H / OUT_W}px`;
  host.style.background = project.bgColor;
  host.classList.toggle('guides', showGuides && interactive);
  host.innerHTML = '';

  // Layer order matters for hit testing: the click-catcher for empty space sits *below* the images,
  // otherwise it swallows clicks on the ones at the bottom of the stack and they can never be picked.
  const hitLayer = document.createElement('div');
  hitLayer.className = 'layer layer-hit';
  const itemLayer = document.createElement('div');
  itemLayer.className = 'layer layer-items';
  const guideLayer = document.createElement('div');
  guideLayer.className = 'layer layer-guide';

  Array.from({ length: count }, (_, index) => {
    const place = node => { node.style.left = `${index * width}px`; node.style.width = `${width}px`; return node; };

    const guide = place(document.createElement('div'));
    guide.className = `slide-cell ${index === selectedSlide && interactive ? 'selected' : ''}`;
    guide.innerHTML = '<div class="cell-frame"></div><div class="cell-safe"></div>'
      + (interactive ? `<div class="cell-num">SLIDE ${pad(index)}</div>` : '')
      + (project.showNumbers ? `<div class="cell-badge">${index + 1}/${count}</div>` : '');
    guideLayer.append(guide);

    // the selected slide carries its own delete button, so it can go without hunting in a panel
    if (interactive && index === selectedSlide && project.slideCount > MIN_SLIDES) {
      const drop = place(document.createElement('div'));
      drop.className = 'slide-cell cell-tools';
      drop.innerHTML = `<button class="cell-drop" title="Elimina questa slide">✕ slide</button>`;
      $('.cell-drop', drop).onclick = event => { event.stopPropagation(); deleteSlide(); };
      guideLayer.append(drop);   // the guide layer ignores pointers, the button opts back in
    }

    if (interactive) {
      const hit = place(document.createElement('div'));
      hit.className = 'slide-cell cell-hit';
      hit.onpointerdown = () => { selectedSlide = index; selectedItem = null; render(); };
      hitLayer.append(hit);
    }
  });

  if (interactive) guideLayer.insertAdjacentHTML('beforeend', '<i class="guide-v"></i><i class="guide-h"></i>');
  host.append(hitLayer, itemLayer, guideLayer);

  // array order is the stack: first drawn is furthest back
  project.items.forEach(item => {
    const node = document.createElement('div');
    node.className = `item frame-${item.frame} ${item.id === selectedItem && interactive ? 'selected' : ''} ${spanOf(item) > 1 ? 'spanning' : ''} ${item.demo ? 'demo' : ''}`;
    node.dataset.id = item.id;
    // one object, three shapes: a photo, a solid colour block, or text
    const inside = itemKind(item) === 'text'
      ? `<div class="item-text"></div>`
      : (item.src ? `<img src="${item.src}" alt="">` : '');
    node.innerHTML = `<div class="item-box">${inside}<span class="tint"></span></div><span class="tape"></span><span class="outline"></span>`
      + (interactive && item.demo ? '<span class="demo-tag">esempio · tocca 2 volte</span>' : '')
      + (interactive
        ? '<span class="span-tag"></span><span class="handle h-rot" data-dir="rot" title="Trascina per ruotare">↻</span>'
          // the top-left corner is the rotation grip, so resizing uses the other seven
          + ['n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(d => `<span class="handle h-${d}" data-dir="${d}"></span>`).join('')
        : '');
    itemLayer.append(node);
    styleItem(node, item, width);
    if (interactive) {
      $('.span-tag', node).textContent = `↔ ${spanOf(item)} slide`;
      setupItemPointer(node, item, width);
    }
  });
}

function styleItem(node, item, width) {
  const h = width * OUT_H / OUT_W;
  node.style.left = `${item.x * width}px`;
  node.style.top = `${item.y * h}px`;
  node.style.width = `${item.w * width}px`;
  node.style.height = `${item.h * h}px`;
  node.style.transform = `rotate(${item.rotation || 0}deg)`;
  const spec = FRAMES[item.frame] || FRAMES.clean;
  const b = framePx(spec.border, width), bb = framePx(spec.bottom, width);
  const box = $('.item-box', node);
  box.style.borderStyle = 'solid';
  box.style.borderColor = spec.color;
  box.style.borderWidth = `${b}px ${b}px ${bb}px`;
  const shaped = shapeCSS(item, framePx(3, width));
  box.style.borderRadius = shaped.radius;
  box.style.clipPath = shaped.clip;
  node.style.setProperty('--shape-clip', shaped.clip || 'none');
  const kind = itemKind(item);
  box.style.background = kind === 'image' ? '#111'
    : kind === 'text' ? rgba(item.fill || '#000000', (item.fillOpacity ?? 0) / 100)
    : (item.fill || '#888888');

  const textNode = $('.item-text', node);
  if (textNode) {
    const slideH = width * OUT_H / OUT_W;
    textNode.textContent = item.text;
    textNode.style.font = `${item.italic ? 'italic ' : ''}${item.bold ? '700 ' : ''}${item.size / 100 * slideH}px/1.25 ${(FONTS[item.font] || FONTS.sans).stack}`;
    textNode.style.color = item.color;
    textNode.style.textAlign = item.align;
    textNode.style.justifyContent = { left: 'flex-start', center: 'center', right: 'flex-end' }[item.align];
    // with flex-wrap on, it is align-content that places the block — setting only align-items did
    // nothing, which is why vertical alignment appeared broken
    const vertical = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[item.valign];
    textNode.style.alignContent = vertical;
    textNode.style.alignItems = vertical;
    textNode.style.textDecoration = [item.underline && 'underline', item.strike && 'line-through'].filter(Boolean).join(' ') || 'none';
    textNode.style.padding = `${framePx(24, width)}px`;
  }

  const img = $('img', node);
  if (img) {
    img.style.objectPosition = `${item.panX}% ${item.panY}%`;
    img.style.transform = `scale(${item.zoom / 100})`;
    img.style.transformOrigin = `${item.panX}% ${item.panY}%`;
    img.style.filter = photoCSS(item, spec.filter);
  }
  const tint = $('.tint', node);
  if (tint) {
    const layers = [];
    if (item.tintOpacity) layers.push(`linear-gradient(${rgba(item.tintColor, item.tintOpacity / 100)}, ${rgba(item.tintColor, item.tintOpacity / 100)})`);
    if (item.vignette) layers.push(`radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,${item.vignette / 100}) 100%)`);
    tint.style.background = layers.join(', ') || 'transparent';
    tint.style.opacity = '1';
    // grain is a tiled noise tile, cheap and resolution independent
    tint.style.backgroundImage = layers.length ? tint.style.backgroundImage : '';
    node.classList.toggle('grainy', Boolean(item.grain));
    node.style.setProperty('--grain', (item.grain || 0) / 100);
  }
}

function renderStrip() {
  const strip = $('#strip');
  buildStrip(strip, slideW, true);
  if (!project.items.length) {
    const hint = document.createElement('div');
    hint.className = 'strip-empty';
    hint.innerHTML = '<b>Aggiungi la prima immagine</b><small>Trascinala dove vuoi: può coprire quante slide vuoi.</small>';
    strip.append(hint);
  }
}

function renderPreviewTrack() {
  const track = $('#preview-track');
  track.innerHTML = '';
  const width = Math.min(slideW, 300);
  Array.from({ length: project.slideCount }, (_, index) => {
    const wrap = document.createElement('div');
    wrap.className = 'preview-slide';
    wrap.style.width = `${width}px`;
    wrap.style.height = `${width * OUT_H / OUT_W}px`;
    const inner = document.createElement('div');
    inner.className = 'strip';
    inner.style.left = `${-index * width}px`;
    wrap.append(inner);
    track.append(wrap);
    buildStrip(inner, width, false);
  });
}

function renderRuler() {
  const ruler = $('#ruler');
  const keepScroll = ruler.scrollLeft;   // rebuilding the strip must not scroll it back to slide 01
  ruler.innerHTML = '';
  const thumbW = 42;
  Array.from({ length: project.slideCount }, (_, index) => {
    const button = document.createElement('button');
    button.className = `rul-slide ${index === selectedSlide ? 'active' : ''}`;
    button.style.width = `${thumbW}px`;
    button.style.height = `${thumbW * OUT_H / OUT_W}px`;
    button.title = `Vai alla slide ${pad(index)}`;
    const inner = document.createElement('div');
    inner.className = 'strip';
    inner.style.left = `${-index * thumbW}px`;
    button.append(inner, Object.assign(document.createElement('span'), { className: 'rul-num', textContent: pad(index) }));
    button.onclick = () => { selectedSlide = index; selectedItem = null; render(); scrollSlideIntoView(index); };
    // drag a thumbnail onto another to reorder the carousel
    button.draggable = true;
    button.ondragstart = event => { event.dataTransfer.setData('text/slide', String(index)); button.classList.add('dragging'); };
    button.ondragend = () => button.classList.remove('dragging');
    button.ondragover = event => { event.preventDefault(); button.classList.add('drop-target'); };
    button.ondragleave = () => button.classList.remove('drop-target');
    button.ondrop = event => {
      event.preventDefault();
      button.classList.remove('drop-target');
      const from = Number(event.dataTransfer.getData('text/slide'));
      if (Number.isNaN(from) || from === index) return;
      moveSlideTo(from, index);
    };
    ruler.append(button);
    buildStrip(inner, thumbW, false);
  });
  ruler.scrollLeft = keepScroll;
}

// Everything touching the current slide, topmost first — the reliable way back to an element that
// is hidden under another one (a full-slide background, typically).
function renderLayers() {
  const list = $('#layers-list');
  const touching = project.items.filter(i => i.x < selectedSlide + 1 && i.x + i.w > selectedSlide);
  const hadFocus = document.activeElement && document.activeElement.dataset.pick;
  $('#layers-count').textContent = touching.length;
  if (!touching.length) { list.innerHTML = '<p class="note">Ancora nessuna immagine su questa slide.</p>'; return; }

  // topmost first, mirroring what you see: the last one drawn is the one on top
  list.innerHTML = [...touching].reverse().map((item, position) => {
    const span = spanOf(item);
    const depth = position === 0 ? 'in cima' : position === touching.length - 1 ? 'in fondo' : `livello ${touching.length - position}`;
    const kind = itemKind(item);
    const thumb = kind === 'image' ? `background-image:url('${item.src}')`
      : kind === 'text' ? `background:${item.color || '#fff'};color:${item.fill || '#111'}`
      : `background:${item.fill || '#888'}`;
    const what = kind === 'image' ? 'Immagine'
      : kind === 'text' ? `“${(item.text || '').split('\n')[0].slice(0, 18) || 'Testo'}”`
      : 'Colore';
    return `<div class="layer-row ${item.id === selectedItem ? 'active' : ''}">
      <button class="layer-pick" data-pick="${item.id}">
        <span class="layer-thumb" style="${thumb}"></span>
        <span class="layer-text"><b>${span > 1 ? `${what} · ${span} slide` : what}</b><small>${depth}${item.demo ? ' · esempio' : ''}</small></span>
      </button>
      <button class="layer-del" data-drop="${item.id}" title="Elimina questo elemento" aria-label="Elimina">×</button>
    </div>`;
  }).join('');
  $$('[data-pick]', list).forEach(b => b.onclick = () => { selectedItem = b.dataset.pick; render(); });
  // dragging a row changes what covers what: the list reads top-first, the array is bottom-first
  $$('.layer-row', list).forEach((row, position) => {
    row.draggable = true;
    row.ondragstart = event => { event.dataTransfer.setData('text/layer', String(position)); row.classList.add('dragging'); };
    row.ondragend = () => row.classList.remove('dragging');
    row.ondragover = event => { event.preventDefault(); row.classList.add('drop-target'); };
    row.ondragleave = () => row.classList.remove('drop-target');
    row.ondrop = event => {
      event.preventDefault();
      row.classList.remove('drop-target');
      const from = Number(event.dataTransfer.getData('text/layer'));
      if (Number.isNaN(from) || from === position) return;
      restackTouching(from, position);
    };
  });
  $$('[data-drop]', list).forEach(b => b.onclick = event => {
    event.stopPropagation();
    pushUndo();
    project.items = project.items.filter(i => i.id !== b.dataset.drop);
    if (selectedItem === b.dataset.drop) selectedItem = null;
    render();
    toast('Elemento eliminato — annulla con ↶');
  });
  if (hadFocus) $(`[data-pick="${hadFocus}"]`, list)?.focus();   // keyboard focus survives the rebuild
}

// Moves one element of the current slide to another depth. Positions are what the list shows
// (top first), so they are flipped back onto the array, where the first entry is the furthest back.
function restackTouching(fromPosition, toPosition) {
  const touching = project.items.filter(i => i.x < selectedSlide + 1 && i.x + i.w > selectedSlide);
  const shown = [...touching].reverse();
  const moving = shown[fromPosition];
  const target = shown[toPosition];
  if (!moving || !target) return;
  pushUndo();
  const rest = project.items.filter(i => i !== moving);
  const targetIndex = rest.indexOf(target);
  // dropping onto a row that is higher in the list means going above that element
  rest.splice(fromPosition > toPosition ? targetIndex + 1 : targetIndex, 0, moving);
  project.items = rest;
  selectedItem = moving.id;
  render();
}

function renderInspector() {
  const item = selected();
  // Only the visibility of the panel is ours to decide: whether a section is expanded belongs to
  // whoever opened it. Forcing it on every render slammed sections shut mid-task.
  $('#sec-item').classList.toggle('hidden', !item);
  $('#sel-slide-label').textContent = pad(selectedSlide);
  $('#recipe-slide').textContent = pad(selectedSlide);
  $('#slide-count-label').textContent = project.slideCount;
  $('#slide-count-inline').textContent = project.slideCount;
  $('#bg-color').value = project.bgColor;
  if (document.activeElement !== $('#project-title')) $('#project-title').value = project.title || '';
  $$('[data-format]').forEach(b => b.classList.toggle('active', b.dataset.format === project.format));
  $('#format-note').textContent = `${FORMATS[project.format].label} · ${OUT_W}×${OUT_H} px`;
  $('#show-numbers').checked = project.showNumbers;
  $('#show-guides').checked = showGuides;
  $('#zoom-value').value = `${Math.round(slideW / 3.2)}%`;
  $('#less-slides').disabled = project.slideCount <= MIN_SLIDES;
  $('#more-slides').disabled = project.slideCount >= MAX_SLIDES;
  $('#move-left').disabled = selectedSlide === 0;
  $('#move-right').disabled = selectedSlide === project.slideCount - 1;
  if (!item) return;

  const span = spanOf(item), first = firstSlideOf(item), last = lastSlideOf(item);
  $('#sel-span-label').textContent = span === 1 ? '1 slide' : `${span} slide`;
  $('#item-position-note').textContent = span === 1
    ? `Sta tutta dentro la slide ${pad(first)}.`
    : `È a cavallo delle slide ${pad(first)}–${pad(last)}: verrà tagliata sui confini.`;
  // only a photo has something to frame inside itself: colour and text swap those controls out
  const kind = itemKind(item);
  const isPhoto = kind === 'image';
  $('#sel-kind-label').textContent = { image: 'Immagine selezionata', colour: 'Riquadro colorato', text: 'Testo selezionato' }[kind];
  $('#item-fill-row').classList.toggle('hidden', kind !== 'colour');
  if (kind === 'colour') $('#item-fill-color').value = item.fill || '#888888';
  $('#text-controls').classList.toggle('hidden', kind !== 'text');
  $('#item-replace').parentElement.classList.toggle('hidden', kind === 'text');
  ['#framing-head', '#item-zoom', '#item-panx', '#item-pany', '#look-head', '#item-grain', '#item-vignette',
   '#item-reset-look', '#item-exposure', '#item-contrast', '#item-shadows', '#item-saturation', '#item-warmth']
    .forEach(sel => $(sel).classList.toggle('hidden', !isPhoto));
  $('#item-look').parentElement.classList.toggle('hidden', !isPhoto);
  $$('#sec-item .range-label').forEach(label => {
    const target = label.nextElementSibling;
    if (target && ['item-zoom', 'item-panx', 'item-pany', 'item-grain', 'item-vignette', 'item-exposure', 'item-contrast', 'item-shadows', 'item-saturation', 'item-warmth'].includes(target.id)) label.classList.toggle('hidden', !isPhoto);
  });
  $('#replace-label').textContent = kind === 'colour' ? '↑ Metti un\'immagine al posto del colore' : '↑ Usa una mia immagine qui';
  if (kind === 'text') {
    if (document.activeElement !== $('#item-text')) $('#item-text').value = item.text;
    $('#item-font').value = item.font;
    $('#item-font').style.fontFamily = (FONTS[item.font] || FONTS.sans).stack;   // preview when closed too
    $('#item-text-color').value = item.color;
    $('#item-size').value = item.size;
    $('#item-size-value').value = item.size;
    $('#item-text-bg').value = item.fill || '#000000';
    $('#item-text-bg-opacity').value = item.fillOpacity ?? 0;
    $('#item-text-bg-opacity-value').value = item.fillOpacity ?? 0;
    $$('[data-align]').forEach(b => b.classList.toggle('active', b.dataset.align === item.align));
    $$('[data-valign]').forEach(b => b.classList.toggle('active', b.dataset.valign === item.valign));
    $$('[data-style]').forEach(b => b.classList.toggle('active', Boolean(item[b.dataset.style])));
  }
  $('#item-frame').value = item.frame;
  $('#item-shape').value = item.shape || 'rect';
  const perCorner = Array.isArray(item.corners);
  const roundable = !SHAPES[item.shape || 'rect'].points && !['circle', 'pill', 'arch', 'leaf'].includes(item.shape);
  $('#corner-controls').classList.toggle('hidden', !roundable);
  $('#corner-split').checked = perCorner;
  $('#corner-grid').classList.toggle('hidden', !perCorner);
  $('#item-radius').previousElementSibling.classList.toggle('hidden', perCorner);   // its own label
  $('#item-radius').classList.toggle('hidden', perCorner);
  if (perCorner) {
    const [tl, tr, br, bl] = item.corners;
    $('#corner-tl').value = tl; $('#corner-tr').value = tr;
    $('#corner-br').value = br; $('#corner-bl').value = bl;
  }
  $('#item-look').value = item.look || 'none';
  $('#item-grain').value = item.grain || 0;
  $('#item-grain-value').value = item.grain || 0;
  $('#item-vignette').value = item.vignette || 0;
  $('#item-vignette-value').value = item.vignette || 0;
  $('#item-exposure').value = item.exposure || 0;
  $('#item-exposure-value').value = item.exposure || 0;
  $('#item-contrast').value = item.contrast || 0;
  $('#item-contrast-value').value = item.contrast || 0;
  $('#item-shadows').value = item.shadows || 0;
  $('#item-shadows-value').value = item.shadows || 0;
  $('#item-saturation').value = item.saturation || 0;
  $('#item-saturation-value').value = item.saturation || 0;
  $('#item-warmth').value = item.warmth || 0;
  $('#item-warmth-value').value = item.warmth || 0;
  $('#item-tint-color').value = item.tintColor;
  $('#item-tint').value = item.tintOpacity;
  $('#item-tint-value').value = item.tintOpacity;
  $('#item-zoom').value = item.zoom;
  $('#item-zoom-value').value = `${item.zoom}%`;
  $('#item-panx').value = item.panX;
  $('#item-panx-value').value = item.panX;
  $('#item-pany').value = item.panY;
  $('#item-pany-value').value = item.panY;
  $('#item-radius').value = item.radius;
  $('#item-radius-value').value = item.radius;
  $('#item-rotation').value = item.rotation;
  $('#item-rotation-value').value = `${item.rotation}°`;
  $('#item-fill').textContent = span === 1 ? 'Riempi la slide' : `Riempi le ${span} slide occupate`;
  $('#item-widen').disabled = item.x + item.w >= project.slideCount;
  $('#item-narrow').disabled = item.w <= 1;
}

let shownItem = null;
let dirty = false;          // something changed since the last explicit save
let activeScope = 'slide';   // which panel group the phone tab bar is showing

// On a phone the three scopes (element / slide / carousel) become tabs instead of one long scroll.
// Same three scopes as the desktop columns, so what you learn on one works on the other.
function setScope(scope) {
  activeScope = scope;
  $$('.tab-scope').forEach(tab => tab.classList.toggle('active', tab.dataset.scope === scope));
  $$('[data-scope]').forEach(section => {
    if (section.classList.contains('tab-scope')) return;
    section.classList.toggle('off-scope', !section.dataset.scope.split(' ').includes(scope));
  });
  $('.tab-scope[data-scope="item"]').disabled = !selectedItem;
}

function render() {
  selectedSlide = clamp(selectedSlide, 0, project.slideCount - 1);
  if (selectedItem && !itemById(selectedItem)) selectedItem = null;
  // expand the photo panel once, when the selection actually changes — never on every render
  if (selectedItem && selectedItem !== shownItem) {
    $('#sec-item').open = true;
    setScope('item');                       // on a phone, jump to what you just picked
  }
  if (!selectedItem && shownItem) setScope('slide');
  shownItem = selectedItem;
  $('#strip-scroll').classList.toggle('hidden', mode !== 'edit');
  $('#preview-track').classList.toggle('hidden', mode !== 'preview');
  if (mode === 'edit') renderStrip(); else renderPreviewTrack();
  renderRuler();
  renderLayers();
  renderInspector();
  scheduleAutosave();
}

function scrollSlideIntoView(index) {
  const scroll = $('#strip-scroll');
  scroll.scrollTo({ left: Math.max(0, index * slideW - (scroll.clientWidth - slideW) / 2 + 26), behavior: 'smooth' });
}

/* ------------------------------------------------------- drag / resize */

// What a dragged edge can latch onto: the slide seams and centres, plus the edges and centres of
// every other element. Returned in the same units the item uses, so comparison is direct.
function snapTargets(exceptId) {
  const xs = [], ys = [0, 0.5, 1];
  for (let i = 0; i <= project.slideCount; i++) {
    xs.push(i);
    if (i < project.slideCount) xs.push(i + 0.5);
  }
  project.items.forEach(other => {
    if (other.id === exceptId) return;
    xs.push(other.x, other.x + other.w, other.x + other.w / 2);
    ys.push(other.y, other.y + other.h, other.y + other.h / 2);
  });
  return { xs, ys };
}

// Tries the item's own edges and centre against the targets and returns the smallest shift that
// lands one of them on a target, or null when nothing is within reach.
function snapShift(points, targets, tolerance) {
  let best = null;
  points.forEach(point => targets.forEach(target => {
    const delta = target - point;
    if (Math.abs(delta) <= tolerance && (!best || Math.abs(delta) < Math.abs(best.delta))) {
      best = { delta, at: target };
    }
  }));
  return best;
}

let lastTap = { id: null, at: 0 };

/* -------------------------------------------------------- context menu */

// Long press on a phone, right click on a desktop: same menu, so the gesture is not something that
// only exists on one of the two.
function openContextMenu(item, x, y) {
  selectedItem = item.id;
  lastTap = { id: null, at: 0 };   // a long press must not count as the first half of a double tap
  render();
  const menu = $('#context-menu');
  menu.classList.remove('hidden');
  menu.querySelector('[data-act="replace"]').hidden = itemKind(item) === 'text';
  menu.querySelector('[data-act="fill"]').textContent = spanOf(item) > 1
    ? `Riempi le ${spanOf(item)} slide occupate` : 'Riempi la slide';
  // keep it inside the window
  const box = menu.getBoundingClientRect();
  menu.style.left = `${clamp(x, 8, innerWidth - box.width - 8)}px`;
  menu.style.top = `${clamp(y, 8, innerHeight - box.height - 8)}px`;
}

const closeContextMenu = () => $('#context-menu').classList.add('hidden');

function runContextAction(action) {
  const item = selected();
  closeContextMenu();
  if (!item) return;
  if (action === 'replace') { $('#item-replace').click(); return; }
  pushUndo();
  if (action === 'duplicate') {
    const copy = { ...clone(item), id: uid(), x: item.x + 0.08, y: item.y + 0.04 };
    project.items.push(copy);
    selectedItem = copy.id;
  }
  if (action === 'front') project.items = [...project.items.filter(i => i !== item), item];
  if (action === 'back') project.items = [item, ...project.items.filter(i => i !== item)];
  if (action === 'fill') fillOccupiedSlides(item);
  if (action === 'straighten') item.rotation = 0;
  if (action === 'delete') {
    project.items = project.items.filter(i => i !== item);
    selectedItem = null;
    toast('Elemento eliminato — annulla con ↶');
  }
  render();
}

function setupItemPointer(node, item, width) {
  node.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    event.preventDefault();
    event.stopPropagation();

    // Double tap on a photo opens the file picker: the quickest way to swap a template's demo
    // photo for your own. The picker needs a user gesture, and this pointerdown is one.
    const now = Date.now();
    if (lastTap.id === item.id && now - lastTap.at < 400) {
      lastTap = { id: null, at: 0 };
      selectedItem = item.id;
      renderInspector();
      $('#item-replace').click();
      return;
    }
    const downAt = { x: event.clientX, y: event.clientY };

    // held still for half a second: show the menu instead of dragging
    let longPress = setTimeout(() => {
      longPress = null;
      // releasing a capture that was never granted throws, and that would swallow the menu
      try { node.releasePointerCapture(event.pointerId); } catch { /* nothing to release */ }
      openContextMenu(item, downAt.x, downAt.y);
    }, 500);
    const cancelLongPress = () => { if (longPress) { clearTimeout(longPress); longPress = null; } };

    selectedItem = item.id;
    selectedSlide = clamp(Math.floor(item.x + item.w / 2), 0, project.slideCount - 1);
    $$('.item').forEach(n => n.classList.toggle('selected', n === node));
    renderLayers();
    renderInspector();

    pushUndo();
    const dir = event.target.dataset.dir || null;
    const h = width * OUT_H / OUT_W;
    const start = { px: event.clientX, py: event.clientY, ...item };
    try { node.setPointerCapture(event.pointerId); } catch { /* pointer already gone */ }
    node.classList.add('dragging');

    // rotation pivots on the item's centre, which the bounding box gives us even while rotated
    const box = node.getBoundingClientRect();
    const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const angleTo = (x, y) => Math.atan2(y - centre.y, x - centre.x) * 180 / Math.PI;
    const grabAngle = angleTo(event.clientX, event.clientY);

    const targets = snapTargets(item.id);
    const tolX = 8 / width, tolY = 8 / h;          // 8 screen pixels, whatever the zoom
    const guideV = $('.guide-v', node.parentElement.parentElement);
    const guideH = $('.guide-h', node.parentElement.parentElement);
    const showGuide = (guide, at, axis) => {
      if (!guide) return;
      guide.classList.toggle('on', at !== null);
      if (at !== null) guide.style[axis === 'x' ? 'left' : 'top'] = `${at * (axis === 'x' ? width : h)}px`;
    };

    let lastPointer = { x: event.clientX, y: event.clientY };
    const move = e => {
      lastPointer = { x: e.clientX, y: e.clientY };
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) cancelLongPress();
      if (!longPress && $('#context-menu').classList.contains('hidden') === false) return;
      const dx = (e.clientX - start.px) / width;
      const dy = (e.clientY - start.py) / h;
      if (dir === 'rot') {
        let next = start.rotation + (angleTo(e.clientX, e.clientY) - grabAngle);
        next = ((next + 180) % 360 + 360) % 360 - 180;          // keep it in -180..180
        const step = Math.round(next / 15) * 15;                 // snap to 15° when close
        item.rotation = Math.round(Math.abs(next - step) < 3.5 ? step : next);
        $('#item-rotation').value = item.rotation;
        $('#item-rotation-value').value = `${item.rotation}°`;
      } else if (!dir) {
        const x = start.x + dx, y = start.y + dy;
        const hitX = snapShift([x, x + item.w / 2, x + item.w], targets.xs, tolX);
        const hitY = snapShift([y, y + item.h / 2, y + item.h], targets.ys, tolY);
        item.x = x + (hitX ? hitX.delta : 0);
        item.y = y + (hitY ? hitY.delta : 0);
        showGuide(guideV, hitX ? hitX.at : null, 'x');
        showGuide(guideH, hitY ? hitY.at : null, 'y');
      } else {
        // resizing snaps only the edge being pulled
        if (dir.includes('e')) {
          const right = start.x + start.w + dx;
          const hit = snapShift([right], targets.xs, tolX);
          showGuide(guideV, hit ? hit.at : null, 'x');
          item.w = Math.max(MIN_W, (hit ? hit.at : right) - item.x);
        }
        if (dir.includes('w')) {
          const right = start.x + start.w, left = start.x + dx;
          const hit = snapShift([left], targets.xs, tolX);
          showGuide(guideV, hit ? hit.at : null, 'x');
          item.x = Math.min(hit ? hit.at : left, right - MIN_W);
          item.w = right - item.x;
        }
        if (dir.includes('s')) {
          const bottom = start.y + start.h + dy;
          const hit = snapShift([bottom], targets.ys, tolY);
          showGuide(guideH, hit ? hit.at : null, 'y');
          item.h = Math.max(MIN_H, (hit ? hit.at : bottom) - item.y);
        }
        if (dir.includes('n')) {
          const bottom = start.y + start.h, top = start.y + dy;
          const hit = snapShift([top], targets.ys, tolY);
          showGuide(guideH, hit ? hit.at : null, 'y');
          item.y = Math.min(hit ? hit.at : top, bottom - MIN_H);
          item.h = bottom - item.y;
        }
      }
      styleItem(node, item, width);
      $('.span-tag', node).textContent = `↔ ${spanOf(item)} slide`;
      node.classList.toggle('spanning', spanOf(item) > 1);
    };
    const done = () => {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', done);
      node.removeEventListener('pointercancel', done);
      cancelLongPress();
      node.classList.remove('dragging');
      showGuide(guideV, null, 'x');
      showGuide(guideH, null, 'y');
      // only a tap that stayed put counts towards a double tap — dragging twice in a row must not
      // be read as "open the file picker"
      const moved = Math.hypot(lastPointer.x - downAt.x, lastPointer.y - downAt.y) > 5;
      const menuUp = !$('#context-menu').classList.contains('hidden');
      lastTap = (moved || menuUp) ? { id: null, at: 0 } : { id: item.id, at: Date.now() };
      render();
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', done);
    node.addEventListener('pointercancel', done);
  });
}

/* ---------------------------------------------------------- item edits */

// Two ways to drop an image in — not two kinds of image. "full" starts slide-sized at the bottom of
// the stack (what used to be called a background), "free" starts as a floating photo on top.
function addItem(src, how = 'free') {
  pushUndo();
  const item = how === 'full'
    ? newItem(src, { x: selectedSlide, y: 0, w: 1, h: 1, frame: 'none', radius: 0 })
    : newItem(src, { x: selectedSlide + 0.14, y: 0.2, w: 0.72, h: 0.48 });
  if (how === 'full') project.items.unshift(item); else project.items.push(item);
  selectedItem = item.id;
  render();
  toast(how === 'full'
    ? 'Immagine inserita a tutta slide, dietro le altre: allargala trascinando i bordi'
    : 'Immagine inserita: trascinala dove vuoi, anche a cavallo di due slide');
}

// A slide that is just a colour: same item, with a fill instead of a photo. Goes to the bottom of
// the stack and covers the slide, which is what "sfondo a tinta unita" means in practice.
// "Più foto" works within the carousel you have set up: the number of slides you chose is the
// frame, never something to grow silently. Photos are spread over those slides, more than one per
// slide when there are many, with a different arrangement on neighbouring slides.
const readingOrder = (a, b) => (firstSlideOf(a) - firstSlideOf(b)) || (a.y - b.y) || (a.x - b.x);
const pick = list => list[Math.floor(Math.random() * list.length)];

// how many photos land on each slide, spreading the remainder over the first ones
function spread(total, slides) {
  const base = Math.floor(total / slides);
  const extra = total % slides;
  return Array.from({ length: slides }, (_, i) => base + (i < extra ? 1 : 0));
}

const MAX_PER_SLIDE = 5;

function composeSlide(slideIndex, sources, style, avoid) {
  const options = (ARRANGEMENTS[sources.length] || ARRANGEMENTS[5]).filter(name => name !== avoid);
  const arrangement = pick(options.length ? options : ARRANGEMENTS[sources.length] || ARRANGEMENTS[5]);
  const spots = RECIPES[arrangement];
  sources.forEach((src, index) => {
    const [x, y, w, h, radius] = spots[index % spots.length];
    const fullBleed = arrangement === 'full';
    project.items.push(newItem(src, {
      x: slideIndex + x, y, w, h,
      radius: fullBleed ? 0 : radius,
      frame: fullBleed ? 'none' : style.frame,
      rotation: fullBleed || !style.tilt ? 0 : (index % 2 ? style.tilt : -style.tilt)
    }));
  });
  return arrangement;
}

// Instead of guessing, ask: the possible ways to place this batch are few and easy to name.
// The dialog only offers what makes sense for the photos you picked and the strip as it is now.
// A tiny drawing of the outcome: filled cells are the photos you just picked, outlines are slides
// that stay as they are. Seeing four schemes side by side beats reading four descriptions.
function planSketch(perSlide, extraSlides = 0, keptSlides = 0) {
  const cells = [...perSlide];
  const width = 13, height = 17, gap = 3;
  const total = keptSlides + cells.length + extraSlides;
  const boxes = [];
  let x = 0;
  for (let i = 0; i < keptSlides; i++, x += width + gap) {
    boxes.push(`<rect x="${x}" y="0" width="${width}" height="${height}" rx="2" fill="none" stroke="#5a5a64" stroke-dasharray="2 2"/>`);
  }
  cells.forEach(count => {
    boxes.push(`<rect x="${x}" y="0" width="${width}" height="${height}" rx="2" fill="none" stroke="#8b8b95"/>`);
    const rows = count <= 1 ? 1 : count <= 4 ? 2 : 3;
    const cols = Math.ceil(count / rows);
    for (let n = 0; n < count; n++) {
      const cw = (width - 3) / cols, ch = (height - 3) / rows;
      const cx = x + 1.5 + (n % cols) * cw, cy = 1.5 + Math.floor(n / cols) * ch;
      boxes.push(`<rect x="${cx + .4}" y="${cy + .4}" width="${cw - .8}" height="${ch - .8}" rx="1" fill="#d9ff4b"/>`);
    }
    x += width + gap;
  });
  for (let i = 0; i < extraSlides; i++, x += width + gap) {
    boxes.push(`<rect x="${x}" y="0" width="${width}" height="${height}" rx="2" fill="none" stroke="#d9ff4b" stroke-dasharray="2 2"/>`);
    boxes.push(`<rect x="${x + 1.5}" y="1.5" width="${width - 3}" height="${height - 3}" rx="1" fill="#d9ff4b" opacity=".55"/>`);
  }
  return `<svg class="sketch" viewBox="0 0 ${Math.max(1, total * (width + gap))} ${height}" preserveAspectRatio="xMinYMid meet">${boxes.join('')}</svg>`;
}

// What each choice would actually do with these photos, worked out up front so the dialog can show
// both the sketch and the real numbers.
function planOptions(count) {
  const frames = project.items.filter(i => i.demo && itemKind(i) === 'image').length;
  const slides = project.slideCount;
  const free = slidesWithRoom().length;
  const options = [];

  if (frames) {
    const filled = Math.min(frames, count);
    options.push({
      id: 'frames', title: 'Riempi i riquadri del template',
      note: count >= frames
        ? `${filled} riquadri riempiti${count > frames ? `, ${count - frames} foto avanzano` : ''}.`
        : `${filled} riquadri riempiti, i ${frames - filled} vuoti vengono tolti.`,
      sketch: planSketch(Array.from({ length: slides }, (_, slide) =>
        Math.min(filled, project.items.filter(i => i.demo && itemKind(i) === 'image' && firstSlideOf(i) === slide).length)))
    });
  }

  const onePerSlide = Math.min(count, slides);
  options.push({
    id: 'one', title: 'Una foto per slide, a tutta pagina',
    note: count > slides
      ? `Riempie tutte le ${slides} slide, ${count - slides} foto restano fuori (o servono nuove slide).`
      : `Occupa ${onePerSlide} slide su ${slides}.`,
    sketch: planSketch(Array.from({ length: onePerSlide }, () => 1), 0, Math.max(0, slides - onePerSlide))
  });

  const composed = spread(Math.min(count, slides * MAX_PER_SLIDE), slides);
  options.push({
    id: 'compose', title: 'Componi più foto per slide',
    note: `${composed.join(' + ')} foto sulle ${slides} slide, con disposizioni diverse.`,
    sketch: planSketch(composed)
  });

  if (free && free < slides) {
    const onFree = spread(Math.min(count, free * MAX_PER_SLIDE), free);
    options.push({
      id: 'append', title: `Solo sulle ${free} slide ancora libere`,
      note: 'Non tocca le slide che hai già composto.',
      sketch: planSketch(onFree, 0, slides - free)
    });
  }
  return options;
}

function askLayout(sources) {
  const dialog = $('#layout-dialog');
  const options = planOptions(sources.length);
  let chosen = options[0].id;
  $('#layout-text').textContent = `${sources.length} foto scelte, ${project.slideCount} slide nel carosello. Il riquadro verde è dove finiscono.`;
  $('#layout-choices').innerHTML = options.map(option => `
    <button class="choice ${option.id === chosen ? 'active' : ''}" data-plan="${option.id}">
      ${option.sketch}
      <span><b>${option.title}</b><small>${option.note}</small></span>
    </button>`).join('');
  $$('[data-plan]').forEach(button => button.onclick = () => {
    chosen = button.dataset.plan;
    $$('[data-plan]').forEach(other => other.classList.toggle('active', other === button));
  });

  // the checkbox only means something when the photos actually spill over
  const spills = sources.length > project.slideCount;
  $('#layout-grow').checked = false;
  $('#layout-grow-row').classList.toggle('hidden', !spills);
  $('#layout-grow-label').textContent = `Aggiungi slide se non entrano (ora ne hai ${project.slideCount})`;

  return new Promise(resolve => {
    $('#layout-cancel').onclick = () => { dialog.close(); resolve(null); };
    $('#layout-go').onclick = () => { dialog.close(); resolve({ plan: chosen, grow: $('#layout-grow').checked }); };
    dialog.showModal();
  });
}

function slidesWithRoom() {
  return Array.from({ length: project.slideCount }, (_, i) => i)
    .filter(i => !project.items.some(item => item.x < i + 1 && item.x + item.w > i));
}

async function autoLayout(files) {
  const list = [...files].filter(f => f.type.startsWith('image/'));
  if (!list.length) { toast('Scegli delle immagini'); return; }

  const sources = [];
  for (const file of list) {
    try { sources.push(await importImage(file)); }
    catch { toast(`Non riesco a leggere ${file.name}`); }
  }
  if (!sources.length) return;

  const answer = await askLayout(sources);
  if (!answer) return;
  const { plan, grow } = answer;

  pushUndo();
  let used = 0;
  emptiedFrames = 0;

  if (plan === 'frames') {
    const frames = project.items.filter(i => i.demo && itemKind(i) === 'image').sort(readingOrder);
    frames.forEach(frame => {
      if (used >= sources.length) return;
      frame.src = sources[used++];
      frame.demo = false;
    });
    // any frame still holding a demo picture would just look like a stray coloured rectangle:
    // clear it out rather than leave a fake photograph in the album
    const leftEmpty = project.items.filter(i => i.demo && itemKind(i) === 'image').length;
    if (leftEmpty) {
      project.items = project.items.filter(i => !(i.demo && itemKind(i) === 'image'));
      emptiedFrames = leftEmpty;
    }
  }

  const left = sources.slice(used);
  if (left.length && plan !== 'frames') {
    const targets = plan === 'append' ? slidesWithRoom() : Array.from({ length: project.slideCount }, (_, i) => i);
    const perSlide = plan === 'one'
      ? targets.map(() => 1)
      : spread(Math.min(left.length, targets.length * MAX_PER_SLIDE), targets.length);
    const style = pick(STYLES);
    let taken = 0, previous = null;
    targets.forEach((slide, position) => {
      const count = Math.min(perSlide[position] || 0, left.length - taken);
      if (count <= 0) return;
      previous = composeSlide(slide, left.slice(taken, taken + count), style, previous);
      taken += count;
    });
    used += taken;
    if (taken) lastComposition = style.name;
  }

  // whatever is still over needs new slides, and only if you allowed it
  if (grow) {
    const style = pick(STYLES);
    while (used < sources.length && project.slideCount < MAX_SLIDES) {
      const slide = project.slideCount++;
      const room = Math.min(sources.length - used, plan === 'one' ? 1 : MAX_PER_SLIDE > 2 ? 2 : 1);
      composeSlide(slide, sources.slice(used, used + room), style, null);
      used += room;
    }
  }

  selectedItem = null;
  selectedSlide = 0;
  render();
  fitZoom();
  const leftOver = sources.length - used;
  toast(leftOver
    ? `${used} foto sistemate — ${leftOver} non entrano: aggiungi slide o consenti di aggiungerle`
    : emptiedFrames
      ? `${used} foto nei riquadri — ${emptiedFrames} riquadri vuoti rimossi`
      : `${used} foto sistemate su ${project.slideCount} slide`);
}

let lastComposition = null;
let emptiedFrames = 0;

function addTextItem() {
  pushUndo();
  const item = newItem(null, {
    text: 'Scrivi qui', font: 'sans', size: 8, color: '#ffffff',
    align: 'center', valign: 'middle', fill: '#000000', fillOpacity: 0,
    x: selectedSlide + 0.1, y: 0.38, w: 0.8, h: 0.24, frame: 'none', radius: 6
  });
  project.items.push(item);
  selectedItem = item.id;
  render();
  $('#item-text').select();
  toast('Testo inserito: scrivilo nel pannello a destra');
}

function addColourBlock() {
  pushUndo();
  const item = newItem(null, {
    fill: project.bgColor === '#1b1b1b' ? '#e8e2d6' : project.bgColor,
    x: selectedSlide, y: 0, w: 1, h: 1, frame: 'none', radius: 0
  });
  project.items.unshift(item);
  selectedItem = item.id;
  render();
  toast('Riquadro colorato inserito: cambia colore o dimensione come una foto');
}

function removeSelected() {
  if (!selectedItem) return;
  pushUndo();
  project.items = project.items.filter(i => i.id !== selectedItem);
  selectedItem = null;
  render();
  toast('Elemento eliminato');
}

// "Riempi": snap to the slides the item already touches — one slide if it sits inside one,
// all of them if it straddles two or three.
function fillOccupiedSlides(item) {
  const first = firstSlideOf(item), last = lastSlideOf(item);
  Object.assign(item, { x: first, w: last - first + 1, y: 0, h: 1 });
}

/* --------------------------------------------------------------- slides */

const insideSlide = (item, slide) => item.x >= slide && item.x + item.w <= slide + 1;

// ponytail: items sitting entirely on the removed slide go with it; ones crossing it just lose a
// slide of width. Splitting a crossing item in two would need a second copy — add it if asked.
function remapAfterDelete(items, at) {
  return items.filter(i => !insideSlide(i, at)).map(i => {
    if (i.x >= at + 1) return { ...i, x: i.x - 1 };
    if (i.x + i.w > at) return { ...i, w: Math.max(MIN_W, i.w - 1) };
    return i;
  });
}

// ponytail: only items fully inside a slide travel with it; a photo straddling the seam stays put.
function remapAfterMove(items, from, to) {
  return items.map(i => {
    if (insideSlide(i, from)) return { ...i, x: i.x + (to - from) };
    if (insideSlide(i, to)) return { ...i, x: i.x - (to - from) };
    return i;
  });
}

function changeSlideCount(delta) {
  const target = clamp(project.slideCount + delta, MIN_SLIDES, MAX_SLIDES);
  if (target === project.slideCount) return;
  pushUndo();
  if (delta < 0) {
    project.items = project.items.filter(i => i.x < target);
    project.items.forEach(i => { if (i.x + i.w > target) i.w = target - i.x; });
  }
  project.slideCount = target;
  render();
}

function deleteSlide() {
  if (project.slideCount <= MIN_SLIDES) { toast('Serve almeno una slide'); return; }
  const at = selectedSlide;
  const losing = project.items.filter(i => insideSlide(i, at)).length;
  confirmAction('Eliminare la slide?',
    losing ? `La slide ${pad(at)} e le ${losing} immagini che contiene verranno eliminate.` : `La slide ${pad(at)} verrà eliminata.`,
    'Elimina slide', () => {
      pushUndo();
      project.slideCount -= 1;
      project.items = remapAfterDelete(project.items, at);
      selectedSlide = clamp(at, 0, project.slideCount - 1);
      selectedItem = null;
      render();
      toast('Slide eliminata');
    });
}

function moveSlide(delta) {
  moveSlideTo(selectedSlide, selectedSlide + delta);
}

// Reordering by drag can jump several places at once: shifting one step at a time keeps every
// item's relationship with the slides it sits on.
function moveSlideTo(from, to) {
  if (to < 0 || to >= project.slideCount || from === to) return;
  pushUndo();
  const step = to > from ? 1 : -1;
  for (let at = from; at !== to; at += step) {
    project.items = remapAfterMove(project.items, at, at + step);
  }
  selectedSlide = to;
  selectedItem = null;
  render();
  scrollSlideIntoView(to);
  toast(`Slide spostata in posizione ${pad(to)}`);
}

function duplicateSlide() {
  if (project.slideCount >= MAX_SLIDES) { toast(`Massimo ${MAX_SLIDES} slide`); return; }
  pushUndo();
  const at = selectedSlide;
  project.slideCount += 1;
  project.items.forEach(i => { if (i.x >= at + 1) i.x += 1; });
  project.items.push(...project.items.filter(i => insideSlide(i, at)).map(i => ({ ...clone(i), id: uid(), x: i.x + 1 })));
  selectedSlide = at + 1;
  render();
  toast('Slide duplicata');
}

/* -------------------------------------------------------------- recipes */

const RECIPES = {
  cover:    [[.14, .22, .72, .56, 12]],
  duo:      [[.06, .14, .5, .52, 12], [.45, .36, .48, .48, 12]],
  triptych: [[.06, .12, .43, .38, 8], [.52, .12, .42, .38, 8], [.14, .55, .72, .33, 8]],
  diary:    [[.09, .11, .48, .42, 10], [.44, .38, .48, .42, 10], [.18, .66, .36, .22, 10]],
  tall:     [[.08, .1, .4, .74, 8], [.53, .16, .39, .3, 8], [.53, .52, .39, .3, 8]],
  contact:  [[.06, .08, .42, .36, 4], [.52, .08, .42, .36, 4], [.06, .5, .42, .36, 4], [.52, .5, .42, .36, 4]],
  full:     [[0, 0, 1, 1, 0]],
  stack:    [[.11, .07, .78, .41, 10], [.11, .52, .78, .41, 10]],
  offset:   [[.04, .1, .56, .46, 10], [.42, .44, .54, .46, 10]],
  scatter:  [[.05, .06, .45, .4, 8], [.53, .14, .42, .36, 8], [.09, .52, .42, .38, 8], [.55, .56, .4, .36, 8]],
  five:     [[.05, .05, .43, .34, 5], [.52, .05, .43, .34, 5], [.05, .42, .43, .34, 5], [.52, .42, .43, .34, 5], [.24, .78, .52, .18, 5]]
};

// Which arrangements suit a given number of photos on one slide. Neighbouring slides take different
// ones, so a generated carousel has rhythm instead of four identical pages.
const ARRANGEMENTS = {
  1: ['full', 'cover'],
  2: ['duo', 'stack', 'offset'],
  3: ['triptych', 'diary', 'tall'],
  4: ['contact', 'scatter'],
  5: ['five']
};

// A single look for the whole carousel: coherent, but picked fresh each time so two runs on the
// same photos do not give the same album.
const STYLES = [
  { name: 'pulito', frame: 'clean', tilt: 0 },
  { name: 'polaroid', frame: 'polaroid', tilt: 3 },
  { name: 'carta', frame: 'paper', tilt: 2 },
  { name: 'pellicola', frame: 'film', tilt: 0 },
  { name: 'senza cornice', frame: 'none', tilt: 0 }
];

function applyRecipe(name) {
  pushUndo();
  const spots = RECIPES[name] || RECIPES.cover;
  project.items = project.items.filter(i => !insideSlide(i, selectedSlide));
  spots.forEach(([x, y, w, h, r], index) => project.items.push(newItem(demoScene(sibling('sunset', index + 1)), {
    x: selectedSlide + x, y, w, h, radius: r, rotation: index % 2 ? 2 : -2,
    frame: name === 'contact' ? 'film' : 'clean', demo: true
  })));
  selectedItem = null;
  render();
  toast(`${spots.length} riquadri sulla slide ${pad(selectedSlide)} — usa “Sostituisci immagine” per le tue foto`);
}

function addSpanningPhoto() {
  pushUndo();
  const width = Math.min(1.6, project.slideCount - selectedSlide);
  const item = newItem(demoScene('coast'), { x: selectedSlide + 0.2, y: 0.22, w: width, h: 0.5, radius: 10, demo: true });
  project.items.push(item);
  selectedItem = item.id;
  render();
  toast('Foto a cavallo inserita: sostituiscila con la tua');
}

/* ------------------------------------------------------------ templates */

const PALETTES = {
  sunset: ['#f7aa64', '#c85b4a', '#453149', '#f9d898'],
  blue: ['#8ed4e4', '#3f718c', '#1b3554', '#e3f4f6'],
  garden: ['#d7d783', '#71844e', '#365346', '#f2dfb4'],
  city: ['#b6bdc9', '#6b7380', '#222a36', '#e6c099'],
  coast: ['#e5c77f', '#76b4bf', '#315c70', '#fff4d5'],
  rose: ['#e7b0b5', '#a65e70', '#4a2c45', '#f8e7df']
};
const SCENES = Object.keys(PALETTES);
// demo photos borrow a neighbouring palette so they read as photos laid over the background
const sibling = (scene, step) => SCENES[(SCENES.indexOf(scene) + step + SCENES.length) % SCENES.length];

function demoScene(scene = 'sunset') {
  const [a, b, c, d] = PALETTES[scene] || PALETTES.sunset;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1350" viewBox="0 0 1800 1350"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${a}"/><stop offset=".48" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient><filter id="blur"><feGaussianBlur stdDeviation="70"/></filter></defs><rect width="1800" height="1350" fill="url(#g)"/><circle cx="350" cy="230" r="310" fill="${d}" opacity=".56" filter="url(#blur)"/><circle cx="1480" cy="930" r="450" fill="${a}" opacity=".46" filter="url(#blur)"/><path d="M-50 1070 C280 780 535 1250 840 970 S1420 685 1880 1010 V1400 H-50Z" fill="${c}" opacity=".48"/><path d="M-50 1180 C265 920 690 1360 1100 1030 S1510 885 1880 1110 V1400 H-50Z" fill="${d}" opacity=".25"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const bgSpan = (x, w, scene) => newItem(demoScene(scene), { x, y: 0, w, h: 1, frame: 'none', radius: 0, demo: true });
const shaped = (x, y, w, h, shape, scene, step) =>
  newItem(demoScene(sibling(scene, step)), { x, y, w, h, shape, frame: shape === 'rect' ? 'clean' : 'none', radius: 0, demo: true });
const spanItem = (x, w, scene, frame) => newItem(demoScene(sibling(scene, 3)), { x, y: 0.24, w, h: 0.5, frame, radius: 10, demo: true });
const recipeItems = (recipe, slide, scene, frame) => (RECIPES[recipe] || RECIPES.cover).map(([x, y, w, h, r], i) =>
  newItem(demoScene(sibling(scene, i + 2)), { x: slide + x, y, w, h, radius: r, frame, rotation: i % 2 ? 2 : -2, demo: true }));

const TEMPLATES = [
  { id: 'golden', name: 'Golden hour diary', desc: 'Sfondo caldo su due slide, polaroid sopra.', scene: 'sunset', color: '#54332f', slides: 4,
    build: s => [bgSpan(0, 2, s), ...recipeItems('duo', 0, s, 'paper'), ...recipeItems('cover', 2, s, 'polaroid'), ...recipeItems('diary', 3, s, 'paper')] },
  { id: 'wide-blue', name: 'Wide blue', desc: 'Una panoramica sola che attraversa tutto il carosello.', scene: 'blue', color: '#22405a', slides: 4,
    build: s => [bgSpan(0, 4, s), ...recipeItems('cover', 0, s, 'glass'), spanItem(1.5, 1.6, s, 'clean'), ...recipeItems('duo', 3, s, 'clean')] },
  { id: 'garden', name: 'Garden notes', desc: 'Scrapbook con scotch e una foto a cavallo.', scene: 'garden', color: '#3c4a35', slides: 4,
    build: s => [bgSpan(0, 4, s), spanItem(0.55, 1.5, s, 'tape'), ...recipeItems('triptych', 2, s, 'paper'), ...recipeItems('cover', 3, s, 'tape')] },
  { id: 'city', name: 'City zine', desc: 'Contrasto alto, provini e ritmo da magazine.', scene: 'city', color: '#20262f', slides: 4,
    build: s => [bgSpan(0, 1, s), ...recipeItems('contact', 0, s, 'film'), bgSpan(1, 3, s), ...recipeItems('tall', 2, s, 'film'), ...recipeItems('cover', 3, s, 'glass')] },
  { id: 'coast', name: 'Coast postcard', desc: 'Mare continuo e cartoline sovrapposte.', scene: 'coast', color: '#2f5c69', slides: 5,
    build: s => [bgSpan(0, 5, s), ...recipeItems('cover', 0, s, 'polaroid'), spanItem(1.4, 1.4, s, 'clean'), ...recipeItems('duo', 3, s, 'paper'), ...recipeItems('cover', 4, s, 'glass')] },
  { id: 'bubbles', name: 'Bolle', desc: 'Cerchi e pillole su fondo pieno: pulito e moderno.', scene: 'blue', color: '#20323f', slides: 4,
    build: s => [
      bgSpan(0, 4, s),
      shaped(0.16, 0.14, 0.68, 0.52, 'circle', s, 1), shaped(0.3, 0.7, 0.4, 0.16, 'pill', s, 2),
      shaped(1.12, 0.2, 0.36, 0.29, 'circle', s, 3), shaped(1.55, 0.35, 0.36, 0.29, 'circle', s, 4),
      shaped(2.14, 0.16, 0.72, 0.4, 'pill', s, 2), shaped(2.24, 0.62, 0.52, 0.28, 'circle', s, 1),
      shaped(3.18, 0.18, 0.64, 0.5, 'arch', s, 3)
    ] },
  { id: 'gems', name: 'Gemme', desc: 'Rombi ed esagoni, per un carosello grafico.', scene: 'garden', color: '#2f3a2c', slides: 4,
    build: s => [
      bgSpan(0, 4, s),
      shaped(0.18, 0.16, 0.64, 0.48, 'hexagon', s, 2), shaped(0.3, 0.66, 0.4, 0.24, 'diamond', s, 3),
      shaped(1.1, 0.22, 0.38, 0.3, 'diamond', s, 1), shaped(1.52, 0.44, 0.38, 0.3, 'hexagon', s, 4),
      shaped(2.16, 0.14, 0.68, 0.54, 'leaf', s, 2),
      shaped(3.14, 0.2, 0.3, 0.24, 'hexagon', s, 1), shaped(3.5, 0.2, 0.3, 0.24, 'hexagon', s, 3), shaped(3.32, 0.52, 0.36, 0.28, 'diamond', s, 4)
    ] },
  { id: 'rose', name: 'Rose after dark', desc: 'Scuro e romantico, con una foto lunga al centro.', scene: 'rose', color: '#3b2030', slides: 4,
    build: s => [bgSpan(0, 4, s), ...recipeItems('cover', 0, s, 'polaroid'), spanItem(1.15, 2.2, s, 'glass'), ...recipeItems('duo', 3, s, 'paper')] }
];

// Card art: the strip laid out at full width inside a 4:5 window, shifted to the slide we want.
// Same geometry as the editor, so what the card shows is what the template gives you.
// shape of a card thumbnail: same rules as the editor, expressed inline
function shapePreviewCSS(item) {
  const shaped = shapeCSS(item, 0.2);
  return `border-radius:${shaped.radius}${shaped.clip ? `;clip-path:${shaped.clip}` : ''}`;
}

function stripHTML(items, count, offset) {
  const shots = items.map(i => {
    const spec = FRAMES[i.frame] || FRAMES.clean;
    const border = spec.border ? Math.max(1, spec.border / 8) : 0;
    return `<div style="position:absolute;left:${i.x / count * 100}%;top:${i.y * 100}%;width:${i.w / count * 100}%;height:${i.h * 100}%;
      background-image:url('${i.src}');background-size:cover;background-position:center;
      border:${border}px solid ${spec.color};border-bottom-width:${spec.bottom > spec.border ? border * 3 : border}px;
      ${shapePreviewCSS(i)};box-shadow:${i.frame === 'none' ? 'none' : '0 3px 8px #0007'};transform:rotate(${i.rotation}deg)"></div>`;
  }).join('');
  return `<div style="position:absolute;top:0;left:${-offset * 100}%;width:${count * 100}%;height:100%">${shots}</div>`;
}

function templateCard(template) {
  const items = template.build(template.scene);
  const n = template.slides;
  const crossing = items.filter(i => spanCount(i, n) > 1).length;
  const minis = Array.from({ length: n }, (_, k) =>
    `<div class="mini" style="background:${template.color}">${stripHTML(items, n, k)}</div>`).join('');
  return `<article class="layout-card">
    <div class="layout-art" style="background:${template.color}">${stripHTML(items, n, 0)}</div>
    <div class="layout-strip" title="Le ${n} slide del carosello">${minis}</div>
    <div class="layout-meta"><span class="chip">${n} slide</span><span class="chip">${items.length} immagini</span>${crossing ? `<span class="chip hot">${crossing} a cavallo</span>` : ''}</div>
    <footer><div><h3>${template.name}</h3><small>${template.desc}</small></div><button class="btn" data-template="${template.id}">Usa</button></footer>
  </article>`;
}

// span for a template item, independent of the open project
const spanCount = (item, count) => {
  const first = Math.max(0, Math.floor(item.x + 0.001));
  const last = Math.min(count - 1, Math.ceil(item.x + item.w - 0.001) - 1);
  return Math.max(1, last - first + 1);
};

/* --------------------------------------------------- templates propri */

const MY_TEMPLATES = 'album-studio-templates';

const readMyTemplates = () => { try { return JSON.parse(localStorage.getItem(MY_TEMPLATES) || '[]'); } catch { return []; } };

// A template is the composition without the photographs: geometry, style and frames are kept, the
// images are dropped. That keeps it small enough for localStorage and makes it reusable on any set
// of photos — reopening it gives you empty frames to fill with "Più foto".
function saveAsTemplate() {
  if (!project.items.length) { toast('Non c’è niente da salvare come template'); return; }
  const name = (project.title || 'Il mio template').slice(0, 40);
  const scene = demoScene('sunset');
  const template = {
    id: uid(),
    name,
    slides: project.slideCount,
    format: project.format,
    color: project.bgColor,
    items: project.items.map(i => ({
      ...i,
      id: undefined,
      src: itemKind(i) === 'image' ? scene : i.src,
      demo: itemKind(i) === 'image' || undefined
    }))
  };
  try {
    const mine = readMyTemplates().filter(t => t.name !== name);
    mine.unshift(template);
    localStorage.setItem(MY_TEMPLATES, JSON.stringify(mine.slice(0, 24)));
    toast(`Salvato come template “${name}” — lo trovi in Template`);
  } catch {
    toast('Spazio esaurito: non riesco a salvare il template');
  }
}

function myTemplateCard(template) {
  const items = template.items.map(i => ({ ...newItem(i.src), ...i }));
  const photos = items.filter(i => itemKind(i) === 'image').length;
  const minis = Array.from({ length: template.slides }, (_, k) => `<div class="mini" style="background:${template.color}">${stripHTML(items, template.slides, k)}</div>`).join('');
  return `<article class="layout-card">
    <div class="layout-art" style="background:${template.color}">${stripHTML(items, template.slides, 0)}</div>
    <div class="layout-strip">${minis}</div>
    <div class="layout-meta"><span class="chip">${template.slides} slide</span><span class="chip">${photos} riquadri</span><span class="chip">${template.format}</span></div>
    <footer><div><h3>${template.name}</h3><small>Il tuo template</small></div>
      <span class="card-actions">
        <button class="btn" data-mine="${template.id}">Usa</button>
        <button class="btn danger" data-mine-del="${template.id}" title="Elimina questo template">×</button>
      </span></footer>
  </article>`;
}

function applyMyTemplate(template) {
  pushUndo();
  project.slideCount = template.slides;
  applyFormat(template.format);
  project.bgColor = template.color;
  project.items = template.items.map(i => ({ ...newItem(i.src), ...i, id: uid() }));
  selectedSlide = 0;
  selectedItem = null;
  showPanel('editor');
  fitZoom();
  toast(`“${template.name}” applicato — usa “Più foto” per riempirlo`);
}

function renderLayoutGallery() {
  const mine = readMyTemplates();
  $('#my-templates').classList.toggle('hidden', !mine.length);
  $('#my-template-grid').innerHTML = mine.map(myTemplateCard).join('');
  $$('[data-mine]').forEach(button => button.onclick = () => applyMyTemplate(mine.find(t => t.id === button.dataset.mine)));
  $$('[data-mine-del]').forEach(button => button.onclick = () => confirmAction('Eliminare il template?', 'Sparisce solo il template, i progetti restano.', 'Elimina', () => {
    localStorage.setItem(MY_TEMPLATES, JSON.stringify(readMyTemplates().filter(t => t.id !== button.dataset.mineDel)));
    renderLayoutGallery();
    toast('Template eliminato');
  }));
  $('#layout-grid').innerHTML = TEMPLATES.map(templateCard).join('');
  $$('[data-template]').forEach(button => button.onclick = () => {
    const template = TEMPLATES.find(t => t.id === button.dataset.template);
    pushUndo();
    project.slideCount = template.slides;
    applyFormat('4:5');            // the built-in templates are composed for the 4:5 post
    project.bgColor = template.color;
    project.items = template.build(template.scene);
    project.title = template.name;
    selectedSlide = 0;
    selectedItem = null;
    showPanel('editor');
    fitZoom();
    toast(`“${template.name}” applicato — tocca una foto e usa “Sostituisci immagine”`);
  });
}

/* -------------------------------------------------------------- storage */

function normalize(raw) {
  const fresh = newProject();
  const inc = raw && typeof raw === 'object' ? raw : {};
  if (Array.isArray(inc.items)) {
    const slideCount = inc.slideCount || inc.slides?.length || fresh.slideCount;
    // older projects carried a per-slide overlay and a bg/photo split; the overlay now lives on the
    // image, so hand it to the bottom-most image of each slide, which is what it used to darken
    const items = inc.items.map(i => ({ ...newItem(i.src), ...i }));
    (inc.slides || []).forEach((slide, index) => {
      if (!slide?.overlayOpacity) return;
      const bottom = items.find(i => i.x < index + 1 && i.x + i.w > index);
      if (bottom && !bottom.tintOpacity) {
        bottom.tintColor = slide.overlayColor || '#000000';
        bottom.tintOpacity = slide.overlayOpacity;
      }
    });
    items.forEach(i => delete i.kind);
    return { ...fresh, ...inc, slideCount, slides: undefined, items };
  }
  // migrate older projects (separate backgrounds / spans / per-slide photos) onto strip coordinates
  const slides = Array.isArray(inc.slides) && inc.slides.length ? inc.slides : Array.from({ length: fresh.slideCount }, () => ({}));
  const items = [];
  (inc.backgrounds || (inc.background ? [{ src: inc.background, start: 0, length: slides.length }] : [])).forEach(b =>
    items.push(newItem(b.src, { x: b.start, y: 0, w: b.length, h: 1, frame: 'none', radius: 0, zoom: b.zoom || 100, panY: b.panY ?? 50 })));
  (inc.spans || []).forEach(s =>
    items.push(newItem(s.src, { x: s.start + (s.x || 0) / 100, y: (s.y || 0) / 100, w: s.length, h: (s.h || 50) / 100, frame: s.frame || 'clean', radius: s.radius ?? 12, rotation: s.rotation || 0 })));
  slides.forEach((slide, index) => (slide.photos || []).forEach(p => {
    const src = p.source === 'background' ? (inc.backgrounds?.[0]?.src || inc.background || p.fallback) : p.src;
    if (src) items.push(newItem(src, { x: index + p.x / 100, y: p.y / 100, w: p.w / 100, h: p.h / 100, radius: p.radius ?? 12, rotation: p.rotation || 0, frame: slide.frame || 'clean' }));
  }));
  slides.forEach((slide, index) => {
    if (!slide.overlayOpacity) return;
    const bottom = items.find(i => i.x < index + 1 && i.x + i.w > index);
    if (bottom && !bottom.tintOpacity) {
      bottom.tintColor = slide.overlayColor || '#000000';
      bottom.tintOpacity = slide.overlayOpacity;
    }
  });
  return {
    ...fresh, id: inc.id, title: inc.title || fresh.title, bgColor: inc.backgroundColor || fresh.bgColor,
    showNumbers: Boolean(inc.showNumbers), items, slideCount: slides.length
  };
}

// One-shot rescue of anything saved back when projects lived under the old localStorage keys.
async function migrateLegacyStorage() {
  for (const key of ['album-studio-projects-v3', 'album-studio-projects-v2']) {
    let list;
    try { list = JSON.parse(localStorage.getItem(key) || 'null'); } catch { list = null; }
    if (!Array.isArray(list) || !list.length) continue;
    try {
      for (const raw of list) await putProject({ ...normalize(raw), id: raw.id || uid() });
      localStorage.removeItem(key);
      toast(`${list.length} progetti recuperati dal vecchio salvataggio`);
    } catch { /* leave the old data alone if the import fails */ }
  }
}

/* ------------------------------------------------------------ autosave */

const AUTOSAVE_ID = '__autosave__';
let autosaveTimer = null, autosaveBroken = false;

// Keeps the current state under a reserved id so closing the tab loses nothing. Debounced, because
// a project is megabytes of base64 and every drag would otherwise rewrite the lot.
function scheduleAutosave() {
  if (autosaveBroken) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    try { await putProject({ ...clone(project), id: AUTOSAVE_ID, autosave: true, updated: Date.now() }); }
    catch {
      autosaveBroken = true;
      toast('Salvataggio automatico non disponibile: usa “Salva” e il backup JSON');
    }
  }, 1500);
}

async function restoreAutosave() {
  try {
    const found = (await allProjects()).find(p => p.id === AUTOSAVE_ID);
    if (!found || !found.items?.length) return;
    project = normalize(found);
    project.id = found.savedAs || null;      // it is a working copy, not the named project
    applyFormat(project.format);
    selectedSlide = 0;
    selectedItem = null;
    fitZoom();
    toast('Ripreso il lavoro dell’ultima sessione');
  } catch { /* nothing to restore */ }
}

async function saveProject() {
  project.updated = Date.now();
  project.id ||= uid();
  try {
    await putProject(clone(project));
    await putProject({ ...clone(project), id: AUTOSAVE_ID, autosave: true, savedAs: project.id });
    dirty = false;
    toast(storageMode === 'local'
      ? 'Progetto salvato (spazio limitato: tieni un backup JSON)'
      : 'Progetto salvato su questo dispositivo');
  } catch (error) {
    toast(error.message === 'quota'
      ? 'Spazio esaurito. Apri “Esporta” e scarica il backup JSON, poi elimina qualche progetto.'
      : 'Salvataggio non riuscito: scarica il backup JSON da “Esporta”.');
  }
}

function openBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      project = normalize(JSON.parse(reader.result));
      project.id ||= uid();
      applyFormat(project.format);
      selectedSlide = 0;
      selectedItem = null;
      showPanel('editor');
      fitZoom();
      toast('Backup aperto');
    } catch { toast('Questo file non è un backup valido'); }
  };
  reader.readAsText(file);
}

async function renderProjects() {
  const grid = $('#projects-grid');
  let saved = [];
  try { saved = await allProjects(); } catch { saved = []; }
  saved = saved.filter(p => p.id !== AUTOSAVE_ID);
  saved.sort((a, b) => b.updated - a.updated);
  $('#storage-note').textContent = storageMode === 'local'
    ? 'Aperto come file locale: lo spazio di salvataggio è limitato. Per progetti pesanti scarica il backup JSON da “Esporta”.'
    : '';
  if (!saved.length) { grid.innerHTML = '<div class="empty-projects">Nessun album salvato.<br>Componi la striscia e premi “Salva”.</div>'; return; }
  grid.innerHTML = saved.map(p => {
    const cover = p.items?.[0]?.src || '';
    return `<article class="project-card"><div class="project-art">${cover ? `<img src="${cover}" alt="">` : ''}<strong>${p.title || 'Album'}</strong></div>
      <footer><span>${p.slides?.length || 0} slide · ${new Date(p.updated).toLocaleDateString('it-IT')}</span>
      <span><button data-open="${p.id}">Apri</button><button class="del" data-del="${p.id}" title="Elimina il progetto">Elimina</button></span></footer></article>`;
  }).join('');
  $$('[data-open]').forEach(b => b.onclick = () => {
    project = normalize(saved.find(p => p.id === b.dataset.open));
    applyFormat(project.format);
    selectedSlide = 0;
    selectedItem = null;
    showPanel('editor');
    fitZoom();
    toast('Album caricato');
  });
  $$('[data-del]').forEach(b => b.onclick = () => confirmAction('Eliminare il progetto?', 'Non sarà più recuperabile su questo dispositivo.', 'Elimina', async () => {
    await deleteProject(b.dataset.del);
    renderProjects();
    toast('Progetto eliminato');
  }));
}

/* --------------------------------------------------------------- export */

// One rounded rectangle, optionally with a different radius per corner (top-left, top-right,
// bottom-right, bottom-left) — the same four values the inspector edits.
function roundedRect(ctx, x, y, w, h, r) {
  const limit = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = (Array.isArray(r) ? r : [r, r, r, r]).map(value => Math.max(0, Math.min(value, limit)));
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

// The export counterpart of shapeCSS: same shapes, drawn as canvas paths.
function shapePath(ctx, item, x, y, w, h, radiusScale) {
  const shape = item.shape || 'rect';
  const spec = SHAPES[shape];
  if (spec && spec.points) {
    ctx.beginPath();
    spec.points.forEach(([px, py], index) => {
      const pointX = x + (px / 100) * w, pointY = y + (py / 100) * h;
      if (index === 0) ctx.moveTo(pointX, pointY); else ctx.lineTo(pointX, pointY);
    });
    ctx.closePath();
    return;
  }
  if (shape === 'circle') {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.closePath();
    return;
  }
  if (shape === 'pill') { roundedRect(ctx, x, y, w, h, Math.min(w, h) / 2); return; }
  if (shape === 'arch') { roundedRect(ctx, x, y, w, h, [w / 2, w / 2, w * .06, w * .06]); return; }
  if (shape === 'leaf') { roundedRect(ctx, x, y, w, h, [Math.min(w, h) / 2, w * .06, Math.min(w, h) / 2, w * .06]); return; }
  roundedRect(ctx, x, y, w, h, cornerList(item).map(value => value * radiusScale));
}

// Canvas has no word wrap: break on spaces, and hard-break a word too long for the line.
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawText(ctx, item, x, y, w, h) {
  const pad = 24;
  const size = item.size / 100 * OUT_H;
  ctx.font = `${item.italic ? 'italic ' : ''}${item.bold ? '700 ' : ''}${size}px ${(FONTS[item.font] || FONTS.sans).stack}`;
  ctx.fillStyle = item.color || '#ffffff';
  ctx.textBaseline = 'top';
  ctx.textAlign = item.align || 'center';
  const lines = wrapText(ctx, item.text, w - pad * 2);
  const lineHeight = size * 1.25;
  const block = lines.length * lineHeight;
  const startY = item.valign === 'top' ? y + pad
    : item.valign === 'bottom' ? y + h - pad - block
    : y + (h - block) / 2;
  const textX = item.align === 'left' ? x + pad : item.align === 'right' ? x + w - pad : x + w / 2;
  lines.forEach((line, index) => {
    const lineY = startY + index * lineHeight;
    ctx.fillText(line, textX, lineY);
    // canvas has no text-decoration: draw the rules ourselves, under the measured line width
    if (!item.underline && !item.strike) return;
    const lineW = ctx.measureText(line).width;
    const left = item.align === 'left' ? textX : item.align === 'right' ? textX - lineW : textX - lineW / 2;
    ctx.fillRect(left, lineY + size * (item.underline ? 1.04 : 0.6), lineW, Math.max(1, size * 0.06));
    if (item.underline && item.strike) ctx.fillRect(left, lineY + size * 0.6, lineW, Math.max(1, size * 0.06));
  });
}


let grainTile = null;
function drawGrain(ctx, x, y, w, h, strength) {
  if (!grainTile) {
    grainTile = document.createElement('canvas');
    grainTile.width = grainTile.height = 128;
    const tileCtx = grainTile.getContext('2d');
    const data = tileCtx.createImageData(128, 128);
    for (let i = 0; i < data.data.length; i += 4) {
      const value = 110 + Math.random() * 90;
      data.data[i] = data.data[i + 1] = data.data[i + 2] = value;
      data.data[i + 3] = 255;
    }
    tileCtx.putImageData(data, 0, 0);
  }
  ctx.save();
  ctx.globalAlpha = strength * 0.55;
  ctx.globalCompositeOperation = 'overlay';
  const pattern = ctx.createPattern(grainTile, 'repeat');
  ctx.fillStyle = pattern;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

// Draws one item for slide `index`: box coordinates are global, shifted by the slide offset, so an
// item crossing the seam lines up exactly between two exported files.
function drawItem(ctx, item, image, index) {
  const bx = (item.x - index) * OUT_W, by = item.y * OUT_H;
  const bw = item.w * OUT_W, bh = item.h * OUT_H;
  const spec = FRAMES[item.frame] || FRAMES.clean;
  ctx.save();
  ctx.translate(bx + bw / 2, by + bh / 2);
  ctx.rotate((item.rotation || 0) * Math.PI / 180);
  if (spec.border) {
    ctx.shadowColor = 'rgba(0,0,0,.4)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = spec.color;
    shapePath(ctx, item, -bw / 2, -bh / 2, bw, bh, 3);
    ctx.fill();
    ctx.shadowColor = 'transparent';
  }
  if (item.frame === 'tape') {
    ctx.fillStyle = 'rgba(232,213,169,.8)';
    ctx.fillRect(-bw * .21, -bh / 2 - bh * .06, bw * .42, bh * .13);
  }
  const ix = -bw / 2 + spec.border, iy = -bh / 2 + spec.border;
  const iw = bw - spec.border * 2, ih = bh - spec.border - spec.bottom;
  if (iw <= 0 || ih <= 0) { ctx.restore(); return; }
  shapePath(ctx, item, ix, iy, iw, ih, Math.max(0, 3 - spec.border / Math.max(1, item.radius || 1)));
  ctx.clip();
  if (itemKind(item) === 'text') {
    if (item.fillOpacity) {
      ctx.fillStyle = rgba(item.fill || '#000000', item.fillOpacity / 100);
      ctx.fillRect(ix, iy, iw, ih);
    }
    drawText(ctx, item, ix, iy, iw, ih);
  } else if (!item.src) {
    ctx.fillStyle = item.fill || '#888888';
    ctx.fillRect(ix, iy, iw, ih);
  } else {
    // object-fit: cover with object-position panX/panY, then the zoom scale
    const scale = Math.max(iw / image.naturalWidth, ih / image.naturalHeight) * (item.zoom / 100);
    const dw = image.naturalWidth * scale, dh = image.naturalHeight * scale;
    const look = photoCSS(item, spec.filter);
    if (look) ctx.filter = look;
    ctx.drawImage(image, ix - (dw - iw) * (item.panX / 100), iy - (dh - ih) * (item.panY / 100), dw, dh);
    ctx.filter = 'none';
    if (item.grain) drawGrain(ctx, ix, iy, iw, ih, item.grain / 100);
    if (item.vignette) {
      const gradient = ctx.createRadialGradient(ix + iw / 2, iy + ih / 2, Math.min(iw, ih) * 0.22,
        ix + iw / 2, iy + ih / 2, Math.max(iw, ih) * 0.72);
      gradient.addColorStop(0, 'rgba(0,0,0,0)');
      gradient.addColorStop(1, `rgba(0,0,0,${item.vignette / 100})`);
      ctx.fillStyle = gradient;
      ctx.fillRect(ix, iy, iw, ih);
    }
  }
  if (item.tintOpacity) {
    ctx.fillStyle = rgba(item.tintColor, item.tintOpacity / 100);
    ctx.fillRect(ix, iy, iw, ih);
  }
  ctx.restore();
}

async function drawSlide(index, imageMap) {
  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = project.bgColor;
  ctx.fillRect(0, 0, OUT_W, OUT_H);
  const visible = project.items.filter(i => i.x < index + 1 && i.x + i.w > index);
  visible.forEach(i => drawItem(ctx, i, imageMap.get(i.src), index));
  if (project.showNumbers) {
    const label = `${index + 1}/${project.slideCount}`;
    ctx.font = '600 34px Arial';
    const w = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    roundedRect(ctx, 54, OUT_H - 118, w + 50, 62, 31);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 79, OUT_H - 87);
  }
  return canvas;
}

let exported = [];   // [{ index, blob, url, name }]

function clearExports() {
  exported.forEach(e => URL.revokeObjectURL(e.url));
  exported = [];
}

const canvasBlob = canvas => new Promise(resolve => canvas.toBlob(resolve, 'image/png'));

// Renders every slide and shows them. Browsers only ever grant the first of a burst of automatic
// downloads, so the slides are handed over as visible images: save them one by one, share them
// through the OS sheet on a phone, or use "scarica tutte" and accept the multi-download prompt.
async function prepareExport() {
  const status = $('#export-status');
  const grid = $('#export-grid');
  clearExports();
  grid.innerHTML = '';
  status.textContent = 'Preparo le slide…';
  $('#share-pngs').classList.add('hidden');
  try {
    const sources = [...new Set(project.items.map(i => i.src).filter(Boolean))];
    const imageMap = new Map(await Promise.all(sources.map(async src => [src, await loadImage(src)])));
    for (let index = 0; index < project.slideCount; index++) {
      const canvas = await drawSlide(index, imageMap);
      const blob = await canvasBlob(canvas);
      exported.push({ index, blob, url: URL.createObjectURL(blob), name: `album-slide-${pad(index)}.png` });
    }
    grid.innerHTML = exported.map(e => `<figure class="export-item">
      <img src="${e.url}" alt="Slide ${pad(e.index)}">
      <figcaption>${pad(e.index)}</figcaption>
      <a class="btn" href="${e.url}" download="${e.name}">Salva</a>
    </figure>`).join('');
    status.textContent = `${exported.length} slide pronte a ${OUT_W}×${OUT_H}. Salvale una per una, oppure tienile premute per salvarle dal telefono.`;
    const files = exported.map(e => new File([e.blob], e.name, { type: 'image/png' }));
    if (navigator.canShare && navigator.canShare({ files })) {
      const share = $('#share-pngs');
      share.classList.remove('hidden');
      share.onclick = () => navigator.share({ files, title: project.title }).catch(() => {});
    }
  } catch {
    status.textContent = 'Non sono riuscito a preparare una delle immagini.';
  }
}

// Sequential downloads: the browser may still ask permission for the batch.
// The whole strip as a single wide image. Same drawing code: every item is placed against slide 0
// of a canvas as wide as the carousel, so the seams land exactly where the slices would cut.
async function exportPanorama() {
  const button = $('#download-panorama');
  button.disabled = true;
  const wasLabel = button.textContent;
  button.textContent = 'Preparo…';
  try {
    const sources = [...new Set(project.items.map(i => i.src).filter(Boolean))];
    const imageMap = new Map(await Promise.all(sources.map(async src => [src, await loadImage(src)])));
    const canvas = document.createElement('canvas');
    canvas.width = OUT_W * project.slideCount;
    canvas.height = OUT_H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = project.bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    project.items.forEach(item => drawItem(ctx, item, imageMap.get(item.src), 0));
    if (showGuides) {           // thin marks where each slide ends
      ctx.strokeStyle = 'rgba(255,255,255,.45)';
      ctx.setLineDash([14, 14]);
      for (let i = 1; i < project.slideCount; i++) {
        ctx.beginPath();
        ctx.moveTo(i * OUT_W, 0);
        ctx.lineTo(i * OUT_W, OUT_H);
        ctx.stroke();
      }
    }
    const blob = await canvasBlob(canvas);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(project.title || 'album').toLowerCase().replace(/\s+/g, '-')}-panorama.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast(`Panoramica ${canvas.width}×${canvas.height} scaricata`);
  } catch {
    toast('Non sono riuscito a comporre la panoramica');
  } finally {
    button.disabled = false;
    button.textContent = wasLabel;
  }
}

async function downloadPNGs() {
  if (!exported.length) return;
  for (const item of exported) {
    const link = document.createElement('a');
    link.href = item.url;
    link.download = item.name;
    link.click();
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  toast(exported.length > 1 ? 'Se il browser ha scaricato solo la prima, consenti i download multipli o usa “Salva” su ogni slide' : 'Download avviato');
}

function downloadProject() {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${(project.title || 'album').toLowerCase().replace(/\s+/g, '-')}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1500);
  toast('Backup scaricato');
}

/* ------------------------------------------------------------------ ui */

function confirmAction(title, text, okLabel, onConfirm) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-yes').textContent = okLabel;
  $('#confirm-yes').onclick = () => { dialog.close(); onConfirm(); };
  $('#confirm-no').onclick = () => dialog.close();
  dialog.showModal();
}

// Starting over: never silently throw away work. If nothing has changed there is nothing to ask.
function startNewProject() {
  const fresh = () => {
    project = newProject();
    applyFormat(project.format);
    undoStack = [];
    redoStack = [];
    selectedSlide = 0;
    selectedItem = null;
    dirty = false;
    showPanel('editor');
    fitZoom();
    toast('Nuovo progetto');
  };
  if (!project.items.length || !dirty) { fresh(); return; }
  const dialog = $('#new-dialog');
  $('#new-text').textContent = project.id
    ? `“${project.title}” ha modifiche non salvate. Cosa ne faccio?`
    : `“${project.title}” non è mai stato salvato. Cosa ne faccio?`;
  $('#new-save').onclick = async () => { dialog.close(); await saveProject(); fresh(); };
  $('#new-discard').onclick = () => { dialog.close(); fresh(); };
  $('#new-cancel').onclick = () => dialog.close();
  dialog.showModal();
}

function showPanel(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.panel === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === `${name}-panel`));
  if (name === 'layouts') renderLayoutGallery();
  if (name === 'projects') renderProjects();
  if (name === 'editor') render();
}

function fitZoom() {
  const stage = $('#stage');
  // keep ~2.5 slides in view so the seams are always visible, but never taller than the stage
  const byWidth = (stage.clientWidth - 44) / Math.min(project.slideCount, 2.5);
  const byHeight = (stage.clientHeight - 56) * OUT_W / OUT_H;
  slideW = clamp(Math.min(byWidth, byHeight), 110, 620);
  render();
}

function bindRange(id, key, format) {
  const input = $(id);
  input.oninput = () => {
    const item = selected();
    if (!item) return;
    item[key] = +input.value;
    const out = $(`${id}-value`);
    if (out) out.value = format ? format(input.value) : input.value;
    render();
  };
}

function init() {
  $('#add-bg').onchange = e => { readFiles(e.target.files, src => addItem(src, 'full')); e.target.value = ''; };
  $('#add-photo').onchange = e => { readFiles(e.target.files, src => addItem(src, 'free')); e.target.value = ''; };
  $('#add-color').onclick = addColourBlock;
  $('#auto-layout').onclick = () => $('#auto-files').click();
  $('#auto-files').onchange = e => { autoLayout(e.target.files); e.target.value = ''; };
  $('#add-text').onclick = addTextItem;

  $('#item-text').oninput = e => { const i = selected(); if (i) { i.text = e.target.value; render(); } };
  // typing is one undo step per burst: a checkpoint before the first keystroke, not before each
  let lastTextUndo = 0;
  $('#item-text').addEventListener('beforeinput', () => {
    if (Date.now() - lastTextUndo > 1500) pushUndo();
    lastTextUndo = Date.now();
  });
  $('#item-font').onchange = e => { const i = selected(); if (i) { pushUndo(); i.font = e.target.value; render(); } };
  $('#item-text-color').oninput = e => { const i = selected(); if (i) { i.color = e.target.value; render(); } };
  $('#item-size').oninput = e => { const i = selected(); if (i) { i.size = +e.target.value; $('#item-size-value').value = i.size; render(); } };
  $('#item-text-bg').oninput = e => { const i = selected(); if (i) { i.fill = e.target.value; render(); } };
  $('#item-text-bg-opacity').oninput = e => { const i = selected(); if (i) { i.fillOpacity = +e.target.value; $('#item-text-bg-opacity-value').value = i.fillOpacity; render(); } };
  $$('[data-style]').forEach(b => b.onclick = () => {
    const i = selected();
    if (!i) return;
    pushUndo();
    i[b.dataset.style] = !i[b.dataset.style];
    render();
  });
  $$('[data-align]').forEach(b => b.onclick = () => { const i = selected(); if (i) { pushUndo(); i.align = b.dataset.align; render(); } });
  $$('[data-valign]').forEach(b => b.onclick = () => { const i = selected(); if (i) { pushUndo(); i.valign = b.dataset.valign; render(); } });

  const TEXT_PRESETS = {
    light: { color: '#241f1a', fill: '#f4efe6', fillOpacity: 92, font: 'serif', size: 8 },
    dark:  { color: '#ffffff', fill: '#141414', fillOpacity: 78, font: 'sans', size: 8 },
    plain: { color: '#ffffff', fillOpacity: 0, font: 'display', size: 12 },
    tag:   { color: '#141400', fill: '#d9ff4b', fillOpacity: 100, font: 'narrow', size: 4 }
  };
  $$('[data-preset]').forEach(b => b.onclick = () => {
    const i = selected();
    if (!i) return;
    pushUndo();
    Object.assign(i, TEXT_PRESETS[b.dataset.preset]);
    render();
  });
  $('#item-fill-color').oninput = e => { const i = selected(); if (i) { i.fill = e.target.value; render(); } };

  $('#more-slides').onclick = () => changeSlideCount(1);
  $('#less-slides').onclick = () => changeSlideCount(-1);
  $('#move-left').onclick = () => moveSlide(-1);
  $('#move-right').onclick = () => moveSlide(1);
  $('#duplicate-slide').onclick = duplicateSlide;
  $('#delete-slide').onclick = deleteSlide;
  $('#clear-slide').onclick = () => {
    const count = project.items.filter(i => insideSlide(i, selectedSlide)).length;
    if (!count) { toast('Questa slide non ha immagini tutte sue'); return; }
    confirmAction('Svuotare la slide?', `${count} elementi verranno rimossi dalla slide ${pad(selectedSlide)}.`, 'Svuota', () => {
      pushUndo();
      project.items = project.items.filter(i => !insideSlide(i, selectedSlide));
      selectedItem = null;
      render();
      toast('Slide svuotata');
    });
  };
  $('#item-tint-color').oninput = e => { const i = selected(); if (i) { i.tintColor = e.target.value; render(); } };
  $('#item-tint').oninput = e => { const i = selected(); if (i) { i.tintOpacity = +e.target.value; $('#item-tint-value').value = i.tintOpacity; render(); } };

  $$('[data-recipe]').forEach(b => b.onclick = () => applyRecipe(b.dataset.recipe));
  $('#span-recipe').onclick = addSpanningPhoto;
  $('#project-title').oninput = e => { project.title = e.target.value.trim() || 'Album fotografico'; scheduleAutosave(); };
  $('#bg-color').oninput = e => { project.bgColor = e.target.value; render(); };
  $$('[data-format]').forEach(b => b.onclick = () => {
    pushUndo();
    applyFormat(b.dataset.format);
    fitZoom();
    toast(`Formato ${FORMATS[project.format].label} — ${OUT_W}×${OUT_H}`);
  });
  $('#show-numbers').onchange = e => { project.showNumbers = e.target.checked; render(); };
  $('#show-guides').onchange = e => { showGuides = e.target.checked; render(); };

  bindRange('#item-zoom', 'zoom', v => `${v}%`);
  bindRange('#item-panx', 'panX');
  bindRange('#item-pany', 'panY');
  bindRange('#item-radius', 'radius');
  bindRange('#item-rotation', 'rotation', v => `${v}°`);
  $('#item-frame').onchange = () => { const i = selected(); if (i) { i.frame = $('#item-frame').value; render(); } };
  $('#item-shape').onchange = () => { const i = selected(); if (i) { pushUndo(); i.shape = $('#item-shape').value; render(); } };
  $('#corner-split').onchange = e => {
    const i = selected();
    if (!i) return;
    pushUndo();
    i.corners = e.target.checked ? [i.radius, i.radius, i.radius, i.radius] : null;
    render();
  };
  [['tl', 0], ['tr', 1], ['br', 2], ['bl', 3]].forEach(([corner, index]) => {
    $(`#corner-${corner}`).oninput = e => {
      const i = selected();
      if (!i || !Array.isArray(i.corners)) return;
      i.corners[index] = +e.target.value;
      render();
    };
  });
  $('#item-look').onchange = () => { const i = selected(); if (i) { pushUndo(); i.look = $('#item-look').value; render(); } };
  bindRange('#item-grain', 'grain');
  bindRange('#item-vignette', 'vignette');
  bindRange('#item-exposure', 'exposure');
  bindRange('#item-contrast', 'contrast');
  bindRange('#item-shadows', 'shadows');
  bindRange('#item-saturation', 'saturation');
  bindRange('#item-warmth', 'warmth');
  $('#item-reset-look').onclick = () => {
    const i = selected();
    if (!i) return;
    pushUndo();
    Object.assign(i, { look: 'none', grain: 0, vignette: 0, exposure: 0, contrast: 0, shadows: 0, saturation: 0, warmth: 0 });
    render();
    toast('Regolazioni azzerate');
  };
  $('#item-fill').onclick = () => { const i = selected(); if (i) { pushUndo(); fillOccupiedSlides(i); render(); toast('Foto allineata ai bordi delle slide'); } };
  $('#item-widen').onclick = () => { const i = selected(); if (i) { pushUndo(); i.w = Math.min(i.w + 1, project.slideCount - i.x); render(); } };
  $('#item-narrow').onclick = () => { const i = selected(); if (i) { pushUndo(); i.w = Math.max(MIN_W, i.w - 1); render(); } };
  $('#item-straighten').onclick = () => { const i = selected(); if (i) { pushUndo(); i.rotation = 0; render(); } };
  $('#item-front').onclick = () => { const i = selected(); if (i) { pushUndo(); project.items = [...project.items.filter(x => x !== i), i]; render(); } };
  $('#item-back').onclick = () => { const i = selected(); if (i) { pushUndo(); project.items = [i, ...project.items.filter(x => x !== i)]; render(); } };
  $('#item-duplicate').onclick = () => {
    const i = selected();
    if (!i) return;
    pushUndo();
    const copy = { ...clone(i), id: uid(), x: i.x + 0.08, y: i.y + 0.04 };
    project.items.push(copy);
    selectedItem = copy.id;
    render();
  };
  $('#item-delete').onclick = removeSelected;
  $('#item-replace').onchange = e => {
    const item = selected();
    if (item) readFiles(e.target.files, src => { pushUndo(); item.src = src; item.demo = false; delete item.fill; render(); toast('Immagine inserita'); });
    e.target.value = '';
  };

  const setMode = next => {
    mode = next;
    $('#mode-edit').classList.toggle('active', next === 'edit');
    $('#mode-preview').classList.toggle('active', next === 'preview');
    render();
  };
  $('#mode-edit').onclick = () => setMode('edit');
  $('#mode-preview').onclick = () => setMode('preview');
  $('#zoom-in').onclick = () => { slideW = clamp(slideW * 1.15, 110, 620); render(); };
  $('#zoom-out').onclick = () => { slideW = clamp(slideW / 1.15, 110, 620); render(); };
  $('#zoom-fit').onclick = fitZoom;

  $('#save-project').onclick = saveProject;
  $('#save-template').onclick = saveAsTemplate;
  $('#new-project').onclick = startNewProject;
  $('#export-open').onclick = () => { $('#export-dialog').showModal(); prepareExport(); };
  $('#close-export').onclick = () => $('#export-dialog').close();
  $('#export-dialog').addEventListener('close', clearExports);
  $('#download-pngs').onclick = downloadPNGs;
  $('#download-panorama').onclick = exportPanorama;
  $('#download-project').onclick = downloadProject;
  $('#open-backup').onchange = e => { if (e.target.files[0]) openBackup(e.target.files[0]); e.target.value = ''; };
  $('#help-open').onclick = () => $('#help-dialog').showModal();
  $('#help-close').onclick = () => $('#help-dialog').close();
  $$('.tab').forEach(t => t.onclick = () => showPanel(t.dataset.panel));

  $$('.tab-scope').forEach(tab => tab.onclick = () => setScope(tab.dataset.scope));
  setScope('slide');

  $$('#context-menu [data-act]').forEach(b => b.onclick = () => runContextAction(b.dataset.act));
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('#context-menu') && !e.target.closest('.item')) closeContextMenu();
  }, true);
  $('#strip').addEventListener('contextmenu', e => {
    const node = e.target.closest('.item');
    if (!node) return;
    e.preventDefault();
    const item = project.items.find(i => i.id === node.dataset.id);
    if (item) openContextMenu(item, e.clientX, e.clientY);
  });

  $('#undo').onclick = undo;
  $('#redo').onclick = redo;
  // a slider drag is one undo step: remember the state when the grab starts, not on every pixel
  $$('#sec-item input[type=range]').forEach(range => {
    range.addEventListener('pointerdown', pushUndo);
    range.addEventListener('keydown', e => { if (e.key.startsWith('Arrow')) pushUndo(); });
  });

  document.addEventListener('keydown', e => {
    const typing = e.target.matches('input,select,textarea');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      (e.shiftKey ? redo : undo)();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (typing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedItem) { e.preventDefault(); removeSelected(); }
    if (e.key === 'Escape') {
      if (!$('#context-menu').classList.contains('hidden')) { closeContextMenu(); return; }
      if (selectedItem) { selectedItem = null; render(); }
    }
  });
  // drop photos straight onto the strip: they land on the slide you dropped them over
  const dropZone = $('#strip-scroll');
  const overClass = on => dropZone.classList.toggle('dropping', on);
  dropZone.addEventListener('dragover', e => { e.preventDefault(); overClass(true); });
  dropZone.addEventListener('dragleave', e => { if (e.target === dropZone) overClass(false); });
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    overClass(false);
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    const strip = $('#strip').getBoundingClientRect();
    const droppedAt = (e.clientX - strip.left) / slideW;
    selectedSlide = clamp(Math.floor(droppedAt), 0, project.slideCount - 1);
    readFiles(files, src => addItem(src, 'free'));
  });

  window.addEventListener('resize', () => render());

  applyFormat(project.format);
  fitZoom();
  migrateLegacyStorage().then(restoreAutosave);
}

if (typeof document !== 'undefined') init();
if (typeof module !== 'undefined') module.exports = {
  remapAfterDelete, remapAfterMove, insideSlide, spanOf, fillOccupiedSlides, normalize,
  useIndexedDB, putProject, allProjects, deleteProject, storageModeNow: () => storageMode,
  setSlideCount: n => { project.slideCount = n; }
};

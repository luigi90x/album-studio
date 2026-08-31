const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const DB_NAME = 'album-studio', STORE = 'projects', MEDIA = 'media';

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
const MAX_CLIP = 30;                 // seconds of video that end up in the export
const CLIP_FPS = 24;                 // default frames per second when recording a slide

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
let playingVideo = null;    // id of the clip the panel player is showing, when it is running
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

// The export records one slide at a time, so a video lying across a seam would come out cut into
// two files. Rather than letting you discover that at export time, a clip is pulled into the slide
// its middle sits in: drag it past the halfway point and it jumps over whole.
function keepClipInOneSlide(item) {
  if (!item || itemKind(item) !== 'video') return false;
  const slide = clamp(Math.floor(item.x + item.w / 2), 0, project.slideCount - 1);
  const w = Math.min(item.w, 1);
  const x = clamp(item.x, slide, slide + 1 - w);
  const changed = Math.abs(w - item.w) > 1e-9 || Math.abs(x - item.x) > 1e-9;
  item.w = w;
  item.x = x;
  return changed;
}

// Work that takes a moment must say so. Shown only after a short delay, so quick operations do not
// make the interface flash.
let busyJobs = 0, busyTimer = null;

function busy(message) {
  busyJobs++;
  const label = $('#busy-text');
  if (label) label.textContent = message;
  if (busyTimer) return;
  busyTimer = setTimeout(() => { if (busyJobs > 0) $('#busy')?.classList.remove('hidden'); }, 180);
}

function busyUpdate(message) {
  const label = $('#busy-text');
  if (label && busyJobs > 0) label.textContent = message;
}

function busyDone() {
  busyJobs = Math.max(0, busyJobs - 1);
  if (busyJobs) return;
  clearTimeout(busyTimer);
  busyTimer = null;
  $('#busy')?.classList.add('hidden');
}

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

// The veil and the vignette, as a background stack. Shared with the video player in the panel so
// that changing the look of a clip is visible where you are actually watching it.
const overlayCSS = item => {
  const layers = [];
  if (item.tintOpacity) layers.push(`linear-gradient(${rgba(item.tintColor, item.tintOpacity / 100)}, ${rgba(item.tintColor, item.tintOpacity / 100)})`);
  if (item.vignette) layers.push(`radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,${item.vignette / 100}) 100%)`);
  return layers.join(', ') || 'transparent';
};

// Shapes an item can be cut to. Everything is expressed as a path so the browser and the export
// canvas can be given the same geometry: CSS gets a clip-path, canvas gets the same points.
const SHAPES = {
  rect:    { label: 'Rettangolo' },
  circle:  { label: 'Cerchio' },
  pill:    { label: 'Pillola' },
  arch:    { label: 'Arco' },
  diamond: { label: 'Rombo', points: [[50, 0], [100, 50], [50, 100], [0, 50]] },
  hexagon: { label: 'Esagono', points: [[25, 0], [75, 0], [100, 50], [75, 100], [25, 100], [0, 50]] },
  leaf:    { label: 'Foglia' },
  // ten vertices alternating between the outer and inner radius of a five-pointed star
  star:    { label: 'Stella', points: [[50, 0], [62.3, 33], [97.6, 34.5], [70, 56.5], [79.4, 90.5],
                                       [50, 71], [20.6, 90.5], [30, 56.5], [2.4, 34.5], [37.7, 33]] }
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
const itemKind = item => (item.video ? 'video'
  : item.text !== undefined && item.text !== null ? 'text'
  : item.src ? 'image'
  : item.placeholder ? 'empty'
  : 'colour');

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
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(MEDIA)) db.createObjectStore(MEDIA, { keyPath: 'id' });
    };
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

function dbRun(mode, run, store = STORE) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = run(tx.objectStore(store));
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
  // with IndexedDB the project is just structure and ids — the pictures already live in the media
  // store, so a save is kilobytes. localStorage has nowhere else to keep them, so there they ride along.
  if (await useIndexedDB()) return dbRun('readwrite', store => store.put(value));
  const list = localList().filter(p => p.id !== value.id);
  list.unshift(await withMediaInline(value));
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

/* ---------------------------------------------------------- media store */

// Photos used to live inside the project as base64 strings. That made every save rewrite every
// picture, and a photo reused in five frames was stored five times. Now the project holds only ids
// and the files live here as Blobs: no encoding overhead, and the same picture is kept once.
// Anything that is already a data: or blob: URL still works, so older projects open unchanged.
const mediaCache = new Map();       // id -> object URL, for this session
const mediaBlobs = new Map();       // id -> Blob, also the whole store when IndexedDB is unavailable

const isDirectSrc = src => typeof src === 'string' && (src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('http'));

// A content key, so the same file dropped twice is stored once. crypto.subtle needs a secure
// context and file:// is not one, hence the plain fallback.
async function mediaKey(blob) {
  const buffer = await blob.arrayBuffer();
  if (crypto.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      return [...new Uint8Array(digest)].slice(0, 12).map(byte => byte.toString(16).padStart(2, '0')).join('');
    } catch { /* fall through */ }
  }
  const bytes = new Uint8Array(buffer);
  const step = Math.max(1, Math.floor(bytes.length / 4096));
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i += step) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return `${blob.size.toString(36)}-${(hash >>> 0).toString(36)}`;
}

// ponytail: media dropped from every project stay in the store. Clearing them means scanning all
// saved projects for references — worth doing when the store can actually grow (videos), not now.
async function putMedia(blob) {
  const id = await mediaKey(blob);
  mediaBlobs.set(id, blob);
  if (await useIndexedDB()) {
    try { await dbRun('readwrite', store => store.put({ id, blob }), MEDIA); } catch { /* keep it in memory */ }
  }
  return id;
}

async function getMedia(id) {
  if (mediaBlobs.has(id)) return mediaBlobs.get(id);
  if (await useIndexedDB()) {
    try {
      const found = await dbRun('readonly', store => store.get(id), MEDIA);
      if (found && found.blob) { mediaBlobs.set(id, found.blob); return found.blob; }
    } catch { /* nothing stored */ }
  }
  return null;
}

// The URL to actually draw with. Ids resolve to an object URL created once per session.
// While composing we draw the cover frame: a still image is cheap even with several videos on the
// strip. The video itself is only played in preview mode and read again when recording the export.
function posterOf(item) {
  if (item && item.poster) return mediaCache.get(item.poster) || '';
  return srcOf(item);
}

function srcOf(item) {
  const src = item && item.src;
  if (!src) return '';
  if (isDirectSrc(src)) return src;
  return mediaCache.get(src) || '';
}

// Makes sure every id used by the project has its object URL ready before drawing.
async function primeMedia(items = project.items) {
  const wanted = items.flatMap(i => [i.src, i.poster]);
  const missing = [...new Set(wanted.filter(src => src && !isDirectSrc(src) && !mediaCache.has(src)))];
  for (const id of missing) {
    const blob = await getMedia(id);
    if (blob) mediaCache.set(id, URL.createObjectURL(blob));
  }
  return missing.length;
}

const blobToDataURL = blob => new Promise(resolve => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.readAsDataURL(blob);
});

// A project that carries its pictures with it: for the JSON backup, and for localStorage, which
// has nowhere else to put them.
async function withMediaInline(source) {
  const copy = clone(source);
  for (const item of copy.items || []) {
    if (!item.src || isDirectSrc(item.src)) continue;
    const blob = await getMedia(item.src);
    if (blob) item.src = await blobToDataURL(blob);
  }
  return copy;
}

// The other direction: pictures embedded in a file become entries in the store.
async function absorbMedia(incoming) {
  for (const item of incoming.items || []) {
    if (!item.src || !item.src.startsWith('data:')) continue;
    try {
      const blob = await (await fetch(item.src)).blob();
      const id = await putMedia(blob);
      mediaCache.set(id, mediaCache.get(id) || URL.createObjectURL(blob));
      item.src = id;
    } catch { /* leave the data URL as it is: it still renders */ }
  }
  return incoming;
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
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    const id = await putMedia(blob);
    if (!mediaCache.has(id)) mediaCache.set(id, URL.createObjectURL(blob));
    return id;                       // the project stores the id, the file lives in the media store
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Videos are kept exactly as they came in: re-encoding them in the browser costs minutes and
// quality, and the export re-draws them anyway. What we take out at import time is what the editor
// needs to work without touching the file again: a cover frame, the duration, the size, and whether
// there is any audio at all.
async function probeVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('formato non leggibile'));
      setTimeout(() => reject(new Error('timeout')), 15000);
    });
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    // seek a little in: the very first frame is often black
    const at = Math.min(duration * 0.1 || 0, 1);
    await new Promise(resolve => {
      video.onseeked = resolve;
      video.currentTime = at;
      setTimeout(resolve, 4000);
    });
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(video.videoWidth || 1, video.videoHeight || 1));
    canvas.width = Math.max(1, Math.round((video.videoWidth || 640) * scale));
    canvas.height = Math.max(1, Math.round((video.videoHeight || 480) * scale));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const poster = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return {
      duration,
      width: video.videoWidth,
      height: video.videoHeight,
      hasAudio: detectAudio(video),
      poster
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// No standard way to ask "does this have sound": try what the engines do offer.
function detectAudio(video) {
  if (typeof video.mozHasAudio === 'boolean') return video.mozHasAudio;
  if (typeof video.webkitAudioDecodedByteCount === 'number') return video.webkitAudioDecodedByteCount > 0;
  try {
    if (typeof video.captureStream === 'function') return video.captureStream().getAudioTracks().length > 0;
  } catch { /* not allowed before playback on some engines */ }
  return true;   // assume there is sound: the switch lets you turn it off anyway
}

async function importVideo(file) {
  if (storageMode === 'local') throw new Error('storage');
  const info = await probeVideo(file);
  const id = await putMedia(file);
  const posterId = info.poster ? await putMedia(info.poster) : null;
  if (!mediaCache.has(id)) mediaCache.set(id, URL.createObjectURL(file));
  if (posterId && !mediaCache.has(posterId)) mediaCache.set(posterId, URL.createObjectURL(info.poster));
  return {
    src: id, poster: posterId, video: true,
    duration: info.duration,
    start: 0,
    clip: Math.min(MAX_CLIP, info.duration || MAX_CLIP),
    audio: info.hasAudio,
    hasAudio: info.hasAudio,
    fps: CLIP_FPS,
    videoWidth: info.width,
    videoHeight: info.height
  };
}

// Decoding and shrinking a photo takes a moment; a batch of them used to run one after the other
// with nothing on screen. Now three are processed at a time, the order of the results is preserved,
// and the progress is visible.
const IMPORT_LANES = 3;

async function importAll(files, label = 'Carico le foto') {
  const results = new Array(files.length);
  let done = 0;
  busy(files.length > 1 ? `${label}… 0 di ${files.length}` : `${label}…`);
  const queue = files.map((file, index) => ({ file, index }));
  const lanes = Array.from({ length: Math.min(IMPORT_LANES, queue.length) }, async () => {
    while (queue.length) {
      const { file, index } = queue.shift();
      try { results[index] = await importImage(file); }
      catch { toast(`Non riesco a leggere ${file.name}`); }
      done++;
      if (files.length > 1) busyUpdate(`${label}… ${done} di ${files.length}`);
    }
  });
  try { await Promise.all(lanes); } finally { busyDone(); }
  return results;
}

async function readFiles(fileList, callback) {
  const files = [...fileList].filter(f => f.type.startsWith('image/'));
  if (!files.length) { toast('Scegli un file immagine'); return; }
  const sources = await importAll(files);
  sources.forEach((src, index) => { if (src) callback(src, files[index].name); });
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
    // one object, four shapes: a photo, a solid colour block, text, or an empty frame
    const kind = itemKind(item);
    const node = document.createElement('div');
    const pending = Boolean(item.src) && !isDirectSrc(item.src) && !mediaCache.has(item.src);
    node.className = `item frame-${item.frame} ${kind === 'empty' ? 'is-empty' : ''} ${pending ? 'loading' : ''} ${item.id === selectedItem && interactive ? 'selected' : ''} ${spanOf(item) > 1 ? 'spanning' : ''} ${item.demo ? 'demo' : ''}`;
    node.dataset.id = item.id;
    const inside = kind === 'text' ? '<div class="item-text"></div>'
      : kind === 'empty' ? '<div class="item-empty">＋</div>'
      : kind === 'video' ? `<img src="${posterOf(item)}" alt="">` + (interactive ? `<span class="video-mark">▶ ${formatClip(item)}</span>` : '')
      : (item.src ? `<img src="${srcOf(item)}" alt="">` : '');
    node.innerHTML = `<div class="item-box">${inside}<span class="tint"></span></div><span class="tape"></span><span class="outline"></span>`
      // only on the one you picked: on every demo photo at once it covered the pictures
      + (interactive && item.demo && item.id === selectedItem ? '<span class="demo-tag">esempio · 2 tocchi o tieni premuto</span>' : '')
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
  box.style.background = kind === 'empty' ? 'transparent'
    : kind === 'image' ? '#111'
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

  const img = $('img', node) || $('video', node);
  if (img) {
    img.style.objectPosition = `${item.panX}% ${item.panY}%`;
    img.style.transform = `scale(${item.zoom / 100})`;
    img.style.transformOrigin = `${item.panX}% ${item.panY}%`;
    img.style.filter = photoCSS(item, spec.filter);
  }
  const tint = $('.tint', node);
  if (tint) {
    tint.style.background = overlayCSS(item);
    tint.style.opacity = '1';
    // grain is a tiled noise tile, cheap and resolution independent
    node.classList.toggle('grainy', Boolean(item.grain));
    node.style.setProperty('--grain', (item.grain || 0) / 100);
  }
}

function renderStrip() {
  const strip = $('#strip');
  buildStrip(strip, slideW, true);
  // the invite hangs on the stage, not on the strip: centred on a strip several slides wide it
  // ended up off screen
  $('.strip-empty')?.remove();
  if (!project.items.length) {
    const hint = document.createElement('div');
    hint.className = 'strip-empty';
    hint.innerHTML = '<b>Aggiungi la prima immagine</b><small>Trascinala dove vuoi: può coprire quante slide vuoi.</small>';
    $('#stage').append(hint);
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

// Signature of everything the thumbnails draw. Images count by their resolved address, not by
// their id: on a reopen the ids are known long before the pictures are, and signing the ids meant
// the thumbnails built while the media was still loading were never rebuilt — broken images.
const rulerSignature = () => JSON.stringify(project, (key, value) => {
  if (key !== 'src' && key !== 'poster') return value;
  if (!value) return value;
  return isDirectSrc(value) ? String(value).slice(-24) : mediaCache.get(value) || 'in attesa';
});
let rulerKey = '';

function renderRuler() {
  const ruler = $('#ruler');
  const key = `${rulerSignature()}|${slideW.toFixed(0)}`;
  if (key === rulerKey && ruler.children.length === project.slideCount) {
    // same pictures as a moment ago: just move the highlight
    Array.from(ruler.children).forEach((node, index) => node.classList.toggle('active', index === selectedSlide));
    return;
  }
  rulerKey = key;
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
    const thumb = kind === 'image' ? `background-image:url('${srcOf(item)}')`
      : kind === 'video' ? `background-image:url('${posterOf(item)}')`
      : kind === 'text' ? `background:${item.color || '#fff'};color:${item.fill || '#111'}`
      : `background:${item.fill || '#888'}`;
    const what = kind === 'image' ? 'Immagine'
      : kind === 'video' ? `Video ${formatClip(item)}`
      : kind === 'empty' ? 'Riquadro vuoto'
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
  if (!item || itemKind(item) !== 'video') releaseClip();   // nothing to play: hand the decoder back
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
  $('#add-slide-here').disabled = project.slideCount >= MAX_SLIDES;
  $('#undo').disabled = !undoStack.length;
  $('#redo').disabled = !redoStack.length;
  $('#more-slides').disabled = project.slideCount >= MAX_SLIDES;
  $('#move-left').disabled = selectedSlide === 0;
  $('#move-right').disabled = selectedSlide === project.slideCount - 1;
  if (!item) return;

  const span = spanOf(item), first = firstSlideOf(item), last = lastSlideOf(item);
  $('#sel-span-label').textContent = span === 1 ? '1 slide' : `${span} slide`;
  $('#item-position-note').textContent = itemKind(item) === 'video'
    ? `Sta nella slide ${pad(first)}. Un video resta dentro una slide: l’export registra una slide alla volta.`
    : span === 1
      ? `Sta tutta dentro la slide ${pad(first)}.`
      : `È a cavallo delle slide ${pad(first)}–${pad(last)}: verrà tagliata sui confini.`;
  // only a photo has something to frame inside itself: colour and text swap those controls out
  const kind = itemKind(item);
  const isPhoto = kind === 'image' || kind === 'video';
  $('#sel-kind-label').textContent = { image: 'Immagine selezionata', colour: 'Riquadro colorato', text: 'Testo selezionato' }[kind];
  $('#item-fill-row').classList.toggle('hidden', kind !== 'colour');
  if (kind === 'colour') $('#item-fill-color').value = item.fill || '#888888';
  $('#text-controls').classList.toggle('hidden', kind !== 'text');
  $('#video-controls').classList.toggle('hidden', kind !== 'video');
  if (kind === 'video') {
    const duration = item.duration || 0;
    const maxStart = Math.max(0, duration - 1);
    // Both scales are fixed: shrinking the duration scale as you moved the start made the duration
    // handle slide across the track even though its value had not changed.
    const dragging = document.activeElement;
    if (dragging !== $('#video-start')) {
      $('#video-start').max = maxStart.toFixed(1);
      $('#video-start').value = Math.min(item.start || 0, maxStart);
    }
    $('#video-start-value').value = `${(item.start || 0).toFixed(1)}s`;
    if (dragging !== $('#video-clip')) {
      $('#video-clip').max = Math.max(1, Math.min(MAX_CLIP, duration)).toFixed(1);
      $('#video-clip').value = item.clip ?? Math.min(MAX_CLIP, duration);
    }
    // the value you asked for stays put; if the end of the video cuts it short, say so here
    const asked = item.clip ?? Math.min(MAX_CLIP, duration);
    const real = clipWindow(item).len;
    $('#video-clip-value').value = real < asked - 0.05
      ? `${real.toFixed(1)}s — il video finisce prima`
      : formatClip(item);
    showClip(item);
    $('#video-audio').checked = Boolean(item.audio && item.hasAudio);
    $('#video-audio').disabled = !item.hasAudio;
    $('#video-audio-label').textContent = item.hasAudio ? 'Includi l’audio' : 'Questo video non ha audio';
    $('#video-fps').value = String(item.fps || CLIP_FPS);
    $('#video-thumb-start').title = `Inizio: ${clipWindow(item).from.toFixed(1)}s`;
    $('#video-thumb-end').title = `Fine: ${clipWindow(item).to.toFixed(1)}s`;
    $('#video-play').textContent = playingVideo === item.id ? '❚❚ Ferma' : '▶ Riproduci questo tratto';
    refreshClipThumbs(item);
    $('#video-note').textContent = duration > MAX_CLIP
      ? `Il video dura ${Math.round(duration)}s: nell'export entra la finestra scelta qui, al massimo ${MAX_CLIP}s.`
      : `Video di ${duration.toFixed(1)}s. Nell'export la slide diventa un filmato con sopra tutto il resto.`;
  }
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
  // an id whose object URL is not ready yet would draw as a blank: fetch it, then draw again
  primeMedia().then(missing => { if (missing) render(); });
  selectedSlide = clamp(selectedSlide, 0, project.slideCount - 1);
  if (selectedItem && !itemById(selectedItem)) selectedItem = null;
  // a clip plays only while its own item is the selected one: this single line stops it when you
  // pick something else, close the panel, or delete the video
  if (playingVideo && playingVideo !== selectedItem) playingVideo = null;
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
    if (itemKind(item) === 'empty' && !event.target.dataset.dir) {
      selectedItem = item.id;
      renderInspector();
      $('#item-replace').click();
      return;
    }
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
      keepClipInOneSlide(item);
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
const areaOf = item => item.w * item.h;

// The stretch of video a slide shows. clipSeconds() takes a slide index, this one takes the clip:
// mixing the two up left the player with a zero-length window, so it snapped back to the start
// instead of playing.
function clipWindow(item) {
  const from = item.start || 0;
  const len = Math.max(0.5, Math.min(item.clip ?? MAX_CLIP, MAX_CLIP, (item.duration || MAX_CLIP) - from));
  return { from, to: from + len, len };
}
const formatClip = item => {
  const seconds = clipWindow(item).len;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
};

// Filling order matters more than it looks. Straight reading order pours every photo into the first
// slides and leaves the later ones empty — the carousel ends up with holes. So we go in rounds:
// first the biggest frame of every slide, then the second biggest of every slide, and so on. With
// few photos each slide still gets its main image.
function fillOrder(frames) {
  const bySlide = new Map();
  frames.forEach(frame => {
    const slide = firstSlideOf(frame);
    if (!bySlide.has(slide)) bySlide.set(slide, []);
    bySlide.get(slide).push(frame);
  });
  const slides = [...bySlide.keys()].sort((a, b) => a - b);
  slides.forEach(slide => bySlide.get(slide).sort((a, b) => areaOf(b) - areaOf(a) || a.y - b.y || a.x - b.x));
  const ordered = [];
  const deepest = Math.max(0, ...slides.map(slide => bySlide.get(slide).length));
  for (let round = 0; round < deepest; round++) {
    slides.forEach(slide => {
      const frame = bySlide.get(slide)[round];
      if (frame) ordered.push(frame);
    });
  }
  return ordered;
}

// Reusing a photo in a second frame is fine as long as it does not look like a duplicate: shift the
// crop and zoom so it reads as another detail of the same shot.
function recrop(item, repeat) {
  const shifts = [[30, 30], [70, 35], [35, 72], [72, 68], [50, 20], [20, 55]];
  const [panX, panY] = shifts[repeat % shifts.length];
  Object.assign(item, { panX, panY, zoom: 100 + ((repeat % 3) + 1) * 18 });
}
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
// What each choice would actually do with these photos, worked out up front so the dialog can show
// both the sketch and the real numbers. Only the choices that make sense here are offered.
function planOptions(count) {
  const demoFrames = project.items.filter(i => i.demo && itemKind(i) === 'image');
  const emptyFrames = project.items.filter(i => itemKind(i) === 'empty');
  const photos = project.items.filter(i => itemKind(i) === 'image' && !i.demo);
  const openFrames = demoFrames.length + emptyFrames.length;
  const slides = project.slideCount;
  const free = slidesWithRoom().length;
  const options = [];

  const perSlideOf = list => Array.from({ length: slides }, (_, slide) =>
    list.filter(i => firstSlideOf(i) === slide).length);

  if (openFrames) {
    const filled = Math.min(openFrames, count);
    options.push({
      id: 'frames', title: `Riempi i ${openFrames} riquadri liberi`,
      note: count >= openFrames
        ? `Tutti riempiti${count > openFrames ? `, ${count - openFrames} foto avanzano` : ''}.`
        : `${filled} riempiti, gli altri ${openFrames - filled} restano vuoti per dopo.`,
      sketch: planSketch(perSlideOf([...demoFrames, ...emptyFrames]))
    });
  }

  if (photos.length) {
    const replaced = Math.min(photos.length, count);
    options.push({
      id: 'replace', title: `Sostituisci le ${photos.length} foto già presenti`,
      note: `Layout, forme e cornici restano: cambiano solo le immagini${count < photos.length ? `. Le ultime ${photos.length - replaced} restano com’è` : ''}.`,
      sketch: planSketch(perSlideOf(photos))
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
    id: 'compose', title: 'Ricomponi tutto da capo',
    note: `${composed.join(' + ')} foto sulle ${slides} slide. Sostituisce quello che c’è ora.`,
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

  // "fill everything" only matters when there are more frames than photos
  const openFrames = project.items.filter(i => (i.demo && itemKind(i) === 'image') || itemKind(i) === 'empty').length;
  const shortOfPhotos = openFrames > sources.length;
  $('#layout-fill-row').classList.toggle('hidden', !shortOfPhotos);
  $('#layout-fill').checked = true;
  $('#layout-fill-label').textContent = `Riempi tutti i ${openFrames} riquadri, riusando le foto con tagli diversi`;

  // the slide switch only means something when the photos actually spill over
  const spills = sources.length > project.slideCount;
  $('#layout-grow').checked = false;
  $('#layout-grow-row').classList.toggle('hidden', !spills);
  $('#layout-grow-label').textContent = `Aggiungi slide se non entrano (ora ne hai ${project.slideCount})`;

  return new Promise(resolve => {
    $('#layout-cancel').onclick = () => { dialog.close(); resolve(null); };
    $('#layout-go').onclick = () => { dialog.close(); resolve({ plan: chosen, grow: $('#layout-grow').checked, fillAll: $('#layout-fill').checked }); };
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

  const sources = (await importAll(list)).filter(Boolean);
  if (!sources.length) return;

  const answer = await askLayout(sources);
  if (!answer) return;
  const { plan, grow, fillAll } = answer;

  pushUndo();
  let used = 0;
  emptiedFrames = 0;
  reusedFrames = 0;

  if (plan === 'replace') {
    // same layout, new pictures: walk the photos in reading order and swap the sources
    project.items.filter(i => itemKind(i) === 'image' && !i.demo).sort(readingOrder).forEach(photo => {
      if (used >= sources.length) return;
      photo.src = sources[used++];
    });
  }

  if (plan === 'frames') {
    const frames = fillOrder(project.items
      .filter(i => (i.demo && itemKind(i) === 'image') || itemKind(i) === 'empty'));
    // first pass, one unique photo each, biggest frame of every slide first
    frames.forEach(frame => {
      if (used >= sources.length) return;
      frame.src = sources[used++];
      frame.demo = false;
      frame.placeholder = false;
    });
    const stillOpen = frames.filter(frame => frame.demo || !frame.src);
    if (fillAll && sources.length) {
      // second pass: no gaping frames left. What is beyond the number of photos reuses them with a
      // different crop, so the album reads as complete rather than half done.
      stillOpen.forEach((frame, repeat) => {
        frame.src = sources[repeat % sources.length];
        frame.demo = false;
        frame.placeholder = false;
        recrop(frame, repeat);
        reusedFrames++;
      });
    } else {
      // left as empty slots: they keep their place and can be filled later, and never reach the export
      stillOpen.forEach(frame => {
        frame.src = null;
        frame.placeholder = true;
        frame.demo = false;
        emptiedFrames++;
      });
    }
  }

  const left = sources.slice(used);
  if (left.length && plan === 'compose') project.items = [];      // recomposing starts from a clean strip
  if (left.length && plan !== 'frames' && plan !== 'replace') {
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
    : reusedFrames
      ? `Riempito tutto: ${used} foto, ${reusedFrames} riquadri riusano una foto con un taglio diverso`
      : emptiedFrames
        ? `${used} foto nei riquadri — ${emptiedFrames} restano vuoti, riempili quando vuoi`
        : `${used} foto sistemate su ${project.slideCount} slide`);
}

let lastComposition = null;
let emptiedFrames = 0;
let reusedFrames = 0;

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

// The two ends of the chosen window, as pictures. Reading a frame means seeking a video, so the
// results are cached and only re-read when the position actually changes.
const clipThumbs = new Map();

async function frameURL(item, at) {
  const key = `${item.id}@${at.toFixed(2)}`;
  if (clipThumbs.has(key)) return clipThumbs.get(key);
  const blob = await grabFrame(item, at, 360);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  if (clipThumbs.size > 40) {                     // keep the cache small
    const [oldest] = clipThumbs.keys();
    URL.revokeObjectURL(clipThumbs.get(oldest));
    clipThumbs.delete(oldest);
  }
  clipThumbs.set(key, url);
  return url;
}

// Nothing selected, or something that is not a clip: let the decoder go.
function releaseClip() {
  const player = $('#video-preview');
  if (!player || !player.dataset.for) return;
  playingVideo = null;
  player.pause();
  player.removeAttribute('src');
  player.load();
  delete player.dataset.for;
}

// One <video> for the whole app, parked in the element panel. It used to sit in the workspace,
// where every redraw spawned another decoder and the app locked up.
let clipShown = '';

// Light refresh while a slider moves: labels, the player position and the two end frames. Running
// the whole inspector on every input event was what still felt jerky.
function showVideoReadout(item) {
  const { from, len } = clipWindow(item);
  const asked = item.clip ?? Math.min(MAX_CLIP, item.duration || 0);
  $('#video-start-value').value = `${from.toFixed(1)}s`;
  $('#video-clip-value').value = len < asked - 0.05
    ? `${len.toFixed(1)}s — il video finisce prima`
    : `${len.toFixed(1)}s`;
  $('#video-thumb-start').title = `Inizio: ${from.toFixed(1)}s`;
  $('#video-thumb-end').title = `Fine: ${(from + len).toFixed(1)}s`;
  const player = $('#video-preview');
  if (player.dataset.for === item.id && player.paused && player.readyState >= 1) {
    clipShown = `${item.id}|${from.toFixed(2)}`;
    player.currentTime = from;
  }
  refreshClipThumbs(item);
  scheduleAutosave();
}

function showClip(item) {
  const player = $('#video-preview');
  const url = srcOf(item);
  // Same treatment the slide gives it, so the look controls are visible right here — on the poster
  // in the workspace they were, but not on the clip you are watching.
  const stage = player.parentElement;
  player.style.filter = photoCSS(item, (FRAMES[item.frame] || FRAMES.clean).filter);
  player.style.objectFit = 'cover';
  player.style.objectPosition = `${item.panX}% ${item.panY}%`;
  player.style.transform = `scale(${(item.zoom || 100) / 100})`;
  player.style.transformOrigin = `${item.panX}% ${item.panY}%`;
  stage.style.aspectRatio = `${Math.max(0.05, item.w) * OUT_W} / ${Math.max(0.05, item.h) * OUT_H}`;
  $('.clip-tint', stage).style.background = overlayCSS(item);
  stage.classList.toggle('grainy', Boolean(item.grain));
  stage.style.setProperty('--grain', (item.grain || 0) / 100);
  if (player.dataset.for !== item.id) {           // switching clips: load once, not on every render
    player.dataset.for = item.id;
    player.src = url;
    player.load();
  }
  const { from, to } = clipWindow(item);
  player.onloadedmetadata = () => { player.currentTime = from; };
  // seeking on every render meant thirty seeks a second while a slider moved
  const key = `${item.id}|${from.toFixed(2)}`;
  if (key !== clipShown) {
    clipShown = key;
    if (player.readyState >= 1 && player.paused) player.currentTime = from;
  }
  player.ontimeupdate = () => {
    $('#video-now').textContent = `${Math.max(0, player.currentTime - from).toFixed(1)}s / ${(to - from).toFixed(1)}s`;
    if (player.currentTime >= to) player.currentTime = from;   // loops inside the window you picked
  };
  if (playingVideo !== item.id) { player.pause(); return; }
  // play() on a video that has only its header loaded is refused: wait for real frames first
  const go = () => player.play().catch(() => { playingVideo = null; });
  if (player.readyState >= 2) go(); else player.oncanplay = go;
}

let thumbRun = 0;
let thumbTimer = null;

// Reading a frame means seeking a video: fired on every slider event the requests piled up and the
// pictures lagged behind. One pair, shortly after you stop.
function refreshClipThumbs(item) {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => drawClipThumbs(item), 180);
}

async function drawClipThumbs(item) {
  const run = ++thumbRun;
  const { from, to: windowEnd } = clipWindow(item);
  const to = Math.min((item.duration || 0) - 0.05, windowEnd);
  const [startURL, endURL] = await Promise.all([frameURL(item, from), frameURL(item, to)]);
  if (run !== thumbRun) return;                   // a newer request won
  $('#video-thumb-start').src = startURL || posterOf(item);
  $('#video-thumb-end').src = endURL || posterOf(item);
}

async function addVideoItem(file) {
  busy('Preparo il video…');
  try {
    const media = await importVideo(file);
    pushUndo();
    const item = newItem(media.src, {
      ...media,
      x: selectedSlide + 0.12, y: 0.22, w: 0.76, h: 0.46,
      frame: 'clean', radius: 12
    });
    keepClipInOneSlide(item);
    project.items.push(item);
    selectedItem = item.id;
    render();
    toast(`Video di ${Math.round(media.duration)}s inserito${media.duration > MAX_CLIP ? ` — nell'export ne useremo ${MAX_CLIP}` : ''}`);
  } catch (error) {
    toast(error.message === 'storage'
      ? 'I video servono spazio: apri l’app da localhost o dal sito, non come file'
      : 'Non riesco a leggere questo video');
  } finally {
    busyDone();
  }
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
  { id: 'bubbles-wide', name: 'Bolle sospese', desc: 'Cerchi e ellissi che scavalcano il confine tra una slide e l’altra.', scene: 'coast', color: '#22333d', slides: 4,
    build: s => [
      bgSpan(0, 4, s),
      shaped(0.58, 0.16, 0.72, 0.52, 'circle', s, 1),      // across the first seam
      shaped(0.18, 0.66, 0.34, 0.24, 'pill', s, 3),
      shaped(1.62, 0.34, 0.78, 0.46, 'circle', s, 4),      // across the second
      shaped(1.24, 0.1, 0.3, 0.21, 'circle', s, 2),
      shaped(2.66, 0.2, 0.68, 0.5, 'circle', s, 3),        // across the third
      shaped(3.3, 0.72, 0.42, 0.16, 'pill', s, 1)
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
      background-image:url('${srcOf(i)}');background-size:cover;background-position:center;
      border:${border}px solid ${spec.color};border-bottom-width:${spec.bottom > spec.border ? border * 3 : border}px;
      ${shapePreviewCSS(i)};box-shadow:${i.frame === 'none' ? 'none' : '0 3px 8px #0007'};transform:rotate(${i.rotation}deg)"></div>`;
  }).join('');
  return `<div style="position:absolute;top:0;left:${-offset * 100}%;width:${count * 100}%;height:100%">${shots}</div>`;
}

function templateCard(template) {
  const items = template.build(template.scene);
  const n = template.slides;
  const minis = Array.from({ length: n }, (_, k) =>
    `<div class="mini" style="background:${template.color}">${stripHTML(items, n, k)}</div>`).join('');
  return `<article class="layout-card">
    <div class="layout-strip tall" title="Le ${n} slide del carosello">${minis}</div>
    <div class="layout-meta"><span class="chip">${n} slide</span><span class="chip">${items.length} immagini</span></div>
    <footer><div><h3>${template.name}</h3><small>${template.desc}</small></div><button class="btn" data-template="${template.id}">Usa</button></footer>
  </article>`;
}

/* --------------------------------------------------- templates propri */

const MY_TEMPLATES = 'album-studio-templates';

const readMyTemplates = () => { try { return JSON.parse(localStorage.getItem(MY_TEMPLATES) || '[]'); } catch { return []; } };

// A template is the composition without the photographs: geometry, style and frames are kept, the
// images become empty frames. Small enough for localStorage, and reusable on any set of photos.
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
      src: itemKind(i) === 'image' || itemKind(i) === 'empty' ? scene : i.src,
      placeholder: false,
      demo: itemKind(i) === 'image' || itemKind(i) === 'empty' || undefined
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
  const frames = items.filter(i => i.demo).length;
  const minis = Array.from({ length: template.slides }, (_, k) =>
    `<div class="mini" style="background:${template.color}">${stripHTML(items, template.slides, k)}</div>`).join('');
  return `<article class="layout-card">
    <div class="layout-strip tall">${minis}</div>
    <div class="layout-meta"><span class="chip">${template.slides} slide</span><span class="chip">${frames} riquadri</span><span class="chip">${template.format}</span></div>
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
  let showing = false;         // only close what we actually opened
  try {
    const found = (await allProjects()).find(p => p.id === AUTOSAVE_ID);
    if (!found || !found.items?.length) return;   // nothing to restore: no indicator at all
    busy('Riprendo il lavoro…');
    showing = true;
    project = await absorbMedia(normalize(found));
    render();                       // the layout appears at once, pictures fill in as they arrive
    await primeMedia();
    project.id = found.savedAs || null;      // it is a working copy, not the named project
    applyFormat(project.format);
    selectedSlide = 0;
    selectedItem = null;
    fitZoom();
    toast('Ripreso il lavoro dell’ultima sessione');
  } catch { /* nothing to restore */ }
  finally { if (showing) busyDone(); }
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
  reader.onload = async () => {
    try {
      busy('Apro il backup…');
      project = await absorbMedia(normalize(JSON.parse(reader.result)));
      await primeMedia();
      busyDone();
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
  // A saved project stores media ids, not pictures: the cover has to be fetched from the store,
  // which is why putting the id straight into src showed a broken image.
  const coverOf = p => [...(p.items || [])].sort((a, b) => a.x - b.x).find(i => i.src || i.poster);
  grid.innerHTML = saved.map(p => {
    const cover = coverOf(p);
    const slides = p.slideCount || p.slides?.length || 0;
    return `<article class="project-card"><div class="project-art">${cover ? `<img data-cover="${p.id}" alt="">` : ''}<strong>${p.title || 'Album'}</strong></div>
      <footer><span>${slides} slide · ${new Date(p.updated).toLocaleDateString('it-IT')}</span>
      <span><button data-open="${p.id}">Apri</button><button class="del" data-del="${p.id}" title="Elimina il progetto">Elimina</button></span></footer></article>`;
  }).join('');
  for (const p of saved) {
    const cover = coverOf(p);
    const img = cover && $(`img[data-cover="${p.id}"]`);
    if (!img) continue;
    await primeMedia([cover]);
    const url = srcOf({ src: cover.poster }) || srcOf(cover);
    if (url) img.src = url; else img.remove();
  }
  $$('[data-open]').forEach(b => b.onclick = async () => {
    busy('Apro il progetto…');
    project = await absorbMedia(normalize(saved.find(p => p.id === b.dataset.open)));
    await primeMedia();
    busyDone();
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
  if (itemKind(item) === 'empty') { ctx.restore(); return; }
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
    const mediaW = image.naturalWidth || image.videoWidth || 1;
    const mediaH = image.naturalHeight || image.videoHeight || 1;
    const scale = Math.max(iw / mediaW, ih / mediaH) * (item.zoom / 100);
    const dw = mediaW * scale, dh = mediaH * scale;
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

// Reads one frame out of a video, for the cover picture and the two end previews.
// One hidden element does all the reading: a fresh <video> per frame re-loaded the whole clip every
// time, which is why the previews crawled. Calls are queued because they share that element.
let grabber = null;
let grabQueue = Promise.resolve();
const grabFrame = (item, at, maxSide = 0) => {
  const next = () => grabFrameNow(item, at, maxSide);
  grabQueue = grabQueue.then(next, next);
  return grabQueue;
};

async function grabFrameNow(item, at, maxSide = 0) {
  const url = srcOf(item);
  if (!url) return null;
  if (!grabber) {
    grabber = document.createElement('video');
    grabber.muted = true;
    grabber.playsInline = true;
    grabber.preload = 'auto';
  }
  const video = grabber;
  try {
    if (video.dataset.src !== url) {
      video.dataset.src = url;
      video.src = url;
    }
    // wait for pixels, not just for the header: with metadata alone the canvas comes out black
    await new Promise((resolve, reject) => {
      if (video.readyState >= 2) return resolve();
      video.onloadeddata = resolve;
      video.onerror = reject;
      setTimeout(reject, 10000);
    });
    const end = Math.max(0, (video.duration || 0) - 0.08);
    let target = Math.min(Math.max(at, 0), end);
    // seeking to where the video already is fires no 'seeked' — nudge it, or we wait for the timeout
    if (Math.abs(video.currentTime - target) < 0.01) target = target > 0.02 ? target - 0.01 : target + 0.01;
    await new Promise(resolve => {
      video.onseeked = resolve;
      video.currentTime = target;
      setTimeout(resolve, 4000);
    });
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    const scale = maxSide ? Math.min(1, maxSide / Math.max(w, h)) : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  } catch {
    return null;
  }
}

// Which container this browser can actually write. Instagram wants MP4/H.264: Chrome and Safari
// can, Firefox only offers WebM and there is no point pretending otherwise.
function recorderType() {
  if (typeof MediaRecorder === 'undefined') return null;
  const wanted = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm'
  ];
  return wanted.find(type => MediaRecorder.isTypeSupported(type)) || null;
}

// how long the recording of a slide will run
function clipSeconds(index) {
  const lead = project.items
    .filter(item => itemKind(item) === 'video' && item.x < index + 1 && item.x + item.w > index)
    .sort(readingOrder)[0];
  if (!lead) return 0;
  return clipWindow(lead).len;
}

const videoSlides = () => Array.from({ length: project.slideCount }, (_, i) => i)
  .filter(i => project.items.some(item => itemKind(item) === 'video' && item.x < i + 1 && item.x + item.w > i));

// Records one slide as a film: the slide is redrawn frame by frame with the videos running inside
// it, so photos, text, frames, shapes and filters all end up in the file. Real time, by necessity —
// MediaRecorder writes as it goes.
async function recordSlide(index, imageMap, onProgress) {
  const type = recorderType();
  if (!type) throw new Error('nessun formato video disponibile');

  const clips = project.items
    .filter(item => itemKind(item) === 'video' && item.x < index + 1 && item.x + item.w > index)
    .sort(readingOrder);
  const lead = clips[0];
  const seconds = Math.max(0.5, Math.min(lead.clip ?? MAX_CLIP, MAX_CLIP, (lead.duration || MAX_CLIP) - (lead.start || 0)));

  // one <video> per clip, all seeked to their starting point
  const players = await Promise.all(clips.map(async item => {
    const video = document.createElement('video');
    video.src = srcOf(item);
    video.muted = item !== lead || !item.audio;
    video.playsInline = true;
    video.preload = 'auto';
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('video non leggibile'));
      setTimeout(() => reject(new Error('timeout')), 20000);
    });
    await new Promise(resolve => {
      video.onseeked = resolve;
      video.currentTime = item.start || 0;
      setTimeout(resolve, 5000);
    });
    return { item, video };
  }));

  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext('2d');
  const fps = clamp(lead.fps || CLIP_FPS, 24, 60);
  const stream = canvas.captureStream(0);          // 0 = we decide when a frame is ready
  const [track] = stream.getVideoTracks();

  // the sound comes from the first clip, and only if you asked for it
  if (lead.audio && lead.hasAudio) {
    try {
      const leadPlayer = players.find(p => p.item === lead).video;
      const source = leadPlayer.captureStream ? leadPlayer.captureStream() : null;
      source?.getAudioTracks().forEach(track => stream.addTrack(track));
    } catch { /* silent export rather than no export */ }
  }

  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8e6 });
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };

  const frameMap = new Map(imageMap);
  players.forEach(({ item, video }) => frameMap.set(srcOf(item), video));   // draw the live frame

  const started = performance.now();
  recorder.start();
  await Promise.all(players.map(({ video }) => video.play().catch(() => {})));

  // A fixed timer, not requestAnimationFrame: rAF stops when the tab is hidden, which would leave
  // the recording hanging half way. The timer keeps drawing at the frame rate we asked for.
  await new Promise(resolve => {
    const timer = setInterval(() => {
      const elapsed = (performance.now() - started) / 1000;
      drawSlideOn(ctx, index, frameMap);
      track.requestFrame?.();                      // this drawing is the next frame of the film
      onProgress?.(Math.min(1, elapsed / seconds));
      if (elapsed >= seconds) { clearInterval(timer); resolve(); }
    }, 1000 / fps);
  });

  players.forEach(({ video }) => { video.pause(); });
  await new Promise(resolve => { recorder.onstop = resolve; recorder.stop(); });
  return { blob: new Blob(chunks, { type }), type };
}

// The still image behind every item. A video cannot be loaded into an <img>, so it is indexed by
// its own key but resolved to its cover frame; while recording, that entry is replaced by the live
// <video>, so the drawing code never needs to know the difference.
async function loadStills() {
  const seen = new Map();
  for (const item of project.items) {
    const key = srcOf(item);
    if (!key || seen.has(key)) continue;
    const url = itemKind(item) === 'video' ? posterOf(item) : key;
    if (!url) continue;
    try { seen.set(key, await loadImage(url)); } catch { /* a broken picture must not stop the export */ }
  }
  return seen;
}

async function drawSlide(index, imageMap) {
  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  drawSlideOn(canvas.getContext('2d'), index, imageMap);
  return canvas;
}

// The slide painted onto a context someone else owns — a still canvas for the PNG export, or the
// recording canvas, called again for every frame while a video plays.
function drawSlideOn(ctx, index, imageMap) {
  ctx.fillStyle = project.bgColor;
  ctx.fillRect(0, 0, OUT_W, OUT_H);
  const visible = project.items.filter(i => i.x < index + 1 && i.x + i.w > index);
  visible.forEach(i => drawItem(ctx, i, imageMap.get(srcOf(i)), index));
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
    await primeMedia();
    const imageMap = await loadStills();
    const movies = videoSlides();
    const codec = movies.length ? recorderType() : null;
    if (movies.length && !codec) {
      status.textContent = 'Questo browser non sa produrre video: le slide con video usciranno come immagini ferme.';
    }
    for (let index = 0; index < project.slideCount; index++) {
      if (movies.includes(index) && codec) {
        // a slide with video is recorded in real time: tell how long it will take
        const seconds = Math.round(clipSeconds(index));
        status.textContent = `Registro la slide ${pad(index)} (${seconds}s)…`;
        const { blob, type } = await recordSlide(index, imageMap, ratio => {
          status.textContent = `Registro la slide ${pad(index)} — ${Math.round(ratio * 100)}%`;
        });
        const still = await canvasBlob(await drawSlide(index, imageMap));
        exported.push({
          index, blob, url: URL.createObjectURL(blob), movie: true,
          poster: URL.createObjectURL(still),
          name: `album-slide-${pad(index)}.${type.includes('mp4') ? 'mp4' : 'webm'}`
        });
        continue;
      }
      const canvas = await drawSlide(index, imageMap);
      const blob = await canvasBlob(canvas);
      exported.push({ index, blob, url: URL.createObjectURL(blob), name: `album-slide-${pad(index)}.png` });
    }
    grid.innerHTML = exported.map(e => `<figure class="export-item${e.movie ? ' movie' : ''}">
      ${e.movie ? `<video src="${e.url}" muted playsinline controls poster="${e.poster || ''}"></video>`
                : `<img src="${e.url}" alt="Slide ${pad(e.index)}">`}
      <figcaption>${pad(e.index)}${e.movie ? ' · video' : ''}</figcaption>
      <a class="btn" href="${e.url}" download="${e.name}">Salva</a>
    </figure>`).join('');
    const films = exported.filter(e => e.movie).length;
    status.textContent = films
      ? `${exported.length} slide pronte a ${OUT_W}×${OUT_H}, di cui ${films} in video. Salvale una per una.`
      : `${exported.length} slide pronte a ${OUT_W}×${OUT_H}. Salvale una per una, oppure tienile premute per salvarle dal telefono.`;
    const files = exported.map(e => new File([e.blob], e.name, { type: 'image/png' }));
    if (navigator.canShare && navigator.canShare({ files })) {
      const share = $('#share-pngs');
      share.classList.remove('hidden');
      share.onclick = () => navigator.share({ files, title: project.title }).catch(() => {});
    }
  } catch (error) {
    status.textContent = `Non sono riuscito a completare l'esportazione: ${error.message || 'errore sconosciuto'}`;
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
    await primeMedia();
    const imageMap = await loadStills();
    const canvas = document.createElement('canvas');
    canvas.width = OUT_W * project.slideCount;
    canvas.height = OUT_H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = project.bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    project.items.forEach(item => drawItem(ctx, item, imageMap.get(srcOf(item)), 0));
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

async function downloadProject() {
  const portable = await withMediaInline(project);   // a backup has to travel with its pictures
  const blob = new Blob([JSON.stringify(portable, null, 2)], { type: 'application/json' });
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

// The zoom follows the window until you set it yourself: on load, on resize, when the phone is
// turned, when a panel opens. Measuring at startup alone was not enough — the stage has no real
// height yet at that point, so the strip came up at the minimum size.
let autoZoom = true;

function fitZoom({ auto = false } = {}) {
  const stage = $('#stage');
  const available = { w: stage.clientWidth, h: stage.clientHeight };
  if (!available.w || !available.h) return;        // layout not settled yet: a later measure will do it
  if (auto && !autoZoom) return;                   // you chose a zoom: leave it alone
  // Fill the height first — that is what makes the strip readable — but never so much that the
  // seam with the next slide falls out of view: keep at least 1.8 slides across. The paddings are
  // read from the scroller itself: guessing them left the strip a few pixels too tall, which showed
  // up as an unwanted vertical scroll.
  const scroller = $('#strip-scroll');
  const style = getComputedStyle(scroller);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const byHeight = (available.h - padY) * OUT_W / OUT_H;
  const byWidth = (available.w - padX) / Math.min(project.slideCount, 1.8);
  const next = clamp(Math.min(byHeight, byWidth), 110, 620);
  if (Math.abs(next - slideW) < 0.5) return;       // nothing to redraw
  slideW = next;
  render();
}

function watchStageSize() {
  const stage = $('#stage');
  if (typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(() => fitZoom({ auto: true })).observe(stage);
}

function bindRange(id, key, format) {
  const input = $(id);
  input.oninput = () => {
    const item = selected();
    if (!item) return;
    item[key] = +input.value;
    const out = $(`${id}-value`);
    if (out) out.value = format ? format(input.value) : input.value;
    restyleSelected();
  };
  input.onchange = () => { if (selected()) render(); };
}

// Repaints just the element you are editing. A full render rebuilds the strip, the slide
// thumbnails and both panels: at thirty slider events a second that is what made it stutter.
function restyleSelected() {
  const item = selected();
  if (!item) return;
  const node = $(`#strip .item[data-id="${item.id}"]`);
  if (!node) { render(); return; }
  styleItem(node, item, slideW);       // this covers text nodes too
  scheduleAutosave();
}

function init() {
  $('#add-bg').onchange = e => { readFiles(e.target.files, src => addItem(src, 'full')); e.target.value = ''; };
  $('#add-photo').onchange = e => { readFiles(e.target.files, src => addItem(src, 'free')); e.target.value = ''; };
  $('#add-color').onclick = addColourBlock;
  $('#add-video').onchange = e => { const file = e.target.files[0]; if (file) addVideoItem(file); e.target.value = ''; };
  // Only the value you are dragging changes. clipWindow() already stops the window running past
  // the end of the video, so there is no reason to touch the other slider.
  $('#video-start').oninput = e => { const i = selected(); if (i) { i.start = +e.target.value; showVideoReadout(i); } };
  $('#video-clip').oninput = e => { const i = selected(); if (i) { i.clip = +e.target.value; showVideoReadout(i); } };
  // the strip badge and the layer list read the length: refresh them once, on release
  $('#video-start').onchange = () => render();
  $('#video-clip').onchange = () => render();
  $('#video-audio').onchange = e => { const i = selected(); if (i) { pushUndo(); i.audio = e.target.checked; render(); } };
  $('#video-fps').onchange = e => { const i = selected(); if (i) { pushUndo(); i.fps = +e.target.value; renderInspector(); } };
  $('#video-play').onclick = () => {
    const i = selected();
    if (!i || itemKind(i) !== 'video') return;
    playingVideo = playingVideo === i.id ? null : i.id;
    renderInspector();
  };
  $('#video-cover').onclick = async () => {
    const i = selected();
    if (!i || itemKind(i) !== 'video') return;
    const blob = await grabFrame(i, i.start || 0);
    if (!blob) { toast('Non riesco a leggere quell’istante'); return; }
    pushUndo();
    const id = await putMedia(blob);
    mediaCache.set(id, mediaCache.get(id) || URL.createObjectURL(blob));
    i.poster = id;
    render();
    toast('Copertina aggiornata');
  };
  $('#auto-layout').onclick = () => $('#auto-files').click();
  $('#auto-files').onchange = e => { autoLayout(e.target.files); e.target.value = ''; };
  $('#add-text').onclick = addTextItem;

  $('#item-text').oninput = e => { const i = selected(); if (i) { i.text = e.target.value; restyleSelected(); } };
  $('#item-text').onchange = () => { if (selected()) render(); };
  // typing is one undo step per burst: a checkpoint before the first keystroke, not before each
  let lastTextUndo = 0;
  $('#item-text').addEventListener('beforeinput', () => {
    if (Date.now() - lastTextUndo > 1500) pushUndo();
    lastTextUndo = Date.now();
  });
  $('#item-font').onchange = e => { const i = selected(); if (i) { pushUndo(); i.font = e.target.value; render(); } };
  $('#item-text-color').oninput = e => { const i = selected(); if (i) { i.color = e.target.value; restyleSelected(); } };
  $('#item-size').oninput = e => { const i = selected(); if (i) { i.size = +e.target.value; $('#item-size-value').value = i.size; restyleSelected(); } };
  $('#item-size').onchange = () => { if (selected()) render(); };
  $('#item-text-bg').oninput = e => { const i = selected(); if (i) { i.fill = e.target.value; restyleSelected(); } };
  $('#item-text-bg-opacity').oninput = e => { const i = selected(); if (i) { i.fillOpacity = +e.target.value; $('#item-text-bg-opacity-value').value = i.fillOpacity; restyleSelected(); } };
  $('#item-text-bg-opacity').onchange = () => { if (selected()) render(); };
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
  $('#item-fill-color').oninput = e => { const i = selected(); if (i) { i.fill = e.target.value; restyleSelected(); } };

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
  $('#item-tint-color').oninput = e => { const i = selected(); if (i) { i.tintColor = e.target.value; restyleSelected(); } };
  $('#item-tint').oninput = e => { const i = selected(); if (i) { i.tintOpacity = +e.target.value; $('#item-tint-value').value = i.tintOpacity; restyleSelected(); } };
  $('#item-tint').onchange = () => { if (selected()) render(); };

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
      restyleSelected();
    };
    $(`#corner-${corner}`).onchange = () => { if (selected()) render(); };
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
    if (item) readFiles(e.target.files, src => { pushUndo(); item.src = src; item.demo = false; item.placeholder = false; delete item.fill; render(); toast('Immagine inserita'); });
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
  $('#zoom-in').onclick = () => { autoZoom = false; slideW = clamp(slideW * 1.15, 110, 620); render(); };
  $('#zoom-out').onclick = () => { autoZoom = false; slideW = clamp(slideW / 1.15, 110, 620); render(); };
  $('#zoom-fit').onclick = () => { autoZoom = true; fitZoom(); };
  $('#add-slide-here').onclick = () => changeSlideCount(1);

  $('#save-project').onclick = saveProject;
  $('#save-template').onclick = saveAsTemplate;
  $('#new-project').onclick = startNewProject;
  $('#new-project-panel').onclick = startNewProject;
  // the sheet: pull the panels up when the controls need more room than the strip
  $('#sheet-toggle').onclick = () => {
    const open = $('.workspace').classList.toggle('sheet-open');
    $('#sheet-toggle').textContent = open ? '▼' : '▲';
    $('#sheet-toggle').title = open ? 'Più spazio per la striscia' : 'Più spazio per i controlli';
    fitZoom({ auto: true });
  };
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

  window.addEventListener('resize', () => fitZoom({ auto: true }));

  applyFormat(project.format);
  watchStageSize();
  fitZoom();
  migrateLegacyStorage().then(restoreAutosave);
}

if (typeof document !== 'undefined') init();
if (typeof module !== 'undefined') module.exports = {
  remapAfterDelete, remapAfterMove, insideSlide, spanOf, fillOccupiedSlides, normalize,
  useIndexedDB, putProject, allProjects, deleteProject, storageModeNow: () => storageMode, mediaKey, isDirectSrc, clipWindow,
  keepClipInOneSlide, itemKind,
  setSlideCount: n => { project.slideCount = n; }
};

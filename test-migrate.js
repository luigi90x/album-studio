const assert = require('assert');

const store = new Map();
global.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
global.indexedDB = { open: () => ({ set onsuccess(_) {}, set onerror(_) {}, set onupgradeneeded(_) {}, set onblocked(_) {} }) };

const { normalize } = require('./app.js');

// v3 project: separate kinds, per-slide overlay, slides as an array
const v3 = {
  id: 'p1', title: 'Vecchio', bgColor: '#111111',
  slides: [
    { overlayColor: '#ff0000', overlayOpacity: 40 },
    { overlayColor: '#000000', overlayOpacity: 0 }
  ],
  items: [
    { id: 'a', kind: 'bg', src: 'bg.jpg', x: 0, y: 0, w: 2, h: 1, zoom: 100, panX: 50, panY: 50, rotation: 0, radius: 0, frame: 'none' },
    { id: 'b', kind: 'photo', src: 'p.jpg', x: 0.2, y: 0.2, w: 0.5, h: 0.4, zoom: 100, panX: 50, panY: 50, rotation: 0, radius: 12, frame: 'clean' }
  ]
};
let out = normalize(v3);
assert.strictEqual(out.slideCount, 2, 'the slides array becomes a count');
assert.strictEqual(out.slides, undefined, 'no slides array survives');
assert.ok(out.items.every(i => i.kind === undefined), 'the bg/photo distinction is gone');
const bottom = out.items[0];
assert.strictEqual(bottom.tintColor, '#ff0000', "the slide overlay moves onto the slide's bottom image");
assert.strictEqual(bottom.tintOpacity, 40);
assert.strictEqual(out.items[1].tintOpacity, 0, 'the images above keep no tint');

// a slide with no overlay leaves its images untouched
assert.ok(out.items.every(i => i.tintOpacity !== 0 || i === out.items[1] || i === bottom));

// v2 project: backgrounds / spans / per-slide photos
const v2 = {
  id: 'p0', backgroundColor: '#222222',
  backgrounds: [{ src: 'old-bg.jpg', start: 0, length: 2, zoom: 120, panY: 30 }],
  spans: [{ src: 'span.jpg', start: 0, length: 2, x: 10, y: 20, h: 50, frame: 'tape', radius: 8, rotation: 3 }],
  slides: [
    { overlayColor: '#00ff00', overlayOpacity: 25, photos: [{ src: 'ph.jpg', x: 10, y: 10, w: 40, h: 30, radius: 10, rotation: 0 }] },
    { overlayColor: '#000000', overlayOpacity: 0, photos: [] }
  ]
};
out = normalize(v2);
assert.strictEqual(out.slideCount, 2);
assert.strictEqual(out.bgColor, '#222222');
assert.strictEqual(out.items.length, 3, 'background, span and photo all become plain images');
assert.ok(out.items.every(i => i.kind === undefined));
assert.strictEqual(out.items[0].w, 2, 'the background keeps the slides it covered');
assert.strictEqual(out.items[0].tintColor, '#00ff00', 'its slide overlay became its tint');
assert.strictEqual(out.items[0].tintOpacity, 25);

// a current project passes through unchanged
const v4 = { id: 'p2', slideCount: 3, bgColor: '#000000', items: [{ id: 'z', src: 'x.jpg', x: 0, y: 0, w: 1, h: 1, tintColor: '#123456', tintOpacity: 10 }] };
out = normalize(v4);
assert.strictEqual(out.slideCount, 3);
assert.strictEqual(out.items[0].tintOpacity, 10);
assert.strictEqual(out.items[0].frame, 'clean', 'missing fields get filled with defaults');

console.log('migration OK');

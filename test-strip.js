const assert = require('assert');
const { remapAfterDelete, remapAfterMove, insideSlide, setSlideCount, spanOf, fillOccupiedSlides } = require('./app.js');

const item = (x, w) => ({ id: `${x}-${w}`, x, y: 0, w, h: 1 });
const at = (list, id) => list.find(i => i.id === id);

// how many slides an item touches
setSlideCount(4);
assert.strictEqual(spanOf(item(0, 1)), 1);
assert.strictEqual(spanOf(item(0.5, 1)), 2, 'straddling one seam touches two slides');
assert.strictEqual(spanOf(item(0.2, 2.6)), 3);
assert.strictEqual(spanOf(item(1, 3)), 3, 'flush multi-slide item counts exactly');

// deleting a slide: items on it disappear, later items shift left, crossing items shrink
let out = remapAfterDelete([item(0, 1), item(1, 1), item(2, 1), item(0.5, 2)], 1);
assert.strictEqual(at(out, '1-1'), undefined, 'item on the deleted slide is gone');
assert.strictEqual(at(out, '2-1').x, 1, 'later item shifts left');
assert.strictEqual(at(out, '0-1').x, 0, 'earlier item stays');
assert.strictEqual(at(out, '0.5-2').w, 1, 'crossing item loses one slide of width');

// a crossing item never collapses below the minimum width
out = remapAfterDelete([item(0.9, 0.2)], 0);
assert.ok(at(out, '0.9-0.2').w >= 0.08);

// moving a slide swaps only the items fully inside the two slides
out = remapAfterMove([item(0, 1), item(1, 1), item(0.5, 1)], 0, 1);
assert.strictEqual(at(out, '0-1').x, 1, 'item follows its slide');
assert.strictEqual(at(out, '1-1').x, 0, 'item of the target slide comes back');
assert.strictEqual(at(out, '0.5-1').x, 0.5, 'item on the seam stays put');

assert.strictEqual(insideSlide(item(1, 1), 1), true);
assert.strictEqual(insideSlide(item(0.9, 1), 1), false);

// "Riempi" snaps to whatever the item already covers: one slide, or all the ones it straddles
setSlideCount(4);
let box = { x: 0.2, y: 0.3, w: 0.5, h: 0.4 };
fillOccupiedSlides(box);
assert.deepStrictEqual(box, { x: 0, y: 0, w: 1, h: 1 }, 'inside one slide → fills that slide');

box = { x: 0.6, y: 0.3, w: 0.9, h: 0.4 };
fillOccupiedSlides(box);
assert.deepStrictEqual(box, { x: 0, y: 0, w: 2, h: 1 }, 'across two slides → fills both');

box = { x: 0.5, y: 0.2, w: 2.1, h: 0.4 };
fillOccupiedSlides(box);
assert.deepStrictEqual(box, { x: 0, y: 0, w: 3, h: 1 }, 'across three slides → fills all three');

box = { x: 2.4, y: 0.2, w: 0.3, h: 0.4 };
fillOccupiedSlides(box);
assert.deepStrictEqual(box, { x: 2, y: 0, w: 1, h: 1 }, 'fills the slide it is actually on');


// The window a clip plays: a zero-length one made the player snap back instead of running.
{
  const { clipWindow } = require('./app.js');
  const w = clipWindow({ start: 2, clip: 3, duration: 10 });
  assert.deepStrictEqual([w.from, w.to, w.len], [2, 5, 3], 'finestra semplice');
  assert.strictEqual(clipWindow({ start: 8, clip: 30, duration: 10 }).len, 2, 'non oltre la fine del video');
  assert.strictEqual(clipWindow({ duration: 40 }).len, 30, 'senza scelta vale il massimo');
  assert.ok(clipWindow({ start: 0, clip: 0, duration: 5 }).len > 0, 'mai lunga zero');
}

console.log('strip geometry OK');

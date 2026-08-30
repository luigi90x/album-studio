const assert = require('assert');

// A browser-ish environment where IndexedDB never answers — exactly what a file:// page sees.
const store = new Map();
global.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: k => store.delete(k)
};
global.indexedDB = { open: () => ({ set onsuccess(_) {}, set onerror(_) {}, set onupgradeneeded(_) {}, set onblocked(_) {} }) };

const { useIndexedDB, putProject, allProjects, deleteProject, storageModeNow, mediaKey, isDirectSrc } = require('./app.js');

(async () => {
  assert.strictEqual(await useIndexedDB(), false, 'a silent IndexedDB must not be used');
  assert.strictEqual(storageModeNow(), 'local');

  await putProject({ id: 'a', title: 'Primo', updated: 1 });
  await putProject({ id: 'b', title: 'Secondo', updated: 2 });
  assert.deepStrictEqual((await allProjects()).map(p => p.id).sort(), ['a', 'b']);

  await putProject({ id: 'a', title: 'Primo aggiornato', updated: 3 });
  const list = await allProjects();
  assert.strictEqual(list.length, 2, 'saving again updates in place, it does not duplicate');
  assert.strictEqual(list.find(p => p.id === 'a').title, 'Primo aggiornato');

  await deleteProject('a');
  assert.deepStrictEqual((await allProjects()).map(p => p.id), ['b']);

  // a full disk surfaces as a quota error the UI can explain, not a silent loss
  global.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  await assert.rejects(() => putProject({ id: 'c', updated: 4 }), /quota/);

    // media keys are content based: the same bytes must land on the same key, different bytes must not
  const key = await mediaKey(new Blob([new Uint8Array([1, 2, 3, 4, 5])]));
  const same = await mediaKey(new Blob([new Uint8Array([1, 2, 3, 4, 5])]));
  const other = await mediaKey(new Blob([new Uint8Array([1, 2, 3, 4, 6])]));
  assert.strictEqual(key, same, 'the same picture stored twice must reuse one entry');
  assert.notStrictEqual(key, other, 'different pictures must not collide');

  // a project can still carry plain data URLs from before the media store existed
  assert.ok(isDirectSrc('data:image/png;base64,AAAA'));
  assert.ok(isDirectSrc('blob:http://x/y'));
  assert.ok(!isDirectSrc('9f2b1c4d'), 'a media id is not a direct source');

  console.log('storage fallback OK');
})();

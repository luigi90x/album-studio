// Bundles index.html + styles.css + app.js into one self-contained file.
//
//   node build.js          -> album-studio.html   single file, copy it anywhere (no manifest)
//   node build.js --web    -> docs/               what GitHub Pages serves: bundle + manifest +
//                                                 service worker + icons, installable and offline
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const forWeb = process.argv.includes('--web');

let html = read('index.html')
  .replace('<link rel="stylesheet" href="styles.css" />', () => `<style>\n${read('styles.css')}\n</style>`)
  .replace('<script src="app.js"></script>', () => `<script>\n${read('app.js')}\n</script>`);

if (html.includes('styles.css') || html.includes('app.js')) {
  console.error('Qualcosa non è stato incorporato: controlla i tag in index.html');
  process.exit(1);
}

if (!forWeb) {
  fs.writeFileSync(path.join(root, 'album-studio.html'), html);
  console.log(`album-studio.html — ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, nessun file esterno`);
  return;
}

// served from a real address it can be installed and cached for offline use
html = html
  .replace('</head>', `  <link rel="manifest" href="manifest.webmanifest" />
  <link rel="apple-touch-icon" href="icon-192.png" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
</head>`)
  .replace('</body>', `  <script>
    if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  </script>
</body>`);

const docs = path.join(root, 'docs');
fs.mkdirSync(docs, { recursive: true });
fs.writeFileSync(path.join(docs, 'index.html'), html);
for (const asset of fs.readdirSync(path.join(root, 'web'))) {
  fs.copyFileSync(path.join(root, 'web', asset), path.join(docs, asset));
}
console.log(`docs/ — index.html ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB + ${fs.readdirSync(path.join(root, 'web')).length} file statici`);

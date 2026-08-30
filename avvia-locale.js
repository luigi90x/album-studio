// Serves the app from http://localhost and opens the browser on it.
//
//   node avvia-locale.js          serve la cartella docs/ (la versione compilata)
//   node avvia-locale.js --src    serve i sorgenti, per lavorarci
//
// Perché non basta aprire il file: da file:// Chrome non concede IndexedDB, e l'app ripiega su
// localStorage, circa 5 MB in tutto. localhost è considerato sicuro quanto https, quindi da qui
// lo spazio torna quello vero e l'app si comporta come la versione pubblicata.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = Number(process.argv.find(a => /^\d+$/.test(a)) || 8080);
const root = path.join(__dirname, process.argv.includes('--src') ? '.' : 'docs');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error(`Non trovo index.html in ${root}. Esegui prima: node build.js --web`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const asked = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, asked === '/' ? 'index.html' : asked);
  // never serve outside the folder, whatever the request says
  if (!file.startsWith(root)) { res.writeHead(403); res.end('no'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Non trovato'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`La porta ${PORT} è occupata. Prova: node avvia-locale.js 8090`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`Album Studio è su ${url}`);
  console.log(`Cartella servita: ${root}`);
  console.log('Lascia questa finestra aperta mentre lavori. Ctrl+C per chiudere.');
  const open = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(open, () => {});
});

// One command to put a new version online:
//
//   node publish.js "messaggio del commit"
//
// It runs the tests, bumps the service-worker cache (without it phones keep serving the old copy
// from cache), rebuilds docs/, then commits and pushes.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const run = (cmd, quiet) => execSync(cmd, { cwd: root, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
const step = message => console.log(`\n▸ ${message}`);

const commitMessage = process.argv.slice(2).join(' ') || 'Aggiorna Album Studio';

step('Test');
for (const test of ['test-strip.js', 'test-storage.js', 'test-migrate.js']) run(`node ${test}`);

step('Versione della cache offline');
const swPath = path.join(root, 'web', 'sw.js');
const sw = fs.readFileSync(swPath, 'utf8');
const current = sw.match(/album-studio-v(\d+)/);
if (!current) {
  console.error('Non trovo la versione in web/sw.js');
  process.exit(1);
}
const next = Number(current[1]) + 1;
fs.writeFileSync(swPath, sw.replace(/album-studio-v\d+/g, `album-studio-v${next}`));
console.log(`  v${current[1]} → v${next}`);

step('Build');
run('node build.js');
run('node build.js --web');

step('Git');
const status = run('git status --porcelain', true);
if (!status.trim()) {
  console.log('  Niente da pubblicare: nessun file cambiato.');
  process.exit(0);
}
console.log(status.trim().split('\n').map(line => `  ${line}`).join('\n'));
run('git add -A');
run(`git commit -m "${commitMessage.replace(/"/g, "'")}"`);
run('git push');

step('Fatto');
console.log('  Il sito si aggiorna in un paio di minuti. Sul telefono, chiudi e riapri l\'app:');
console.log('  il nuovo service worker sostituisce la copia in cache al secondo avvio.');

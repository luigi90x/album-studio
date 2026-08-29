# Album Studio

Editor di caroselli fotografici che funziona **interamente sul dispositivo**: nessun account, nessun
upload, nessuna dipendenza. Le foto non lasciano mai il telefono o il computer.

**App online:** https://luigi90x.github.io/album-studio/ — apribile da telefono e installabile
("Aggiungi a schermata Home"), funziona anche senza rete.

## L'idea

Le slide del carosello sono affiancate su una **striscia continua**. Un'immagine che supera il
confine finisce su due slide, e l'export la taglia esattamente dove serve: ricomposta su Instagram
torna continua. Non esistono "sfondi" e "miniature" come cose diverse — c'è un solo tipo di
elemento (immagine, riquadro di colore o testo) e l'ordine nella pila decide cosa sta dietro.

- formati 4:5, 1:1, 9:16 per tutto il carosello
- trascina, ridimensiona e ruota, con aggancio ai bordi degli altri elementi
- testo con caratteri di sistema, stili e fascia di sfondo
- annulla/ripristina, salvataggio automatico, backup JSON
- export PNG una slide alla volta, o condivisione di gruppo dal telefono

## Struttura

| | |
|---|---|
| `index.html`, `app.js`, `styles.css` | i sorgenti su cui si lavora |
| `web/` | manifest, service worker e icone della versione installabile |
| `docs/` | **quello che GitHub Pages pubblica** — generato, non modificare a mano |
| `test-*.js` | verifiche eseguibili con Node, senza framework |
| `build.js`, `publish.js` | compilazione e pubblicazione |

## Comandi

```bash
node build.js          # album-studio.html: un file solo, da copiare ovunque
node build.js --web    # docs/: la versione pubblicata (bundle + manifest + service worker)
node publish.js "cosa è cambiato"   # test, bump cache, build, commit e push
```

I test si lanciano anche singolarmente:

```bash
node test-strip.js     # geometria della striscia: span, riempimento, sposta/elimina slide
node test-storage.js   # IndexedDB con fallback a localStorage, e limite di spazio
node test-migrate.js   # apertura dei progetti salvati con i formati precedenti
```

## Sviluppo

Aprire `index.html` in un browser è sufficiente: non serve alcun build per provare le modifiche.
Il build serve solo per distribuire un file unico o pubblicare.

Nota: aperta come file locale (`file://`) l'app non può usare IndexedDB — Chrome non lo concede — e
ripiega su `localStorage`, circa 5 MB. Servita da un indirizzo (come GitHub Pages) usa IndexedDB e
lo spazio non è più un problema.

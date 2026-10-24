/**
 * Kopiert das Frontend aus app/static/ in die Capacitor-Web-Assets (www/)
 * und prüft vorher, dass alle Versionsangaben zusammenpassen.
 *
 *   node scripts/build-www.js           Prüfen + kopieren   (npm run build:www)
 *   node scripts/build-www.js --check   Nur prüfen, auch ob www/ aktuell ist (CI)
 */
const fs = require('fs');
const path = require('path');
const { ROOT, checkVersions } = require('./lib/versions');

const STATIC_DIR = path.join(ROOT, 'app', 'static');
const WWW_DIR = path.join(ROOT, 'www');

/** Ziel → Quelle. index.html liegt in www/ oben, alles andere unter www/static/. */
function copyPlan() {
    const plan = [];
    for (const name of fs.readdirSync(STATIC_DIR)) {
        if (name === 'index.html') continue;
        plan.push({ src: path.join(STATIC_DIR, name), dst: path.join(WWW_DIR, 'static', name) });
    }
    plan.push({ src: path.join(STATIC_DIR, 'index.html'), dst: path.join(WWW_DIR, 'index.html') });
    // app.js lädt tariffs.json als letzten Fallback relativ zur Seite, also auch aus www/ selbst.
    plan.push({ src: path.join(STATIC_DIR, 'tariffs.json'), dst: path.join(WWW_DIR, 'tariffs.json') });
    return plan;
}

function sameContent(a, b) {
    if (!fs.existsSync(b)) return false;
    if (fs.statSync(a).isDirectory()) {
        return fs.readdirSync(a).every((n) => sameContent(path.join(a, n), path.join(b, n)));
    }
    return fs.readFileSync(a).equals(fs.readFileSync(b));
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function buildWww({ checkOnly = false } = {}) {
    const { version, versionCode, errors } = checkVersions();
    if (errors.length) {
        const err = new Error(
            'Versionsangaben passen nicht zusammen:\n  - ' + errors.join('\n  - ') +
            '\nTipp: "npm run bump <version>" setzt alle Stellen auf einmal.'
        );
        err.code = 'VERSION_MISMATCH';
        throw err;
    }
    console.log(`Version ${version} (versionCode ${versionCode}) ist überall gleich.`);

    const plan = copyPlan();
    if (checkOnly) {
        const stale = plan.filter(({ src, dst }) => !sameContent(src, dst));
        if (stale.length) {
            const err = new Error(
                'www/ ist nicht aktuell:\n  - ' + stale.map(({ dst }) => rel(dst)).join('\n  - ') +
                '\nTipp: "npm run build:www" ausführen.'
            );
            err.code = 'WWW_STALE';
            throw err;
        }
        console.log('www/ entspricht app/static/.');
    } else {
        for (const { src, dst } of plan) {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.cpSync(src, dst, { recursive: true });
        }
        console.log(`${plan.length} Dateien nach www/ kopiert.`);
    }

    const known = new Set(plan.map(({ dst }) => path.basename(dst)));
    const extra = fs.readdirSync(path.join(WWW_DIR, 'static')).filter((n) => !known.has(n));
    if (extra.length) {
        console.warn(`Hinweis: in www/static/ liegen Dateien ohne Gegenstück in app/static/: ${extra.join(', ')}`);
    }
    const rootTariffs = path.join(ROOT, 'tariffs.json');
    if (fs.existsSync(rootTariffs) && !sameContent(rootTariffs, path.join(STATIC_DIR, 'tariffs.json'))) {
        console.warn('Hinweis: tariffs.json (vom Tarif-Workflow gepflegt) weicht von app/static/tariffs.json ab.');
    }
    return { version, versionCode };
}

if (require.main === module) {
    try {
        buildWww({ checkOnly: process.argv.includes('--check') });
    } catch (err) {
        console.error(`FEHLER: ${err.message}`);
        process.exit(1);
    }
}

module.exports = { buildWww };

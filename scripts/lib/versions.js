/**
 * Alle Stellen, an denen die Version von EV Charge Live steht.
 * Gemeinsame Basis für build-www.js, bump-version.js und build-apk.js.
 *
 * Maßgeblich ist config.yaml (Add-on-Version); alle anderen Stellen müssen dazu passen.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

const FILES = {
    config: 'config.yaml',
    pkg: 'package.json',
    lock: 'package-lock.json',
    gradle: 'android/app/build.gradle',
    index: 'app/static/index.html',
};

// Jede Regex hat genau drei Gruppen: Präfix, Wert, Suffix – ersetzt wird nur der Wert.
const PATTERNS = {
    config: /^(version:\s*")([^"]*)(")/m,
    pkg: /^( {2}"version":\s*")([^"]*)(")/m,
    lockTop: /^( {2}"version":\s*")([^"]*)(")/m,
    lockRoot: /("packages":\s*\{\s*"":\s*\{[^}]*?"version":\s*")([^"]*)(")/,
    gradleName: /(versionName\s+")([^"]*)(")/,
    gradleCode: /(versionCode\s+)(\d+)()/,
    badge: /(<span class="badge-app-version">v)([^<]*)(<\/span>)/g,
    appJs: /(static\/app\.js\?v=)([^"'&]*)()/g,
    styleCss: /(static\/style\.css\?v=)([^"'&]*)()/g,
};

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readFile(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function allMatches(text, re) {
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    return [...text.matchAll(new RegExp(re.source, flags))].map((m) => m[2]);
}

/** Liest alle Versionsangaben ein: [{ where, value }] plus versionCode. */
function readVersions() {
    const config = readFile(FILES.config);
    const pkg = readFile(FILES.pkg);
    const lock = JSON.parse(readFile(FILES.lock));
    const gradle = readFile(FILES.gradle);
    const index = readFile(FILES.index);

    const entries = [];
    const add = (where, value) => entries.push({ where, value });

    add(`${FILES.config} (version)`, (config.match(PATTERNS.config) || [])[2]);
    add(`${FILES.pkg} (version)`, JSON.parse(pkg).version);
    add(`${FILES.lock} (version)`, lock.version);
    add(`${FILES.lock} (packages[""].version)`, lock.packages && lock.packages[''] && lock.packages[''].version);
    add(`${FILES.gradle} (versionName)`, (gradle.match(PATTERNS.gradleName) || [])[2]);
    allMatches(index, PATTERNS.badge).forEach((v, i) => add(`${FILES.index} (badge-app-version #${i + 1})`, v));
    allMatches(index, PATTERNS.appJs).forEach((v) => add(`${FILES.index} (static/app.js?v=)`, v));
    allMatches(index, PATTERNS.styleCss).forEach((v) => add(`${FILES.index} (static/style.css?v=)`, v));

    const codeMatch = gradle.match(PATTERNS.gradleCode);
    return {
        version: entries[0].value,
        versionCode: codeMatch ? Number(codeMatch[2]) : NaN,
        entries,
        counts: {
            badge: allMatches(index, PATTERNS.badge).length,
            appJs: allMatches(index, PATTERNS.appJs).length,
        },
    };
}

/** versionName/versionCode aus dem letzten Commit – null, wenn git nicht verfügbar ist. */
function readGradleFromHead() {
    try {
        const text = execFileSync('git', ['show', `HEAD:${FILES.gradle}`], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const name = (text.match(PATTERNS.gradleName) || [])[2];
        const code = Number((text.match(PATTERNS.gradleCode) || [])[2]);
        return name && Number.isInteger(code) ? { name, code } : null;
    } catch (err) {
        return null;
    }
}

/** Prüft, dass alle Versionsangaben zusammenpassen. Liefert { version, versionCode, errors }. */
function checkVersions() {
    const info = readVersions();
    const errors = [];

    if (!info.version || !VERSION_RE.test(info.version)) {
        errors.push(`${FILES.config}: keine gültige Version gefunden ("${info.version}")`);
    }
    for (const { where, value } of info.entries.slice(1)) {
        if (value !== info.version) {
            errors.push(`${where} = "${value}", erwartet "${info.version}"`);
        }
    }
    if (info.counts.badge === 0) errors.push(`${FILES.index}: kein <span class="badge-app-version"> gefunden`);
    if (info.counts.appJs === 0) errors.push(`${FILES.index}: kein static/app.js?v= gefunden`);

    if (!Number.isInteger(info.versionCode) || info.versionCode < 1) {
        errors.push(`${FILES.gradle}: versionCode fehlt oder ist ungültig`);
    } else {
        const head = readGradleFromHead();
        if (head && info.versionCode < head.code) {
            errors.push(`${FILES.gradle}: versionCode ${info.versionCode} ist kleiner als im letzten Commit (${head.code})`);
        } else if (head && head.name !== info.version && info.versionCode <= head.code) {
            errors.push(
                `${FILES.gradle}: Version ${head.name} → ${info.version}, aber versionCode ist noch ${info.versionCode} ` +
                `(muss größer als ${head.code} sein – "npm run bump ${info.version}" erledigt das)`
            );
        }
    }

    return { version: info.version, versionCode: info.versionCode, errors };
}

/** Ersetzt in einer Datei den Wert-Teil aller Treffer; Zeilenenden bleiben unverändert. */
function replaceInFile(rel, re, value, { min = 1 } = {}) {
    const text = readFile(rel);
    let hits = 0;
    const out = text.replace(re, (all, pre, _old, post) => {
        hits += 1;
        return `${pre}${value}${post}`;
    });
    if (hits < min) {
        throw new Error(`${rel}: Muster ${re} nicht gefunden`);
    }
    if (out !== text) fs.writeFileSync(path.join(ROOT, rel), out);
    return hits;
}

/** Setzt alle Versionsangaben auf newVersion. versionCode wird bei Versionswechsel um 1 erhöht. */
function bumpVersion(newVersion, { versionCode } = {}) {
    if (!VERSION_RE.test(newVersion)) {
        throw new Error(`"${newVersion}" ist keine gültige Version (erwartet z. B. 1.3.19)`);
    }
    const before = readVersions();
    const gradleName = (readFile(FILES.gradle).match(PATTERNS.gradleName) || [])[2];
    let code = before.versionCode;
    if (versionCode !== undefined) {
        code = versionCode;
    } else if (gradleName !== newVersion) {
        code = before.versionCode + 1;
    }
    if (!Number.isInteger(code) || code < 1) {
        throw new Error(`ungültiger versionCode: ${code}`);
    }

    replaceInFile(FILES.config, PATTERNS.config, newVersion);
    replaceInFile(FILES.pkg, PATTERNS.pkg, newVersion);
    replaceInFile(FILES.lock, PATTERNS.lockTop, newVersion);
    replaceInFile(FILES.lock, PATTERNS.lockRoot, newVersion);
    replaceInFile(FILES.gradle, PATTERNS.gradleName, newVersion);
    replaceInFile(FILES.gradle, PATTERNS.gradleCode, String(code));
    replaceInFile(FILES.index, PATTERNS.badge, newVersion);
    replaceInFile(FILES.index, PATTERNS.appJs, newVersion);
    replaceInFile(FILES.index, PATTERNS.styleCss, newVersion, { min: 0 });

    return { from: before.version, fromCode: before.versionCode, to: newVersion, toCode: code };
}

module.exports = { ROOT, FILES, VERSION_RE, readVersions, checkVersions, bumpVersion };

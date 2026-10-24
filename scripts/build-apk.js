/**
 * Baut die Debug-APK: build:www → cap sync → Gradle assembleDebug
 * und legt das Ergebnis als dist/ev-charge-live-v<version>.apk ab.
 *
 *   npm run apk
 *
 * Voraussetzungen: JDK 17+ (JAVA_HOME) und Android SDK (ANDROID_HOME oder android/local.properties).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT } = require('./lib/versions');
const { buildWww } = require('./build-www');

const ANDROID_DIR = path.join(ROOT, 'android');
const APK_OUT = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const DIST_DIR = path.join(ROOT, 'dist');
const IS_WIN = process.platform === 'win32';

function run(command, cwd) {
    console.log(`\n> ${command}`);
    // Feste Kommandozeilen ohne Benutzereingaben; die Shell löst npx.cmd / gradlew.bat unter Windows auf.
    const res = spawnSync(command, { cwd, stdio: 'inherit', shell: true });
    if (res.status !== 0) {
        throw new Error(`"${command}" ist fehlgeschlagen (Exit-Code ${res.status}).`);
    }
}

function checkAndroidSdk() {
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    if (sdk && fs.existsSync(sdk)) return;
    if (fs.existsSync(path.join(ANDROID_DIR, 'local.properties'))) return;
    throw new Error(
        'Android SDK nicht gefunden. ANDROID_HOME setzen (z. B. F:\\KI-Workspace\\apps\\AndroidSdk) ' +
        'oder android/local.properties mit sdk.dir=... anlegen.'
    );
}

function main() {
    checkAndroidSdk();
    const { version } = buildWww();

    run('npx cap sync android', ROOT);
    // Expliziter Pfad: cmd.exe sucht nicht immer im aktuellen Verzeichnis und fände sonst ein fremdes gradlew.bat im PATH.
    run(IS_WIN ? '.\\gradlew.bat assembleDebug' : './gradlew assembleDebug', ANDROID_DIR);

    if (!fs.existsSync(APK_OUT)) {
        throw new Error(`Gradle hat keine APK erzeugt (${APK_OUT} fehlt).`);
    }
    fs.mkdirSync(DIST_DIR, { recursive: true });
    const target = path.join(DIST_DIR, `ev-charge-live-v${version}.apk`);
    fs.copyFileSync(APK_OUT, target);
    const mb = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
    console.log(`\nAPK fertig: ${path.relative(ROOT, target)} (${mb} MB)`);
}

try {
    main();
} catch (err) {
    console.error(`FEHLER: ${err.message}`);
    process.exit(1);
}

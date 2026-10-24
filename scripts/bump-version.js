/**
 * Setzt die Version an allen Stellen auf einmal und aktualisiert danach www/.
 *
 *   npm run bump 1.3.19                  versionCode wird um 1 erhöht
 *   npm run bump -- 1.3.19 --code 30     versionCode explizit setzen
 *
 * Betroffen: config.yaml, package.json, package-lock.json, android/app/build.gradle
 * (versionName/versionCode), badge-app-version-Badges und ?v=-Cache-Busting in index.html.
 */
const { bumpVersion } = require('./lib/versions');
const { buildWww } = require('./build-www');

function main(argv) {
    const args = argv.slice(2);
    const codeIdx = args.indexOf('--code');
    let versionCode;
    if (codeIdx !== -1) {
        versionCode = Number(args[codeIdx + 1]);
        args.splice(codeIdx, 2);
    }
    if (args.length !== 1) {
        throw new Error('Aufruf: npm run bump <version>   (z. B. npm run bump 1.3.19)');
    }

    const r = bumpVersion(args[0], { versionCode });
    console.log(`Version ${r.from} → ${r.to}, versionCode ${r.fromCode} → ${r.toCode}`);
    buildWww();
    console.log(`Nächste Schritte: Änderungen committen, "npm run apk" für die APK, scripts/deploy-ha.sh für Home Assistant.`);
}

try {
    main(process.argv);
} catch (err) {
    console.error(`FEHLER: ${err.message}`);
    process.exit(1);
}

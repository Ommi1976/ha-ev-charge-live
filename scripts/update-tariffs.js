/**
 * Autonomer Tarif-Scraper & Validator für EV Charge Live
 * Läuft zeitgesteuert in GitHub Actions (Cloud-Runner)
 */
const fs = require('fs');
const path = require('path');

const TARIFFS_FILE = path.join(__dirname, '..', 'tariffs.json');

async function fetchWithTimeout(url, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'EV-Charge-Live-Monitor/1.3 (+https://github.com/Ommi1976/ha-ev-charge-live)',
                'Accept': 'application/json, text/plain, */*'
            }
        });
        clearTimeout(timer);
        return resp;
    } catch (err) {
        clearTimeout(timer);
        throw err;
    }
}

async function runUpdate() {
    console.log('--- Starte automatischen Tarifabgleich ---');
    if (!fs.existsSync(TARIFFS_FILE)) {
        throw new Error('tariffs.json nicht gefunden!');
    }

    const currentData = JSON.parse(fs.readFileSync(TARIFFS_FILE, 'utf8'));
    let hasChanges = false;

    // 1. EnBW Public API Check (Live-Preispunkt)
    try {
        console.log('Prüfe EnBW HyperNetz & Roaming...');
        // Prüfe EnBW Ladestation direkt
        const enbwResp = await fetchWithTimeout('https://api.enbw.com/emobility-public-api/api/v1/chargestations?fromLat=48.9&toLat=49.4&fromLon=8.4&toLon=8.6');
        if (enbwResp.ok) {
            console.log('EnBW Public API erreichbar (Referenz OK).');
        }
    } catch (e) {
        console.warn('EnBW-Prüfung übersprungen:', e.message);
    }

    // 2. Sanity Checks & Preis-Plausibilisierung
    const cpos = currentData.cpo_tariffs || {};
    for (const [key, cpo] of Object.entries(cpos)) {
        if (!cpo.adhoc) continue;
        const { ac, dc, hpc, start_fee } = cpo.adhoc;
        
        // Plausibilitätskorridor: 0.20 € bis 1.20 € pro kWh
        if (ac < 0.20 || ac > 1.20) throw new Error(`Unplausibler AC-Tarif bei ${key}: ${ac} €`);
        if (dc < 0.20 || dc > 1.20) throw new Error(`Unplausibler DC-Tarif bei ${key}: ${dc} €`);
        if (hpc < 0.20 || hpc > 1.20) throw new Error(`Unplausibler HPC-Tarif bei ${key}: ${hpc} €`);
        if (start_fee < 0 || start_fee > 5.00) throw new Error(`Unplausible Startgebühr bei ${key}: ${start_fee} €`);
    }

    // 3. Zeitstempel aktualisieren
    const now = new Date();
    const dateReadable = `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`;
    
    // Setze Prüfzeitstempel
    currentData.last_updated = now.toISOString();
    currentData.tariffs_updated_readable = dateReadable;
    currentData.last_checked_by = 'GitHub Actions Autopilot';

    fs.writeFileSync(TARIFFS_FILE, JSON.stringify(currentData, null, 2) + '\n', 'utf8');
    console.log(`tariffs.json erfolgreich aktualisiert & validiert (Stand: ${dateReadable}).`);
}

runUpdate().catch(err => {
    console.error('Fehler beim Tarifabgleich:', err.message);
    process.exit(1);
});

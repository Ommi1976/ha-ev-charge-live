const test = require("node:test");
const assert = require("node:assert/strict");

/* ==========================================================================
   Helper-Funktionen extrahiert aus app/static/app.js zur direkten Verifikation
   ========================================================================== */

function decodeDisplaySoc(hexVal) {
    const raw = parseInt(hexVal, 16);
    if (isNaN(raw)) return null;
    return Math.min(100, Math.max(0, raw <= 100 ? raw : Math.round(raw / 2.55)));
}

function decodeBattTemp(hexVal) {
    const raw = parseInt(hexVal, 16);
    if (isNaN(raw)) return null;
    return raw - 40;
}

function decode12vVolts(hexVal) {
    const raw = parseInt(hexVal, 16);
    if (isNaN(raw)) return null;
    return Number((raw / 10.0).toFixed(1));
}

function decodePlugStatus(hexVal) {
    const statusByte = parseInt(hexVal, 16);
    if (isNaN(statusByte)) return null;
    const isConnected = (statusByte & 0x01) !== 0;
    const isLocked = (statusByte & 0x02) !== 0;
    const isCharging = (statusByte & 0x04) !== 0;
    let label = "Nicht angesteckt";
    if (isCharging) label = "Lädt aktiv";
    else if (isLocked) label = "Verriegelt (bereit)";
    else if (isConnected) label = "Angesteckt";
    return { isConnected, isLocked, isCharging, label };
}

function calculateClientBlockingDeadline(startDate, freeMinutes, nightStartHour = 21, nightEndHour = 9, hasNightRule = true) {
    let curr = new Date(startDate.getTime());
    let remainingMins = Math.max(0, freeMinutes);
    if (!hasNightRule || remainingMins <= 0) {
        return new Date(curr.getTime() + remainingMins * 60000);
    }
    while (remainingMins > 0) {
        const h = curr.getHours();
        const isNight = (nightStartHour > nightEndHour) ? (h >= nightStartHour || h < nightEndHour) : (h >= nightStartHour && h < nightEndHour);
        if (isNight) {
            if (h >= nightStartHour) {
                curr.setDate(curr.getDate() + 1);
                curr.setHours(nightEndHour, 0, 0, 0);
            } else {
                curr.setHours(nightEndHour, 0, 0, 0);
            }
        } else {
            const nightToday = new Date(curr.getTime());
            nightToday.setHours(nightStartHour, 0, 0, 0);
            const minsUntilNight = Math.floor((nightToday.getTime() - curr.getTime()) / 60000);
            if (minsUntilNight <= 0) {
                curr.setHours(nightStartHour, 0, 0, 0);
                continue;
            }
            if (remainingMins <= minsUntilNight) {
                curr = new Date(curr.getTime() + remainingMins * 60000);
                remainingMins = 0;
            } else {
                remainingMins -= minsUntilNight;
                curr = nightToday;
            }
        }
    }
    return curr;
}

function parsePairingPayload(rawText) {
    const clean = String(rawText || "").trim();
    try {
        if (clean.startsWith("{") && clean.endsWith("}")) {
            const parsed = JSON.parse(clean);
            if (parsed && (parsed.type === "ha_pairing" || parsed.ha_url || parsed.ha_token)) {
                return {
                    isPairing: true,
                    url: String(parsed.ha_url || "").trim(),
                    token: String(parsed.ha_token || "").trim()
                };
            }
        } else if (clean.startsWith("evcharge://pair") || clean.includes("pair?url=")) {
            const urlObj = new URL(clean.replace("evcharge://", "http://"));
            const url = urlObj.searchParams.get("url") || "";
            const token = urlObj.searchParams.get("token") || "";
            if (url) {
                return { isPairing: true, url, token };
            }
        }
    } catch (e) {}
    return { isPairing: false, url: "", token: "" };
}

/* ==========================================================================
   Test Suiten
   ========================================================================== */

test("UDS Telemetrie: Display SoC Decodierung", () => {
    // Standard Prozentwerte (0-100)
    assert.equal(decodeDisplaySoc("00"), 0);
    assert.equal(decodeDisplaySoc("32"), 50);
    assert.equal(decodeDisplaySoc("50"), 80);
    assert.equal(decodeDisplaySoc("64"), 100);

    // Byte-Werte (101-255 skaliert auf 2.55)
    assert.equal(decodeDisplaySoc("C8"), 78); // 200 / 2.55 = 78.43 -> 78
    assert.equal(decodeDisplaySoc("FF"), 100); // 255 / 2.55 = 100

    // Ungültige Werte
    assert.equal(decodeDisplaySoc("ZZ"), null);
});

test("UDS Telemetrie: Akkutemperatur Offset -40°C", () => {
    assert.equal(decodeBattTemp("28"), 0);   // 40 - 40 = 0°C
    assert.equal(decodeBattTemp("3C"), 20);  // 60 - 40 = 20°C
    assert.equal(decodeBattTemp("4B"), 35);  // 75 - 40 = 35°C
    assert.equal(decodeBattTemp("19"), -15); // 25 - 40 = -15°C
});

test("UDS Telemetrie: 12V Bordnetz-Spannung", () => {
    assert.equal(decode12vVolts("7C"), 12.4); // 124 / 10 = 12.4V
    assert.equal(decode12vVolts("82"), 13.0); // 130 / 10 = 13.0V
    assert.equal(decode12vVolts("8F"), 14.3); // 143 / 10 = 14.3V (Lichtmaschine / DC-DC aktiv)
});

test("UDS Telemetrie: Ladekabel & Stecker-Bitmaske", () => {
    // 0x00: Unplugged
    const s0 = decodePlugStatus("00");
    assert.equal(s0.isConnected, false);
    assert.equal(s0.isLocked, false);
    assert.equal(s0.isCharging, false);
    assert.equal(s0.label, "Nicht angesteckt");

    // 0x01: Angesteckt, nicht verriegelt
    const s1 = decodePlugStatus("01");
    assert.equal(s1.isConnected, true);
    assert.equal(s1.isLocked, false);
    assert.equal(s1.isCharging, false);
    assert.equal(s1.label, "Angesteckt");

    // 0x03: Angesteckt & Verriegelt (bereit)
    const s3 = decodePlugStatus("03");
    assert.equal(s3.isConnected, true);
    assert.equal(s3.isLocked, true);
    assert.equal(s3.isCharging, false);
    assert.equal(s3.label, "Verriegelt (bereit)");

    // 0x07: Lädt aktiv (Bit 0 + Bit 1 + Bit 2)
    const s7 = decodePlugStatus("07");
    assert.equal(s7.isConnected, true);
    assert.equal(s7.isLocked, true);
    assert.equal(s7.isCharging, true);
    assert.equal(s7.label, "Lädt aktiv");
});

test("Park-Wächter: Deadline-Berechnung mit Nachtruhe-Regel", () => {
    // 1. Tag-Laden ohne Nachtüberschreitung: Start 10:00, 240 Min. (4 Std.) -> 14:00
    const startDay = new Date(2026, 9, 21, 10, 0, 0); // 21. Okt 2026, 10:00
    const endDay = calculateClientBlockingDeadline(startDay, 240);
    assert.equal(endDay.getHours(), 14);
    assert.equal(endDay.getDate(), 21);

    // 2. Abend-Laden mit Nachtruhe (21:00 - 09:00): Start 19:00, 240 Min. (4 Std.)
    // 19:00 bis 21:00 = 2 Std. verbraucht, 2 Std. verbleiben.
    // Pause über Nacht, Weiterlauf ab 09:00 -> Deadline = 11:00 am Folgetag!
    const startEvening = new Date(2026, 9, 21, 19, 0, 0);
    const endEvening = calculateClientBlockingDeadline(startEvening, 240, 21, 9, true);
    assert.equal(endEvening.getDate(), 22);
    assert.equal(endEvening.getHours(), 11);
    assert.equal(endEvening.getMinutes(), 0);

    // 3. Ohne Nachtruhe (hasNightRule = false): Start 19:00, 240 Min. -> 23:00 am selben Tag
    const endNoNight = calculateClientBlockingDeadline(startEvening, 240, 21, 9, false);
    assert.equal(endNoNight.getDate(), 21);
    assert.equal(endNoNight.getHours(), 23);
});

test("Home Assistant 1-Klick Pairing: Payload-Erkennung", () => {
    // Valides JSON-Pairing
    const jsonStr = JSON.stringify({
        type: "ha_pairing",
        version: 1,
        ha_url: "http://homeassistant.local:8123",
        ha_token: "secret_token_123"
    });
    const parsedJson = parsePairingPayload(jsonStr);
    assert.equal(parsedJson.isPairing, true);
    assert.equal(parsedJson.url, "http://homeassistant.local:8123");
    assert.equal(parsedJson.token, "secret_token_123");

    // Valides URI-Scheme
    const uriStr = "evcharge://pair?url=https%3A%2F%2Fnabu.casa&token=token_xyz";
    const parsedUri = parsePairingPayload(uriStr);
    assert.equal(parsedUri.isPairing, true);
    assert.equal(parsedUri.url, "https://nabu.casa");
    assert.equal(parsedUri.token, "token_xyz");

    // Regulärer Säulen-QR-Code (kein HA-Pairing)
    const evseQr = "https://ladeapp.de/de/station/DE*SWH*E000123";
    const parsedEvse = parsePairingPayload(evseQr);
    assert.equal(parsedEvse.isPairing, false);
});

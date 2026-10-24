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

// Getestete Logik wird direkt aus app/static/app.js geladen (keine Kopie), damit der Test den echten Code prüft
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const APP_JS = fs.readFileSync(path.join(__dirname, "..", "app", "static", "app.js"), "utf8");
const CONTRACT = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "bridge_contract.json"), "utf8"));

function pickFunction(name) {
    const startIdx = APP_JS.indexOf(`function ${name}(`);
    assert.ok(startIdx >= 0, `${name} nicht in app.js gefunden`);
    // Skip the parameter list (may contain default objects like "= {}") before the body starts
    let parens = 0;
    let i = APP_JS.indexOf("(", startIdx);
    for (; i < APP_JS.length; i++) {
        if (APP_JS[i] === "(") parens++;
        else if (APP_JS[i] === ")" && --parens === 0) break;
    }
    let depth = 0;
    for (i = APP_JS.indexOf("{", i); i < APP_JS.length; i++) {
        if (APP_JS[i] === "{") depth++;
        else if (APP_JS[i] === "}" && --depth === 0) return APP_JS.slice(startIdx, i + 1);
    }
    throw new Error(`${name}: Funktionsende nicht gefunden`);
}

function pickConst(name) {
    const match = APP_JS.match(new RegExp(`^const ${name} = .*;$`, "m"));
    assert.ok(match, `Konstante ${name} nicht in app.js gefunden`);
    return match[0];
}

function loadFromAppJs({ consts = [], functions = [], globals = {} }) {
    const code = [...consts.map(pickConst), ...functions.map(pickFunction)].join("\n");
    const ctx = { ...globals };
    vm.runInNewContext(`${code}\n${functions.map(n => `this.${n} = ${n};`).join("\n")}`, ctx);
    return ctx;
}

// Objects from the vm realm have foreign prototypes; compare plain JSON
const plain = (value) => JSON.parse(JSON.stringify(value));

const { calculateClientBlockingDeadline, isNightHour } = loadFromAppJs({
    functions: ["isNightHour", "nextAtHour", "calculateClientBlockingDeadline"]
});

const haBridge = loadFromAppJs({
    consts: ["HA_BRIDGE_ENTITY", "HA_BRIDGE_PROTOCOL", "HA_BRIDGE_STALE_MS", "HA_VIA_SUFFIX", "HA_STATION_KEYS", "HA_LIVE_KEYS"],
    functions: [
        "normalizeHaBaseUrl", "describeHaHttpError", "formatSinceDuration", "parseHaBridgeState",
        "mergeHaBridgeStations", "reconcileChargeSession", "compactStationForHa", "buildHaCommand", "findHaCommandAck"
    ],
    globals: { URL }
});

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

test("Park-Wächter: keine Endlosschleife bei ungewöhnlichen Nachtfenstern", () => {
    const start = new Date(2026, 9, 21, 10, 0, 0);

    // Nachtfenster innerhalb eines Tages (01-05 Uhr): Start 10:00 + 240 Min. -> 14:00
    const inDay = calculateClientBlockingDeadline(start, 240, 1, 5, true);
    assert.equal(inDay.getDate(), 21);
    assert.equal(inDay.getHours(), 14);

    // Start 23:00, 240 Min. bei Nacht 01-05: 23:00-01:00 = 120 Min., Pause, ab 05:00 Rest 120 -> 07:00
    const lateStart = new Date(2026, 9, 21, 23, 0, 0);
    const across = calculateClientBlockingDeadline(lateStart, 240, 1, 5, true);
    assert.equal(across.getDate(), 22);
    assert.equal(across.getHours(), 7);

    // Gleiche Start-/Endstunde = keine Nachtregel (früher Endlosschleife)
    const same = calculateClientBlockingDeadline(start, 90, 0, 0, true);
    assert.equal(same.getHours(), 11);
    assert.equal(same.getMinutes(), 30);

    // Ungültige Werte frieren die App nicht ein
    const bad = calculateClientBlockingDeadline(start, 60, "x", undefined, true);
    assert.equal(bad.getHours(), 11);

    assert.equal(isNightHour(23, 21, 9), true);
    assert.equal(isNightHour(12, 21, 9), false);
    assert.equal(isNightHour(3, 1, 5), true);
    assert.equal(isNightHour(10, 1, 5), false);
    assert.equal(isNightHour(0, 0, 0), false);
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

/* ==========================================================================
   APK unterwegs: Verbindung zum Add-on über die HA-REST-API (Bridge-Sensor + Events)
   ========================================================================== */

test("APK → HA: kein Aufruf des nicht existierenden hassio_ingress-Pfads mehr", () => {
    assert.equal(APP_JS.includes("hassio_ingress"), false);
    assert.ok(APP_JS.includes("/api/states/${HA_BRIDGE_ENTITY}"));
    assert.ok(APP_JS.includes("/api/events/${HA_COMMAND_EVENT}"));
});

test("APK → HA: Server-URL wird auf den Origin normalisiert", () => {
    const { normalizeHaBaseUrl } = haBridge;
    assert.equal(normalizeHaBaseUrl("http://homeassistant.local:8123/"), "http://homeassistant.local:8123");
    assert.equal(normalizeHaBaseUrl(" https://abc123.ui.nabu.casa/lovelace/0 "), "https://abc123.ui.nabu.casa");
    assert.equal(normalizeHaBaseUrl("https://user:pw@ha.example.org"), "https://ha.example.org");
    assert.equal(normalizeHaBaseUrl("homeassistant.local:8123"), "");
    assert.equal(normalizeHaBaseUrl("javascript:alert(1)"), "");
    assert.equal(normalizeHaBaseUrl(""), "");
    assert.equal(normalizeHaBaseUrl(null), "");
});

test("APK → HA: Watchlist-Befehl entspricht dem Vertrag des Add-ons", () => {
    const { buildHaCommand } = haBridge;
    // Same fixture is executed by the add-on in tests/test_bridge.py
    const cmd = buildHaCommand("watchlist_add", { station: CONTRACT.apk_station }, "apk_test_1");
    assert.deepEqual(plain(cmd), CONTRACT.apk_command);

    const session = { station_id: "s1", start_time_ms: 1792850400000 };
    const sessionCmd = plain(buildHaCommand("session_start", { session }, "apk_x"));
    assert.deepEqual(sessionCmd, { protocol: 1, action: "session_start", request_id: "apk_x", session });
    assert.deepEqual(plain(buildHaCommand("sync", {}, "apk_y")), { protocol: 1, action: "sync", request_id: "apk_y" });
});

test("APK → HA: Bridge-Sensor des Add-ons wird gelesen (Favoriten, Watchlist, Lade-Wächter, Quittung)", () => {
    const { parseHaBridgeState, findHaCommandAck } = haBridge;
    const state = CONTRACT.bridge_state;
    const nowMs = 1792854000000 + 65 * 60000;
    const snap = parseHaBridgeState(state, nowMs);

    assert.deepEqual(plain(snap.favorites.map(s => s.id)), ["DE*SWH*E1001"]);
    assert.deepEqual(plain(snap.watchlist.map(s => s.id)), ["DE*SWH*E1001", "DE*EBW*E2002"]);
    const pumpwerk = snap.favorites[0];
    assert.equal(pumpwerk.free_slots, 1);
    assert.equal(pumpwerk.live_source, "EnBW Echtzeit");
    // "vor X Min." is derived locally from updated_at (not stored in HA to avoid recorder churn)
    assert.equal(pumpwerk.connectors[1].duration_str, "vor 1 Std. 5 Min.");
    assert.equal(pumpwerk.connectors[0].duration_str, "vor 5 Min.");
    assert.equal(snap.session.deadline_ms, 1792864800000);
    assert.equal(snap.session.station_name, "Hockenheim Pumpwerk");
    assert.equal(snap.reportedAt, Date.parse(state.last_reported));
    assert.equal(snap.truncated, false);

    const ack = findHaCommandAck(snap, "apk_test_1");
    assert.equal(ack.ok, true);
    assert.equal(findHaCommandAck(snap, "apk_unknown"), null);
});

test("APK → HA: ungültige oder fremde Sensor-Daten werden verworfen", () => {
    const { parseHaBridgeState } = haBridge;
    const state = CONTRACT.bridge_state;
    assert.equal(parseHaBridgeState(null), null);
    assert.equal(parseHaBridgeState({ ...state, entity_id: "sensor.other" }), null);
    assert.equal(parseHaBridgeState({ ...state, attributes: { ...state.attributes, protocol: 2 } }), null);
    assert.equal(parseHaBridgeState({ entity_id: state.entity_id }), null);

    const junk = parseHaBridgeState({
        entity_id: state.entity_id,
        attributes: {
            protocol: 1,
            stations: [null, "x", { name: "ohne id" }, { id: 7, connectors: "kaputt" }],
            favorite_ids: [7, "fehlt"],
            watch_ids: "nein",
            session: "x",
            recent_commands: [null, { request_id: "a" }]
        }
    });
    assert.deepEqual(plain(junk.favorites), [{ id: "7", connectors: [] }]);
    assert.deepEqual(plain(junk.watchlist), []);
    assert.equal(junk.session, null);
    assert.equal(junk.recentCommands.length, 1);
    assert.equal(junk.reportedAt, null);
});

test("APK → HA: Kartendaten zeigen für überwachte Säulen den Add-on-Stand", () => {
    const { parseHaBridgeState, mergeHaBridgeStations } = haBridge;
    const reportedAt = Date.parse(CONTRACT.bridge_state.last_reported);
    const snap = parseHaBridgeState(CONTRACT.bridge_state, reportedAt);
    const direct = [
        { ...CONTRACT.apk_station, free_slots: 2, status: "AVAILABLE" },
        { id: "DE*XYZ*E9", name: "Fremd", free_slots: 3, total_slots: 3, live_source: "MobiData BW" }
    ];

    const merged = plain(mergeHaBridgeStations(direct, snap, reportedAt + 60000));
    assert.equal(merged[0].free_slots, 1);
    assert.equal(merged[0].status, "PARTIAL");
    assert.equal(merged[0].is_favorite, true);
    assert.equal(merged[0].is_watched, true);
    assert.equal(merged[0].live_source, "EnBW Echtzeit · via Home Assistant");
    assert.equal(merged[1].free_slots, 3);
    assert.equal(merged[1].is_favorite, false);
    assert.equal(merged[1].live_source, "MobiData BW");

    // Suffix is not stacked when merged data is merged again
    const relabeled = { ...snap, favorites: [{ ...snap.favorites[0], live_source: merged[0].live_source }] };
    assert.equal(plain(mergeHaBridgeStations(merged, relabeled, reportedAt))[0].live_source, "EnBW Echtzeit · via Home Assistant");

    // Stale add-on data (> 5 min without report) does not override the fresher direct search
    const stale = plain(mergeHaBridgeStations(direct, snap, reportedAt + 10 * 60000));
    assert.equal(stale[0].free_slots, 2);
    assert.equal(stale[0].is_watched, true);

    // Direct search empty (offline MobiData): monitored stations stay visible
    const fallback = plain(mergeHaBridgeStations([], snap, reportedAt));
    assert.deepEqual(fallback.map(s => s.id).sort(), ["DE*EBW*E2002", "DE*SWH*E1001"]);
    assert.deepEqual(plain(mergeHaBridgeStations(direct, null)), plain(direct));
});

test("APK → HA: Lade-Wächter-Abgleich mit dem Add-on", () => {
    const { reconcileChargeSession } = haBridge;
    const remote = { station_id: "s1", start_time_ms: 1, deadline_ms: 2 };
    assert.deepEqual(plain(reconcileChargeSession(null, remote)), { ...remote, ha_synced: true });
    // Stopped in HA/Ingress: confirmed local session is removed
    assert.equal(reconcileChargeSession({ ...remote, ha_synced: true }, null), null);
    // Not yet confirmed by the add-on (offline start): local session stays and gets re-sent
    const pending = { station_id: "s2", start_time_ms: 3 };
    assert.equal(reconcileChargeSession(pending, remote), pending);
    assert.equal(reconcileChargeSession(pending, null), pending);
    assert.equal(reconcileChargeSession(null, null), null);
});

test("APK → HA: Zeitangaben und Fehlermeldungen", () => {
    const { formatSinceDuration, describeHaHttpError } = haBridge;
    const now = Date.UTC(2026, 9, 23, 18, 0, 0);
    assert.equal(formatSinceDuration(now - 12 * 60000, now), "vor 12 Min.");
    assert.equal(formatSinceDuration(String(now - 125 * 60000), now), "vor 2 Std. 5 Min.");
    assert.equal(formatSinceDuration(new Date(now - 60000).toISOString(), now), "vor 1 Min.");
    assert.equal(formatSinceDuration(now + 60000, now), "vor 0 Min.");
    assert.equal(formatSinceDuration(null, now), null);
    assert.equal(formatSinceDuration("kaputt", now), null);

    assert.match(describeHaHttpError(401), /Token/);
    assert.match(describeHaHttpError(404), /Add-on-Sensor/);
    assert.match(describeHaHttpError(0), /nicht erreichbar/);
    assert.match(describeHaHttpError(500), /HTTP 500/);
});

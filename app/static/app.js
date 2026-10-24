// Determine Ingress base path dynamically
const getApiUrl = (endpoint) => {
    let path = window.location.pathname;
    if (path.endsWith('.html') || path.endsWith('.htm')) {
        path = path.substring(0, path.lastIndexOf('/') + 1);
    } else if (!path.endsWith('/')) {
        path += '/';
    }
    return `${path}${endpoint.replace(/^\//, '')}`;
};

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
    if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) return 999999;
    const r = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return r * c;
}

const escapeHtml = (unsafe) => {
    if (unsafe === null || unsafe === undefined) return "";
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
};

// For JS string literals inside HTML attributes (onclick="fn('...')"): emit only JS hex escapes,
// so no HTML entity (e.g. "&#39;") can be decoded back into a quote before the JS is parsed.
const escapeJsString = (unsafe) => {
    if (unsafe === null || unsafe === undefined) return "";
    return String(unsafe)
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\x27")
        .replace(/"/g, "\\x22")
        .replace(/&/g, "\\x26")
        .replace(/</g, "\\x3C")
        .replace(/>/g, "\\x3E")
        .replace(/\r|\n|\u2028|\u2029/g, " ");
};

const isFavorite = (stationId) => {
    if (!stationId || !Array.isArray(favorites)) return false;
    return favorites.some(f => String(f.id) === String(stationId));
};
window.isFavorite = isFavorite;

const isWatched = (stationId) => {
    if (!stationId || !Array.isArray(watchlist)) return false;
    return watchlist.some(w => String(w.id) === String(stationId));
};
window.isWatched = isWatched;

async function nativeHttpFetch(url, options = {}) {
    const headers = options.headers || {};
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
        try {
            const res = await window.Capacitor.Plugins.CapacitorHttp.request({
                url: url,
                method: options.method || "GET",
                headers: headers,
                data: options.body || undefined
            });
            let parsedData = res.data;
            if (typeof parsedData === "string") {
                try { parsedData = JSON.parse(parsedData); } catch (e) {}
            }
            return {
                ok: res.status >= 200 && res.status < 300,
                status: res.status,
                json: async () => parsedData,
                text: async () => (typeof res.data === "string" ? res.data : JSON.stringify(res.data))
            };
        } catch (e) {
            console.warn("CapacitorHttp request failed, fallback to fetch", e);
        }
    }
    const browserHeaders = { ...headers };
    if (!window.Capacitor || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) {
        delete browserHeaders["Origin"];
        delete browserHeaders["Referer"];
        delete browserHeaders["User-Agent"];
    }
    return fetch(url, { ...options, headers: browserHeaders });
}

const sanitizeHttpUrl = (rawUrl, fallback = "#") => {
    if (!rawUrl || typeof rawUrl !== "string") return fallback;
    try {
        const parsed = new URL(rawUrl.trim(), window.location.origin);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
            return parsed.href;
        }
    } catch (e) {
        // invalid URL
    }
    return fallback;
};

/* ==========================================================================
   APK unterwegs: Verbindung zum Add-on nur über die offizielle HA-REST-API
   - Lesen:   GET  {HA}/api/states/sensor.ev_charge_live_bridge (vom Add-on gepflegt)
   - Befehle: POST {HA}/api/events/ev_charge_live_command (Add-on quittiert per request_id)
   Das Add-on selbst ist nur per Ingress erreichbar: Ingress-URLs enthalten einen zufälligen
   Session-Token, ein Long-Lived-Token reicht dafür nicht.
   ========================================================================== */
const HA_BRIDGE_ENTITY = "sensor.ev_charge_live_bridge";
const HA_COMMAND_EVENT = "ev_charge_live_command";
// Created by the add-on; lets non-admin tokens send commands (HA allows events only for admins)
const HA_COMMAND_SCRIPT = "ev_charge_live_command";
const HA_BRIDGE_PROTOCOL = 1;
const HA_BRIDGE_CACHE_MS = 5000;
const HA_BRIDGE_RETRY_MS = 30000;
const HA_BRIDGE_STALE_MS = 5 * 60 * 1000;
const HA_VIA_SUFFIX = " · via Home Assistant";
const HA_STATION_KEYS = ["id", "name", "operator", "address", "postal_code", "city", "latitude", "longitude", "total_slots", "free_slots", "occupied_slots", "status", "status_text", "live_source", "connectors", "enbw_station_id"];
const HA_LIVE_KEYS = ["total_slots", "free_slots", "occupied_slots", "status", "status_text"];

let haBridgeCache = { fetchedAt: 0, snapshot: null, error: "", promise: null };
// After a 401 on a read the token is not retried automatically: HA's IP ban counts failed logins
const haAuthState = { failedToken: "" };
// Token that may read but not fire events (non-admin): commands go through the script
const haCommandState = { scriptToken: "" };
let haSessionPushInFlight = false;

const isNativeApp = () => Boolean(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform());

function normalizeHaBaseUrl(rawUrl) {
    try {
        const parsed = new URL(String(rawUrl || "").trim());
        return (parsed.protocol === "https:" || parsed.protocol === "http:") ? parsed.origin : "";
    } catch (e) {
        return "";
    }
}

function getHaRemoteConfig() {
    const url = normalizeHaBaseUrl(localStorage.getItem("ev_ha_server_url") || currentConfig.ha_server_url);
    const token = String(localStorage.getItem("ev_ha_token") || "").trim();
    return url && token ? { url, token } : null;
}

// APK with HA URL + token: favorites, watchlist and Lade-Wächter live in the add-on
const useHaRemote = () => isNativeApp() && Boolean(getHaRemoteConfig());

function resetHaBridgeCache() {
    haBridgeCache = { fetchedAt: 0, snapshot: null, error: "", promise: null };
    haAuthState.failedToken = "";
    haCommandState.scriptToken = "";
}

function describeHaHttpError(status) {
    if (status === 401) return "Token ungültig oder abgelaufen";
    if (status === 403) return "Zugriff von Home Assistant verweigert";
    if (status === 404) return "Add-on-Sensor fehlt – läuft EV Charge Live ab v1.3.21?";
    return status ? `Home Assistant antwortet mit HTTP ${status}` : "Home Assistant nicht erreichbar";
}

// Token-authenticated HA REST call. In the APK via native HTTP: needs no CORS entry in HA.
async function haRequest(path, { method = "GET", body, timeoutMs = 6000, ha = getHaRemoteConfig() } = {}) {
    if (!ha) return null;
    if (ha.token === haAuthState.failedToken) return { ok: false, status: 401, data: null };
    const headers = { "Authorization": `Bearer ${ha.token}`, "Accept": "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let result;
    const capHttp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    if (capHttp && isNativeApp()) {
        const res = await capHttp.request({
            url: ha.url + path, method, headers, data: body, connectTimeout: timeoutMs, readTimeout: timeoutMs
        });
        let data = res.data;
        if (typeof data === "string") {
            try { data = JSON.parse(data); } catch (e) {}
        }
        result = { ok: res.status >= 200 && res.status < 300, status: res.status, data };
    } else {
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
        try {
            const resp = await fetch(ha.url + path, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: controller ? controller.signal : undefined
            });
            let data = null;
            try { data = await resp.json(); } catch (e) {}
            result = { ok: resp.ok, status: resp.status, data };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    // Only a rejected read proves the token invalid; POST /api/events also answers 401 for non-admins
    if (result.status === 401 && method === "GET") haAuthState.failedToken = ha.token;
    return result;
}

// Admin tokens fire the event directly; other tokens call the add-on's script (non-admins may call services)
async function postHaCommand(command, ha = getHaRemoteConfig()) {
    if (!ha) return null;
    if (haCommandState.scriptToken !== ha.token) {
        const res = await haRequest(`/api/events/${HA_COMMAND_EVENT}`, { method: "POST", body: command, ha });
        if (!res || res.status !== 401) return res;
        haCommandState.scriptToken = ha.token;
    }
    const res = await haRequest(`/api/services/script/${HA_COMMAND_SCRIPT}`, { method: "POST", body: command, ha });
    return res ? { ...res, viaScript: true } : res;
}

function describeHaCommandError(res) {
    if (res && res.viaScript && res.status === 400) {
        return `Token ohne Admin-Rechte und Skript script.${HA_COMMAND_SCRIPT} fehlt – Add-on ab v1.3.21 starten oder Admin-Token nutzen`;
    }
    return describeHaHttpError(res ? res.status : 0);
}

// Mirrors the add-on's "vor X Min." for connectors (the bridge omits it to avoid recorder churn)
function formatSinceDuration(updatedAt, nowMs) {
    const raw = String(updatedAt ?? "");
    const ms = typeof updatedAt === "number" ? updatedAt : (/^\d+$/.test(raw) ? Number(raw) : Date.parse(raw));
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const totalMins = Math.max(0, Math.floor((nowMs - ms) / 60000));
    const hours = Math.floor(totalMins / 60);
    return hours > 0 ? `vor ${hours} Std. ${totalMins % 60} Min.` : `vor ${totalMins} Min.`;
}

// Validates the bridge sensor state (HA REST JSON) into { favorites, watchlist, session, ... }
function parseHaBridgeState(stateObj, nowMs = Date.now()) {
    if (!stateObj || typeof stateObj !== "object" || stateObj.entity_id !== HA_BRIDGE_ENTITY) return null;
    const attrs = stateObj.attributes;
    if (!attrs || typeof attrs !== "object" || Number(attrs.protocol) !== HA_BRIDGE_PROTOCOL) return null;

    const byId = new Map();
    (Array.isArray(attrs.stations) ? attrs.stations : []).forEach(st => {
        if (!st || typeof st !== "object" || st.id === undefined || st.id === null) return;
        const connectors = (Array.isArray(st.connectors) ? st.connectors : [])
            .filter(c => c && typeof c === "object")
            .map(c => {
                const dur = c.duration_str || formatSinceDuration(c.updated_at, nowMs);
                return dur ? { ...c, duration_str: dur } : { ...c };
            });
        byId.set(String(st.id), { ...st, id: String(st.id), connectors });
    });
    const pick = (ids) => (Array.isArray(ids) ? ids : [])
        .map(id => byId.get(String(id)))
        .filter(Boolean)
        .map(st => ({ ...st }));
    const reportedAt = Date.parse(stateObj.last_reported || stateObj.last_updated || "");

    return {
        favorites: pick(attrs.favorite_ids),
        watchlist: pick(attrs.watch_ids),
        session: attrs.session && typeof attrs.session === "object" ? { ...attrs.session } : null,
        recentCommands: Array.isArray(attrs.recent_commands) ? attrs.recent_commands.filter(c => c && typeof c === "object") : [],
        truncated: Boolean(attrs.truncated),
        reportedAt: Number.isFinite(reportedAt) ? reportedAt : null
    };
}

// Direct search results + add-on data: monitored stations show the add-on's debounced live state,
// so map, HA sensors and push notifications agree.
function mergeHaBridgeStations(stations, snapshot, nowMs = Date.now()) {
    const list = Array.isArray(stations) ? stations : [];
    if (!snapshot) return list;
    const favIds = new Set(snapshot.favorites.map(s => String(s.id)));
    const watchIds = new Set(snapshot.watchlist.map(s => String(s.id)));
    const monitored = new Map([...snapshot.favorites, ...snapshot.watchlist].map(s => [String(s.id), s]));
    const flag = (st) => ({ ...st, is_favorite: favIds.has(String(st.id)), is_watched: watchIds.has(String(st.id)) });

    // Direct search failed (offline MobiData etc.): show at least the monitored stations
    if (list.length === 0) return [...monitored.values()].map(flag);

    const fresh = !snapshot.reportedAt || nowMs - snapshot.reportedAt <= HA_BRIDGE_STALE_MS;
    return list.map(st => {
        const out = flag(st);
        const live = fresh ? monitored.get(String(st.id)) : null;
        if (live && Number.isFinite(Number(live.total_slots))) {
            HA_LIVE_KEYS.forEach(k => { if (live[k] !== undefined) out[k] = live[k]; });
            if (Array.isArray(live.connectors) && live.connectors.length > 0) out.connectors = live.connectors;
            out.live_source = String(live.live_source || "Add-on").replace(HA_VIA_SUFFIX, "") + HA_VIA_SUFFIX;
        }
        return out;
    });
}

// Unconfirmed local session wins (pending hand-over); otherwise the add-on's Lade-Wächter is the truth
function reconcileChargeSession(local, remote) {
    if (local && !local.ha_synced) return local;
    return remote ? { ...remote, ha_synced: true } : null;
}

function compactStationForHa(st) {
    const out = {};
    HA_STATION_KEYS.forEach(k => {
        if (st[k] !== undefined && st[k] !== null) out[k] = st[k];
    });
    if (Array.isArray(out.connectors)) out.connectors = out.connectors.slice(0, 20);
    out.id = String(st.id);
    return out;
}

function buildHaCommand(action, payload, requestId) {
    const cmd = { protocol: HA_BRIDGE_PROTOCOL, action, request_id: requestId };
    if (payload && payload.station) cmd.station = compactStationForHa(payload.station);
    if (payload && payload.session) cmd.session = payload.session;
    return cmd;
}

function findHaCommandAck(snapshot, requestId) {
    if (!snapshot || !requestId) return null;
    return snapshot.recentCommands.find(c => c.request_id === requestId) || null;
}

async function getHaBridgeState({ force = false } = {}) {
    if (!getHaRemoteConfig()) return null;
    const age = Date.now() - haBridgeCache.fetchedAt;
    if (!force && age < (haBridgeCache.snapshot ? HA_BRIDGE_CACHE_MS : HA_BRIDGE_RETRY_MS)) return haBridgeCache.snapshot;
    if (haBridgeCache.promise) return haBridgeCache.promise;
    haBridgeCache.promise = (async () => {
        let snapshot = null;
        let error = "";
        try {
            const res = await haRequest(`/api/states/${HA_BRIDGE_ENTITY}`);
            if (res && res.ok) {
                snapshot = parseHaBridgeState(res.data);
                if (!snapshot) error = "Add-on-Sensor hat ein unbekanntes Format – App und Add-on aktualisieren";
            } else {
                error = describeHaHttpError(res ? res.status : 0);
            }
        } catch (e) {
            error = describeHaHttpError(0);
        }
        haBridgeCache = { fetchedAt: Date.now(), snapshot, error, promise: null };
        return snapshot;
    })();
    return haBridgeCache.promise;
}

async function waitForHaCommandAck(requestId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1200));
        const ack = findHaCommandAck(await getHaBridgeState({ force: true }), requestId);
        if (ack) return ack;
    }
    return null;
}

// Sends a command to the add-on (event or script) and waits until it is acknowledged in the bridge sensor
async function runHaCommand(action, payload = {}, { ackTimeoutMs = 8000 } = {}) {
    const requestId = `apk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    let res;
    try {
        res = await postHaCommand(buildHaCommand(action, payload, requestId));
    } catch (e) {
        res = { ok: false, status: 0 };
    }
    if (!res || !res.ok) {
        return { delivered: false, acked: false, ok: false, error: describeHaCommandError(res) };
    }
    const ack = await waitForHaCommandAck(requestId, ackTimeoutMs);
    if (!ack) return { delivered: true, acked: false, ok: false, error: "Add-on hat nicht bestätigt – läuft EV Charge Live ab v1.3.21?" };
    return { delivered: true, acked: true, ok: Boolean(ack.ok), error: ack.error || "" };
}

function showHaCommandToast(result, successText) {
    if (result.ok) showToast(successText, "success");
    else if (result.delivered && !result.acked) showToast(`⚠️ Von Home Assistant angenommen, aber: ${result.error}`, "warning");
    else showToast(`❌ Nicht gespeichert: ${result.error}`, "error");
}

function applyStationList(kind, list) {
    if (kind === "watchlist") {
        watchlist = list;
    } else {
        favorites = list;
        document.getElementById("fav-count").innerText = favorites.length;
        renderMapMarkers(activeStations, false);
    }
    try {
        localStorage.setItem(kind === "watchlist" ? "ev_watchlist" : "ev_favorites", JSON.stringify(list));
    } catch (e) {}
    renderFavoritesModal();
    updateSheetWatchButton();
}

// APK: change favorites/watchlist in the add-on; optimistic UI, rolled back unless HA accepted it
async function setStationListViaHa(kind, station, enabled) {
    const current = kind === "watchlist" ? watchlist : favorites;
    const previous = current.slice();
    const others = current.filter(s => String(s.id) !== String(station.id));
    applyStationList(kind, enabled ? [...others, station] : others);

    const prefix = kind === "watchlist" ? "watchlist" : "favorite";
    const result = await runHaCommand(`${prefix}_${enabled ? "add" : "remove"}`, { station });
    if (!result.delivered || (result.acked && !result.ok)) {
        applyStationList(kind, previous);
    } else if (result.acked) {
        const snapshot = await getHaBridgeState();
        if (snapshot) applyStationList(kind, kind === "watchlist" ? snapshot.watchlist : snapshot.favorites);
    }
    return result;
}

// Ingress add-on backend (same origin). The APK has none: callers fall back to HA bridge / localStorage.
async function fetchAddonJson(endpoint, options) {
    if (isNativeApp()) throw new Error("APK: kein Ingress-Backend");
    const resp = await fetch(getApiUrl(endpoint), options);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
}

// APK: list from the add-on via HA (cached locally for offline use), else the local list
async function loadRemoteOrLocalList(kind) {
    const storageKey = kind === "watchlist" ? "ev_watchlist" : "ev_favorites";
    const snapshot = useHaRemote() ? await getHaBridgeState() : null;
    if (snapshot) {
        const list = kind === "watchlist" ? snapshot.watchlist : snapshot.favorites;
        try { localStorage.setItem(storageKey, JSON.stringify(list)); } catch (e) {}
        return list;
    }
    try {
        const local = JSON.parse(localStorage.getItem(storageKey) || "[]");
        return Array.isArray(local) ? local : [];
    } catch (e) {
        return [];
    }
}

function getActiveSoc() {
    if (cupraState.liveSoc !== null && cupraState.liveSoc !== undefined && !isNaN(Number(cupraState.liveSoc))) {
        return Math.min(100, Math.max(0, Number(cupraState.liveSoc)));
    }
    return Math.min(100, Math.max(0, Number(cupraState.manualSoc ?? 42)));
}

function showToast(message, type = "info") {
    let container = document.getElementById("toast-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "toast-container";
        container.className = "toast-container";
        document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add("toast-hide");
        setTimeout(() => toast.remove(), 300);
    }, 3800);
}

let map;
let markersLayer;
let activeStations = [];
let favorites = [];
let watchlist = [];
let availableNotifyDevices = [];
let currentConfig = {};
let userLocationMarker = null;
let currentDeviceCoords = null;
let activeFilter = "all";

let cupraState = {
    batteryCapacity: 58,
    targetSoc: 80,
    manualSoc: 42,
    liveSoc: null,
    realBmsSoc: null,
    batteryTemp: null,
    battery12vVoltage: null,
    plugState: "disconnected", // 'disconnected', 'connected', 'locked', 'charging'
    warned12v: false,
    chargeSessionStartSoc: null,
    chargeSessionStartTime: null,
    source: 'manual', // 'manual', 'ble', 'ha'
    haSensor: 'sensor.cupra_born_battery_level'
};

let bleConnection = {
    device: null,
    server: null,
    rxChar: null,
    txChar: null,
    connected: false,
    connecting: false,
    telemetryInterval: null,
    commandLock: false,
    isNative: false,
    deviceId: null,
    serviceUuid: null,
    txCharUuid: null,
    rxCharUuid: null,
    nativeListenerHandle: null
};

let bleAutoReconnectTimer = null;
let bleAutoReconnectAttempts = 0;
let bleManualDisconnected = false;

let parkTimer = null; // { endTimestamp: ms, stationName: '' }
let parkTimerInterval = null;
let parkedLocation = null; // { name, lat, lon, time }
let winterMode = false;
let activeReports = {}; // { stationId: { type, expiresAt } }

// Initialize on DOM Load
document.addEventListener("DOMContentLoaded", async () => {
    initTheme();
    initCupraState();
    initParkStatus();
    initWinterMode();
    initMap();
    setupEventHandlers();
    setupFilterChips();
    updateHudLocationText();
    await evDb.init();
    await loadActiveReports();
    await loadConfig();
    syncRemoteTariffs();
    await loadFavorites();
    await loadWatchlist();
    await loadNotifyDevices();
    await searchStations(true);

    setTimeout(() => {
        if (map) map.invalidateSize();
    }, 300);

    // Auto-refresh every 60 seconds (paused when tab is hidden to save mobile battery & data)
    setInterval(async () => {
        if (document.hidden) return;
        await searchStations(false);
        await loadFavorites();
        await loadWatchlist();
        await syncChargeSessionFromHa();
    }, 60000);

    // Auto-Reconnect Watchdog bei App-Start (nach 2,5 Sekunden zur Entlastung des Boots)
    setTimeout(() => {
        if (!bleConnection.connected && !bleConnection.connecting && !bleManualDisconnected && isObdAutoReconnectEnabled()) {
            const lastDev = localStorage.getItem("ev_last_ble_device_id");
            if (lastDev) {
                obdLog("info", `[Auto-Reconnect] App-Start: Starte automatische Verbindung zu gespeichertem Dongle [${lastDev}]...`);
                scheduleObdAutoReconnect(1200);
            }
        }
    }, 2500);

    // Reconnect-Check beim Zurückkehren in den Vordergrund (z.B. nach Einsteigen ins Auto)
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
            if (!bleConnection.connected && !bleConnection.connecting && !bleManualDisconnected && isObdAutoReconnectEnabled()) {
                const lastDev = localStorage.getItem("ev_last_ble_device_id");
                if (lastDev) {
                    obdLog("info", "[Auto-Reconnect] App wieder im Vordergrund: Prüfe vLinker-Dongle...");
                    scheduleObdAutoReconnect(1500);
                }
            }
        }
    });
});

// Map Setup
function initMap() {
    // Default to Hockenheim
    map = L.map("map").setView([49.317584, 8.545261], 13);

    // ESRI World Street Map (extrem stabil, schnell, kein 403-Block)
    const esriStreet = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
        attribution: 'Tiles &copy; Esri &mdash; OpenStreetMap contributors',
        maxZoom: 19
    });

    // OpenStreetMap DE als Alternative
    const osmDe = L.tileLayer("https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> Deutschland',
        maxZoom: 19
    });

    esriStreet.addTo(map);

    L.control.layers({
        "Straßenkarte (ESRI)": esriStreet,
        "OpenStreetMap (DE)": osmDe
    }, null, { position: "topright" }).addTo(map);

    markersLayer = L.layerGroup().addTo(map);
}

// Event Handlers
function setupEventHandlers() {
    const btnSearch = document.getElementById("btn-search");
    if (btnSearch) {
        btnSearch.addEventListener("click", () => {
            const drawer = document.getElementById("search-drawer");
            if (drawer) drawer.classList.add("hidden");
            searchStations(true);
            updateHudLocationText();
        });
    }

    const btnSync = document.getElementById("btn-sync");
    if (btnSync) btnSync.addEventListener("click", triggerSync);

    const btnFavs = document.getElementById("btn-favorites");
    if (btnFavs) btnFavs.addEventListener("click", () => openModal("modal-favorites"));

    const btnSettings = document.getElementById("btn-settings");
    if (btnSettings) btnSettings.addEventListener("click", () => openModal("modal-settings"));

    const btnTestPush = document.getElementById("btn-test-push");
    if (btnTestPush) btnTestPush.addEventListener("click", sendTestPush);

    const settingsForm = document.getElementById("settings-form");
    if (settingsForm) settingsForm.addEventListener("submit", saveSettings);

    // Floating HUD Search Drawer Toggle
    const btnToggleDrawer = document.getElementById("btn-toggle-search-drawer");
    const searchDrawer = document.getElementById("search-drawer");
    if (btnToggleDrawer && searchDrawer) {
        btnToggleDrawer.addEventListener("click", (e) => {
            e.stopPropagation();
            searchDrawer.classList.toggle("hidden");
        });
    }

    // Close search drawer when clicking outside
    document.addEventListener("click", (e) => {
        if (searchDrawer && !searchDrawer.classList.contains("hidden")) {
            if (!searchDrawer.contains(e.target) && !btnToggleDrawer?.contains(e.target)) {
                searchDrawer.classList.add("hidden");
            }
        }
    });

    const btnTheme = document.getElementById("btn-theme");
    if (btnTheme) btnTheme.addEventListener("click", toggleAmoledTheme);

    const btnQrScan = document.getElementById("btn-qr-scan");
    if (btnQrScan) btnQrScan.addEventListener("click", openQrScannerModal);

    const btnRoutePlanner = document.getElementById("btn-route-planner");
    if (btnRoutePlanner) btnRoutePlanner.addEventListener("click", openRoutePlannerModal);

    const btnWinter = document.getElementById("btn-winter");
    if (btnWinter) btnWinter.addEventListener("click", toggleWinterMode);

    const btnLogbook = document.getElementById("btn-logbook");
    if (btnLogbook) btnLogbook.addEventListener("click", openLogbookModal);

    const btnCupraSoc = document.getElementById("btn-cupra-soc");
    if (btnCupraSoc) btnCupraSoc.addEventListener("click", () => openModal("modal-cupra-obd"));

    const btnObdConnect = document.getElementById("btn-obd-connect");
    if (btnObdConnect) btnObdConnect.addEventListener("click", connectVlinkerBle);

    const btnObdDisconnect = document.getElementById("btn-obd-disconnect");
    if (btnObdDisconnect) btnObdDisconnect.addEventListener("click", disconnectVlinkerBle);

    const btnGps = document.getElementById("btn-recenter-gps");
    if (btnGps) {
        btnGps.addEventListener("click", () => {
            if (currentDeviceCoords && currentDeviceCoords.lat && currentDeviceCoords.lon) {
                map.setView([currentDeviceCoords.lat, currentDeviceCoords.lon], 15);
                showToast("🎯 Auf aktuellen Standort zentriert", "info");
            } else {
                applyCurrentLocation();
            }
        });
    }

    // Close search drawer when tapping on map
    if (map) {
        map.on("click", () => {
            if (searchDrawer) searchDrawer.classList.add("hidden");
        });
    }

    // Slider Listeners in Cupra Modal
    const targetSlider = document.getElementById("born-target-soc");
    const targetVal = document.getElementById("target-soc-val");
    if (targetSlider && targetVal) {
        targetSlider.addEventListener("input", (e) => {
            targetVal.textContent = e.target.value + " %";
        });
    }

    const manualSlider = document.getElementById("born-manual-soc");
    const manualVal = document.getElementById("manual-soc-val");
    if (manualSlider && manualVal) {
        manualSlider.addEventListener("input", (e) => {
            manualVal.textContent = e.target.value + " %";
        });
    }
}

// Update Top HUD Location & Radius display
function updateHudLocationText() {
    const cityInput = document.getElementById("input-city");
    const radiusSelect = document.getElementById("select-radius");
    const hudLocation = document.getElementById("hud-location-text");
    const hudRadius = document.getElementById("hud-radius-text");

    if (hudLocation && cityInput) {
        const val = cityInput.value.trim();
        if (val) {
            hudLocation.textContent = val.replace(/^📍\s*/, "");
        }
    }
    if (hudRadius && radiusSelect) {
        const radiusM = parseInt(radiusSelect.value, 10);
        hudRadius.textContent = `${Math.round(radiusM / 1000)} km Umkreis ▾`;
    }
}

// Config Loading
async function loadConfig() {
    try {
        const resp = await fetch(getApiUrl("api/config"));
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data && typeof data === "object" && !Array.isArray(data)) {
            currentConfig = data;
        }
    } catch (err) {
        // Standalone APK / no add-on backend: use locally persisted settings
        try {
            const local = JSON.parse(localStorage.getItem("ev_local_config") || "null");
            if (local && typeof local === "object" && !Array.isArray(local)) {
                currentConfig = local;
            }
        } catch (e) {
            console.warn("Lokale Einstellungen nicht lesbar:", e);
        }
    }

    try {

        // Populate settings form
        const polling = currentConfig.polling || {};
        const notify = currentConfig.notifications || {};
        const ha = currentConfig.home_assistant_integration || {};

        document.getElementById("cfg-interval").value = polling.interval_seconds || 60;
        document.getElementById("cfg-notify-enabled").checked = notify.enabled !== false;
        const notifySvcInput = document.getElementById("cfg-notify-service");
        if (notifySvcInput) notifySvcInput.value = notify.service || "notify.mobile_app_2407fpn8eg";
        renderNotifyDevices();
        document.getElementById("cfg-notify-cooldown").value = notify.cooldown_minutes || 10;
        document.getElementById("cfg-title-tpl").value = notify.title_template || "⚡ Ladestation frei: {station_name}";
        document.getElementById("cfg-msg-tpl").value = notify.message_template || "An {station_name} ({address}) sind jetzt {free_slots} von {total_slots} Plätzen frei!";
        document.getElementById("cfg-prefix").value = ha.entity_prefix || "sensor.ev_charge_";
        document.getElementById("cfg-device-tracker").checked = ha.create_device_tracker !== false;
        document.getElementById("cfg-fire-events").checked = ha.fire_ha_events !== false;

        // User Tariffs in Settings
        const userTariffs = currentConfig.tariffs || getUserTariffs();
        const mode = userTariffs.mode || "adhoc";
        const rdoAdhoc = document.getElementById("cfg-mode-adhoc");
        const rdoContracts = document.getElementById("cfg-mode-contracts");
        if (rdoAdhoc && rdoContracts) {
            rdoAdhoc.checked = mode === "adhoc";
            rdoContracts.checked = mode === "contracts";
        }
        if (typeof toggleTariffModeUI === "function") toggleTariffModeUI();

        const chkSwh = document.getElementById("cfg-tariff-swh");
        if (chkSwh) chkSwh.checked = Boolean(userTariffs.swh);
        const chkEnbw = document.getElementById("cfg-tariff-enbw");
        if (chkEnbw) chkEnbw.checked = Boolean(userTariffs.enbw);
        const chkEwego = document.getElementById("cfg-tariff-ewego");
        if (chkEwego) chkEwego.checked = Boolean(userTariffs.ewego);
        const chkIonity = document.getElementById("cfg-tariff-ionity");
        if (chkIonity) chkIonity.checked = Boolean(userTariffs.ionity);
        const chkMaingau = document.getElementById("cfg-tariff-maingau");
        if (chkMaingau) chkMaingau.checked = Boolean(userTariffs.maingau);

        // Home Assistant Remote Server settings
        const haUrlInput = document.getElementById("cfg-ha-server-url");
        if (haUrlInput) haUrlInput.value = currentConfig.ha_server_url || localStorage.getItem("ev_ha_server_url") || "";
        const haTokenInput = document.getElementById("cfg-ha-token");
        if (haTokenInput) haTokenInput.value = currentConfig.ha_token || localStorage.getItem("ev_ha_token") || "";

        const loc = currentConfig.location_defaults || {};
        if (loc.latitude && loc.longitude) {
            map.setView([loc.latitude, loc.longitude], 14);
        }
        const trackerInput = document.getElementById("cfg-device-tracker-entity");
        if (trackerInput) {
            trackerInput.value = loc.device_tracker_entity || "device_tracker.2407fpn8eg";
        }
    } catch (err) {
        console.error("Failed to load config:", err);
    }
}

// Favorites Loading
async function loadFavorites() {
    try {
        const data = await fetchAddonJson("api/favorites");
        favorites = Array.isArray(data) ? data : [];
    } catch (err) {
        favorites = await loadRemoteOrLocalList("favorites");
    }
    document.getElementById("fav-count").innerText = favorites.length;
    renderFavoritesModal();
}

// Watchlist (Push-Beobachtungsliste) Loading
async function loadWatchlist() {
    try {
        const data = await fetchAddonJson("api/watchlist");
        watchlist = Array.isArray(data) ? data : [];
    } catch (err) {
        watchlist = await loadRemoteOrLocalList("watchlist");
    }
    renderFavoritesModal();
    updateSheetWatchButton();
}

window.toggleWatchlist = async function(stationId) {
    const station = activeStations.find(s => String(s.id) === String(stationId)) ||
                    favorites.find(f => String(f.id) === String(stationId)) ||
                    watchlist.find(w => String(w.id) === String(stationId)) ||
                    (window.currentSheetStation && String(window.currentSheetStation.id) === String(stationId) ? window.currentSheetStation : null);
    if (!station) return;

    if (useHaRemote()) {
        const enable = !isWatched(stationId);
        const result = await setStationListViaHa("watchlist", station, enable);
        showHaCommandToast(result, enable
            ? `🔔 "${station.name}" wird in Home Assistant beobachtet (Push-Alarm bei freiem Platz aktiv)`
            : `🔕 "${station.name}" von der Beobachtungsliste in Home Assistant entfernt`);
        return;
    }

    let isWatchedNow = false;
    try {
        const res = await fetchAddonJson("api/watchlist/toggle", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(station)
        });
        isWatchedNow = res.is_watched;
    } catch (err) {
        let localWl = [];
        try { localWl = JSON.parse(localStorage.getItem("ev_watchlist") || "[]"); } catch (e) {}
        const idx = localWl.findIndex(w => String(w.id) === String(stationId));
        if (idx >= 0) {
            localWl.splice(idx, 1);
            isWatchedNow = false;
        } else {
            localWl.push(station);
            isWatchedNow = true;
        }
        localStorage.setItem("ev_watchlist", JSON.stringify(localWl));
        watchlist = localWl;
    }

    await loadWatchlist();
    showToast(
        isWatchedNow ? `🔔 "${station.name}" wird jetzt beobachtet (Push-Alarm bei freiem Platz aktiv)` : `🔕 "${station.name}" von Beobachtungsliste entfernt`,
        isWatchedNow ? "success" : "info"
    );
};

window.toggleWatchlistFromSheet = async function() {
    if (!window.currentSheetStation) return;
    const st = window.currentSheetStation;
    await toggleWatchlist(st.id);
    updateSheetWatchButton();
};

function updateSheetWatchButton() {
    if (!window.currentSheetStation) return;
    const isW = isWatched(window.currentSheetStation.id);
    const watchBtn = document.getElementById("sheet-btn-watch");
    const watchIcon = document.getElementById("sheet-watch-icon");
    const watchText = document.getElementById("sheet-watch-text");
    if (watchBtn) {
        if (isW) {
            watchBtn.classList.add("is-watching");
            if (watchIcon) watchIcon.textContent = "🔔";
            if (watchText) watchText.textContent = "Beobachtet";
        } else {
            watchBtn.classList.remove("is-watching");
            if (watchIcon) watchIcon.textContent = "🔕";
            if (watchText) watchText.textContent = "Beobachten";
        }
    }
}

// Available Notify Devices Loading
async function loadNotifyDevices() {
    try {
        const resp = await fetch(getApiUrl("api/notify-devices"));
        if (resp.ok) {
            availableNotifyDevices = await resp.json();
        }
    } catch (err) {
        console.warn("Could not fetch notify devices:", err);
    }
    if (!Array.isArray(availableNotifyDevices) || availableNotifyDevices.length === 0) {
        availableNotifyDevices = [
            { id: "notify.mobile_app_2407fpn8eg", name: "📱 Stephan (Xiaomi 14T Pro)" },
            { id: "notify.mobile_app_sm_s928b", name: "📱 Galaxy S24 Ultra" },
            { id: "notify.mobile_app_2405crpfdg", name: "📱 Xiaomi Handy" },
            { id: "notify.mobile_app_sm_x115", name: "📟 Galaxy Tab A9" },
            { id: "notify.notify", name: "📢 Alle Geräte (Broadcast Gruppe)" }
        ];
    }
    renderNotifyDevices();
}

function renderNotifyDevices() {
    const container = document.getElementById("notify-devices-container");
    if (!container) return;

    const notify = currentConfig.notifications || {};
    let selected = notify.target_devices;
    if (!Array.isArray(selected) || selected.length === 0) {
        if (notify.service && notify.service !== "notify.notify") {
            selected = [notify.service];
        } else {
            selected = ["notify.mobile_app_2407fpn8eg"];
        }
    }

    container.innerHTML = availableNotifyDevices.map(dev => {
        const isChecked = selected.includes(dev.id);
        const safeId = escapeHtml(dev.id);
        const safeName = escapeHtml(dev.name);
        return `
            <label class="device-check-card ${isChecked ? 'checked' : ''}">
                <input type="checkbox" name="cfg-target-device" value="${safeId}" ${isChecked ? 'checked' : ''} onchange="this.closest('.device-check-card').classList.toggle('checked', this.checked)">
                <div class="device-card-label">
                    <span class="device-card-title">${safeName}</span>
                    <span class="device-card-sub">${safeId}</span>
                </div>
            </label>
        `;
    }).join("");
}

// EnBW Recursive Ungrouping Engine for Direct Client
async function fetchEnbwAreaWithUngrouping(fromLat, toLat, fromLon, toLon, depth) {
    depth = depth || 0;
    if (depth > 3) return [];
    const enbwUrl = `https://api.emp.emob-enbw.com/emobility-public-api/api/v1/chargestations?grouping=false&fromLat=${fromLat}&toLat=${toLat}&fromLon=${fromLon}&toLon=${toLon}`;
    const enbwResp = await nativeHttpFetch(enbwUrl, {
        headers: {
            "Ocp-Apim-Subscription-Key": "90a67b9900364009b588e100e4b1cc64",
            "Origin": "https://www.enbw.com",
            "Referer": "https://www.enbw.com/",
            "User-Agent": "HomeAssistant-EVChargeLive/1.1",
            "Accept": "application/json"
        }
    });
    if (!enbwResp.ok) return [];
    let markers;
    try {
        markers = await enbwResp.json();
    } catch (e) {
        return [];
    }
    if (!Array.isArray(markers)) return [];

    const results = [];
    const subPromises = [];
    for (let i = 0; i < markers.length; i++) {
        const m = markers[i];
        if (m.grouped && m.viewPort && depth < 3) {
            const vp = m.viewPort;
            subPromises.push(fetchEnbwAreaWithUngrouping(vp.lowerLeftLat, vp.upperRightLat, vp.lowerLeftLon, vp.upperRightLon, depth + 1));
        } else if (!m.grouped) {
            results.push(m);
        }
    }

    if (subPromises.length > 0) {
        const subLists = await Promise.all(subPromises);
        const seen = new Set(results.map(r => r.stationId).filter(Boolean));
        for (let j = 0; j < subLists.length; j++) {
            const list = subLists[j];
            for (let k = 0; k < list.length; k++) {
                const item = list[k];
                if (item && item.stationId && !seen.has(item.stationId)) {
                    seen.add(item.stationId);
                    results.push(item);
                }
            }
        }
    }
    return results;
}

// Deterministic EVSE Sort Key for consistent connector numbering (Ladepunkt 1, 2...)
function getEvseSortKey(item) {
    if (!item) return { isNum: false, num: 0, raw: "" };
    const rawId = String(item.evse_id || item.evseId || item.uid || item.chargePointId || "");
    const m = rawId.match(/(\d+)$/);
    return {
        isNum: Boolean(m),
        num: m ? parseInt(m[1], 10) : 0,
        raw: rawId
    };
}

function compareEvseItems(a, b) {
    const kA = getEvseSortKey(a);
    const kB = getEvseSortKey(b);
    if (kA.isNum && kB.isNum) {
        if (kA.num !== kB.num) return kA.num - kB.num;
    }
    return kA.raw.localeCompare(kB.raw);
}

// Fetch single EnBW Station Details for real-time EVSE status & timestamps
async function fetchEnbwStationDetail(stationId) {
    if (!stationId) return null;
    try {
        const enbwUrl = `https://api.emp.emob-enbw.com/emobility-public-api/api/v1/chargestations/${stationId}`;
        const resp = await nativeHttpFetch(enbwUrl, {
            headers: {
                "Ocp-Apim-Subscription-Key": "90a67b9900364009b588e100e4b1cc64",
                "Origin": "https://www.enbw.com",
                "Referer": "https://www.enbw.com/",
                "User-Agent": "HomeAssistant-EVChargeLive/1.1",
                "Accept": "application/json"
            }
        });
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        return null;
    }
}

// Parse EnBW ChargePoints deterministically with point labels and timestamps
function parseEnbwChargePointsClient(chargePoints) {
    if (!Array.isArray(chargePoints)) return [];
    const sorted = [...chargePoints].sort(compareEvseItems);
    const now = Date.now();
    const connectors = [];

    sorted.forEach((cp, idx) => {
        const cpStatus = (cp.status || "AVAILABLE").toUpperCase();
        const evseId = cp.evseId || cp.chargePointId || "";
        const updatedAt = cp.state && cp.state.updatedAt ? cp.state.updatedAt : null;
        let sinceTime = null;
        let durStr = null;
        let durMinutes = null;

        if (updatedAt) {
            try {
                const dt = new Date(updatedAt);
                const hh = String(dt.getHours()).padStart(2, '0');
                const mm = String(dt.getMinutes()).padStart(2, '0');
                sinceTime = `${hh}:${mm}`;
                const diffMs = Math.max(0, now - updatedAt);
                durMinutes = Math.floor(diffMs / 60000);
                const h = Math.floor(durMinutes / 60);
                const m = durMinutes % 60;
                durStr = h > 0 ? `vor ${h} Std. ${m} Min.` : `vor ${m} Min.`;
            } catch (e) {}
        }

        const pointLabel = `Ladepunkt ${idx + 1}`;
        const rawConns = cp.connectors && cp.connectors.length > 0 ? cp.connectors : [{}];
        rawConns.forEach(conn => {
            let plug = conn.plugTypeName || conn.chargePlugTypeGroup || "Typ 2";
            if (/type_2|typ 2/i.test(plug)) plug = "Typ 2";
            else if (/ccs/i.test(plug)) plug = "CCS";
            else if (/chademo/i.test(plug)) plug = "CHAdeMO";
            else if (/schuko/i.test(plug)) plug = "Schuko";

            const power = Math.round((conn.maxPowerInKw || 22.0) * 10) / 10;
            connectors.push({
                point_label: pointLabel,
                point_index: idx + 1,
                standard: plug,
                power_kw: power,
                power_type: power <= 43 ? "AC" : "DC",
                status: cpStatus,
                evse_id: evseId,
                updated_at: updatedAt,
                since_time: sinceTime,
                duration_str: durStr,
                duration_minutes: durMinutes
            });
        });
    });
    return connectors;
}

// Standalone Direct Client for APK
async function searchStationsDirectClient(city, postalCode, lat, lon, radius) {
    try {
        const params = new URLSearchParams({ limit: "100" });
        if (lat !== null && lon !== null && radius) {
            params.append("lat", lat);
            params.append("lon", lon);
            params.append("radius", radius);
        } else if (postalCode) {
            params.append("postal_code", postalCode);
        } else if (city) {
            params.append("city", city);
        } else {
            params.append("postal_code", "68766");
            params.append("city", "Hockenheim");
        }

        const resp = await fetch(`https://api.mobidata-bw.de/ocpdb/api/public/v1/locations?${params.toString()}`, {
            headers: { "Accept": "application/json" }
        });
        if (!resp.ok) return [];
        const data = await resp.json();
        const rawItems = data.items || data.data || [];

        let favs = [];
        try { favs = JSON.parse(localStorage.getItem("ev_favorites") || "[]"); } catch (e) {}
        const favIds = new Set(favs.map(f => String(f.id)));

        let stations = rawItems.map(item => {
            const coords = item.coordinates || {};
            const itemLat = coords.lat ?? coords.latitude;
            const itemLon = coords.lon ?? coords.longitude;
            if (itemLat === undefined || itemLon === undefined) return null;

            const op = (item.operator && item.operator.name) || "Unbekannter Betreiber";
            const addr = item.address || "";
            const name = item.name || `${op} ${addr}`.trim();
            const sid = String(item.id);

            let evses = item.evses || [];
            if (!evses.length && item.charging_pool) {
                item.charging_pool.forEach(p => { if (p.evses) evses.push(...p.evses); });
            }

            // Sort EVSEs deterministically (Ladepunkt 1, 2...)
            evses.sort(compareEvseItems);

            let total = evses.length || 2;
            let free = 0;
            let occupied = 0;
            let connectors = [];

            evses.forEach((evse, evseIdx) => {
                const st = (evse.status || "AVAILABLE").toUpperCase();
                const isFree = (st === "AVAILABLE" || st === "FREE" || st === "STATIC" || st === "OPERATIVE");
                if (isFree) free++;
                else occupied++;

                (evse.connectors || []).forEach(conn => {
                    const pKw = Math.round((conn.max_electric_power || 22000) / 1000.0);
                    let std = conn.standard || "Typ 2";
                    if (std.includes("T2_COMBO") || std.includes("CCS")) std = "CCS";
                    else if (std.includes("T2")) std = "Typ 2";
                    connectors.push({
                        point_label: `Ladepunkt ${evseIdx + 1}`,
                        point_index: evseIdx + 1,
                        evse_id: evse.evse_id || evse.uid,
                        standard: std,
                        power_kw: pKw,
                        power_type: conn.power_type || (pKw > 22 ? "DC" : "AC"),
                        status: isFree ? "AVAILABLE" : "OCCUPIED"
                    });
                });
            });

            if (!connectors.length) {
                connectors = [{ standard: "Typ 2", power_kw: 22.0, power_type: "AC", status: "AVAILABLE" }];
                free = total;
            }

            return {
                id: sid,
                name: name,
                operator: op,
                address: addr,
                postal_code: item.postal_code || "",
                city: item.city || "",
                latitude: Number(itemLat),
                longitude: Number(itemLon),
                total_slots: total,
                free_slots: free,
                occupied_slots: occupied,
                status: free === total ? "AVAILABLE" : (free === 0 ? "OCCUPIED" : "PARTIAL"),
                connectors: connectors,
                live_source: "MobiData BW",
                is_favorite: favIds.has(sid)
            };
        }).filter(Boolean);

        // Direct Client EnBW Real-Time Overlay with 5-minute fallback cache
        if (stations.length > 0) {
            try {
                const lats = stations.map(s => s.latitude).filter(Boolean);
                const lons = stations.map(s => s.longitude).filter(Boolean);
                if (lats.length > 0 && lons.length > 0) {
                    const minLat = Math.min(...lats) - 0.006;
                    const maxLat = Math.max(...lats) + 0.006;
                    const minLon = Math.min(...lons) - 0.006;
                    const maxLon = Math.max(...lons) + 0.006;
                    const markers = await fetchEnbwAreaWithUngrouping(minLat, maxLat, minLon, maxLon, 0);
                    if (Array.isArray(markers) && markers.length > 0) {
                        stations.forEach(st => {
                            const stAddrNorm = (st.address || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                            let bestMatch = null;
                            let minDist = 999999;
                            for (const m of markers) {
                                if (m.grouped || !m.lat || !m.lon) continue;
                                const dLat = (m.lat - st.latitude) * 111000;
                                const dLon = (m.lon - st.longitude) * 111000 * Math.cos(st.latitude * Math.PI / 180);
                                const dist = Math.sqrt(dLat * dLat + dLon * dLon);
                                if (dist > 250) continue;
                                const mAddrNorm = (m.shortAddress || "").toLowerCase().replace(/[^a-z0-9]/g, "");
                                const isAddrMatch = Boolean(stAddrNorm && mAddrNorm && (stAddrNorm.includes(mAddrNorm) || mAddrNorm.includes(stAddrNorm)));
                                if (isAddrMatch) {
                                    bestMatch = m;
                                    break;
                                } else if (dist < 50 && dist < minDist) {
                                    minDist = dist;
                                    bestMatch = m;
                                }
                            }
                            if (bestMatch && typeof bestMatch.availableChargePoints === "number") {
                                const tot = bestMatch.numberOfChargePoints || st.total_slots || 2;
                                const fr = bestMatch.availableChargePoints;
                                st.total_slots = tot;
                                st.free_slots = fr;
                                st.occupied_slots = Math.max(0, tot - fr);
                                st.live_source = "EnBW Echtzeit (Direkt)";
                                st.status = fr === tot ? "AVAILABLE" : (fr === 0 ? "OCCUPIED" : "PARTIAL");
                                if (bestMatch.stationId) {
                                    st.enbw_station_id = bestMatch.stationId;
                                }
                                if (st.connectors && st.connectors.length > 0) {
                                    if (fr === tot) {
                                        st.connectors.forEach(c => { c.status = "AVAILABLE"; });
                                    } else if (fr === 0) {
                                        st.connectors.forEach(c => { c.status = "OCCUPIED"; });
                                    }
                                }
                                // Save in direct cache for 5 min grace
                                window._directStateCache = window._directStateCache || new Map();
                                window._directStateCache.set(st.id, {
                                    free_slots: st.free_slots,
                                    occupied_slots: st.occupied_slots,
                                    total_slots: st.total_slots,
                                    status: st.status,
                                    connectors: st.connectors,
                                    enbw_station_id: st.enbw_station_id,
                                    time: Date.now()
                                });
                            } else if (window._directStateCache && window._directStateCache.has(st.id)) {
                                const cached = window._directStateCache.get(st.id);
                                if (Date.now() - cached.time < 300000) {
                                    st.free_slots = cached.free_slots;
                                    st.occupied_slots = cached.occupied_slots;
                                    st.total_slots = cached.total_slots;
                                    st.status = cached.status;
                                    st.connectors = cached.connectors;
                                    st.enbw_station_id = cached.enbw_station_id || st.enbw_station_id;
                                    st.live_source = "EnBW Echtzeit (Puffer)";
                                }
                            }
                        });

                        // Enrich favorite stations with exact per-EVSE timestamps if matched
                        const matchedFavs = stations.filter(s => s.is_favorite && s.enbw_station_id);
                        if (matchedFavs.length > 0) {
                            await Promise.all(matchedFavs.map(async (fst) => {
                                try {
                                    const det = await fetchEnbwStationDetail(fst.enbw_station_id);
                                    if (det && det.chargePoints) {
                                        const parsed = parseEnbwChargePointsClient(det.chargePoints);
                                        if (parsed && parsed.length > 0) {
                                            fst.connectors = parsed;
                                            const fCount = parsed.filter(c => c.status === "AVAILABLE" || c.status === "FREE").length;
                                            const tCount = parsed.length;
                                            fst.total_slots = tCount;
                                            fst.free_slots = fCount;
                                            fst.occupied_slots = Math.max(0, tCount - fCount);
                                            fst.status = fCount === tCount ? "AVAILABLE" : (fCount === 0 ? "OCCUPIED" : "PARTIAL");
                                        }
                                    }
                                } catch (e) {}
                            }));
                        }
                    }
                }
            } catch (enbwErr) {
                console.warn("Direct EnBW query failed, checking cached state", enbwErr);
                if (window._directStateCache) {
                    stations.forEach(st => {
                        const cached = window._directStateCache.get(st.id);
                        if (cached && (Date.now() - cached.time < 300000)) {
                            st.free_slots = cached.free_slots;
                            st.occupied_slots = cached.occupied_slots;
                            st.total_slots = cached.total_slots;
                            st.status = cached.status;
                            st.connectors = cached.connectors;
                            st.live_source = "EnBW Echtzeit (Puffer)";
                        }
                    });
                }
            }
        }
        return stations;
    } catch (e) {
        console.warn("Direct MobiData query failed", e);
        return [];
    }
}

// Search Stations
async function searchStations(adjustView = false) {
    const city = document.getElementById("input-city").value.trim();
    const postalCode = document.getElementById("input-zip").value.trim();
    const radius = document.getElementById("select-radius").value;

    const params = new URLSearchParams();
    if (currentDeviceCoords) {
        params.append("lat", currentDeviceCoords.lat);
        params.append("lon", currentDeviceCoords.lon);
        params.append("radius", radius);
    } else if (postalCode) {
        params.append("postal_code", postalCode);
        if (radius) params.append("radius", radius);
    } else if (city) {
        params.append("city", city);
        if (radius) params.append("radius", radius);
    }

    try {
        const data = await fetchAddonJson(`api/stations?${params.toString()}`);
        activeStations = Array.isArray(data) ? data : [];
    } catch (err) {
        // APK: search directly at MobiData/EnBW; favorites & watchlist get the add-on's data from HA
        const [direct, snapshot] = await Promise.all([
            searchStationsDirectClient(
                city,
                postalCode,
                currentDeviceCoords ? currentDeviceCoords.lat : null,
                currentDeviceCoords ? currentDeviceCoords.lon : null,
                radius
            ),
            useHaRemote() ? getHaBridgeState() : Promise.resolve(null)
        ]);
        activeStations = mergeHaBridgeStations(direct, snapshot);
    }

    // Synchronize live slot counts into favorites array & localStorage
    if (Array.isArray(favorites) && favorites.length > 0 && Array.isArray(activeStations) && activeStations.length > 0) {
        let favsUpdated = false;
        favorites.forEach(fav => {
            const match = activeStations.find(s => String(s.id) === String(fav.id));
            if (match) {
                fav.free_slots = match.free_slots;
                fav.occupied_slots = match.occupied_slots;
                fav.total_slots = match.total_slots;
                fav.status = match.status;
                fav.status_text = match.status_text;
                fav.connectors = match.connectors;
                fav.live_source = match.live_source;
                favsUpdated = true;
            }
        });
        if (favsUpdated) {
            try {
                localStorage.setItem("ev_favorites", JSON.stringify(favorites));
                renderFavoritesModal();
            } catch (e) {}
        }
    }

    renderMapMarkers(activeStations, adjustView);
}

// Render Pins on Map
function renderMapMarkers(stations, adjustView) {
    markersLayer.clearLayers();

    // Filter stations based on activeFilter chip
    let filtered = stations || [];
    if (activeFilter === "free") {
        filtered = filtered.filter(st => Number(st.free_slots || 0) > 0);
    } else if (activeFilter === "swh") {
        filtered = filtered.filter(st => {
            const op = (st.operator || "").toLowerCase();
            const nm = (st.name || "").toLowerCase();
            return op.includes("stadtwerke") || nm.includes("stadtwerke");
        });
    } else if (activeFilter === "enbw") {
        filtered = filtered.filter(st => {
            const op = (st.operator || "").toLowerCase();
            const nm = (st.name || "").toLowerCase();
            return op.includes("enbw") || nm.includes("enbw");
        });
    } else if (activeFilter === "ac") {
        filtered = filtered.filter(st => (st.connectors || []).some(c => parseFloat(c.power_kw) <= 22));
    } else if (activeFilter === "dc") {
        filtered = filtered.filter(st => (st.connectors || []).some(c => c.power_type === 'DC' || parseFloat(c.power_kw) > 22));
    }

    const bounds = [];
    if (currentDeviceCoords && currentDeviceCoords.lat && currentDeviceCoords.lon) {
        bounds.push([currentDeviceCoords.lat, currentDeviceCoords.lon]);
    }

    if (!filtered || filtered.length === 0) {
        if (adjustView && bounds.length > 0) {
            map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
        }
        return;
    }

    filtered.forEach(st => {
        const lat = Number(st.latitude);
        const lon = Number(st.longitude);
        if (!lat || !lon) return;

        bounds.push([lat, lon]);

        const isFav = favorites.some(f => String(f.id) === String(st.id));
        const safeId = escapeHtml(st.id);
        const report = activeReports[safeId] || activeReports[st.id];

        // Pin styling based on free slots & community reports
        let pinClass = "pin-available";
        let statusBadgeClass = "badge-success";
        if (report && report.expiresAt > Date.now()) {
            pinClass = "pin-reported";
            statusBadgeClass = "badge-danger";
        } else if (st.status === "OUTOFORDER") {
            pinClass = "pin-outoforder";
            statusBadgeClass = "badge-danger";
        } else if (st.free_slots === 0) {
            pinClass = "pin-occupied";
            statusBadgeClass = "badge-danger";
        } else if (st.free_slots < st.total_slots) {
            pinClass = "pin-partial";
            statusBadgeClass = "badge-warning";
        }

        const icon = L.divIcon({
            className: "custom-div-icon",
            html: `<div class="custom-pin ${pinClass}">${report && report.expiresAt > Date.now() ? "⚠️" : (isFav ? "★" : Number(st.free_slots || 0))}</div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
            popupAnchor: [0, -18]
        });

        const marker = L.marker([lat, lon], { icon: icon });
        marker.on("click", () => openStationDetailSheet(st));
        markersLayer.addLayer(marker);
    });

    if (adjustView && bounds.length > 0) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    }
}

// Build Station Detail Bottom Sheet Body HTML
function buildStationDetailBodyHtml(st) {
    const safeId = escapeHtml(st.id);
    const report = activeReports[safeId] || activeReports[st.id];
    const isFav = isFavorite(st.id);
    const lat = Number(st.latitude);
    const lon = Number(st.longitude);

    let statusBadgeClass = "badge-success";
    if (st.status === "OUTOFORDER") statusBadgeClass = "badge-danger";
    else if (st.free_slots === 0) statusBadgeClass = "badge-danger";
    else if (st.free_slots < st.total_slots) statusBadgeClass = "badge-warning";

    const connectorsHtml = (st.connectors || []).map((c, idx) => {
        let statusBadge = "";
        const sinceTime = escapeHtml(c.since_time);
        const durStr = escapeHtml(c.duration_str);
        if (c.status === "OCCUPIED" || c.status === "CHARGING") {
            const timeInfo = sinceTime ? ` seit ${sinceTime} Uhr${durStr ? ` (${durStr})` : ''}` : (durStr ? ` (${durStr})` : '');
            statusBadge = `<span class="badge-occupied">⛔ Belegt${timeInfo}</span>`;
        } else if (c.status === "AVAILABLE" || c.status === "FREE") {
            const timeInfo = sinceTime ? ` seit ${sinceTime} Uhr` : "";
            statusBadge = `<span class="badge-available">✅ Frei${timeInfo}</span>`;
        } else {
            statusBadge = `<span class="badge-occupied">⚠️ ${escapeHtml(c.status || 'Unbekannt')}</span>`;
        }
        const lpLabel = c.point_label || (st.connectors.length > 1 ? `Ladepunkt ${idx + 1}` : '');
        const titleText = lpLabel ? `${lpLabel} · ${c.standard}` : c.standard;
        return `
            <li>
                <div class="connector-row">
                    <div class="conn-header">
                        <span class="conn-title">⚡ ${escapeHtml(titleText)}</span>
                        <span style="font-weight:700;color:var(--text-primary);">${escapeHtml(c.power_kw)} kW (${escapeHtml(c.power_type)})</span>
                    </div>
                    <div>${statusBadge}</div>
                </div>
            </li>
        `;
    }).join("");

    const currentSoc = (cupraState.liveSoc !== null && cupraState.liveSoc !== undefined) ? cupraState.liveSoc : ((cupraState.manualSoc !== null && cupraState.manualSoc !== undefined) ? cupraState.manualSoc : 50);
    const targetSoc = cupraState.targetSoc || 80;
    const deltaSoc = Math.max(0, targetSoc - currentSoc);
    const usableCapacity = (cupraState.batteryCapacity || 58) * ((cupraState.soh || 98) / 100);
    const neededKwh = (deltaSoc / 100) * usableCapacity;
    const consumptionKwh = winterMode ? 19.5 : 16.5;

    let maxPower = 11;
    let hasDc = false;
    (st.connectors || []).forEach(c => {
        const p = parseFloat(c.power_kw) || 0;
        if (p > maxPower) maxPower = p;
        if (c.power_type === 'DC' || p > 22) hasDc = true;
    });

    let durMinutes = 0;
    if (hasDc) {
        const effPower = Math.min(maxPower, 110);
        durMinutes = Math.round((neededKwh / effPower) * 60) + 4;
    } else {
        const effPower = Math.min(maxPower, 11);
        durMinutes = Math.round((neededKwh / (effPower * 0.9)) * 60);
    }
    const durH = Math.floor(durMinutes / 60);
    const durM = durMinutes % 60;
    const durFormatted = durH > 0 ? `${durH} Std. ${durM} Min.` : `${durM} Min.`;
    const addedKm = Math.round((neededKwh / consumptionKwh) * 100);
    const estCost = (neededKwh * 0.45).toFixed(2);

    const currentRangeKm = Math.round(((currentSoc / 100) * usableCapacity / consumptionKwh) * 100);
    const distKm = (st.distance_km !== undefined && st.distance_km !== null) ? parseFloat(st.distance_km) : null;
    let rangeBadgeHtml = "";
    if (distKm !== null && !isNaN(distKm)) {
        const bufferKm = Math.round(currentRangeKm - distKm);
        if (bufferKm >= 20) {
            rangeBadgeHtml = `<div class="range-badge range-green">🟢 Reicht locker (${currentRangeKm} km Rest, +${bufferKm} km Puffer)</div>`;
        } else if (bufferKm >= 5) {
            rangeBadgeHtml = `<div class="range-badge range-yellow">🟡 Knapp: Nur ${bufferKm} km Puffer bei Ankunft!</div>`;
        } else {
            rangeBadgeHtml = `<div class="range-badge range-red">🔴 Kritisch: Kaum erreichbar (${distKm.toFixed(1)} km vs. ${currentRangeKm} km)!</div>`;
        }
    }

    let tempNoticeHtml = "";
    if (hasDc && cupraState.batteryTemp !== null) {
        if (cupraState.batteryTemp < 20) {
            tempNoticeHtml = `<div class="temp-notice temp-notice-cold">❄️ <b>Akku ${cupraState.batteryTemp} °C:</b> DC-Ladeleistung auf ~65 kW gedrosselt. Vorkonditionierung im Born Infotainment empfohlen für volle 135 kW Peak!</div>`;
        } else {
            tempNoticeHtml = `<div class="temp-notice temp-notice-opt">🟢 <b>Akku ${cupraState.batteryTemp} °C:</b> Optimale Batterietemperatur für volle 135 kW DC Peak bereit.</div>`;
        }
    }

    const feeInfo = getBlockingFeeInfo(st.operator, hasDc);
    const tariffInfo = getAutomatedTariffComparison(st.operator, hasDc, neededKwh, maxPower);
    const tariffCardsHtml = tariffInfo.cards.map(c => `
        <div class="tariff-card ${c === tariffInfo.cheapest ? 'tariff-card-cheapest' : ''}">
            <div>
                <div class="tariff-card-name">
                    ${escapeHtml(c.name)} ${c === tariffInfo.cheapest ? '🏆' : ''}
                    ${c.isUserContract ? `<span class="${c.isAdhocChoice ? 'badge-user-adhoc' : 'badge-user-contract'}">${c.isAdhocChoice ? 'Meine Zahlart' : 'Mein Vertrag'}</span>` : ''}
                </div>
                <div class="tariff-card-sub">${escapeHtml(c.rate)} • ${c.badge}</div>
            </div>
            <div class="tariff-card-right">
                <div class="tariff-card-total">ca. ${c.totalCost.toFixed(2).replace('.', ',')} €</div>
            </div>
        </div>
    `).join("");

    const savingsHtml = (tariffInfo.savings && tariffInfo.cheapest && tariffInfo.cheapest.name) ? `<div class="tariff-savings-tip">💡 <b>Tipp:</b> Mit <b>${escapeHtml(tariffInfo.cheapest.name)}</b> sparst du hier ca. <b>${tariffInfo.savings} €</b>!</div>` : '';

    const cheapestBadgeText = (tariffInfo.cheapest && tariffInfo.cheapest.name) ? `${escapeHtml(tariffInfo.cheapest.name.split(' ')[0])} am günstigsten` : 'Günstigster Tarif';

    const tariffAdvisorHtml = `
        <div class="tariff-advisor-box">
            <div class="tariff-advisor-header">
                <span>💳 <b>Tarif-Vergleich (${neededKwh.toFixed(1)} kWh • ${escapeHtml(tariffInfo.powerCategory.toUpperCase())})</b></span>
                <span class="badge-cheapest">🏆 ${cheapestBadgeText}</span>
            </div>
            <div class="tariff-cards-list">
                ${tariffCardsHtml}
            </div>
            ${savingsHtml}
        </div>
    `;

    let reportBannerHtml = "";
    if (report && report.expiresAt > Date.now()) {
        reportBannerHtml = `<div style="background:#ef4444;color:#fff;font-size:0.75rem;padding:4px 8px;border-radius:6px;margin:6px 0;font-weight:700;">⚠️ Vor Ort als ${report.type === 'blocked' ? 'zugeparkt' : 'defekt'} gemeldet</div>`;
    }

    const sourceTag = st.live_source ? `<div style="font-size:11px;color:#94a3b8;margin-top:6px;">📡 ${escapeHtml(st.live_source)}</div>` : '';
    const gmapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(lat)},${encodeURIComponent(lon)}`;
    const safeJsId = escapeJsString(st.id);
    const safeJsName = escapeJsString(st.name);

    return `
        <div class="slots" style="margin-top:0;">
            <span style="font-weight:600;">Live-Verfügbarkeit:</span>
            <span class="badge ${statusBadgeClass}">${Number(st.free_slots || 0)} von ${Number(st.total_slots || 0)} frei</span>
        </div>
        ${rangeBadgeHtml}
        ${reportBannerHtml}
        <ul class="connectors-list">
            ${connectorsHtml}
        </ul>

        <!-- Cupra Born Lader-Rechner -->
        <div class="cupra-calc-box">
            <div class="calc-title">
                <span>🚗 Cupra Born (${currentSoc}% ➔ ${targetSoc}%)</span>
                <span>${usableCapacity.toFixed(1)} kWh (${cupraState.soh || 98}% SoH) ${winterMode ? '(❄️ Winter)' : '(☀️ Sommer)'}</span>
            </div>
            <div class="calc-grid">
                <div class="calc-metric">
                    <div class="calc-metric-label">Benötigt</div>
                    <div class="calc-metric-val">${neededKwh.toFixed(1)} kWh</div>
                </div>
                <div class="calc-metric">
                    <div class="calc-metric-label">Ladedauer</div>
                    <div class="calc-metric-val">~ ${durFormatted}</div>
                </div>
                <div class="calc-metric">
                    <div class="calc-metric-label">Reichweite</div>
                    <div class="calc-metric-val">+ ${addedKm} km</div>
                </div>
                <div class="calc-metric">
                    <div class="calc-metric-label">Kosten (~0,45€)</div>
                    <div class="calc-metric-val">ca. ${estCost} €</div>
                </div>
            </div>
            ${tempNoticeHtml}
        </div>

        ${tariffAdvisorHtml}

        <!-- Stand- & Blockiergebühr Info -->
        <div class="blocking-fee-box">
            <div class="fee-header">
                <span>⏱️ Stand- &amp; Blockiergebühr (${escapeHtml(feeInfo.title)})</span>
                <span class="badge-fee">${feeInfo.freeMinutes} Min. frei</span>
            </div>
            <div class="fee-text">${escapeHtml(feeInfo.summary)}</div>
            <div class="fee-night">${escapeHtml(feeInfo.nightRule)}</div>
        </div>

        ${sourceTag}
        <div class="nav-buttons-group">
            <a href="${gmapsUrl}" target="_blank" rel="noopener noreferrer" class="btn-nav btn-gmaps" title="In Google Maps / Android Auto im Cupra Born öffnen">
                🧭 Google Maps / Auto
            </a>
            <button class="btn-nav btn-cupra" onclick="sendToCupra('${safeJsId}')" title="Ziel an Cupra Born senden">
                🚗 An Cupra Born
            </button>
        </div>
        <div class="popup-extra-actions">
            <button class="btn-extra" onclick="startSmartChargeGuardianFromSheet()" style="background:linear-gradient(135deg, rgba(235,106,56,0.25), rgba(16,185,129,0.2));border:1px solid var(--cupra-copper);color:var(--text-primary);font-weight:700;">
                🛡️ Lade-Wächter (${feeInfo.timerMinutes >= 60 ? (feeInfo.timerMinutes / 60) + ' Std.' : feeInfo.timerMinutes + ' Min.'} + ${targetSoc}%)
            </button>
            <button class="btn-extra" onclick="markParkedCar('${safeJsName}', ${lat}, ${lon})">🅿️ Hier geparkt</button>
        </div>
        <div class="popup-extra-actions" style="margin-top:6px;">
            <button class="btn-extra" onclick="reportStationPrompt('${safeJsId}', '${safeJsName}')">⚠️ Zugeparkt/Defekt melden</button>
            <button class="btn-extra" onclick="quickLogCharge('${safeJsName}', ${neededKwh.toFixed(1)}, ${estCost})">💾 Zu Logbuch</button>
        </div>
    `;
}

// Open Station Detail Bottom Sheet
window.openStationDetailSheet = function(st) {
    if (!st) return;
    window.currentSheetStation = st;

    try {
        const titleEl = document.getElementById("sheet-station-title");
        const opEl = document.getElementById("sheet-station-operator");
        const bodyEl = document.getElementById("sheet-station-body");
        const favBtn = document.getElementById("sheet-btn-fav");
        const favIcon = document.getElementById("sheet-fav-icon");
        const favText = document.getElementById("sheet-fav-text");

        if (titleEl) titleEl.textContent = st.name || "Ladestation";
        if (opEl) opEl.textContent = `${st.operator || 'Betreiber'} • ${st.address || ''}, ${st.postal_code || ''} ${st.city || ''}`.trim();

        const isFav = isFavorite(st.id);
        if (favBtn) {
            if (isFav) {
                favBtn.classList.add("is-fav");
                if (favIcon) favIcon.textContent = "★";
                if (favText) favText.textContent = "Überwacht";
            } else {
                favBtn.classList.remove("is-fav");
                if (favIcon) favIcon.textContent = "☆";
                if (favText) favText.textContent = "Als Favorit";
            }
        }

        updateSheetWatchButton();

        if (bodyEl) {
            bodyEl.innerHTML = buildStationDetailBodyHtml(st);
        }

        openModal("modal-station-detail");

        // Background live refresh if EnBW station ID is available to get exact per-EVSE connector durations
        if (st.enbw_station_id) {
            fetchEnbwStationDetail(st.enbw_station_id).then(det => {
                if (det && det.chargePoints) {
                    const conns = parseEnbwChargePointsClient(det.chargePoints);
                    if (conns && conns.length > 0) {
                        st.connectors = conns;
                        const fr = conns.filter(c => c.status === "AVAILABLE" || c.status === "FREE").length;
                        const tot = conns.length;
                        st.total_slots = tot;
                        st.free_slots = fr;
                        st.occupied_slots = Math.max(0, tot - fr);
                        st.status = fr === tot ? "AVAILABLE" : (fr === 0 ? "OCCUPIED" : "PARTIAL");
                        const currentBody = document.getElementById("sheet-station-body");
                        if (currentBody && window.currentSheetStation && String(window.currentSheetStation.id) === String(st.id)) {
                            currentBody.innerHTML = buildStationDetailBodyHtml(st);
                        }
                    }
                }
            }).catch(() => {});
        }
    } catch (err) {
        console.error("Fehler beim Öffnen der Stationsdetails:", err);
        showToast("Fehler beim Laden der Stationsdetails: " + (err.message || err), "error");
    }
};

window.toggleFavoriteFromSheet = async function() {
    if (!window.currentSheetStation) return;
    const st = window.currentSheetStation;
    await toggleFavorite(st.id);
    const isFav = isFavorite(st.id);
    const favBtn = document.getElementById("sheet-btn-fav");
    const favIcon = document.getElementById("sheet-fav-icon");
    const favText = document.getElementById("sheet-fav-text");
    if (favBtn) {
        if (isFav) {
            favBtn.classList.add("is-fav");
            if (favIcon) favIcon.textContent = "★";
            if (favText) favText.textContent = "Überwacht";
        } else {
            favBtn.classList.remove("is-fav");
            if (favIcon) favIcon.textContent = "☆";
            if (favText) favText.textContent = "Als Favorit";
        }
    }
};

window.openStationDetailSheetById = function(stationId) {
    const station = activeStations.find(s => String(s.id) === String(stationId)) ||
                    favorites.find(f => String(f.id) === String(stationId));
    if (station) {
        closeModal("modal-favorites");
        if (map && station.latitude && station.longitude) {
            map.setView([station.latitude, station.longitude], 16);
        }
        openStationDetailSheet(station);
    }
};

// Stand- & Blockiergebühren der Anbieter ermitteln
function getBlockingFeeInfo(operator, hasDc) {
    const op = (operator || "").toLowerCase();

    if (op.includes("stadtwerke hockenheim") || op.includes("stadtwerke")) {
        return {
            title: "Stadtwerke Hockenheim",
            freeMinutes: 240,
            feePerMinute: 0.10,
            nightStart: 20,
            nightEnd: 8,
            hasNightRule: true,
            summary: "Ab 240 Min. (4 Std.) 0,10 €/Min. Tagsüber Parkscheibe (3–4 Std.) beachten.",
            nightRule: "🌙 Nachts (20:00 – 08:00 Uhr) ohne Blockiergebühr.",
            timerMinutes: 240
        };
    }

    if (op.includes("enbw")) {
        if (hasDc) {
            return {
                title: "EnBW mobility+ (DC)",
                freeMinutes: 45,
                feePerMinute: 0.10,
                nightStart: 21,
                nightEnd: 9,
                hasNightRule: false,
                summary: "Ab 45 Min. Standzeit 0,10 €/Min. (Gedeckelt auf max. 12,00 € pro Vorgang).",
                nightRule: "⚠️ Gilt rund um die Uhr (auch nachts).",
                timerMinutes: 45
            };
        } else {
            return {
                title: "EnBW mobility+ (AC)",
                freeMinutes: 240,
                feePerMinute: 0.10,
                nightStart: 21,
                nightEnd: 9,
                hasNightRule: true,
                summary: "Ab 240 Min. (4 Std.) Standzeit 0,10 €/Min. (Gedeckelt auf max. 12,00 €).",
                nightRule: "🌙 Nachts (21:00 – 09:00 Uhr) ohne Blockiergebühr.",
                timerMinutes: 240
            };
        }
    }

    if (op.includes("ionity")) {
        return {
            title: "IONITY High Power",
            freeMinutes: 60,
            feePerMinute: 0.20,
            nightStart: 21,
            nightEnd: 9,
            hasNightRule: false,
            summary: "Ab 60 Min. Standzeit 0,20 €/Min. Blockiergebühr.",
            nightRule: "⚠️ Rund um die Uhr aktiv.",
            timerMinutes: 60
        };
    }

    if (op.includes("aral") || op.includes("pulse")) {
        return {
            title: "Aral pulse (DC)",
            freeMinutes: 45,
            feePerMinute: 0.10,
            nightStart: 21,
            nightEnd: 9,
            hasNightRule: false,
            summary: "Ab 45 Min. Standzeit 0,10 €/Min. (max. 12,00 € Deckel).",
            nightRule: "⚠️ Rund um die Uhr aktiv.",
            timerMinutes: 45
        };
    }

    if (op.includes("tesla")) {
        return {
            title: "Tesla Supercharger",
            freeMinutes: 0,
            feePerMinute: 0.50,
            nightStart: 21,
            nightEnd: 9,
            hasNightRule: false,
            summary: "Supercharger: 0,50–1,00 €/Min. Blockiergebühr unmittelbar nach Ladeende (100% voll).",
            nightRule: "⚠️ Rund um die Uhr aktiv.",
            timerMinutes: 30
        };
    }

    if (op.includes("shell")) {
        return {
            title: "Shell Recharge",
            freeMinutes: hasDc ? 45 : 240,
            feePerMinute: 0.10,
            nightStart: 21,
            nightEnd: 9,
            hasNightRule: !hasDc,
            summary: hasDc ? "DC Schnelllader: Standgebühr ab 45 Min. (0,10 €/Min.)." : "AC: Standgebühr ab 240 Min. (4 Std.) 0,10 €/Min.",
            nightRule: "🌙 Bei AC nachts (21:00–09:00 Uhr) oft frei.",
            timerMinutes: hasDc ? 45 : 240
        };
    }

    if (op.includes("aldi")) {
        return {
            title: "ALDI SÜD Filial-Ladepunkt",
            freeMinutes: 60,
            feePerMinute: 0.10,
            nightStart: 21,
            nightEnd: 9,
            hasNightRule: false,
            summary: "Kundenparkplatz: Max. 60–90 Min. Parkzeit während des Einkaufs mit Parkscheibe.",
            nightRule: "⚠️ Außerhalb der Öffnungszeiten meist geschlossen.",
            timerMinutes: 60
        };
    }

    if (op.includes("wirelane")) {
        return {
            title: "Wirelane",
            freeMinutes: 240,
            feePerMinute: 0.10,
            nightStart: 22,
            nightEnd: 8,
            hasNightRule: true,
            summary: "AC: Ab 240 Min. (4 Std.) Standzeitzuschlag von 0,10 €/Min.",
            nightRule: "🌙 Nachts (22:00–08:00 Uhr) gebührenfrei.",
            timerMinutes: 240
        };
    }

    // Standard Fallback (Cupra / Elli / Roaming)
    if (hasDc) {
        return {
            title: "DC Schnelllader",
            freeMinutes: 45,
            feePerMinute: 0.10,
            nightStart: 21,
            nightEnd: 9,
            hasNightRule: false,
            summary: "DC Schnelllader: Standgebühr meist ab 45–60 Min. (ca. 0,10–0,15 €/Min.).",
            nightRule: "Je nach Ladekarte / Roaming-Tarif.",
            timerMinutes: 45
        };
    } else {
        return {
            title: "AC Normallader",
            freeMinutes: 240,
            feePerMinute: 0.10,
            nightStart: 21,
            nightEnd: 9,
            hasNightRule: true,
            summary: "AC Normallader: Standgebühr meist ab 240 Min. (4 Std.) ca. 0,10 €/Min.",
            nightRule: "🌙 Viele Roaming-Tarife nachts (21:00 – 08:00 Uhr) gebührenfrei.",
            timerMinutes: 240
        };
    }
}

// Abrufen der aktiven Lade-Verträge des Benutzers
function getUserTariffs() {
    try {
        const saved = localStorage.getItem("ev_user_tariffs");
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed && typeof parsed === "object") return parsed;
        }
    } catch (e) {}
    return {
        mode: "adhoc", // Default: "adhoc" (Kein Abo / Spontanzahler) oder "contracts"
        swh: false,
        enbw: false,
        ewego: false,
        ionity: false,
        maingau: false
    };
}

// UI Umschalter für Einstellungen (Ad-hoc vs. Verträge)
window.toggleTariffModeUI = function() {
    const isAdhoc = document.getElementById("cfg-mode-adhoc")?.checked;
    const panel = document.getElementById("contracts-sub-panel");
    if (panel) {
        panel.style.display = isAdhoc ? "none" : "block";
    }
};

window.switchSettingsTab = function(tabName) {
    document.querySelectorAll(".settings-tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".settings-tab-pane").forEach(p => {
        p.classList.remove("active");
        p.style.display = "none";
    });
    const activeBtn = document.getElementById(`settings-tab-btn-${tabName}`);
    const activePane = document.getElementById(`settings-tab-${tabName}`);
    if (activeBtn) activeBtn.classList.add("active");
    if (activePane) {
        activePane.classList.add("active");
        activePane.style.display = "block";
    }
};

// ==========================================
// BUNDESWEITER LADETARIF-KATALOG (Git-Sync & Offline-Fallback)
// ==========================================
const DEFAULT_TARIFF_CATALOG = {
    version: "1.3.8",
    tariffs_updated_readable: "20.10.2026",
    cpo_tariffs: {
        stadtwerke_hockenheim: {
            keywords: ["stadtwerke", "hockenheim", "swh"],
            name: "Stadtwerke Hockenheim / Ladenetz",
            adhoc: { ac: 0.52, dc: 0.52, hpc: 0.52, start_fee: 1.00 },
            app_name: "ladeapp / QR-Code Direkt"
        },
        enbw: {
            keywords: ["enbw"],
            name: "EnBW HyperNetz",
            adhoc: { ac: 0.59, dc: 0.69, hpc: 0.69, start_fee: 0.00 }
        },
        aral_pulse: {
            keywords: ["aral", "pulse"],
            name: "Aral pulse",
            adhoc: { ac: 0.59, dc: 0.69, hpc: 0.79, start_fee: 0.00 }
        },
        ionity: {
            keywords: ["ionity"],
            name: "IONITY",
            adhoc: { ac: 0.69, dc: 0.69, hpc: 0.69, start_fee: 0.00 }
        },
        fastned: {
            keywords: ["fastned"],
            name: "Fastned",
            adhoc: { ac: 0.59, dc: 0.69, hpc: 0.69, start_fee: 0.00 }
        },
        allego: {
            keywords: ["allego"],
            name: "Allego",
            adhoc: { ac: 0.60, dc: 0.69, hpc: 0.73, start_fee: 0.00 }
        },
        ewe_go: {
            keywords: ["ewe", "ewe go"],
            name: "EWE Go",
            adhoc: { ac: 0.52, dc: 0.52, hpc: 0.52, start_fee: 0.00 }
        },
        pfalzwerke: {
            keywords: ["pfalzwerke"],
            name: "Pfalzwerke",
            adhoc: { ac: 0.54, dc: 0.64, hpc: 0.64, start_fee: 0.00 }
        },
        tesla: {
            keywords: ["tesla", "supercharger"],
            name: "Tesla Supercharger",
            adhoc: { ac: 0.50, dc: 0.50, hpc: 0.52, start_fee: 0.00 }
        },
        shell_recharge: {
            keywords: ["shell", "recharge"],
            name: "Shell Recharge",
            adhoc: { ac: 0.59, dc: 0.69, hpc: 0.79, start_fee: 0.00 }
        },
        eon: {
            keywords: ["e.on", "eon"],
            name: "E.ON Drive",
            adhoc: { ac: 0.59, dc: 0.69, hpc: 0.69, start_fee: 0.00 }
        },
        default: {
            name: "Betreiber-Ad-hoc (Säulentarif)",
            adhoc: { ac: 0.55, dc: 0.65, hpc: 0.72, start_fee: 0.00 }
        }
    },
    emp_tariffs: {
        enbw_m: {
            name: "EnBW mobility+ (Tarif M/L)",
            rates: {
                enbw_cpo: { ac: 0.39, dc: 0.39, hpc: 0.39, start_fee: 0.00 },
                roaming: { ac: 0.49, dc: 0.59, hpc: 0.59, start_fee: 0.00 }
            }
        },
        enbw_s: {
            name: "EnBW mobility+ (Ladetarif S / Ad-hoc)",
            rates: {
                enbw_cpo: { ac: 0.59, dc: 0.59, hpc: 0.59, start_fee: 0.00 },
                swh_cpo: { ac: 0.52, dc: 0.52, hpc: 0.52, start_fee: 1.00 },
                roaming: { ac: 0.59, dc: 0.69, hpc: 0.69, start_fee: 0.00 }
            }
        },
        ewego: {
            name: "EWE Go Ladekarte",
            rates: {
                ewe_cpo: { ac: 0.52, dc: 0.52, hpc: 0.52, start_fee: 0.00 },
                roaming: { ac: 0.62, dc: 0.62, hpc: 0.62, start_fee: 0.00 }
            }
        },
        ionity_passport: {
            name: "Cupra Easy / Ionity Passport",
            rates: {
                ionity_cpo: { ac: 0.49, dc: 0.49, hpc: 0.49, start_fee: 0.00 },
                roaming: { ac: 0.59, dc: 0.69, hpc: 0.69, start_fee: 0.00 }
            }
        },
        maingau_kunde: {
            name: "Maingau Autostrom (Kunde)",
            rates: {
                all: { ac: 0.52, dc: 0.62, hpc: 0.62, start_fee: 0.00 }
            }
        },
        swh_kunde: {
            name: "Stadtwerke Hockenheim Ladekarte",
            rates: {
                swh_cpo: { ac: 0.52, dc: 0.52, hpc: 0.52, start_fee: 1.00 },
                roaming: { ac: 0.52, dc: 0.62, hpc: 0.62, start_fee: 0.00 }
            }
        }
    }
};

function getTariffCatalog() {
    try {
        const cached = localStorage.getItem("ev_tariffs_catalog");
        if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed && parsed.cpo_tariffs && parsed.emp_tariffs && parsed.version) {
                // Falls der lokale Cache älter ist als der mitgelieferte Katalog (z.B. v1.3.3 vs v1.3.8), Cache bereinigen
                const isOlder = String(parsed.version).localeCompare(String(DEFAULT_TARIFF_CATALOG.version), undefined, { numeric: true, sensitivity: 'base' }) < 0;
                if (isOlder) {
                    localStorage.setItem("ev_tariffs_catalog", JSON.stringify(DEFAULT_TARIFF_CATALOG));
                    return DEFAULT_TARIFF_CATALOG;
                }
                return parsed;
            }
        }
    } catch (e) {
        console.warn("Fehler beim Lesen des Tarif-Caches:", e);
    }
    return DEFAULT_TARIFF_CATALOG;
}

async function syncRemoteTariffs(forceAlert = false) {
    const statusTextEl = document.getElementById("tariff-sync-text");
    const statusDotEl = document.getElementById("tariff-sync-dot");
    const updateUI = (text, isOk) => {
        if (statusTextEl) statusTextEl.textContent = text;
        if (statusDotEl) statusDotEl.style.background = isOk ? "#00e676" : "#ff9100";
    };

    const sources = [
        `https://raw.githubusercontent.com/Ommi1976/ha-ev-charge-live/master/tariffs.json?_t=${Date.now()}`,
        `https://raw.githubusercontent.com/Ommi1976/ha-ev-charge-live/main/tariffs.json?_t=${Date.now()}`,
        `static/tariffs.json?_t=${Date.now()}`,
        `tariffs.json?_t=${Date.now()}`
    ];

    let downloadedData = null;
    for (const url of sources) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3500);
            const resp = await fetch(url, { signal: controller.signal, cache: "no-store" });
            clearTimeout(timeoutId);
            if (resp.ok) {
                const data = await resp.json();
                if (data && data.cpo_tariffs && data.emp_tariffs && data.version) {
                    downloadedData = data;
                    break;
                }
            }
        } catch (err) {
            console.debug("Tariff sync attempt failed for:", url, err.message);
        }
    }

    if (downloadedData) {
        localStorage.setItem("ev_tariffs_catalog", JSON.stringify(downloadedData));
        localStorage.setItem("ev_tariffs_last_sync", new Date().toISOString());
        const dateStr = downloadedData.tariffs_updated_readable || new Date().toLocaleDateString("de-DE");
        updateUI(`Katalog v${downloadedData.version} (${dateStr}) live`, true);
        if (forceAlert) {
            alert(`✅ Tarife erfolgreich synchronisiert!\nStand: ${dateStr}\nVersion: ${downloadedData.version}`);
        }
        return downloadedData;
    } else {
        const active = getTariffCatalog();
        const dateStr = active.tariffs_updated_readable || "20.10.2026";
        updateUI(`Katalog v${active.version || "1.3.8"} (${dateStr})`, false);
        if (forceAlert) {
            alert(`ℹ️ Keine Online-Verbindung zu GitHub.\nAktiver Offline-Katalog: v${active.version || "1.3.8"} (Stand ${dateStr})`);
        }
        return active;
    }
}
window.syncRemoteTariffs = syncRemoteTariffs;

// Vollautomatischer Tarif- & Ladekarten-Berater (unter Berücksichtigung von HPC, CPO & Ad-hoc)
function getAutomatedTariffComparison(operator, hasDc, neededKwh, maxPowerKw) {
    const op = (operator || "").toLowerCase();
    const kwh = Math.max(1, Number(neededKwh) || 20);
    const kw = parseFloat(maxPowerKw) || (hasDc ? 50 : 11);

    // Leistungskategorie exakt erfassen
    let powerCategory = "ac";
    if (kw >= 150) {
        powerCategory = "hpc";
    } else if (hasDc || kw >= 40) {
        powerCategory = "dc";
    }

    const catalog = getTariffCatalog();
    const userTariffs = getUserTariffs();
    const isAdhocOnly = userTariffs.mode === "adhoc" || (!userTariffs.swh && !userTariffs.enbw && !userTariffs.ewego && !userTariffs.ionity && !userTariffs.maingau);

    // Betreiber (CPO) matchen
    let matchedCpoKey = "default";
    let matchedCpo = catalog.cpo_tariffs.default;
    for (const [key, cpo] of Object.entries(catalog.cpo_tariffs)) {
        if (key === "default") continue;
        if (cpo.keywords && cpo.keywords.some(k => op.includes(k))) {
            matchedCpoKey = key;
            matchedCpo = cpo;
            break;
        }
    }

    let cards = [];

    // 1. CPO Ad-hoc (Säulentarif / Direktzahlung per Kreditkarte / QR)
    const cpoAdhocRate = (matchedCpo.adhoc && matchedCpo.adhoc[powerCategory] !== undefined)
        ? matchedCpo.adhoc[powerCategory]
        : (powerCategory === "hpc" ? 0.72 : (powerCategory === "dc" ? 0.65 : 0.55));
    const cpoStartFee = (matchedCpo.adhoc && matchedCpo.adhoc.start_fee) || 0;
    const cpoTotal = Math.round(((kwh * cpoAdhocRate) + cpoStartFee) * 100) / 100;
    const isSwh = matchedCpoKey === "stadtwerke_hockenheim";
    const adhocCardName = isSwh ? "Stadtwerke Hockenheim (ladeapp / Direkt)" : `${matchedCpo.name} (Ad-hoc / Direkt)`;
    const isDirectAdhocChoice = isAdhocOnly;

    cards.push({
        name: adhocCardName,
        rate: `${cpoAdhocRate.toFixed(2).replace('.', ',')} €/kWh${cpoStartFee > 0 ? ' + ' + cpoStartFee.toFixed(2).replace('.', ',') + ' €' : ''}`,
        totalCost: cpoTotal,
        isHomeCpo: true,
        isUserContract: isDirectAdhocChoice,
        isAdhocChoice: isDirectAdhocChoice,
        badge: isDirectAdhocChoice ? "Meine Zahlart (Ad-hoc)" : "Direktzahlung"
    });

    // 2. Stadtwerke Hockenheim Ladekarte
    if (!isAdhocOnly && userTariffs.swh) {
        const perKwh = isSwh
            ? (catalog.emp_tariffs.swh_kunde.rates.swh_cpo[powerCategory] || 0.52)
            : (powerCategory !== "ac" ? 0.62 : 0.52);
        const startFee = isSwh ? 1.00 : 0.00;
        const total = Math.round(((kwh * perKwh) + startFee) * 100) / 100;
        cards.push({
            name: isSwh ? "Stadtwerke Hockenheim Ladekarte" : "Stadtwerke Hockenheim (Roaming)",
            rate: `${perKwh.toFixed(2).replace('.', ',')} €/kWh${startFee > 0 ? ' + 1,00 €' : ''}`,
            totalCost: total,
            isHomeCpo: isSwh,
            isUserContract: true,
            isAdhocChoice: false,
            badge: isSwh ? "Mein Vertrag" : "Mein Vertrag (Roaming)"
        });
    }

    // 3. EnBW mobility+
    const isEnbwCpo = matchedCpoKey === "enbw";
    if (!isAdhocOnly && userTariffs.enbw) {
        const rates = catalog.emp_tariffs.enbw_m.rates;
        const perKwh = isEnbwCpo ? rates.enbw_cpo[powerCategory] : rates.roaming[powerCategory];
        const total = Math.round((kwh * perKwh) * 100) / 100;
        cards.push({
            name: isEnbwCpo ? "EnBW mobility+ (Tarif M/L)" : "EnBW mobility+ (Vorteils-Roaming)",
            rate: `${perKwh.toFixed(2).replace('.', ',')} €/kWh`,
            totalCost: total,
            isHomeCpo: isEnbwCpo,
            isUserContract: true,
            isAdhocChoice: false,
            badge: "Mein Vertrag (M/L)"
        });
    } else {
        const rates = catalog.emp_tariffs.enbw_s.rates;
        let perKwh = 0.59;
        let startFee = 0.00;
        if (isEnbwCpo) {
            perKwh = rates.enbw_cpo[powerCategory] || 0.59;
        } else if (isSwh) {
            perKwh = rates.swh_cpo.ac;
            startFee = rates.swh_cpo.start_fee;
        } else {
            perKwh = rates.roaming[powerCategory] || 0.69;
        }
        const total = Math.round(((kwh * perKwh) + startFee) * 100) / 100;
        const isEnbwChoice = isAdhocOnly && isEnbwCpo;
        cards.push({
            name: isEnbwCpo ? "EnBW mobility+ (Ladetarif S)" : "EnBW mobility+ (Roaming S)",
            rate: `${perKwh.toFixed(2).replace('.', ',')} €/kWh${startFee > 0 ? ' + ' + startFee.toFixed(2).replace('.', ',') + ' €' : ''}`,
            totalCost: total,
            isHomeCpo: isEnbwCpo,
            isUserContract: isEnbwChoice,
            isAdhocChoice: isEnbwChoice,
            badge: isEnbwChoice ? "Meine Zahlart (Ad-hoc)" : (isEnbwCpo ? "Eigennetz (0€ Abo)" : "Roaming (0€ Abo)")
        });
    }

    // 4. EWE Go
    const isEweCpo = matchedCpoKey === "ewe_go";
    if (!isAdhocOnly && userTariffs.ewego) {
        const rates = catalog.emp_tariffs.ewego.rates;
        const perKwh = isEweCpo ? rates.ewe_cpo[powerCategory] : rates.roaming[powerCategory];
        const total = Math.round((kwh * perKwh) * 100) / 100;
        cards.push({
            name: "EWE Go Ladekarte",
            rate: `${perKwh.toFixed(2).replace('.', ',')} €/kWh`,
            totalCost: total,
            isHomeCpo: isEweCpo,
            isUserContract: true,
            isAdhocChoice: false,
            badge: "Mein Vertrag"
        });
    }

    // 5. Ionity Passport / Cupra Charging
    const isIonityCpo = matchedCpoKey === "ionity";
    if (!isAdhocOnly && (userTariffs.ionity || isIonityCpo)) {
        const rates = catalog.emp_tariffs.ionity_passport.rates;
        const perKwh = userTariffs.ionity ? (isIonityCpo ? rates.ionity_cpo[powerCategory] : rates.roaming[powerCategory]) : 0.69;
        const total = Math.round((kwh * perKwh) * 100) / 100;
        cards.push({
            name: "Cupra Easy / Ionity Passport",
            rate: `${perKwh.toFixed(2).replace('.', ',')} €/kWh`,
            totalCost: total,
            isHomeCpo: isIonityCpo,
            isUserContract: Boolean(userTariffs.ionity),
            isAdhocChoice: false,
            badge: userTariffs.ionity ? "Mein Vertrag (Passport)" : "Standard"
        });
    }

    // 6. Maingau Autostrom
    if (!isAdhocOnly && userTariffs.maingau) {
        const rates = catalog.emp_tariffs.maingau_kunde.rates;
        const perKwh = rates.all[powerCategory] || (powerCategory === "ac" ? 0.52 : 0.62);
        const total = Math.round((kwh * perKwh) * 100) / 100;
        cards.push({
            name: "Maingau Autostrom (Kunde)",
            rate: `${perKwh.toFixed(2).replace('.', ',')} €/kWh`,
            totalCost: total,
            isHomeCpo: false,
            isUserContract: true,
            isAdhocChoice: false,
            badge: "Mein Vertrag"
        });
    }

    // Dubletten nach Namen filtern
    const uniqueCards = [];
    const seenNames = new Set();
    for (const c of cards) {
        if (!seenNames.has(c.name)) {
            seenNames.add(c.name);
            uniqueCards.push(c);
        }
    }

    // Nach Gesamtkosten aufsteigend sortieren
    uniqueCards.sort((a, b) => a.totalCost - b.totalCost);

    const cheapest = uniqueCards[0];
    const userBest = uniqueCards.find(c => c.isUserContract) || cheapest;
    const mostExpensive = uniqueCards[uniqueCards.length - 1];
    const savings = Math.max(0, (mostExpensive.totalCost - userBest.totalCost));

    return {
        cards: uniqueCards,
        cheapest: userBest,
        savings: savings > 0.40 ? savings.toFixed(2).replace('.', ',') : null,
        powerCategory,
        cpoName: matchedCpo.name
    };
}

// Toggle Favorite
window.toggleFavorite = async function(stationId) {
    const station = activeStations.find(s => String(s.id) === String(stationId)) ||
                    favorites.find(f => String(f.id) === String(stationId)) ||
                    (window.currentSheetStation && String(window.currentSheetStation.id) === String(stationId) ? window.currentSheetStation : null);
    if (!station) return;

    if (useHaRemote()) {
        const enable = !isFavorite(stationId);
        const result = await setStationListViaHa("favorites", station, enable);
        showHaCommandToast(result, enable
            ? `★ "${station.name}" in Home Assistant als Favorit gespeichert`
            : `☆ "${station.name}" aus den Favoriten in Home Assistant entfernt`);
        return;
    }

    let isFavNow = false;
    try {
        const res = await fetchAddonJson("api/favorites/toggle", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(station)
        });
        isFavNow = res.is_favorite;
    } catch (err) {
        // Standalone LocalStorage fallback für APK
        let localFavs = [];
        try { localFavs = JSON.parse(localStorage.getItem("ev_favorites") || "[]"); } catch (e) {}
        const idx = localFavs.findIndex(f => String(f.id) === String(stationId));
        if (idx >= 0) {
            localFavs.splice(idx, 1);
            isFavNow = false;
        } else {
            localFavs.push(station);
            isFavNow = true;
        }
        localStorage.setItem("ev_favorites", JSON.stringify(localFavs));
        favorites = localFavs;
    }

    await loadFavorites();
    renderMapMarkers(activeStations, false);
    showToast(
        isFavNow ? `★ "${station.name}" zu Favoriten hinzugefügt` : `☆ "${station.name}" aus Favoriten entfernt`,
        "success"
    );
};

// Render Favorites Modal
function renderFavoritesModal() {
    const list = document.getElementById("favorites-list");
    if (!favorites || favorites.length === 0) {
        list.innerHTML = "<p style='color: var(--text-secondary);'>Noch keine Favoriten hinzugefügt. Tippe auf eine Säule auf der Karte und wähle oben '☆ Als Favorit', um sie zu überwachen.</p>";
        return;
    }

    let sourceHint = "";
    if (useHaRemote()) {
        const snap = haBridgeCache.snapshot;
        const when = snap && snap.reportedAt
            ? new Date(snap.reportedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
            : "";
        sourceHint = snap
            ? `<p class="ha-bridge-hint">🏠 Live-Daten vom Home-Assistant-Add-on${when ? ` · Stand ${escapeHtml(when)} Uhr` : ""}</p>`
            : `<p class="ha-bridge-hint">⚠️ Home Assistant gerade nicht erreichbar${haBridgeCache.error ? ` (${escapeHtml(haBridgeCache.error)})` : ""} – letzter bekannter Stand</p>`;
    }

    list.innerHTML = sourceHint + favorites.map(f => {
        let statusBadge = "badge-success";
        if (f.status === "OUTOFORDER") statusBadge = "badge-danger";
        else if (f.free_slots === 0) statusBadge = "badge-danger";
        else if (f.free_slots < f.total_slots) statusBadge = "badge-warning";

        const safeJsId = escapeJsString(f.id);
        const watched = isWatched(f.id);
        const connLineHtml = (f.connectors && f.connectors.length > 0) ? `
            <div style="font-size: 0.72rem; margin-top: 4px; display: flex; gap: 8px; flex-wrap: wrap;">
                ${f.connectors.map((c, i) => {
                    const isFree = (c.status === 'AVAILABLE' || c.status === 'FREE');
                    const lp = c.point_label || `LP ${i + 1}`;
                    const dur = !isFree && c.duration_str ? ` (${c.duration_str})` : '';
                    const color = isFree ? '#10b981' : '#f87171';
                    return `<span style="color: ${color}; font-weight: 600;">${isFree ? '✅' : '⛔'} ${escapeHtml(lp)}${escapeHtml(dur)}</span>`;
                }).join("")}
            </div>
        ` : '';

        return `
            <div class="favorite-card">
                <div class="favorite-info" style="cursor:pointer;" onclick="openStationDetailSheetById('${safeJsId}')" title="Details öffnen">
                    <h4>${escapeHtml(f.name)}</h4>
                    <div class="sub">${escapeHtml(f.operator)} &bull; ${escapeHtml(f.address)}</div>
                    ${connLineHtml}
                </div>
                <div class="favorite-actions">
                    <span class="badge ${statusBadge}">${Number(f.free_slots || 0)} / ${Number(f.total_slots || 0)} frei</span>
                    <button class="btn-watch-inline ${watched ? 'active' : ''}" title="${watched ? 'Beobachten aktiv (Push-Alarm bei freiem Platz). Klick zum Deaktivieren' : 'Station beobachten (Push-Alarm bei freiem Platz aktivieren)'}" onclick="event.stopPropagation(); toggleWatchlist('${safeJsId}')">${watched ? '🔔' : '🔕'}</button>
                    <button class="btn-remove" title="Aus Favoriten entfernen" onclick="event.stopPropagation(); toggleFavorite('${safeJsId}')">🗑️</button>
                </div>
            </div>
        `;
    }).join("");
}

// Quick Search
window.applyQuickSearch = function(city, zip) {
    currentDeviceCoords = null;
    if (userLocationMarker) {
        map.removeLayer(userLocationMarker);
        userLocationMarker = null;
    }
    const inputCity = document.getElementById("input-city");
    if (inputCity) inputCity.value = city;
    const inputZip = document.getElementById("input-zip");
    if (inputZip) inputZip.value = zip;
    const drawer = document.getElementById("search-drawer");
    if (drawer) drawer.classList.add("hidden");
    updateHudLocationText();
    searchStations(true);
};

// Current Location: Primär Handy-GPS (HTML5 Geolocation) mit HA Fallback
window.applyCurrentLocation = async function() {
    const btn = document.getElementById("btn-current-location");
    const origText = btn ? btn.innerHTML : "📍 Primäres Handy-GPS";
    if (btn) {
        btn.innerHTML = "📍 Satelliten suchen...";
        btn.disabled = true;
    }

    const setPositionOnMap = async (lat, lon, accuracy, sourceName) => {
        currentDeviceCoords = { lat: lat, lon: lon };
        document.getElementById("input-city").value = "📍 " + sourceName;
        document.getElementById("input-zip").value = "";

        const drawer = document.getElementById("search-drawer");
        if (drawer) drawer.classList.add("hidden");
        updateHudLocationText();

        if (userLocationMarker) {
            map.removeLayer(userLocationMarker);
        }

        const userIcon = L.divIcon({
            className: "custom-div-icon",
            html: `<div class="user-location-pin">📱</div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
            popupAnchor: [0, -18]
        });

        userLocationMarker = L.marker([lat, lon], { icon: userIcon, zIndexOffset: 1000 })
            .bindPopup(`<b>📱 Dein Standort</b><br>${escapeHtml(sourceName)}<br>GPS-Genauigkeit: ±${Math.round(accuracy)} m`)
            .addTo(map);

        await searchStations(true);
        showToast(`📍 GPS-Standort: ${sourceName} (±${Math.round(accuracy)}m)`, "success");
    };

    // 1. Primär: Natives Handy-GPS per navigator.geolocation
    if ("geolocation" in navigator) {
        try {
            const pos = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, {
                    enableHighAccuracy: true,
                    timeout: 8000,
                    maximumAge: 10000
                });
            });
            if (pos && pos.coords) {
                await setPositionOnMap(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy || 5, "Handy-GPS (Live)");
                if (btn) {
                    btn.innerHTML = origText;
                    btn.disabled = false;
                }
                return;
            }
        } catch (geoErr) {
            console.warn("Natives GPS nicht verfügbar oder abgewiesen, wechsle zu HA-Fallback:", geoErr);
        }
    }

    // 2. Sekundär: Fallback auf Home Assistant device_tracker
    try {
        const resp = await fetch(getApiUrl("api/device-location"));
        if (resp.ok) {
            const data = await resp.json();
            if (data.latitude && data.longitude) {
                await setPositionOnMap(data.latitude, data.longitude, data.accuracy || 25, data.name || "HA Device Tracker");
                return;
            }
        }
        showToast("Konnte Standort weder per GPS noch über HA ermitteln.", "warning");
    } catch (err) {
        showToast("Fehler bei Standortabfrage: " + err, "error");
    } finally {
        if (btn) {
            btn.innerHTML = origText;
            btn.disabled = false;
        }
    }
};

// Sync Action
async function triggerSync() {
    const btn = document.getElementById("btn-sync");
    btn.innerHTML = `<span class="btn-icon">⏳</span><span class="btn-text">Sync...</span>`;
    try {
        if (useHaRemote()) {
            // Add-on acknowledges only after its live poll, so the reload below gets fresh data
            const result = await runHaCommand("sync", {}, { ackTimeoutMs: 25000 });
            if (!result.ok) throw new Error(result.error);
        } else {
            await fetch(getApiUrl("api/sync"), { method: "POST" });
        }
        await loadFavorites();
        await loadWatchlist();
        await searchStations(false);
        showToast("🔄 Live-Daten erfolgreich synchronisiert", "success");
    } catch (err) {
        showToast("Fehler bei Synchronisation: " + err, "error");
    } finally {
        btn.innerHTML = `<span class="btn-icon">🔄</span><span class="btn-text">Sync</span>`;
    }
}

// Test Push
async function sendTestPush() {
    const btn = document.getElementById("btn-test-push");
    btn.disabled = true;
    btn.innerText = "Sende Test-Push...";
    try {
        if (useHaRemote()) {
            const result = await runHaCommand("test_notify", {}, { ackTimeoutMs: 15000 });
            if (result.ok) showToast("✅ Test-Benachrichtigung über Home Assistant verschickt!", "success");
            else showToast(`⚠️ Test-Push fehlgeschlagen: ${result.error}`, "warning");
            return;
        }
        const resp = await fetch(getApiUrl("api/test-notify"), { method: "POST" });
        const res = await resp.json();
        if (res.delivered) {
            showToast("✅ Test-Benachrichtigung erfolgreich an Home Assistant übermittelt!", "success");
        } else {
            showToast("⚠️ Serviceaufruf abgesetzt. Prüfe ob der HA Notify-Service existiert.", "warning");
        }
    } catch (err) {
        showToast("Fehler beim Senden: " + err, "error");
    } finally {
        btn.disabled = false;
        btn.innerText = "🔔 Test-Push an Smartphone senden";
    }
}

// Save Settings
async function saveSettings(e) {
    e.preventDefault();
    const trackerInput = document.getElementById("cfg-device-tracker-entity");
    const existingLoc = currentConfig.location_defaults || {};
    const existingPoll = currentConfig.polling || {};
    const existingNotify = currentConfig.notifications || {};
    const existingHa = currentConfig.home_assistant_integration || {};

    // User Tariffs
    const isAdhoc = document.getElementById("cfg-mode-adhoc") ? document.getElementById("cfg-mode-adhoc").checked : true;
    const tariffs = {
        mode: isAdhoc ? "adhoc" : "contracts",
        swh: isAdhoc ? false : (document.getElementById("cfg-tariff-swh") ? document.getElementById("cfg-tariff-swh").checked : false),
        enbw: isAdhoc ? false : (document.getElementById("cfg-tariff-enbw") ? document.getElementById("cfg-tariff-enbw").checked : false),
        ewego: isAdhoc ? false : (document.getElementById("cfg-tariff-ewego") ? document.getElementById("cfg-tariff-ewego").checked : false),
        ionity: isAdhoc ? false : (document.getElementById("cfg-tariff-ionity") ? document.getElementById("cfg-tariff-ionity").checked : false),
        maingau: isAdhoc ? false : (document.getElementById("cfg-tariff-maingau") ? document.getElementById("cfg-tariff-maingau").checked : false)
    };
    localStorage.setItem("ev_user_tariffs", JSON.stringify(tariffs));

    // HA Remote connection
    const haServerUrlInput = document.getElementById("cfg-ha-server-url");
    const haTokenInput = document.getElementById("cfg-ha-token");
    if (haServerUrlInput) localStorage.setItem("ev_ha_server_url", haServerUrlInput.value.trim());
    if (haTokenInput) localStorage.setItem("ev_ha_token", haTokenInput.value.trim());
    resetHaBridgeCache();

    const deviceCheckboxes = document.querySelectorAll('input[name="cfg-target-device"]:checked');
    let targetDevices = Array.from(deviceCheckboxes).map(cb => cb.value);
    if (targetDevices.length === 0) {
        targetDevices = ["notify.mobile_app_2407fpn8eg"];
    }

    const newConfig = {
        polling: {
            ...existingPoll,
            interval_seconds: parseInt(document.getElementById("cfg-interval").value, 10) || 60,
            request_timeout: existingPoll.request_timeout || 15
        },
        location_defaults: {
            city: existingLoc.city || "Hockenheim",
            postal_code: existingLoc.postal_code || "68766",
            latitude: existingLoc.latitude || 49.317584,
            longitude: existingLoc.longitude || 8.545261,
            search_radius_meters: existingLoc.search_radius_meters || 5000,
            device_tracker_entity: trackerInput ? trackerInput.value.trim() : (existingLoc.device_tracker_entity || "device_tracker.2407fpn8eg")
        },
        tariffs: tariffs,
        ha_server_url: haServerUrlInput ? haServerUrlInput.value.trim() : "",
        ha_token: haTokenInput ? haTokenInput.value.trim() : "",
        notifications: {
            ...existingNotify,
            enabled: document.getElementById("cfg-notify-enabled").checked,
            service: targetDevices[0] || "notify.mobile_app_2407fpn8eg",
            target_devices: targetDevices,
            cooldown_minutes: parseInt(document.getElementById("cfg-notify-cooldown").value, 10) || 10,
            min_free_slots_to_trigger: existingNotify.min_free_slots_to_trigger || 1,
            notify_on_all_busy: existingNotify.notify_on_all_busy || false,
            title_template: document.getElementById("cfg-title-tpl").value,
            message_template: document.getElementById("cfg-msg-tpl").value
        },
        home_assistant_integration: {
            ...existingHa,
            entity_prefix: document.getElementById("cfg-prefix").value.trim(),
            create_device_tracker: document.getElementById("cfg-device-tracker").checked,
            fire_ha_events: document.getElementById("cfg-fire-events").checked
        }
    };

    try {
        const resp = await fetch(getApiUrl("api/config"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(newConfig)
        });
        if (resp.ok) {
            showToast("✅ Einstellungen erfolgreich gespeichert!", "success");
            closeModal("modal-settings");
            await loadConfig();
            renderMapMarkers(activeStations, false);
        } else {
            throw new Error(`HTTP ${resp.status}`);
        }
    } catch (err) {
        // Standalone LocalStorage fallback (persisted so settings survive an APK restart)
        currentConfig = { ...currentConfig, ...newConfig };
        try {
            const { ha_token, ...persistable } = currentConfig;
            localStorage.setItem("ev_local_config", JSON.stringify(persistable));
        } catch (e) {
            console.warn("Einstellungen konnten nicht lokal gespeichert werden:", e);
        }
        showToast("✅ Einstellungen lokal gespeichert!", "success");
        closeModal("modal-settings");
        renderMapMarkers(activeStations, false);
    }
}

// Modal Helpers & Bottom Nav Synchronization
const MODAL_TO_TAB_MAP = {
    "modal-route-planner": "route",
    "modal-qr-scanner": "qr",
    "modal-cupra-obd": "cupra",
    "modal-logbook": "logbook"
};

function closeAllModals(exceptId = null) {
    document.querySelectorAll(".modal.active").forEach(m => {
        if (m.id !== exceptId) {
            if (m.id === "modal-qr-scanner" && typeof stopQrCamera === "function") {
                stopQrCamera();
            }
            m.classList.remove("active");
        }
    });
}

window.openModal = function(id) {
    closeAllModals(id);
    const el = document.getElementById(id);
    if (el) el.classList.add("active");

    if (id === "modal-cupra-obd" && typeof window.refreshObdBondedDevices === "function") {
        window.refreshObdBondedDevices(true);
    }

    const mappedTab = MODAL_TO_TAB_MAP[id];
    if (mappedTab) {
        document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
        const activeTab = document.getElementById(`tab-nav-${mappedTab}`);
        if (activeTab) activeTab.classList.add("active");
    }
};

window.closeModal = function(id) {
    if (id === "modal-qr-scanner" && typeof stopQrCamera === "function") {
        stopQrCamera();
    }
    const el = document.getElementById(id);
    if (el) el.classList.remove("active");

    // If no modal remains open, highlight 'Karte' tab
    if (!document.querySelector(".modal.active")) {
        document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
        const mapTab = document.getElementById("tab-nav-map");
        if (mapTab) mapTab.classList.add("active");
    }
};

// Send to Cupra Born / Car
window.sendToCupra = async function(stationId) {
    const station = activeStations.find(s => String(s.id) === String(stationId)) ||
                    favorites.find(f => String(f.id) === String(stationId));
    if (!station) return;

    try {
        const resp = await fetch(getApiUrl("api/send-to-cupra"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(station)
        });
        if (resp.ok) {
            showToast(`🚗 Route zu "${station.name}" wurde an deinen Cupra Born übertragen!`, "success");
        } else {
            showToast("Fehler bei Übertragung an Cupra Born.", "error");
        }
    } catch (err) {
        showToast("Fehler bei Übertragung an Cupra Born: " + err, "error");
    }
};

/* ==========================================================================
   5 Mobile Design Themes & Theme Switching
   ========================================================================== */
const THEMES = ["cupra", "cyan", "glass", "emerald", "nordic"];

function initTheme() {
    const savedTheme = localStorage.getItem("ev_active_theme") || "cupra";
    applyTheme(savedTheme, false);

    const themeSelect = document.getElementById("cfg-theme-select");
    if (themeSelect) {
        themeSelect.value = savedTheme;
        themeSelect.addEventListener("change", (e) => {
            applyTheme(e.target.value, true);
        });
    }

    const savedAmoled = localStorage.getItem("ev_amoled_theme");
    if (savedAmoled === "true") {
        document.body.classList.add("amoled-mode");
    }
    updateThemeIcon(savedAmoled === "true");
}

function applyTheme(themeName, notify = true) {
    THEMES.forEach(t => document.body.classList.remove("theme-" + t));
    const target = THEMES.includes(themeName) ? themeName : "cupra";
    document.body.classList.add("theme-" + target);
    localStorage.setItem("ev_active_theme", target);

    const themeSelect = document.getElementById("cfg-theme-select");
    if (themeSelect && themeSelect.value !== target) {
        themeSelect.value = target;
    }

    const labels = {
        cupra: "🚗 Cupra Born Cockpit (Kupfer)",
        cyan: "🗺️ Bottom-Sheet Maps (Cyan)",
        glass: "💎 Frosted Glass HUD (Transluzent)",
        emerald: "🌿 Emerald Eco (Smaragd & Nacht)",
        nordic: "❄️ Nordic Stealth (Titan & Eisblau)"
    };

    if (notify) {
        showToast(`🎨 Theme aktiviert: ${labels[target]}`, "success");
    }
}

function toggleAmoledTheme() {
    const isNowAmoled = document.body.classList.toggle("amoled-mode");
    localStorage.setItem("ev_amoled_theme", isNowAmoled);
    updateThemeIcon(isNowAmoled);
    showToast(isNowAmoled ? "🌙 AMOLED Schwarzmodus aktiviert" : "☀️ Standard-Design aktiviert", "info");
}

function updateThemeIcon(isAmoled) {
    const icon = document.getElementById("theme-icon");
    if (icon) {
        icon.textContent = isAmoled ? "☀️" : "🌙";
    }
}

/* ==========================================================================
   Filter Chips
   ========================================================================== */
function setupFilterChips() {
    const chips = document.querySelectorAll(".filter-chips-scroll .chip, .filter-chips-bar .chip");
    chips.forEach(chip => {
        chip.addEventListener("click", () => {
            chips.forEach(c => c.classList.remove("active"));
            chip.classList.add("active");
            activeFilter = chip.getAttribute("data-filter") || "all";
            renderMapMarkers(activeStations, false);
        });
    });
}

/* ==========================================================================
   Cupra Born State & Hybrid SoC Management
   ========================================================================== */
function initCupraState() {
    try {
        const saved = localStorage.getItem("ev_cupra_config");
        if (saved) {
            const parsed = JSON.parse(saved);
            cupraState.batteryCapacity = parsed.batteryCapacity || 58;
            cupraState.targetSoc = parsed.targetSoc || 80;
            cupraState.manualSoc = parsed.manualSoc || 42;
            cupraState.soh = parsed.soh || 98;
            cupraState.haSensor = parsed.haSensor || "sensor.cupra_born_battery_level";
        }
    } catch (e) {
        console.warn("Could not load cupra state from localStorage", e);
    }

    // Populate modal inputs
    const r58 = document.getElementById("battery-58");
    const r77 = document.getElementById("battery-77");
    if (r58 && r77) {
        if (cupraState.batteryCapacity === 77) r77.checked = true;
        else r58.checked = true;
    }

    const sohSlider = document.getElementById("born-soh-slider");
    const sohDisplay = document.getElementById("soh-display-val");
    const sohMetric = document.getElementById("born-soh-metric");
    if (sohSlider && sohDisplay) {
        sohSlider.value = cupraState.soh || 98;
        sohDisplay.textContent = `${cupraState.soh || 98} %`;
        if (sohMetric) {
            const usable = ((cupraState.batteryCapacity || 58) * ((cupraState.soh || 98) / 100)).toFixed(1);
            sohMetric.textContent = `${usable} kWh netto`;
        }
        sohSlider.addEventListener("input", (e) => {
            const v = parseInt(e.target.value, 10);
            sohDisplay.textContent = `${v} %`;
            if (sohMetric) {
                const usable = ((cupraState.batteryCapacity || 58) * (v / 100)).toFixed(1);
                sohMetric.textContent = `${usable} kWh netto`;
            }
        });
    }

    const targetSlider = document.getElementById("born-target-soc");
    const targetVal = document.getElementById("target-soc-val");
    if (targetSlider && targetVal) {
        targetSlider.value = cupraState.targetSoc;
        targetVal.textContent = cupraState.targetSoc + " %";
    }

    const manualSlider = document.getElementById("born-manual-soc");
    const manualVal = document.getElementById("manual-soc-val");
    if (manualSlider && manualVal) {
        manualSlider.value = cupraState.manualSoc;
        manualVal.textContent = cupraState.manualSoc + " %";
    }

    const haSensorInput = document.getElementById("cfg-ha-cupra-sensor");
    if (haSensorInput) {
        haSensorInput.value = cupraState.haSensor;
    }

    updateCupraUi();
}

function updateCupraUi() {
    const currentSoc = getActiveSoc();
    const displayText = document.getElementById("soc-display-text");
    const badge = document.getElementById("soc-status-badge");
    const tabSoc = document.getElementById("tab-label-soc");

    if (displayText) {
        displayText.textContent = `Born: ${currentSoc}%`;
    }
    if (tabSoc) {
        tabSoc.textContent = `Born: ${currentSoc}%`;
    }

    if (badge) {
        badge.className = "soc-pill";
        if (cupraState.source === "ble") {
            badge.classList.add("soc-ble");
            badge.textContent = "vLinker BLE";
        } else if (cupraState.source === "ha") {
            badge.classList.add("soc-ha");
            badge.textContent = "HA Sync";
        } else {
            badge.classList.add("soc-manual");
            badge.textContent = "Manuell";
        }
    }
}

window.switchNavTab = function(tab) {
    document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
    const activeEl = document.getElementById(`tab-nav-${tab}`);
    if (activeEl) activeEl.classList.add("active");

    if (tab === "map") {
        closeAllModals();
        if (map) map.invalidateSize();
    }
};

window.saveCupraSettings = function() {
    const r77 = document.getElementById("battery-77");
    cupraState.batteryCapacity = (r77 && r77.checked) ? 77 : 58;

    const targetSlider = document.getElementById("born-target-soc");
    if (targetSlider) cupraState.targetSoc = parseInt(targetSlider.value, 10) || 80;

    const manualSlider = document.getElementById("born-manual-soc");
    if (manualSlider) {
        cupraState.manualSoc = parseInt(manualSlider.value, 10) || 42;
        if (cupraState.source === "manual") {
            cupraState.liveSoc = null;
        }
    }

    const sohSlider = document.getElementById("born-soh-slider");
    if (sohSlider) cupraState.soh = parseInt(sohSlider.value, 10) || 98;

    const haSensorInput = document.getElementById("cfg-ha-cupra-sensor");
    if (haSensorInput) cupraState.haSensor = haSensorInput.value.trim();

    try {
        localStorage.setItem("ev_cupra_config", JSON.stringify({
            batteryCapacity: cupraState.batteryCapacity,
            targetSoc: cupraState.targetSoc,
            manualSoc: cupraState.manualSoc,
            soh: cupraState.soh,
            haSensor: cupraState.haSensor
        }));
    } catch (e) {
        console.warn("Storage save failed", e);
    }

    updateCupraUi();
    renderMapMarkers(activeStations, false);
    closeModal("modal-cupra-obd");
    showToast(`🚗 Cupra Born Parameter gespeichert (${cupraState.batteryCapacity} kWh, SoH: ${cupraState.soh}%, Ziel: ${cupraState.targetSoc}%)`, "success");
};

/* ==========================================================================
   Vgate vLinker FS Dual-Stack Bluetooth Driver (Classic SPP / RFCOMM + BLE GATT)
   inkl. Live-Diagnose-Konsole, Bonded-Device-Picker & Manuelles AT/UDS-Terminal
   ========================================================================== */
let obdLogEntries = [];
let cachedBondedDevices = [];
let obdSppListenersRegistered = false;

function formatObdTimestamp() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${ms}`;
}

function obdLog(level, message) {
    const ts = formatObdTimestamp();
    const upperLevel = String(level || "info").toUpperCase();
    const lineText = `[${ts}] [${upperLevel}] ${message}`;
    obdLogEntries.push({ ts, level: String(level || "info").toLowerCase(), text: lineText });
    if (obdLogEntries.length > 350) {
        obdLogEntries.shift();
    }
    console.log(`[OBD-${upperLevel}]`, message);

    const logEl = document.getElementById("obd-debug-log");
    if (logEl) {
        const div = document.createElement("div");
        div.className = `obd-log-line obd-log-${String(level || "info").toLowerCase()}`;
        div.textContent = lineText;
        logEl.appendChild(div);
        while (logEl.childNodes.length > 350) {
            logEl.removeChild(logEl.firstChild);
        }
        logEl.scrollTop = logEl.scrollHeight;
    }
}
window.obdLog = obdLog;

window.toggleObdDebugPanel = function() {
    const panel = document.getElementById("obd-debug-panel");
    const label = document.getElementById("obd-debug-toggle-label");
    if (!panel) return;
    const isHidden = panel.style.display === "none";
    panel.style.display = isHidden ? "block" : "none";
    if (label) label.textContent = isHidden ? "Ausblenden ▲" : "Anzeigen ▼";
};

window.clearObdDebugLog = function() {
    obdLogEntries = [];
    const logEl = document.getElementById("obd-debug-log");
    if (logEl) logEl.innerHTML = "";
    obdLog("info", "Diagnose-Log geleert.");
};

window.copyObdDebugLog = async function() {
    const metaEl = document.getElementById("obd-diag-meta");
    const header = [
        "=== EV Charge Live OBD2 Diagnose-Protokoll (v1.3.21) ===",
        `Zeitpunkt: ${new Date().toISOString()}`,
        `Treiber-Info: ${metaEl ? metaEl.textContent : "n/a"}`,
        `Verbindungsstatus: connected=${bleConnection.connected}, connecting=${bleConnection.connecting}, transport=${bleConnection.transport || "none"}, deviceId=${bleConnection.deviceId || "none"}`,
        `Auto-Reconnect: enabled=${isObdAutoReconnectEnabled()}, attempts=${bleAutoReconnectAttempts}, manualDisc=${bleManualDisconnected}`,
        `Gekoppelte Geräte (${cachedBondedDevices.length}): ${JSON.stringify(cachedBondedDevices)}`,
        "--- LOG VERLAUF ---"
    ].join("\n");

    const fullText = header + "\n" + obdLogEntries.map(e => e.text).join("\n");

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(fullText);
            showToast("📋 Diagnose-Log in die Zwischenablage kopiert!", "success");
            return;
        }
    } catch (e) {
        console.warn("Clipboard API fallback:", e);
    }

    const ta = document.createElement("textarea");
    ta.value = fullText;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
        document.execCommand("copy");
        showToast("📋 Diagnose-Log in die Zwischenablage kopiert!", "success");
    } catch (err) {
        showToast("Kopieren fehlgeschlagen: " + err.message, "error");
    }
    document.body.removeChild(ta);
};

function isObdAutoReconnectEnabled() {
    return localStorage.getItem("ev_obd_autoreconnect") !== "false";
}

window.toggleObdAutoReconnect = function(checked) {
    localStorage.setItem("ev_obd_autoreconnect", checked ? "true" : "false");
    obdLog("info", `Auto-Reconnect wurde ${checked ? "AKTIVIERT" : "DEAKTIVIERT"}.`);
    if (checked) {
        bleManualDisconnected = false;
        if (!bleConnection.connected && !bleConnection.connecting) {
            scheduleObdAutoReconnect(1000);
        }
    } else {
        if (bleAutoReconnectTimer) {
            clearTimeout(bleAutoReconnectTimer);
            bleAutoReconnectTimer = null;
        }
        const statusPill = document.getElementById("obd-status-pill");
        if (statusPill && !bleConnection.connected) {
            statusPill.className = "badge badge-warning";
            statusPill.textContent = "Nicht verbunden";
        }
    }
};

function scheduleObdAutoReconnect(customDelayMs = null) {
    if (bleConnection.connected || bleConnection.connecting || bleManualDisconnected) {
        return;
    }
    if (!isObdAutoReconnectEnabled()) {
        return;
    }

    if (bleAutoReconnectTimer) {
        clearTimeout(bleAutoReconnectTimer);
        bleAutoReconnectTimer = null;
    }

    let delayMs = customDelayMs;
    if (delayMs === null) {
        if (bleAutoReconnectAttempts === 0) delayMs = 5000;
        else if (bleAutoReconnectAttempts === 1) delayMs = 10000;
        else delayMs = 20000;
        bleAutoReconnectAttempts++;
    }

    const delaySec = Math.round(delayMs / 1000);
    const statusPill = document.getElementById("obd-status-pill");
    if (statusPill && !bleConnection.connected) {
        statusPill.className = "badge badge-warning";
        statusPill.textContent = `Warte auf Dongle (Auto-Reconnect in ${delaySec}s)...`;
    }

    obdLog("info", `[Auto-Reconnect] Neuer Verbindungsversuch in ${delaySec}s geplant (Versuch #${bleAutoReconnectAttempts})...`);

    bleAutoReconnectTimer = setTimeout(async () => {
        bleAutoReconnectTimer = null;
        if (bleConnection.connected || bleConnection.connecting || bleManualDisconnected) {
            return;
        }
        if (!isObdAutoReconnectEnabled()) {
            return;
        }
        obdLog("info", `[Auto-Reconnect] Führe automatischen Verbindungsversuch #${bleAutoReconnectAttempts} aus...`);
        try {
            await connectVlinkerBle(true, true);
        } catch (e) {
            // Intern geloggt
        }
    }, delayMs);
}

function ensureObdNativeListeners() {
    if (obdSppListenersRegistered) return;
    const ObdClassic = window.Capacitor?.Plugins?.ObdClassic;
    if (!ObdClassic || typeof ObdClassic.addListener !== "function") return;

    obdSppListenersRegistered = true;

    ObdClassic.addListener("obdDebug", (evt) => {
        if (evt && evt.message) {
            obdLog(evt.level || "info", `[SPP-Driver] ${evt.message}`);
        }
    });

    ObdClassic.addListener("obdData", (evt) => {
        if (!evt) return;
        const rawText = evt.data || "";
        const cleanPreview = rawText.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
        obdLog("rx", `RX (SPP ${evt.bytes || 0}B): "${cleanPreview}" [HEX: ${evt.hex || ""}]`);
        if (rawText) {
            handleBleRxChunk(rawText);
        }
    });

    ObdClassic.addListener("obdDisconnected", (evt) => {
        obdLog("warn", `SPP-Socket vom Dongle getrennt (${evt?.reason || "unbekannt"}).`);
        onBleDisconnected();
    });
}

function isLikelyObdDeviceName(name) {
    const n = String(name || "").toLowerCase();
    return (
        n.includes("vlinker") ||
        n.includes("v-link") ||
        n.includes("vlink") ||
        n.includes("obd") ||
        n.includes("icar") ||
        n.includes("vgate") ||
        n.includes("elm") ||
        n.includes("ios-vlink") ||
        n.includes("android-vlink")
    );
}

window.refreshObdBondedDevices = async function(silent = false) {
    ensureObdNativeListeners();

    const chkAuto = document.getElementById("cfg-obd-autoreconnect");
    if (chkAuto) chkAuto.checked = isObdAutoReconnectEnabled();

    const ObdClassic = window.Capacitor?.Plugins?.ObdClassic;
    const BlePlugin = window.Capacitor?.Plugins?.BluetoothLe;
    const hasObdClassic = Boolean(ObdClassic);
    const hasCapacitorBle = Boolean(BlePlugin);
    const hasWebBle = Boolean(navigator.bluetooth);

    const metaEl = document.getElementById("obd-diag-meta");
    if (metaEl) {
        metaEl.textContent = `Treiber: Classic-SPP=${hasObdClassic ? "✅" : "❌"} | BLE-GATT=${hasCapacitorBle ? "✅" : "❌"} | WebBLE=${hasWebBle ? "✅" : "❌"}`;
    }

    if (!silent) {
        obdLog("info", `Prüfe Bluetooth-Umgebung: ClassicSPP=${hasObdClassic}, BLE=${hasCapacitorBle}, WebBLE=${hasWebBle}`);
    }

    let bonded = [];
    try {
        if (hasObdClassic) {
            await ObdClassic.ensurePermissions();
            const res = await ObdClassic.getBondedDevices();
            bonded = (res && res.devices) || [];
            if (metaEl) {
                metaEl.textContent = `Treiber: Classic-SPP=✅ | BLE-GATT=${hasCapacitorBle ? "✅" : "❌"} | Android SDK=${res?.sdkInt || "?"} | BT=${res?.enabled ? "AN" : "AUS"} | Gekoppelt=${bonded.length}`;
            }
            obdLog("info", `Android Bluetooth-Status: Aktiv=${res?.enabled}, SDK=${res?.sdkInt}, Gekoppelte Geräte=${bonded.length}`);
        } else if (hasCapacitorBle) {
            await BlePlugin.initialize({ androidNeverForLocation: false });
            if (typeof BlePlugin.getBondedDevices === "function") {
                const res = await BlePlugin.getBondedDevices();
                bonded = ((res && res.devices) || []).map(d => ({
                    name: d.name || "Unbekannt",
                    address: d.deviceId,
                    deviceId: d.deviceId,
                    type: "UNKNOWN",
                    supportsSpp: true
                }));
                obdLog("info", `Gekoppelte Geräte (über BLE-Plugin): ${bonded.length}`);
            }
        }
    } catch (err) {
        obdLog("error", `Fehler beim Abrufen gekoppelter Geräte: ${err?.message || err}`);
    }

    cachedBondedDevices = bonded;

    const selectEl = document.getElementById("obd-device-select");
    const lastId = localStorage.getItem("ev_last_ble_device_id");
    let autoMatchedAddress = null;

    if (selectEl) {
        const previousVal = selectEl.value;
        selectEl.innerHTML = `<option value="auto">⚡ Automatisch erkennen (vLinker / OBD)</option>`;

        bonded.forEach((dev, idx) => {
            const addr = dev.address || dev.deviceId || "";
            const name = dev.name || "Unbekannt";
            const typeLabel = dev.type || "BT";
            const sppTag = dev.supportsSpp ? "SPP" : "BLE";
            const opt = document.createElement("option");
            opt.value = addr;
            opt.textContent = `${name} [${addr}] (${typeLabel}/${sppTag})`;
            selectEl.appendChild(opt);

            if (!autoMatchedAddress && isLikelyObdDeviceName(name)) {
                autoMatchedAddress = addr;
            }
            if (!silent || obdLogEntries.length < 15) {
                obdLog("info", `  #${idx + 1}: "${name}" [${addr}] Typ=${typeLabel}, SPP=${Boolean(dev.supportsSpp)}, UUIDs=${JSON.stringify(dev.uuids || [])}`);
            }
        });

        // Auswahl wiederherstellen oder besten Treffer vorauswählen
        if (previousVal && previousVal !== "auto" && bonded.some(d => (d.address || d.deviceId) === previousVal)) {
            selectEl.value = previousVal;
        } else if (autoMatchedAddress) {
            selectEl.value = autoMatchedAddress;
            obdLog("success", `🎯 OBD-Dongle automatisch erkannt & ausgewählt: ${autoMatchedAddress}`);
        } else if (lastId && bonded.some(d => (d.address || d.deviceId) === lastId)) {
            selectEl.value = lastId;
            obdLog("info", `Zuletzt verbundenes Gerät ausgewählt: ${lastId}`);
        } else if (bonded.length > 0 && !silent) {
            obdLog("warn", `Kein Gerät mit Namen "vLinker/OBD" gefunden. Bitte wähle deinen Dongle oben im Dropdown "Gekoppeltes Bluetooth-Gerät" manuell aus!`);
        }
    }

    return bonded;
};

// Helper for text <-> hex conversion for native Android BLE write
function textToHex(text) {
    let hex = "";
    for (let i = 0; i < text.length; i++) {
        hex += text.charCodeAt(i).toString(16).padStart(2, "0");
    }
    return hex;
}

function hexToText(hex) {
    if (!hex) return "";
    let str = "";
    const clean = hex.replace(/[^0-9a-fA-F]/g, "");
    for (let i = 0; i < clean.length; i += 2) {
        str += String.fromCharCode(parseInt(clean.substr(i, 2), 16));
    }
    return str;
}

async function connectVlinkerBle(silent = false, isAutoRetry = false) {
    ensureObdNativeListeners();

    if (bleConnection.connecting) {
        if (!silent) obdLog("warn", "Verbindungsaufbau läuft bereits...");
        return;
    }
    bleConnection.connecting = true;
    bleManualDisconnected = false;

    const ObdClassic = window.Capacitor?.Plugins?.ObdClassic;
    const BlePlugin = window.Capacitor?.Plugins?.BluetoothLe;
    const hasObdClassic = Boolean(ObdClassic);
    const hasCapacitorBle = Boolean(BlePlugin);
    const hasWebBle = Boolean(navigator.bluetooth);

    // Debug-Panel beim manuellen Verbinden automatisch sichtbar machen
    if (!silent && !isAutoRetry) {
        const debugPanel = document.getElementById("obd-debug-panel");
        const debugLabel = document.getElementById("obd-debug-toggle-label");
        if (debugPanel) debugPanel.style.display = "block";
        if (debugLabel) debugLabel.textContent = "Ausblenden ▲";
    }

    if (!hasObdClassic && !hasCapacitorBle && !hasWebBle) {
        obdLog("error", "Keine Bluetooth-Schnittstelle verfügbar (weder Native APK noch WebBluetooth).");
        if (!silent) {
            showToast("Bluetooth wird von diesem Browser nicht unterstützt. Bitte die Android-APK nutzen.", "warning");
        }
        bleConnection.connecting = false;
        return;
    }

    const btnConnect = document.getElementById("btn-obd-connect");
    const btnDisconnect = document.getElementById("btn-obd-disconnect");
    const statusPill = document.getElementById("obd-status-pill");
    const telemetryBox = document.getElementById("obd-live-telemetry");
    const selectEl = document.getElementById("obd-device-select");
    const protoEl = document.getElementById("obd-protocol-select");

    const selectedDeviceValue = selectEl ? selectEl.value : "auto";
    const selectedProto = protoEl ? protoEl.value : "auto";

    if (btnConnect) {
        btnConnect.disabled = true;
        btnConnect.textContent = "Verbinde mit vLinker...";
    }

    const NORDIC_UART_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
    const NORDIC_TX_CHAR = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
    const NORDIC_RX_CHAR = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
    const GENERIC_ELM_SERVICE = "0000ffe0-0000-1000-8000-00805f9b34fb";
    const GENERIC_ELM_CHAR = "0000ffe1-0000-1000-8000-00805f9b34fb";

    try {
        if (bleConnection.telemetryInterval) {
            clearInterval(bleConnection.telemetryInterval);
            bleConnection.telemetryInterval = null;
        }
        bleConnection.connected = false;
        bleConnection.transport = null;

        obdLog("info", `=== Starte Verbindungsaufbau (Gerät: ${selectedDeviceValue}, Protokoll: ${selectedProto}) ===`);

        // Bluetooth Adapter-Zustand prüfen vor Verbindungsversuchen
        if (hasObdClassic) {
            const permCheck = await ObdClassic.ensurePermissions().catch(() => null);
            if (permCheck && permCheck.bluetoothEnabled === false) {
                obdLog("warn", "[Bluetooth] Bluetooth-Adapter ist auf dem Smartphone ausgeschaltet.");
                if (statusPill) {
                    statusPill.className = "badge badge-warning";
                    statusPill.textContent = "Bluetooth am Handy AUS";
                }
                if (!silent) {
                    showToast("Bitte Bluetooth auf deinem Smartphone einschalten.", "warning");
                }
                if (isObdAutoReconnectEnabled() && !bleManualDisconnected) {
                    scheduleObdAutoReconnect(30000);
                }
                bleConnection.connecting = false;
                return;
            }
        }

        // Gekoppelte Geräte aktualisieren
        const bondedList = await window.refreshObdBondedDevices(true);

        // Zielgerät aus Auswahl oder Auto-Erkennung bestimmen
        let targetDevice = null;
        if (selectedDeviceValue && selectedDeviceValue !== "auto") {
            targetDevice = bondedList.find(d => (d.address || d.deviceId) === selectedDeviceValue) || {
                name: "Ausgewähltes Gerät",
                address: selectedDeviceValue,
                deviceId: selectedDeviceValue,
                type: "CLASSIC"
            };
            obdLog("info", `Manuell gewähltes Gerät: "${targetDevice.name}" [${targetDevice.address}] (${targetDevice.type})`);
        } else {
            const obdMatches = bondedList.filter(d => isLikelyObdDeviceName(d.name));
            if (obdMatches.length === 1) {
                targetDevice = obdMatches[0];
                obdLog("info", `Auto-Match (eindeutig): "${targetDevice.name}" [${targetDevice.address}] (${targetDevice.type})`);
            } else if (obdMatches.length > 1) {
                const lastId = localStorage.getItem("ev_last_ble_device_id");
                targetDevice = obdMatches.find(d => (d.address || d.deviceId) === lastId) || obdMatches[0];
                obdLog("info", `Auto-Match (aus ${obdMatches.length} OBD-Geräten): "${targetDevice.name}" [${targetDevice.address}]`);
            } else if (bondedList.length === 1) {
                targetDevice = bondedList[0];
                obdLog("info", `Nur 1 gekoppeltes Gerät vorhanden, verwende: "${targetDevice.name}" [${targetDevice.address}]`);
            } else if (bondedList.length > 1) {
                // Prüfen ob genau 1 Gerät die SPP-UUID (00001101) besitzt und kein Audio/Headset ist
                const lastId = localStorage.getItem("ev_last_ble_device_id");
                const byLast = lastId ? bondedList.find(d => (d.address || d.deviceId) === lastId) : null;
                if (byLast) {
                    targetDevice = byLast;
                    obdLog("info", `Verwende zuletzt gewähltes Gerät: "${targetDevice.name}" [${targetDevice.address}]`);
                } else {
                    obdLog("warn", `Kein Gerät heißt "vLinker/OBD" unter den ${bondedList.length} gekoppelten Geräten. Bitte wähle das gewünschte Gerät im Dropdown aus!`);
                }
            }
        }

        // =========================================================================
        // STUFE 1: BLUETOOTH CLASSIC SPP / RFCOMM (Standard für Vgate vLinker FS BT)
        // =========================================================================
        const shouldTrySpp = hasObdClassic && selectedProto !== "ble";
        if (shouldTrySpp && targetDevice && (targetDevice.address || targetDevice.deviceId)) {
            const addr = targetDevice.address || targetDevice.deviceId;
            let sppStrategy = "auto";
            if (selectedProto === "spp_secure") sppStrategy = "secure";
            else if (selectedProto === "spp_insecure") sppStrategy = "insecure";
            else if (selectedProto === "spp_reflection") sppStrategy = "reflection";

            try {
                obdLog("info", `Starte Bluetooth Classic SPP (RFCOMM) zu "${targetDevice.name}" [${addr}] (Strategie: ${sppStrategy})...`);
                showToast(`📡 Verbinde via Classic SPP mit "${targetDevice.name || addr}"...`, "info");

                const sppRes = await ObdClassic.connectSpp({
                    address: addr,
                    strategy: sppStrategy
                });

                bleConnection.connected = true;
                bleConnection.isNative = true;
                bleConnection.transport = "spp";
                bleConnection.deviceId = addr;
                bleConnection.device = { name: sppRes?.name || targetDevice.name || "vLinker FS" };
                localStorage.setItem("ev_last_ble_device_id", addr);

                obdLog("success", `✅ Classic SPP verbunden mit "${bleConnection.device.name}" [${addr}] über Strategie [${sppRes?.strategy || sppStrategy}]!`);

                if (bleManualDisconnected) {
                    obdLog("info", "Verbindungsaufbau abgebrochen (Benutzer hat 'Trennen' gedrückt).");
                    if (window.Capacitor?.Plugins?.ObdClassic) {
                        await window.Capacitor.Plugins.ObdClassic.disconnectSpp().catch(() => {});
                    }
                    onBleDisconnected();
                    bleConnection.connecting = false;
                    return;
                }
            } catch (sppErr) {
                const errMsg = sppErr?.message || String(sppErr);
                obdLog("error", `❌ Classic SPP Verbindung zu [${addr}] fehlgeschlagen: ${errMsg}`);
                if (selectedProto.startsWith("spp_")) {
                    throw new Error(`Classic SPP fehlgeschlagen: ${errMsg}`);
                }
                obdLog("warn", "Prüfe BLE-GATT Fallback...");
            }
        } else if (shouldTrySpp && !targetDevice) {
            if (selectedProto.startsWith("spp_")) {
                throw new Error("Bitte wähle zuerst deinen gekoppelten Dongle oben im Dropdown 'Gekoppeltes Bluetooth-Gerät' aus.");
            }
            obdLog("warn", "Kein gekoppeltes Zielgerät für Classic SPP ausgewählt -> versuche BLE-Suche...");
        }

        // =========================================================================
        // STUFE 2: BLUETOOTH LOW ENERGY (BLE GATT) FALLBACK
        // =========================================================================
        if (!bleConnection.connected) {
            if (hasCapacitorBle) {
                obdLog("info", "Initialisiere Native BLE (GATT)...");
                await BlePlugin.initialize({ androidNeverForLocation: false });

                try {
                    const en = await BlePlugin.isEnabled();
                    if (!en || !en.value) {
                        obdLog("warn", "Bluetooth ist deaktiviert -> fordere Aktivierung an...");
                        await BlePlugin.requestEnable();
                    }
                } catch (enErr) {
                    obdLog("warn", `BLE isEnabled Check: ${enErr?.message || enErr}`);
                }

                let bleDevice = targetDevice ? { deviceId: targetDevice.deviceId || targetDevice.address, name: targetDevice.name } : null;
                let fromBonded = Boolean(bleDevice && bleDevice.deviceId);

                if (fromBonded && targetDevice.type === "CLASSIC" && selectedProto === "auto") {
                    obdLog("warn", `Hinweis: "${targetDevice.name}" meldet Typ=CLASSIC (kein BLE). Versuche dennoch GATT-Connect, danach BLE-Scan...`);
                }

                if (!bleDevice || !bleDevice.deviceId) {
                    obdLog("info", "Öffne nativen BLE-Gerätesuchdialog (requestDevice)...");
                    bleDevice = await BlePlugin.requestDevice({
                        optionalServices: [NORDIC_UART_SERVICE, GENERIC_ELM_SERVICE, "0000fff0-0000-1000-8000-00805f9b34fb"]
                    });
                }

                if (!bleDevice || !bleDevice.deviceId) {
                    throw new Error("Kein Bluetooth-Gerät ausgewählt.");
                }

                bleConnection.isNative = true;
                bleConnection.transport = "ble";
                bleConnection.deviceId = bleDevice.deviceId;
                bleConnection.device = { name: bleDevice.name || "vLinker FS" };

                try {
                    obdLog("info", `Verbinde via BLE-GATT mit ${bleDevice.deviceId} (Timeout 12s)...`);
                    await BlePlugin.connect({ deviceId: bleDevice.deviceId, timeout: 12000 });
                } catch (connErr) {
                    obdLog("error", `BLE-GATT Direktverbindung zu ${bleDevice.deviceId} fehlgeschlagen: ${connErr?.message || connErr}`);
                    if (fromBonded) {
                        obdLog("info", "Starte interaktiven BLE-Scan-Dialog als Fallback...");
                        showToast("Gekoppelter Dongle antwortet nicht auf BLE-GATT, starte BLE-Scan...", "warning");
                        bleDevice = await BlePlugin.requestDevice({
                            optionalServices: [NORDIC_UART_SERVICE, GENERIC_ELM_SERVICE, "0000fff0-0000-1000-8000-00805f9b34fb"]
                        });
                        if (!bleDevice || !bleDevice.deviceId) throw connErr;
                        bleConnection.deviceId = bleDevice.deviceId;
                        bleConnection.device = { name: bleDevice.name || "vLinker FS" };
                        await BlePlugin.connect({ deviceId: bleDevice.deviceId, timeout: 12000 });
                    } else {
                        throw connErr;
                    }
                }

                localStorage.setItem("ev_last_ble_device_id", bleDevice.deviceId);

                obdLog("info", "Suche GATT-Services (discoverServices)...");
                await BlePlugin.discoverServices({ deviceId: bleDevice.deviceId });
                const sRes = await BlePlugin.getServices({ deviceId: bleDevice.deviceId });
                const sList = (sRes && sRes.services) || [];
                obdLog("info", `Gefundene GATT-Services (${sList.length}): ${sList.map(s => s.uuid).join(", ") || "keine"}`);

                let targetService = NORDIC_UART_SERVICE;
                let targetTx = NORDIC_TX_CHAR;
                let targetRx = NORDIC_RX_CHAR;

                const hasNordic = sList.some(s => (s.uuid || "").toLowerCase().includes("6e400001"));
                if (!hasNordic) {
                    const hasGeneric = sList.some(s => (s.uuid || "").toLowerCase().includes("ffe0"));
                    if (hasGeneric) {
                        targetService = GENERIC_ELM_SERVICE;
                        targetTx = GENERIC_ELM_CHAR;
                        targetRx = GENERIC_ELM_CHAR;
                    } else if (sList.length > 0) {
                        // Dynamischer Fallback auf ersten schreib-/notify-fähigen Custom-Service
                        for (const srv of sList) {
                            const u = (srv.uuid || "").toLowerCase();
                            if (u.startsWith("00001800") || u.startsWith("00001801") || u.startsWith("0000180a")) continue;
                            const chars = srv.characteristics || [];
                            const writeC = chars.find(c => c.properties?.write || c.properties?.writeWithoutResponse);
                            const notifyC = chars.find(c => c.properties?.notify || c.properties?.indicate);
                            if (writeC && notifyC) {
                                targetService = srv.uuid;
                                targetTx = writeC.uuid;
                                targetRx = notifyC.uuid;
                                obdLog("info", `Nutze dynamischen GATT-Service ${targetService} (TX=${targetTx}, RX=${targetRx})`);
                                break;
                            }
                        }
                    }
                }

                bleConnection.serviceUuid = targetService;
                bleConnection.txCharUuid = targetTx;
                bleConnection.rxCharUuid = targetRx;

                const notifKey = `notification|${bleDevice.deviceId}|${targetService}|${targetRx}`;
                const listenerHandle = await BlePlugin.addListener(notifKey, (event) => {
                    let text = "";
                    if (typeof event?.value === "string") {
                        text = hexToText(event.value);
                    } else if (event?.value?.buffer) {
                        text = new TextDecoder("utf-8").decode(event.value);
                    }
                    if (text) {
                        const cleanPreview = text.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
                        obdLog("rx", `RX (BLE): "${cleanPreview}" [HEX: ${event?.value || ""}]`);
                        handleBleRxChunk(text);
                    }
                });
                bleConnection.nativeListenerHandle = listenerHandle;

                await BlePlugin.startNotifications({
                    deviceId: bleDevice.deviceId,
                    service: targetService,
                    characteristic: targetRx
                });

                bleConnection.connected = true;
                obdLog("success", `✅ BLE-GATT verbunden (Service: ${targetService})`);

            } else {
                // BROWSER WEB BLUETOOTH FALLBACK
                obdLog("info", "Starte Web-Bluetooth Geräteauswahl...");
                if (bleConnection.device) {
                    bleConnection.device.removeEventListener("gattserverdisconnected", onBleDisconnected);
                }

                const device = await navigator.bluetooth.requestDevice({
                    filters: [
                        { namePrefix: "vLinker" },
                        { namePrefix: "OBD" },
                        { namePrefix: "IOS-Vlink" },
                        { namePrefix: "Android-Vlink" },
                        { namePrefix: "V-LINK" }
                    ],
                    optionalServices: [NORDIC_UART_SERVICE, GENERIC_ELM_SERVICE, "0000fff0-0000-1000-8000-00805f9b34fb"]
                });

                device.addEventListener("gattserverdisconnected", onBleDisconnected);
                bleConnection.isNative = false;
                bleConnection.transport = "webble";
                bleConnection.device = device;

                const server = await device.gatt.connect();
                bleConnection.server = server;

                let service = null;
                try {
                    service = await server.getPrimaryService(NORDIC_UART_SERVICE);
                    bleConnection.txChar = await service.getCharacteristic(NORDIC_TX_CHAR);
                    bleConnection.rxChar = await service.getCharacteristic(NORDIC_RX_CHAR);
                } catch (e1) {
                    try {
                        service = await server.getPrimaryService(GENERIC_ELM_SERVICE);
                        bleConnection.txChar = await service.getCharacteristic(GENERIC_ELM_CHAR);
                        bleConnection.rxChar = bleConnection.txChar;
                    } catch (e2) {
                        throw new Error("Konnte kompatiblen UART/OBD-Kanal auf dem Dongle nicht finden.");
                    }
                }

                await bleConnection.rxChar.startNotifications();
                bleConnection.rxChar.removeEventListener("characteristicvaluechanged", handleBleNotification);
                bleConnection.rxChar.addEventListener("characteristicvaluechanged", handleBleNotification);
                bleConnection.connected = true;
                obdLog("success", "✅ Web-Bluetooth verbunden!");
            }
        }

        bleAutoReconnectAttempts = 0;
        if (bleAutoReconnectTimer) {
            clearTimeout(bleAutoReconnectTimer);
            bleAutoReconnectTimer = null;
        }

        if (statusPill) {
            statusPill.className = "badge badge-success";
            statusPill.textContent = bleConnection.transport === "spp" ? "Verbunden (Classic SPP)" : "Verbunden (BLE)";
        }
        if (btnConnect) btnConnect.style.display = "none";
        if (btnDisconnect) btnDisconnect.style.display = "inline-block";
        if (telemetryBox) telemetryBox.style.display = "grid";

        if (isAutoRetry) {
            showToast(`⚡ Mit ${bleConnection.device?.name || "vLinker"} automatisch verbunden!`, "success");
        } else if (!silent) {
            showToast(`⚡ Mit ${bleConnection.device?.name || "vLinker"} (${(bleConnection.transport || "BT").toUpperCase()}) verbunden! Initialisiere...`, "success");
        }

        // ELM327 / vLinker / MEB UDS Initialisierung
        obdLog("info", "Sende ELM327/vLinker Initialisierungs-Sequenz...");
        await sendBleCommand("ATZ");
        await new Promise(r => setTimeout(r, 800));
        await sendBleCommand("ATI");
        await new Promise(r => setTimeout(r, 250));
        await sendBleCommand("ATE0");
        await new Promise(r => setTimeout(r, 200));
        await sendBleCommand("ATL0");
        await new Promise(r => setTimeout(r, 200));
        await sendBleCommand("ATH0");
        await new Promise(r => setTimeout(r, 200));
        await sendBleCommand("ATRV"); // 12V Spannung direkt vom Dongle-ADC
        await new Promise(r => setTimeout(r, 250));
        await sendBleCommand("ATSP6"); // ISO 15765-4 CAN 11bit 500k
        await new Promise(r => setTimeout(r, 250));
        await sendBleCommand("ATSH 7E5"); // Header auf MEB BMS 7E5
        await new Promise(r => setTimeout(r, 250));

        // Erste Abfrage starten + zyklisches Polling alle 8 Sekunden
        await queryBornTelemetry();
        bleConnection.telemetryInterval = setInterval(queryBornTelemetry, 8000);

    } catch (err) {
        const msg = err?.message || String(err);
        obdLog(isAutoRetry ? "info" : "error", `Verbindungsaufbau ${isAutoRetry ? "nicht möglich (Dongle offline/außer Reichweite)" : "abgebrochen"}: ${msg}`);
        if (!silent) {
            showToast("Bluetooth-Fehler: " + msg, "warning");
        }
        onBleDisconnected();
    } finally {
        bleConnection.connecting = false;
        if (btnConnect) {
            btnConnect.disabled = false;
            btnConnect.innerHTML = `<span class="btn-icon">📡</span> Mit vLinker Bluetooth verbinden`;
        }
    }
}

let bleResponseBuffer = "";
function handleBleRxChunk(chunk) {
    bleResponseBuffer += chunk;

    if (bleResponseBuffer.length > 4096) {
        bleResponseBuffer = "";
        return;
    }

    if (bleResponseBuffer.includes(">") || bleResponseBuffer.includes("\r") || bleResponseBuffer.includes("\n")) {
        parseBleResponse(bleResponseBuffer);
        if (bleResponseBuffer.includes(">")) {
            bleResponseBuffer = "";
        } else {
            // Nur abgeschlossene Zeilen verarbeiten
            const lastCr = Math.max(bleResponseBuffer.lastIndexOf("\r"), bleResponseBuffer.lastIndexOf("\n"));
            bleResponseBuffer = bleResponseBuffer.substring(lastCr + 1);
        }
    }
}

function handleBleNotification(event) {
    const val = event.target.value;
    const decoder = new TextDecoder("utf-8");
    const chunk = decoder.decode(val);
    obdLog("rx", `RX (WebBLE): "${chunk.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`);
    handleBleRxChunk(chunk);
}

function update12vDisplay(volts) {
    if (isNaN(volts) || volts < 5 || volts > 20) return;
    cupraState.battery12vVoltage = Number(volts.toFixed(1));
    const el = document.getElementById("obd-val-12v");
    if (el) {
        let badgeColor = "#34d399";
        if (volts < 11.9) badgeColor = "#ef4444";
        else if (volts <= 12.3) badgeColor = "#f59e0b";
        el.innerHTML = `<span style="color:${badgeColor};font-weight:700;">${volts.toFixed(1)} V</span>`;
    }
    if (volts < 11.9 && !cupraState.warned12v) {
        cupraState.warned12v = true;
        showToast(`⚠️ WARNUNG: 12V-Bordnetzbatterie kritisch (${volts.toFixed(1)} V)! Bitte Born einschalten/laden.`, "error");
    }
}

function parseBleResponse(response) {
    // 0. Direktes ATRV Spannungs-Format prüfen (z.B. "12.4V" oder "12,4V")
    const atrvMatch = response.match(/(\d{1,2}[.,]\d{1,2})\s*V/i);
    if (atrvMatch) {
        const v = parseFloat(atrvMatch[1].replace(",", "."));
        if (!isNaN(v)) {
            update12vDisplay(v);
            obdLog("success", `📊 ATRV 12V-Bordnetzspannung erkannt: ${v.toFixed(1)} V`);
        }
    }

    const cleaned = response.replace(/\s+/g, "").toUpperCase();

    // Display SoC (PID 02 8C -> Positiv-Antwort 62 02 8C [BYTE])
    if (cleaned.includes("62028C")) {
        const idx = cleaned.lastIndexOf("62028C") + 6;
        const hexVal = cleaned.substring(idx, idx + 2);
        if (hexVal && hexVal.length === 2) {
            const raw = parseInt(hexVal, 16);
            if (!isNaN(raw)) {
                const soc = Math.min(100, Math.max(0, raw <= 100 ? raw : Math.round(raw / 2.55)));
                cupraState.liveSoc = soc;
                cupraState.source = "ble";
                const el = document.getElementById("obd-val-soc");
                if (el) el.textContent = `${soc} %`;
                obdLog("success", `📊 Display-SoC (PID 028C): ${soc} % (raw=0x${hexVal})`);
                updateCupraUi();
                renderMapMarkers(activeStations, false);
            }
        }
    }

    // Real BMS SoC (PID 02 8D -> Positiv-Antwort 62 02 8D [BYTE])
    if (cleaned.includes("62028D")) {
        const idx = cleaned.lastIndexOf("62028D") + 6;
        const hexVal = cleaned.substring(idx, idx + 2);
        if (hexVal && hexVal.length === 2) {
            const raw = parseInt(hexVal, 16);
            if (!isNaN(raw)) {
                const realSoc = Math.min(100, Math.max(0, raw <= 100 ? raw : Math.round(raw / 2.55)));
                cupraState.realBmsSoc = realSoc;
                const el = document.getElementById("obd-val-real-soc");
                if (el) el.textContent = `${realSoc} %`;
                obdLog("success", `📊 BMS Real-SoC (PID 028D): ${realSoc} % (raw=0x${hexVal})`);
            }
        }
    }

    // Akkutemperatur (PID 02 8E -> Positiv-Antwort 62 02 8E [BYTE], Offset -40)
    if (cleaned.includes("62028E")) {
        const idx = cleaned.lastIndexOf("62028E") + 6;
        const hexVal = cleaned.substring(idx, idx + 2);
        if (hexVal && hexVal.length === 2) {
            const raw = parseInt(hexVal, 16);
            if (!isNaN(raw)) {
                const temp = raw - 40;
                cupraState.batteryTemp = temp;
                const el = document.getElementById("obd-val-temp");
                if (el) el.textContent = `${temp} °C`;
                obdLog("success", `📊 Akkutemperatur (PID 028E): ${temp} °C (raw=0x${hexVal})`);
            }
        }
    }

    // 12V Bordnetzbatterie (PID 02 88 -> Positiv-Antwort 62 02 88 [BYTE])
    if (cleaned.includes("620288")) {
        const idx = cleaned.lastIndexOf("620288") + 6;
        const hexVal = cleaned.substring(idx, idx + 2);
        if (hexVal && hexVal.length === 2) {
            const raw = parseInt(hexVal, 16);
            if (!isNaN(raw)) {
                const volts = (raw / 10.0) || 12.4;
                update12vDisplay(volts);
                obdLog("success", `📊 12V Bordnetz (PID 0288): ${volts.toFixed(1)} V (raw=0x${hexVal})`);
            }
        }
    }

    // Battery State of Health (SoH) - PID 02 8A -> 62 02 8A [BYTE]
    if (cleaned.includes("62028A")) {
        const idx = cleaned.lastIndexOf("62028A") + 6;
        const hexVal = cleaned.substring(idx, idx + 2);
        if (hexVal && hexVal.length === 2) {
            const raw = parseInt(hexVal, 16);
            if (!isNaN(raw) && raw > 40) {
                const soh = raw <= 100 ? raw : Math.min(100, Math.round(raw / 2.55));
                cupraState.soh = soh;
                const el = document.getElementById("obd-val-soh");
                if (el) el.textContent = `${soh} %`;
                const slider = document.getElementById("born-soh-slider");
                if (slider) slider.value = soh;
                const display = document.getElementById("soh-display-val");
                if (display) display.textContent = `${soh} %`;
                const metric = document.getElementById("born-soh-metric");
                if (metric) {
                    const usable = ((cupraState.batteryCapacity || 58) * (soh / 100)).toFixed(1);
                    metric.textContent = `${usable} kWh netto`;
                }
                obdLog("success", `📊 Batterie-SoH (PID 028A): ${soh} % (raw=0x${hexVal})`);
            }
        }
    }

    // Battery State of Health alternative PID 1E 3B -> 62 1E 3B [BYTE]
    if (cleaned.includes("621E3B")) {
        const idx = cleaned.lastIndexOf("621E3B") + 6;
        const hexVal = cleaned.substring(idx, idx + 2);
        if (hexVal && hexVal.length === 2) {
            const raw = parseInt(hexVal, 16);
            if (!isNaN(raw) && raw > 40 && raw <= 100) {
                cupraState.soh = raw;
                const el = document.getElementById("obd-val-soh");
                if (el) el.textContent = `${raw} %`;
                obdLog("success", `📊 Batterie-SoH (PID 1E3B): ${raw} % (raw=0x${hexVal})`);
            }
        }
    }

    // Stecker- & Ladestatus (PID 02 8F -> Positiv-Antwort 62 02 8F [BYTE])
    if (cleaned.includes("62028F")) {
        const idx = cleaned.lastIndexOf("62028F") + 6;
        const hexVal = cleaned.substring(idx, idx + 2);
        if (hexVal && hexVal.length === 2) {
            const statusByte = parseInt(hexVal, 16);
            if (!isNaN(statusByte)) {
                const isConnected = (statusByte & 0x01) !== 0;
                const isLocked = (statusByte & 0x02) !== 0;
                const isCharging = (statusByte & 0x04) !== 0;

                let plugStr = "Nicht angesteckt";
                let plugState = "disconnected";
                if (isCharging) {
                    plugStr = "⚡ Lädt aktiv";
                    plugState = "charging";
                } else if (isLocked) {
                    plugStr = "🔒 Verriegelt (bereit)";
                    plugState = "locked";
                } else if (isConnected) {
                    plugStr = "🔌 Angesteckt";
                    plugState = "connected";
                }

                const prevPlugState = cupraState.plugState;
                cupraState.plugState = plugState;
                const el = document.getElementById("obd-val-plug");
                if (el) el.textContent = plugStr;

                const autoEnabled = document.getElementById("obd-auto-plug-timer") ? document.getElementById("obd-auto-plug-timer").checked : true;
                if (autoEnabled) {
                    handleAutoPlugEvent(prevPlugState, plugState);
                }
            }
        }
    }
}

function handleAutoPlugEvent(prev, current) {
    if (prev !== "charging" && current === "charging") {
        cupraState.chargeSessionStartSoc = getActiveSoc();
        cupraState.chargeSessionStartTime = Date.now();
        if (!activeChargeSession && !parkTimer) {
            let nearStation = null;
            if (currentDeviceCoords && Array.isArray(activeStations) && activeStations.length > 0) {
                nearStation = activeStations.find(s => {
                    if (s.latitude === null || s.longitude === null) return false;
                    return calculateDistanceKm(currentDeviceCoords.lat, currentDeviceCoords.lon, s.latitude, s.longitude) <= 0.35;
                });
            }
            if (!nearStation && currentDeviceCoords && Array.isArray(favorites) && favorites.length > 0) {
                nearStation = favorites.find(s => {
                    if (s.latitude === null || s.longitude === null) return false;
                    return calculateDistanceKm(currentDeviceCoords.lat, currentDeviceCoords.lon, s.latitude, s.longitude) <= 0.35;
                });
            }

            let stationName = "Ladesäule unterwegs";
            let op = "default";
            let hasDc = false;
            let feeInfo = { freeMinutes: 60, feePerMinute: 0.10, nightStart: 21, nightEnd: 9, hasNightRule: true };

            if (nearStation) {
                stationName = nearStation.name || nearStation.address || "Ladestation";
                op = nearStation.operator || "default";
                hasDc = (nearStation.connectors || []).some(c => c.power_type === 'DC' || (parseFloat(c.power_kw) || 0) > 22);
                feeInfo = getBlockingFeeInfo(op, hasDc);
            }

            const targetSoc = cupraState.targetSoc || 80;
            const startSoc = cupraState.chargeSessionStartSoc || 50;
            const deltaSoc = Math.max(0, targetSoc - startSoc);
            const usableCap = (cupraState.batteryCapacity || 58) * ((cupraState.soh || 98) / 100);
            const neededKwh = (deltaSoc / 100) * usableCap;
            const chargePower = hasDc ? 100 : 11;
            const neededMinutes = Math.max(1, Math.round((neededKwh / chargePower) * 60));

            startSmartChargeGuardian({
                station: nearStation || { id: "auto_born", name: stationName, latitude: currentDeviceCoords ? currentDeviceCoords.lat : null, longitude: currentDeviceCoords ? currentDeviceCoords.lon : null },
                connectorLabel: hasDc ? "CCS DC (OBD2 erkannt)" : "Typ 2 AC (OBD2 erkannt)",
                freeMinutes: feeInfo.freeMinutes,
                feePerMinute: feeInfo.feePerMinute || 0.10,
                nightStart: feeInfo.nightStart || 21,
                nightEnd: feeInfo.nightEnd || 9,
                hasNightRule: feeInfo.hasNightRule !== false,
                targetSoc: targetSoc,
                startSoc: startSoc,
                neededMinutes: neededMinutes,
                neededKwh: neededKwh
            });
            showToast(`🛡️ Ladekabel verriegelt: Lade-Wächter für "${stationName}" gestartet!`, "success");
        }
    }
    if (prev === "charging" && current !== "charging") {
        const endSoc = getActiveSoc();
        const startSoc = cupraState.chargeSessionStartSoc !== null ? cupraState.chargeSessionStartSoc : Math.max(0, endSoc - 10);
        const gainedSoc = Math.max(0, endSoc - startSoc);
        const gainedKwh = Number(((gainedSoc / 100) * (cupraState.batteryCapacity || 58.0)).toFixed(1));
        const estCost = Number((gainedKwh * 0.39).toFixed(2));
        if (gainedKwh > 0.5) {
            quickLogCharge("Cupra Born Auto-Ladung", gainedKwh, estCost);
            showToast(`✅ Ladevorgang beendet: +${gainedKwh} kWh (+${gainedSoc}% SoC) automatisch im Logbuch gespeichert!`, "success");
        }
        stopParkTimer();
        stopSmartChargeGuardian();
    }
}

async function sendBleCommand(cmd) {
    if (!bleConnection.connected) {
        obdLog("warn", `Befehl "${cmd}" verworfen (nicht verbunden).`);
        return;
    }
    try {
        const cleanCmd = String(cmd || "").trim();
        const fullCmd = cleanCmd + "\r";
        obdLog("tx", `TX (${(bleConnection.transport || "bt").toUpperCase()}): "${cleanCmd}\\r"`);

        if (bleConnection.transport === "spp" && window.Capacitor?.Plugins?.ObdClassic) {
            await window.Capacitor.Plugins.ObdClassic.writeSpp({ data: fullCmd });
        } else if (bleConnection.isNative && window.Capacitor?.Plugins?.BluetoothLe) {
            const BlePlugin = window.Capacitor.Plugins.BluetoothLe;
            await BlePlugin.write({
                deviceId: bleConnection.deviceId,
                service: bleConnection.serviceUuid,
                characteristic: bleConnection.txCharUuid,
                value: textToHex(fullCmd)
            });
        } else if (bleConnection.txChar && bleConnection.txChar.writeValue) {
            const encoder = new TextEncoder();
            const data = encoder.encode(fullCmd);
            await bleConnection.txChar.writeValue(data);
        }
    } catch (e) {
        obdLog("error", `Sende-Fehler bei "${cmd}": ${e?.message || e}`);
    }
}

window.sendManualObdCommand = async function(presetCmd) {
    const inputEl = document.getElementById("obd-manual-cmd");
    const cmd = presetCmd || (inputEl ? inputEl.value.trim() : "");
    if (!cmd) {
        showToast("Bitte einen AT- oder UDS-Befehl eingeben (z.B. ATZ).", "warning");
        return;
    }
    if (!bleConnection.connected) {
        obdLog("warn", `Manueller Befehl "${cmd}" nicht möglich: Bitte zuerst mit dem Dongle verbinden!`);
        showToast("Bitte zuerst mit dem Dongle verbinden.", "warning");
        return;
    }
    await sendBleCommand(cmd);
    if (!presetCmd && inputEl) {
        inputEl.value = "";
    }
};

async function queryBornTelemetry() {
    if (!bleConnection.connected || bleConnection.commandLock) return;
    bleConnection.commandLock = true;
    try {
        await sendBleCommand("ATRV");     // 12V Bordnetz direkt via ELM/vLinker
        await new Promise(r => setTimeout(r, 220));
        await sendBleCommand("22 02 8C"); // Display SoC
        await new Promise(r => setTimeout(r, 220));
        await sendBleCommand("22 02 8D"); // BMS SoC
        await new Promise(r => setTimeout(r, 220));
        await sendBleCommand("22 02 8E"); // Batt Temp
        await new Promise(r => setTimeout(r, 220));
        await sendBleCommand("22 02 88"); // 12V Bordnetz Batterie UDS
        await new Promise(r => setTimeout(r, 220));
        await sendBleCommand("22 02 8A"); // Battery State of Health (SoH)
        await new Promise(r => setTimeout(r, 220));
        await sendBleCommand("22 02 8F"); // Ladekabel / Stecker Status
    } finally {
        bleConnection.commandLock = false;
    }
}

async function disconnectVlinkerBle() {
    bleManualDisconnected = true;
    if (bleAutoReconnectTimer) {
        clearTimeout(bleAutoReconnectTimer);
        bleAutoReconnectTimer = null;
    }
    bleAutoReconnectAttempts = 0;
    obdLog("info", "Trenne Verbindung zum OBD2-Dongle...");
    if (bleConnection.transport === "spp" && window.Capacitor?.Plugins?.ObdClassic) {
        try {
            await window.Capacitor.Plugins.ObdClassic.disconnectSpp();
        } catch (e) {}
    } else if (bleConnection.isNative && window.Capacitor?.Plugins?.BluetoothLe && bleConnection.deviceId) {
        try {
            await window.Capacitor.Plugins.BluetoothLe.disconnect({ deviceId: bleConnection.deviceId });
        } catch (e) {}
    } else if (bleConnection.device && bleConnection.device.gatt && bleConnection.device.gatt.connected) {
        try {
            bleConnection.device.gatt.disconnect();
        } catch (e) {}
    }
    onBleDisconnected();
    showToast("Bluetooth-Verbindung zum vLinker getrennt.", "info");
}

function onBleDisconnected() {
    if (bleConnection.telemetryInterval) {
        clearInterval(bleConnection.telemetryInterval);
        bleConnection.telemetryInterval = null;
    }
    if (bleConnection.rxChar) {
        try {
            bleConnection.rxChar.removeEventListener("characteristicvaluechanged", handleBleNotification);
        } catch (e) {}
    }
    if (bleConnection.nativeListenerHandle) {
        try {
            bleConnection.nativeListenerHandle.remove();
        } catch (e) {}
        bleConnection.nativeListenerHandle = null;
    }
    bleConnection.connected = false;
    bleConnection.commandLock = false;
    bleConnection.transport = null;
    bleConnection.device = null;
    bleConnection.server = null;
    bleConnection.rxChar = null;
    bleConnection.txChar = null;
    bleConnection.deviceId = null;
    bleConnection.serviceUuid = null;
    bleConnection.txCharUuid = null;
    bleConnection.rxCharUuid = null;
    bleConnection.isNative = false;
    bleResponseBuffer = "";
    cupraState.source = "manual";

    const statusPill = document.getElementById("obd-status-pill");
    const btnConnect = document.getElementById("btn-obd-connect");
    const btnDisconnect = document.getElementById("btn-obd-disconnect");
    if (statusPill) {
        statusPill.className = "badge badge-warning";
        statusPill.textContent = "Nicht verbunden";
    }
    if (btnConnect) btnConnect.style.display = "inline-block";
    if (btnDisconnect) btnDisconnect.style.display = "none";
    updateCupraUi();

    if (!bleManualDisconnected && isObdAutoReconnectEnabled()) {
        scheduleObdAutoReconnect();
    }
}

/* ==========================================================================
   Park-Timer, Lade-Wächter & "Auto hier geparkt" Banner
   ========================================================================== */
let activeChargeSession = null;
let chargeSessionInterval = null;

function isNightHour(h, nightStartHour, nightEndHour) {
    if (nightStartHour === nightEndHour) return false;
    if (nightStartHour > nightEndHour) return h >= nightStartHour || h < nightEndHour;
    return h >= nightStartHour && h < nightEndHour;
}

// Next point in time strictly after `curr` with wall-clock time hour:00
function nextAtHour(curr, hour) {
    const candidate = new Date(curr.getTime());
    candidate.setHours(hour, 0, 0, 0);
    if (candidate.getTime() <= curr.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate;
}

function calculateClientBlockingDeadline(startDate, freeMinutes, nightStartHour = 21, nightEndHour = 9, hasNightRule = true) {
    let remainingMins = Math.max(0, Number(freeMinutes) || 0);
    const ns = ((Number(nightStartHour) % 24) + 24) % 24;
    const ne = ((Number(nightEndHour) % 24) + 24) % 24;
    let curr = new Date(startDate.getTime());
    if (!hasNightRule || remainingMins <= 0 || ns === ne || isNaN(ns) || isNaN(ne)) {
        return new Date(curr.getTime() + remainingMins * 60000);
    }
    // Each iteration skips a whole night or consumes a whole day segment; the bound only guards edge cases (DST)
    for (let i = 0; i < 64; i++) {
        if (isNightHour(curr.getHours(), ns, ne)) {
            curr = nextAtHour(curr, ne);
            continue;
        }
        const nightBegin = nextAtHour(curr, ns);
        const minsUntilNight = (nightBegin.getTime() - curr.getTime()) / 60000;
        if (remainingMins <= minsUntilNight) {
            return new Date(curr.getTime() + remainingMins * 60000);
        }
        remainingMins -= minsUntilNight;
        curr = nightBegin;
    }
    return new Date(curr.getTime() + remainingMins * 60000);
}

window.startSmartChargeGuardianFromSheet = function() {
    if (!window.currentSheetStation) return;
    const st = window.currentSheetStation;
    const currentSoc = (cupraState.liveSoc !== null && cupraState.liveSoc !== undefined) ? cupraState.liveSoc : ((cupraState.manualSoc !== null && cupraState.manualSoc !== undefined) ? cupraState.manualSoc : 50);
    const targetSoc = cupraState.targetSoc || 80;
    const deltaSoc = Math.max(0, targetSoc - currentSoc);
    const usableCapacity = (cupraState.batteryCapacity || 58) * ((cupraState.soh || 98) / 100);
    const neededKwh = (deltaSoc / 100) * usableCapacity;

    let maxPower = 11;
    let hasDc = false;
    (st.connectors || []).forEach(c => {
        const p = parseFloat(c.power_kw) || 0;
        if (p > maxPower) maxPower = p;
        if (c.power_type === 'DC' || p > 22) hasDc = true;
    });

    const chargePower = hasDc ? Math.min(135, maxPower) : 11;
    const hoursNeeded = neededKwh / chargePower;
    const minutesNeeded = Math.max(1, Math.round(hoursNeeded * 60));

    const feeInfo = getBlockingFeeInfo(st.operator, hasDc);

    let connLabel = "Typ 2";
    if (st.connectors && st.connectors.length > 0) {
        connLabel = st.connectors[0].point_label ? `${st.connectors[0].point_label} (${st.connectors[0].standard})` : st.connectors[0].standard;
    }

    startSmartChargeGuardian({
        station: st,
        connectorLabel: connLabel,
        freeMinutes: feeInfo.freeMinutes,
        feePerMinute: feeInfo.feePerMinute || 0.10,
        nightStart: feeInfo.nightStart ?? 21,
        nightEnd: feeInfo.nightEnd ?? 9,
        hasNightRule: feeInfo.hasNightRule !== false,
        targetSoc: targetSoc,
        startSoc: currentSoc,
        neededMinutes: minutesNeeded,
        neededKwh: neededKwh
    });
};

window.startSmartChargeGuardian = async function(params) {
    const now = Date.now();
    const st = params.station;
    const targetReachedMs = now + (params.neededMinutes * 60 * 1000);
    const targetDt = new Date(targetReachedMs);
    const targetEtaStr = `ca. ${String(targetDt.getHours()).padStart(2, '0')}:${String(targetDt.getMinutes()).padStart(2, '0')} Uhr`;

    const deadlineDt = calculateClientBlockingDeadline(
        new Date(now),
        params.freeMinutes,
        params.nightStart,
        params.nightEnd,
        params.hasNightRule
    );

    const sessionData = {
        station_id: String(st.id),
        station_name: st.name || st.address || "Ladestation",
        connector_label: params.connectorLabel || "Anschluss",
        latitude: st.latitude,
        longitude: st.longitude,
        start_time_ms: now,
        free_parking_minutes: params.freeMinutes,
        night_window_start: params.nightStart,
        night_window_end: params.nightEnd,
        has_night_rule: params.hasNightRule,
        target_soc: params.targetSoc,
        start_soc: params.startSoc,
        target_reached_ms: targetReachedMs,
        target_soc_eta_str: targetEtaStr,
        blocking_fee_per_min: params.feePerMinute,
        deadline_ms: deadlineDt.getTime(),
        deadline_str: `${String(deadlineDt.getHours()).padStart(2, '0')}:${String(deadlineDt.getMinutes()).padStart(2, '0')}`
    };

    activeChargeSession = sessionData;
    localStorage.setItem("ev_charge_session", JSON.stringify(sessionData));

    if (useHaRemote()) {
        // The add-on's Lade-Wächter keeps pushing while the phone sleeps; confirmation arrives async
        pushChargeSessionToHa(sessionData).then(result => {
            if (!result.ok) showToast(`⚠️ Lade-Wächter läuft vorerst nur in der App: ${result.error}`, "warning");
        });
    } else if (!isNativeApp()) {
        try {
            await fetch(getApiUrl("api/charge-session/start"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(sessionData)
            });
        } catch (e) {
            console.warn("Could not sync charge session to HA backend:", e);
        }
    }

    startChargeSessionInterval();
    updateStatusBanner();
    closeModal("modal-station-detail");
    showToast(`🛡️ Lade-Wächter gestartet: Freiparkzeit & ${params.targetSoc}% Alarm aktiv!`, "success");
};

window.stopSmartChargeGuardian = async function() {
    if (chargeSessionInterval) clearInterval(chargeSessionInterval);
    activeChargeSession = null;
    localStorage.removeItem("ev_charge_session");
    if (useHaRemote()) {
        runHaCommand("session_stop").then(result => {
            if (!result.ok) showToast(`⚠️ Lade-Wächter in Home Assistant nicht beendet: ${result.error}`, "warning");
        });
    } else if (!isNativeApp()) {
        try {
            await fetch(getApiUrl("api/charge-session/stop"), { method: "POST" });
        } catch (e) {}
    }
    updateStatusBanner();
    showToast("⏹️ Lade-Wächter beendet.", "info");
};

// APK: hand the session to the add-on; marked ha_synced only once the add-on confirmed it
async function pushChargeSessionToHa(session) {
    if (haSessionPushInFlight) return { delivered: false, acked: false, ok: false, error: "Übertragung läuft bereits" };
    haSessionPushInFlight = true;
    try {
        const result = await runHaCommand("session_start", { session });
        const stillCurrent = activeChargeSession &&
            activeChargeSession.start_time_ms === session.start_time_ms &&
            String(activeChargeSession.station_id) === String(session.station_id);
        if (result.ok && stillCurrent) {
            activeChargeSession.ha_synced = true;
            localStorage.setItem("ev_charge_session", JSON.stringify(activeChargeSession));
        }
        return result;
    } finally {
        haSessionPushInFlight = false;
    }
}

// APK: adopt the add-on's Lade-Wächter (stopped/started in HA or Ingress) once HA is reachable
async function syncChargeSessionFromHa() {
    if (!useHaRemote()) return;
    const snapshot = await getHaBridgeState();
    if (!snapshot) return;
    if (activeChargeSession && !activeChargeSession.ha_synced) {
        // Started offline or confirmation missed: hand it over now (add-on keeps alert flags of re-sends)
        pushChargeSessionToHa(activeChargeSession);
        return;
    }
    const next = reconcileChargeSession(activeChargeSession, snapshot.session);
    if (JSON.stringify(next) === JSON.stringify(activeChargeSession)) return;
    activeChargeSession = next;
    if (next) {
        localStorage.setItem("ev_charge_session", JSON.stringify(next));
        startChargeSessionInterval();
    } else {
        localStorage.removeItem("ev_charge_session");
        if (chargeSessionInterval) clearInterval(chargeSessionInterval);
    }
    updateStatusBanner();
}

function startChargeSessionInterval() {
    if (chargeSessionInterval) clearInterval(chargeSessionInterval);
    chargeSessionInterval = setInterval(() => {
        if (!activeChargeSession) {
            clearInterval(chargeSessionInterval);
            return;
        }
        updateStatusBanner();
    }, 1000);
}

function initParkStatus() {
    try {
        const savedTimer = localStorage.getItem("ev_park_timer");
        if (savedTimer) {
            const parsed = JSON.parse(savedTimer);
            if (parsed.endTimestamp > Date.now()) {
                parkTimer = parsed;
                startParkInterval();
            } else {
                localStorage.removeItem("ev_park_timer");
            }
        }
        const savedSession = localStorage.getItem("ev_charge_session");
        if (savedSession) {
            activeChargeSession = JSON.parse(savedSession);
            startChargeSessionInterval();
        }
        const savedPark = localStorage.getItem("ev_parked_car");
        if (savedPark) {
            parkedLocation = JSON.parse(savedPark);
        }
    } catch (e) {
        console.warn("Could not load park status", e);
    }
    updateStatusBanner();

    if (isNativeApp()) {
        syncChargeSessionFromHa();
        return;
    }

    // Background sync with HA charge session
    fetch(getApiUrl("api/charge-session"))
        .then(r => r.json())
        .then(d => {
            if (d && d.session) {
                activeChargeSession = d.session;
                localStorage.setItem("ev_charge_session", JSON.stringify(d.session));
                startChargeSessionInterval();
                updateStatusBanner();
            }
        })
        .catch(() => {});
}

window.startParkTimer = function(minutes, stationName) {
    const endTimestamp = Date.now() + minutes * 60 * 1000;
    parkTimer = { endTimestamp, stationName };
    localStorage.setItem("ev_park_timer", JSON.stringify(parkTimer));
    startParkInterval();
    updateStatusBanner();
    showToast(`⏱️ Lade-Timer gestartet: ${minutes} Min. an ${stationName}`, "success");
};

window.stopParkTimer = function() {
    if (parkTimerInterval) clearInterval(parkTimerInterval);
    parkTimer = null;
    localStorage.removeItem("ev_park_timer");
    updateStatusBanner();
    showToast("⏱️ Lade-Timer beendet", "info");
};

function startParkInterval() {
    if (parkTimerInterval) clearInterval(parkTimerInterval);
    parkTimerInterval = setInterval(() => {
        if (!parkTimer) {
            clearInterval(parkTimerInterval);
            return;
        }
        const remainingMs = parkTimer.endTimestamp - Date.now();
        if (remainingMs <= 0) {
            clearInterval(parkTimerInterval);
            showToast(`⚠️ LADEZEIT ABGELAUFEN an ${parkTimer.stationName}! Bitte umparken wegen Blockiergebühr.`, "error");
            stopParkTimer();
            return;
        }
        updateStatusBanner();
    }, 1000);
}

window.markParkedCar = function(stationName, lat, lon) {
    parkedLocation = { name: stationName, lat, lon, time: Date.now() };
    localStorage.setItem("ev_parked_car", JSON.stringify(parkedLocation));
    updateStatusBanner();
    showToast(`🅿️ Parkplatz gespeichert: "${stationName}"`, "success");
};

window.clearParkedCar = function() {
    parkedLocation = null;
    localStorage.removeItem("ev_parked_car");
    updateStatusBanner();
    showToast("🅿️ Parkplatz-Markierung entfernt", "info");
};

function updateStatusBanner() {
    const banner = document.getElementById("status-banner");
    if (!banner) return;

    let itemsHtml = [];

    if (activeChargeSession) {
        const now = Date.now();
        const remSecs = Math.max(0, Math.floor((activeChargeSession.deadline_ms - now) / 1000));
        const remHours = Math.floor(remSecs / 3600);
        const remMins = Math.floor((remSecs % 3600) / 60);
        const remS = remSecs % 60;
        const timeStr = `${remHours > 0 ? remHours + ' Std. ' : ''}${remMins} Min. ${remS < 10 ? '0' : ''}${remS}s`;

        const curDate = new Date();
        const curH = curDate.getHours();
        const nwStart = activeChargeSession.night_window_start ?? 21;
        const nwEnd = activeChargeSession.night_window_end ?? 9;
        const isNight = Boolean(activeChargeSession.has_night_rule && isNightHour(curH, nwStart, nwEnd));

        let feeStatusText = "";
        const feeRate = Number(activeChargeSession.blocking_fee_per_min || 0.10).toFixed(2);
        if (now >= activeChargeSession.deadline_ms) {
            const overdueSecs = Math.floor((now - activeChargeSession.deadline_ms) / 1000);
            const overdueMins = Math.floor(overdueSecs / 60);
            const overdueH = Math.floor(overdueMins / 60);
            const overdueM = overdueMins % 60;
            const overdueStr = overdueH > 0 ? `${overdueH} Std. ${overdueM} Min.` : `${overdueMins} Min.`;
            const accFee = (overdueMins * Number(activeChargeSession.blocking_fee_per_min || 0.10)).toFixed(2).replace('.', ',');
            feeStatusText = `<span style="color:#ef4444;font-weight:700;">⛔ Blockiergebühr aktiv: seit ${overdueStr} (ca. ${accFee} € aufgelaufen)!</span>`;
        } else if (isNight) {
            feeStatusText = `<span style="color:#38bdf8;font-weight:600;">🌙 Nachtpause aktiv (Frei bis ${escapeHtml(activeChargeSession.deadline_str)} Uhr)</span>`;
        } else if (remSecs <= 300) {
            feeStatusText = `<span style="color:#ef4444;font-weight:700;">🚨 Nur noch ${timeStr} frei!</span>`;
        } else if (remSecs <= 1200) {
            feeStatusText = `<span style="color:#f59e0b;font-weight:700;">⚠️ Noch ${timeStr} frei (bis ${escapeHtml(activeChargeSession.deadline_str)} Uhr)</span>`;
        } else {
            feeStatusText = `<span style="color:#10b981;font-weight:600;">⏱️ Freiparkzeit: noch ${timeStr} (bis ${escapeHtml(activeChargeSession.deadline_str)} Uhr)</span>`;
        }

        const socRemSecs = Math.max(0, Math.floor((activeChargeSession.target_reached_ms - now) / 1000));
        let socStatusText = "";
        if (socRemSecs <= 0) {
            socStatusText = `<span style="color:#10b981;font-weight:700;">✅ Ziel ${activeChargeSession.target_soc}% erreicht!</span>`;
        } else {
            const socMins = Math.ceil(socRemSecs / 60);
            socStatusText = `<span>🎯 <b>Ziel ${activeChargeSession.target_soc}%:</b> in ca. ${socMins} Min. (${escapeHtml(activeChargeSession.target_soc_eta_str || '')})</span>`;
        }

        itemsHtml.push(`
            <div class="banner-item guardian-banner-item" style="border-left: 4px solid var(--cupra-copper); background: rgba(235, 106, 56, 0.08); padding: 8px 12px; border-radius: 8px; margin-bottom: 4px;">
                <div style="display:flex;flex-direction:column;gap:3px;flex:1;">
                    <div style="font-weight:700;color:var(--text-primary);display:flex;align-items:center;gap:6px;font-size:0.88rem;">
                        <span class="live-pulse-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;"></span>
                        🛡️ Lade-Wächter: ${escapeHtml(activeChargeSession.station_name)} (${escapeHtml(activeChargeSession.connector_label)})
                    </div>
                    <div style="font-size:0.8rem;display:flex;gap:12px;flex-wrap:wrap;">
                        ${socStatusText}
                        ${feeStatusText}
                    </div>
                </div>
                <div class="banner-actions">
                    <button class="btn-banner" onclick="stopSmartChargeGuardian()" style="background:rgba(239,68,68,0.2);color:#ef4444;border-color:rgba(239,68,68,0.4);font-weight:600;">⏹️ Beenden</button>
                </div>
            </div>
        `);
    }

    if (parkTimer && !activeChargeSession && parkTimer.endTimestamp > Date.now()) {
        const remSecs = Math.max(0, Math.floor((parkTimer.endTimestamp - Date.now()) / 1000));
        const remHours = Math.floor(remSecs / 3600);
        const remMins = Math.floor((remSecs % 3600) / 60);
        const remS = remSecs % 60;
        const timeStr = `${remHours > 0 ? remHours + 'h ' : ''}${remMins}m ${remS < 10 ? '0' : ''}${remS}s`;
        itemsHtml.push(`
            <div class="banner-item">
                <span>⏱️ <b>Lade-Timer:</b> ${timeStr} verbleibend (${escapeHtml(parkTimer.stationName)})</span>
                <button class="btn-banner" onclick="stopParkTimer()">Stopp</button>
            </div>
        `);
    }

    if (parkedLocation) {
        const gmapsWalkUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(parkedLocation.lat)},${encodeURIComponent(parkedLocation.lon)}&travelmode=walking`;
        itemsHtml.push(`
            <div class="banner-item">
                <span>🅿️ <b>Geparkt an:</b> ${escapeHtml(parkedLocation.name)}</span>
                <div class="banner-actions">
                    <a href="${gmapsWalkUrl}" target="_blank" rel="noopener noreferrer" class="btn-banner">🚶 Zu Fuß zum Auto</a>
                    <button class="btn-banner" onclick="clearParkedCar()">❌</button>
                </div>
            </div>
        `);
    }

    if (itemsHtml.length > 0) {
        banner.innerHTML = itemsHtml.join("");
        banner.style.display = "flex";
    } else {
        banner.innerHTML = "";
        banner.style.display = "none";
    }
}

/* ==========================================================================
   Winter- / Sommer-Modus (Kompensationsschalter 19,5 vs. 16,5 kWh/100km)
   ========================================================================== */
function initWinterMode() {
    try {
        const saved = localStorage.getItem("ev_winter_mode");
        if (saved !== null) {
            winterMode = saved === "true";
        }
    } catch (e) {
        console.warn("Could not load winter mode", e);
    }
    updateWinterUi();
}

function toggleWinterMode() {
    winterMode = !winterMode;
    try {
        localStorage.setItem("ev_winter_mode", winterMode.toString());
    } catch (e) {}
    updateWinterUi();
    showToast(winterMode ? "❄️ Winter-Modus aktiv: Verbrauch kalkuliert mit 19,5 kWh/100km (+18% Heizung)" : "☀️ Sommer-Modus aktiv: Verbrauch kalkuliert mit 16,5 kWh/100km", "info");
    updateCupraUi();
    renderMapMarkers(activeStations, false);
}

function updateWinterUi() {
    const icon = document.getElementById("winter-icon");
    const text = document.getElementById("winter-text");
    const btn = document.getElementById("btn-winter");
    if (!btn) return;

    if (winterMode) {
        if (icon) icon.textContent = "❄️";
        if (text) text.textContent = "Winter";
        btn.classList.add("winter-active");
    } else {
        if (icon) icon.textContent = "☀️";
        if (text) text.textContent = "Sommer";
        btn.classList.remove("winter-active");
    }
}

/* ==========================================================================
   Lokale IndexedDB Datenbank (Ladelogbuch & Community-Störungsmeldungen)
   ========================================================================== */
class EVDatabase {
    constructor() {
        this.dbName = "EVChargeLiveDB";
        this.dbVersion = 1;
        this.db = null;
    }

    async init() {
        if (typeof indexedDB === "undefined") {
            console.warn("IndexedDB not available in this environment.");
            return null;
        }
        return new Promise((resolve) => {
            const req = indexedDB.open(this.dbName, this.dbVersion);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains("charging_logs")) {
                    const store = db.createObjectStore("charging_logs", { keyPath: "id", autoIncrement: true });
                    store.createIndex("timestamp", "timestamp", { unique: false });
                }
                if (!db.objectStoreNames.contains("station_reports")) {
                    const reportStore = db.createObjectStore("station_reports", { keyPath: "stationId" });
                    reportStore.createIndex("expiresAt", "expiresAt", { unique: false });
                }
            };
            req.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };
            req.onerror = (e) => {
                console.error("IndexedDB open error", e);
                resolve(null);
            };
        });
    }

    async addLog(entry) {
        if (!this.db) return null;
        return new Promise((resolve) => {
            const tx = this.db.transaction("charging_logs", "readwrite");
            const store = tx.objectStore("charging_logs");
            const req = store.add(entry);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    }

    async getAllLogs() {
        if (!this.db) return [];
        return new Promise((resolve) => {
            const tx = this.db.transaction("charging_logs", "readonly");
            const store = tx.objectStore("charging_logs");
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    }

    async deleteLog(id) {
        if (!this.db) return false;
        return new Promise((resolve) => {
            const tx = this.db.transaction("charging_logs", "readwrite");
            const store = tx.objectStore("charging_logs");
            const req = store.delete(Number(id));
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
        });
    }

    async saveReport(report) {
        if (!this.db) return false;
        return new Promise((resolve) => {
            const tx = this.db.transaction("station_reports", "readwrite");
            const store = tx.objectStore("station_reports");
            const req = store.put(report);
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
        });
    }

    async getActiveReports() {
        if (!this.db) return [];
        return new Promise((resolve) => {
            const tx = this.db.transaction("station_reports", "readonly");
            const store = tx.objectStore("station_reports");
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    }

    async cleanExpiredReports() {
        if (!this.db) return;
        const now = Date.now();
        const reports = await this.getActiveReports();
        const tx = this.db.transaction("station_reports", "readwrite");
        const store = tx.objectStore("station_reports");
        reports.forEach(r => {
            if (r.expiresAt <= now) {
                store.delete(r.stationId);
            }
        });
    }
}
const evDb = new EVDatabase();

/* ==========================================================================
   Community Störungsmeldung ("Zugeparkt / Defekt")
   ========================================================================== */
async function loadActiveReports() {
    try {
        await evDb.cleanExpiredReports();
        const reports = await evDb.getActiveReports();
        activeReports = {};
        const now = Date.now();
        reports.forEach(r => {
            if (r.expiresAt > now) {
                activeReports[r.stationId] = r;
            }
        });
    } catch (e) {
        console.warn("Could not load reports", e);
    }
}

let pendingReportStationId = null;
let pendingReportStationName = "";

window.reportStationPrompt = function(stationId, stationName) {
    pendingReportStationId = stationId;
    pendingReportStationName = stationName || "Ladestation";
    const nameEl = document.getElementById("report-modal-station-name");
    if (nameEl) nameEl.textContent = `📍 ${pendingReportStationName}`;
    openModal("modal-report-station");
};

window.submitStationReport = async function(type) {
    if (!pendingReportStationId) return;
    const stationId = pendingReportStationId;
    const stationName = pendingReportStationName;
    closeModal("modal-report-station");

    if (type === "blocked") {
        const expiresAt = Date.now() + 2 * 60 * 60 * 1000; // 2 Std. Overlay
        const report = { stationId, stationName, type: "blocked", expiresAt, timestamp: Date.now() };
        await evDb.saveReport(report);
        activeReports[stationId] = report;
        showToast(`⚠️ "${stationName}" für 2h als zugeparkt markiert.`, "warning");
    } else if (type === "defect") {
        const expiresAt = Date.now() + 4 * 60 * 60 * 1000; // 4 Std. Störungs-Overlay
        const report = { stationId, stationName, type: "defect", expiresAt, timestamp: Date.now() };
        await evDb.saveReport(report);
        activeReports[stationId] = report;
        showToast(`⚠️ "${stationName}" für 4h als defekt markiert.`, "error");
    } else if (type === "clear") {
        if (evDb.db) {
            const tx = evDb.db.transaction("station_reports", "readwrite");
            tx.objectStore("station_reports").delete(stationId);
        }
        delete activeReports[stationId];
        showToast(`✅ Meldung für "${stationName}" aufgehoben.`, "success");
    }
    renderMapMarkers(activeStations, false);
};

/* ==========================================================================
   Lade-Logbuch (IndexedDB & CSV Export)
   ========================================================================== */
window.quickLogCharge = async function(stationName, kwh, cost) {
    const entry = {
        stationName,
        kwh: Number(kwh) || 0,
        cost: Number(cost) || 0,
        timestamp: Date.now(),
        dateFormatted: new Date().toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })
    };
    await evDb.addLog(entry);
    showToast(`💾 Ladevorgang gespeichert: ${kwh} kWh an ${stationName}`, "success");
};

window.openLogbookModal = async function() {
    await renderLogbook();
    openModal("modal-logbook");
};

window.closeLogbookModal = function() {
    closeModal("modal-logbook");
};

window.toggleAddLogForm = function() {
    const form = document.getElementById("form-add-log");
    if (!form) return;
    form.style.display = form.style.display === "none" ? "block" : "none";
};

window.submitManualLog = async function() {
    const stationInput = document.getElementById("log-station");
    const kwhInput = document.getElementById("log-kwh");
    const costInput = document.getElementById("log-cost");

    const stationName = (stationInput && stationInput.value.trim()) || "Unbekannte Station";
    const kwh = parseFloat(kwhInput ? kwhInput.value : 0) || 0;
    const cost = parseFloat(costInput ? costInput.value : 0) || 0;

    if (kwh <= 0) {
        showToast("Bitte geladene kWh eingeben (> 0)", "warning");
        return;
    }

    const entry = {
        stationName,
        kwh,
        cost,
        timestamp: Date.now(),
        dateFormatted: new Date().toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })
    };

    await evDb.addLog(entry);
    if (stationInput) stationInput.value = "";
    if (kwhInput) kwhInput.value = "";
    if (costInput) costInput.value = "";
    const form = document.getElementById("form-add-log");
    if (form) form.style.display = "none";

    showToast("✅ Ladevorgang im Logbuch gespeichert", "success");
    await renderLogbook();
};

window.deleteLogEntry = async function(id) {
    if (!confirm("Diesen Eintrag wirklich aus dem Logbuch löschen?")) return;
    await evDb.deleteLog(id);
    showToast("Eintrag gelöscht", "info");
    await renderLogbook();
};

async function renderLogbook() {
    const tbody = document.getElementById("logbook-tbody");
    const sumKwhEl = document.getElementById("sum-kwh");
    const sumCostEl = document.getElementById("sum-cost");
    const sumCountEl = document.getElementById("sum-count");

    if (!tbody) return;

    const logs = await evDb.getAllLogs();
    logs.sort((a, b) => b.timestamp - a.timestamp);

    let totalKwh = 0;
    let totalCost = 0;

    if (logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:24px;">Noch keine Ladevorgänge gespeichert. Ladezeiten an Stationen direkt mit "💾 Zu Logbuch" ablegen!</td></tr>`;
    } else {
        tbody.innerHTML = logs.map(l => {
            totalKwh += (l.kwh || 0);
            totalCost += (l.cost || 0);
            return `
                <tr>
                    <td>${escapeHtml(l.dateFormatted || new Date(l.timestamp).toLocaleDateString("de-DE"))}</td>
                    <td><b>${escapeHtml(l.stationName || "Unbekannt")}</b></td>
                    <td>${(l.kwh || 0).toFixed(1)} kWh</td>
                    <td>${(l.cost || 0).toFixed(2)} €</td>
                    <td>
                        <button class="btn-table-del" onclick="deleteLogEntry(${Number(l.id)})" title="Löschen">🗑️</button>
                    </td>
                </tr>
            `;
        }).join("");
    }

    if (sumKwhEl) sumKwhEl.textContent = totalKwh.toFixed(1) + " kWh";
    if (sumCostEl) sumCostEl.textContent = totalCost.toFixed(2) + " €";
    if (sumCountEl) sumCountEl.textContent = logs.length.toString();
}

window.exportLogbookCsv = async function() {
    const logs = await evDb.getAllLogs();
    if (logs.length === 0) {
        showToast("Keine Einträge zum Exportieren vorhanden.", "warning");
        return;
    }
    logs.sort((a, b) => a.timestamp - b.timestamp);

    const headers = ["ID", "Datum & Uhrzeit", "Station", "Geladene Energie (kWh)", "Kosten (EUR)"];
    const rows = logs.map(l => [
        l.id,
        `"${(l.dateFormatted || new Date(l.timestamp).toLocaleString('de-DE')).replace(/"/g, '""')}"`,
        `"${(l.stationName || '').replace(/"/g, '""')}"`,
        (l.kwh || 0).toFixed(2).replace(".", ","),
        (l.cost || 0).toFixed(2).replace(".", ",")
    ]);

    const csvContent = "\uFEFF" + [headers.join(";"), ...rows.map(r => r.join(";"))].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Cupra_Born_Ladelogbuch_${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("📥 CSV-Export erfolgreich heruntergeladen!", "success");
};

/* ==========================================================================
   QR-Code Scanner & Lade-App Handoff ("ladeapp" & "EnBW")
   ========================================================================== */
let qrMediaStream = null;
let qrScanAnimationId = null;

window.openQrScannerModal = function(context = null) {
    openModal("modal-qr-scanner");
    const resultBox = document.getElementById("qr-result-box");
    if (resultBox) resultBox.style.display = "none";
    const statusPill = document.getElementById("qr-status");
    if (statusPill) {
        statusPill.textContent = context === "ha"
            ? "Kamera auf den Kopplungs-QR-Code auf dem PC richten..."
            : "Kamera wird initialisiert...";
    }

    const manualInput = document.getElementById("manual-qr-input");
    if (manualInput) {
        manualInput.placeholder = context === "ha"
            ? "HA-Pairing JSON oder Server-URL hier einfügen"
            : "z.B. DE*SWH*E000123 oder https://ladeapp.de/...";
    }

    startQrCamera(context);
};

window.closeQrScannerModal = function() {
    stopQrCamera();
    closeModal("modal-qr-scanner");
};

async function startQrCamera(context = null) {
    const video = document.getElementById("qr-video");
    const statusPill = document.getElementById("qr-status");
    if (!video) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        if (statusPill) statusPill.textContent = "Kamera wird in diesem Browser nicht unterstützt. Bitte Code manuell eingeben.";
        return;
    }

    try {
        qrMediaStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        video.srcObject = qrMediaStream;
        await video.play();

        if (statusPill) {
            statusPill.textContent = context === "ha"
                ? "Kamera auf den QR-Code am Bildschirm richten..."
                : "Kamera auf QR-Code an der Säule richten...";
        }
        scanQrFrame();
    } catch (err) {
        console.warn("Camera access failed", err);
        if (statusPill) statusPill.textContent = "Kein Kamerazugriff. Bitte Code manuell eingeben.";
    }
}

function stopQrCamera() {
    if (qrScanAnimationId) {
        cancelAnimationFrame(qrScanAnimationId);
        qrScanAnimationId = null;
    }
    if (qrMediaStream) {
        qrMediaStream.getTracks().forEach(t => t.stop());
        qrMediaStream = null;
    }
    const video = document.getElementById("qr-video");
    if (video) video.srcObject = null;
}

async function scanQrFrame() {
    const video = document.getElementById("qr-video");
    const canvas = document.getElementById("qr-canvas");
    if (!video || !qrMediaStream || video.readyState !== video.HAVE_ENOUGH_DATA) {
        qrScanAnimationId = requestAnimationFrame(scanQrFrame);
        return;
    }

    // 1. Try native BarcodeDetector API if available
    if ("BarcodeDetector" in window) {
        try {
            const detector = new BarcodeDetector({ formats: ["qr_code"] });
            const barcodes = await detector.detect(video);
            if (barcodes && barcodes.length > 0) {
                const code = barcodes[0].rawValue;
                if (code) {
                    onQrCodeScanned(code);
                    return;
                }
            }
        } catch (e) {
            // fallback to jsQR
        }
    }

    // 2. Fallback to jsQR
    if (window.jsQR && canvas) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const qrCode = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: "dontInvert" });
            if (qrCode && qrCode.data) {
                onQrCodeScanned(qrCode.data);
                return;
            }
        }
    }

    qrScanAnimationId = requestAnimationFrame(scanQrFrame);
}

window.handleManualQrSubmit = function() {
    const input = document.getElementById("manual-qr-input");
    if (!input || !input.value.trim()) {
        showToast("Bitte Säulencode oder URL eingeben", "warning");
        return;
    }
    onQrCodeScanned(input.value.trim());
};

function onQrCodeScanned(qrText) {
    stopQrCamera();
    const statusPill = document.getElementById("qr-status");
    if (statusPill) statusPill.textContent = "✅ QR-Code erfolgreich erkannt!";

    const resultBox = document.getElementById("qr-result-box");
    const nameEl = document.getElementById("qr-station-name");
    const opEl = document.getElementById("qr-station-operator");
    const metaEl = document.getElementById("qr-station-meta");
    const swhBox = document.getElementById("qr-swh-buttons");
    const genericBox = document.getElementById("qr-generic-buttons");

    if (!resultBox) return;
    resultBox.style.display = "block";

    // Analyze scanned text
    const clean = qrText.trim();

    // 0. Prüfen auf Home Assistant 1-Klick Kopplung
    let isHaPairing = false;
    let pairingUrl = "";
    let pairingToken = "";

    try {
        if (clean.startsWith("{") && clean.endsWith("}")) {
            const parsed = JSON.parse(clean);
            if (parsed && (parsed.type === "ha_pairing" || parsed.ha_url || parsed.ha_token)) {
                isHaPairing = true;
                pairingUrl = String(parsed.ha_url || "").trim();
                pairingToken = String(parsed.ha_token || "").trim();
            }
        } else if (clean.startsWith("evcharge://pair") || clean.includes("pair?url=")) {
            const urlObj = new URL(clean.replace("evcharge://", "http://"));
            pairingUrl = urlObj.searchParams.get("url") || "";
            pairingToken = urlObj.searchParams.get("token") || "";
            if (pairingUrl) isHaPairing = true;
        }
    } catch (e) {
        // Nicht als JSON oder Pairing-URL interpretierbar
    }

    if (isHaPairing && pairingUrl) {
        localStorage.setItem("ev_ha_server_url", pairingUrl);
        if (pairingToken) {
            localStorage.setItem("ev_ha_token", pairingToken);
        }
        const haUrlInput = document.getElementById("cfg-ha-server-url");
        const haTokenInput = document.getElementById("cfg-ha-token");
        if (haUrlInput) haUrlInput.value = pairingUrl;
        if (haTokenInput && pairingToken) haTokenInput.value = pairingToken;

        resetHaBridgeCache();
        closeQrScannerModal();
        showToast(`🎉 Home Assistant erfolgreich gekoppelt! Server: ${pairingUrl}`, "success");

        // Sofortige Datenaktualisierung: Favoriten, Watchlist & Lade-Wächter kommen jetzt aus HA
        loadFavorites()
            .then(loadWatchlist)
            .then(() => searchStations(false))
            .then(syncChargeSessionFromHa)
            .catch(err => console.warn("Datenabgleich nach Kopplung fehlgeschlagen:", err));
        return;
    }

    let evseId = clean;
    let urlTarget = sanitizeHttpUrl(clean.startsWith("http") ? clean : `https://${clean}`, "https://www.enbw.com");

    // Try to extract EVSE ID if URL
    const urlMatch = clean.match(/(?:id=|evse=|evseId=|\/)([A-Z]{2}[A-Za-z0-9*_\-]+)/i);
    if (urlMatch) {
        evseId = urlMatch[1];
    }

    // Try to match with existing station in activeStations
    const matchedStation = activeStations.find(s => {
        const sid = String(s.id || "").toLowerCase();
        const sname = String(s.name || "").toLowerCase();
        const target = clean.toLowerCase();
        return (sid && (target.includes(sid) || sid.includes(target))) || (sname && target.includes(sname));
    });

    const stationName = matchedStation ? matchedStation.name : (evseId.length > 5 ? `Ladestation (${evseId})` : "Erkannte Ladesäule");
    const operator = matchedStation ? matchedStation.operator : (clean.toLowerCase().includes("swh") || clean.toLowerCase().includes("hockenheim") || clean.toLowerCase().includes("ladeapp") ? "Stadtwerke Hockenheim" : "Ladebetreiber");

    if (nameEl) nameEl.textContent = stationName;
    if (opEl) opEl.textContent = operator;
    if (metaEl) metaEl.textContent = `EVSE-ID / QR: ${clean}`;

    // Vollautomatischer Tarif-Vergleich für die gescannte Säule
    const hasDc = matchedStation ? (matchedStation.connectors || []).some(c => (c.power_kw || 0) > 22) : false;
    let qrMaxPower = 11;
    if (matchedStation && matchedStation.connectors) {
        matchedStation.connectors.forEach(c => {
            const p = parseFloat(c.power_kw) || 0;
            if (p > qrMaxPower) qrMaxPower = p;
        });
    } else if (hasDc) {
        qrMaxPower = 150;
    }
    const currentSoc = getActiveSoc();
    const targetSoc = cupraState.targetSoc || 80;
    const neededKwh = Math.max(5, ((targetSoc - currentSoc) / 100) * (cupraState.batteryCapacity || 58.0));
    const tariffInfo = getAutomatedTariffComparison(operator, hasDc, neededKwh, qrMaxPower);

    const tariffBox = document.getElementById("qr-station-tariff");
    if (tariffBox) {
        const tariffCardsHtml = tariffInfo.cards.map(c => `
            <div class="tariff-card ${c === tariffInfo.cheapest ? 'tariff-card-cheapest' : ''}">
                <div>
                    <div class="tariff-card-name">${escapeHtml(c.name)} ${c === tariffInfo.cheapest ? '🏆' : ''}</div>
                    <div class="tariff-card-sub">${escapeHtml(c.rate)} • ${c.badge}</div>
                </div>
                <div class="tariff-card-right">
                    <div class="tariff-card-total">ca. ${c.totalCost.toFixed(2).replace('.', ',')} €</div>
                </div>
            </div>
        `).join("");

        const savingsHtml = tariffInfo.savings ? `<div class="tariff-savings-tip">💡 <b>Empfehlung:</b> Mit <b>${escapeHtml(tariffInfo.cheapest.name)}</b> sparst du hier ca. <b>${tariffInfo.savings} €</b>!</div>` : '';

        tariffBox.innerHTML = `
            <div class="tariff-advisor-box" style="margin-bottom:12px;">
                <div class="tariff-advisor-header">
                    <span>💳 <b>Tarif-Vergleich (~${neededKwh.toFixed(1)} kWh • ${escapeHtml(tariffInfo.powerCategory.toUpperCase())})</b></span>
                    <span class="badge-cheapest">🏆 ${escapeHtml(tariffInfo.cheapest.name.split(' ')[0])} am günstigsten</span>
                </div>
                <div class="tariff-cards-list">
                    ${tariffCardsHtml}
                </div>
                ${savingsHtml}
            </div>
        `;
    }

    const isSwh = operator.toLowerCase().includes("stadtwerke") || operator.toLowerCase().includes("hockenheim") || clean.toLowerCase().includes("ladeapp") || clean.toLowerCase().includes("swh");

    if (isSwh) {
        if (swhBox) swhBox.style.display = "flex";
        if (genericBox) genericBox.style.display = "none";

        const ladeappUrl = sanitizeHttpUrl(
            clean.startsWith("http") && clean.includes("ladeapp") ? clean : `https://ladeapp.de/station?id=${encodeURIComponent(evseId)}`,
            `https://ladeapp.de/station?id=${encodeURIComponent(evseId)}`
        );
        const enbwUrl = `https://www.enbw.com/elektromobilitaet/produkte-und-tarife/mobilityplus-app?evse=${encodeURIComponent(evseId)}`;
        const adhocUrl = sanitizeHttpUrl(
            clean.startsWith("http") ? clean : `https://directpayment.chargecloud.de/station/${encodeURIComponent(evseId)}`,
            `https://directpayment.chargecloud.de/station/${encodeURIComponent(evseId)}`
        );

        const btnLade = document.getElementById("btn-open-ladeapp");
        const btnEnbw = document.getElementById("btn-open-enbw");
        const btnAdhoc = document.getElementById("btn-open-adhoc-swh");

        if (btnLade) btnLade.href = ladeappUrl;
        if (btnEnbw) btnEnbw.href = enbwUrl;
        if (btnAdhoc) btnAdhoc.href = adhocUrl;
    } else {
        if (swhBox) swhBox.style.display = "none";
        if (genericBox) genericBox.style.display = "flex";

        const primaryName = document.getElementById("primary-app-name");
        if (primaryName) primaryName.textContent = `In ${operator}-App öffnen`;

        const btnPrimary = document.getElementById("btn-open-primary-app");
        const btnEnbwRoam = document.getElementById("btn-open-enbw-roaming");
        const btnAdhocGen = document.getElementById("btn-open-adhoc-generic");

        if (btnPrimary) btnPrimary.href = urlTarget;
        if (btnEnbwRoam) btnEnbwRoam.href = `https://www.enbw.com/elektromobilitaet/produkte-und-tarife/mobilityplus-app?evse=${encodeURIComponent(evseId)}`;
        if (btnAdhocGen) btnAdhocGen.href = urlTarget;
    }

    // Quick action buttons
    const btnToMap = document.getElementById("btn-qr-to-map");
    const btnTimer = document.getElementById("btn-qr-park-timer");
    const btnLog = document.getElementById("btn-qr-logbook");

    if (btnToMap) {
        btnToMap.onclick = () => {
            closeQrScannerModal();
            const stLat = matchedStation ? (matchedStation.latitude ?? matchedStation.lat) : null;
            const stLon = matchedStation ? (matchedStation.longitude ?? matchedStation.lon) : null;
            if (stLat !== null && stLon !== null && !isNaN(Number(stLat)) && !isNaN(Number(stLon))) {
                map.setView([Number(stLat), Number(stLon)], 16);
                showToast(`📍 Zentriert auf ${stationName}`, "info");
            } else {
                showToast("Keine GPS-Koordinaten zu diesem QR-Code in den geladenen Stationen gefunden.", "info");
            }
        };
    }
    if (btnTimer) {
        btnTimer.onclick = () => {
            startParkTimer(isSwh ? 240 : 45, stationName);
            closeQrScannerModal();
        };
    }
    if (btnLog) {
        btnLog.onclick = () => {
            quickLogCharge(stationName, Number(neededKwh.toFixed(1)), Number(tariffInfo.cheapest.totalCost.toFixed(2)));
            closeQrScannerModal();
        };
    }

    showToast(`⚡ Ladesäule erkannt: ${stationName}`, "success");
}

/* ==========================================================================
   Cupra Born Routenplaner mit dynamischen Ladestopps
   ========================================================================== */
let activePlannedRoute = null;
let routePolylineLayer = null;
let routeStopMarkersLayer = null;

window.openRoutePlannerModal = function() {
    updateRouteVehicleBar();
    openModal("modal-route-planner");
};

function updateRouteVehicleBar() {
    const socEl = document.getElementById("route-born-soc");
    const modeEl = document.getElementById("route-v-consumption");
    const modeIcon = document.getElementById("route-v-mode-icon");

    const currentSoc = getActiveSoc();
    if (socEl) socEl.textContent = `${currentSoc}% (${cupraState.batteryCapacity} kWh)`;

    if (winterMode) {
        if (modeIcon) modeIcon.textContent = "❄️";
        if (modeEl) modeEl.textContent = "19,5 kWh / 100 km (Winter)";
    } else {
        if (modeIcon) modeIcon.textContent = "☀️";
        if (modeEl) modeEl.textContent = "16,5 kWh / 100 km (Sommer)";
    }
}

window.setRouteDest = function(city) {
    const destInput = document.getElementById("route-dest-input");
    if (destInput) destInput.value = city;
    runRoutePlanning();
};

window.runRoutePlanning = async function() {
    const destInput = document.getElementById("route-dest-input");
    const bufferInput = document.getElementById("route-buffer-soc");
    const targetSocInput = document.getElementById("route-target-soc");
    const resultBox = document.getElementById("route-result-container");
    const summaryBanner = document.getElementById("route-summary-banner");
    const stopsList = document.getElementById("route-stops-list");
    const btnGmaps = document.getElementById("btn-export-gmaps");

    const destinationQuery = (destInput && destInput.value.trim()) || "";
    if (!destinationQuery) {
        showToast("Bitte einen Zielort eingeben (z.B. Frankfurt)", "warning");
        return;
    }

    const rawBuffer = parseFloat(bufferInput ? bufferInput.value : 10);
    const minBufferSoc = Math.min(40, Math.max(2, isNaN(rawBuffer) ? 10 : rawBuffer));
    const rawTarget = parseFloat(targetSocInput ? targetSocInput.value : 80);
    const targetChargeSoc = Math.min(100, Math.max(minBufferSoc + 20, isNaN(rawTarget) ? 80 : rawTarget));

    if (bufferInput) bufferInput.value = minBufferSoc;
    if (targetSocInput) targetSocInput.value = targetChargeSoc;

    showToast(`🔍 Berechne Route nach "${destinationQuery}"...`, "info");

    // 1. Geocode Destination
    let destLat, destLon, destName;
    try {
        const geoResp = await fetch(getApiUrl(`api/geocode?q=${encodeURIComponent(destinationQuery)}`));
        if (!geoResp.ok) throw new Error(`HTTP ${geoResp.status}`);
        const geoData = await geoResp.json();
        if (Array.isArray(geoData) && geoData.length > 0) {
            destLat = Number(geoData[0].latitude);
            destLon = Number(geoData[0].longitude);
            destName = (geoData[0].display_name || destinationQuery).split(",")[0];
        } else {
            throw new Error("Ort nicht gefunden");
        }
    } catch (e) {
        showToast(`Ort "${destinationQuery}" konnte nicht gefunden werden.`, "error");
        return;
    }

    // 2. Start Location (GPS or Hockenheim default)
    const startLat = (currentDeviceCoords && currentDeviceCoords.lat) ? Number(currentDeviceCoords.lat) : 49.317584;
    const startLon = (currentDeviceCoords && currentDeviceCoords.lon) ? Number(currentDeviceCoords.lon) : 8.545261;

    // 3. Request Driving Route
    let routeData;
    try {
        const routeResp = await fetch(getApiUrl(`api/route?start_lat=${startLat}&start_lon=${startLon}&end_lat=${destLat}&end_lon=${destLon}`));
        if (routeResp.ok) {
            routeData = await routeResp.json();
        }
    } catch (e) {
        console.warn("Route API error", e);
    }

    const totalDistKm = (routeData && routeData.distance_km) || 100;
    const totalDurationMin = (routeData && routeData.duration_minutes) || Math.round(totalDistKm / 90 * 60);
    const coordinates = (routeData && Array.isArray(routeData.coordinates) && routeData.coordinates.length > 0)
        ? routeData.coordinates
        : [[startLat, startLon], [destLat, destLon]];

    // 4. EV Energy Calculation for Cupra Born
    const consumptionKwh = Math.max(5.0, winterMode ? 19.5 : 16.5);
    const batteryCapacity = Math.max(20.0, cupraState.batteryCapacity || 58.0);
    const currentSoc = getActiveSoc();

    // Usable energy until minimum buffer is reached
    const usableSoc = Math.max(0, currentSoc - minBufferSoc);
    const usableKwh = (usableSoc / 100) * batteryCapacity;
    const firstLegMaxRangeKm = Math.round((usableKwh / consumptionKwh) * 100);

    let stops = [];
    let arrivalSoc = 0;

    if (totalDistKm <= firstLegMaxRangeKm) {
        // Direct drive possible without charging!
        const totalEnergyKwh = (totalDistKm * consumptionKwh) / 100;
        arrivalSoc = Math.max(0, Math.round(currentSoc - (totalEnergyKwh / batteryCapacity * 100)));
    } else {
        // Intermediate charging stop(s) needed!
        let remainingKm = totalDistKm;
        let currentLegRange = firstLegMaxRangeKm;
        let progressDistance = 0;
        let maxIterations = 15;

        const rechargedLegKwh = ((targetChargeSoc - minBufferSoc) / 100) * batteryCapacity;
        const rechargedLegRangeKm = Math.max(40, Math.round((rechargedLegKwh / consumptionKwh) * 100));

        while (remainingKm > currentLegRange && maxIterations-- > 0) {
            const stepKm = currentLegRange > 5 ? Math.max(15, currentLegRange * 0.85) : Math.min(5, totalDistKm * 0.05);
            progressDistance = Math.min(totalDistKm * 0.96, progressDistance + stepKm);
            const ratio = Math.min(0.96, Math.max(0.02, progressDistance / totalDistKm));
            const coordIndex = Math.min(coordinates.length - 1, Math.floor(coordinates.length * ratio));
            const stopCoord = coordinates[coordIndex] || [startLat + (destLat - startLat) * ratio, startLon + (destLon - startLon) * ratio];

            // Calculate energy required to charge to target SoC (80%)
            const stopArrivalSoc = stops.length === 0 && currentLegRange <= 5 ? currentSoc : minBufferSoc;
            const chargeNeededKwh = Math.max(5, ((targetChargeSoc - stopArrivalSoc) / 100) * batteryCapacity);
            // Cupra Born DC Curve: average 80 kW charge speed from 10% to 80%
            const chargeDurationMin = Math.max(5, Math.round((chargeNeededKwh / 80.0) * 60));

            stops.push({
                name: `HPC Schnellladepark (Raststätte / Autohof km ${Math.round(progressDistance)})`,
                operator: "EnBW / IONITY / Aral pulse",
                lat: stopCoord[0],
                lon: stopCoord[1],
                power: "300 kW HPC",
                arrivalSoc: stopArrivalSoc,
                targetSoc: targetChargeSoc,
                kwhToCharge: chargeNeededKwh,
                chargeDurationMin
            });

            // Range for next leg from targetChargeSoc (80%) down to minBufferSoc
            currentLegRange = rechargedLegRangeKm;
            remainingKm = Math.max(0, totalDistKm - progressDistance);
        }

        // Final arrival SoC
        const finalLegEnergy = (remainingKm * consumptionKwh) / 100;
        arrivalSoc = Math.max(0, Math.round(targetChargeSoc - (finalLegEnergy / batteryCapacity * 100)));
    }

    // 5. Render Result
    activePlannedRoute = {
        destinationQuery,
        destName,
        startLat,
        startLon,
        destLat,
        destLon,
        totalDistKm,
        totalDurationMin,
        coordinates,
        stops,
        arrivalSoc,
        minBufferSoc
    };

    if (resultBox) resultBox.style.display = "block";

    const hours = Math.floor(totalDurationMin / 60);
    const mins = totalDurationMin % 60;
    const durStr = `${hours > 0 ? hours + 'h ' : ''}${mins}m`;

    if (summaryBanner) {
        summaryBanner.innerHTML = `
            <div class="route-summary-header">
                <h3>🚗 Route: Hockenheim ➔ ${escapeHtml(destName)}</h3>
                <span class="badge ${stops.length === 0 ? 'badge-success' : 'badge-warning'}">
                    ${stops.length === 0 ? '✅ Direkt erreichbar' : `⚡ ${stops.length} Ladestopp erforderlich`}
                </span>
            </div>
            <div class="route-metrics-grid">
                <div class="route-metric-box">
                    <div class="label">Gesamtstrecke</div>
                    <div class="val">${totalDistKm} km</div>
                </div>
                <div class="route-metric-box">
                    <div class="label">Fahrzeit</div>
                    <div class="val">${durStr}</div>
                </div>
                <div class="route-metric-box">
                    <div class="label">Ankunfts-SoC</div>
                    <div class="val" style="color:${arrivalSoc >= minBufferSoc ? '#34d399' : '#f87171'}">${arrivalSoc}%</div>
                </div>
                <div class="route-metric-box">
                    <div class="label">Puffer-Reserve</div>
                    <div class="val">${minBufferSoc}% SoC</div>
                </div>
            </div>
        `;
    }

    if (stopsList) {
        if (stops.length === 0) {
            stopsList.innerHTML = `
                <div class="route-stop-card" style="border-left-color:#10b981;">
                    <div class="stop-info">
                        <h4>🟢 Keine Zwischenladung nötig!</h4>
                        <div class="stop-meta">Die Restreichweite deines Cupra Born reicht bis zum Ziel (Ankunft mit ~${arrivalSoc}% SoC).</div>
                    </div>
                </div>
            `;
        } else {
            stopsList.innerHTML = stops.map((s, idx) => `
                <div class="route-stop-card">
                    <div class="stop-info">
                        <h4>Stopp ${idx + 1}: ${escapeHtml(s.name)}</h4>
                        <div class="stop-meta">${escapeHtml(s.operator)} • ${s.power}</div>
                    </div>
                    <div class="stop-stats">
                        <div class="stop-charge-time">~ ${s.chargeDurationMin} Min.</div>
                        <div class="stop-soc-trans">${s.arrivalSoc}% ➔ ${s.targetSoc}% (+${s.kwhToCharge.toFixed(1)} kWh)</div>
                    </div>
                </div>
            `).join("");
        }
    }

    // Google Maps Multi-Stop Link
    if (btnGmaps) {
        let gmapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${startLat},${startLon}&destination=${destLat},${destLon}`;
        if (stops.length > 0) {
            const waypointsStr = stops.map(s => `${s.lat},${s.lon}`).join("|");
            gmapsUrl += `&waypoints=${encodeURIComponent(waypointsStr)}`;
        }
        btnGmaps.href = gmapsUrl;
    }

    showToast(`✅ Route nach ${destName} berechnet!`, "success");
};

window.showRouteOnMainMap = function() {
    if (!activePlannedRoute) return;
    closeModal("modal-route-planner");

    if (routePolylineLayer) map.removeLayer(routePolylineLayer);
    if (routeStopMarkersLayer) map.removeLayer(routeStopMarkersLayer);

    // Draw Route Polyline
    routePolylineLayer = L.polyline(activePlannedRoute.coordinates, {
        color: "#38bdf8",
        weight: 5,
        opacity: 0.85,
        dashArray: "10, 8"
    }).addTo(map);

    routeStopMarkersLayer = L.layerGroup().addTo(map);

    // Add Stop Markers
    activePlannedRoute.stops.forEach((s, idx) => {
        const stopIcon = L.divIcon({
            className: "custom-div-icon",
            html: `<div class="custom-pin" style="background:#2563eb;color:#fff;font-weight:700;">⚡${idx+1}</div>`,
            iconSize: [36, 36],
            iconAnchor: [18, 18],
            popupAnchor: [0, -18]
        });
        const marker = L.marker([s.lat, s.lon], { icon: stopIcon })
            .bindPopup(`<b>Ladestopp ${idx+1}:</b><br>${escapeHtml(s.name)}<br>~${s.chargeDurationMin} Min. (${s.arrivalSoc}% ➔ ${s.targetSoc}%)`);
        routeStopMarkersLayer.addLayer(marker);
    });

    map.fitBounds(routePolylineLayer.getBounds(), { padding: [50, 50] });
    showToast("🗺️ Route & Ladestopps auf der Karte eingezeichnet", "info");
};

// Settings: checks the typed URL/token against the add-on's bridge sensor (before saving)
window.testHaRemoteConnection = async function() {
    const statusEl = document.getElementById("ha-remote-status");
    const setStatus = (text, color = "") => {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.style.color = color;
    };
    if (!isNativeApp()) {
        setStatus("ℹ️ Der Test läuft in der Android-App – im Browser blockiert Home Assistant den Direktzugriff (CORS).", "#f59e0b");
        return;
    }
    const url = normalizeHaBaseUrl(document.getElementById("cfg-ha-server-url")?.value);
    const token = (document.getElementById("cfg-ha-token")?.value || "").trim();
    if (!url || !token) {
        setStatus("Bitte Server-URL (http:// oder https://) und Long-Lived Token eintragen.", "#f59e0b");
        return;
    }
    setStatus("⏳ Verbinde mit Home Assistant …");
    haAuthState.failedToken = "";
    haCommandState.scriptToken = "";
    try {
        const res = await haRequest(`/api/states/${HA_BRIDGE_ENTITY}`, { ha: { url, token } });
        if (!res.ok) {
            setStatus(`❌ ${describeHaHttpError(res.status)}`, "#ef4444");
            return;
        }
        const snapshot = parseHaBridgeState(res.data);
        if (!snapshot) {
            setStatus("❌ Add-on-Sensor hat ein unbekanntes Format – App und Add-on aktualisieren.", "#ef4444");
            return;
        }
        const when = snapshot.reportedAt
            ? new Date(snapshot.reportedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
            : "?";
        setStatus(
            `✅ Verbunden: ${snapshot.favorites.length} Favoriten, ${snapshot.watchlist.length} beobachtet` +
            `${snapshot.session ? ", Lade-Wächter aktiv" : ""} (Add-on-Stand ${when} Uhr). Speichern nicht vergessen.`,
            "#10b981"
        );
    } catch (e) {
        setStatus(`❌ ${describeHaHttpError(0)}`, "#ef4444");
    }
};

/* ==========================================================================
   Home Assistant 1-Klick Smartphone-Kopplung (QR-Code Generator)
   ========================================================================== */
window.showHaPairingQrModal = async function() {
    openModal("modal-ha-pairing-qr");

    const urlInput = document.getElementById("pairing-modal-url");
    const tokenInput = document.getElementById("pairing-modal-token");

    let currentUrl = (document.getElementById("cfg-ha-server-url")?.value || localStorage.getItem("ev_ha_server_url") || "").trim();
    let currentToken = (document.getElementById("cfg-ha-token")?.value || localStorage.getItem("ev_ha_token") || "").trim();

    if (!currentUrl) {
        try {
            const resp = await fetch(getApiUrl("api/pairing-info"));
            if (resp.ok) {
                const info = await resp.json();
                if (info.ha_url) currentUrl = info.ha_url;
                if (!currentToken && info.ha_token) currentToken = info.ha_token;
            }
        } catch (e) {
            console.warn("Could not fetch pairing info from backend:", e);
        }
    }

    if (!currentUrl) {
        currentUrl = window.location.origin.includes("localhost") ? "http://homeassistant.local:8123" : window.location.origin;
    }

    if (urlInput) urlInput.value = currentUrl;
    if (tokenInput) tokenInput.value = currentToken;

    await renderPairingQrSvg(currentUrl, currentToken);
};

async function renderPairingQrSvg(url, token) {
    const svgWrapper = document.getElementById("ha-pairing-qr-svg-wrapper");
    if (!svgWrapper) return;

    svgWrapper.innerHTML = `<div class="qr-loading-spinner">Generiere QR-Code...</div>`;

    try {
        // Token goes in the POST body: query strings end up in server access logs
        const resp = await fetch(getApiUrl("api/pairing-qr"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: url || null, token: token || null })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const svgText = await resp.text();
        svgWrapper.innerHTML = svgText;
    } catch (err) {
        svgWrapper.innerHTML = `<div style="color:#ef4444;font-size:0.85rem;padding:20px;">Fehler beim Laden des QR-Codes.<br>${escapeHtml(err.message)}</div>`;
    }
}

let pairingQrDebounceTimer = null;
window.updatePairingQrFromModal = function() {
    clearTimeout(pairingQrDebounceTimer);
    pairingQrDebounceTimer = setTimeout(() => {
        const url = (document.getElementById("pairing-modal-url")?.value || "").trim();
        const token = (document.getElementById("pairing-modal-token")?.value || "").trim();
        renderPairingQrSvg(url, token);
    }, 350);
};

window.copyPairingJson = function() {
    const url = (document.getElementById("pairing-modal-url")?.value || "").trim();
    const token = (document.getElementById("pairing-modal-token")?.value || "").trim();
    const payload = {
        type: "ha_pairing",
        version: 1,
        ha_url: url,
        ha_token: token
    };
    const jsonStr = JSON.stringify(payload, null, 2);

    const ta = document.createElement("textarea");
    ta.value = jsonStr;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
        document.execCommand("copy");
        showToast("📋 Pairing-JSON in die Zwischenablage kopiert!", "success");
    } catch (e) {
        showToast("Kopieren fehlgeschlagen: " + e.message, "error");
    }
    document.body.removeChild(ta);
};






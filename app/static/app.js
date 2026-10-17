// Determine Ingress base path dynamically
const getApiUrl = (endpoint) => {
    let path = window.location.pathname;
    if (!path.endsWith('/')) {
        path += '/';
    }
    return `${path}${endpoint.replace(/^\//, '')}`;
};

const escapeHtml = (unsafe) => {
    if (unsafe === null || unsafe === undefined) return "";
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
};

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
let currentConfig = {};
let userLocationMarker = null;
let currentDeviceCoords = null;

// Initialize on DOM Load
document.addEventListener("DOMContentLoaded", async () => {
    initMap();
    setupEventHandlers();
    await loadConfig();
    await loadFavorites();
    await searchStations(true);

    setTimeout(() => {
        if (map) map.invalidateSize();
    }, 300);

    // Auto-refresh every 60 seconds
    setInterval(async () => {
        await searchStations(false);
        await loadFavorites();
    }, 60000);
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
    document.getElementById("btn-search").addEventListener("click", () => searchStations(true));
    document.getElementById("btn-sync").addEventListener("click", triggerSync);
    document.getElementById("btn-favorites").addEventListener("click", () => openModal("modal-favorites"));
    document.getElementById("btn-settings").addEventListener("click", () => openModal("modal-settings"));
    document.getElementById("btn-test-push").addEventListener("click", sendTestPush);
    document.getElementById("settings-form").addEventListener("submit", saveSettings);
}

// Config Loading
async function loadConfig() {
    try {
        const resp = await fetch(getApiUrl("api/config"));
        currentConfig = await resp.json();

        // Populate settings form
        const polling = currentConfig.polling || {};
        const notify = currentConfig.notifications || {};
        const ha = currentConfig.home_assistant_integration || {};

        document.getElementById("cfg-interval").value = polling.interval_seconds || 60;
        document.getElementById("cfg-notify-enabled").checked = notify.enabled !== false;
        document.getElementById("cfg-notify-service").value = notify.service || "notify.notify";
        document.getElementById("cfg-notify-cooldown").value = notify.cooldown_minutes || 10;
        document.getElementById("cfg-title-tpl").value = notify.title_template || "⚡ Ladestation frei: {station_name}";
        document.getElementById("cfg-msg-tpl").value = notify.message_template || "An {station_name} ({address}) sind jetzt {free_slots} von {total_slots} Plätzen frei!";
        document.getElementById("cfg-prefix").value = ha.entity_prefix || "sensor.ev_charge_";
        document.getElementById("cfg-device-tracker").checked = ha.create_device_tracker !== false;
        document.getElementById("cfg-fire-events").checked = ha.fire_ha_events !== false;

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
        const resp = await fetch(getApiUrl("api/favorites"));
        favorites = await resp.json();
        document.getElementById("fav-count").innerText = favorites.length;
        renderFavoritesModal();
    } catch (err) {
        console.error("Failed to load favorites:", err);
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
        const resp = await fetch(getApiUrl(`api/stations?${params.toString()}`));
        activeStations = await resp.json();
        renderMapMarkers(activeStations, adjustView);
    } catch (err) {
        console.error("Failed to search stations:", err);
    }
}

// Render Pins on Map
function renderMapMarkers(stations, adjustView) {
    markersLayer.clearLayers();

    const bounds = [];
    if (currentDeviceCoords && currentDeviceCoords.lat && currentDeviceCoords.lon) {
        bounds.push([currentDeviceCoords.lat, currentDeviceCoords.lon]);
    }

    if (!stations || stations.length === 0) {
        if (adjustView && bounds.length > 0) {
            map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
        }
        return;
    }

    stations.forEach(st => {
        const lat = Number(st.latitude);
        const lon = Number(st.longitude);
        if (!lat || !lon) return;

        bounds.push([lat, lon]);

        // Pin styling based on free slots
        let pinClass = "pin-available";
        let statusBadgeClass = "badge-success";
        if (st.status === "OUTOFORDER") {
            pinClass = "pin-outoforder";
            statusBadgeClass = "badge-danger";
        } else if (st.free_slots === 0) {
            pinClass = "pin-occupied";
            statusBadgeClass = "badge-danger";
        } else if (st.free_slots < st.total_slots) {
            pinClass = "pin-partial";
            statusBadgeClass = "badge-warning";
        }

        const isFav = favorites.some(f => String(f.id) === String(st.id));
        const safeId = escapeHtml(st.id);

        const icon = L.divIcon({
            className: "custom-div-icon",
            html: `<div class="custom-pin ${pinClass}">${isFav ? "★" : Number(st.free_slots || 0)}</div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
            popupAnchor: [0, -18]
        });

        const marker = L.marker([lat, lon], { icon: icon });

        // Build popup content
        const connectorsHtml = (st.connectors || []).map(c => {
            let statusBadge = "";
            const sinceTime = escapeHtml(c.since_time);
            const durStr = escapeHtml(c.duration_str);
            if (c.status === "OCCUPIED") {
                const timeInfo = sinceTime ? ` seit ${sinceTime} Uhr (${durStr})` : "";
                statusBadge = `<span class="badge-occupied">⛔ Belegt${timeInfo}</span>`;
            } else if (c.status === "AVAILABLE") {
                const timeInfo = sinceTime ? ` seit ${sinceTime} Uhr` : "";
                statusBadge = `<span class="badge-available">✅ Frei${timeInfo}</span>`;
            } else {
                statusBadge = `<span class="badge-occupied">⚠️ ${escapeHtml(c.status || 'Unbekannt')}</span>`;
            }
            return `
                <li>
                    <div class="connector-row">
                        <div class="conn-header">
                            <span class="conn-title">⚡ ${escapeHtml(c.standard)}</span>
                            <span style="font-weight:700;color:var(--text-primary);">${escapeHtml(c.power_kw)} kW (${escapeHtml(c.power_type)})</span>
                        </div>
                        <div>${statusBadge}</div>
                    </div>
                </li>
            `;
        }).join("");

        const sourceTag = st.live_source ? `<div style="font-size:11px;color:#94a3b8;margin-top:6px;">📡 ${escapeHtml(st.live_source)}</div>` : '';
        const gmapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(lat)},${encodeURIComponent(lon)}`;

        const popupContent = `
            <div class="station-popup">
                <h3>${escapeHtml(st.name)}</h3>
                <div class="operator">${escapeHtml(st.operator)}</div>
                <div class="address">${escapeHtml(st.address)}, ${escapeHtml(st.postal_code)} ${escapeHtml(st.city)}</div>
                <div class="slots">
                    <span>Verfügbarkeit:</span>
                    <span class="badge ${statusBadgeClass}">${Number(st.free_slots || 0)} von ${Number(st.total_slots || 0)} frei</span>
                </div>
                <ul class="connectors-list">
                    ${connectorsHtml}
                </ul>
                ${sourceTag}
                <div class="nav-buttons-group">
                    <a href="${gmapsUrl}" target="_blank" rel="noopener noreferrer" class="btn-nav btn-gmaps" title="In Google Maps / Android Auto im Cupra Born öffnen">
                        🧭 Google Maps
                    </a>
                    <button class="btn-nav btn-cupra" onclick="sendToCupra('${safeId}')" title="Ziel an Cupra Born senden">
                        🚗 An Cupra Born
                    </button>
                </div>
                <button class="btn-fav-toggle ${isFav ? 'is-fav' : ''}" onclick="toggleFavorite('${safeId}')">
                    ${isFav ? "★ Aus Favoriten entfernen" : "☆ Als HA-Sensor überwachen"}
                </button>
            </div>
        `;

        marker.bindPopup(popupContent);
        markersLayer.addLayer(marker);
    });

    if (adjustView && bounds.length > 0) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    }
}

// Toggle Favorite
window.toggleFavorite = async function(stationId) {
    const station = activeStations.find(s => String(s.id) === String(stationId)) ||
                    favorites.find(f => String(f.id) === String(stationId));
    if (!station) return;

    try {
        const resp = await fetch(getApiUrl("api/favorites/toggle"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(station)
        });
        const res = await resp.json();
        await loadFavorites();
        renderMapMarkers(activeStations, false);
        showToast(
            res.is_favorite ? `★ "${station.name}" zu Favoriten hinzugefügt` : `☆ "${station.name}" aus Favoriten entfernt`,
            "success"
        );
    } catch (err) {
        showToast("Fehler beim Aktualisieren der Favoriten: " + err, "error");
    }
};

// Render Favorites Modal
function renderFavoritesModal() {
    const list = document.getElementById("favorites-list");
    if (!favorites || favorites.length === 0) {
        list.innerHTML = "<p style='color: var(--text-secondary);'>Noch keine Favoriten hinzugefügt. Klicke auf eine Station auf der Karte, um sie zu überwachen.</p>";
        return;
    }

    list.innerHTML = favorites.map(f => {
        let statusBadge = "badge-success";
        if (f.status === "OUTOFORDER") statusBadge = "badge-danger";
        else if (f.free_slots === 0) statusBadge = "badge-danger";
        else if (f.free_slots < f.total_slots) statusBadge = "badge-warning";

        const safeId = escapeHtml(f.id);
        return `
            <div class="favorite-card">
                <div class="favorite-info">
                    <h4>${escapeHtml(f.name)}</h4>
                    <div class="sub">${escapeHtml(f.operator)} &bull; ${escapeHtml(f.address)}</div>
                </div>
                <div class="favorite-actions">
                    <span class="badge ${statusBadge}">${Number(f.free_slots || 0)} / ${Number(f.total_slots || 0)} frei</span>
                    <button class="btn-remove" title="Entfernen" onclick="toggleFavorite('${safeId}')">🗑️</button>
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
    document.getElementById("input-city").value = city;
    document.getElementById("input-zip").value = zip;
    searchStations(true);
};

// Current Location (Xiaomi Phone)
window.applyCurrentLocation = async function() {
    const btn = document.getElementById("btn-current-location");
    const origText = btn ? btn.innerHTML : "📍 Aktueller Standort (Xiaomi)";
    if (btn) {
        btn.innerHTML = "📍 GPS laden...";
        btn.disabled = true;
    }

    try {
        const resp = await fetch(getApiUrl("api/device-location"));
        if (!resp.ok) {
            throw new Error(`Server antwortete mit Status ${resp.status}`);
        }
        const data = await resp.json();

        if (data.latitude && data.longitude) {
            currentDeviceCoords = { lat: data.latitude, lon: data.longitude };
            document.getElementById("input-city").value = "📍 " + (data.name || "Xiaomi 14T Pro");
            document.getElementById("input-zip").value = "";

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

            userLocationMarker = L.marker([data.latitude, data.longitude], { icon: userIcon, zIndexOffset: 1000 })
                .bindPopup(`<b>📱 Dein aktueller Standort</b><br>${escapeHtml(data.name)}<br>GPS-Genauigkeit: ${Math.round(data.accuracy || 10)} m`)
                .addTo(map);

            await searchStations(true);
            showToast(`📍 Standort geladen: ${data.name}`, "success");
        } else {
            showToast("Konnte Standort vom Smartphone nicht ermitteln.", "warning");
        }
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
        await fetch(getApiUrl("api/sync"), { method: "POST" });
        await loadFavorites();
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
        notifications: {
            ...existingNotify,
            enabled: document.getElementById("cfg-notify-enabled").checked,
            service: document.getElementById("cfg-notify-service").value.trim(),
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
        } else {
            showToast("Fehler beim Speichern der Einstellungen.", "error");
        }
    } catch (err) {
        showToast("Netzwerkfehler: " + err, "error");
    }
}

// Modal Helpers
window.openModal = function(id) {
    document.getElementById(id).classList.add("active");
};

window.closeModal = function(id) {
    document.getElementById(id).classList.remove("active");
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


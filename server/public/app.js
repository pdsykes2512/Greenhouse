const API_BASE = window.location.origin + '/api';

let currentStatus = null;
let envChart = null;
let moistureChart = null;
let plantConfigs = {};

// ─── Watering-dots plugin ────────────────────────────────────────────────────
// Marks watering events on the moisture chart as small colored dots at the
// top. When two or more events fall in close succession, the dots stack
// vertically rather than drawing on top of each other.
const wateringLinesPlugin = {
    id: 'wateringLines',
    afterDatasetsDraw(chart, _args, options) {
        const lines = options?.lines;
        if (!lines || lines.length === 0) return;
        const { ctx, chartArea: { top }, scales: { x } } = chart;

        const RADIUS  = 4;
        const SPACING = 9;   // vertical pixels between stacked dots
        const GROUP_PX = 8;  // events within this horizontal distance get stacked

        // Resolve pixel x for every event, drop any that fell off the scale
        const items = lines
            .map(l => ({ ...l, xPos: x.getPixelForValue(l.xIdx) }))
            .filter(i => !isNaN(i.xPos))
            .sort((a, b) => a.xPos - b.xPos);

        // Group events whose dots would visually overlap
        const groups = [];
        let cur = [];
        for (const item of items) {
            if (cur.length === 0 || item.xPos - cur[cur.length - 1].xPos <= GROUP_PX) {
                cur.push(item);
            } else {
                groups.push(cur);
                cur = [item];
            }
        }
        if (cur.length) groups.push(cur);

        ctx.save();
        for (const group of groups) {
            // Within a close-time cluster, only draw one dot per plant (colour)
            const seen = new Set();
            const unique = group.filter(item => {
                if (seen.has(item.color)) return false;
                seen.add(item.color);
                return true;
            });
            // Centre the stack on the average x of the group
            const avgX = unique.reduce((s, i) => s + i.xPos, 0) / unique.length;
            unique.forEach((item, idx) => {
                const dotY = top + RADIUS + 2 + idx * SPACING;
                ctx.beginPath();
                ctx.arc(avgX, dotY, RADIUS, 0, 2 * Math.PI);
                ctx.fillStyle = item.color;
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = 'white';
                ctx.stroke();
            });
        }
        ctx.restore();
    }
};
Chart.register(wateringLinesPlugin);

// ─── Initialisation ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    // Restore the chart range from the previous session
    const savedHours = localStorage.getItem('chart-hours');
    const hoursSelect = document.getElementById('chart-hours');
    if (savedHours && hoursSelect && [...hoursSelect.options].some(o => o.value === savedHours)) {
        hoursSelect.value = savedHours;
    }
    if (hoursSelect) {
        hoursSelect.addEventListener('change', () => {
            localStorage.setItem('chart-hours', hoursSelect.value);
        });
    }

    initCharts();
    fetchStatus();          // initial snapshot
    initLiveUpdates();      // SSE for live updates (falls back to polling)
    setInterval(updateCharts, 60 * 1000);

    // PWA: register service worker, then surface the notification button if the
    // browser supports push and we haven't already subscribed.
    initPWA();
    initPullToRefresh();
    initChartTooltipDismiss();
});

// ─── Pull-to-refresh ─────────────────────────────────────────────────────────
// Touch-only gesture. Pulling down past 80 px clears all caches, unregisters
// the service worker, and reloads — guarantees the absolute latest version.

function initPullToRefresh() {
    const indicator = document.getElementById('refresh-indicator');
    if (!indicator) return;
    const icon = indicator.querySelector('svg');

    const THRESHOLD = 80;
    const MAX_PULL = 140;
    let startY = 0;
    let pullDist = 0;
    let pulling = false;
    let refreshing = false;

    document.addEventListener('touchstart', (e) => {
        if (refreshing || window.scrollY > 0 || e.touches.length !== 1) return;
        startY = e.touches[0].clientY;
        pulling = true;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!pulling || refreshing) return;
        if (window.scrollY > 0) { resetIndicator(); pulling = false; return; }
        pullDist = Math.max(0, e.touches[0].clientY - startY);
        if (pullDist === 0) return;
        const damped = Math.min(pullDist * 0.5, MAX_PULL);
        indicator.style.transform = `translate(-50%, ${damped}px)`;
        indicator.style.opacity = Math.min(pullDist / THRESHOLD, 1).toFixed(2);
        icon.style.transform = `rotate(${Math.min((pullDist / THRESHOLD) * 360, 360)}deg)`;
    }, { passive: true });

    document.addEventListener('touchend', () => {
        if (!pulling || refreshing) return;
        pulling = false;
        if (pullDist > THRESHOLD) {
            triggerRefresh();
        } else {
            resetIndicator();
        }
        pullDist = 0;
    });

    function resetIndicator() {
        indicator.style.transform = '';
        indicator.style.opacity = '';
        icon.style.transform = '';
    }

    async function triggerRefresh() {
        refreshing = true;
        // Settle indicator at top with spinner
        indicator.style.transform = 'translate(-50%, 24px)';
        indicator.style.opacity = '1';
        icon.style.transform = '';
        icon.classList.add('animate-spin');

        try {
            if ('caches' in window) {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
            }
            if ('serviceWorker' in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(r => r.unregister()));
            }
        } catch (e) {
            console.warn('Pull-to-refresh: cache clear failed', e);
        }
        location.reload();
    }
}

// ─── Chart tooltip dismiss on tap-outside ────────────────────────────────────
// Chart.js shows the tooltip on any tap with intersect:false, which on mobile
// means the bubble sticks around. Dismiss it whenever the user taps outside
// either canvas.

function initChartTooltipDismiss() {
    const dismissOutside = (event) => {
        [envChart, moistureChart].forEach(chart => {
            if (!chart || !chart.canvas) return;
            if (!chart.canvas.contains(event.target)) {
                chart.setActiveElements([]);
                chart.tooltip?.setActiveElements?.([], { x: 0, y: 0 });
                chart.update('none');
            }
        });
    };
    document.addEventListener('pointerdown', dismissOutside);
}

// ─── Live updates via Server-Sent Events ─────────────────────────────────────
// Replaces 2-second polling — server pushes a 'status' event whenever data
// changes (sensor POST, control click, calibration). Falls back to polling if
// EventSource is unavailable or the connection drops repeatedly.

let sseFailures = 0;
let pollIntervalId = null;

function initLiveUpdates() {
    if (!('EventSource' in window)) {
        startPolling();
        return;
    }

    const es = new EventSource(`${API_BASE}/events`);

    es.addEventListener('status', (e) => {
        sseFailures = 0;
        stopPolling();
        try {
            const data = JSON.parse(e.data);
            updateUI(data);
            updateConnectionStatus(true);
        } catch (err) {
            console.warn('SSE status parse error:', err);
        }
    });

    es.onopen = () => {
        sseFailures = 0;
        stopPolling();
        updateConnectionStatus(true);
    };

    es.onerror = () => {
        // EventSource auto-reconnects; if it fails repeatedly, fall back to
        // polling so the UI keeps refreshing.
        sseFailures++;
        updateConnectionStatus(false);
        if (sseFailures >= 3 && !pollIntervalId) {
            console.warn('SSE struggling — falling back to polling');
            startPolling();
        }
    };
}

function startPolling() {
    if (pollIntervalId) return;
    pollIntervalId = setInterval(fetchStatus, 2000);
}

function stopPolling() {
    if (pollIntervalId) {
        clearInterval(pollIntervalId);
        pollIntervalId = null;
    }
}

// ─── PWA / Push notifications ────────────────────────────────────────────────

async function initPWA() {
    if (!('serviceWorker' in navigator)) return;

    // When a new SW version activates, it sends SW_UPDATED — reload so we
    // pick up the fresh app.js / index.html instead of running old code.
    let reloading = false;
    navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'SW_UPDATED' && !reloading) {
            reloading = true;
            location.reload();
        }
    });

    try {
        const reg = await navigator.serviceWorker.register('/sw.js');

        // If push is supported and not yet granted, show the Enable button
        if ('PushManager' in window && Notification.permission !== 'granted') {
            const btn = document.getElementById('notif-btn');
            if (btn) btn.classList.remove('hidden');
        }

        // If we already have permission but no subscription (e.g. cleared cache),
        // re-subscribe silently.
        if (Notification.permission === 'granted') {
            const existing = await reg.pushManager.getSubscription();
            if (!existing) await subscribeToPush(reg);
        }
    } catch (e) {
        console.warn('SW registration failed:', e);
    }
}

async function enableNotifications() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        alert('Notifications are not supported in this browser.');
        return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        alert('Notification permission was denied. You can re-enable it from your browser settings.');
        return;
    }

    const reg = await navigator.serviceWorker.ready;
    await subscribeToPush(reg);

    const btn = document.getElementById('notif-btn');
    if (btn) {
        btn.textContent = '🔔 Alerts on';
        btn.disabled = true;
        btn.classList.remove('hover:bg-green-800');
    }
}

async function subscribeToPush(reg) {
    // Fetch the VAPID public key from the server
    const keyRes = await fetch(`${API_BASE}/push/vapid-public-key`);
    if (!keyRes.ok) {
        console.warn('No VAPID key configured on server; push will be disabled.');
        return;
    }
    const { key } = await keyRes.json();

    const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key)
    });

    // Send subscription to server for storage
    await fetch(`${API_BASE}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub)
    });
}

// VAPID keys are base64url-encoded; PushManager wants a Uint8Array
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from(raw, c => c.charCodeAt(0));
}

// ─── Status polling ───────────────────────────────────────────────────────────

async function fetchStatus() {
    try {
        const response = await fetch(`${API_BASE}/status`);
        if (!response.ok) throw new Error('Failed to fetch status');
        const data = await response.json();
        currentStatus = data;
        updateUI(data);
        updateConnectionStatus(true);
    } catch (error) {
        console.error('Error fetching status:', error);
        updateConnectionStatus(false);
    }
}

// ─── UI update ────────────────────────────────────────────────────────────────

function updateUI(data) {
    if (data.latest_reading) {
        const r = data.latest_reading;

        updateGauges(r);

        const secondsAgo = Math.floor((Date.now() - new Date(r.timestamp)) / 1000);
        document.getElementById('last-update').textContent =
            secondsAgo < 60  ? `${secondsAgo}s ago` :
            secondsAgo < 3600 ? `${Math.floor(secondsAgo / 60)}m ago` :
            new Date(r.timestamp).toLocaleString();

        if (r.plants) {
            r.plants.forEach((plant, index) => {
                const valveNum = index + 1;
                // Valve is "open" if either the user has manually triggered it
                // OR the ESP32 reports the valve is currently open (auto-water).
                const manualOpen = data.system_state?.valves?.[valveNum] === true;
                const valveOpen  = manualOpen || plant.valve_state === true;
                updatePlantUI(valveNum, plant, valveOpen);
            });
        }
    }

    if (data.system_state) {
        const state = data.system_state;


        const anyValveOpen = state.valves && Object.values(state.valves).some(v => v);
        const pumpOn = anyValveOpen;
        const pumpIndicator = document.getElementById('pump-indicator');
        pumpIndicator.classList.toggle('status-on', pumpOn);
        pumpIndicator.classList.toggle('status-off', !pumpOn);
        const pumpText = document.getElementById('pump-status-text');
        if (pumpText) pumpText.textContent = pumpOn ? 'On' : 'Off';

        if (state.plants_active) {
            for (let i = 1; i <= 4; i++) {
                const btn = document.getElementById(`plant-${i}-enable-btn`);
                if (!btn) continue;
                const isActive = state.plants_active[i];
                if (isActive) {
                    btn.classList.remove('bg-gray-200', 'text-gray-600');
                    btn.classList.add('bg-green-500', 'text-white');
                    btn.textContent = 'AUTO ON';
                    btn.onclick = () => enablePlant(i, false);
                } else {
                    btn.classList.remove('bg-green-500', 'text-white');
                    btn.classList.add('bg-gray-200', 'text-gray-600');
                    btn.textContent = 'AUTO OFF';
                    btn.onclick = () => enablePlant(i, true);
                }
            }
        }
    }

    if (data.plant_configs) {
        plantConfigs = data.plant_configs;
        populateSettings(data.plant_configs);
    }
}

function formatDuration(seconds) {
    if (seconds < 1) return 'Ready';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function updatePlantUI(plantNum, plant, valveCommandedOpen) {
    const container = document.getElementById(`plant-${plantNum}`);
    if (!container) return;

    const moistureSpan = container.querySelector('.plant-moisture');
    const moistureBar  = container.querySelector('.plant-moisture-bar');
    if (moistureSpan && plant.soil_moisture !== undefined) {
        moistureSpan.textContent = plant.soil_moisture.toFixed(1);
        if (moistureBar) moistureBar.style.height = `${Math.min(Math.max(plant.soil_moisture, 0), 100)}%`;
    }

    const progressSpan = container.querySelector('.plant-progress');
    const progressBar  = container.querySelector('.plant-progress-bar');
    if (progressSpan && plant.progress !== undefined) {
        const cfg = plantConfigs[plantNum] ?? plantConfigs[String(plantNum)];
        if (valveCommandedOpen) {
            progressSpan.textContent = 'Watering';
        } else if (plant.progress >= 100) {
            progressSpan.textContent = 'Ready';
        } else if (cfg?.cooldown_sec) {
            const remainingSec = ((100 - plant.progress) / 100) * cfg.cooldown_sec;
            progressSpan.textContent = formatDuration(remainingSec);
        } else {
            progressSpan.textContent = `${plant.progress}%`;
        }
        if (progressBar) progressBar.style.height = `${Math.min(Math.max(plant.progress, 0), 100)}%`;
    }

    const valveIndicator = container.querySelector('.plant-valve-indicator');
    const valveText      = container.querySelector('.plant-valve-text');
    if (valveIndicator && valveText) {
        valveIndicator.classList.toggle('status-on',  valveCommandedOpen);
        valveIndicator.classList.toggle('status-off', !valveCommandedOpen);
        valveText.textContent = valveCommandedOpen ? 'Open' : 'Closed';
    }

    const valveBtn = document.getElementById(`plant-${plantNum}-valve-btn`);
    if (valveBtn) {
        valveBtn.dataset.open = valveCommandedOpen ? 'true' : 'false';
        valveBtn.textContent  = valveCommandedOpen ? 'CLOSE' : 'OPEN';
        valveBtn.className = valveCommandedOpen
            ? 'px-3 py-1 bg-orange-500 text-white rounded text-xs hover:bg-orange-600 transition w-16 text-center'
            : 'px-3 py-1 bg-blue-500 text-white rounded text-xs hover:bg-blue-600 transition w-16 text-center';
    }
}

// ─── Gauge dials ──────────────────────────────────────────────────────────────

const GAUGE_CX = 60, GAUGE_CY = 70, GAUGE_R = 45;
const GAUGE_CIRC = 282.74, GAUGE_ARC = 212.06;

function gaugeTick(fraction) {
    const rad = (135 + Math.max(0, Math.min(1, fraction)) * 270) * Math.PI / 180;
    const cosA = Math.cos(rad), sinA = Math.sin(rad);
    return {
        x1: (GAUGE_CX + (GAUGE_R - 8) * cosA).toFixed(1),
        y1: (GAUGE_CY + (GAUGE_R - 8) * sinA).toFixed(1),
        x2: (GAUGE_CX + (GAUGE_R + 8) * cosA).toFixed(1),
        y2: (GAUGE_CY + (GAUGE_R + 8) * sinA).toFixed(1)
    };
}

function setGaugeArc(id, fraction) {
    const len = Math.max(0, Math.min(1, fraction)) * GAUGE_ARC;
    document.getElementById(id)?.setAttribute(
        'stroke-dasharray', `${len.toFixed(1)} ${(GAUGE_CIRC - len).toFixed(1)}`
    );
}

// Smooth blue→cyan→green→lime→amber→red gradient based on temperature
function temperatureColor(tempC) {
    const stops = [
        { t: -10, c: [ 37,  99, 235] },  // deep blue
        { t:   5, c: [  6, 182, 212] },  // cyan
        { t:  18, c: [ 16, 185, 129] },  // green
        { t:  25, c: [132, 204,  22] },  // lime
        { t:  32, c: [245, 158,  11] },  // amber
        { t:  50, c: [239,  68,  68] }   // red
    ];
    if (tempC == null || isNaN(tempC)) return 'rgb(156,163,175)';  // gray for unknown
    if (tempC <= stops[0].t) return `rgb(${stops[0].c.join(',')})`;
    if (tempC >= stops[stops.length - 1].t) {
        const last = stops[stops.length - 1].c;
        return `rgb(${last.join(',')})`;
    }
    for (let i = 0; i < stops.length - 1; i++) {
        if (tempC <= stops[i + 1].t) {
            const a = stops[i], b = stops[i + 1];
            const f = (tempC - a.t) / (b.t - a.t);
            const c = a.c.map((v, j) => Math.round(v + (b.c[j] - v) * f));
            return `rgb(${c.join(',')})`;
        }
    }
}

function updateGauges(r) {
    const TEMP_MIN = -10, TEMP_RANGE = 60;

    // Temperature arc — colour shifts blue→green→amber→red with the value
    setGaugeArc('temp-value-arc', (r.temperature - TEMP_MIN) / TEMP_RANGE);
    const tempArc = document.getElementById('temp-value-arc');
    if (tempArc) tempArc.setAttribute('stroke', temperatureColor(r.temperature));
    const tvt = document.getElementById('temp-value-text');
    if (tvt) tvt.textContent = r.temperature != null ? r.temperature.toFixed(1) : '--';

    // High marker (red line)
    if (r.temp_high != null) {
        const t = gaugeTick((r.temp_high - TEMP_MIN) / TEMP_RANGE);
        const tick = document.getElementById('temp-high-tick');
        if (tick) {
            tick.setAttribute('x1', t.x1); tick.setAttribute('y1', t.y1);
            tick.setAttribute('x2', t.x2); tick.setAttribute('y2', t.y2);
        }
        const el = document.getElementById('temp-high');
        if (el) el.textContent = r.temp_high.toFixed(1);
    }

    // Low marker (blue line)
    if (r.temp_low != null) {
        const t = gaugeTick((r.temp_low - TEMP_MIN) / TEMP_RANGE);
        const tick = document.getElementById('temp-low-tick');
        if (tick) {
            tick.setAttribute('x1', t.x1); tick.setAttribute('y1', t.y1);
            tick.setAttribute('x2', t.x2); tick.setAttribute('y2', t.y2);
        }
        const el = document.getElementById('temp-low');
        if (el) el.textContent = r.temp_low.toFixed(1);
    }

    // Humidity arc
    setGaugeArc('hum-value-arc', r.humidity / 100);
    const hvt = document.getElementById('hum-value-text');
    if (hvt) hvt.textContent = r.humidity != null ? r.humidity.toFixed(0) : '--';

    // Absolute humidity
    const absel = document.getElementById('humidity-absolute');
    if (absel) absel.textContent = r.absolute_humidity != null ? r.absolute_humidity.toFixed(1) : '--';
}

function updateConnectionStatus(connected) {
    const el        = document.getElementById('connection-status');
    const indicator = el.querySelector('.status-indicator');
    const text      = el.querySelector('span:last-child');
    indicator.classList.toggle('status-on',    connected);
    indicator.classList.toggle('status-error', !connected);
    indicator.classList.toggle('status-off',   false);
    text.textContent = connected ? 'Connected' : 'Connection Error';
}

// ─── Plant settings (modal) ──────────────────────────────────────────────────

let currentSettingsPlant = 0;  // 0 = closed; 1-4 = open for that plant

// Called from each plant card's gear button. Opens the shared modal.
function toggleSettings(plantNum) {
    openSettings(plantNum);
}

function openSettings(plantNum) {
    const cfg = plantConfigs[plantNum] ?? plantConfigs[String(plantNum)];
    if (!cfg) return;

    currentSettingsPlant = plantNum;
    const name = cfg.name || `Plant ${plantNum}`;

    document.getElementById('modal-title').textContent = name + ' — Settings';
    document.getElementById('modal-name').value     = name;
    document.getElementById('modal-dry').value      = cfg.soil_dry_threshold;
    document.getElementById('modal-wet').value      = cfg.soil_wet_threshold;
    document.getElementById('modal-duration').value = cfg.water_duration_sec;
    document.getElementById('modal-cooldown').value = (cfg.cooldown_sec / 3600).toFixed(2);
    document.getElementById('modal-cal-dry').textContent = cfg.dry_voltage_mv ? cfg.dry_voltage_mv : '--';
    document.getElementById('modal-cal-wet').textContent = cfg.wet_voltage_mv ? cfg.wet_voltage_mv : '--';
    document.getElementById('modal-msg').textContent = '';
    document.getElementById('modal-cal-msg').textContent = '';

    document.getElementById('settings-modal').classList.remove('hidden');
    document.getElementById('modal-name').focus();
}

function closeSettings() {
    currentSettingsPlant = 0;
    document.getElementById('settings-modal').classList.add('hidden');
}

// Click on the dim backdrop closes; click inside the white card doesn't bubble.
function closeSettingsIfBackdrop(event) {
    if (event.target.id === 'settings-modal') closeSettings();
}

// Escape key closes the modal
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentSettingsPlant) closeSettings();
});

// Refresh the modal's calibration display when fresh data arrives via SSE.
// Form fields are NOT touched — that would erase what the user is typing.
function populateSettings(configs) {
    for (let i = 1; i <= 4; i++) {
        const cfg = configs[i] ?? configs[String(i)];
        if (!cfg) continue;

        const name = cfg.name || `Plant ${i}`;

        const title = document.getElementById(`plant-${i}-title`);
        if (title) title.textContent = name;
        if (moistureChart) moistureChart.data.datasets[i - 1].label = name;

        // If modal is open for this plant, live-update the calibration readout
        // (so a calibrate-button click shows the new mV right away).
        if (currentSettingsPlant === i) {
            document.getElementById('modal-cal-dry').textContent = cfg.dry_voltage_mv ? cfg.dry_voltage_mv : '--';
            document.getElementById('modal-cal-wet').textContent = cfg.wet_voltage_mv ? cfg.wet_voltage_mv : '--';
        }
    }
}

async function calibrateSensor(type) {
    const plantNum = currentSettingsPlant;
    if (!plantNum) return;

    const msgEl = document.getElementById('modal-cal-msg');
    const set = (cls, txt) => { msgEl.className = `block text-xs mt-2 ${cls}`; msgEl.textContent = txt; };
    set('text-gray-500', 'Capturing latest reading...');

    try {
        const res = await fetch(`${API_BASE}/calibrate/${plantNum}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type })
        });
        const data = await res.json();
        if (!res.ok) {
            set('text-red-600', data.message || 'Calibration failed');
            return;
        }
        set('text-green-600', `Saved ${type} at ${data.voltage_mv} mV`);
        // SSE will push the updated calibration values; modal display updates via populateSettings
        setTimeout(() => { msgEl.textContent = ''; }, 4000);
    } catch (e) {
        set('text-red-600', 'Network error');
    }
}

async function savePlantConfig() {
    const plantNum = currentSettingsPlant;
    if (!plantNum) return;

    const get = id => document.getElementById(id)?.value;
    const msgEl = document.getElementById('modal-msg');

    const name        = (get('modal-name') || '').trim() || `Plant ${plantNum}`;
    const dry         = parseFloat(get('modal-dry'));
    const wet         = parseFloat(get('modal-wet'));
    const duration    = parseInt(get('modal-duration'), 10);
    const cooldownHrs = parseFloat(get('modal-cooldown'));

    const err = (msg) => { msgEl.textContent = msg; msgEl.className = 'text-xs text-red-600'; };

    if ([dry, wet, duration, cooldownHrs].some(isNaN)) return err('All fields are required.');
    if (dry >= wet)    return err('Dry threshold must be less than wet threshold.');
    if (duration <= 0) return err('Burst duration must be greater than 0.');
    if (cooldownHrs < 0) return err('Cooldown cannot be negative.');

    try {
        const res = await fetch(`${API_BASE}/plant-config/${plantNum}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                soil_dry_threshold: dry,
                soil_wet_threshold: wet,
                water_duration_sec: duration,
                cooldown_sec: Math.round(cooldownHrs * 3600)
            })
        });

        if (!res.ok) {
            const e = await res.json();
            return err(e.message || 'Save failed.');
        }

        // Saved successfully — close the modal
        closeSettings();
    } catch (e) {
        err('Network error.');
    }
}

// ─── Control actions ──────────────────────────────────────────────────────────

async function toggleValve(plantNum) {
    const btn = document.getElementById(`plant-${plantNum}-valve-btn`);
    const isOpen = btn?.dataset.open === 'true';
    await controlValve(plantNum, !isOpen);
}

async function controlValve(valveNum, state) {
    await sendControl({ action: 'valve', valve: valveNum, state });
}

async function enablePlant(plantNum, state) {
    await sendControl({ action: 'enable_plant', valve: plantNum, state });
}

async function sendControl(body) {
    try {
        const res = await fetch(`${API_BASE}/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error('Control request failed');
        fetchStatus();
    } catch (e) {
        console.error('Control error:', e);
        alert('Command failed. Check connection.');
    }
}

// ─── Charts ───────────────────────────────────────────────────────────────────

const PLANT_COLORS = [
    { border: 'rgb(59,130,246)',  bg: 'rgba(59,130,246,0.1)'  },   // blue   — Plant 1
    { border: 'rgb(16,185,129)',  bg: 'rgba(16,185,129,0.1)'  },   // green  — Plant 2
    { border: 'rgb(245,158,11)',  bg: 'rgba(245,158,11,0.1)'  },   // amber  — Plant 3
    { border: 'rgb(239,68,68)',   bg: 'rgba(239,68,68,0.1)'   },   // red    — Plant 4
];

const CHART_OPTS = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12 } } },
    scales: {
        x: { ticks: { maxTicksLimit: 8, maxRotation: 0 } }
    }
};

function initCharts() {
    envChart = new Chart(document.getElementById('envChart'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Temperature (°C)',
                    data: [],
                    borderColor: 'rgb(239,68,68)',
                    backgroundColor: 'rgba(239,68,68,0.1)',
                    borderWidth: 1.5,
                    pointRadius: 0,
                    tension: 0.3,
                    yAxisID: 'yTemp'
                },
                {
                    label: 'Humidity (%)',
                    data: [],
                    borderColor: 'rgb(59,130,246)',
                    backgroundColor: 'rgba(59,130,246,0.1)',
                    borderWidth: 1.5,
                    pointRadius: 0,
                    tension: 0.3,
                    yAxisID: 'yHum'
                }
            ]
        },
        options: {
            ...CHART_OPTS,
            scales: {
                x: CHART_OPTS.scales.x,
                yTemp: { type: 'linear', position: 'left',  min: -10, max: 50, title: { display: true, text: '°C' } },
                yHum:  { type: 'linear', position: 'right', min: 0, max: 100, title: { display: true, text: '%' }, grid: { drawOnChartArea: false } }
            }
        }
    });

    moistureChart = new Chart(document.getElementById('moistureChart'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [1, 2, 3, 4].map(n => ({
                label: `Plant ${n}`,
                data: [],
                borderColor: PLANT_COLORS[n-1].border,
                backgroundColor: PLANT_COLORS[n-1].bg,
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.3
            }))
        },
        options: {
            ...CHART_OPTS,
            scales: {
                x: CHART_OPTS.scales.x,
                y: { min: 0, max: 100, title: { display: true, text: 'Moisture (%)' } }
            },
            plugins: {
                ...CHART_OPTS.plugins,
                wateringLines: { lines: [] }
            }
        }
    });

    updateCharts();
}

async function updateCharts() {
    const hours = parseInt(document.getElementById('chart-hours')?.value) || 24;

    try {
        const res = await fetch(`${API_BASE}/history/all?hours=${hours}`);
        if (!res.ok) throw new Error('Failed to fetch history');
        const data = await res.json();
        const readings = data.readings || [];

        const labelOpts = hours > 48
            ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
            : { hour: '2-digit', minute: '2-digit' };
        const labels = readings.map(r =>
            new Date(r.timestamp).toLocaleString('en-GB', labelOpts)
        );

        // Environment chart
        envChart.data.labels = labels;
        envChart.data.datasets[0].data = readings.map(r => r.temperature);
        envChart.data.datasets[1].data = readings.map(r => r.humidity);
        envChart.update();

        // Moisture chart — one dataset per plant
        moistureChart.data.labels = labels;
        moistureChart.data.datasets[0].data = readings.map(r => r.plant1_moisture);
        moistureChart.data.datasets[1].data = readings.map(r => r.plant2_moisture);
        moistureChart.data.datasets[2].data = readings.map(r => r.plant3_moisture);
        moistureChart.data.datasets[3].data = readings.map(r => r.plant4_moisture);

        // Watering event markers — vertical dashed lines per plant
        const wateringEvents = data.watering_events || [];
        const readingTimes = readings.map(r => new Date(r.timestamp).getTime());
        const lines = wateringEvents.map(evt => {
            const evtTime = new Date(evt.timestamp).getTime();
            let nearestIdx = 0, minDiff = Infinity;
            readingTimes.forEach((t, idx) => {
                const diff = Math.abs(t - evtTime);
                if (diff < minDiff) { minDiff = diff; nearestIdx = idx; }
            });
            return {
                xIdx: nearestIdx,
                color: PLANT_COLORS[evt.plant_number - 1].border,
                label: `P${evt.plant_number}`
            };
        });
        moistureChart.options.plugins.wateringLines.lines = lines;
        moistureChart.update();

    } catch (e) {
        console.error('Error updating charts:', e);
    }
}

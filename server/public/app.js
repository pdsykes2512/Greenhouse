const API_BASE = window.location.origin + '/api';

let currentStatus = null;
let envChart = null;
let moistureChart = null;
let plantConfigs = {};

// ─── Watering-lines plugin ────────────────────────────────────────────────────
// Draws vertical dashed lines on the moisture chart at each watering event.
const wateringLinesPlugin = {
    id: 'wateringLines',
    afterDatasetsDraw(chart, _args, options) {
        const lines = options?.lines;
        if (!lines || lines.length === 0) return;
        const { ctx, chartArea: { top, bottom }, scales: { x } } = chart;
        ctx.save();
        lines.forEach(line => {
            const xPos = x.getPixelForValue(line.xIdx);
            ctx.beginPath();
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = line.color;
            ctx.lineWidth = 1.5;
            ctx.moveTo(xPos, top);
            ctx.lineTo(xPos, bottom);
            ctx.stroke();
        });
        ctx.setLineDash([]);
        lines.forEach(line => {
            const xPos = x.getPixelForValue(line.xIdx);
            ctx.font = 'bold 9px sans-serif';
            const tw = ctx.measureText(line.label).width;
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.fillRect(xPos - tw / 2 - 2, top + 2, tw + 4, 12);
            ctx.fillStyle = line.color;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(line.label, xPos, top + 3);
        });
        ctx.restore();
    }
};
Chart.register(wateringLinesPlugin);

// ─── Initialisation ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    initCharts();
    fetchStatus();
    setInterval(fetchStatus, 2000);
    setInterval(updateCharts, 5 * 60 * 1000);
});

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
                const commandedOpen = data.system_state?.valves?.[valveNum] ?? plant.valve_state;
                updatePlantUI(valveNum, plant, commandedOpen);
            });
        }
    }

    if (data.system_state) {
        const state = data.system_state;

        const autoBtn = document.getElementById('auto-mode-btn');
        if (state.auto_mode) {
            autoBtn.classList.remove('bg-green-700', 'text-green-200');
            autoBtn.classList.add('bg-white', 'text-green-700');
            autoBtn.textContent = 'AUTO ON';
        } else {
            autoBtn.classList.remove('bg-white', 'text-green-700');
            autoBtn.classList.add('bg-green-700', 'text-green-200');
            autoBtn.textContent = 'AUTO OFF';
        }

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
                    btn.textContent = 'ENABLED';
                    btn.onclick = () => enablePlant(i, false);
                } else {
                    btn.classList.remove('bg-green-500', 'text-white');
                    btn.classList.add('bg-gray-200', 'text-gray-600');
                    btn.textContent = 'DISABLED';
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

// ─── Plant settings ───────────────────────────────────────────────────────────

function toggleSettings(plantNum) {
    document.getElementById(`plant-${plantNum}-settings`)?.classList.toggle('hidden');
}

function populateSettings(configs) {
    for (let i = 1; i <= 4; i++) {
        const cfg = configs[i] ?? configs[String(i)];
        if (!cfg) continue;

        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        const name = cfg.name || `Plant ${i}`;

        // Always-updated bits — these don't conflict with anything the user can type
        setText(`plant-${i}-cal-dry`, cfg.dry_voltage_mv ? cfg.dry_voltage_mv : '--');
        setText(`plant-${i}-cal-wet`, cfg.wet_voltage_mv ? cfg.wet_voltage_mv : '--');

        const title = document.getElementById(`plant-${i}-title`);
        if (title) title.textContent = name;
        if (moistureChart) moistureChart.data.datasets[i - 1].label = name;

        // Don't overwrite a panel that the user currently has open and may be editing
        const panel = document.getElementById(`plant-${i}-settings`);
        if (panel && !panel.classList.contains('hidden')) continue;

        const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
        set(`plant-${i}-name`,     name);
        set(`plant-${i}-dry`,      cfg.soil_dry_threshold);
        set(`plant-${i}-wet`,      cfg.soil_wet_threshold);
        set(`plant-${i}-duration`, cfg.water_duration_sec);
        set(`plant-${i}-cooldown`, (cfg.cooldown_sec / 3600).toFixed(2));
    }
}

async function calibrateSensor(plantNum, type) {
    const msgEl = document.getElementById(`plant-${plantNum}-cal-msg`);
    const set = (cls, txt) => { msgEl.className = `block text-[11px] mt-1 ${cls}`; msgEl.textContent = txt; };
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
        // Refresh status so the displayed cal values update
        fetchStatus();
        setTimeout(() => { msgEl.textContent = ''; }, 4000);
    } catch (e) {
        set('text-red-600', 'Network error');
    }
}

async function savePlantConfig(plantNum) {
    const get = id => document.getElementById(id)?.value;
    const msgEl = document.getElementById(`plant-${plantNum}-settings-msg`);

    const name         = (get(`plant-${plantNum}-name`) || '').trim() || `Plant ${plantNum}`;
    const dry          = parseFloat(get(`plant-${plantNum}-dry`));
    const wet          = parseFloat(get(`plant-${plantNum}-wet`));
    const duration     = parseInt(get(`plant-${plantNum}-duration`), 10);
    const cooldownHrs  = parseFloat(get(`plant-${plantNum}-cooldown`));

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

        msgEl.textContent = 'Saved.';
        msgEl.className = 'text-xs text-green-600';
        setTimeout(() => { msgEl.textContent = ''; }, 3000);
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

async function toggleAutoMode() {
    if (!currentStatus?.system_state) return;
    await sendControl({ action: 'auto_mode', enabled: !currentStatus.system_state.auto_mode });
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

// Alert engine — runs on a timer, scans recent readings, fires push notifications
// for important events. Uses the alert_log table to deduplicate so we don't
// re-send the same alert on every tick.

const db = require('./database');
const push = require('./push');

// How long to wait after firing the same alert before re-firing it
const COOLDOWN_MS = {
    'plant-dry-too-long': 6 * 60 * 60 * 1000,    // 6 hours per plant
    'pump-fault':         2 * 60 * 60 * 1000,    // 2 hours per plant
    'data-stale':         60 * 60 * 1000,        // 1 hour
    'water-tank-low':     2 * 60 * 60 * 1000     // 2 hours (when sensor is wired)
};

// Plant is considered "dry too long" if its moisture has been below the dry
// threshold continuously for this long without a successful watering.
const DRY_TOO_LONG_HOURS = 12;

// If we haven't received any reading for this long, the ESP32 is probably down.
const STALE_DATA_MINUTES = 10;

// "Pump fault" = a watering completed but moisture didn't rise by at least
// this many percentage points within the next reading after the measure-pause.
const PUMP_FAULT_DELTA_PCT = 3;

async function maybeFire(kind, plantNum, payload) {
    const cooldownMs = COOLDOWN_MS[kind] ?? (60 * 60 * 1000);

    const lastTs = await new Promise((resolve, reject) =>
        db.getLastAlert(kind, plantNum, (e, ts) => e ? reject(e) : resolve(ts))
    );

    if (lastTs) {
        const sinceMs = Date.now() - new Date(lastTs + 'Z').getTime();
        if (sinceMs < cooldownMs) return false;
    }

    await new Promise((resolve, reject) =>
        db.recordAlert(kind, plantNum, e => e ? reject(e) : resolve())
    );

    if (push.isReady()) {
        await push.sendToAll(payload);
        console.log(`[alert] fired ${kind} (plant=${plantNum ?? 'n/a'})`);
    }
    return true;
}

// ─── Individual checks ────────────────────────────────────────────────────────

function checkDataStale() {
    return new Promise((resolve) => {
        db.getLatestReading((err, reading) => {
            if (err || !reading) return resolve();
            const ageMin = (Date.now() - new Date(reading.timestamp + 'Z').getTime()) / 60000;
            if (ageMin > STALE_DATA_MINUTES) {
                maybeFire('data-stale', null, {
                    title: 'Greenhouse offline',
                    body: `No sensor data for ${Math.floor(ageMin)} min — check the ESP32.`,
                    tag: 'data-stale',
                    requireInteraction: true
                }).then(resolve).catch(resolve);
            } else {
                resolve();
            }
        });
    });
}

function checkPlantDryTooLong() {
    return new Promise((resolve) => {
        // For each plant, look at the last DRY_TOO_LONG_HOURS hours of readings.
        // If moisture has been below the dry threshold for the entire window
        // and the plant is "active", alert.
        db.getAllPlantConfigs((err, configs) => {
            if (err) return resolve();

            const hours = DRY_TOO_LONG_HOURS;
            db.getAllPlantsHistory(hours, (err, rows) => {
                if (err || !rows.length) return resolve();

                Promise.all([1, 2, 3, 4].map(async n => {
                    const cfg = configs[n];
                    if (!cfg) return;
                    const dryThresh = cfg.soil_dry_threshold;
                    const key = `plant${n}_moisture`;

                    // Need at least a minimum number of readings in the window
                    // to say something meaningful. Require ~80% coverage.
                    const expected = (hours * 60); // ~1 reading/min
                    if (rows.length < expected * 0.5) return;

                    // Every non-null reading in window below dry threshold?
                    const allDry = rows.every(r => {
                        const v = r[key];
                        return v == null || v < dryThresh;
                    });

                    if (allDry) {
                        await maybeFire('plant-dry-too-long', n, {
                            title: `${cfg.name || 'Plant ' + n} has been dry`,
                            body: `Below ${dryThresh}% for ${hours}+ hours. Check the water tank or sensor.`,
                            tag: `dry-${n}`,
                            url: '/',
                            requireInteraction: true
                        });
                    }
                })).then(resolve);
            });
        });
    });
}

// Public entry point — runs all checks
async function tick() {
    try {
        await checkDataStale();
        await checkPlantDryTooLong();
    } catch (e) {
        console.error('Alert check failed:', e);
    }
}

function start(intervalSec = 60) {
    setInterval(tick, intervalSec * 1000);
    // First run shortly after startup so the user gets a fast signal if the
    // ESP32 was already offline before the server started.
    setTimeout(tick, 5000);
    console.log(`Alert engine running every ${intervalSec}s`);
}

module.exports = { start, tick };

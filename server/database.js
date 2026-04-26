const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'greenhouse.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to SQLite database');
    initDatabase();
  }
});

function initDatabase() {
  db.serialize(() => {
    // Sensor readings table
    db.run(`
      CREATE TABLE IF NOT EXISTS sensor_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        temperature REAL,
        humidity REAL,
        absolute_humidity REAL,
        temp_high REAL,
        temp_low REAL
      )
    `);

    // Plant data table
    db.run(`
      CREATE TABLE IF NOT EXISTS plant_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reading_id INTEGER,
        plant_number INTEGER,
        soil_moisture REAL,
        soil_temp REAL,
        valve_state BOOLEAN,
        progress_percent INTEGER,
        FOREIGN KEY (reading_id) REFERENCES sensor_readings(id)
      )
    `);

    // System state table (single row)
    db.run(`
      CREATE TABLE IF NOT EXISTS system_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pump_override BOOLEAN DEFAULT 0,
        valve1_override BOOLEAN DEFAULT 0,
        valve2_override BOOLEAN DEFAULT 0,
        valve3_override BOOLEAN DEFAULT 0,
        valve4_override BOOLEAN DEFAULT 0,
        plant1_active BOOLEAN DEFAULT 0,
        plant2_active BOOLEAN DEFAULT 0,
        plant3_active BOOLEAN DEFAULT 0,
        plant4_active BOOLEAN DEFAULT 0,
        auto_mode BOOLEAN DEFAULT 1,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add columns if they don't exist (for existing databases)
    db.run(`ALTER TABLE system_state ADD COLUMN plant1_active BOOLEAN DEFAULT 0`, () => {});
    db.run(`ALTER TABLE system_state ADD COLUMN plant2_active BOOLEAN DEFAULT 0`, () => {});
    db.run(`ALTER TABLE system_state ADD COLUMN plant3_active BOOLEAN DEFAULT 0`, () => {});
    db.run(`ALTER TABLE system_state ADD COLUMN plant4_active BOOLEAN DEFAULT 0`, () => {});
    db.run(`ALTER TABLE system_state ADD COLUMN pump_override_at DATETIME DEFAULT NULL`, () => {});
    db.run(`ALTER TABLE plant_config ADD COLUMN name TEXT NOT NULL DEFAULT ''`, () => {
      // Set default names for any rows that have an empty name
      db.run(`UPDATE plant_config SET name = 'Plant ' || plant_number WHERE name = ''`);
    });
    db.run(`ALTER TABLE plant_config ADD COLUMN dry_voltage_mv INTEGER`, () => {});
    db.run(`ALTER TABLE plant_config ADD COLUMN wet_voltage_mv INTEGER`, () => {});
    db.run(`ALTER TABLE plant_data ADD COLUMN soil_voltage_mv INTEGER`, () => {});

    // Insert initial system state if not exists
    db.run(`
      INSERT OR IGNORE INTO system_state (id) VALUES (1)
    `);

    // Configuration table
    db.run(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    // Web Push subscriptions
    db.run(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        subscription TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Recent alert log — used to dedupe so we don't spam the same notification
    db.run(`
      CREATE TABLE IF NOT EXISTS alert_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        plant_number INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_alert_log_kind_ts ON alert_log(kind, timestamp)`);

    // Per-plant watering settings
    db.run(`
      CREATE TABLE IF NOT EXISTS plant_config (
        plant_number       INTEGER PRIMARY KEY CHECK (plant_number BETWEEN 1 AND 4),
        soil_dry_threshold REAL    NOT NULL DEFAULT 60.0,
        soil_wet_threshold REAL    NOT NULL DEFAULT 80.0,
        water_duration_sec INTEGER NOT NULL DEFAULT 15,
        cooldown_sec       INTEGER NOT NULL DEFAULT 3600
      )
    `);

    db.run(`
      INSERT OR IGNORE INTO plant_config
        (plant_number, name, soil_dry_threshold, soil_wet_threshold, water_duration_sec, cooldown_sec)
      VALUES
        (1, 'Plant 1', 45.0, 60.0, 45, 14400),
        (2, 'Plant 2', 60.0, 80.0, 15, 3600),
        (3, 'Plant 3', 60.0, 80.0, 15, 3600),
        (4, 'Plant 4', 60.0, 80.0, 20, 3600)
    `);

    console.log('Database tables initialized');
  });
}

// Database operations
const database = {
  // Insert sensor reading with plant data
  insertReading: (data, callback) => {
    db.serialize(() => {
      db.run(
        `INSERT INTO sensor_readings
         (timestamp, temperature, humidity, absolute_humidity, temp_high, temp_low)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          data.timestamp || new Date().toISOString(),
          data.temperature,
          data.humidity,
          data.absolute_humidity,
          data.temp_high,
          data.temp_low
        ],
        function(err) {
          if (err) {
            return callback(err);
          }

          const readingId = this.lastID;

          // Insert plant data
          const stmt = db.prepare(`
            INSERT INTO plant_data
            (reading_id, plant_number, soil_moisture, soil_voltage_mv, soil_temp, valve_state, progress_percent)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `);

          data.plants.forEach(plant => {
            stmt.run(
              readingId,
              plant.plant,
              plant.soil_moisture,
              plant.soil_voltage_mv ?? null,
              plant.soil_temp,
              plant.valve_state ? 1 : 0,
              plant.progress
            );
          });

          stmt.finalize((err) => {
            callback(err, readingId);
          });
        }
      );
    });
  },

  // Get latest reading with plant data
  getLatestReading: (callback) => {
    db.get(
      `SELECT * FROM sensor_readings ORDER BY timestamp DESC LIMIT 1`,
      (err, reading) => {
        if (err) return callback(err);
        if (!reading) return callback(null, null);

        db.all(
          `SELECT * FROM plant_data WHERE reading_id = ? ORDER BY plant_number`,
          [reading.id],
          (err, plants) => {
            if (err) return callback(err);

            reading.plants = plants.map(p => ({
              plant: p.plant_number,
              soil_moisture: p.soil_moisture,
              soil_temp: p.soil_temp,
              valve_state: p.valve_state === 1,
              progress: p.progress_percent
            }));

            callback(null, reading);
          }
        );
      }
    );
  },

  // Get current system commands/state
  getCommands: (callback) => {
    db.get(
      `SELECT * FROM system_state WHERE id = 1`,
      (err, row) => {
        if (err) return callback(err);

        const commands = {
          auto_mode: row.auto_mode === 1,
          pump_override: row.pump_override === 1,
          valves: {
            1: row.valve1_override === 1,
            2: row.valve2_override === 1,
            3: row.valve3_override === 1,
            4: row.valve4_override === 1
          },
          plants_active: {
            1: row.plant1_active === 1,
            2: row.plant2_active === 1,
            3: row.plant3_active === 1,
            4: row.plant4_active === 1
          },
          timestamp: row.last_updated
        };

        callback(null, commands);
      }
    );
  },

  // Update system command
  updateCommand: (command, value, callback) => {
    const validCommands = {
      'auto_mode': 'auto_mode',
      'pump_override': 'pump_override',
      'valve1': 'valve1_override',
      'valve2': 'valve2_override',
      'valve3': 'valve3_override',
      'valve4': 'valve4_override',
      'plant1_active': 'plant1_active',
      'plant2_active': 'plant2_active',
      'plant3_active': 'plant3_active',
      'plant4_active': 'plant4_active'
    };

    const column = validCommands[command];
    if (!column) {
      return callback(new Error('Invalid command'));
    }

    // Track when pump override is manually enabled so the timeout can clear it
    const extra = (command === 'pump_override')
      ? (value ? ', pump_override_at = CURRENT_TIMESTAMP' : ', pump_override_at = NULL')
      : '';

    db.run(
      `UPDATE system_state SET ${column} = ?, last_updated = CURRENT_TIMESTAMP${extra} WHERE id = 1`,
      [value ? 1 : 0],
      (err) => {
        callback(err);
      }
    );
  },

  // Get all plant watering configs
  getAllPlantConfigs: (callback) => {
    db.all(
      `SELECT plant_number, name, soil_dry_threshold, soil_wet_threshold,
              water_duration_sec, cooldown_sec, dry_voltage_mv, wet_voltage_mv
       FROM plant_config ORDER BY plant_number`,
      (err, rows) => {
        if (err) return callback(err);
        const configs = {};
        rows.forEach(r => {
          configs[r.plant_number] = {
            name:               r.name,
            soil_dry_threshold: r.soil_dry_threshold,
            soil_wet_threshold: r.soil_wet_threshold,
            water_duration_sec: r.water_duration_sec,
            cooldown_sec:       r.cooldown_sec,
            dry_voltage_mv:     r.dry_voltage_mv ?? 0,
            wet_voltage_mv:     r.wet_voltage_mv ?? 0
          };
        });
        callback(null, configs);
      }
    );
  },

  // Latest raw mV captured for a plant (used by calibrate endpoint)
  getLatestPlantVoltage: (plantNumber, callback) => {
    db.get(
      `SELECT pd.soil_voltage_mv, sr.timestamp
       FROM plant_data pd
       JOIN sensor_readings sr ON pd.reading_id = sr.id
       WHERE pd.plant_number = ?
       ORDER BY sr.id DESC
       LIMIT 1`,
      [plantNumber],
      (err, row) => {
        if (err) return callback(err);
        callback(null, row || null);
      }
    );
  },

  // Set the dry/wet calibration voltage for a single plant
  setCalibration: (plantNumber, type, voltage_mv, callback) => {
    if (type !== 'wet' && type !== 'dry') {
      return callback(new Error('Invalid calibration type'));
    }
    const column = type === 'wet' ? 'wet_voltage_mv' : 'dry_voltage_mv';
    db.run(
      `UPDATE plant_config SET ${column} = ? WHERE plant_number = ?`,
      [voltage_mv, plantNumber],
      callback
    );
  },

  // Clear both calibration points for a plant (revert to manufacturer regression)
  clearCalibration: (plantNumber, callback) => {
    db.run(
      `UPDATE plant_config SET dry_voltage_mv = NULL, wet_voltage_mv = NULL WHERE plant_number = ?`,
      [plantNumber],
      callback
    );
  },

  // Update watering config for one plant — uses UPSERT so the calibration
  // columns (dry_voltage_mv, wet_voltage_mv) aren't wiped out on save.
  updatePlantConfig: (plantNumber, config, callback) => {
    db.run(
      `INSERT INTO plant_config
         (plant_number, name, soil_dry_threshold, soil_wet_threshold,
          water_duration_sec, cooldown_sec)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(plant_number) DO UPDATE SET
         name               = excluded.name,
         soil_dry_threshold = excluded.soil_dry_threshold,
         soil_wet_threshold = excluded.soil_wet_threshold,
         water_duration_sec = excluded.water_duration_sec,
         cooldown_sec       = excluded.cooldown_sec`,
      [plantNumber, config.name, config.soil_dry_threshold, config.soil_wet_threshold,
       config.water_duration_sec, config.cooldown_sec],
      (err) => callback(err)
    );
  },

  // Get history for all plants in one query (for charts)
  getAllPlantsHistory: (hours, callback) => {
    const query = `
      SELECT
        sr.timestamp,
        sr.temperature,
        sr.humidity,
        p1.soil_moisture AS plant1_moisture,
        p2.soil_moisture AS plant2_moisture,
        p3.soil_moisture AS plant3_moisture,
        p4.soil_moisture AS plant4_moisture
      FROM sensor_readings sr
      LEFT JOIN plant_data p1 ON sr.id = p1.reading_id AND p1.plant_number = 1
      LEFT JOIN plant_data p2 ON sr.id = p2.reading_id AND p2.plant_number = 2
      LEFT JOIN plant_data p3 ON sr.id = p3.reading_id AND p3.plant_number = 3
      LEFT JOIN plant_data p4 ON sr.id = p4.reading_id AND p4.plant_number = 4
      WHERE datetime(sr.timestamp) >= datetime('now', '-' || ? || ' hours')
      ORDER BY sr.timestamp ASC
    `;
    db.all(query, [hours], (err, rows) => {
      if (err) return callback(err);
      callback(null, rows);
    });
  },

  // Get historical data
  getHistory: (hours, plantNumber, callback) => {
    const query = `
      SELECT
        sr.timestamp,
        sr.temperature,
        sr.humidity,
        sr.absolute_humidity,
        pd.soil_moisture,
        pd.soil_temp,
        pd.valve_state
      FROM sensor_readings sr
      LEFT JOIN plant_data pd ON sr.id = pd.reading_id AND pd.plant_number = ?
      WHERE datetime(sr.timestamp) >= datetime('now', '-' || ? || ' hours')
      ORDER BY sr.timestamp ASC
    `;

    db.all(query, [plantNumber, hours], (err, rows) => {
      if (err) return callback(err);

      const readings = rows.map(row => ({
        timestamp: row.timestamp,
        temperature: row.temperature,
        humidity: row.humidity,
        absolute_humidity: row.absolute_humidity,
        soil_moisture: row.soil_moisture,
        soil_temp: row.soil_temp,
        valve_state: row.valve_state === 1
      }));

      callback(null, readings);
    });
  },

  // Auto-clear pump override if it has been on longer than timeoutMinutes
  clearExpiredPumpOverride: (timeoutMinutes, callback) => {
    db.run(
      `UPDATE system_state
       SET pump_override = 0, pump_override_at = NULL, last_updated = CURRENT_TIMESTAMP
       WHERE id = 1
         AND pump_override = 1
         AND pump_override_at IS NOT NULL
         AND pump_override_at <= datetime('now', '-' || ? || ' minutes')`,
      [timeoutMinutes],
      function(err) {
        callback(err, this.changes);
      }
    );
  },

  // Get timestamps when each plant's valve first opened (0→1 transitions) within a window
  getWateringEvents: (hours, callback) => {
    const query = `
      SELECT sub.timestamp, sub.plant_number
      FROM (
        SELECT sr.timestamp, pd.plant_number, pd.valve_state,
               LAG(pd.valve_state, 1, 0) OVER (
                   PARTITION BY pd.plant_number ORDER BY sr.id
               ) AS prev_state
        FROM sensor_readings sr
        JOIN plant_data pd ON sr.id = pd.reading_id
        WHERE datetime(sr.timestamp) >= datetime('now', '-' || ? || ' hours')
      ) sub
      WHERE sub.valve_state = 1 AND sub.prev_state = 0
      ORDER BY sub.timestamp ASC
    `;
    db.all(query, [hours], (err, rows) => {
      if (err) return callback(err);
      callback(null, rows);
    });
  },

  // High/low temperature recorded since midnight (server local time / UTC)
  getDailyTempRange: (callback) => {
    db.get(
      `SELECT MAX(temperature) AS temp_high, MIN(temperature) AS temp_low
       FROM sensor_readings
       WHERE datetime(timestamp) >= datetime('now', 'start of day')`,
      (err, row) => {
        if (err) return callback(err);
        callback(null, row || { temp_high: null, temp_low: null });
      }
    );
  },

  // ─── Push subscriptions ────────────────────────────────────────────────────
  addPushSubscription: (subscription, callback) => {
    db.run(
      `INSERT OR REPLACE INTO push_subscriptions (endpoint, subscription) VALUES (?, ?)`,
      [subscription.endpoint, JSON.stringify(subscription)],
      callback
    );
  },

  removePushSubscription: (endpoint, callback) => {
    db.run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [endpoint], callback);
  },

  getAllPushSubscriptions: (callback) => {
    db.all(`SELECT subscription FROM push_subscriptions`, (err, rows) => {
      if (err) return callback(err);
      callback(null, rows.map(r => JSON.parse(r.subscription)));
    });
  },

  // ─── Alert log (for deduplication) ─────────────────────────────────────────
  // Returns the most recent alert of a given kind+plant, so the alert engine
  // can decide whether to re-fire (e.g. don't spam the same dry-too-long
  // alert every minute).
  getLastAlert: (kind, plantNumber, callback) => {
    db.get(
      `SELECT timestamp FROM alert_log
       WHERE kind = ? AND (plant_number IS ? OR plant_number = ?)
       ORDER BY id DESC LIMIT 1`,
      [kind, plantNumber, plantNumber],
      (err, row) => {
        if (err) return callback(err);
        callback(null, row ? row.timestamp : null);
      }
    );
  },

  recordAlert: (kind, plantNumber, callback) => {
    db.run(
      `INSERT INTO alert_log (kind, plant_number) VALUES (?, ?)`,
      [kind, plantNumber],
      callback
    );
  },

  // Get system statistics
  getStats: (callback) => {
    db.get(
      `SELECT
        COUNT(*) as total_readings,
        MIN(timestamp) as first_reading,
        MAX(timestamp) as last_reading
       FROM sensor_readings`,
      (err, stats) => {
        callback(err, stats);
      }
    );
  }
};

module.exports = database;

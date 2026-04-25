const express = require('express');
const router = express.Router();
const db = require('../database');

// POST /api/data - Receive sensor data from ESP32
router.post('/data', (req, res) => {
  const data = req.body;

  if (!data.temperature || !data.humidity || !data.plants) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields' });
  }

  if (!Array.isArray(data.plants) || data.plants.length === 0) {
    return res.status(400).json({ status: 'error', message: 'Invalid plants data' });
  }

  db.insertReading(data, (err, readingId) => {
    if (err) {
      console.error('Error inserting reading:', err);
      return res.status(500).json({ status: 'error', message: 'Database error' });
    }

    console.log(`Data stored: Reading ID ${readingId}, Temp ${data.temperature}°C`);

    // Return today's MIN/MAX so the ESP32 can show the same Hi/Lo as the website
    db.getDailyTempRange((err, range) => {
      if (err) range = {};
      res.json({
        status: 'ok',
        stored: true,
        reading_id: readingId,
        temp_high: range?.temp_high ?? null,
        temp_low:  range?.temp_low  ?? null
      });
    });
  });
});

// GET /api/commands - ESP32 polls for control commands (includes plant settings)
router.get('/commands', (req, res) => {
  db.getCommands((err, commands) => {
    if (err) {
      console.error('Error getting commands:', err);
      return res.status(500).json({ status: 'error', message: 'Database error' });
    }

    db.getAllPlantConfigs((err, plantConfigs) => {
      if (err) {
        console.error('Error getting plant configs:', err);
        return res.status(500).json({ status: 'error', message: 'Database error' });
      }

      res.json({ ...commands, plant_settings: plantConfigs });
    });
  });
});

// GET /api/status - Current system status for web UI
router.get('/status', (req, res) => {
  db.getLatestReading((err, reading) => {
    if (err) {
      console.error('Error getting latest reading:', err);
      return res.status(500).json({ status: 'error', message: 'Database error' });
    }

    db.getCommands((err, commands) => {
      if (err) {
        console.error('Error getting commands:', err);
        return res.status(500).json({ status: 'error', message: 'Database error' });
      }

      db.getStats((err, stats) => {
        if (err) stats = {};

        db.getAllPlantConfigs((err, plantConfigs) => {
          if (err) plantConfigs = {};

          db.getDailyTempRange((err, range) => {
            if (err) range = {};

            // Override the per-reading temp_high/low with today's MIN/MAX from
            // every reading, so the UI doesn't reset when the ESP32 reboots.
            if (reading && range) {
              if (range.temp_high != null) reading.temp_high = range.temp_high;
              if (range.temp_low  != null) reading.temp_low  = range.temp_low;
            }

            res.json({
              latest_reading: reading,
              system_state:   commands,
              stats:          stats,
              plant_configs:  plantConfigs
            });
          });
        });
      });
    });
  });
});

// POST /api/control - Web UI sends control commands
router.post('/control', (req, res) => {
  const { action, valve, state, enabled } = req.body;

  if (!action) {
    return res.status(400).json({ status: 'error', message: 'Missing action parameter' });
  }

  let command, value;

  switch (action) {
    case 'valve':
      if (valve < 1 || valve > 4) {
        return res.status(400).json({ status: 'error', message: 'Invalid valve number (1-4)' });
      }
      command = `valve${valve}`;
      value = state === true || state === 'true' || state === 1;
      break;

    case 'pump':
      command = 'pump_override';
      value = state === true || state === 'true' || state === 1;
      break;

    case 'auto_mode':
      command = 'auto_mode';
      value = enabled === true || enabled === 'true' || enabled === 1;
      break;

    case 'enable_plant':
      if (valve < 1 || valve > 4) {
        return res.status(400).json({ status: 'error', message: 'Invalid plant number (1-4)' });
      }
      command = `plant${valve}_active`;
      value = state === true || state === 'true' || state === 1;
      break;

    default:
      return res.status(400).json({ status: 'error', message: 'Invalid action' });
  }

  db.updateCommand(command, value, (err) => {
    if (err) {
      console.error('Error updating command:', err);
      return res.status(500).json({ status: 'error', message: 'Database error' });
    }

    console.log(`Command updated: ${command} = ${value}`);
    res.json({ status: 'ok', applied: true, command, value });
  });
});

// GET /api/plant-config - All plant watering configs (for settings UI)
router.get('/plant-config', (req, res) => {
  db.getAllPlantConfigs((err, configs) => {
    if (err) {
      console.error('Error getting plant configs:', err);
      return res.status(500).json({ status: 'error', message: 'Database error' });
    }
    res.json(configs);
  });
});

// POST /api/plant-config/:plant - Save watering settings for one plant
router.post('/plant-config/:plant', (req, res) => {
  const plantNumber = parseInt(req.params.plant, 10);
  if (plantNumber < 1 || plantNumber > 4) {
    return res.status(400).json({ status: 'error', message: 'Plant must be 1-4' });
  }

  const { name, soil_dry_threshold, soil_wet_threshold, water_duration_sec, cooldown_sec } = req.body;

  if (soil_dry_threshold === undefined || soil_wet_threshold === undefined ||
      water_duration_sec === undefined || cooldown_sec === undefined) {
    return res.status(400).json({ status: 'error', message: 'Missing fields' });
  }

  const dry  = parseFloat(soil_dry_threshold);
  const wet  = parseFloat(soil_wet_threshold);
  const dur  = parseInt(water_duration_sec, 10);
  const cool = parseInt(cooldown_sec, 10);

  if (isNaN(dry) || isNaN(wet) || isNaN(dur) || isNaN(cool)) {
    return res.status(400).json({ status: 'error', message: 'Non-numeric values' });
  }
  if (dry >= wet) {
    return res.status(400).json({ status: 'error', message: 'Dry threshold must be less than wet threshold' });
  }
  if (dur <= 0) {
    return res.status(400).json({ status: 'error', message: 'Burst duration must be > 0' });
  }
  if (cool < 0) {
    return res.status(400).json({ status: 'error', message: 'Cooldown cannot be negative' });
  }

  const plantName = (name || '').toString().trim().slice(0, 32) || `Plant ${plantNumber}`;

  db.updatePlantConfig(plantNumber,
    { name: plantName, soil_dry_threshold: dry, soil_wet_threshold: wet, water_duration_sec: dur, cooldown_sec: cool },
    (err) => {
      if (err) {
        console.error('Error updating plant config:', err);
        return res.status(500).json({ status: 'error', message: 'Database error' });
      }
      console.log(`Plant ${plantNumber} config updated`);
      res.json({ status: 'ok', plant: plantNumber });
    }
  );
});

// POST /api/calibrate/:plant - Capture the latest voltage reading as the dry or wet reference
router.post('/calibrate/:plant', (req, res) => {
  const plantNumber = parseInt(req.params.plant, 10);
  const { type } = req.body;

  if (plantNumber < 1 || plantNumber > 4) {
    return res.status(400).json({ status: 'error', message: 'Plant must be 1-4' });
  }
  if (type !== 'wet' && type !== 'dry') {
    return res.status(400).json({ status: 'error', message: "Type must be 'wet' or 'dry'" });
  }

  db.getLatestPlantVoltage(plantNumber, (err, row) => {
    if (err) {
      console.error('Error reading latest voltage:', err);
      return res.status(500).json({ status: 'error', message: 'Database error' });
    }
    if (!row || row.soil_voltage_mv == null) {
      return res.status(409).json({ status: 'error', message: 'No voltage recorded yet — wait for the next sensor read' });
    }

    const voltage_mv = row.soil_voltage_mv;
    db.setCalibration(plantNumber, type, voltage_mv, (err) => {
      if (err) {
        console.error('Error saving calibration:', err);
        return res.status(500).json({ status: 'error', message: 'Database error' });
      }
      console.log(`Plant ${plantNumber} calibrated ${type} at ${voltage_mv} mV (reading ${row.timestamp})`);
      res.json({ status: 'ok', plant: plantNumber, type, voltage_mv, captured_at: row.timestamp });
    });
  });
});

// POST /api/calibrate/:plant/clear - Clear both calibration points
router.post('/calibrate/:plant/clear', (req, res) => {
  const plantNumber = parseInt(req.params.plant, 10);
  if (plantNumber < 1 || plantNumber > 4) {
    return res.status(400).json({ status: 'error', message: 'Plant must be 1-4' });
  }
  db.clearCalibration(plantNumber, (err) => {
    if (err) {
      console.error('Error clearing calibration:', err);
      return res.status(500).json({ status: 'error', message: 'Database error' });
    }
    res.json({ status: 'ok', plant: plantNumber });
  });
});

// GET /api/history/all - All-plants history for charts
router.get('/history/all', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;

  if (hours < 1 || hours > 168) {
    return res.status(400).json({ status: 'error', message: 'Hours must be between 1 and 168' });
  }

  db.getAllPlantsHistory(hours, (err, rows) => {
    if (err) {
      console.error('Error getting all-plants history:', err);
      return res.status(500).json({ status: 'error', message: 'Database error' });
    }

    db.getWateringEvents(hours, (err, events) => {
      if (err) events = [];
      res.json({ hours, count: rows.length, readings: rows, watering_events: events });
    });
  });
});

// GET /api/history - Single-plant historical data (kept for compatibility)
router.get('/history', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const plant = parseInt(req.query.plant) || 1;

  if (hours < 1 || hours > 168) {
    return res.status(400).json({ status: 'error', message: 'Hours must be between 1 and 168' });
  }

  if (plant < 1 || plant > 4) {
    return res.status(400).json({ status: 'error', message: 'Plant must be between 1 and 4' });
  }

  db.getHistory(hours, plant, (err, readings) => {
    if (err) {
      console.error('Error getting history:', err);
      return res.status(500).json({ status: 'error', message: 'Database error' });
    }
    res.json({ hours, plant, count: readings.length, readings });
  });
});

// GET /api/stats
router.get('/stats', (req, res) => {
  db.getStats((err, stats) => {
    if (err) {
      console.error('Error getting stats:', err);
      return res.status(500).json({ status: 'error', message: 'Database error' });
    }
    res.json(stats);
  });
});

module.exports = router;

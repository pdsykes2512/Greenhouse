# Greenhouse Control Server

Node.js server for greenhouse monitoring and control system.

## Setup

### Install Dependencies

```bash
cd server
npm install
```

### Run Development Server

```bash
npm start
```

The server will start on port 3000.

### API Endpoints

- **POST** `/api/data` - Receive sensor data from ESP32
- **GET** `/api/commands` - ESP32 polls for control commands
- **GET** `/api/status` - Get current system status
- **POST** `/api/control` - Send control commands
- **GET** `/api/history` - Get historical data for charts
- **GET** `/health` - Health check endpoint

### Web Interface

Open `http://localhost:3000` in your browser to access the control dashboard.

## Deployment on VPS

### 1. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Copy files to VPS

```bash
scp -r server/ user@your-vps-ip:~/greenhouse/
```

### 3. Install dependencies on VPS

```bash
ssh user@your-vps-ip
cd ~/greenhouse
npm install --production
```

### 4. Create systemd service

Create `/etc/systemd/system/greenhouse.service`:

```ini
[Unit]
Description=Greenhouse Control Server
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/home/your-username/greenhouse
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=greenhouse

Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

### 5. Enable and start service

```bash
sudo systemctl daemon-reload
sudo systemctl enable greenhouse
sudo systemctl start greenhouse
sudo systemctl status greenhouse
```

### 6. View logs

```bash
sudo journalctl -u greenhouse -f
```

## Database

The SQLite database (`greenhouse.db`) is created automatically on first run.

### Backup database

```bash
cp greenhouse.db greenhouse.db.backup
```

## Configuration

- Port: Change `PORT` environment variable (default: 3000)
- CORS: All origins allowed by default (adjust in `server.js` for production)

## Testing

Test the API with curl:

```bash
# Health check
curl http://localhost:3000/health

# Get status
curl http://localhost:3000/api/status

# Send test data
curl -X POST http://localhost:3000/api/data \
  -H "Content-Type: application/json" \
  -d '{
    "temperature": 24.5,
    "humidity": 65.2,
    "absolute_humidity": 14.8,
    "temp_high": 28.3,
    "temp_low": 18.7,
    "plants": [
      {"plant": 1, "soil_moisture": 45.2, "soil_temp": 22.1, "valve_state": false, "progress": 67},
      {"plant": 2, "soil_moisture": 52.3, "soil_temp": 22.5, "valve_state": false, "progress": 82},
      {"plant": 3, "soil_moisture": 38.1, "soil_temp": 21.8, "valve_state": false, "progress": 45},
      {"plant": 4, "soil_moisture": 61.2, "soil_temp": 23.1, "valve_state": false, "progress": 91}
    ]
  }'

# Control valve
curl -X POST http://localhost:3000/api/control \
  -H "Content-Type: application/json" \
  -d '{"action": "valve", "valve": 1, "state": true}'
```

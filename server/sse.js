// Server-Sent Events broadcaster.
// Tracks connected clients and pushes updates when sensor data or system state
// changes. Replaces 2-second polling on the dashboard.

const clients = new Set();

function addClient(res) {
    clients.add(res);
    res.on('close', () => clients.delete(res));
}

function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
        try { res.write(payload); } catch (_) { clients.delete(res); }
    }
}

// Heartbeat every 25 s — keeps the connection alive under most proxy idle
// timeouts (Cloudflare's default is 100s) and gives the client a quick way
// to detect a dead socket.
setInterval(() => {
    for (const res of clients) {
        try { res.write(': ping\n\n'); } catch (_) { clients.delete(res); }
    }
}, 25000);

module.exports = {
    addClient,
    broadcast,
    clientCount: () => clients.size
};

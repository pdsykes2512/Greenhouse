// Web Push helper — loads VAPID keys from vapid-keys.json (or env vars),
// configures web-push, and exposes sendToAll() for fan-out.

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const db = require('./database');

let configured = false;
let publicKey = null;

function configure() {
    let keys = null;

    // Env vars take precedence (useful for systemd / docker)
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        keys = {
            publicKey:  process.env.VAPID_PUBLIC_KEY,
            privateKey: process.env.VAPID_PRIVATE_KEY
        };
    } else {
        const keyPath = path.join(__dirname, 'vapid-keys.json');
        if (fs.existsSync(keyPath)) {
            try {
                keys = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
            } catch (e) {
                console.error('Failed to parse vapid-keys.json:', e);
            }
        }
    }

    if (!keys) {
        console.warn('No VAPID keys found — push notifications disabled.');
        console.warn('Run: cd server && npm run generate-vapid');
        return;
    }

    const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    publicKey = keys.publicKey;
    configured = true;
    console.log('Web Push configured. Public key:', publicKey);
}

configure();

function isReady() {
    return configured;
}

function getPublicKey() {
    return publicKey;
}

// Send a notification to every stored subscription.
// payload: { title, body, tag?, url?, requireInteraction? }
async function sendToAll(payload) {
    if (!configured) return { sent: 0, failed: 0, skipped: true };

    const subs = await new Promise((resolve, reject) => {
        db.getAllPushSubscriptions((err, rows) => err ? reject(err) : resolve(rows));
    });

    let sent = 0, failed = 0;
    const body = JSON.stringify(payload);

    await Promise.all(subs.map(sub =>
        webpush.sendNotification(sub, body)
            .then(() => { sent++; })
            .catch(err => {
                failed++;
                // 410 Gone or 404 Not Found → subscription is dead, prune it
                if (err.statusCode === 410 || err.statusCode === 404) {
                    db.removePushSubscription(sub.endpoint, () => {});
                } else {
                    console.warn('Push send failed:', err.statusCode, err.body);
                }
            })
    ));

    return { sent, failed };
}

module.exports = { isReady, getPublicKey, sendToAll };

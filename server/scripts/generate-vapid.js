// Generates a VAPID keypair for Web Push and writes it to vapid-keys.json
// Run once with: node scripts/generate-vapid.js
// The file is gitignored — keep the privateKey secret.

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const outPath = path.join(__dirname, '..', 'vapid-keys.json');

if (fs.existsSync(outPath) && !process.argv.includes('--force')) {
    console.error(`Refusing to overwrite ${outPath}. Use --force to regenerate.`);
    console.error('NOTE: regenerating invalidates every existing push subscription.');
    process.exit(1);
}

const keys = webpush.generateVAPIDKeys();
fs.writeFileSync(outPath, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });

console.log('VAPID keypair written to', outPath);
console.log('Public key:', keys.publicKey);
console.log('Subject (set in env VAPID_SUBJECT, e.g. mailto:you@example.com)');

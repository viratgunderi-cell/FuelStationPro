/**
 * FuelBunk Pro — Setup Script
 * Run: npm run setup
 *
 * Downloads Chart.js to public/chart.min.js so it can be served
 * locally and cached by the Service Worker for offline use.
 * NOTE: Never exits with code 1 — download failure is non-fatal.
 *       The app falls back to the cdnjs CDN at runtime if the file is missing.
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CHART_URL = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const DEST      = path.join(__dirname, '..', 'src', 'public', 'chart.min.js');
const SHOTS_DIR = path.join(__dirname, '..', 'src', 'public', 'screenshots');

// Ensure screenshots directory exists
if (!fs.existsSync(SHOTS_DIR)) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  console.log('✅ Created src/public/screenshots/');
}

// Skip if already downloaded
if (fs.existsSync(DEST)) {
  const kb = (fs.statSync(DEST).size / 1024).toFixed(1);
  console.log(`✅ chart.min.js already present (${kb} KB) — skipping download`);
  process.exit(0);
}

console.log('⬇️  Downloading Chart.js 4.4.1...');
const file = fs.createWriteStream(DEST);

https.get(CHART_URL, res => {
  if (res.statusCode !== 200) {
    file.close();
    fs.unlink(DEST, () => {});
    console.warn(`⚠️  Chart.js download skipped (HTTP ${res.statusCode}) — CDN fallback will be used at runtime`);
    return; // non-fatal
  }
  res.pipe(file);
  file.on('finish', () => {
    file.close();
    const kb = (fs.statSync(DEST).size / 1024).toFixed(1);
    console.log(`✅ Chart.js downloaded (${kb} KB) → src/public/chart.min.js`);
  });
}).on('error', err => {
  file.close();
  fs.unlink(DEST, () => {});
  console.warn('⚠️  Chart.js download error (non-fatal):', err.message, '— CDN fallback will be used at runtime');
  // DO NOT process.exit(1) — Railway build must succeed regardless
});

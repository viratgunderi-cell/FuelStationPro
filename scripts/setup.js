/**
 * FuelBunk Pro — Setup Script
 * Run: npm run setup
 * 
 * Downloads Chart.js to public/chart.min.js so it can be served
 * locally and cached by the Service Worker for offline use (Fix F-07).
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CHART_URL  = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const DEST       = path.join(__dirname, '..', 'src', 'public', 'chart.min.js');
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'src', 'public', 'screenshots');

// Ensure screenshots directory exists
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  console.log('✅ Created public/screenshots/ directory');
  console.log('   → Add dashboard-mobile.png (390×844) and dashboard-tablet.png (1024×768)');
  console.log('   → These are used in manifest.json screenshots field for PWA install sheets\n');
}

// Download Chart.js
if (fs.existsSync(DEST)) {
  const size = fs.statSync(DEST).size;
  console.log(`✅ chart.min.js already exists (${(size/1024).toFixed(1)}KB) — skipping download`);
  process.exit(0);
}

console.log('⬇️  Downloading Chart.js 4.4.1 to public/chart.min.js...');
const file = fs.createWriteStream(DEST);
https.get(CHART_URL, res => {
  if (res.statusCode !== 200) {
    fs.unlinkSync(DEST);
    console.error('❌ Download failed — HTTP', res.statusCode);
    console.log('   Manual download:', CHART_URL);
    console.log('   Save to: src/public/chart.min.js');
    process.exit(1);
  }
  res.pipe(file);
  file.on('finish', () => {
    file.close();
    const size = fs.statSync(DEST).size;
    console.log(`✅ Chart.js downloaded (${(size/1024).toFixed(1)}KB) → src/public/chart.min.js`);
    console.log('\n📋 Next steps:');
    console.log('  1. Run: npm install   (installs web-push for background push notifications)');
    console.log('  2. Run: npm run generate-vapid   (generates VAPID keys)');
    console.log('  3. Add VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_MAILTO to your .env file');
    console.log('  4. Add screenshots to src/public/screenshots/ (see above)\n');
  });
}).on('error', err => {
  fs.unlink(DEST, () => {});
  console.error('❌ Download error:', err.message);
  process.exit(1);
});

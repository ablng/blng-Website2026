const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const url = args[0];
const outputName = args[1] || 'screenshot';

if (!url) {
  console.error('Usage: node tools/screenshot.js <url> [output-name]');
  console.error('Example: node tools/screenshot.js http://localhost:3000 homepage');
  process.exit(1);
}

const outputDir = path.join(__dirname, '..', '.tmp', 'screenshots');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet',  width: 768,  height: 1024 },
  { name: 'mobile',  width: 375,  height: 812 },
];

(async () => {
  const browser = await puppeteer.launch({ headless: true });

  for (const vp of viewports) {
    const page = await browser.newPage();
    await page.setViewport({ width: vp.width, height: vp.height });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    const file = path.join(outputDir, `${outputName}-${vp.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`Saved: ${file}`);
    await page.close();
  }

  await browser.close();
})();

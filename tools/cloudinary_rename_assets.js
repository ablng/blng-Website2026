#!/usr/bin/env node
/**
 * cloudinary_rename_assets.js
 * Renames a list of Cloudinary public IDs (from -> to). Generic tool for
 * fixing mis-prefixed/mis-numbered uploads without re-uploading.
 *
 * Usage: node tools/cloudinary_rename_assets.js
 * Edit the RENAMES array below, or import renameAsset() from another script.
 * Reads credentials from .env (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)
 */

'use strict';

const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ── Load .env ─────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m) process.env[m[1]] = m[2];
  });
}

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY    = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;
const RATE_LIMIT_MS = 400;

if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
  console.error('Missing CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, or CLOUDINARY_API_SECRET.');
  process.exit(1);
}

// ── EDIT THIS: list of {from, to} public IDs ─────────────────────────────────
const RENAMES = [
  { from: 'cultural-mextropoli-pavilion-01',         to: 'work-mextropoli-pavilion-01' },
  { from: 'cultural-mextropoli-pavilion-02',         to: 'work-mextropoli-pavilion-02' },
  { from: 'cultural-mextropoli-pavilion-03',         to: 'work-mextropoli-pavilion-03' },
  { from: 'cultural-mextropoli-pavilion-04',         to: 'work-mextropoli-pavilion-04' },
  { from: 'cultural-mextropoli-pavilion-05_ohmmhz',  to: 'work-mextropoli-pavilion-05' },
];

// ── HELPERS ───────────────────────────────────────────────────────────────────

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', d => (raw += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sign(params) {
  const EXCLUDE = new Set(['api_key', 'resource_type', 'type', 'file', 'url']);
  const str = Object.keys(params)
    .filter(k => !EXCLUDE.has(k))
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(str + API_SECRET).digest('hex');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function renameAsset(from, to) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const params = { from_public_id: from, timestamp, to_public_id: to };
  const signature = sign(params);
  const body = new URLSearchParams({ ...params, api_key: API_KEY, signature }).toString();
  const opts = {
    hostname: 'api.cloudinary.com',
    path:     `/v1_1/${CLOUD_NAME}/image/rename`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  };
  const { status, body: res } = await request(opts, body);
  if (status !== 200) throw new Error(`${status} ${JSON.stringify(res)}`);
  return res;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Cloudinary rename — cloud: ${CLOUD_NAME}\n`);
  let ok = 0, fail = 0;
  for (const { from, to } of RENAMES) {
    try {
      await renameAsset(from, to);
      console.log(`  ✓ ${from}\n    → ${to}`);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${from}: ${err.message}`);
      fail++;
    }
    await sleep(RATE_LIMIT_MS);
  }
  console.log(`\n${ok} renamed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * cloudinary_replace_gallery.js
 * Replaces a project's gallery images in Cloudinary from a local folder.
 * Local files must be named by gallery number (02.jpg, 03.jpg, ...). Each is
 * uploaded as <folder>-NN (overwriting + CDN-invalidating any existing asset).
 * Any other <folder>-* asset not in KEEP and not just uploaded is deleted.
 *
 * Usage: node tools/cloudinary_replace_gallery.js <folder> <localDir> [overrideDir]
 *   folder      e.g. work-eam-headquarters
 *   localDir    folder with NN.jpg files
 *   overrideDir optional folder whose NN.jpg files take precedence (e.g. converted TIFFs)
 * Reads credentials from .env (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET)
 */

'use strict';

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
const KEEP       = new Set(['01']);   // gallery numbers to leave untouched
const MAX_BYTES  = 10 * 1024 * 1024;  // Free plan image upload limit

const [folder, localDir, overrideDir] = process.argv.slice(2);
if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
  console.error('Missing CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, or CLOUDINARY_API_SECRET.');
  process.exit(1);
}
if (!folder || !localDir) {
  console.error('Usage: node tools/cloudinary_replace_gallery.js <folder> <localDir> [overrideDir]');
  process.exit(1);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function sign(params) {
  const str = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(str + API_SECRET).digest('hex');
}

const auth = 'Basic ' + Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');

async function listAssets() {
  const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/resources/image/upload?prefix=${encodeURIComponent(folder + '-')}&max_results=500`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  const body = await res.json();
  if (!res.ok) throw new Error(`List error ${res.status}: ${JSON.stringify(body)}`);
  return body.resources.map(r => r.public_id);
}

async function upload(filePath, publicId) {
  const params = { invalidate: 'true', overwrite: 'true', public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)) };
  const form = new FormData();
  Object.entries(params).forEach(([k, v]) => form.append(k, v));
  form.append('api_key', API_KEY);
  form.append('signature', sign(params));
  form.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, { method: 'POST', body: form });
  const body = await res.json();
  if (!res.ok) throw new Error(`Upload error ${publicId} ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function destroy(publicIds) {
  const qs = publicIds.map(id => `public_ids[]=${encodeURIComponent(id)}`).join('&') + '&invalidate=true';
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/resources/image/upload?${qs}`, { method: 'DELETE', headers: { Authorization: auth } });
  const body = await res.json();
  if (!res.ok) throw new Error(`Delete error ${res.status}: ${JSON.stringify(body)}`);
  return body.deleted;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

(async () => {
  const files = fs.readdirSync(localDir).filter(f => /^\d{2}\.jpe?g$/i.test(f)).sort();
  if (!files.length) throw new Error(`No NN.jpg files in ${localDir}`);

  // Validate everything before touching Cloudinary
  const plan = files.map(f => {
    const num = f.slice(0, 2);
    if (KEEP.has(num)) throw new Error(`${f} collides with kept image ${num}`);
    const override = overrideDir && path.join(overrideDir, f);
    const src = override && fs.existsSync(override) ? override : path.join(localDir, f);
    const buf = fs.readFileSync(src);
    if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error(`${src} is not a real JPEG`);
    if (buf.length > MAX_BYTES) throw new Error(`${src} exceeds 10 MB upload limit`);
    return { num, src, publicId: `${folder}-${num}` };
  });

  const before = await listAssets();
  console.log('Before:', before.join(', '));

  for (const p of plan) {
    const r = await upload(p.src, p.publicId);
    console.log(`Uploaded ${p.publicId}  <-  ${p.src}  (${r.width}x${r.height})`);
  }

  const uploaded = new Set(plan.map(p => p.publicId));
  const keep = new Set([...KEEP].map(n => `${folder}-${n}`));
  const stale = before.filter(id => !uploaded.has(id) && !keep.has(id));
  if (stale.length) console.log('Deleted:', JSON.stringify(await destroy(stale)));

  console.log('After:', (await listAssets()).join(', '));
})().catch(e => { console.error(e.message); process.exit(1); });

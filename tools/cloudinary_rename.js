#!/usr/bin/env node
/**
 * cloudinary_rename.js
 * Strips 6-character random suffixes (_xxxxxx) from all asset filenames
 * in the Cloudinary "projects/" folder and all subfolders.
 *
 * Usage: node tools/cloudinary_rename.js
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

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY    = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

// Assets live at root level (no folder). Set to a prefix string to narrow scope,
// or leave empty to process everything.
const SEARCH_PREFIX   = '';
const SUFFIX_RE       = /^(.+)_[a-z0-9]{6}$/;   // matches _xxxxxx at end of filename
const RATE_LIMIT_MS   = 350;                      // ms between rename calls

if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
  console.error('Missing CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, or CLOUDINARY_API_SECRET.');
  process.exit(1);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

/** Basic HTTP request returning parsed JSON */
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', d => (raw += d));
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          resolve({ status: res.statusCode, body: json });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Basic auth header */
function basicAuth() {
  return 'Basic ' + Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
}

/**
 * Sign Cloudinary Upload API params.
 * Signature = SHA1(sorted_params_string + api_secret)
 * where sorted_params_string = "key1=val1&key2=val2..." sorted alphabetically,
 * excluding api_key, resource_type, type, file, url.
 */
function sign(params) {
  const EXCLUDE = new Set(['api_key', 'resource_type', 'type', 'file', 'url']);
  const str = Object.keys(params)
    .filter(k => !EXCLUDE.has(k))
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(str + API_SECRET).digest('hex');
}

/** Sleep */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── LIST ALL RESOURCES ────────────────────────────────────────────────────────
/**
 * Uses the Admin API search endpoint to list all assets under SEARCH_PREFIX.
 * Handles pagination via next_cursor.
 * Covers all resource types (image, video, raw) in one go.
 */
async function listAllResources() {
  const resources = [];
  // Cloudinary separates resources by type; check image + video + raw
  const RESOURCE_TYPES = ['image', 'video', 'raw'];

  for (const rType of RESOURCE_TYPES) {
    let nextCursor = null;
    do {
      let qs = `max_results=500&type=upload`;
      if (SEARCH_PREFIX) qs += `&prefix=${encodeURIComponent(SEARCH_PREFIX)}`;
      if (nextCursor)    qs += `&next_cursor=${encodeURIComponent(nextCursor)}`;

      const opts = {
        hostname: 'api.cloudinary.com',
        path:     `/v1_1/${CLOUD_NAME}/resources/${rType}?${qs}`,
        method:   'GET',
        headers:  { 'Authorization': basicAuth() },
      };

      const { status, body } = await request(opts, null);
      if (status !== 200) {
        throw new Error(`List error [${rType}] ${status}: ${JSON.stringify(body)}`);
      }

      const batch = (body.resources || []).map(r => ({ ...r, resource_type: rType }));
      resources.push(...batch);
      nextCursor = body.next_cursor || null;

      if (nextCursor) {
        console.log(`  [${rType}] Fetched ${resources.length} so far, paginating...`);
      }
    } while (nextCursor);
  }

  return resources;
}

// ── RENAME ────────────────────────────────────────────────────────────────────
/**
 * Renames a Cloudinary asset using the Upload API rename endpoint.
 * resource_type: 'image' | 'video' | 'raw'
 */
async function renameAsset(fromPublicId, toPublicId, resourceType) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const params = {
    from_public_id: fromPublicId,
    timestamp,
    to_public_id:   toPublicId,
  };
  const signature = sign(params);

  const body = new URLSearchParams({
    ...params,
    api_key:   API_KEY,
    signature,
  }).toString();

  const opts = {
    hostname: 'api.cloudinary.com',
    path:     `/v1_1/${CLOUD_NAME}/${resourceType}/rename`,
    method:   'POST',
    headers:  {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const { status, body: resBody } = await request(opts, body);
  if (status !== 200) {
    throw new Error(`${status} ${JSON.stringify(resBody)}`);
  }
  return resBody;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Cloudinary rename — cloud: ${CLOUD_NAME}`);
  console.log(`Listing all assets under "${SEARCH_PREFIX}"...\n`);

  let resources;
  try {
    resources = await listAllResources();
  } catch (err) {
    console.error('Failed to list resources:', err.message);
    process.exit(1);
  }

  console.log(`Found ${resources.length} assets total.\n`);

  let renamed = 0;
  let skipped = 0;
  let errors  = 0;

  for (const res of resources) {
    const publicId     = res.public_id;
    const resourceType = res.resource_type || 'image';

    // Split folder path from filename
    const lastSlash = publicId.lastIndexOf('/');
    const folder    = lastSlash >= 0 ? publicId.slice(0, lastSlash + 1) : '';
    const filename  = lastSlash >= 0 ? publicId.slice(lastSlash + 1) : publicId;

    const match = filename.match(SUFFIX_RE);
    if (!match) {
      skipped++;
      continue;
    }

    const newPublicId = folder + match[1];

    try {
      await renameAsset(publicId, newPublicId, resourceType);
      console.log(`  ✓ ${publicId}`);
      console.log(`    → ${newPublicId}`);
      renamed++;
    } catch (err) {
      console.error(`  ✗ ${publicId}: ${err.message}`);
      errors++;
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.log('\n─────────────────────────────');
  console.log(`Total assets scanned : ${resources.length}`);
  console.log(`Renamed              : ${renamed}`);
  console.log(`Skipped (no suffix)  : ${skipped}`);
  console.log(`Errors               : ${errors}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

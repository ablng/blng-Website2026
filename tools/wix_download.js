#!/usr/bin/env node
/**
 * wix_download.js
 * Downloads all media from the Wix Media Manager "Work" folder
 * and organises it into blng-image-staging/projects/ using fuzzy matching.
 * Unmatched folders land in blng-image-staging/review-manually/.
 *
 * Usage: node tools/wix_download.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

// ── CONFIG ────────────────────────────────────────────────────
const API_KEY  = 'IST.eyJraWQiOiJQb3pIX2FDMiIsImFsZyI6IlJTMjU2In0.eyJkYXRhIjoie1wiaWRcIjpcIjI1OWRjYjkzLTg5M2QtNDBkZi04MTM5LWYxOTM0YjkyZWUyY1wiLFwiaWRlbnRpdHlcIjp7XCJ0eXBlXCI6XCJhcHBsaWNhdGlvblwiLFwiaWRcIjpcImFhNjViNjk5LTZhNTgtNDBjMy1hYTk0LTEyNTYxOTAwMDQ5OFwifSxcInRlbmFudFwiOntcInR5cGVcIjpcImFjY291bnRcIixcImlkXCI6XCI3NTM2ZGEwNS1kMDUyLTRlYTctYjg5MC0yZDA4ZjkyZTE2MmRcIn19IiwiaWF0IjoxNzczMzI3NDY3fQ.fcOVT-NBii_K6NBSReY4uEMC7TNurkmSFqMDDkIFeDOZOIVIiWQb_r7N6G1D0RnkAQOcCoGjHloR-_4Vg-ZvGytVVEm1xXSB6cr7E__JCsOHLqFUlhvGU_BSFkDGzndzc85lu_8ULrERhesn5SR51IBMvtZaKQXs23lntyTjV1mZQVM_wfLPRrR_s7Mj-NeOvmJIbdlSCqHf765xNOUMb2Eo8JpTXXDVO37yXBxtklPlZ0kkdpCAn_diItMrh0PLGIkuYlFqGZtQ3Q-GjDjZD7dLTxDDeJLuRYhUe__2SOyHSTaloPmt4I-edYsSYHW37F4AeQu_gVbw1bLc7QXt_g';
const SITE_ID  = '46ea1557-e2eb-45ba-851b-40feb764ffde';
const STAGING  = 'C:\\Users\\AriadnaLópezBielingB\\BIELING ARCHITECTS\\BLNG Projects - Documents\\04 Marketing + Sales\\Website\\blng-image-staging';
const PROJECTS_DIR      = path.join(STAGING, 'projects');
const REVIEW_DIR        = path.join(STAGING, 'review-manually');
const FUZZY_THRESHOLD   = 0.55;   // 0–1, lower = more permissive
const RATE_LIMIT_MS     = 250;    // ms between API calls
const DOWNLOAD_CONCURRENCY = 3;   // parallel downloads per folder

const WIX_BASE = 'https://www.wixapis.com';
const HEADERS  = {
  'Authorization': API_KEY,
  'wix-site-id':   SITE_ID,
  'Content-Type':  'application/json',
};

// ── UTILS ─────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Normalise a name for fuzzy comparison: lowercase, strip non-alphanumeric */
function normalise(s) {
  return s.toLowerCase()
    .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôõöø]/g, 'o')
    .replace(/[ùúûü]/g, 'u').replace(/ß/g, 'ss').replace(/ç/g, 'c')
    .replace(/ñ/g, 'n').replace(/ž/g, 'z')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Dice coefficient (bigram similarity), range 0–1 */
function diceSimilarity(a, b) {
  const bigrams = s => {
    const set = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      set.set(bg, (set.get(bg) || 0) + 1);
    }
    return set;
  };
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) || 0);
  const total = (a.length - 1) + (b.length - 1);
  return total === 0 ? 0 : (2 * inter) / total;
}

/**
 * Check if the Wix folder name's project-number prefix is contained in
 * the local folder name. E.g. "01J" matches "01j-herz-mariae-church".
 * Note: normalise() converts hyphens → spaces, so always split on spaces.
 */
function prefixMatch(wixName, localName) {
  const wixNum  = normalise(wixName).split(' ')[0];
  const localNum = normalise(localName).split(' ')[0]; // first token after normalise
  return wixNum.length > 0 && wixNum === localNum;
}

/** Find the best matching local folder for a given Wix folder name */
function findBestMatch(wixName, localFolders) {
  const wixNorm = normalise(wixName);
  let best = null, bestScore = 0;

  for (const local of localFolders) {
    const localNorm = normalise(local);

    // Strong signal: project-number prefix matches exactly
    if (prefixMatch(wixName, local)) {
      const score = 0.7 + 0.3 * diceSimilarity(wixNorm, localNorm);
      if (score > bestScore) { bestScore = score; best = local; }
      continue;
    }

    const score = diceSimilarity(wixNorm, localNorm);
    if (score > bestScore) { bestScore = score; best = local; }
  }

  return bestScore >= FUZZY_THRESHOLD ? { folder: best, score: bestScore } : null;
}

// ── WIX API ───────────────────────────────────────────────────

async function wixRequest(endpoint, params = {}) {
  const url = new URL(WIX_BASE + endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  let attempts = 0;
  while (true) {
    attempts++;
    const res = await fetch(url.toString(), { headers: HEADERS });

    if (res.status === 429 || res.status === 503) {
      const wait = Math.min(2000 * attempts, 16000);
      console.warn(`  ⚠ Rate limited (${res.status}), retrying in ${wait}ms…`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Wix API ${res.status} on ${endpoint}: ${body}`);
    }
    await sleep(RATE_LIMIT_MS);
    return res.json();
  }
}

/** List all folders inside a parent (handles pagination).
 *  Pass null to list media-root children (omits parentFolderId param). */
async function listFolders(parentFolderId) {
  const all = [];
  let cursor = null;
  do {
    const params = { limit: 100 };
    if (parentFolderId) params.parentFolderId = parentFolderId;
    if (cursor) params['paging.cursor'] = cursor;
    const data = await wixRequest('/site-media/v1/folders', params);
    all.push(...(data.folders || []));
    cursor = data.nextCursor?.cursors?.next || null;
  } while (cursor);
  return all;
}

/** List all files inside a folder (handles pagination) */
async function listFiles(parentFolderId) {
  const all = [];
  let cursor = null;
  do {
    const params = { parentFolderId, limit: 100 };
    if (cursor) params['paging.cursor'] = cursor;
    const data = await wixRequest('/site-media/v1/files', params);
    all.push(...(data.files || []));
    cursor = data.nextCursor?.cursors?.next || null;
  } while (cursor);
  return all;
}

/** Recursively list all files inside a folder tree */
async function listFilesRecursive(folderId) {
  const files = await listFiles(folderId);
  const subFolders = await listFolders(folderId);
  for (const sub of subFolders) {
    const subFiles = await listFilesRecursive(sub.id);
    files.push(...subFiles);
  }
  return files;
}

// ── DOWNLOAD ──────────────────────────────────────────────────

/** Extract the best download URL from a Wix file object */
function getDownloadUrl(file) {
  // Wix files have url in different places depending on media type
  return file.url
    || file.media?.image?.url
    || file.media?.document?.url
    || file.media?.video?.url
    || null;
}

/** Move all files from srcDir into destDir, skip if already present */
function moveFilesFrom(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  let moved = 0;
  for (const f of fs.readdirSync(srcDir)) {
    const src  = path.join(srcDir, f);
    const dest = path.join(destDir, f);
    if (fs.statSync(src).isFile()) {
      if (!fs.existsSync(dest)) { fs.renameSync(src, dest); moved++; }
    }
  }
  // Remove empty source dir
  try { fs.rmdirSync(srcDir); } catch {}
  return moved;
}

/** Download a single file with retry, skip if already exists */
async function downloadFile(url, destPath, retries = 3) {
  if (fs.existsSync(destPath)) return 'skipped';

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath + '.tmp');
        const proto = url.startsWith('https') ? https : http;

        const req = proto.get(url, { headers: { 'User-Agent': 'blng-downloader/1.0' } }, res => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            file.close();
            fs.unlinkSync(destPath + '.tmp');
            downloadFile(res.headers.location, destPath, retries - attempt + 1)
              .then(resolve).catch(reject);
            return;
          }
          if (res.statusCode !== 200) {
            file.close();
            fs.unlinkSync(destPath + '.tmp');
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          res.pipe(file);
          file.on('finish', () => { file.close(); fs.renameSync(destPath + '.tmp', destPath); resolve('ok'); });
        });
        req.on('error', err => {
          file.close();
          if (fs.existsSync(destPath + '.tmp')) fs.unlinkSync(destPath + '.tmp');
          reject(err);
        });
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return 'ok';
    } catch (err) {
      if (attempt === retries) return `error: ${err.message}`;
      await sleep(1000 * attempt);
    }
  }
}

/** Download an array of files into destDir with limited concurrency */
async function downloadFiles(files, destDir, stats) {
  fs.mkdirSync(destDir, { recursive: true });

  // Only image/video files (skip internal Wix system files)
  const media = files.filter(f => {
    const mt = (f.mimeType || f.media?.image ? 'image' : '').toLowerCase();
    return f.url || f.media?.image?.url;
  });

  for (let i = 0; i < media.length; i += DOWNLOAD_CONCURRENCY) {
    const batch = media.slice(i, i + DOWNLOAD_CONCURRENCY);
    await Promise.all(batch.map(async file => {
      const url = getDownloadUrl(file);
      if (!url) { stats.errors++; return; }

      // Build filename from displayName or extract from URL
      let name = file.displayName || file.title || path.basename(new URL(url).pathname);
      if (!path.extname(name)) {
        const urlExt = path.extname(new URL(url).pathname);
        name += urlExt || '.jpg';
      }
      // Sanitise filename
      name = name.replace(/[<>:"/\\|?*]/g, '_');
      const destPath = path.join(destDir, name);

      const result = await downloadFile(url, destPath);
      if (result === 'ok')       stats.downloaded++;
      else if (result === 'skipped') stats.skipped++;
      else { stats.errors++;  console.error(`    ✗ ${name}: ${result}`); }
    }));
  }
}

// ── MAIN ──────────────────────────────────────────────────────

async function main() {
  console.log('━━━ Wix Media Manager → blng-image-staging ━━━\n');

  // Load local project folders
  const localFolders = fs.readdirSync(PROJECTS_DIR)
    .filter(f => fs.statSync(path.join(PROJECTS_DIR, f)).isDirectory());
  console.log(`Local project folders found: ${localFolders.length}`);

  fs.mkdirSync(REVIEW_DIR, { recursive: true });

  // ── Find root folders ───────────────────────────────────────
  console.log('\nFetching Wix root folders…');
  const rootFolders = await listFolders(null); // null = media-root
  console.log(`Root folders: ${rootFolders.map(f => f.displayName).join(', ')}`);

  // ── Find "Work" folder ──────────────────────────────────────
  const workFolder = rootFolders.find(f =>
    f.displayName?.toLowerCase().includes('work') ||
    f.name?.toLowerCase().includes('work')
  );

  let wixProjectFolders;
  if (workFolder) {
    console.log(`\nFound Work folder: "${workFolder.displayName}" (${workFolder.id})`);
    wixProjectFolders = await listFolders(workFolder.id);
  } else {
    console.warn('\nNo "Work" folder found — using all root-level folders.');
    wixProjectFolders = rootFolders;
  }
  console.log(`Wix project folders to process: ${wixProjectFolders.length}\n`);

  // ── Match and download ──────────────────────────────────────
  const summary = { matched: [], reviewManually: [], totalDownloaded: 0, totalErrors: 0 };

  for (const wixFolder of wixProjectFolders) {
    const wixName = wixFolder.displayName || wixFolder.name || wixFolder.id;
    process.stdout.write(`Processing: "${wixName}" … `);

    // List all files in this Wix folder (including sub-subfolders)
    let files;
    try {
      files = await listFilesRecursive(wixFolder.id);
    } catch (e) {
      console.error(`\n  ✗ Failed to list files: ${e.message}`);
      summary.totalErrors++;
      continue;
    }

    const stats = { downloaded: 0, skipped: 0, errors: 0 };
    const match = findBestMatch(wixName, localFolders);

    if (match) {
      const destDir    = path.join(PROJECTS_DIR, match.folder);
      const reviewSrc  = path.join(REVIEW_DIR, wixName);
      const moved      = moveFilesFrom(reviewSrc, destDir);
      if (moved > 0) stats.downloaded += moved;
      console.log(`→ "${match.folder}" (score ${match.score.toFixed(2)})${moved ? ` [moved ${moved} from review-manually]` : ''}`);
      await downloadFiles(files, destDir, stats);
      summary.matched.push({
        wix: wixName, local: match.folder, score: match.score,
        downloaded: stats.downloaded, skipped: stats.skipped, errors: stats.errors,
      });
    } else {
      // Sanitise Wix folder name for use as a directory name
      const safeName = wixName.replace(/[<>:"/\\|?*]/g, '_');
      const destDir  = path.join(REVIEW_DIR, safeName);
      console.log(`→ review-manually/ (no confident match)`);
      await downloadFiles(files, destDir, stats);
      summary.reviewManually.push({
        wix: wixName, downloaded: stats.downloaded, skipped: stats.skipped, errors: stats.errors,
      });
    }

    summary.totalDownloaded += stats.downloaded;
    summary.totalErrors     += stats.errors;
  }

  // ── Summary ─────────────────────────────────────────────────
  console.log('\n' + '━'.repeat(60));
  console.log('SUMMARY');
  console.log('━'.repeat(60));

  console.log(`\n✔ MATCHED (${summary.matched.length} folders):`);
  for (const m of summary.matched) {
    console.log(`  "${m.wix}"  →  "${m.local}"`);
    console.log(`     score ${m.score.toFixed(2)} | ↓${m.downloaded} downloaded | ⊘${m.skipped} skipped | ✗${m.errors} errors`);
  }

  if (summary.reviewManually.length > 0) {
    console.log(`\n⚠ REVIEW MANUALLY (${summary.reviewManually.length} folders → blng-image-staging/review-manually/):`);
    for (const m of summary.reviewManually) {
      console.log(`  "${m.wix}"  |  ↓${m.downloaded} downloaded`);
    }
  } else {
    console.log('\n✔ All folders matched — nothing in review-manually/');
  }

  console.log(`\nTOTAL: ${summary.totalDownloaded} files downloaded, ${summary.totalErrors} errors`);
  console.log('━'.repeat(60));
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});

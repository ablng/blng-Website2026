#!/usr/bin/env node
/**
 * generate_projects_json.js
 * Parses projects.csv and writes projects.json with Cloudinary folder paths.
 *
 * Usage: node tools/generate_projects_json.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const CSV_PATH  = path.join(__dirname, '..', 'projects.csv');
const JSON_PATH = path.join(__dirname, '..', 'projects.json');

// ── SLUG GENERATOR ────────────────────────────────────────────────────────────
// Matches the naming convention used in Cloudinary (from Wix export).
// e.g. "WIKUS Headquarters & Conference Centre" → "wikus-headquarters-conference-centre"
// e.g. "Fürstenriedstraße Commercial"           → "furstenriedstra-e-commercial"
function toSlug(title) {
  return title
    .replace(/ü/g, 'u').replace(/Ü/g, 'u')
    .replace(/ö/g, 'o').replace(/Ö/g, 'o')
    .replace(/ä/g, 'a').replace(/Ä/g, 'a')
    .replace(/ç/g, 'c').replace(/Ç/g, 'c')
    .replace(/ß/g, '-')             // ß → hyphen (Wix naming convention)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // any non-alnum run → single hyphen
    .replace(/^-|-$/g, '');         // trim edge hyphens
}

// Manual folder overrides for cases where the Cloudinary name differs from the title slug.
const FOLDER_OVERRIDES = {
  'europacity-neighbourhood': 'work-europacity-blocks',
};

// Manual slug overrides, keyed by title, for projects whose live slug/Cloudinary
// folder is more specific than toSlug(title) alone would produce (usually a
// location suffix disambiguating a short title). Without this, regenerating
// would silently rename the project and orphan its already-uploaded images.
const SLUG_OVERRIDES = {
  'Bell Tower': 'bell-tower-grossauheim',
  'Church Administration Building': 'church-administration-building-kassel',
  'Leopoldstraße Residential': 'leopoldstrasse-residential',
  'Psychiatric Clinic': 'psychiatric-clinic-haina',
  'Überseekontor': 'uberseekontor-bremen',
  'Upper Königstraße Commercial': 'upper-konigstrasse-commercial',
  'Vicariate General Offices': 'vicariate-general-offices-paderborn',
};

// ── CSV PARSER ─────────────────────────────────────────────────────────────────
// Handles quoted fields (including multi-line quoted values).
function parseCSV(text) {
  const records = [];
  let field = '';
  let fields = [];
  let inQuote = false;

  const push = () => { fields.push(field.trim()); field = ''; };
  const commit = () => { if (fields.length > 0) { records.push(fields); fields = []; } };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      if (inQuote && next === '"') { field += '"'; i++; }  // escaped quote
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      push();
    } else if (ch === '\n' && !inQuote) {
      push(); commit();
    } else if (ch === '\r') {
      // skip
    } else {
      field += ch;
    }
  }
  push(); commit();
  return records;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

// Preserve existing featured/selected/hasPage values so running the generator
// doesn't reset them — these are set by hand and have no CSV column.
const existingFeatured = {};
const existingSelected = {};
const existingHasPage = {};
if (fs.existsSync(JSON_PATH)) {
  try {
    JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'))
      .forEach(p => {
        existingFeatured[p.slug] = p.featured;
        if (p.selected) existingSelected[p.slug] = true;
        if (p.hasPage === false) existingHasPage[p.slug] = false;
      });
  } catch {}
}

const csv  = fs.readFileSync(CSV_PATH, 'utf8');
const rows = parseCSV(csv);

if (rows.length === 0) { console.error('CSV is empty'); process.exit(1); }

const headers = rows[0];
const col = {};
headers.forEach((h, i) => { col[h.trim()] = i; });

const REQUIRED = ['Title', 'Year', 'Project Number', 'Type', 'Programme',
                  'Description', 'Client', 'Location', 'Status', 'Area',
                  'Scope', 'Collaborators'];
REQUIRED.forEach(h => {
  if (col[h] === undefined) { console.error(`Missing column: ${h}`); process.exit(1); }
});

const projects = [];

for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  const title = (row[col['Title']] || '').trim();
  if (!title) continue;

  const types = (row[col['Type']] || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  const slug = SLUG_OVERRIDES[title] || toSlug(title);

  const entry = {
    title,
    year:          (row[col['Year']]           || '').trim(),
    projectNumber: (row[col['Project Number']] || '').trim(),
    type:          types,
    programme:     (row[col['Programme']]      || '').trim(),
    description:   (row[col['Description']]    || '').trim(),
    client:        (row[col['Client']]         || '').trim(),
    location:      (row[col['Location']]       || '').trim(),
    status:        (row[col['Status']]         || '').trim(),
    area:          (row[col['Area']]           || '').trim(),
    scope:         (row[col['Scope']]          || '').trim(),
    collaborators: (row[col['Collaborators']]  || '').trim(),
    slug,
    folder:   FOLDER_OVERRIDES[slug] || `work-${slug}`,
    featured: existingFeatured[slug] ?? false,
  };
  if (existingSelected[slug]) entry.selected = true;
  if (existingHasPage[slug] === false) entry.hasPage = false;
  projects.push(entry);
}

// Sort: most recent first, then by project number as tiebreak
projects.sort((a, b) => {
  const yDiff = parseInt(b.year || '0') - parseInt(a.year || '0');
  if (yDiff !== 0) return yDiff;
  return (a.projectNumber || '').localeCompare(b.projectNumber || '');
});

const output = JSON.stringify(projects, null, 2);
fs.writeFileSync(JSON_PATH, output);

console.log(`\nWritten ${projects.length} projects to projects.json\n`);
console.log('Slug → Cloudinary folder mapping:');
projects.forEach(p => console.log(`  ${p.year}  ${p.title.padEnd(55)} → ${p.folder}`));

// Report all unique types
const allTypes = new Set();
projects.forEach(p => p.type.forEach(t => allTypes.add(t)));
console.log(`\nUnique types (${allTypes.size}): ${[...allTypes].sort().join(', ')}`);

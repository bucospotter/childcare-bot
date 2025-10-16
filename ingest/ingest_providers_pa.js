// ingest/ingest_providers_pa.js
import 'dotenv/config';
import pg from 'pg';
// If you're on Node < 18, keep node-fetch:
// import fetch from 'node-fetch';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { require: true, rejectUnauthorized: false }
});

// small helpers
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
}
function normalizeZip(z) {
  const s = (z ?? '').toString().replace(/[^0-9]/g, '');
  return s ? s.slice(0, 5) : null;
}

export async function ingestPAProviders() {
  const url = process.env.PA_PROVIDERS_URL;
  if (!url) throw new Error('PA_PROVIDERS_URL not set');

  console.log('⏳ Fetching provider data from', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch providers: ${res.status} ${res.statusText}`);
  const data = await res.json();

  if (!Array.isArray(data)) {
    throw new Error('Unexpected response (not an array)');
  }
  console.log(`📦 Fetched ${data.length} rows`);
  if (data.length) {
    console.log('🧩 Keys in first row:', Object.keys(data[0]).join(', '));
  }

  let read = 0;
  let inserted = 0;
  let skipped = 0;
  let conflicts = 0;

  for (const r of data) {
    read++;

    // Map to your columns based on the sample payload
    const name = pick(r, ['facility_name', 'provider_name', 'legal_entity_name']);
    const address = pick(r, ['facility_address', 'address', 'street_address', 'legal_entity_address']);
    const city = (pick(r, ['facility_city', 'city', 'legal_entity_city']) || '').toString().toUpperCase();
    const zip = normalizeZip(pick(r, ['facility_zip_code', 'zip', 'zip_code', 'legal_entity_zip_code']));
    const license_type = pick(r, ['provider_type', 'facility_type', 'license_type']);
    // There is no explicit "status" in the sample; set null or derive later if you find a status field
    const license_status = pick(r, ['license_status', 'status']) || null;
    const qris_rating = pick(r, ['star_level', 'keystone_stars', 'qris_rating']);
    // No provider_webpage in the sample. Leave null unless you have a URL field
    const source_url = pick(r, ['provider_webpage', 'website']) || null;

    if (!name || !address) {
      skipped++;
      continue;
    }

    const result = await pool.query(
        `INSERT INTO providers
         (state, name, address, city, zip,
          license_type, license_status, qris_rating, source_url, last_seen)
       VALUES ('PA', $1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT DO NOTHING`,
        [name, address, city, zip, license_type, license_status, qris_rating, source_url]
    );

    if (result.rowCount === 1) inserted++;
    else conflicts++; // row existed under your unique constraint (if any)
  }

  console.log(`✅ Done. Read: ${read}, Inserted: ${inserted}, Skipped (missing name/address): ${skipped}, Conflicts: ${conflicts}`);
}

// --- main() runner ---
async function main() {
  try {
    await ingestPAProviders();
  } catch (e) {
    console.error('❌ Ingest failed:', e);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });

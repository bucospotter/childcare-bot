// ingest/ingest_providers_wv.js
import pg from "pg";
import fs from "fs/promises";
import fetch from "node-fetch";
import { csvToJson } from "./utils/csv_to_json.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,   ssl: {
    require: true,
    rejectUnauthorized: false // use true if you provide a CA cert
  } });

async function getData() {
  const src = process.env.WV_PROVIDERS_SRC || "";
  if (!src) throw new Error("Set WV_PROVIDERS_SRC to a local CSV/JSON path or an HTTP URL.");
  if (src.startsWith("http")) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    const text = await res.text();
    if (text.includes(",") && text.split("\n")[0].includes(",")) {
      return csvToJson(text);
    } else {
      return JSON.parse(text);
    }
  } else {
    const text = await fs.readFile(src, "utf8");
    if (src.endsWith(".csv")) return csvToJson(text);
    return JSON.parse(text);
  }
}

function mapRecord(r) {
  return {
    name: r.name || r.ProviderName || r["Program Name"] || "",
    address: r.address || r.Address || r["Street Address"] || "",
    city: r.city || r.City || "",
    zip: (r.zip || r.ZIP || r.Zip || "").toString().padStart(5,"0"),
    license_type: r.license_type || r.Type || r["License Type"] || null,
    license_status: r.license_status || r.Status || r["License Status"] || null,
    qris_rating: r.qris_rating || r.QRIS || r["QRIS Level"] || null,
    source_url: r.source_url || r.DetailURL || r["Detail URL"] || null
  };
}

async function main() {
  const data = await getData();
  let inserted = 0;
  for (const raw of data) {
    const r = mapRecord(raw);
    if (!r.name || !r.address) continue;
    await pool.query(
      `INSERT INTO providers(state,name,address,city,zip,license_type,license_status,qris_rating,source_url,last_seen)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
      ["WV", r.name, r.address, r.city, r.zip, r.license_type, r.license_status, r.qris_rating, r.source_url]
    );
    inserted++;
  }
  console.log(`✅ Inserted ${inserted} WV providers`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });

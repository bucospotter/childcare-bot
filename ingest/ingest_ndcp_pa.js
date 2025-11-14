// ingest/ingest_ndcp_pa.js
import fs from "fs/promises";
import path from "path";
import pg from "pg";
import "dotenv/config";
import ExcelJS from "exceljs";

// ---------- config ----------
const NDCP_LOCAL_XLSX =
    process.env.NDCP_LOCAL_XLSX || "./ingest/data/NDCP2022.xlsx";
const NDCP_SHEET_NAME = "County_LevelNDCP_v8_update2008_"; // sheet name in your file
const OUTPUT_YEAR = 2022; // price columns (MCINFANT, _75CINFANT, etc.) are 2022 weekly values

// CLI: --state=PA (defaults to PA)
const argState = (() => {
    const m = process.argv.find((s) => s.startsWith("--state="));
    const val = m ? m.split("=")[1] : "PA";
    return (val || "PA").toUpperCase();
})();

// ---------- db ----------
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { require: true, rejectUnauthorized: false },
});

// ---------- helpers ----------
const wk2mo = (n) =>
    n == null || Number.isNaN(Number(n)) ? null : Number(n) * 4.333;

const toSettingEnum = (s) => {
    const v = (s || "").toString().trim().toLowerCase();
    if (v.includes("center")) return "center";
    if (v.includes("home") || v.includes("family")) return "family";
    throw new Error(`Unknown setting: "${s}"`);
};

const toAgeEnum = (s) => {
    const v = (s || "").toString().trim().toLowerCase();
    if (v.includes("infant")) return "infant";
    if (v.includes("toddler")) return "toddler";
    if (v.includes("preschool") || v.includes("pre-school") || v.includes("pre school"))
        return "preschool";
    if (v.includes("school")) return "school-age";
    if (v.includes("mixed") || v.includes("all ages") || /\ball\b.*\bages\b/.test(v))
        return "mixed";
    throw new Error(`Unknown age group: "${s}"`);
};

const toNum = (x) => (x == null || x === "" ? null : Number(x));

// --- de-dupe + batching helpers ---
function dedupeAndMerge(rows) {
    const byKey = new Map();
    for (const r of rows) {
        const key = `${r.county_fips}|${r.setting_raw}|${r.age_group_raw}`;
        const cur = byKey.get(key);
        if (!cur) {
            byKey.set(key, { ...r });
        } else {
            // fill first non-null values encountered
            if (cur.median_wk == null && r.median_wk != null) cur.median_wk = r.median_wk;
            if (cur.p75_wk == null && r.p75_wk != null) cur.p75_wk = r.p75_wk;
        }
    }
    return Array.from(byKey.values());
}

function chunk(arr, size = 500) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

// ---------- streaming parse with exceljs ----------
async function parseNdcpFromExcelStreaming(filePath, state2 = "PA") {
    const abs = path.resolve(filePath);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) throw new Error(`File not found: ${abs}`);
    console.log(
        `Resolved path: ${abs} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`
    );

    const out = [];
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(abs, {
        entries: "emit",
        sharedStrings: "cache", // avoid building one giant string
        worksheets: "emit",     // stream worksheets
        hyperlinks: "ignore",
        styles: "subset",
    });

    for await (const worksheet of reader) {
        // Skip non-target worksheets if a specific name is configured
        if (NDCP_SHEET_NAME && worksheet.name !== NDCP_SHEET_NAME) {
            continue;
        }
        console.log("Streaming sheet:", worksheet.name);

        let header = [];
        let headerFound = false;
        const REQUIRED = [
            "STATE_ABBREVIATION",
            "COUNTY_FIPS_CODE",
            "STUDYYEAR",
            "COUNTY_NAME",
        ];

        const norm = (v) => (v == null ? "" : String(v).trim());
        const toUpperArray = (arr) => arr.map((c) => norm(c).toUpperCase());
        const idxOf = (name) => header.indexOf(name.toUpperCase());

        for await (const row of worksheet) {
            // Build a plain array of cell texts (preserve blanks)
            const cells = [];
            row.eachCell({ includeEmpty: true }, (cell, col) => {
                let v = cell?.value;
                if (v && typeof v === "object") {
                    // exceljs cell values can be {text, richText, formula, result, ...}
                    if (v.text != null) v = v.text;
                    else if (Array.isArray(v.richText))
                        v = v.richText.map((rt) => rt.text).join("");
                    else if (v.result != null) v = v.result;
                    else v = "";
                }
                cells[col - 1] = norm(v);
            });

            // Seek header row (first row that contains all REQUIRED headers)
            if (!headerFound) {
                const upper = toUpperArray(cells);
                const ok = REQUIRED.every((k) => upper.includes(k));
                if (!ok) continue;

                header = upper; // lock header (uppercased keys)
                headerFound = true;
                console.log(
                    "Detected header (first 20 cols):",
                    header.slice(0, 20)
                );
                continue;
            }

            // Skip completely empty rows
            if (cells.every((v) => v === "")) continue;

            const get = (name) => {
                const i = idxOf(name);
                return i >= 0 ? cells[i] : "";
            };

            // filter by state only; year in this workbook is 2008, but price cols are 2022
            const stateAbbr = norm(get("STATE_ABBREVIATION")).toUpperCase();
            if (stateAbbr !== state2) continue;

            const county_fips_raw = norm(get("COUNTY_FIPS_CODE"));
            if (!county_fips_raw) continue;

            const county_fips = county_fips_raw.padStart(5, "0");
            const state_fips = (norm(get("STATE_FIPS")) || "").padStart(2, "0") || null;
            const county = norm(get("COUNTY_NAME")) || null;

            // read price columns (weekly)
            const push = (setting, age, median, p75) => {
                const m = toNum(median);
                const p = toNum(p75);
                if (m == null && p == null) return;
                out.push({
                    year: OUTPUT_YEAR,
                    state_fips,
                    state: stateAbbr,
                    county_fips,
                    county,
                    age_group_raw: age,    // 'infant' | 'toddler' | 'preschool'
                    setting_raw: setting,  // 'center' | 'family'
                    p10_wk: null,
                    p25_wk: null,
                    median_wk: m,
                    p75_wk: p,
                    p90_wk: null,
                });
            };

            // center-based
            push("center", "infant",   get("MCINFANT"),    get("_75CINFANT"));
            push("center", "toddler",  get("MCTODDLER"),   get("_75CTODDLER"));
            push("center", "preschool",get("MCPRESCHOOL"), get("_75CPRESCHOOL"));
            // family/home-based
            push("family", "infant",   get("MFCCINFANT"),    get("_75FCCINFANT"));
            push("family", "toddler",  get("MFCCTODDLER"),   get("_75FCCTODDLER"));
            push("family", "preschool",get("MFCCPRESCHOOL"), get("_75FCCPRESCHOOL"));
        }

        // If we had a preferred sheet and just finished it, we can break
        if (NDCP_SHEET_NAME && worksheet.name === NDCP_SHEET_NAME) break;
    }

    if (!out.length) {
        console.warn(
            `Parsed 0 rows for ${state2} from ${path.basename(filePath)}. ` +
            `Confirm the sheet name and that the file actually contains ${OUTPUT_YEAR} price columns for ${state2}.`
        );
    } else {
        console.log(`Parsed ${out.length} rows for ${state2}.`);
    }
    return out;
}

// ---------- upsert (batched) ----------
async function upsertIntoPricesNdcp(rows, sourceUrl) {
    const db = await pool.connect();
    try {
        await db.query("BEGIN");

        // 1) Seed counties in batches (deduped)
        const countyMap = new Map();
        for (const r of rows) {
            if (!countyMap.has(r.county_fips)) {
                countyMap.set(r.county_fips, {
                    state_fips: r.state_fips,
                    state: r.state,
                    county_fips: r.county_fips,
                    county: r.county,
                });
            }
        }
        const counties = Array.from(countyMap.values());
        for (const batch of chunk(counties, 500)) {
            const vals = [];
            const params = [];
            batch.forEach((c, i) => {
                const p = i * 4;
                params.push(`($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4})`);
                vals.push(c.state_fips, c.county_fips, c.state, c.county);
            });
            await db.query(
                `
        INSERT INTO counties (state_fips, county_fips, state, county)
        VALUES ${params.join(",")}
        ON CONFLICT (county_fips) DO NOTHING
        `,
                vals
            );
        }

        // 2) Upsert prices in batches
        for (const batch of chunk(rows, 300)) {
            const vals = [];
            const tuples = [];
            let j = 0;
            for (const r of batch) {
                const ageEnum = toAgeEnum(r.age_group_raw);
                const settingEnum = toSettingEnum(r.setting_raw);
                const p = j * 13;
                tuples.push(
                    `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6}::age_group,$${p + 7}::care_setting,$${p + 8},$${p + 9},$${p + 10},$${p + 11},$${p + 12},$${p + 13})`
                );
                vals.push(
                    r.county_fips,
                    r.state_fips,
                    r.state,
                    r.county,
                    r.year,
                    ageEnum,
                    settingEnum,
                    wk2mo(r.p10_wk),
                    wk2mo(r.p25_wk),
                    wk2mo(r.median_wk),
                    wk2mo(r.p75_wk),
                    wk2mo(r.p90_wk),
                    `${sourceUrl} (weekly→monthly ×4.333)`
                );
                j++;
            }

            await db.query(
                `
        INSERT INTO prices_ndcp
          (county_fips, state_fips, state, county, year, age_group, setting,
           p10, p25, median, p75, p90, source)
        VALUES
          ${tuples.join(",")}
        ON CONFLICT (county_fips, year, age_group, setting)
        DO UPDATE SET
          state_fips = EXCLUDED.state_fips,
          state      = EXCLUDED.state,
          county     = EXCLUDED.county,
          p10        = EXCLUDED.p10,
          p25        = EXCLUDED.p25,
          median     = EXCLUDED.median,
          p75        = EXCLUDED.p75,
          p90        = EXCLUDED.p90,
          source     = EXCLUDED.source
        `,
                vals
            );
        }

        await db.query("COMMIT"); // <-- was COMPLETE
        console.log(`✅ Upserted ${rows.length} ${argState} rows into prices_ndcp`);
    } catch (e) {
        try { await db.query("ROLLBACK"); } catch {}
        throw e;
    } finally {
        db.release();
    }
}

// ---------- main ----------
async function main() {
    console.log(`Ingesting NDCP (streaming) for ${argState}, year ${OUTPUT_YEAR}…`);
    console.log(`Reading: ${NDCP_LOCAL_XLSX}`);

    const parsed = await parseNdcpFromExcelStreaming(NDCP_LOCAL_XLSX, argState);

    if (!parsed.length) {
        console.warn(
            `No rows produced for ${argState}. If this file only has 2008 in STUDYYEAR but 2022 price columns, ` +
            `that’s expected — we now hard-code year=${OUTPUT_YEAR} from the price columns. ` +
            `Double-check the sheet name (${NDCP_SHEET_NAME}) and state filter.`
        );
    } else {
        const rows = dedupeAndMerge(parsed);
        console.log(`Collapsed ${parsed.length} → ${rows.length} unique price rows.`);
        console.log("Sample mapped rows:", rows.slice(0, 3));
        await upsertIntoPricesNdcp(rows, `file://${path.resolve(NDCP_LOCAL_XLSX)}`);
    }

    await pool.end();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

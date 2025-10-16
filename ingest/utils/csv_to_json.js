// ingest/utils/csv_to_json.js
// Minimal CSV→JSON converter (no deps). Handles commas, quotes, and newlines in quotes.
import fs from "fs";

export function csvToJson(csvText) {
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  function pushField() { row.push(field); field = ""; }
  function pushRow() { rows.push(row); row = []; }

  while (i < csvText.length) {
    const c = csvText[i];
    if (inQuotes) {
      if (c === '"') {
        if (csvText[i+1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { pushField(); }
      else if (c === '\n') { pushField(); pushRow(); }
      else if (c === '\r') { /* skip */ }
      else { field += c; }
    }
    i++;
  }
  if (field.length || row.length) { pushField(); pushRow(); }

  if (rows.length === 0) return [];
  const headers = rows.shift().map(h => h.trim());
  return rows.filter(r => r.length && r.some(x => x && x.trim().length)).map(cols => {
    const obj = {};
    for (let j=0;j<headers.length;j++) obj[headers[j]] = cols[j] ?? "";
    return obj;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [,, inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error("Usage: node ingest/utils/csv_to_json.js input.csv output.json");
    process.exit(2);
  }
  const csv = fs.readFileSync(inPath, "utf8");
  const json = csvToJson(csv);
  fs.writeFileSync(outPath, JSON.stringify(json, null, 2));
  console.log(`Wrote ${json.length} records to ${outPath}`);
}

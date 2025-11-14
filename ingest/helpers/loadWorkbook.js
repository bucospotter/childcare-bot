import fs from "fs/promises";
import * as xlsx from "xlsx";

// --- robust workbook loader ---
async function loadWorkbook(localPath) {
    const buf = await fs.readFile(localPath);

    // Try standard buffer mode
    try {
        const wb = xlsx.read(buf, { type: "buffer", dense: true });
        if (wb && wb.SheetNames?.length) return wb;
    } catch (_) {}

    // Try array mode (Uint8Array)
    try {
        const wb = xlsx.read(new Uint8Array(buf), { type: "array", dense: true });
        if (wb && wb.SheetNames?.length) return wb;
    } catch (_) {}

    // Try path-based loader (some builds behave better here)
    try {
        const wb = xlsx.readFile(localPath, { dense: true });
        if (wb && wb.SheetNames?.length) return wb;
    } catch (_) {}

    throw new Error("Could not load workbook with xlsx in any mode.");
}

// --- get a concrete Sheet object, even if the name is known ---
function getFirstSheet(wb, preferredName) {
    const names = wb.SheetNames || [];
    if (!names.length) throw new Error("Workbook has no SheetNames.");

    // Prefer exact match
    const target = preferredName && names.find(n => n === preferredName);
    const sheetName = target || names[0];

    const sheet = wb.Sheets?.[sheetName];
    if (sheet) return { sheet, sheetName };

    // Some rare builds keep sheet mapping lazy; force rebuild via write+read trick:
    // Convert to json via XLSX range reading of A1:ZZZ999999 (wide range); if still empty, we fall back.
    // But first, try re-reading with bookSheets=false (default) to materialize:
    const wb2 = xlsx.read(xlsx.write(wb, { type: "buffer", bookType: "xlsx" }), { type: "buffer", dense: true });
    const sheet2 = wb2.Sheets?.[sheetName];
    if (sheet2) return { sheet: sheet2, sheetName };

    throw new Error(`No sheets found in workbook (SheetNames present: ${names.join(", ")})`);
}

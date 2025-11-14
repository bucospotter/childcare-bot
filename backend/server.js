// backend/server.js
import express from "express";
import OpenAI from "openai";
import cors from "cors";
import pg from "pg";

import { detectIntent, getPrompt } from "./intentRouter.js";
import { validateIntentOutput } from "./validator.js";
import { ragSearchDocuments, searchProviders } from "./retriever.js";

// --------------------------- config & setup ---------------------------------

// Fallback questions for Pennsylvania eligibility
const DEFAULT_PA_ELIGIBILITY_QUESTIONS = [
    "Child’s age (in years and months)",
    "Household size (including the child)",
    "Approximate monthly gross household income",
    "County or ZIP code of residence",
    "Parent/guardian work or school/training status (hours/week)",
    "Does the child have a disability, IEP/IFSP, or special needs?",
    "Current subsidy or waiting list enrollment?",
    "Preferred schedule (full-time/part-time; hours needed)"
];

const app = express();
app.use(express.json());

app.use(
    cors({
        origin: [
            "http://localhost:5173", // Vite
            "http://localhost:3001"  // Next.js
        ],
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
    })
);

// Shared DB pool
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { require: true, rejectUnauthorized: false },
});

// ----------------------------- helpers --------------------------------------

function ensurePaEligibilityScaffolding(intent, state, data) {
    if (intent === "CHECK_ELIGIBILITY" && state === "PA") {
        if (!data.clarifying_questions || !Array.isArray(data.clarifying_questions) || data.clarifying_questions.length === 0) {
            data.clarifying_questions = DEFAULT_PA_ELIGIBILITY_QUESTIONS;
        }
        if (!data.summary) {
            data.summary = "To assess eligibility for Pennsylvania Child Care Works (CCW), please answer the questions below.";
        }
        if (!data.estimated_fit) {
            data.estimated_fit = "uncertain";
        }
        if (!data.answer) {
            data.answer = "To check eligibility, I need a few details:";
        }
    }
    return data;
}

// Normalize some text into age_group/setting enums the DB uses
function normalizeAgeGroup(s) {
    const v = (s || "").toLowerCase();
    if (/infant/.test(v)) return "infant";
    if (/toddler/.test(v)) return "toddler";
    if (/pre[-\s]?school/.test(v)) return "preschool";
    if (/school[-\s]?age/.test(v)) return "school-age"; // not used in NDCP table, but safe
    return null;
}
function normalizeSetting(s) {
    const v = (s || "").toLowerCase();
    if (v.includes("center")) return "center";
    if (v.includes("home") || v.includes("family") || v.includes("fcc")) return "family";
    return null;
}

// COST query: resolve a county then fetch prices
async function resolveCountyFips(db, { state, countyFips, countyName }) {
    if (countyFips) {
        const q = `SELECT county_fips, state_fips, state, county FROM counties WHERE county_fips = $1`;
        const r = await db.query(q, [countyFips]);
        if (r.rowCount) return r.rows[0];
    }
    if (countyName) {
        const q = `
      SELECT county_fips, state_fips, state, county
      FROM counties
      WHERE state = $1 AND LOWER(county) = LOWER($2)
      LIMIT 1
    `;
        const r = await db.query(q, [state, countyName]);
        if (r.rowCount) return r.rows[0];
    }
    return null;
}

function wk2mo(n) {
    if (n == null || Number.isNaN(Number(n))) return null;
    return Math.round(Number(n) * 4.333 * 100) / 100;
}

// Build COST JSON response
function buildCostResponse({ state, countyRow, rows, queries }) {
    const answers = rows.map((r) => {
        const weekly = {
            median: r.median ?? null,
            p75: r.p75 ?? null,
        };
        const monthly = {
            median: r.median != null ? wk2mo(r.median) : null,
            p75: r.p75 != null ? wk2mo(r.p75) : null,
        };
        return {
            age_group: r.age_group,
            setting: r.setting,
            weekly,
            monthly,
        };
    });

    // collect distinct sources; fall back to “NDCP 2022” label
    const citations = Array.from(new Set(rows.map(r => r.source).filter(Boolean)));
    if (citations.length === 0) citations.push("NDCP 2022 (prices_ndcp)");

    return {
        state,
        county_fips: countyRow.county_fips,
        county: countyRow.county,
        queries,
        answers,
        notes: [
            "Weekly prices come from NDCP 2022.",
            "Monthly values derived using ×4.333.",
        ],
        citations,
    };
}

// ------------------------------- routes -------------------------------------

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/chat", async (req, res) => {
    try {
        // --- normalize incoming payloads from different UIs/clients ---
        const body = req.body || {};
        const message = body.message ?? body.query ?? body.input ?? "";
        const state = (body.state ?? "PA").toUpperCase();
        const explicitIntent = body.intent;      // optional override from client
        const clientCityOrZip = body.cityOrZip;  // optional provider hint

        if (!message.trim()) {
            return res.status(400).json({ error: "message (or query/input) is required" });
        }

        console.log("CHAT REQ:", { state, explicitIntent, clientCityOrZip, message });

        // --- pick intent: explicit > detectIntent(message) ---
        let intent = explicitIntent || detectIntent(message);

        // --- helper: light city/ZIP extraction for provider lookups ---
        const zipMatch = message.match(/\b(\d{5})\b/);
        const cityMatch = message.match(/\bin\s+([A-Za-z][A-Za-z\s]+)\b/i); // e.g., "in Pittsburgh"
        const inferredCityOrZip =
            clientCityOrZip ??
            (zipMatch ? zipMatch[1] : undefined) ??
            (cityMatch ? cityMatch[1].trim() : undefined);

        // If user clearly asked for providers but sent no explicit intent, nudge to LOOKUP_PROVIDER
        const looksLikeProvider = /\b(provider|providers|center|centers|daycare|child\s*care|near|in\s+[A-Za-z]|zip\s*\d{5})\b/i.test(message);
        if (!explicitIntent && looksLikeProvider) {
            intent = "LOOKUP_PROVIDER";
        }

        // ------------------- COST: direct DB path, no model ----------------------
        if (intent === "COST") {
            const db = await pool.connect();
            try {
                // Pull optional hints from request body if UI supplies them
                const countyFipsInput = body.countyFips || body.county_fips;
                const countyNameInput = body.county || undefined;

                // Attempt to resolve a county
                const countyRow = await resolveCountyFips(db, {
                    state,
                    countyFips: countyFipsInput,
                    countyName: countyNameInput,
                });

                if (!countyRow) {
                    return res.status(400).json({
                        intent: "COST",
                        error: `Couldn't resolve county. Provide a county FIPS or an exact county name in ${state}.`,
                    });
                }

                // Normalize optional filters
                const ageRaw = normalizeAgeGroup(body.age || body.age_group || "");
                const settingRaw = normalizeSetting(body.setting || "");

                const metric = (body.metric || "").toLowerCase(); // "median" or "p75"
                const wantMonthly = /month|monthly|per\s*month/i.test(body.units || body.period || "");

                // Query NDCP prices for this county/year, filter optionally by age/setting
                const params = [countyRow.county_fips, 2022];
                const where = ["county_fips = $1", "year = $2"];
                if (ageRaw) { params.push(ageRaw); where.push("age_group = $" + params.length); }
                if (settingRaw) { params.push(settingRaw); where.push("setting = $" + params.length); }

                const sql = `
          SELECT county_fips, state_fips, state, county, year, age_group, setting,
                 median AS median, p75 AS p75, source
          FROM prices_ndcp
          WHERE ${where.join(" AND ")}
          ORDER BY age_group, setting
        `;
                const r = await db.query(sql, params);

                if (r.rowCount === 0) {
                    return res.status(404).json({
                        intent: "COST",
                        error: `No NDCP price rows found for ${countyRow.county}, ${state}.`,
                    });
                }

                // Build query echo for response schema
                const queries = [];
                const ages = ageRaw ? [ageRaw] : ["infant", "toddler", "preschool"];
                const settings = settingRaw ? [settingRaw] : ["center", "family"];
                for (const a of ages) {
                    for (const s of settings) {
                        queries.push({
                            age_group: a,
                            setting: s,
                            metric: metric === "p75" ? "p75" : "median",
                            units: wantMonthly ? "monthly" : "weekly",
                        });
                    }
                }

                // Shape rows; we’ll include both weekly & monthly in the final payload
                const shaped = r.rows.map(row => ({
                    county_fips: row.county_fips,
                    state_fips: row.state_fips,
                    state: row.state,
                    county: row.county,
                    year: row.year,
                    age_group: row.age_group,
                    setting: row.setting,
                    median: row.median,
                    p75: row.p75,
                    source: row.source,
                }));

                const payload = buildCostResponse({
                    state,
                    countyRow,
                    rows: shaped,
                    queries,
                });

                // If the user asked for specific metric/period, it’s already reflected in queries;
                // UI can highlight the requested measure. We still return both weekly & monthly.
                return res.json({
                    intent: "COST",
                    data: payload,
                });
            } finally {
                // always release
                pool.release && pool.release(); // defensive in case of older pg versions
            }
        }

        // ----------------- Provider path (DB-only) -------------------------------
        if (intent === "LOOKUP_PROVIDER" || intent === "FIND_PROVIDER") {
            const results = await searchProviders({
                state,
                cityOrZip: inferredCityOrZip,
                limit: 10,
            });

            const place = inferredCityOrZip || state;
            const answer = results.length
                ? `Here are ${Math.min(results.length, 10)} providers in ${place}:`
                : `I couldn’t find providers for “${place}”. Try a city like “Pittsburgh” or a 5-digit ZIP.`;

            return res.json({
                intent: "LOOKUP_PROVIDER",
                answer,
                citations: [],         // not applicable here
                providers: results,    // raw rows for UI display
                sources: [],           // optional
            });
        }

        // ----------------- Document/RAG path (ratios, eligibility, etc.) --------
        const { systemPrompt } = getPrompt(intent, state, message);

        const docs = await ragSearchDocuments({
            state,
            intent,
            query: message,
            k: 5,
        });

        const context = docs
            .map(
                (d, i) =>
                    `#${i + 1}\nTITLE: ${d.title}\nURL: ${d.url}\nCONTENT:\n${d.content.slice(0, 1500)}`
            )
            .join("\n\n---\n\n");

        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        // Instruct the model to return STRICT JSON (your validator relies on this)
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.1,
            messages: [
                {
                    role: "system",
                    content:
                        systemPrompt +
                        " Always respond in STRICT JSON matching the schema for this intent. Do not include Markdown or extra text.",
                },
                {
                    role: "user",
                    content: `Use the context to answer. Cite URLs/sections inside the JSON.

EXPECTED_INTENT: ${intent}
STATE: ${state}

CONTEXT:
${context}

QUESTION: ${message}

Return ONLY JSON.`,
                },
            ],
        });

        const raw = completion.choices?.[0]?.message?.content || "";
        const validation = validateIntentOutput(intent, raw);

        if (!validation.ok) {
            // Return useful info to UI for debugging
            return res.status(422).json({
                intent,
                error: "Schema validation failed",
                issues: validation.issues,
                raw,
                sources: docs.map((d) => ({ title: d.title, url: d.url })),
            });
        }

        // Normalized response for UI
        const data = ensurePaEligibilityScaffolding(intent, state, validation.data);
        return res.json({
            intent,
            answer: data.answer,                 // many intents include a top-level "answer"
            citations: data.citations || [],     // keep
            data,                                // full validated payload
            sources: docs.map((d) => ({ title: d.title, url: d.url })),
        });
    } catch (e) {
        console.error("CHAT ERROR:", e?.response?.data || e);
        res.status(500).json({ error: e?.message || "Server error" });
    }
});

// ------------------------------ bootstrap -----------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

// backend/server.js
import express from "express";
import OpenAI from "openai";
import { detectIntent, getPrompt } from "./intentRouter.js";
import { validateIntentOutput } from "./validator.js";
import { ragSearchDocuments, searchProviders } from "./retriever.js";
import cors from "cors";

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
        origin: ["http://localhost:5173", "http://localhost:3001", "https://childcare-ui.netlify.app/"],
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"]
    })
);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/chat", async (req, res) => {
    try {
        const body = req.body || {};
        const message = body.message ?? body.query ?? body.input ?? "";
        const state = (body.state ?? "PA").toUpperCase();
        const explicitIntent = body.intent;
        const clientCityOrZip = body.cityOrZip;

        if (!message.trim() && body.intent !== "COST") {
            return res.status(400).json({ error: "message (or query/input) is required" });
        }

        console.log("CHAT REQ:", { state, explicitIntent, clientCityOrZip, message });

        let intent = explicitIntent || detectIntent(message);

        // Provider-ish heuristic (kept)
        const looksLikeProvider =
            /\b(provider|providers|center|centers|daycare|child\s*care|near|zip\s*\d{5})\b/i.test(
                message
            );
        if (!explicitIntent && looksLikeProvider) {
            intent = "LOOKUP_PROVIDER";
        }

        // -------------------- PROVIDERS --------------------
        if (intent === "LOOKUP_PROVIDER" || intent === "FIND_PROVIDER") {
            const zipMatch = message.match(/\b(\d{5})\b/);
            const cityMatch = message.match(/\bin\s+([A-Za-z][A-Za-z\s]+)\b/i);
            const inferredCityOrZip = clientCityOrZip
                ?? (zipMatch ? zipMatch[1] : undefined)
                ?? (cityMatch ? cityMatch[1].trim() : undefined);

            const results = await searchProviders({
                state,
                cityOrZip: inferredCityOrZip,
                limit: 10
            });

            const place = inferredCityOrZip || state;
            const answer = results.length
                ? `Here are ${Math.min(results.length, 10)} providers in ${place}:`
                : `I couldn’t find providers for “${place}”. Try a city like “Pittsburgh” or a 5-digit ZIP.`;

            return res.json({
                intent: "LOOKUP_PROVIDER",
                answer,
                citations: [],
                providers: results,
                sources: []
            });
        }

        // -------------------- DOCUMENTATION (Docs) --------------------
        if (intent === "DOCUMENTATION") {
            // 1) Try the raw query

            let docs = await ragSearchDocuments({ state, intent, query: message, k: 5, ignoreIntent: true });

            // 2) If weak results, broaden query with common doc keywords
            if (!docs || docs.length < 2) {
                const broadened = [
                    message,
                    `${message} filetype:pdf`,
                    `${message} Keystone STARS policy`,
                    `${state} child care code 3042 pdf`,
                    `${state} OCDEL guidance pdf`,
                    `Keystone STARS manual pdf`,
                    `PA Code 55 Chapter 3042 pdf`,
                    `child care licensing forms ${state}`
                ]
                    .filter((v, i, arr) => v && arr.indexOf(v) === i)
                    .join(" OR ");

                const fallbackDocs = await ragSearchDocuments({
                    state,
                    intent,
                    query: broadened,
                    k: 12
                });

                if (fallbackDocs && fallbackDocs.length > (docs?.length || 0)) {
                    docs = fallbackDocs;
                }
            }

            if (!docs || docs.length === 0) {
                return res.json({
                    intent,
                    answer:
                        `I couldn’t find official documents for “${message}”. ` +
                        `Try a more specific phrase like “PA Code § 3042.31”, “Keystone STARS Performance Standards PDF”, or “OCDEL policy announcement pdf”.`,
                    citations: [],
                    data: null,
                    sources: []
                });
            }

            // Return links directly (no LLM), use your UI's citations list
            const citations = docs.slice(0, 12).map((d) => ({
                title: d.title,
                url: d.url
            }));

            return res.json({
                intent,
                answer: `Here are ${citations.length} document link(s) that match your request:`,
                citations,
                data: null,
                sources: docs.map((d) => ({ title: d.title, url: d.url }))
            });
        }

        // -------------------- RAG + LLM for other intents --------------------
        const { systemPrompt } = getPrompt(intent, state);

        const docs = await ragSearchDocuments({
            state,
            intent,
            query: message,
            k: 5
        });

        const context = docs
            .map(
                (d, i) =>
                    `#${i + 1}\nTITLE: ${d.title}\nURL: ${d.url}\nCONTENT:\n${d.content.slice(0, 1500)}`
            )
            .join("\n\n---\n\n");

        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.1,
            messages: [
                {
                    role: "system",
                    content:
                        systemPrompt +
                        " Always respond in STRICT JSON matching the schema for this intent. Do not include Markdown or extra text."
                },
                {
                    role: "user",
                    content: `Use the context to answer. Cite URLs/sections inside the JSON.

EXPECTED_INTENT: ${intent}
STATE: ${state}

CONTEXT:
${context}

QUESTION: ${message}

Return ONLY JSON.`
                }
            ]
        });

        const raw = completion.choices?.[0]?.message?.content || "";
        const validation = validateIntentOutput(intent, raw);

        if (!validation.ok) {
            return res.status(422).json({
                intent,
                error: "Schema validation failed",
                issues: validation.issues,
                raw,
                sources: docs.map((d) => ({ title: d.title, url: d.url }))
            });
        }

        const data = validation.data;

        // PA-specific guardrails for eligibility clarifying questions
        if (intent === "CHECK_ELIGIBILITY" && state === "PA") {
            if (
                !data.clarifying_questions ||
                !Array.isArray(data.clarifying_questions) ||
                data.clarifying_questions.length === 0
            ) {
                data.clarifying_questions = DEFAULT_PA_ELIGIBILITY_QUESTIONS;
            }
            if (!data.summary) {
                data.summary =
                    "To assess eligibility for Pennsylvania Child Care Works (CCW), please answer the questions below.";
            }
            if (!data.estimated_fit) {
                data.estimated_fit = "uncertain";
            }
        }

        return res.json({
            intent,
            answer: data.answer,
            citations: data.citations || [],
            data,
            sources: docs.map((d) => ({ title: d.title, url: d.url }))
        });
    } catch (e) {
        console.error("CHAT ERROR:", e?.response?.data || e);
        res.status(500).json({ error: e?.message || "Server error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

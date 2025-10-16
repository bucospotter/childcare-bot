// backend/server.js
import express from "express";
import OpenAI from "openai";
import { detectIntent, getPrompt } from "./intentRouter.js";
import { validateIntentOutput } from "./validator.js";
import { ragSearchDocuments, searchProviders } from "./retriever.js";
import cors from "cors";

const app = express();
app.use(express.json());

app.use(cors({
    origin: [
        "http://localhost:5173", // Vite
        "http://localhost:3001"  // Next.js
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/chat", async (req, res) => {
    try {
        // --- normalize incoming payloads from different UIs/clients ---
        const body = req.body || {};
        const message = body.message ?? body.query ?? body.input ?? "";
        const state = (body.state ?? "PA").toUpperCase();
        const explicitIntent = body.intent;           // optional override from client
        const clientCityOrZip = body.cityOrZip;       // optional override from client

        if (!message.trim()) {
            return res.status(400).json({ error: "message (or query/input) is required" });
        }

        console.log("CHAT REQ:", { state, explicitIntent, clientCityOrZip, message });

        // --- pick intent: explicit > detectIntent(message) ---
        let intent = explicitIntent || detectIntent(message);

        // --- helper: light city/ZIP extraction for provider lookups ---
        const zipMatch = message.match(/\b(\d{5})\b/);
        const cityMatch = message.match(/\bin\s+([A-Za-z][A-Za-z\s]+)\b/i); // e.g., "in Pittsburgh"
        const inferredCityOrZip = clientCityOrZip
            ?? (zipMatch ? zipMatch[1] : undefined)
            ?? (cityMatch ? cityMatch[1].trim() : undefined);

        // If user asked for “providers/centers in X” but UI sent wrong intent, auto-correct
        const looksLikeProvider =
            /\b(provider|providers|center|centers|daycare|child\s*care|near|in\s+[A-Za-z]|zip\s*\d{5})\b/i.test(message);
        if (!explicitIntent && looksLikeProvider) {
            intent = "LOOKUP_PROVIDER";
        }

        // --- Provider path (DB only) ---
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

            // You can shape providers however your UI expects
            return res.json({
                intent: "LOOKUP_PROVIDER",
                answer,
                citations: [],            // not applicable here
                providers: results,       // raw rows for UI display
                sources: [],              // optional
            });
        }

        // --- Document/RAG path (ratios, eligibility, etc.) ---
        const { systemPrompt } = getPrompt(intent, state);

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

        // Normalized response shape for UI
        const data = validation.data; // { answer, citations, ... } per your schema
        return res.json({
            intent,
            answer: data.answer,
            citations: data.citations || [],
            data, // keep full validated payload if UI wants extra fields
            sources: docs.map((d) => ({ title: d.title, url: d.url })),
        });
    } catch (e) {
        console.error("CHAT ERROR:", e?.response?.data || e);
        res.status(500).json({ error: e?.message || "Server error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

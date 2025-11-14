// backend/intentRouter.js

// --- lightweight helpers -----------------------------------------------------

/** Try to recognize a US state postal code in free text (very lightweight). */
function detectStateHint(text, fallback = "PA") {
  if (!text) return fallback;
  const m = text.match(/\b(AL|AK|AS|AZ|AR|CA|CO|CT|DC|DE|FL|GA|GU|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MP|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|PR|RI|SC|SD|TN|TX|UT|VA|VI|VT|WA|WI|WV|WY)\b/i);
  return m ? m[1].toUpperCase() : fallback;
}

/** True if question looks like a price/cost query. */
function isCostQuery(q) {
  // core keywords
  const kw = /\b(costs?|price|prices|tuition|rate|rates|fee|fees|afford|affordability|how much|median|p50|p75|percentile|weekly|monthly)\b/i;
  // age/setting hints often used in price questions
  const ageSetting = /\b(infant|toddler|preschool|school[-\s]?age|center|family\s+(child\s+)?care|home\s+based|fcc)\b/i;
  // pattern with currency or $.../week,/month
  const money = /\$\s?\d|(\d{2,4}\s?(per|\/)\s?(week|wk|month|mo))/i;

  return kw.test(q) || money.test(q) || (kw.test(q) && ageSetting.test(q));
}

// --- intent detection --------------------------------------------------------

export function detectIntent(text) {
  const q = (text || "").toLowerCase();

  // 1) COST (childcare price/tuition by county/age/setting)
  if (isCostQuery(q)) return "COST";

  // 2) FIND_PROVIDER
  if (/\b(near|find|search|within|miles|zip|open|hours|daycare|center|family child care|preschool)\b/.test(q) || /\b\d{5}\b/.test(q))
    return "FIND_PROVIDER";

  // 3) CHECK_ELIGIBILITY
  if (/\b(eligible|eligibility|qualify|income|apply|application|copay|assistance|subsidy|voucher)\b/.test(q))
    return "CHECK_ELIGIBILITY";

  // 4) LOOKUP_RULE
  if (/\b(ratio|ratios|group size|capacity|licensing|regulation|rule|requirement|background check|inspection|health|safety|training|cmr|pa\. code|csr|§)\b/.test(q))
    return "LOOKUP_RULE";

  // 5) EXPLAIN_PROCESS
  if (/\b(how to|renew|register|become licensed|start a daycare|open a center|background check|fingerprint|orientation)\b/.test(q))
    return "EXPLAIN_PROCESS";

  // 6) PROGRAM_INFO
  if (/\b(qris|keystone|stars|quality rating|level)\b/.test(q))
    return "PROGRAM_INFO";

  // 7) CONTACT_HELP
  if (/\b(contact|call|phone|email|office|agency|help|support|hotline)\b/.test(q))
    return "CONTACT_HELP";

  return "GENERAL";
}

// --- prompts -----------------------------------------------------------------

// Minimal prompt generator using schema-like mappings
export function getPrompt(intent, stateHint = "PA", userText = "") {
  // Preserve your default, but allow a quick best-effort override from user text.
  const STATE = detectStateHint(userText, (stateHint || "PA").toUpperCase());

  const systemByIntent = {
    FIND_PROVIDER: `You are a childcare provider finder for ${STATE}. Use only provider records and linked official pages. Include citation URLs.`,
    CHECK_ELIGIBILITY: `You are a ${STATE} childcare assistance explainer. Use only retrieved eligibility documents and cite sections/URLs. Provide a clear checklist.`,
    LOOKUP_RULE: `You are a ${STATE} licensing rules assistant. Quote the exact section (§) when possible and provide a brief plain-language explanation.`,
    EXPLAIN_PROCESS: `You are a ${STATE} childcare process guide. Produce numbered steps, requirements, timelines, fees, links, and citations.`,
    PROGRAM_INFO: `You are a ${STATE} quality rating explainer. Define the program, levels/criteria, and benefits. Include citations.`,
    CONTACT_HELP: `You are a ${STATE} childcare contact directory helper. Return the best office for the user’s topic with phone/email and a citation URL.`,
    GENERAL: `Be helpful and brief. If the user is asking for childcare info, ask a SINGLE clarifying question to route to an intent.`,

    // ✅ New COST intent
    COST: `You are a ${STATE} childcare cost analyst. Answer using the local database table prices_ndcp (median and 75th percentile weekly prices) joined with counties.
Return prices by:
- county_fips OR (state + county name),
- age_group ∈ {"infant","toddler","preschool"} (accept common aliases),
- setting ∈ {"center","family"} (accept "home-based" as family).

Rules:
- If the user provides a county FIPS, use it directly; else resolve by exact county name within ${STATE}.
- If age_group or setting is missing, return both settings for all three age groups.
- Default metric is "median". If the user asks for 75th percentile, use p75.
- Return weekly prices by default; if the user requests monthly, convert with ×4.333 (round to 2 decimals).
- Include an explanation of assumptions and what was inferred from the query.

Respond as strict JSON that matches the COST schema:
{
  "state": "PA",
  "county_fips": "42051",
  "county": "Fayette County",
  "queries": [{ "age_group": "infant", "setting": "family", "metric": "median", "units": "weekly" }],
  "answers": [{ "age_group": "infant", "setting": "family", "weekly": { "median": 140.15, "p75": 150.00 }, "monthly": { "median": 607.54, "p75": 649.95 } }],
  "notes": ["Assumed units=weekly; monthly derived with ×4.333."],
  "citations": ["file://NDCP2022.xlsx"]
}

Only include fields defined by the schema.`
  };

  // Base prompt for the selected intent
  let systemPrompt = systemByIntent[intent] || systemByIntent.GENERAL;

  // ✅ PA-specific nudge for Eligibility answers (keep your original behavior)
  if (intent === "CHECK_ELIGIBILITY" && STATE === "PA") {
    systemPrompt += `
When the state is PA, prefer citing **55 Pa. Code Chapter 3042** sections (e.g., §§ 3042.31–3042.37, 3042.41–3042.44, 3042.91–3042.99) and include URLs to the specific section pages (PA Code and Bulletin).`;
  }

  return { systemPrompt, collection: intent };
}

// backend/intentRouter.js
export function detectIntent(text) {
  const q = (text || "").toLowerCase();

  // NEW: prioritize "Docs" queries early so they don't fall into other buckets
  if (
      /\b(doc|docs|document|documentation|pdf|policy|manual|guide|handbook|form|forms)\b/.test(q) ||
      /\b(keystone\s*stars|pa code|chapter\s*3042|ocdel|statute|regulation pdf)\b/.test(q)
  ) {
    return "DOCUMENTATION";
  }

  if (
      /\b(near|find|search|within|miles|zip|open|hours|daycare|center|family child care|preschool)\b/.test(
          q
      ) || /\b\d{5}\b/.test(q)
  )
    return "FIND_PROVIDER";

  if (/\b(eligible|eligibility|qualify|income|apply|application|copay|assistance|subsidy|voucher)\b/.test(q))
    return "CHECK_ELIGIBILITY";

  if (/\b(ratio|ratios|group size|capacity|licensing|regulation|rule|requirement|background check|inspection|health|safety|training|cmr|pa\. code|csr|§)\b/.test(q))
    return "LOOKUP_RULE";

  if (/\b(how to|renew|register|become licensed|start a daycare|open a center|background check|fingerprint|orientation)\b/.test(q))
    return "EXPLAIN_PROCESS";

  if (/\b(qris|keystone|stars|quality rating|level)\b/.test(q))
    return "PROGRAM_INFO";

  return "GENERAL";
}

// Minimal prompt generator using schema-like mappings
export function getPrompt(intent, stateHint = "PA") {
  const STATE = (stateHint || "PA").toUpperCase();

  const systemByIntent = {
    FIND_PROVIDER: `You are a childcare provider finder for ${STATE}. Use only provider records and linked official pages. Include citation URLs.`,
    CHECK_ELIGIBILITY: `You are a ${STATE} childcare assistance explainer. Use only retrieved eligibility documents and cite sections/URLs. Provide a clear checklist.`,
    LOOKUP_RULE: `You are a ${STATE} licensing rules assistant. Quote the exact section (§) when possible and provide a brief plain-language explanation.`,
    EXPLAIN_PROCESS: `You are a ${STATE} childcare process guide. Produce numbered steps, requirements, timelines, fees, links, and citations.`,
    PROGRAM_INFO: `You are a ${STATE} quality rating explainer. Define the program, levels/criteria, and benefits. Include citations.`,
    // NEW: Documentation mode — return links only from context
    DOCUMENTATION: `You are a ${STATE} childcare documentation finder. Return a list of relevant document links (title + URL) using ONLY the provided context. Do not invent links. If nothing relevant is in context, say you couldn’t find it and suggest narrower terms.`,
    GENERAL: `Be helpful and brief. If the user is asking for childcare info, ask a SINGLE clarifying question to route to an intent.`
  };

  // PA-specific nudge for Eligibility answers
  if (intent === "CHECK_ELIGIBILITY" && STATE === "PA") {
    systemPrompt += `
When the state is PA, prefer citing **55 Pa. Code Chapter 3042** sections (e.g., §§ 3042.31–3042.37, 3042.41–3042.44, 3042.91–3042.99) and include URLs to the specific section pages (PA Code and Bulletin).`;
  }

  let systemPrompt = systemByIntent[intent] || systemByIntent.GENERAL;
  return { systemPrompt, collection: intent };
}

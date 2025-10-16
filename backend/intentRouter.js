// backend/intentRouter.js
export function detectIntent(text) {
  const q = (text || "").toLowerCase();
  if (/\b(near|find|search|within|miles|zip|open|hours|daycare|center|family child care|preschool)\b/.test(q) || /\b\d{5}\b/.test(q))
    return "FIND_PROVIDER";
  if (/\b(eligible|eligibility|qualify|income|apply|application|copay|assistance|subsidy|voucher)\b/.test(q))
    return "CHECK_ELIGIBILITY";
  if (/\b(ratio|ratios|group size|capacity|licensing|regulation|rule|requirement|background check|inspection|health|safety|training|cmr|pa\. code|csr|§)\b/.test(q))
    return "LOOKUP_RULE";
  if (/\b(how to|renew|register|become licensed|start a daycare|open a center|background check|fingerprint|orientation)\b/.test(q))
    return "EXPLAIN_PROCESS";
  if (/\b(qris|keystone|stars|quality rating|level)\b/.test(q))
    return "PROGRAM_INFO";
  if (/\b(contact|call|phone|email|office|agency|help|support|hotline)\b/.test(q))
    return "CONTACT_HELP";
  return "GENERAL";
}

// Minimal prompt generator using schema-like mappings
export function getPrompt(intent, stateHint = "PA") {
  const STATE = stateHint.toUpperCase();
  const systemByIntent = {
    FIND_PROVIDER: `You are a childcare provider finder for ${STATE}. Use only provider records and linked official pages. Include citation URLs.`,
    CHECK_ELIGIBILITY: `You are a ${STATE} childcare assistance explainer. Use only retrieved eligibility documents and cite sections/URLs. Provide a clear checklist.`,
    LOOKUP_RULE: `You are a ${STATE} licensing rules assistant. Quote the exact section (§) when possible and provide a brief plain-language explanation.`,
    EXPLAIN_PROCESS: `You are a ${STATE} childcare process guide. Produce numbered steps, requirements, timelines, fees, links, and citations.`,
    PROGRAM_INFO: `You are a ${STATE} quality rating explainer. Define the program, levels/criteria, and benefits. Include citations.`,
    CONTACT_HELP: `You are a ${STATE} childcare contact directory helper. Return the best office for the user’s topic with phone/email and a citation URL.`,
    GENERAL: `Be helpful and brief. If the user is asking for childcare info, ask a SINGLE clarifying question to route to an intent.`
  };
  return { systemPrompt: systemByIntent[intent] || systemByIntent.GENERAL, collection: intent };
}

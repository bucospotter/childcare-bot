// backend/validator.js
import { getSchema } from "./schemas.js";

export function extractJsonCandidate(text) {
  // Try to extract JSON (supports fenced code blocks)
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) return fence[1];
  return text.trim();
}

export function validateIntentOutput(intent, rawText) {
  const schema = getSchema(intent);
  if (!schema) return { ok: true, data: rawText }; // nothing to validate

  let candidate = extractJsonCandidate(rawText);
  try {
    const parsed = JSON.parse(candidate);
    const result = schema.safeParse(parsed);
    if (result.success) return { ok: true, data: result.data };
    return { ok: false, error: "Schema validation failed", issues: result.error.issues, raw: candidate };
  } catch (e) {
    return { ok: false, error: "JSON parse failed", raw: candidate };
  }
}

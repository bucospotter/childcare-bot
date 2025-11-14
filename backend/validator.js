// backend/validator.js
import { getSchema } from "./schemas.js";

/**
 * Extract a JSON-looking payload from a freeform LLM response.
 * - Supports ```json ... ``` fenced blocks
 * - Falls back to whole string
 */
export function extractJsonCandidate(text) {
  if (!text) return "";
  const fence = text.match(/```(?:json|jsonc)?\s*([\s\S]*?)\s*```/i);
  if (fence) return fence[1];
  return text.trim();
}

/**
 * Remove // and /* *\/ comments and trailing commas to make JSON more lenient.
 * Note: this is a lightweight sanitizer, not a full JSON5 parser.
 */
function sanitizeJson(text) {
  if (!text) return text;
  // strip // line comments
  let s = text.replace(/(^|[^:])\/\/.*$/gm, "$1");
  // strip /* block comments */
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  // remove trailing commas in objects and arrays
  s = s
      .replace(/,\s*([}\]])/g, "$1")            // ,} or ,]
      .replace(/([{\[])\s*,\s*([}\]])/g, "$1$2"); // {,} or [,]
  // trim BOM/whitespace
  return s.replace(/^\uFEFF/, "").trim();
}

/**
 * Canonicalize/patch fields for specific intents before schema validation.
 * This lets us accept common aliases from the model while keeping strict schemas.
 */
function canonicalizeForIntent(intent, obj) {
  if (!obj || typeof obj !== "object") return obj;

  if (intent === "COST") {
    // accept 'age' as alias of 'age_group'
    if (obj.age_group == null && typeof obj.age === "string") {
      obj.age_group = obj.age;
    }
    // accept 'p50' as synonym of 'median'
    if (obj.metric === "p50") obj.metric = "median";
    // coerce state to uppercase 2-letter if looks like a state code
    if (typeof obj.state === "string" && obj.state.length === 2) {
      obj.state = obj.state.toUpperCase();
    }
    // allow 'countyFips' alias
    if (obj.county_fips == null && typeof obj.countyFips === "string") {
      obj.county_fips = obj.countyFips;
    }
    // allow 'setting' synonyms
    if (typeof obj.setting === "string") {
      const v = obj.setting.toLowerCase();
      if (v.includes("center")) obj.setting = "center";
      if (v.includes("home") || v.includes("family")) obj.setting = "family";
    }
    // allow 'units' synonyms
    if (typeof obj.units === "string") {
      const u = obj.units.toLowerCase();
      if (u.startsWith("mon")) obj.units = "monthly";
      if (u.startsWith("week")) obj.units = "weekly";
    }
  }

  return obj;
}

/**
 * Human-readable Zod issues for easier debugging.
 */
function summarizeZodIssues(issues) {
  if (!Array.isArray(issues)) return undefined;
  return issues.slice(0, 10).map((i) => {
    const path = i.path?.length ? i.path.join(".") : "(root)";
    return `${path}: ${i.message}`;
  });
}

/**
 * Validate an intent’s output. Returns:
 *  - { ok: true, data } on success (data is parsed & validated)
 *  - { ok: false, error, issues?, raw } on failure
 */
export function validateIntentOutput(intent, rawText) {
  const schema = getSchema(intent);
  if (!schema) return { ok: true, data: rawText }; // nothing to validate

  const candidate = extractJsonCandidate(rawText);
  const cleaned = sanitizeJson(candidate);

  try {
    const parsed = JSON.parse(cleaned);
    const patched = canonicalizeForIntent(intent, parsed);

    const result = schema.safeParse(patched);
    if (result.success) {
      return { ok: true, data: result.data };
    }
    return {
      ok: false,
      error: "Schema validation failed",
      issues: result.error.issues,
      issue_summary: summarizeZodIssues(result.error.issues),
      raw: cleaned,
    };
  } catch (e) {
    return { ok: false, error: "JSON parse failed", raw: cleaned };
  }
}

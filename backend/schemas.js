// backend/schemas.js
import { z } from "zod";

export const Schemas = {
  CHECK_ELIGIBILITY: z.object({
    summary: z.string(),
    estimated_fit: z.enum(["likely","uncertain","unlikely"]),
    income_table: z.array(z.object({
      household_size: z.number().int().positive(),
      max_income: z.number().nonnegative(),
      unit: z.string()
    })).optional(),
    next_steps: z.array(z.string()),
    application_links: z.array(z.string().url()),
    required_documents: z.array(z.string()).optional(),
    citations: z.array(z.string()).min(1),
  
    clarifying_questions: z.array(z.string()).optional(),}),

  LOOKUP_RULE: z.object({
    answer: z.string(),
    reg_section: z.string().nullable().optional(),
    effective_date: z.string().nullable().optional(),
    citations: z.array(z.string()).min(1)
  }),

  EXPLAIN_PROCESS: z.object({
    steps: z.array(z.string()),
    requirements: z.array(z.string()).optional(),
    fees: z.array(z.string()).optional(),
    processing_times: z.string().nullable().optional(),
    citations: z.array(z.string()).min(1)
  }),

  PROGRAM_INFO: z.object({
    overview: z.string(),
    levels: z.array(z.object({
      level: z.string(),
      criteria: z.array(z.string())
    })).optional(),
    benefits: z.array(z.string()).optional(),
    citations: z.array(z.string()).min(1)
  }),

  CONTACT_HELP: z.object({
    agency_name: z.string(),
    phone: z.string(),
    email: z.string().email().nullable().optional(),
    address: z.string().nullable().optional(),
    hours: z.string().nullable().optional(),
    topic: z.string().nullable().optional(),
    citation_url: z.string()
  })
};

export function getSchema(intent) {
  return Schemas[intent] || null;
}

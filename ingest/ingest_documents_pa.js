// ingest/ingest_documents_pa.js
import pg from "pg";
import OpenAI from "openai";
import fs from "fs/promises";
import { chunkText } from "./utils/chunk.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,   ssl: {
    require: true,
    rejectUnauthorized: false // use true if you provide a CA cert
  } });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function embedAndInsert({ state, intent, title, url, content }) {
  const chunks = chunkText(content, { maxChars: 1800, overlap: 200 });

  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];

    const emb = await openai.embeddings.create({
      model: "text-embedding-3-large",
      input: chunk
    });

    const vec = emb.data[0].embedding;     // number[]
    const vecSql = `[${vec.join(",")}]`;   // pgvector literal: "[...,...]"

    await pool.query(
        `INSERT INTO documents (state, intent, title, url, content, embedding)
       VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        [state, intent, `${title} [${idx + 1}/${chunks.length}]`, url, chunk, vecSql]
    );
  }
}

async function main() {
  // Example: load a local text export of PA regs
  const content = await fs.readFile("./ingest/data/pa_chapter_3270.txt", "utf8");
  await embedAndInsert({
    state: "PA",
    intent: "LOOKUP_RULE",
    title: "PA Code Title 55 Chapter 3270",
    url: "https://www.pacodeandbulletin.gov/",
    content
  });

  console.log("✅ PA documents ingested");
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });

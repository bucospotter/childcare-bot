// ingest/ingest_documents_ma.js
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
    await pool.query(
      `INSERT INTO documents(state,intent,title,url,content,embedding)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [state, intent, `${title} [${idx+1}/${chunks.length}]`, url, chunk, emb.data[0].embedding]
    );
  }
}

async function main() {
  const content = await fs.readFile("./ingest/data/ma_606_cmr_7.txt", "utf8");
  await embedAndInsert({
    state: "MA",
    intent: "LOOKUP_RULE",
    title: "Massachusetts 606 CMR 7.00",
    url: "https://www.mass.gov/regulations/606-CMR-700-standards-for-the-licensure-or-approval-of-family-child-care-small-group-and-school-age-child-care-programs",
    content
  });

  const elig = await fs.readFile("./ingest/data/ma_ccdf_eligibility.txt", "utf8");
  await embedAndInsert({
    state: "MA",
    intent: "CHECK_ELIGIBILITY",
    title: "Massachusetts Child Care Financial Assistance",
    url: "https://www.mass.gov/child-care-financial-assistance",
    content: elig
  });

  console.log("✅ MA documents ingested");
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });

// ingest/ingest_documents_wv.js
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
  const content = await fs.readFile("./ingest/data/wv_78_csr_rules.txt", "utf8");
  await embedAndInsert({
    state: "WV",
    intent: "LOOKUP_RULE",
    title: "West Virginia 78 CSR (Child Care Licensing)",
    url: "https://ohflac.wvdhhr.org/RuleIndex.aspx",
    content
  });

  const elig = await fs.readFile("./ingest/data/wv_ccdf_eligibility.txt", "utf8");
  await embedAndInsert({
    state: "WV",
    intent: "CHECK_ELIGIBILITY",
    title: "West Virginia Child Care Assistance",
    url: "https://dhhr.wv.gov/bcf/Children_Adult/ChildCare/Pages/Financial-Help.aspx",
    content: elig
  });

  console.log("✅ WV documents ingested");
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });

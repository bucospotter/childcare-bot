// backend/retriever.js
import 'dotenv/config';
import pg from "pg";
import OpenAI from "openai";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    require: true,
    rejectUnauthorized: false // use true if you provide a CA cert
  }
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Generic vector search over the 'documents' table for doc-based intents.
 * Uses pgvector (<#>) cosine distance.
 */
export async function ragSearchDocuments({ state, intent, query, k = 5 }) {
  const emb = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: query
  });

  const vecSql = `[${emb.data[0].embedding.join(",")}]`; // pgvector literal

  const { rows } = await pool.query(
      `
    SELECT id, title, url, content,
           1 - (embedding <=> $1::vector) AS similarity
    FROM documents
    WHERE state = $2
      AND (intent = $3 OR intent IS NULL)
    ORDER BY embedding <=> $1::vector
    LIMIT 5
    `,
      [vecSql, state, intent] // <— pass intent from caller
  );
  return rows;
}

/**
 * Simple provider search (SQL filter only)
 */
export async function searchProviders({ state, cityOrZip, limit = 10 }) {
  const where = [`state = $1`];
  const params = [state];

  if (cityOrZip) {
    if (/^\d{5}$/.test(cityOrZip)) {
      params.push(cityOrZip);
      where.push(`zip = $${params.length}`);
    } else {
      params.push(cityOrZip.toUpperCase());
      where.push(`UPPER(city) = $${params.length}`);
    }
  }

  const sql = `
    SELECT name, address, city, zip, license_type, license_status,
           qris_rating, source_url, last_seen
    FROM providers
    WHERE ${where.join(" AND ")}
    LIMIT ${limit}
  `;

  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Direct semantic similarity search — returns docs with cosine similarity score.
 * Useful for debugging or exploratory queries.
 */
export async function searchSimilar(queryText, state) {
  const emb = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: queryText
  });

  const vecSql = `[${emb.data[0].embedding.join(",")}]`; // pgvector literal

  const { rows } = await pool.query(
      `
    SELECT id, title, url, content,
           1 - (embedding <=> $1::vector) AS similarity
    FROM documents
    WHERE state = $2
    ORDER BY embedding <=> $1::vector
    LIMIT 5
    `,
      [vecSql, state]
  );

  return rows;
}
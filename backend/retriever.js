// backend/retriever.js
import "dotenv/config";
import pg from "pg";
import OpenAI from "openai";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { require: true, rejectUnauthorized: false } // set to true if you provide a CA cert
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Generic vector search over the 'documents' table for doc-based intents.
 * Uses pgvector cosine distance (<=>). Higher similarity = closer match.
 *
 * Options:
 *  - k: number of results (default 5)
 *  - searchIntents: optional array of intents to allow (otherwise [intent])
 *  - ignoreIntent: if true, do NOT filter by intent (Documents tab behavior)
 */
export async function ragSearchDocuments({
                                           state,
                                           intent,
                                           query,
                                           k = 5,
                                           searchIntents,
                                           ignoreIntent = false
                                         }) {
  // 1) Embed query
  const emb = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: query
  });
  const vecSql = `[${emb.data[0].embedding.join(",")}]`; // pgvector literal

  // 2) Vector search (with or without intent filter)
  let rows;
  if (ignoreIntent) {
    // Search ALL documents for the state regardless of intent
    const sqlAll = `
      SELECT id, title, url, content, intent,
             1 - (embedding <=> $1::vector) AS similarity
      FROM documents
      WHERE state = $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3
    `;
    ({ rows } = await pool.query(sqlAll, [vecSql, state, k]));
  } else {
    const intents = Array.isArray(searchIntents) && searchIntents.length > 0
        ? searchIntents
        : [intent];

    const sqlSome = `
      SELECT id, title, url, content, intent,
             1 - (embedding <=> $1::vector) AS similarity
      FROM documents
      WHERE state = $2
        AND (intent = ANY($3) OR intent IS NULL)
      ORDER BY embedding <=> $1::vector
      LIMIT $4
    `;
    ({ rows } = await pool.query(sqlSome, [vecSql, state, intents, k]));
  }

  // 3) Lightweight keyword fallback if vector search returns nothing
  if (!rows || rows.length === 0) {
    const qLike = `%${query}%`;
    if (ignoreIntent) {
      const sqlFallbackAll = `
        SELECT id, title, url, content, intent,
               NULL::float8 AS similarity
        FROM documents
        WHERE state = $1
          AND (title ILIKE $2 OR content ILIKE $2)
        LIMIT $3
      `;
      ({ rows } = await pool.query(sqlFallbackAll, [state, qLike, k]));
    } else {
      const intents = Array.isArray(searchIntents) && searchIntents.length > 0
          ? searchIntents
          : [intent];
      const sqlFallbackSome = `
        SELECT id, title, url, content, intent,
               NULL::float8 AS similarity
        FROM documents
        WHERE state = $1
          AND (intent = ANY($2) OR intent IS NULL)
          AND (title ILIKE $3 OR content ILIKE $3)
        LIMIT $4
      `;
      ({ rows } = await pool.query(sqlFallbackSome, [state, intents, qLike, k]));
    }
  }

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

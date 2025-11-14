// ingest/ingest_pa_eligibility.js
import pg from "pg";
import OpenAI from "openai";
import { chunkText } from "./utils/chunk.js";
import * as cheerio from "cheerio";
import fetch from "node-fetch";
import 'dotenv/config'

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { require: true, rejectUnauthorized: false }
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function cleanHtmlToText(html) {
    const $ = cheerio.load(html);
    // Kill nav/headers/footers that PA Code pages include:
    $("nav, header, footer, script, style").remove();
    // Keep the section title + body
    const title = $("h2, h1").first().text().trim() || $("title").text().trim();
    const body = $("#content, #innercontent, body").text().replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
    return { title, text: `${title}\n\n${body}`.trim() };
}

async function embed(text) {
    const { data } = await openai.embeddings.create({
        input: text,
        model: "text-embedding-3-large"
    });
    return data[0].embedding;
}

function toSqlVector(arr) {
    // ensure numbers (pgvector wants `[n1,n2,...]`)
    const nums = arr.map(x => (typeof x === "string" ? parseFloat(x) : x));
    return `[${nums.join(",")}]`;
}

async function embedAndInsert({ state, intent, title, url, content }) {
    const chunks = chunkText(content, { maxChars: 1800, overlap: 200 });
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const vec = await embed(chunk);

        await pool.query(`
      INSERT INTO documents (state, intent, title, url, content, embedding)
      VALUES ($1, $2, $3, $4, $5, $6::vector)
      ON CONFLICT (state, intent, title, url, content_md5) DO NOTHING
    `, [state, intent, `${title} (part ${i + 1})`, url, chunk, toSqlVector(vec)]);
    }
}

async function fetchTocLinks() {
    const tocUrl = "https://www.pacodeandbulletin.gov/Display/pacode?file=/secure/pacode/data/055/chapter3042/chap3042toc.html";
    const html = await (await fetch(tocUrl)).text();
    const $ = cheerio.load(html);
    const links = [];
    $("a").each((_, a) => {
        const href = $(a).attr("href") || "";
        if (/\/secure\/pacode\/data\/055\/chapter3042\/s3042\.\d+\.html/.test(href)) {
            links.push(new URL(href, tocUrl).toString());
        }
    });
    return [...new Set(links)];
}

async function main() {
    const links = await fetchTocLinks();
    for (const url of links) {
        const html = await (await fetch(url)).text();
        const { title, text } = await cleanHtmlToText(html);
        await embedAndInsert({
            state: "PA",
            intent: "CHECK_ELIGIBILITY",
            title: `55 Pa. Code ${title || "Chapter 3042"}`,
            url,
            content: text
        });
        console.log("Ingested:", title || url);
    }
    console.log("✅ PA Chapter 3042 ingested");
    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });

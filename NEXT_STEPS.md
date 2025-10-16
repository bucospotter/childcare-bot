# Next Steps to Run Your Childcare Bot (MA/PA/WV)

1) **Environment**
   - Ensure Postgres is running and your DB has `CREATE EXTENSION vector;`
   - Set `.env` with:
     - `DATABASE_URL=postgres://...`
     - `OPENAI_API_KEY=...`
     - (optional) `PA_PROVIDERS_URL=https://...`

2) **Install deps**
   ```bash
   cd /mnt/data/childcare-bot/childcare-bot
   npm install
   ```

3) **Ingest documents**
   - Place PA regs text at `ingest/data/pa_chapter_3270.txt` (export from PDF to text).
   - Run:
   ```bash
   npm run ingest:pa:docs
   ```

4) **Ingest providers**
   - Set `PA_PROVIDERS_URL` to a JSON endpoint with fields: name, address, city, zip, license_type, license_status, qris_rating, source_url
   - Run:
   ```bash
   npm run ingest:pa:providers
   ```

5) **Start backend**
   ```bash
   npm start
   ```
   - Test:
   ```bash
   curl -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d '{"message":"What is the infant ratio in PA?"}'
   ```

6) **Extend**
   - Duplicate the PA ingest scripts for MA/WV (documents + providers).
   - Add more intents by adding more documents in the `documents` table.
   - Improve `searchProviders` with hours/age filters when your data has those fields.

7) **Quality**
   - Add schema validation to ensure LLM answers include citations (e.g., using zod).
   - Add small test sets per intent to evaluate routing and answers.


## New: MA/WV ingestion & CSV→JSON

### Ingest MA/WV documents
```bash
npm run ingest:ma:docs
npm run ingest:wv:docs
```

Place text files first:
- `ingest/data/ma_606_cmr_7.txt`
- `ingest/data/ma_ccdf_eligibility.txt`
- `ingest/data/wv_78_csr_rules.txt`
- `ingest/data/wv_ccdf_eligibility.txt`

### Providers from CSV or JSON
Set one of these in `.env`:
```
MA_PROVIDERS_SRC=/absolute/path/to/ma_providers.csv   # or a https:// URL (CSV/JSON)
WV_PROVIDERS_SRC=/absolute/path/to/wv_providers.csv   # or a https:// URL (CSV/JSON)
```
Run:
```bash
npm run ingest:ma:providers
npm run ingest:wv:providers
```

You can also convert CSV → JSON yourself:
```bash
npm run csv:tojson -- ingest/data/ma_providers.csv ingest/data/ma_providers.json
```

## Output validation
The backend now asks the model to return **strict JSON** per intent and validates it with **Zod**.
- If validation fails, the API returns HTTP 422 with `issues` so you can debug quickly.
- Successful responses come back in `{ intent, data, sources }` with `data` matching the intent schema.

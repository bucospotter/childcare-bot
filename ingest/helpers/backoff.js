// helpers/backoff.js
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function jitter(base){ return Math.floor(base * (0.5 + Math.random())); }

async function fetchWithBackoff(url, { headers, tries=8, baseDelay=500 } = {}) {
    let attempt = 0;
    while (true) {
        const res = await fetch(url, { headers });
        if (res.status === 429) {
            // honor Retry-After if present
            const ra = res.headers.get('retry-after');
            const waitMs = ra ? Number(ra) * 1000 : jitter(baseDelay * Math.pow(2, attempt));
            await sleep(waitMs);
            attempt++; if (attempt >= tries) throw new Error(`429 too many retries for ${url}`);
            continue;
        }
        if (res.status === 413) { // surface to caller so it can lower limit
            const body = await res.text();
            const err = new Error(`413 payload too large: ${body.slice(0,300)}`);
            err.code = 413;
            throw err;
        }
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        return res;
    }
}
export { fetchWithBackoff };
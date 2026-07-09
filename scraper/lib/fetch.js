// Sayfa çekme: native fetch + kimliği açık UA + backoff'lu tek retry.
// HTTP status kontrolü parse'tan ÖNCE — 403/429/5xx gövdesi asla parse
// edilmez (impact: failure-modes §1.5). Politeness: gerçek bot kimliği,
// tarayıcı UA taklidi yok (research §7).

export const USER_AGENT =
  'Duesday-PriceBot/1.0 (+https://github.com/sinansener/duesday-data)';

export class FetchError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {{timeoutMs?:number, retries?:number, retryDelayMs?:number, acceptLanguage?:string}} opts
 * @returns {Promise<string>} HTML gövdesi
 */
export async function fetchPage(url, opts = {}) {
  const {
    timeoutMs = 20_000,
    retries = 1,
    retryDelayMs = 10_000,
    acceptLanguage,
  } = opts;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(retryDelayMs * attempt);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml',
          ...(acceptLanguage ? { 'accept-language': acceptLanguage } : {}),
        },
      });
      if (!res.ok) {
        lastError = new FetchError(`HTTP ${res.status} — ${url}`, {
          status: res.status,
        });
        // 4xx'te retry anlamsız (403 bot koruması ısrarla döner) — tek
        // istisna 429 (rate limit), backoff sonrası bir şans daha.
        if (res.status !== 429 && res.status < 500) throw lastError;
        continue;
      }
      return await res.text();
    } catch (e) {
      if (e instanceof FetchError && e.status !== 429 && e.status < 500) throw e;
      lastError = e instanceof FetchError ? e : new FetchError(String(e?.message ?? e));
    }
  }
  throw lastError;
}

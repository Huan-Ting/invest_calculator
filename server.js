const express = require('express');
const path = require('path');
const crypto = require('node:crypto');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const FETCH_RETRY_COUNT = Number(process.env.FETCH_RETRY_COUNT || 3);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 12 * 60 * 60 * 1000);
const ALLOWED_SYMBOLS = new Set(['0050.TW', 'QQQ', 'VTI', 'VT']);
const STOCK_CACHE_TTL_MS = Number(process.env.STOCK_CACHE_TTL_MS || 10 * 60 * 1000);
const STOCK_SYMBOL_PATTERN = /^[A-Z0-9.\-]{1,15}$/;
const ALLOWED_STOCK_SYMBOLS = new Set(['AAPL', 'MSFT', 'TSLA', 'NVDA', 'GOOG', 'PLTR', 'AMZN', 'META']);

const athCache = new Map();
const stockSnapshotCache = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const response = await fetch(url, {
    cache: 'no-store',
    signal: controller.signal,
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; invest-calculator-render/1.0)',
      accept: 'application/json,text/plain,*/*',
      'accept-language': 'en-US,en;q=0.9',
    },
  }).finally(() => {
    clearTimeout(timer);
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchJsonWithRetry(url, retries = FETCH_RETRY_COUNT) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('request failed');
}

function getMaxCloseFromYahooChart(data) {
  const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes)) {
    throw new Error('missing close history');
  }

  const maxClose = closes.reduce((max, value) => {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
      return max;
    }
    return numberValue > max ? numberValue : max;
  }, Number.NEGATIVE_INFINITY);

  if (!Number.isFinite(maxClose)) {
    throw new Error('invalid close history');
  }
  return maxClose;
}

function hashPayload(data) {
  const raw = JSON.stringify(data);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function fetchAthFromYahoo(symbol) {
  const encoded = encodeURIComponent(symbol);
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=max&interval=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?range=max&interval=1d`,
  ];

  let lastError = null;
  for (const yahooUrl of urls) {
    try {
      const data = await fetchJsonWithRetry(yahooUrl);
      const ath = getMaxCloseFromYahooChart(data);
      return {
        symbol,
        ath,
        source: `yahoo-chart-max-close:${new URL(yahooUrl).host}`,
        sourcePayloadHash: hashPayload(data),
        asOf: new Date().toISOString(),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('all yahoo upstreams failed');
}

function getOneYearHighFromYahooChart(data) {
  const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes)) {
    throw new Error('missing one year close history');
  }
  const high = closes.reduce((max, value) => {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
      return max;
    }
    return numberValue > max ? numberValue : max;
  }, Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(high)) {
    throw new Error('invalid one year close history');
  }
  return high;
}

function getCurrentPriceFromYahooChart(data) {
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;
  const metaCandidates = [
    meta?.regularMarketPrice,
    meta?.previousClose,
    meta?.chartPreviousClose,
  ];
  for (const candidate of metaCandidates) {
    const numberValue = Number(candidate);
    if (Number.isFinite(numberValue)) {
      return numberValue;
    }
  }

  const closes = result?.indicators?.quote?.[0]?.close;
  if (Array.isArray(closes)) {
    for (let i = closes.length - 1; i >= 0; i -= 1) {
      const numberValue = Number(closes[i]);
      if (Number.isFinite(numberValue)) {
        return numberValue;
      }
    }
  }
  throw new Error('missing current price from chart');
}

function isValidStockSymbol(symbol) {
  return STOCK_SYMBOL_PATTERN.test(symbol);
}

async function fetchStockSnapshotFromYahoo(symbol) {
  const encoded = encodeURIComponent(symbol);
  const chartUrls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=1y&interval=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?range=1y&interval=1d`,
  ];

  let chartPayload = null;
  let lastError = null;

  for (const chartUrl of chartUrls) {
    try {
      chartPayload = await fetchJsonWithRetry(chartUrl);
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!chartPayload) {
    throw lastError || new Error('stock upstream unavailable');
  }

  const yearHigh = getOneYearHighFromYahooChart(chartPayload);
  const currentPrice = getCurrentPriceFromYahooChart(chartPayload);
  return {
    symbol,
    yearHigh,
    currentPrice,
    source: 'yahoo-chart-1y',
    asOf: new Date().toISOString(),
    sourcePayloadHash: hashPayload(chartPayload),
  };
}

function sendError(res, status, code, message) {
  res.status(status).json({
    error: {
      code,
      message,
    },
  });
}

function isCacheFresh(entry) {
  if (!entry || typeof entry.fetchedAtMs !== 'number') {
    return false;
  }
  return Date.now() - entry.fetchedAtMs < CACHE_TTL_MS;
}

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/api/ath', async (req, res) => {
  const symbolRaw = typeof req.query.symbol === 'string' ? req.query.symbol : '';
  const symbol = symbolRaw.trim().toUpperCase();

  if (!ALLOWED_SYMBOLS.has(symbol)) {
    return sendError(res, 400, 'INVALID_SYMBOL', 'Unsupported symbol');
  }

  const cached = athCache.get(symbol);
  if (isCacheFresh(cached) && Number.isFinite(cached.ath)) {
    return res.status(200).json({
      symbol,
      ath: cached.ath,
      source: cached.source,
      asOf: cached.asOf,
      cached: true,
    });
  }

  try {
    const upstream = await fetchAthFromYahoo(symbol);
    athCache.set(symbol, {
      ...upstream,
      fetchedAtMs: Date.now(),
    });

    return res.status(200).json({
      symbol,
      ath: upstream.ath,
      source: upstream.source,
      asOf: upstream.asOf,
      cached: false,
    });
  } catch (error) {
    console.error('[/api/ath] upstream failed', {
      symbol,
      message: error?.message || 'unknown error',
    });
    return sendError(res, 502, 'UPSTREAM_ERROR', 'Failed to fetch upstream history');
  }
});

app.get('/api/stock', async (req, res) => {
  const symbolRaw = typeof req.query.symbol === 'string' ? req.query.symbol : '';
  const symbol = symbolRaw.trim().toUpperCase();

  if (!isValidStockSymbol(symbol) || !ALLOWED_STOCK_SYMBOLS.has(symbol)) {
    return sendError(res, 400, 'INVALID_SYMBOL', 'Unsupported symbol');
  }

  const cached = stockSnapshotCache.get(symbol);
  const isFresh = cached && typeof cached.fetchedAtMs === 'number'
    && Date.now() - cached.fetchedAtMs < STOCK_CACHE_TTL_MS;
  if (isFresh) {
    return res.status(200).json({
      symbol,
      yearHigh: cached.yearHigh,
      currentPrice: cached.currentPrice,
      growthRate: cached.yearHigh === 0 ? 0 : ((cached.currentPrice - cached.yearHigh) / cached.yearHigh) * 100,
      source: cached.source,
      asOf: cached.asOf,
      cached: true,
    });
  }

  try {
    const upstream = await fetchStockSnapshotFromYahoo(symbol);
    stockSnapshotCache.set(symbol, {
      ...upstream,
      fetchedAtMs: Date.now(),
    });
    return res.status(200).json({
      symbol,
      yearHigh: upstream.yearHigh,
      currentPrice: upstream.currentPrice,
      growthRate: upstream.yearHigh === 0 ? 0 : ((upstream.currentPrice - upstream.yearHigh) / upstream.yearHigh) * 100,
      source: upstream.source,
      asOf: upstream.asOf,
      cached: false,
    });
  } catch (error) {
    console.error('[/api/stock] upstream failed', {
      symbol,
      message: error?.message || 'unknown error',
    });
    return sendError(res, 502, 'UPSTREAM_ERROR', 'Failed to fetch stock data');
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`invest_calculator_render listening on port ${PORT}`);
});

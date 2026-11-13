'use strict';

const https = require('https');

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const MAX_MESSAGE_LEN = 3900;

// Persistent Keep-Alive Agent (90s LIFO) so button clicks reuse warm TLS sockets to api.telegram.org
// with 0ms DNS/TCP/TLS handshake latency even when clicks are separated by >4 seconds.
const telegramKeepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 90000,
  maxSockets: 32,
  maxFreeSockets: 16,
  scheduling: 'lifo',
  timeout: 60000
});

const answeredCallbacksCache = new Map();

function markCallbackAnswered(callbackQueryId) {
  if (!callbackQueryId) return false;
  const key = String(callbackQueryId);
  const now = Date.now();
  const prev = answeredCallbacksCache.get(key);
  if (prev && (now - prev) < 30000) {
    return false; // Already answered
  }
  answeredCallbacksCache.set(key, now);
  if (answeredCallbacksCache.size > 500) {
    for (const [k, ts] of answeredCallbacksCache.entries()) {
      if (now - ts > 30000) answeredCallbacksCache.delete(k);
    }
  }
  return true;
}

function postHttpsKeepAlive(urlStr, bodyStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const bodyBuf = Buffer.from(bodyStr, 'utf8');
    const req = https.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        agent: telegramKeepAliveAgent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuf.length,
          'Connection': 'keep-alive'
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode || 500,
            json: async () => JSON.parse(text || '{}')
          });
        });
      }
    );
    req.on('timeout', () => {
      const err = new Error('Request timed out');
      err.name = 'AbortError';
      req.destroy(err);
    });
    req.on('error', (err) => reject(err));
    req.write(bodyBuf);
    req.end();
  });
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function stripTelegramMarkup(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`#]/g, '');
}

function splitTextTelegramSafe(text, maxLen = MAX_MESSAGE_LEN) {
  const str = String(text || '');
  if (!str) return [];
  if (str.length <= maxLen) return [str];

  const chunks = [];
  let remaining = str;

  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx < Math.floor(maxLen * 0.4)) {
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitIdx < Math.floor(maxLen * 0.4)) {
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx <= 0) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

function isParseError(statusCode, description) {
  return statusCode === 400 && /can't parse|entities|parse error|entity|unsupported|unmatched/i.test(String(description || ''));
}

function isNotModifiedError(statusCode, description) {
  return statusCode === 400 && /message is not modified/i.test(String(description || ''));
}

async function postTelegramMethodAsync(token, method, payload, options = {}) {
  if (!token || !method) {
    return { ok: false, statusCode: 400, description: 'Missing token or method' };
  }

  const customFetch = options.fetchImpl || null;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
  const maxRetries429 = Number.isFinite(options.maxRetries429) ? options.maxRetries429 : 1;
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;

  let attemptBody = { ...(payload || {}) };
  let triedPlainFallback = false;
  let retries429 = 0;

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const bodyStr = JSON.stringify(attemptBody);
      const res = customFetch
        ? await customFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Connection': 'keep-alive' },
            body: bodyStr,
            signal: controller.signal
          })
        : await postHttpsKeepAlive(url, bodyStr, timeoutMs);
      clearTimeout(timer);

      let data = null;
      try {
        data = await res.json();
      } catch (_) {
        data = null;
      }

      const description = (data && data.description) ? String(data.description) : '';
      if (res.ok && (!data || data.ok !== false)) {
        return { ok: true, statusCode: res.status, result: data ? data.result : true };
      }

      if (isNotModifiedError(res.status, description)) {
        return { ok: true, statusCode: 200, notModified: true };
      }

      if (res.status === 429 && retries429 < maxRetries429) {
        const retryAfterSec = Math.min(3, Math.max(1, Number(data?.parameters?.retry_after) || 1));
        retries429 += 1;
        await sleepAsync(retryAfterSec * 1000);
        continue;
      }

      if (!triedPlainFallback && isParseError(res.status, description) && attemptBody.parse_mode) {
        triedPlainFallback = true;
        const { parse_mode: _ignored, ...rest } = attemptBody;
        if (rest.text) rest.text = stripTelegramMarkup(rest.text);
        if (rest.caption) rest.caption = stripTelegramMarkup(rest.caption);
        attemptBody = rest;
        continue;
      }

      return { ok: false, statusCode: res.status, description, data };
    } catch (err) {
      clearTimeout(timer);
      return {
        ok: false,
        statusCode: err && err.name === 'AbortError' ? 504 : 500,
        description: err ? err.message : 'Network error'
      };
    }
  }
}

async function answerCallbackQueryFast(token, callbackQueryId, text = '', showAlert = false, options = {}) {
  if (!token || !callbackQueryId) return { ok: false, skipped: true };
  if (!options.fetchImpl && !markCallbackAnswered(callbackQueryId)) {
    return { ok: true, statusCode: 200, deduplicated: true };
  }
  return postTelegramMethodAsync(
    token,
    'answerCallbackQuery',
    {
      callback_query_id: String(callbackQueryId),
      text: String(text || '').slice(0, 200),
      show_alert: Boolean(showAlert)
    },
    { timeoutMs: options.timeoutMs || 2500, maxRetries429: 0, fetchImpl: options.fetchImpl }
  );
}

async function sendChatActionFast(token, chatId, action = 'typing', options = {}) {
  if (!token || !chatId) return { ok: false, skipped: true };
  return postTelegramMethodAsync(
    token,
    'sendChatAction',
    { chat_id: chatId, action: action || 'typing' },
    { timeoutMs: options.timeoutMs || 2500, maxRetries429: 0, fetchImpl: options.fetchImpl }
  );
}

async function sendMessageChunked(token, chatId, text, options = {}) {
  const chunks = splitTextTelegramSafe(text, options.maxLen || MAX_MESSAGE_LEN);
  if (chunks.length === 0) return { ok: false, results: [] };

  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    let chunkText = chunks[i];
    if (chunks.length > 1) {
      const prefix = !isFirst ? `📄 _[Parte ${i + 1}/${chunks.length} · Continuação]_\n\n` : '';
      const suffix = !isLast ? `\n\n📄 _[Parte ${i + 1}/${chunks.length} · Continua abaixo ⬇️]_` : '';
      chunkText = `${prefix}${chunkText}${suffix}`;
    }
    const payload = {
      chat_id: chatId,
      text: chunkText
    };
    if (options.parseMode) payload.parse_mode = options.parseMode;
    if (isLast && options.replyMarkup) payload.reply_markup = options.replyMarkup;

    const res = await postTelegramMethodAsync(token, 'sendMessage', payload, options);
    results.push(res);
    if (!res.ok) {
      return { ok: false, results };
    }
  }
  return { ok: true, results };
}

async function editMessageInPlace(token, chatId, messageId, text, options = {}) {
  const str = String(text || '');
  if (!messageId || str.length > (options.maxEditLen || MAX_MESSAGE_LEN)) {
    return sendMessageChunked(token, chatId, str, options);
  }

  const payload = {
    chat_id: chatId,
    message_id: Number(messageId),
    text: str
  };
  if (options.parseMode) payload.parse_mode = options.parseMode;
  if (options.replyMarkup) payload.reply_markup = options.replyMarkup;

  const editRes = await postTelegramMethodAsync(token, 'editMessageText', payload, options);
  if (editRes.ok) {
    return { ...editRes, edited: true };
  }

  if (options.fallbackToSend !== false) {
    const sendRes = await sendMessageChunked(token, chatId, str, options);
    return { ...sendRes, edited: false, fallbackSent: sendRes.ok };
  }
  return editRes;
}

class PerChatAsyncQueue {
  constructor(options = {}) {
    this.maxQueuePerChat = options.maxQueuePerChat || 30;
    this.maxGlobalPending = options.maxGlobalPending || 100;
    this.chains = new Map();
    this.pendingCount = 0;
  }

  getTotalPending() {
    return this.pendingCount;
  }

  enqueue(chatId, handler, meta = {}) {
    const key = String(chatId || 'default');
    if (this.pendingCount >= this.maxGlobalPending) {
      return { accepted: false, reason: 'global_queue_full' };
    }

    if (meta.fastLane === true) {
      this.pendingCount += 1;
      const fastPromise = Promise.resolve()
        .then(() => handler())
        .finally(() => {
          this.pendingCount = Math.max(0, this.pendingCount - 1);
        });
      return { accepted: true, fastLane: true, promise: fastPromise };
    }

    const prev = this.chains.get(key) || Promise.resolve();
    this.pendingCount += 1;

    const next = prev
      .catch(() => {})
      .then(() => handler())
      .finally(() => {
        this.pendingCount = Math.max(0, this.pendingCount - 1);
        if (this.chains.get(key) === next) {
          this.chains.delete(key);
        }
      });

    this.chains.set(key, next);
    return { accepted: true, fastLane: false, promise: next };
  }
}

function dispatchTelegramFastFromVm(url, options = {}) {
  if (!url || typeof url !== 'string' || options.syncResponse === true) {
    return null;
  }
  const match = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/(answerCallbackQuery|sendChatAction|editMessageText|editMessageReplyMarkup|deleteMessage|sendMessage)$/);
  if (!match) {
    return null;
  }

  const token = match[1];
  const tgMethod = match[2];
  let payload = {};
  if (options.payload) {
    if (typeof options.payload === 'string') {
      try {
        payload = JSON.parse(options.payload);
      } catch (_) {
        return null;
      }
    } else if (typeof options.payload === 'object' && !Buffer.isBuffer(options.payload)) {
      payload = options.payload;
    } else {
      return null;
    }
  }

  if (tgMethod === 'answerCallbackQuery') {
    setImmediate(() => {
      answerCallbackQueryFast(token, payload.callback_query_id, payload.text || '', Boolean(payload.show_alert), { fetchImpl: options.fetchImpl }).catch(() => {});
    });
  } else if (tgMethod === 'sendChatAction') {
    setImmediate(() => {
      sendChatActionFast(token, payload.chat_id, payload.action || 'typing', { fetchImpl: options.fetchImpl }).catch(() => {});
    });
  } else if (tgMethod === 'editMessageText') {
    queueMicrotask(() => {
      editMessageInPlace(token, payload.chat_id, payload.message_id, payload.text, {
        parseMode: payload.parse_mode,
        replyMarkup: payload.reply_markup,
        fallbackToSend: true,
        fetchImpl: options.fetchImpl
      }).catch(() => {});
    });
  } else {
    queueMicrotask(() => {
      postTelegramMethodAsync(token, tgMethod, payload, { fetchImpl: options.fetchImpl }).catch(() => {});
    });
  }

  const syntheticBody = JSON.stringify({
    ok: true,
    result: tgMethod === 'answerCallbackQuery' || tgMethod === 'sendChatAction' || tgMethod === 'deleteMessage'
      ? true
      : { message_id: Number(payload.message_id) || 1 }
  });

  return {
    getResponseCode: () => 200,
    getContentText: () => syntheticBody,
    getHeaders: () => ({ 'content-type': 'application/json' }),
    getBlob: () => ({
      getBytes: () => Buffer.from(syntheticBody),
      getContentType: () => 'application/json',
      getName: () => 'telegram_fast'
    })
  };
}

module.exports = {
  TELEGRAM_API_BASE,
  MAX_MESSAGE_LEN,
  stripTelegramMarkup,
  splitTextTelegramSafe,
  postTelegramMethodAsync,
  answerCallbackQueryFast,
  sendChatActionFast,
  sendMessageChunked,
  editMessageInPlace,
  dispatchTelegramFastFromVm,
  PerChatAsyncQueue
};


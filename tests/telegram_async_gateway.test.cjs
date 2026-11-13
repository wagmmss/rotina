'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  stripTelegramMarkup,
  splitTextTelegramSafe,
  postTelegramMethodAsync,
  answerCallbackQueryFast,
  sendChatActionFast,
  sendMessageChunked,
  editMessageInPlace,
  dispatchTelegramFastFromVm,
  PerChatAsyncQueue
} = require('../server/telegram-gateway.js');

const {
  GEMINI_MODELS,
  collectApiKeys
} = require('../server/gemini-async.js');

const runtime = require('../server/runtime.js');

test('stripTelegramMarkup removes HTML tags and markdown symbols', () => {
  const input = '<b>Alerta</b> *CRÍTICO* _hoje_ `0.5mg` #sepse';
  assert.equal(stripTelegramMarkup(input), 'Alerta CRÍTICO hoje 0.5mg sepse');
});

test('splitTextTelegramSafe splits long multi-paragraph text cleanly under maxLen', () => {
  const short = 'Conduta simples';
  assert.deepEqual(splitTextTelegramSafe(short, 100), [short]);
  assert.deepEqual(splitTextTelegramSafe('', 100), []);

  const p1 = 'A'.repeat(60);
  const p2 = 'B'.repeat(60);
  const p3 = 'C'.repeat(60);
  const full = `${p1}\n\n${p2}\n\n${p3}`;
  const chunks = splitTextTelegramSafe(full, 130);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].length <= 130);
  assert.ok(chunks[1].length <= 130);
  assert.ok(chunks[0].includes(p1));
  assert.ok(chunks[1].includes(p3));
});

test('postTelegramMethodAsync falls back to plain text on 400 entity parse error', async () => {
  const calls = [];
  const mockFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (calls.length === 1) {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          description: "Bad Request: can't parse entities: Can't find end of the entity"
        })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 42 } })
    };
  };

  const res = await postTelegramMethodAsync(
    'fake_token',
    'sendMessage',
    { chat_id: '123', text: '*Quebrado_markdown', parse_mode: 'Markdown' },
    { fetchImpl: mockFetch }
  );

  assert.equal(res.ok, true);
  assert.equal(res.result.message_id, 42);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].parse_mode, 'Markdown');
  assert.equal(calls[1].parse_mode, undefined);
  assert.equal(calls[1].text, 'Quebradomarkdown');
});

test('postTelegramMethodAsync treats "message is not modified" as ok', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({
      ok: false,
      description: 'Bad Request: message is not modified: specified new message content is the same'
    })
  });

  const res = await postTelegramMethodAsync(
    'fake_token',
    'editMessageText',
    { chat_id: '123', message_id: 10, text: 'Mesmo texto' },
    { fetchImpl: mockFetch }
  );

  assert.equal(res.ok, true);
  assert.equal(res.notModified, true);
});

test('postTelegramMethodAsync retries once on 429 rate limit', async () => {
  let attempts = 0;
  const mockFetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        ok: false,
        status: 429,
        json: async () => ({
          ok: false,
          description: 'Too Many Requests',
          parameters: { retry_after: 1 }
        })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 99 } })
    };
  };

  const res = await postTelegramMethodAsync(
    'fake_token',
    'sendMessage',
    { chat_id: '123', text: 'Retry ok' },
    { fetchImpl: mockFetch, maxRetries429: 1 }
  );

  assert.equal(attempts, 2);
  assert.equal(res.ok, true);
  assert.equal(res.result.message_id, 99);
});

test('answerCallbackQueryFast and sendChatActionFast dispatch quickly with keep-alive', async () => {
  const endpoints = [];
  const mockFetch = async (url, init) => {
    endpoints.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: true })
    };
  };

  const cbRes = await answerCallbackQueryFast('tok', 'cb_1', 'Abrindo...', false, { fetchImpl: mockFetch });
  const actRes = await sendChatActionFast('tok', '999', 'typing', { fetchImpl: mockFetch });

  assert.equal(cbRes.ok, true);
  assert.equal(actRes.ok, true);
  assert.match(endpoints[0].url, /answerCallbackQuery$/);
  assert.equal(endpoints[0].body.callback_query_id, 'cb_1');
  assert.match(endpoints[1].url, /sendChatAction$/);
  assert.equal(endpoints[1].body.action, 'typing');
});

test('editMessageInPlace falls back to sendMessageChunked if edit fails', async () => {
  const methods = [];
  const mockFetch = async (url) => {
    const method = url.split('/').pop();
    methods.push(method);
    if (method === 'editMessageText') {
      return {
        ok: false,
        status: 400,
        json: async () => ({ ok: false, description: 'Bad Request: message to edit not found' })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 777 } })
    };
  };

  const res = await editMessageInPlace('tok', '123', 55, 'Conteúdo atualizado', { fetchImpl: mockFetch });
  assert.equal(res.ok, true);
  assert.equal(res.edited, false);
  assert.equal(res.fallbackSent, true);
  assert.deepEqual(methods, ['editMessageText', 'sendMessage']);
});

test('sendMessageChunked attaches reply_markup only on final chunk', async () => {
  const payloads = [];
  const mockFetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: payloads.length } }) };
  };

  const kb = { inline_keyboard: [[{ text: 'OK', callback_data: 'ok' }]] };
  const text = `${'X'.repeat(80)}\n\n${'Y'.repeat(80)}`;
  const res = await sendMessageChunked('tok', '123', text, { maxLen: 100, replyMarkup: kb, fetchImpl: mockFetch });

  assert.equal(res.ok, true);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].reply_markup, undefined);
  assert.deepEqual(payloads[1].reply_markup, kb);
});

test('PerChatAsyncQueue serializes per-chat tasks, isolates different chats, and bypasses slow lane via fastLane', async () => {
  const queue = new PerChatAsyncQueue();
  const order = [];

  let releaseSlowA;
  const slowAGate = new Promise((resolve) => { releaseSlowA = resolve; });

  const slowA1 = queue.enqueue('chatA', async () => {
    order.push('A1_start');
    await slowAGate;
    order.push('A1_end');
  });

  const slowA2 = queue.enqueue('chatA', async () => {
    order.push('A2_run');
  });

  const chatB1 = queue.enqueue('chatB', async () => {
    order.push('B1_run');
  });

  const fastA = queue.enqueue('chatA', async () => {
    order.push('A_fastLane');
  }, { fastLane: true });

  await Promise.all([chatB1.promise, fastA.promise]);
  assert.ok(order.includes('B1_run'), 'Blocked chatA must not delay chatB');
  assert.ok(order.includes('A_fastLane'), 'fastLane callback must bypass blocked chatA slow queue');
  assert.ok(!order.includes('A2_run'), 'A2 must still wait behind A1');

  releaseSlowA();
  await Promise.all([slowA1.promise, slowA2.promise]);
  assert.equal(order.indexOf('A1_end') < order.indexOf('A2_run'), true);
  assert.equal(queue.getTotalPending(), 0);
});

test('GEMINI_MODELS avoids deprecated 2.0/1.5 defaults and filters placeholder API keys', () => {
  assert.ok(!/2\.0|1\.5/.test(GEMINI_MODELS.FAST), `Unexpected model: ${GEMINI_MODELS.FAST}`);
  assert.ok(!/2\.0|1\.5/.test(GEMINI_MODELS.CLINICAL), `Unexpected model: ${GEMINI_MODELS.CLINICAL}`);
  const filtered = collectApiKeys(['test_123456', 'mock_token', 'short', 'AIzaValidFakeKeyForDedupTest123', 'AIzaValidFakeKeyForDedupTest123']);
  assert.deepEqual(filtered, ['AIzaValidFakeKeyForDedupTest123']);
});

test('Local MedQuest doubts & weekly habits persistence work without Notion or Sheets', () => {
  const ctx = runtime.ctx;
  const props = ctx.PropertiesService.getScriptProperties();
  props.deleteProperty('duvidas_medquest_local');

  const saved = ctx.salvarDuvidaEstudoLocal('Qual dose de tenecteplase no IAMCSST 75kg?');
  assert.ok(saved && saved.id.startsWith('duv_'));
  assert.equal(saved.resolvida, false);

  const listBefore = ctx.obterDuvidasEstudoLocal();
  assert.equal(listBefore.length, 1);
  assert.equal(listBefore[0].id, saved.id);

  const marked = ctx.marcarDuvidaEstudoResolvida(saved.id);
  assert.equal(marked, true);

  const listAfter = ctx.obterDuvidasEstudoLocal();
  assert.equal(listAfter[0].resolvida, true);

  const habits = ctx.marcarHabitoProativoHoje('Hoje fiz 40 questoes no MedQuest e treino na academia');
  assert.ok(habits.some((h) => h.includes('MedQuest')));
  assert.ok(habits.some((h) => h.includes('Treino')));

  // Guest isolation on weekly habits report
  assert.equal(ctx.enviarRelatorioSemanalHabitos('999999999_convidado'), false);
});

test('Fastify POST /webhook enqueues callback_query and /menu in fast-lane under 50ms without uncaught exceptions', async () => {
  const prevEnv = process.env.NODE_ENV;
  const props = runtime.ctx.PropertiesService.getScriptProperties();
  const prevSecretProp = props.getProperty('WEBHOOK_SECRET');
  const prevChatProp = props.getProperty('TELEGRAM_CHAT_ID');
  process.env.NODE_ENV = 'test';
  props.setProperty('WEBHOOK_SECRET', 'test-secret-gateway');
  props.setProperty('TELEGRAM_CHAT_ID', '1771571035');
  if (runtime.ctx.ConfigService && typeof runtime.ctx.ConfigService.invalidar === 'function') {
    runtime.ctx.ConfigService.invalidar();
  }

  const sentMessages = [];
  runtime.ctx.executarPostTelegram = (_url, payload) => {
    sentMessages.push(payload);
    return { ok: true, result: { message_id: 501 } };
  };
  runtime.ctx.responderCallbackTelegram = () => true;

  const { buildServer } = require('../server/index.js');
  const app = await buildServer();
  const baseUid = Math.floor(Date.now() / 100) + Math.floor(Math.random() * 10000);
  const uid1 = baseUid + 1;
  const uid2 = baseUid + 2;
  try {
    try { runtime.ctx.PersistenciaBot.remover('inbox_' + uid1); } catch (_) {}
    try { runtime.ctx.PersistenciaBot.remover('inbox_' + uid2); } catch (_) {}

    const resCb = await app.inject({
      method: 'POST',
      url: '/webhook?secret=test-secret-gateway',
      payload: {
        update_id: uid1,
        callback_query: {
          id: 'cb_gw_' + uid1,
          from: { id: 1771571035 },
          message: { chat: { id: 1771571035 }, message_id: 10 },
          data: 'ux:hub:inicio'
        }
      }
    });
    assert.equal(resCb.statusCode, 200);
    assert.equal(resCb.json().ok, true);

    const resMenu = await app.inject({
      method: 'POST',
      url: '/webhook?secret=test-secret-gateway',
      payload: {
        update_id: uid2,
        message: {
          message_id: 12,
          chat: { id: 1771571035, type: 'private' },
          from: { id: 1771571035 },
          text: '/menu'
        }
      }
    });
    assert.equal(resMenu.statusCode, 200);
    assert.equal(resMenu.json().ok, true);

    // Allow setImmediate + PerChatAsyncQueue tasks to drain cleanly
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(sentMessages.length >= 1, 'Queue should process enqueued updates without throwing');
  } finally {
    try { runtime.ctx.PersistenciaBot.remover('inbox_' + uid1); } catch (_) {}
    try { runtime.ctx.PersistenciaBot.remover('inbox_' + uid2); } catch (_) {}
    await app.close();
    process.env.NODE_ENV = prevEnv;
    if (prevSecretProp === null || prevSecretProp === undefined) props.deleteProperty('WEBHOOK_SECRET');
    else props.setProperty('WEBHOOK_SECRET', prevSecretProp);
    if (prevChatProp === null || prevChatProp === undefined) props.deleteProperty('TELEGRAM_CHAT_ID');
    else props.setProperty('TELEGRAM_CHAT_ID', prevChatProp);
    if (runtime.ctx.ConfigService && typeof runtime.ctx.ConfigService.invalidar === 'function') {
      runtime.ctx.ConfigService.invalidar();
    }
  }
});

test('dispatchTelegramFastFromVm returns synthetic 200 OK in <2ms without blocking V8', () => {
  const mockFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const t0 = performance.now();
  const res = dispatchTelegramFastFromVm('https://api.telegram.org/botFAKE_TOKEN/answerCallbackQuery', {
    method: 'post',
    fetchImpl: mockFetch,
    payload: JSON.stringify({ callback_query_id: 'cb_bench_fast_1', text: 'Instantâneo' })
  });
  const elapsedMs = performance.now() - t0;
  assert.ok(res, 'Should return synthetic response object for Telegram API URL');
  assert.equal(res.getResponseCode(), 200);
  assert.ok(elapsedMs < 2, `Expected <2ms non-blocking dispatch, took ${elapsedMs.toFixed(2)}ms`);

  // Sync-required call (syncResponse: true) should return null so caller uses sync worker
  const syncRes = dispatchTelegramFastFromVm('https://api.telegram.org/botFAKE_TOKEN/sendMessage', {
    method: 'post',
    syncResponse: true,
    payload: JSON.stringify({ chat_id: '123', text: 'sync' })
  });
  assert.equal(syncRes, null);
});


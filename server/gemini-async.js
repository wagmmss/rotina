'use strict';

const { GoogleGenAI, ThinkingLevel } = require('@google/genai');

const GEMINI_MODELS = Object.freeze({
  FAST: process.env.GEMINI_MODEL_FAST || 'gemini-4-hydrogen',
  CLINICAL: process.env.GEMINI_MODEL_CLINICAL || 'gemini-4-argon',
  TRANSCRIBE: process.env.GEMINI_MODEL_TRANSCRIBE || 'gemini-3.5-transcribe',
  TTS: process.env.GEMINI_MODEL_TTS || 'gemini-3.8-flash-lite-tts'
});

let roundRobinIndex = 0;

function collectApiKeys(extraKeys = []) {
  const keys = [];
  if (Array.isArray(extraKeys)) keys.push(...extraKeys);
  if (process.env.GEMINI_API_KEYS) {
    keys.push(...String(process.env.GEMINI_API_KEYS).split(',').map((s) => s.trim()));
  }
  if (process.env.GEMINI_API_KEY) {
    keys.push(String(process.env.GEMINI_API_KEY).trim());
  }
  return [...new Set(keys.filter((k) => k && k.length > 5 && !k.startsWith('test_') && k !== 'mock_token'))];
}

function nextApiKey(keys) {
  if (!keys || keys.length === 0) return null;
  const idx = roundRobinIndex % keys.length;
  roundRobinIndex = (roundRobinIndex + 1) % keys.length;
  return keys[idx];
}

function withTimeout(promise, timeoutMs, label = 'Gemini request') {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout após ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function generateTextAsync({
  prompt,
  systemInstruction = '',
  model = GEMINI_MODELS.FAST,
  thinkingLevel = ThinkingLevel.LOW,
  temperature = 0.15,
  maxOutputTokens = 2048,
  timeoutMs = 15000,
  apiKeys = []
}) {
  const keys = collectApiKeys(apiKeys);
  if (keys.length === 0) {
    throw new Error('Nenhuma GEMINI_API_KEY válida configurada.');
  }

  let lastError = null;
  const maxAttempts = Math.min(keys.length, 3);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const apiKey = nextApiKey(keys);
    const ai = new GoogleGenAI({ apiKey });
    try {
      const config = {
        temperature,
        maxOutputTokens
      };
      if (systemInstruction) {
        config.systemInstruction = systemInstruction;
      }
      if (thinkingLevel && (String(model).includes('gemini-4') || String(model).includes('gemini-3'))) {
        config.thinkingConfig = { thinkingLevel };
      }

      const response = await withTimeout(
        ai.models.generateContent({
          model,
          contents: String(prompt || ''),
          config
        }),
        timeoutMs,
        `generateTextAsync(${model})`
      );

      const text = response && response.text ? String(response.text).trim() : '';
      if (!text) {
        throw new Error(`Resposta vazia do modelo ${model}`);
      }
      return { ok: true, text, model };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Falha ao gerar texto via @google/genai');
}

async function transcribeAudioAsync({
  base64Audio,
  mimeType = 'audio/ogg',
  prompt = 'Transcreva fielmente o áudio clínico em português do Brasil.',
  model = GEMINI_MODELS.TRANSCRIBE,
  timeoutMs = 20000,
  apiKeys = []
}) {
  const keys = collectApiKeys(apiKeys);
  if (keys.length === 0) {
    throw new Error('Nenhuma GEMINI_API_KEY válida configurada.');
  }
  const apiKey = nextApiKey(keys);
  const ai = new GoogleGenAI({ apiKey });

  const response = await withTimeout(
    ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { data: base64Audio, mimeType } },
            { text: prompt }
          ]
        }
      ]
    }),
    timeoutMs,
    `transcribeAudioAsync(${model})`
  );

  const text = response && response.text ? String(response.text).trim() : '';
  return { ok: Boolean(text), text, model };
}

async function synthesizeSpeechAsync({
  text,
  voiceName = 'Fenrir',
  model = GEMINI_MODELS.TTS,
  timeoutMs = 20000,
  apiKeys = []
}) {
  const keys = collectApiKeys(apiKeys);
  if (keys.length === 0) {
    throw new Error('Nenhuma GEMINI_API_KEY válida configurada.');
  }
  const apiKey = nextApiKey(keys);
  const ai = new GoogleGenAI({ apiKey });

  const response = await withTimeout(
    ai.models.generateContent({
      model,
      contents: String(text || ''),
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName }
          }
        }
      }
    }),
    timeoutMs,
    `synthesizeSpeechAsync(${model})`
  );

  const parts = response?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData && part.inlineData.data) {
      return {
        ok: true,
        base64Audio: part.inlineData.data,
        mimeType: part.inlineData.mimeType || 'audio/wav',
        model
      };
    }
  }
  return { ok: false, base64Audio: null, mimeType: null, model };
}

module.exports = {
  GEMINI_MODELS,
  collectApiKeys,
  generateTextAsync,
  transcribeAudioAsync,
  synthesizeSpeechAsync
};

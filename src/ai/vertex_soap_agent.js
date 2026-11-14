const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const { VertexSoapOutputSchema } = require('../clinical/schemas/soap.schema.js');

const DEFAULT_PROJECT_ID = 'gen-lang-client-0798056953';
const DEFAULT_LOCATION = process.env.VERTEX_LOCATION || 'global';
const DEFAULT_MODEL = process.env.VERTEX_MODEL || 'gemini-4-argon';
const FALLBACK_MODEL = process.env.VERTEX_FALLBACK_MODEL || 'gemini-4-hydrogen';
const REQUEST_TIMEOUT_MS = 30000;

let cachedToken = null;
let tokenExpirationTime = 0;
let cachedCredentials = null;

/**
 * Localiza e carrega o arquivo de credenciais da Service Account do Google Cloud.
 */
function loadCredentials() {
  if (cachedCredentials) {
    return cachedCredentials;
  }

  const candidatePaths = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    path.join(os.homedir(), '.gemini', 'config', 'vertex-key.json'),
    path.resolve(process.cwd(), 'google-credentials.json'),
    path.resolve(process.cwd(), 'vertex-key.json')
  ].filter(Boolean);

  for (const credPath of candidatePaths) {
    try {
      if (fs.existsSync(credPath)) {
        const raw = fs.readFileSync(credPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.client_email && parsed.private_key) {
          cachedCredentials = parsed;
          return cachedCredentials;
        }
      }
    } catch (err) {
      // Continua tentando os próximos caminhos válidos
    }
  }

  throw new Error(
    'Credenciais Vertex AI não encontradas. Configure GOOGLE_APPLICATION_CREDENTIALS ou ~/.gemini/config/vertex-key.json.'
  );
}

function tryLoadCredentials() {
  try {
    return loadCredentials();
  } catch (_) {
    return null;
  }
}

function getConfiguredGeminiApiKey() {
  const raw = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '';
  if (!raw || typeof raw !== 'string') return '';
  return raw.split(',')[0].trim();
}

/**
 * Codifica buffer ou string para Base64URL.
 */
function base64UrlEncode(input) {
  const base64 = Buffer.isBuffer(input)
    ? input.toString('base64')
    : Buffer.from(input, 'utf8').toString('base64');
  return base64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Realiza chamadas HTTPS nativas com suporte a Timeout rigoroso.
 */
function httpsRequest(url, options, bodyString) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        responseBody += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ statusCode: res.statusCode, body: responseBody });
        } else {
          const error = new Error(`HTTP Error ${res.statusCode}: ${responseBody}`);
          error.statusCode = res.statusCode;
          error.responseBody = responseBody;
          reject(error);
        }
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timeout após ${REQUEST_TIMEOUT_MS}ms para ${url}`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (bodyString) {
      req.write(bodyString);
    }
    req.end();
  });
}

/**
 * Obtém um token OAuth2 válido para a Vertex AI utilizando assinatura RSA-SHA256 e cache em memória.
 */
async function getAccessToken() {
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (cachedToken && nowSeconds < tokenExpirationTime - 120) {
    return cachedToken;
  }

  const credentials = loadCredentials();
  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };

  const exp = nowSeconds + 3600;
  const payload = {
    iss: credentials.client_email,
    sub: credentials.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: exp,
    scope: 'https://www.googleapis.com/auth/cloud-platform'
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedToken);
  signer.end();

  const signature = signer.sign(credentials.private_key);
  const encodedSignature = base64UrlEncode(signature);
  const jwt = `${unsignedToken}.${encodedSignature}`;

  const postData = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt
  }).toString();

  const response = await httpsRequest(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    },
    postData
  );

  const tokenData = JSON.parse(response.body);
  if (!tokenData.access_token) {
    throw new Error('Falha ao obter access_token na resposta OAuth2 do Google.');
  }

  cachedToken = tokenData.access_token;
  tokenExpirationTime = nowSeconds + (tokenData.expires_in || 3600);

  return cachedToken;
}

/**
 * Constrói o System Prompt Clínico Mestre do Preceptor Sênior.
 */
function buildClinicalSystemPrompt() {
  return `Você é um Preceptor Sênior de Clínica Médica, Medicina de Família e Comunidade e Medicina de Emergência atuando no Brasil.
Sua função é estruturar notas clínicas no formato SOAP (Subjetivo, Objetivo, Avaliação e Plano) de altíssimo rigor técnico a partir de relatos livres (brain dump), sinais vitais e métricas clínicas calculadas.

DIRETRIZES CLÍNICAS E SEMIOLÓGICAS OBRIGATÓRIAS:
1. TRADUÇÃO SEMIOLÓGICA TÉCNICA:
   - Converta expressões coloquiais ou leigas para terminologia médica semiológica precisa no Subjetivo (ex.: "dor no peito em queimação" -> "dor torácica retroesternal em pirose/queimação"; "falta de ar ao deitar" -> "ortopneia"; "falta de ar" -> "dispneia"; "batedeira no peito" -> "palpitações"; "urina solta" -> "incontinência urinária").
   - Organize a História da Doença Atual (HDA) de forma cronológica, clara e concisa, preservando negativas pertinentes.

2. FIDELIDADE AO EXAME FÍSICO (PROIBIÇÃO DE ALUCINAÇÃO):
   - NUNCA invente, presuma ou adicione achados de exame físico que não foram explicitamente informados no relato ou nos sinais vitais.
   - Caso faltem dados críticos do exame físico para a queixa principal (ex.: ausência de ausculta cardíaca/pulmonar em paciente com dispneia, ou ausência de sinais de irritação peritoneal em dor abdominal), aponte explicitamente a sugestão do que deve ser examinado no campo apropriado do Objetivo, sem falsificar que o exame já foi feito.

3. FARMACOLOGIA E PRESCRIÇÃO (PADRÃO ANVISA / RENAME / DCB):
   - Utilize estritamente a Denominação Comum Brasileira (DCB) para todos os fármacos (ex.: "dipirona sódica", "losartana potássica", "amoxicilina + clavulanato de potássio", "omeprazol"). Nunca utilize nomes comerciais.
   - Especifique apresentações farmacêuticas, concentrações, posologias, vias de administração e durações reais comercializadas no Brasil e disponíveis no SUS/RENAME ou farmácias comunitárias brasileiras.

4. ANCORAGEM EM DIRETRIZES NACIONAIS BRASILEIRAS:
   - Baseie o raciocínio diagnóstico, estratificação de risco e condutas terapêuticas nas diretrizes médicas brasileiras vigentes: Protocolos Clínicos e Diretrizes Terapêuticas (PCDTs) do Ministério da Saúde, Sociedade Brasileira de Cardiologia (SBC), Sociedade Brasileira de Pneumologia e Tisiologia (SBPT), Federação Brasileira das Associações de Ginecologia e Obstetrícia (FEBRASGO), Sociedade Brasileira de Diabetes (SBD) e Cadernos de Atenção Básica.
   - Utilize códigos CID-10 oficiais e precisos nas hipóteses diagnósticas.

5. INTEGRAÇÃO COM MÉTRICAS DETERMINÍSTICAS:
   - Incorpore e interprete clinicamente no Objetivo e na Avaliação todos os escores e índices determinísticos fornecidos em "calculated_metrics" (ex.: IMC, PAM, Clearance de Creatinina CKD-EPI, escores de risco), não contradizendo os valores matemáticos já calculados.

6. FORMATO DE SAÍDA:
   - Responda exclusivamente com um objeto JSON estritamente válido e compatível com o schema estruturado solicitado.`;
}

/**
 * Monta o prompt de entrada do usuário consolidando o relato livre e os dados estruturados.
 */
function buildUserPrompt({ brain_dump, patient_context, vitals, calculated_metrics, tdc_evidences }) {
  const payload = {
    relato_clinico_livre_brain_dump: brain_dump || '',
    contexto_demografico_paciente: patient_context || {},
    sinais_vitais_brutos: vitals || {},
    metricas_deterministicas_calculadas: calculated_metrics || {},
    evidencias_clinicas_locais_tdc: Array.isArray(tdc_evidences) ? tdc_evidences : []
  };

  return `Analise os dados clínicos do atendimento abaixo e gere o registro estruturado SOAP completo seguindo rigorosamente as instruções do sistema:

${JSON.stringify(payload, null, 2)}`;
}

/**
 * Executa a chamada à API generateContent da Vertex AI para um modelo específico.
 */
async function callVertexModel({ model, systemPrompt, userPrompt, accessToken, projectId, location }) {
  const host = location === 'global'
    ? 'aiplatform.googleapis.com'
    : `${location}-aiplatform.googleapis.com`;

  const url = `https://${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;

  const requestPayload = {
    systemInstruction: {
      role: 'system',
      parts: [{ text: systemPrompt }]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: VertexSoapOutputSchema
    }
  };

  const bodyString = JSON.stringify(requestPayload);

  const response = await httpsRequest(
    url,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyString)
      }
    },
    bodyString
  );

  const parsedResponse = JSON.parse(response.body);
  const candidateText = parsedResponse?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!candidateText) {
    throw new Error(`Resposta da Vertex AI (${model}) não contém texto válido no candidato.`);
  }

  return JSON.parse(candidateText);
}

/**
 * Executa a chamada à API Gemini via API Key quando credenciais de Service Account Vertex não estão presentes.
 */
async function callGeminiApiKeyModel({ apiKey, model = 'gemini-2.5-flash', systemPrompt, userPrompt }) {
  const targetModel = (model && !model.includes('argon') && !model.includes('hydrogen'))
    ? model
    : 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const requestPayload = {
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: VertexSoapOutputSchema
    }
  };

  const bodyString = JSON.stringify(requestPayload);
  const response = await httpsRequest(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyString)
      }
    },
    bodyString
  );

  const parsedResponse = JSON.parse(response.body);
  const candidateText = parsedResponse?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!candidateText) {
    throw new Error(`Resposta da Gemini API (${targetModel}) não contém texto válido no candidato.`);
  }
  return JSON.parse(candidateText);
}

/**
 * Motor Clínico Determinístico de Contingência Local (RAM + RAG TdC).
 * Garante estruturação SOAP imediata e segura mesmo sem credenciais externas de nuvem.
 */
function buildDeterministicClinicalSoap({
  brain_dump = '',
  patient_context = {},
  vitals = {},
  calculated_metrics = {},
  tdc_evidences = []
}) {
  const textoBruto = String(brain_dump || '').trim();
  const lower = textoBruto.toLowerCase();

  // 1. Tradução semiológica técnica do relato
  let hdaTecnica = textoBruto
    .replace(/\bdor no peito\b/gi, 'dor torácica')
    .replace(/\bfalta de ar ao deitar\b/gi, 'ortopneia')
    .replace(/\bfalta de ar\b/gi, 'dispneia')
    .replace(/\bbatedeira no peito\b|\bbatedeira\b/gi, 'palpitações')
    .replace(/\bdor de cabe[çc]a\b/gi, 'cefaleia')
    .replace(/\bard[êe]ncia para urinar\b|\bdor para urinar\b/gi, 'disúria')
    .replace(/\bv[ôo]mitos?\b/gi, 'êmese')
    .replace(/\bdor na barriga\b/gi, 'dor abdominal');

  const demografiaParts = [];
  if (patient_context.idade !== undefined && patient_context.idade !== null) {
    demografiaParts.push(`${patient_context.idade} anos`);
  }
  if (patient_context.sexo === 'M') demografiaParts.push('sexo masculino');
  else if (patient_context.sexo === 'F') demografiaParts.push('sexo feminino');
  if (patient_context.gestante) demografiaParts.push('gestante');

  const prefixoDemografico = demografiaParts.length > 0
    ? `Paciente (${demografiaParts.join(', ')}): `
    : '';

  // Queixa Principal concisa
  const primeiraSentenca = hdaTecnica.split(/[.\n;]/)[0].trim();
  const qp = primeiraSentenca.length > 90 ? `${primeiraSentenca.slice(0, 87)}...` : (primeiraSentenca || 'Avaliação clínica aguda');

  // HPP e medicações
  const matchHpp = textoBruto.match(/\b(hipertens[oa]|has|diab[ée]tic[oa]|dm2?|asm[áa]tic[oa]|dpoc| tabagista|etilista|hipotireoidismo|irc|drc|ic|insufici[êe]ncia card[íi]aca|em uso de [^.]+)\b/gi);
  const hppMedicacoes = matchHpp && matchHpp.length > 0
    ? `Comorbidades/antecedentes mencionados no relato: ${Array.from(new Set(matchHpp)).join(', ')}.`
    : 'Não informada no relato inicial (confirmar ativamente comorbidades prévias e medicações de uso contínuo).';

  // Alergias (nunca fabrica "Nega alergias" se não informado)
  const alergiasContext = Array.isArray(patient_context.alergias) ? patient_context.alergias.filter(Boolean) : [];
  let alergiasStr = 'Não informado (confirmar ativamente alergias medicamentosas antes de prescrever).';
  if (alergiasContext.length > 0) {
    alergiasStr = `Alergia(s) registrada(s): ${alergiasContext.join(', ')}.`;
  } else if (/alergi[ca]/i.test(textoBruto)) {
    const mAlerg = textoBruto.match(/[^.;\n]*alergi[^.;\n]*/i);
    if (mAlerg) alergiasStr = mAlerg[0].trim();
  }

  const textoSubjetivoUnificado = [
    `QP: ${qp}.`,
    `HDA: ${prefixoDemografico}${hdaTecnica}`,
    `HPP / Medicações: ${hppMedicacoes}`,
    `Alergias: ${alergiasStr}`
  ].join('\n');

  // 2. Bloco Objetivo (Sinais Vitais + Métricas Determinísticas + Exame Físico fiel ao relato)
  const svParts = [];
  if (vitals.pas !== undefined && vitals.pad !== undefined) {
    svParts.push(`PA: ${vitals.pas}x${vitals.pad} mmHg`);
  } else if (vitals.pas !== undefined) {
    svParts.push(`PAS: ${vitals.pas} mmHg`);
  }
  if (vitals.fc !== undefined) svParts.push(`FC: ${vitals.fc} bpm`);
  if (vitals.fr !== undefined) svParts.push(`FR: ${vitals.fr} irpm`);
  if (vitals.spo2 !== undefined) svParts.push(`SpO2: ${vitals.spo2}%`);
  if (vitals.tax !== undefined) svParts.push(`Tax: ${vitals.tax} °C`);
  if (vitals.hgt !== undefined) svParts.push(`HGT: ${vitals.hgt} mg/dL`);
  if (vitals.glasgow !== undefined) svParts.push(`Glasgow: ${vitals.glasgow}/15`);
  if (vitals.peso !== undefined) svParts.push(`Peso: ${vitals.peso} kg`);
  if (vitals.altura !== undefined) svParts.push(`Altura: ${vitals.altura} cm`);

  const sinaisVitaisFormatados = svParts.length > 0
    ? svParts.join(' | ')
    : 'Sinais vitais formais não preenchidos nos campos numéricos (aferir PA, FC, FR, SpO2 e Tax à beira-leito).';

  const escoresParts = [];
  if (calculated_metrics.pam !== undefined && calculated_metrics.pam !== null) {
    escoresParts.push(`PAM: ${calculated_metrics.pam} mmHg`);
  }
  if (calculated_metrics.indice_choque !== undefined && calculated_metrics.indice_choque !== null) {
    escoresParts.push(`Índice de Choque (FC/PAS): ${calculated_metrics.indice_choque}`);
  }
  if (calculated_metrics.qsofa !== undefined && calculated_metrics.qsofa !== null) {
    escoresParts.push(`qSOFA: ${calculated_metrics.qsofa}/3`);
  }
  if (calculated_metrics.imc !== undefined && calculated_metrics.imc !== null) {
    escoresParts.push(`IMC: ${calculated_metrics.imc} kg/m² (${calculated_metrics.imc_classificacao || 'Calculado'})`);
  }
  const escoresCalculados = escoresParts.length > 0
    ? escoresParts.join(' | ')
    : 'Aguardando preenchimento completo de parâmetros vitais/antropométricos para cálculo de PAM, Índice de Choque, qSOFA e IMC.';

  const exameFisicoSistemas = 'Exame físico registrado conforme dados informados no relato clínico. Sugestão propedêutica complementar à beira-leito: documentar ectoscopia, ausculta cardiopulmonar (ACV/AR), tempo de enchimento capilar (TEC) e exame segmentar direcionado à queixa principal.';

  const textoObjetivoUnificado = [
    `Sinais Vitais: ${sinaisVitaisFormatados}`,
    `Escores e Métricas Determinísticas: ${escoresCalculados}`,
    `Exame Físico / Propedêutica: ${exameFisicoSistemas}`
  ].join('\n');

  // 3. Avaliação e Plano Sindrômico Baseado em Diretrizes Brasileiras
  const hipoteses = [];
  const redFlags = [];
  const prescricao = [];
  const exames = [];
  const orientacoes = [
    'Manter hidratação adequada e adesão rigorosa aos horários das medicações prescritas.',
    'Não utilizar anti-inflamatórios não esteroidais (AINEs) ou automedicação sem avaliação médica.'
  ];
  let raciocinio = '';
  let retorno = 'Reavaliação clínica conforme evolução ou retorno imediato à Sala de Emergência / Pronto-Socorro diante de sinais de alarme.';
  const referencias = [];

  // Alertas hemodinâmicos baseados nos sinais vitais
  if (calculated_metrics.pam !== undefined && calculated_metrics.pam !== null && calculated_metrics.pam < 65) {
    redFlags.push(`Hipotensão arterial / Hipoperfusão tecidual (PAM ${calculated_metrics.pam} mmHg < 65 mmHg)`);
  }
  if (calculated_metrics.indice_choque !== undefined && calculated_metrics.indice_choque !== null && calculated_metrics.indice_choque >= 0.9) {
    redFlags.push(`Índice de Choque elevado (${calculated_metrics.indice_choque}) sugerindo instabilidade hemodinâmica oculta`);
  }
  if (vitals.spo2 !== undefined && vitals.spo2 < 92) {
    redFlags.push(`Hipoxemia aguda (SpO2 ${vitals.spo2}% < 92%) — avaliar suplementação de O2 imediata`);
  }

  if (/dor no peito|dor tor[áa]cica|precordial|angina|infarto|iam|sca/i.test(lower)) {
    hipoteses.push(
      {
        cid10: 'I20.9',
        descricao: 'Síndrome Coronariana Aguda / Dor Torácica em Investigação',
        probabilidade: 'ALTA',
        justificativa: 'Quadro de dor torácica aguda exigindo estratificação imediata com ECG de 12 derivações em até 10 minutos e troponina seriada.'
      },
      {
        cid10: 'R07.4',
        descricao: 'Dor Torácica Não Especificada (Diagnóstico Diferencial: Dissecção Aórtica, TEP, Pericardite)',
        probabilidade: 'DIAGNOSTICO_DIFERENCIAL',
        justificativa: 'Necessidade de exclusão de causas torácicas potencialmente fatais conforme protocolo de Sala Vermelha.'
      }
    );
    redFlags.push(
      'Irradiação para membro superior esquerdo, mandíbula ou dorso, sudorese fria, dispneia ou síncope',
      'Instabilidade hemodinâmica, congestão pulmonar ou arritmias ventriculares'
    );
    raciocinio = 'Paciente com dor torácica aguda. Prioridade máxima na obtenção e laudo do ECG de 12 derivações em <= 10 minutos, monitorização contínua (MOV), coleta de troponina de alta sensibilidade e aplicação do escore HEART.';
    prescricao.push(
      {
        via: 'Uso Oral',
        medicamento: 'ácido acetilsalicílico',
        concentracao: '100mg comprimido',
        posologia: 'Mastigar e engolir 3 comprimidos (300mg) em dose de ataque (se ausentes contraindicações ou alergia)',
        duracao: 'Dose única de ataque na admissão',
        quantidade_dispensacao: '3 comprimidos',
        orientacao_uso: 'Administrar imediatamente após excluir suspeita de dissecção aguda de aorta ou sangramento ativo.'
      }
    );
    exames.push(
      'Eletrocardiograma (ECG) de 12 derivações imediato (meta <= 10 min)',
      'Troponina cardíaca (0h e 1h/3h conforme protocolo institucional)',
      'Radiografia de tórax no leito, Hemograma, Creatinina, Eletrólitos'
    );
    referencias.push({
      orgao: 'Sociedade Brasileira de Cardiologia (SBC)',
      diretriz: 'Diretrizes da SBC sobre Angina Instável e Infarto Agudo do Miocárdio',
      ano: '2021'
    });
  } else if (/tosse|pneumonia|dispneia|falta de ar|expectora[çc][ãa]o|febre/i.test(lower)) {
    hipoteses.push(
      {
        cid10: 'J18.9',
        descricao: 'Pneumonia Adquirida na Comunidade (PAC) / Infecção Respiratória Aguda',
        probabilidade: 'ALTA',
        justificativa: 'Sintomatologia respiratória aguda associada a sinais infecciosos/ventilatórios.'
      },
      {
        cid10: 'J06.9',
        descricao: 'Infecção Aguda das Vias Aéreas Superiores (IVAS)',
        probabilidade: 'MODERADA',
        justificativa: 'Diagnóstico diferencial em quadros respiratórios agudos sem consolidação radiológica.'
      }
    );
    redFlags.push(
      'Taquipneia acentuada (FR >= 30 irpm), hipoxemia (SpO2 < 90%), confusão mental ou hipotensão (critérios CURB-65)',
      'Esforço ventilatório, tiragem intercostal ou rebaixamento do sensório'
    );
    raciocinio = 'Quadro respiratório agudo. Indicada estratificação de gravidade (CURB-65 / qSOFA), avaliação da oximetria de pulso e definição do local de tratamento (ambulatorial vs. hospitalar).';
    prescricao.push(
      {
        via: 'Uso Oral',
        medicamento: 'amoxicilina + clavulanato de potássio',
        concentracao: '875mg + 125mg comprimido revestido',
        posologia: 'Tomar 1 comprimido de 12 em 12 horas',
        duracao: 'por 7 dias',
        quantidade_dispensacao: '14 comprimidos',
        orientacao_uso: 'Tomar no início das refeições para melhor tolerabilidade gastrointestinal (confirmar ausência de alergia a betalactâmicos).'
      },
      {
        via: 'Uso Oral',
        medicamento: 'dipirona sódica',
        concentracao: '500mg comprimido',
        posologia: 'Tomar 1 a 2 comprimidos de 6 em 6 horas se dor ou temperatura axilar >= 37,8 °C',
        duracao: 'se dor ou febre',
        quantidade_dispensacao: '10 comprimidos',
        orientacao_uso: 'Respeitar dose máxima diária de 4g/dia em adultos.'
      }
    );
    exames.push(
      'Radiografia de tórax (PA e Perfil)',
      'Hemograma completo, Proteína C Reativa (PCR), Ureia e Creatinina séricas'
    );
    referencias.push({
      orgao: 'Sociedade Brasileira de Pneumologia e Tisiologia (SBPT)',
      diretriz: 'Recomendações para o Manejo da Pneumonia Adquirida na Comunidade',
      ano: '2022'
    });
  } else if (/dis[úu]ria|ard[êe]ncia.*urin|polaci[úu]ria|itu|cistite|pielonefrite|lombar/i.test(lower)) {
    hipoteses.push(
      {
        cid10: 'N39.0',
        descricao: 'Infecção do Trato Urinário (ITU) / Cistite Aguda',
        probabilidade: 'ALTA',
        justificativa: 'Sintomas irritativos do trato urinário inferior (disúria/polaciúria).'
      },
      {
        cid10: 'N10',
        descricao: 'Pielonefrite Aguda Não Obstrutiva',
        probabilidade: 'DIAGNOSTICO_DIFERENCIAL',
        justificativa: 'Avaliar presença de febre, calafrios ou sinal de Giordano positivo.'
      }
    );
    redFlags.push('Febre alta persistente, calafrios, dor lombar com Giordano positivo, náuseas/vômitos incoercíveis ou sinais de sepse');
    raciocinio = 'Quadro compatível com infecção do trato urinário. Diferenciar cistite não complicada de pielonefrite aguda para escolha antimicrobiana racional.';
    prescricao.push(
      {
        via: 'Uso Oral',
        medicamento: 'nitrofurantoína',
        concentracao: '100mg cápsula',
        posologia: 'Tomar 1 cápsula de 6 em 6 horas',
        duracao: 'por 5 dias',
        quantidade_dispensacao: '20 cápsulas',
        orientacao_uso: 'Indicada para cistite aguda baixa não complicada (evitar se ClCr < 30 mL/min ou no termo da gestação).'
      },
      {
        via: 'Uso Oral',
        medicamento: 'dipirona sódica',
        concentracao: '500mg comprimido',
        posologia: 'Tomar 1 comprimido de 6 em 6 horas se dor',
        duracao: 'se dor',
        quantidade_dispensacao: '10 comprimidos',
        orientacao_uso: 'Analgesia sintomática.'
      }
    );
    exames.push('Urina tipo I (EAS) e Urocultura com antibiograma (se ITU complicada, gestante ou recidivante)');
    referencias.push({
      orgao: 'FEBRASGO / Sociedade Brasileira de Infectologia (SBI)',
      diretriz: 'Diretrizes Brasileiras para Manejo de Infecção do Trato Urinário',
      ano: '2023'
    });
  } else {
    hipoteses.push(
      {
        cid10: 'R69',
        descricao: ' Quadro Clínico Agudo em Investigação Diagnóstica',
        probabilidade: 'ALTA',
        justificativa: `Correlação clínica baseada na anamnese (${qp}) e parâmetros vitais registrados.`
      }
    );
    redFlags.push(
      'Piora clínica aguda, rebaixamento do nível de consciência, dispneia, hipotensão ou febre persistente refratária'
    );
    raciocinio = 'Avaliação clínica sistematizada estruturada a partir do relato livre e métricas determinísticas calculadas. Conduta voltada ao controle sintomático seguro e investigação complementar direcionada.';
    prescricao.push(
      {
        via: 'Uso Oral',
        medicamento: 'dipirona sódica',
        concentracao: '500mg comprimido',
        posologia: 'Tomar 1 comprimido de 6 em 6 horas se dor ou febre',
        duracao: 'se dor ou febre',
        quantidade_dispensacao: '10 comprimidos',
        orientacao_uso: 'Confirmar ausência de alergia prévia a pirazolônicos antes da administração.'
      }
    );
    exames.push('Avaliação laboratorial direcionada conforme evolução clínica (Hemograma, Função Renal, Eletrólitos)');
    referencias.push({
      orgao: 'Ministério da Saúde do Brasil',
      diretriz: 'Protocolos Clínicos e Diretrizes Terapêuticas (PCDT) / Cadernos de Atenção Básica',
      ano: '2024'
    });
  }

  if (Array.isArray(tdc_evidences) && tdc_evidences.length > 0) {
    for (const ev of tdc_evidences) {
      if (ev && ev.title) {
        referencias.push({
          orgao: `Acervo Clínico TdC (${ev.specialty || ev.category || 'Clínica Médica'})`,
          diretriz: ev.title,
          ano: ev.edition_date ? String(ev.edition_date).slice(0, 4) : '2025'
        });
      }
    }
  }

  return {
    subjetivo_formatado: {
      qp,
      hda: `${prefixoDemografico}${hdaTecnica}`,
      hpp_medicacoes: hppMedicacoes,
      alergias: alergiasStr,
      texto_unificado: textoSubjetivoUnificado
    },
    objetivo_formatado: {
      sinais_vitais_formatados: sinaisVitaisFormatados,
      exame_fisico_sistemas: exameFisicoSistemas,
      escores_calculados: escoresCalculados,
      texto_unificado: textoObjetivoUnificado
    },
    avaliacao: {
      hipoteses_diagnosticas: hipoteses,
      red_flags: redFlags,
      raciocinio_clinico: raciocinio
    },
    plano: {
      prescricao,
      exames_solicitados: exames,
      orientacoes_paciente: orientacoes,
      criterios_retorno_encaminhamento: retorno
    },
    referencias_bibliograficas: referencias
  };
}

/**
 * Gera a evolução clínica estruturada no padrão SOAP utilizando a Vertex AI com fallback resiliente.
 */
async function generateSoapWithVertex({
  brain_dump,
  patient_context = {},
  vitals = {},
  calculated_metrics = {},
  tdc_evidences = [],
  modelOverride = null
}) {
  if (!brain_dump || typeof brain_dump !== 'string' || !brain_dump.trim()) {
    throw new Error('O parâmetro "brain_dump" é obrigatório e deve ser uma string não vazia.');
  }

  const startTime = Date.now();
  const systemPrompt = buildClinicalSystemPrompt();
  const userPrompt = buildUserPrompt({
    brain_dump,
    patient_context,
    vitals,
    calculated_metrics,
    tdc_evidences
  });

  let soapObject = null;
  let modelUsed = modelOverride || DEFAULT_MODEL;

  // 1. Tentativa via Service Account da Vertex AI (quando configurada)
  const credentials = tryLoadCredentials();
  if (credentials) {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || credentials.project_id || DEFAULT_PROJECT_ID;
    const location = DEFAULT_LOCATION;
    const primaryModel = modelOverride || DEFAULT_MODEL;

    try {
      const accessToken = await getAccessToken();
      soapObject = await callVertexModel({
        model: primaryModel,
        systemPrompt,
        userPrompt,
        accessToken,
        projectId,
        location
      });
      modelUsed = primaryModel;
    } catch (primaryError) {
      const isRecoverable =
        !primaryError.statusCode ||
        primaryError.statusCode === 429 ||
        primaryError.statusCode === 404 ||
        primaryError.statusCode >= 500 ||
        /timeout/i.test(primaryError.message);

      if (isRecoverable && primaryModel !== FALLBACK_MODEL) {
        try {
          const accessToken = await getAccessToken();
          modelUsed = FALLBACK_MODEL;
          soapObject = await callVertexModel({
            model: FALLBACK_MODEL,
            systemPrompt,
            userPrompt,
            accessToken,
            projectId,
            location
          });
        } catch (_) {
          soapObject = null;
        }
      }
    }
  }

  // 2. Tentativa via Gemini API Key (quando configurada no ambiente)
  if (!soapObject) {
    const geminiApiKey = getConfiguredGeminiApiKey();
    if (geminiApiKey) {
      try {
        soapObject = await callGeminiApiKeyModel({
          apiKey: geminiApiKey,
          model: modelOverride || 'gemini-2.5-flash',
          systemPrompt,
          userPrompt
        });
        modelUsed = 'gemini-2.5-flash';
      } catch (_) {
        soapObject = null;
      }
    }
  }

  // 3. Fallback Clínico Determinístico Local (RAM + RAG TdC)
  if (!soapObject) {
    soapObject = buildDeterministicClinicalSoap({
      brain_dump,
      patient_context,
      vitals,
      calculated_metrics,
      tdc_evidences
    });
    modelUsed = 'motor-clinico-deterministico-local';
  }

  const executionTimeMs = Date.now() - startTime;

  return {
    ...soapObject,
    _meta: {
      model_used: modelUsed,
      execution_time_ms: executionTimeMs
    }
  };
}

module.exports = {
  generateSoapWithVertex,
  buildClinicalSystemPrompt,
  buildDeterministicClinicalSoap
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const rootDir = path.resolve(__dirname, '..');
const runtime = require('../server/runtime.js');
const lactacaoAdapter = require('../src/02_lactacao_seguranca.js');
const lactacaoCanonical = require('../src/domain/lactacao_seguranca_domain.js');
const soapAmbService = require('../src/02_soap_ambulatorial.js');
const motoresIa = require('../src/04_motores_ia.js');
const { tdcService } = require('../src/clinical/tdc_service.js');
const { processClinicalSoap } = require('../src/clinical/soap_service.js');

function sha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function extrairFuncaoCockpit(html, fnName) {
  const marker = `function ${fnName}(`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `Função ${fnName} deve existir no cockpit_movel.html`);
  const bodyStart = html.indexOf('{', start);
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;
  for (let i = bodyStart; i < html.length; i++) {
    const ch = html[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (!inDouble && !inTemplate && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inTemplate && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === '`') {
      inTemplate = !inTemplate;
      continue;
    }
    if (inSingle || inDouble || inTemplate) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return html.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Chaves desbalanceadas ao extrair ${fnName}`);
}

test('1. Deduplicação Lactação: adapter src/02_lactacao_seguranca.js delega 100% para domínio canônico', () => {
  assert.strictEqual(lactacaoAdapter, lactacaoCanonical, 'Adapter deve exportar exatamente a instância canônica');
  const amioAdapter = lactacaoAdapter.consultarMedicamento('Amiodarona');
  const amioCanonical = lactacaoCanonical.consultarMedicamento('Amiodarona');
  assert.deepStrictEqual(amioAdapter, amioCanonical);
  assert.equal(amioAdapter.ms, 'VERMELHO');
});

test('2. Deduplicação de globals no VM Runtime sem sombreamento ou quebra standalone', () => {
  assert.equal(typeof soapAmbService.processarEntradaSoap, 'function', 'SoapAmbulatorialService deve expor processarEntradaSoap');
  assert.equal(typeof motoresIa.gerarSOAPComIA, 'function', 'motoresIa standalone deve exportar gerarSOAPComIA');

  const checkHub = runtime.cockpitRpc('cockpitPerfil', 'bot', []);
  assert.ok(checkHub && typeof checkHub === 'object', 'Runtime VM deve permanecer íntegro após remoção de duplicatas');
});

test('3. Transparência RAG (TdC): getSourceMetadata() e _meta de processClinicalSoap expõem origem real', async () => {
  const res = await processClinicalSoap({
    brain_dump: 'Paciente 62 anos com febre alta, tosse produtiva, crepitações em base direita, PA 100/60, FR 24.',
    idade: 62,
    sexo: 'M',
    pas: 100,
    pad: 60,
    fr: 24,
    fc: 108
  });

  assert.equal(res.success, true);
  assert.equal(typeof res._meta.is_offline_contingency, 'boolean', '_meta.is_offline_contingency deve ser booleano explícito');
  assert.equal(
    res._meta.is_offline_contingency,
    res._meta.model_used === 'motor-clinico-deterministico-local',
    'is_offline_contingency deve refletir fielmente se caiu no motor determinístico local'
  );
  assert.ok(['sqlite_fts5', 'resumo_emergencia_local', 'none'].includes(res._meta.tdc_source), 'tdc_source deve ser explícito');
  assert.equal(typeof res._meta.tdc_db_available, 'boolean');

  const tdcMeta = tdcService.getSourceMetadata();
  assert.equal(typeof tdcMeta.dbAvailable, 'boolean');
  assert.ok(tdcMeta.fallbackPoolSize >= 5);
});

test('4. Unificação SafetyGuard no Cockpit: cockpitSoapAmbulatorial e cockpitConversar reportam is_safe e clinical_alerts', () => {
  const propsFile = path.join(rootDir, 'data/properties.json');
  const backupProps = fs.existsSync(propsFile) ? fs.readFileSync(propsFile, 'utf8') : null;
  try {
    const resAmb = runtime.cockpitRpc('cockpitSoapAmbulatorial', 'bot', [{
      paciente: 'Ana Teste',
      idade: 29,
      sexo: 'f',
      gestante: true,
      alergias: 'Dipirona',
      queixa: 'Cefaleia frontal intensa',
      conduta: 'Dipirona 1g EV agora e Ibuprofeno 600mg VO',
      prescricao: [
        { medicamento: 'Dipirona 500mg', posologia: '1g EV agora' },
        { medicamento: 'Ibuprofeno 600mg', posologia: '8/8h' }
      ]
    }]);

    assert.equal(resAmb.sucesso, true);
    assert.equal(typeof resAmb.is_safe, 'boolean');
    assert.ok(Array.isArray(resAmb.clinical_alerts));
    assert.equal(resAmb.is_safe, false, 'Alergia a Dipirona + AINE na gestação deve marcar is_safe = false');
    assert.ok(resAmb.clinical_alerts.length >= 1, 'Deve retornar pelo menos 1 alerta clínico estruturado');

    const resConv = runtime.cockpitRpc('cockpitConversar', 'bot', [{
      texto: 'Paciente gestante 26s alérgica a penicilina, iniciar amoxicilina 500mg 8/8h',
      alergias: 'penicilina',
      gestante: true,
      fallbackLocal: true
    }]);
    assert.equal(resConv.sucesso, true);
    assert.equal(typeof resConv.is_safe, 'boolean');
    assert.ok(Array.isArray(resConv.clinical_alerts));
  } finally {
    if (backupProps !== null) {
      fs.writeFileSync(propsFile, backupProps, 'utf8');
    }
  }
});

test('5. Paridade Matemática Offline (Cockpit calcularOfflineLocal vs Backend canônico)', () => {
  const html = fs.readFileSync(path.join(rootDir, 'cockpit_movel.html'), 'utf8');
  const fnCode = extrairFuncaoCockpit(html, 'calcularOfflineLocal');
  const sandbox = {
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    parseFloat,
    parseInt,
    isNaN,
    isFinite,
    interpretarSorologiasOfflineLocal: () => ({ textoFormatado: '' })
  };
  vm.createContext(sandbox);
  vm.runInContext(fnCode, sandbox);

  // 5.1 Noradrenalina 70 kg (concentração 64 mcg/mL: 0.1 -> 6.6, 0.5 -> 32.8, 2.0 -> 131.3 mL/h)
  const noraOff = sandbox.calcularOfflineLocal('dva', { droga: 'nora', peso: 70 });
  const noraBack = runtime.cockpitRpc('cockpitCalcular', 'bot', ['dva', { droga: 'nora', peso: '70' }]);
  assert.ok(noraOff.includes('6.6 mL/h'), 'Noradrenalina offline inicial 70kg deve ser 6.6 mL/h');
  assert.ok(noraOff.includes('32.8 mL/h'), 'Noradrenalina offline média 70kg deve ser 32.8 mL/h');
  assert.ok(noraOff.includes('131.3 mL/h'), 'Noradrenalina offline máx 70kg deve ser 131.3 mL/h');
  assert.ok(noraBack.textoFormatado.includes('6,6') || noraBack.textoFormatado.includes('6.6'), 'Backend deve bater 6.6 mL/h');

  // 5.2 Dobutamina 80 kg (concentração 1000 mcg/mL: 2.5 -> 12.0, 5.0 -> 24.0, 20.0 -> 96.0 mL/h)
  const dobutaOff = sandbox.calcularOfflineLocal('dva', { droga: 'dobuta', peso: 80 });
  assert.ok(dobutaOff.includes('12.0 mL/h'));
  assert.ok(dobutaOff.includes('24.0 mL/h'));
  assert.ok(dobutaOff.includes('96.0 mL/h'));

  // 5.3 Cockcroft-Gault ClCr (70a, 70kg, Cr 1.4, masc = 48.6; fem = 41.3)
  const clcrMasc = sandbox.calcularOfflineLocal('crcl', { idade: 70, peso: 70, creatinina: 1.4, sexo: 'm' });
  const clcrFem = sandbox.calcularOfflineLocal('crcl', { idade: 70, peso: 70, creatinina: 1.4, sexo: 'f' });
  assert.ok(clcrMasc.includes('48.6 mL/min'), `ClCr masc esperado 48.6 mL/min, obtido: ${clcrMasc}`);
  assert.ok(clcrFem.includes('41.3 mL/min'), `ClCr fem esperado 41.3 mL/min, obtido: ${clcrFem}`);
});

test('6. Paridade SHA-256 dos espelhos PWA (cockpit_movel.html e estacao_soap.js)', () => {
  const hashMovel = sha256(path.join(rootDir, 'cockpit_movel.html'));
  const hashIndex = sha256(path.join(rootDir, 'index.html'));
  const hashDeployIndex = sha256(path.join(rootDir, 'gh_cockpit_deploy/index.html'));
  const hashDeployMovel = sha256(path.join(rootDir, 'gh_cockpit_deploy/cockpit_movel.html'));

  assert.equal(hashIndex, hashMovel, 'index.html deve estar sincronizado com cockpit_movel.html');
  assert.equal(hashDeployIndex, hashMovel, 'gh_cockpit_deploy/index.html deve estar sincronizado com cockpit_movel.html');
  assert.equal(hashDeployMovel, hashMovel, 'gh_cockpit_deploy/cockpit_movel.html deve estar sincronizado com cockpit_movel.html');

  const hashSoapSrc = sha256(path.join(rootDir, 'estacao_soap.js'));
  const hashSoapDeploy = sha256(path.join(rootDir, 'gh_cockpit_deploy/estacao_soap.js'));
  assert.equal(hashSoapDeploy, hashSoapSrc, 'gh_cockpit_deploy/estacao_soap.js deve estar sincronizado com estacao_soap.js');
});

test('7. Ponto Cego não fabrica casos falsos (IAM/Sepse/Anafilaxia) quando vazio ou em contingência offline', () => {
  const html = fs.readFileSync(path.join(rootDir, 'cockpit_movel.html'), 'utf8');
  const idxCat = html.indexOf('const CATALOGO_PONTOS_CEGOS_PLANTAO =');
  const idxEnd = html.indexOf('function atualizarPontoCegoPlantaoDinamico');
  assert.ok(idxCat !== -1 && idxEnd > idxCat, 'Bloco Ponto Cego deve existir');
  const snippet = html.slice(idxCat, idxEnd);

  const sandbox = {
    Map,
    Array,
    String,
    Math,
    cockpitDados: {
      leitos: [],
      casosDoDia: [],
      soap: '⚡ *MODO OFFLINE DE CONTINGÊNCIA*\nAtalho imediato (100% ativo offline): ex: adrenalina 70kg ou /pcr, sepse, iam.'
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(snippet, sandbox);

  const resContingencia = sandbox.analisarCasosPlantaoDinamico();
  assert.equal(resContingencia.totalCasosIdentificados, 0, 'Contingência offline nunca deve gerar casos falsos');
  assert.equal(resContingencia.pontoFoco, null);
  assert.equal(resContingencia.sinteseTexto, 'Aguardando atendimentos do plantão de hoje.');
});


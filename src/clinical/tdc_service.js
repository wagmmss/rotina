/**
 * @file src/clinical/tdc_service.js
 * @description Motor RAG Determinístico Local sobre o acervo clínico "Tá de Clinicagem" (data/tdc_knowledge.db).
 *              Consulta instantânea (< 2ms) via node:sqlite FTS5 (BM25) nos 3.899 documentos clínicos.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STOPWORDS_PT = new Set([
  'de', 'da', 'do', 'das', 'dos', 'em', 'na', 'no', 'nas', 'nos', 'um', 'uma',
  'para', 'por', 'com', 'sem', 'sob', 'sobre', 'que', 'se', 'ao', 'aos', 'ou',
  'as', 'os', 'ele', 'ela', 'paciente', 'relata', 'refere', 'apresenta', 'ha',
  'dias', 'horas', 'anos', 'meses', 'exame', 'fisico', 'normal', 'nega', 'uso',
  'caso', 'clinico', 'sintetico', 'auditoria', 'consulta', 'atendimento'
]);

function normalizeQueryTokens(text) {
  if (!text || typeof text !== 'string') return [];
  const clean = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ');

  const seen = new Set();
  const tokens = [];
  for (const w of clean.split(/\s+/)) {
    if (w.length >= 3 && !STOPWORDS_PT.has(w) && !/^\d+$/.test(w) && !seen.has(w)) {
      seen.add(w);
      tokens.push(w);
    }
    if (tokens.length >= 8) break;
  }
  return tokens;
}

const TDC_FALLBACK_DOCS = [
  {
    id: 1,
    title: 'Insuficiência Cardíaca Descompensada e Crônica (ICFER / ICFEP): Manejo Baseado nos 4 Pilares e Perfil Hemodinâmico',
    category: 'Guia TdC',
    specialty: 'Cardiologia',
    edition_date: '2025-02-10',
    snippet: 'Classificação hemodinâmica de Stevenson (Quente/Frio x Seco/Úmido). Perfil B (Quente e Úmido): furosemida EV 1 mg/kg (ou 2,5x dose domiciliar) + vasodilatador se PAS > 110 mmHg. Os 4 pilares modificadores de mortalidade na ICFER: Sacubitril-Valsartana/IECA, Betabloqueador ( succinato de metoprolol, carvedilol, bisoprolol), Espironolactone e iSGLT2 (dapagliflozina/empagliflozina).'
  },
  {
    id: 2,
    title: 'Síndrome Coronariana Aguda (IAMCSST e IAMSSST) e Dor Torácica na Sala de Emergência',
    category: 'Guia TdC',
    specialty: 'Cardiologia',
    edition_date: '2025-01-18',
    snippet: 'ECG de 12 derivações em até 10 minutos da chegada. AAS 300 mg VO mastigado imediato. Estratificação pelo HEART Score e curvas de troponina de alta sensibilidade (0h/1h). Infarto de ventrículo direito (V3R/V4R): contraindicação absoluta a nitratos e morfina.'
  },
  {
    id: 3,
    title: 'Pneumonia Adquirida na Comunidade (PAC): Estratificação CURB-65 e Antibioticoterapia Empírica',
    category: 'Guia TdC',
    specialty: 'Pneumologia / Infectologia',
    edition_date: '2024-11-20',
    snippet: 'Estratificação CURB-65 (Confusão, Ureia > 50 mg/dL, FR >= 30 irpm, PAS < 90 ou PAD <= 60 mmHg, Idade >= 65). Ambulatorial com comorbidades: Amoxicilina + Clavulanato 875/125 mg 12/12h associada ou não a macrolídeo. Internação: Ceftriaxona 1-2g EV 24/24h + Claritromicina 500 mg 12/12h ou Azitromicina 500 mg/dia.'
  },
  {
    id: 4,
    title: 'Sepse e Choque Séptico: Pacote de 1 Hora (Surviving Sepsis Campaign)',
    category: 'Guia TdC',
    specialty: 'Medicina de Emergência / Terapia Intensiva',
    edition_date: '2025-03-05',
    snippet: 'Coleta de lactato arterial e 2 pares de hemoculturas antes do antimicrobiano (sem atrasar ATB > 45 min). Ressuscitação volêmica com 30 mL/kg de cristaloide balanceado nas primeiras 3h se hipotensão ou lactato >= 4 mmol/L. Noradrenalina precoce para meta de PAM >= 65 mmHg.'
  },
  {
    id: 5,
    title: 'Infecção do Trato Urinário (Cistite Aguda e Pielonefrite): Escolha Antimicrobiana Racional',
    category: 'Guia TdC',
    specialty: 'Infectologia / Nefrologia',
    edition_date: '2024-09-14',
    snippet: 'Cistite aguda não complicada: Fosfomicina trometamol 3g dose única ou Nitrofurantoína 100 mg VO 6/6h por 5 dias. Pielonefrite aguda não complicada: Ciprofloxacino 500 mg VO 12/12h por 7 dias ou Ceftriaxona 1-2g EV/IM 24/24h.'
  },
  {
    id: 6,
    title: 'Crise Hipertensiva: Emergência vs. Pseudocrise e Urgência Hipertensiva',
    category: 'Guia TdC',
    specialty: 'Cardiologia / Clínica Médica',
    edition_date: '2024-12-02',
    snippet: 'Emergência hipertensiva exige lesão aguda de órgão-alvo (LOA: encefalopatia, síndrome coronariana, edema agudo de pulmão, dissecção aórtica, eclâmpsia) e redução controlada da PAM em 20-25% na 1ª hora com vasodilatador EV. Ausência de LOA contraindica redução abrupta da PA.'
  }
];

class TdcKnowledgeService {
  constructor(dbPathOverride = null) {
    this.sqliteDb = null;
    this.lastSearchMeta = {
      dbAvailable: false,
      source: 'none',
      matchedCount: 0,
      fallbackPoolSize: TDC_FALLBACK_DOCS.length
    };
    this._initSqlite(dbPathOverride);
  }

  _initSqlite(customPath = null) {
    try {
      const candidates = [
        customPath,
        process.env.TDC_DB_PATH,
        path.resolve(__dirname, '../../data/tdc_knowledge.db'),
        path.resolve(process.cwd(), 'data/tdc_knowledge.db')
      ].filter(Boolean);

      let found = null;
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          found = p;
          break;
        }
      }

      if (found) {
        const { DatabaseSync } = require('node:sqlite');
        this.sqliteDb = new DatabaseSync(found, { open: true, readOnly: true });
        this.sqliteDb.exec('PRAGMA query_only = ON; PRAGMA mmap_size = 67108864;');
      }
      this.lastSearchMeta.dbAvailable = Boolean(this.sqliteDb);
    } catch (_) {
      this.sqliteDb = null;
      this.lastSearchMeta.dbAvailable = false;
    }
  }

  /**
   * Retorna transparência auditável da fonte RAG utilizada na última consulta clínica.
   */
  getSourceMetadata() {
    return {
      dbAvailable: Boolean(this.sqliteDb),
      source: this.lastSearchMeta.source,
      matchedCount: this.lastSearchMeta.matchedCount,
      fallbackPoolSize: TDC_FALLBACK_DOCS.length
    };
  }

  /**
   * Busca evidências clínicas relevantes no banco FTS5 do Tá de Clinicagem em < 2ms (com fallback em RAM).
   * @param {string} rawText - Texto da queixa, hipótese ou brain dump.
   * @param {number} [limit=3] - Número máximo de documentos retornados.
   * @returns {Array<{id: number, title: string, category: string, specialty: string, snippet: string}>}
   */
  buscarEvidenciasClinicas(rawText = '', limit = 3) {
    this.lastSearchMeta = {
      dbAvailable: Boolean(this.sqliteDb),
      source: 'none',
      matchedCount: 0,
      fallbackPoolSize: TDC_FALLBACK_DOCS.length
    };

    if (!rawText) return [];
    const tokens = normalizeQueryTokens(rawText);
    if (tokens.length === 0) return [];

    const maxLimit = Math.min(Math.max(Number(limit) || 3, 1), 10);

    if (this.sqliteDb) {
      const ftsMatchQuery = tokens.map((t) => `"${t}"*`).join(' OR ');
      try {
        const sql = `
          SELECT
            d.id,
            d.title,
            d.category,
            d.specialty,
            d.edition_date,
            substr(d.markdown_content, 1, 900) AS snippet
          FROM clinical_documents_fts f
          JOIN clinical_documents d ON d.id = f.rowid
          WHERE clinical_documents_fts MATCH ?
          ORDER BY bm25(clinical_documents_fts, 5.0, 2.0, 1.5, 2.0, 1.0)
          LIMIT ?
        `;
        const rows = this.sqliteDb.prepare(sql).all(ftsMatchQuery, maxLimit);
        if (Array.isArray(rows) && rows.length > 0) {
          this.lastSearchMeta = {
            dbAvailable: true,
            source: 'sqlite_fts5',
            matchedCount: rows.length,
            fallbackPoolSize: TDC_FALLBACK_DOCS.length
          };
          return rows;
        }
      } catch (_) {}
    }

    // Fallback determinístico em memória (Dual-Layer)
    const scored = [];
    for (const doc of TDC_FALLBACK_DOCS) {
      const haystack = `${doc.title} ${doc.specialty} ${doc.snippet}`
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
      let score = 0;
      for (const tk of tokens) {
        if (haystack.includes(tk)) score += 1;
      }
      if (score > 0) {
        scored.push({ doc, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const out = scored.slice(0, maxLimit).map((s) => s.doc);
    this.lastSearchMeta = {
      dbAvailable: Boolean(this.sqliteDb),
      source: out.length > 0 ? 'resumo_emergencia_local' : 'none',
      matchedCount: out.length,
      fallbackPoolSize: TDC_FALLBACK_DOCS.length
    };
    return out;
  }

  /**
   * Alias de conveniência para busca de evidências clínicas por tema/assunto.
   */
  buscarPorTema(tema = '', options = {}) {
    const limit = options.limite || options.limit || 3;
    return this.buscarEvidenciasClinicas(tema, limit);
  }
}

const tdcService = new TdcKnowledgeService();

module.exports = {
  TdcKnowledgeService,
  tdcService
};

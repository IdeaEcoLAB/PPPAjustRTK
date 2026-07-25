// Extração de dados do relatório oficial IBGE-PPP (PDF) usando pdf.js.
// Layout de referência: "Relatório do Posicionamento por Ponto Preciso (PPP)".
// - Linha oficial de coordenadas: "Em 2000.4 (É a que deve ser usada)"
//   → Lat(gms) Lon(gms) Alt.Geo(m) UTM N(m) UTM E(m) MC
// - Altitude ortométrica aparece como "Altitude Normal (m)" (modelo hgeoHNOR).
// - Números misturam vírgula decimal (450,60) e ponto decimal (7444262.734).
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

function parseBRNumber(s) {
  if (!s) return NaN;
  s = String(s).trim();
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  return parseFloat(s);
}

const NUM = "(-?[\\d\\.]{1,12},\\d{1,4}|-?\\d+\\.\\d{1,4})";

function firstMatch(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const v = parseBRNumber(m[1]);
      if (!isNaN(v)) return v;
    }
  }
  return NaN;
}

export async function extractPppFromPdf(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(" ") + "\n";
  }
  text = text.replace(/\s+/g, " ");

  const result = {
    station: null, antennaModel: null, antHeight: NaN,
    utmE: NaN, utmN: NaN, altGeo: NaN, altOrto: NaN,
    sigmaLat: NaN, sigmaLon: NaN, sigmaAlt: NaN,
    geoidModel: null, dataInicio: null, dataFim: null, duracao: null, orbitas: null,
  };

  // Identificação do marco: "Sumário do Processamento do marco: 20251019=3487255"
  const st = text.match(/marco:\s*([\w\-\.=]+)/i);
  if (st) result.station = st[1].includes("=") ? st[1].split("=").pop() : st[1];

  // Modelo da antena informado ao PPP (nomenclatura IGS/NGS)
  const am = text.match(/Modelo da Antena:?\s*([A-Z0-9_\-\/\+\.]+)/i);
  if (am) result.antennaModel = am[1];

  // Altura da antena usada no processamento (marco → PRA/ARP)
  result.antHeight = firstMatch(text, [
    new RegExp("Altura da Antena[^:]{0,15}:\\s*" + NUM, "i"),
  ]);

  // Data/hora de início e fim da sessão de rastreio
  const di = text.match(/In[ií]cio:\s*(\d{4}\/\d{2}\/\d{2})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?/i);
  if (di) result.dataInicio = di[1] + (di[2] ? " " + di[2] : "");
  const df = text.match(/Fim:\s*(\d{4}\/\d{2}\/\d{2})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?/i);
  if (df) result.dataFim = df[1] + (df[2] ? " " + df[2] : "");

  // Duração do rastreio: usa a informada no relatório ou calcula de início/fim
  const du = text.match(/Dura[cç][aã]o[^\d]{0,25}(\d{1,3}:\d{2}(?::\d{2})?|\d+\s*h(?:\s*\d+\s*m(?:in)?)?)/i);
  if (du) result.duracao = du[1];
  if (!result.duracao && di?.[2] && df?.[2]) {
    const toDate = (d, t) => new Date(d.replace(/\//g, "-") + "T" + (t.length === 5 ? t + ":00" : t));
    const ms = toDate(df[1], df[2]) - toDate(di[1], di[2]);
    if (ms > 0) {
      const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
      result.duracao = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
  }

  // Órbitas dos satélites usadas no processamento (final / rápida / ultra-rápida)
  const ob = text.match(/[ÓO]rbitas?(?:\s+dos\s+Sat[ée]lites)?:?\s*([A-Za-zÀ-ú\- ]{3,25}?)(?=\s{2,}|\s+[A-ZÀ-Ú][a-z]|$|\s+\()/);
  if (ob) result.orbitas = ob[1].trim();

  // Modelo geoidal / de conversão altimétrica
  const gm = text.match(/Modelo:\s*([\w]+)/i);
  if (gm) result.geoidModel = gm[1];

  // ── Linha oficial "Em 2000.4": pega o trecho até "Na data"/"Sigma" e
  //    identifica os números pela ordem e magnitude típicas de UTM no Brasil.
  const seg = text.match(/Em\s*2000\.4.*?(?=Na data|Sigma\s*\(95)/i);
  if (seg) {
    const nums = [...seg[0].matchAll(/-?\d[\d\.]*,\d+|-?\d+\.\d+/g)].map((m) => ({
      raw: m[0], val: parseBRNumber(m[0]),
    })).filter((n) => !isNaN(n.val));
    const iN = nums.findIndex((n) => n.val > 1000000 && n.val < 10100000);
    if (iN >= 0) {
      result.utmN = nums[iN].val;
      const e = nums.slice(iN + 1).find((n) => n.val >= 100000 && n.val < 1000000);
      if (e) result.utmE = e.val;
      // Alt. Geo. é o número imediatamente anterior ao UTM N na linha
      if (iN > 0) result.altGeo = nums[iN - 1].val;
    }
  }

  // Altitude Normal (ortométrica via hgeoHNOR/MAPGEO)
  result.altOrto = firstMatch(text, [
    new RegExp("Altitude\\s*Normal\\s*\\(m\\)\\s*:?\\s*" + NUM, "i"),
    new RegExp("Alt(?:itude|\\.)?\\s*Ortom[ée]trica(?:\\s*\\(?\\s*MAPGEO\\s*\\d{0,4}\\s*\\)?)?[^\\d\\-]{0,40}" + NUM, "i"),
  ]);

  // Sigmas(95%): lat, lon, alt
  const sg = text.match(new RegExp("Sigma\\s*\\(95%\\)[^,]{0,15}?" + NUM + "\\s+" + NUM + "\\s+" + NUM, "i"));
  if (sg) {
    result.sigmaLat = parseBRNumber(sg[1]);
    result.sigmaLon = parseBRNumber(sg[2]);
    result.sigmaAlt = parseBRNumber(sg[3]);
  }

  // ── Fallbacks para versões antigas do relatório (rótulos diretos) ──
  if (isNaN(result.utmE)) result.utmE = firstMatch(text, [
    new RegExp("Este\\s*\\(m\\)[^\\d\\-]{0,40}" + NUM, "i"),
  ]);
  if (isNaN(result.utmN)) result.utmN = firstMatch(text, [
    new RegExp("Norte\\s*\\(m\\)[^\\d\\-]{0,40}" + NUM, "i"),
  ]);
  if (isNaN(result.altGeo)) result.altGeo = firstMatch(text, [
    new RegExp("Alt(?:itude|\\.)?\\s*Geom[ée]trica[^\\d\\-]{0,40}" + NUM, "i"),
  ]);
  if (isNaN(result.utmE) || isNaN(result.utmN)) {
    const nums = [...text.matchAll(/-?\d[\d\.]*,\d+|-?\d+\.\d+/g)].map((m) => parseBRNumber(m[0]));
    if (isNaN(result.utmN)) result.utmN = nums.find((v) => v > 1000000 && v < 10100000) ?? NaN;
    if (isNaN(result.utmE)) result.utmE = nums.find((v) => v >= 100000 && v < 1000000) ?? NaN;
  }

  result.ok = !isNaN(result.utmE) && !isNaN(result.utmN) && (!isNaN(result.altOrto) || !isNaN(result.altGeo));
  return result;
}

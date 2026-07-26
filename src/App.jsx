import { useState, useRef, useMemo } from "react";
import {
  Upload, Download, FileText, Crosshair, CheckCircle2, AlertTriangle,
  RefreshCw, Plus, Pencil, ShieldAlert, FileDown, Satellite, HelpCircle,
  Table2, Info, Map, ChevronRight,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────
// AJUSTE PPP · Correção de levantamentos GNSS RTK a partir de
// base ajustada pelo IBGE-PPP. Fluxo em abas:
// 1 Arquivos → 2 Colunas → 3 Base & PPP → 4 Resultados → 5 Desenhos
// ─────────────────────────────────────────────────────────────

const DEFAULT_ANTENNAS = [
  { id: 1, nome: "ComNav CNTT300 (T300)", apc: "0.0791", fonte: "Manual do fabricante: h0 0,0411 + h1 0,038 m" },
  { id: 2, nome: "KQ M10T", apc: "0.0800", fonte: "Etiqueta do equipamento: HL1 = 80 mm (ARP → centro de fase L1); L = 130 mm é o braço de medição, use-o apenas se a altura for medida inclinada" },
  { id: 3, nome: "CHC i73+", apc: "0.1018", fonte: "Calibração NGS (CHCI73+ NONE): offset L1 = 101,8 mm acima do ARP" },
];

const ROLES = [
  { key: "name", label: "Nome do ponto" },
  { key: "code", label: "Descrição/código" },
  { key: "e", label: "Este / E (m)" },
  { key: "n", label: "Norte / N (m)" },
  { key: "z", label: "Altitude / Z (m)" },
  { key: "se", label: "Sigma E (m)" },
  { key: "sn", label: "Sigma N (m)" },
  { key: "sz", label: "Sigma Z (m)" },
  { key: "sol", label: "Solução (fixo/flutuante)" },
  { key: "antH", label: "Altura da antena (m)" },
  { key: "pdop", label: "PDOP" },
  { key: "start", label: "Data/hora" },
  { key: "ignore", label: "— Ignorar —" },
];

function detectDelimiter(line) {
  const counts = { "\t": (line.match(/\t/g) || []).length, ";": (line.match(/;/g) || []).length, ",": (line.match(/,/g) || []).length };
  if (counts["\t"] >= 2) return "\t";
  if (counts[";"] >= 2) return ";";
  return ",";
}

function toNum(v, delim) {
  if (v === undefined || v === null) return NaN;
  let s = String(v).trim().replace(/^"|"$/g, "");
  if (s === "") return NaN;
  if (delim !== ",") s = s.replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN;
}

function normalizeSol(s) {
  const t = String(s ?? "").trim().toLowerCase();
  if (/^fix/.test(t)) return "fixed";
  if (/^(float|flut)/.test(t)) return "float";
  if (/base/.test(t)) return "base";
  return t;
}

// Comparação de modelos de antena (relatório PPP × perfil do app)
function normModel(s) {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/NONE$/, "");
}

function autoMapColumns(matrix, delim) {
  const nCols = Math.max(...matrix.map((r) => r.length));
  const roles = new Array(nCols).fill("ignore");
  const stats = [];
  for (let c = 0; c < nCols; c++) {
    const vals = matrix.map((r) => r[c]).filter((v) => v !== undefined && String(v).trim() !== "");
    const nums = vals.map((v) => toNum(v, delim)).filter((v) => !isNaN(v));
    const numFrac = vals.length ? nums.length / vals.length : 0;
    const sorted = [...nums].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
    const distinct = new Set(nums.map((v) => v.toFixed(3))).size;
    const solFrac = vals.length ? vals.filter((v) => /^(fixo|fixed|float|flutuante|base|dgps|single|auton)/i.test(String(v).trim())).length / vals.length : 0;
    const dateFrac = vals.length ? vals.filter((v) => /\d{4}[\/\-]\d{2}[\/\-]\d{2}/.test(String(v))).length / vals.length : 0;
    stats.push({ c, numFrac, median, distinct, solFrac, dateFrac });
  }

  const taken = new Set();
  const take = (c, role) => { roles[c] = role; taken.add(c); };

  for (const s of stats) if (!taken.has(s.c) && s.solFrac > 0.6) { take(s.c, "sol"); break; }
  for (const s of stats) if (!taken.has(s.c) && s.dateFrac > 0.6) { take(s.c, "start"); break; }

  const nCol = stats.find((s) => !taken.has(s.c) && s.numFrac > 0.9 && s.median > 1e6 && s.median < 1.01e7);
  if (nCol) take(nCol.c, "n");
  const eCol = stats.find((s) => !taken.has(s.c) && s.numFrac > 0.9 && s.median >= 1e5 && s.median < 1e6);
  if (eCol) take(eCol.c, "e");

  // Altitude: prefere coluna DEPOIS de E/N (evita nomes de ponto numéricos)
  const zCands = stats.filter((s) => !taken.has(s.c) && s.numFrac > 0.9 && s.median > 10 && s.median < 5000);
  const coordMin = Math.min(nCol ? nCol.c : Infinity, eCol ? eCol.c : Infinity);
  const zCol = zCands.find((s) => s.c > coordMin) ?? zCands[0];
  if (zCol) take(zCol.c, "z");

  const sigmaCols = stats.filter((s) => !taken.has(s.c) && s.numFrac > 0.9 && s.median > 0 && s.median < 0.5).slice(0, 3);
  const coordOrder = (nCol && eCol && nCol.c < eCol.c) ? ["sn", "se"] : ["se", "sn"];
  sigmaCols.forEach((s, i) => take(s.c, i < 2 ? coordOrder[i] : "sz"));

  for (const s of stats) {
    if (taken.has(s.c) || s.numFrac < 0.9 || isNaN(s.median)) continue;
    if (s.median >= 0.3 && s.median <= 3.5) take(s.c, s.distinct <= 8 ? "antH" : "pdop");
    else if (s.median > 0.3 && s.median < 10) take(s.c, "pdop");
  }

  if (!taken.has(0)) take(0, "name");
  else { const f = stats.find((s) => !taken.has(s.c)); if (f) take(f.c, "name"); }
  const codeCol = stats.find((s) => !taken.has(s.c) && s.numFrac < 0.5);
  if (codeCol) take(codeCol.c, "code");

  return roles;
}

const HEADER_HINTS = [
  { role: "name", tests: ["name", "nome", "ponto", "id", "pt"] },
  { role: "code", tests: ["code", "cod", "desc"] },
  { role: "e", tests: ["este", "east", "leste", "utm e", "e"] },
  { role: "n", tests: ["norte", "north", "utm n", "n"] },
  { role: "z", tests: ["z", "elev", "alt", "cota", "h"] },
  { role: "se", tests: ["rms_x", "sigma e", "se", "sx"] },
  { role: "sn", tests: ["rms_y", "sigma n", "sn", "sy"] },
  { role: "sz", tests: ["rms_h", "sigma z", "sz", "sh"] },
  { role: "sol", tests: ["solution", "solu", "situa", "status"] },
  { role: "pdop", tests: ["pdop"] },
  { role: "antH", tests: ["antenna height", "altura"] },
  { role: "start", tests: ["start", "inicio", "início", "data"] },
];

function refineWithHeader(roles, headerCells) {
  const out = [...roles];
  headerCells.forEach((raw, i) => {
    const h = String(raw).trim().toLowerCase().replace(/^"|"$/g, "");
    // "Antenna name"/"measure type" não são nome/código do ponto
    if (/antenna|antena/.test(h) && !/height|altura/.test(h)) return;
    for (const { role, tests } of HEADER_HINTS) {
      if (tests.some((t) => (t.length <= 2 ? h === t : h.includes(t)))) {
        const prev = out.indexOf(role);
        if (prev >= 0 && prev !== i) out[prev] = "ignore";
        out[i] = role;
        break;
      }
    }
  });
  return out;
}

function parseRaw(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return { error: "Arquivo vazio." };
  const delim = detectDelimiter(lines[0]);
  const firstCells = lines[0].split(delim).map((s) => s.trim().replace(/^"|"$/g, ""));
  const numericCount = firstCells.filter((c) => !isNaN(toNum(c, delim))).length;
  const hasHeader = numericCount < firstCells.length / 2;
  const dataLines = hasHeader ? lines.slice(1) : lines;
  const matrix = dataLines.map((l) => l.split(delim).map((s) => s.trim().replace(/^"|"$/g, "")));
  if (matrix.length === 0) return { error: "Nenhuma linha de dados encontrada." };
  let roles = autoMapColumns(matrix, delim);
  if (hasHeader) roles = refineWithHeader(roles, firstCells);
  return { matrix, delim, header: hasHeader ? firstCells : null, roles };
}

function buildStructured(matrix, delim, roles) {
  const idx = (role) => roles.indexOf(role);
  const iName = idx("name"), iCode = idx("code"), iE = idx("e"), iN = idx("n"), iZ = idx("z");
  const iSE = idx("se"), iSN = idx("sn"), iSZ = idx("sz"), iSol = idx("sol");
  const iAntH = idx("antH"), iPdop = idx("pdop"), iStart = idx("start");
  const rows = [];
  const skipped = [];
  matrix.forEach((c, li) => {
    const e = iE >= 0 ? toNum(c[iE], delim) : NaN;
    const n = iN >= 0 ? toNum(c[iN], delim) : NaN;
    const z = iZ >= 0 ? toNum(c[iZ], delim) : NaN;
    if (isNaN(e) || isNaN(n) || isNaN(z)) { skipped.push(li + 1); return; }
    rows.push({
      name: iName >= 0 ? c[iName] : String(rows.length + 1),
      code: iCode >= 0 ? (c[iCode] ?? "") : "",
      e, n, z,
      se: iSE >= 0 ? toNum(c[iSE], delim) : NaN,
      sn: iSN >= 0 ? toNum(c[iSN], delim) : NaN,
      sz: iSZ >= 0 ? toNum(c[iSZ], delim) : NaN,
      sol: iSol >= 0 ? normalizeSol(c[iSol]) : "",
      antH: iAntH >= 0 ? toNum(c[iAntH], delim) : NaN,
      pdop: iPdop >= 0 ? toNum(c[iPdop], delim) : NaN,
      start: iStart >= 0 ? (c[iStart] ?? "") : "",
    });
  });
  return { rows, skipped };
}

function findBaseIndex(rows) {
  let i = rows.findIndex((r) => r.sol === "base");
  if (i < 0) i = rows.findIndex((r) => /base/i.test(r.code) || /base/i.test(r.name));
  return i < 0 ? 0 : i;
}

const f3 = (v) => (isNaN(v) ? "" : v.toFixed(3));
const f4 = (v) => (isNaN(v) ? "" : v.toFixed(4));

// Evita "CSV/formula injection" ao abrir no Excel/LibreOffice/Sheets
function safeCell(v) {
  const s = String(v ?? "");
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function download(filename, content, mime = "text/plain") {
  const blob = new Blob(["\uFEFF" + content], { type: mime + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

const TAB_LABELS = ["1 · Arquivos", "2 · Colunas", "3 · Base & PPP", "4 · Resultados", "5 · Desenhos"];

export default function App() {
  const [tab, setTab] = useState(0);
  // Arquivos
  const [fileName, setFileName] = useState("");
  const [raw, setRaw] = useState(null);
  const [colRoles, setColRoles] = useState([]);
  const [pdfName, setPdfName] = useState("");
  const [pdfInfo, setPdfInfo] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [error, setError] = useState("");
  // Base / PPP
  const [baseIdx, setBaseIdx] = useState(0);
  const [baseName, setBaseName] = useState("BASE");
  const [pppE, setPppE] = useState("");
  const [pppN, setPppN] = useState("");
  const [pppZ, setPppZ] = useState("");
  const [zType, setZType] = useState("Ortométrica");
  const [arp, setArp] = useState("");
  // Até onde a altura da base foi medida no campo
  const [measureTo, setMeasureTo] = useState("arp"); // 'arp' | 'fase' | 'reduzido'
  // Antenas
  const [antennas, setAntennas] = useState(DEFAULT_ANTENNAS);
  const [antId, setAntId] = useState(1);
  const [showAntForm, setShowAntForm] = useState(false);
  const [antFormMode, setAntFormMode] = useState("nova");
  const [antNome, setAntNome] = useState("");
  const [antH0, setAntH0] = useState("");
  const [antH1, setAntH1] = useState("");

  const txtRef = useRef(null);
  const pdfRef = useRef(null);

  const selAnt = antennas.find((a) => a.id === antId) ?? antennas[0];
  const apcNum = parseFloat(String(selAnt?.apc ?? "").replace(",", "."));

  const parsed = useMemo(() => {
    if (!raw) return null;
    return buildStructured(raw.matrix, raw.delim, colRoles);
  }, [raw, colRoles]);

  const MAX_FILE_MB = 25;
  const tooBig = (file) => file.size > MAX_FILE_MB * 1024 * 1024;

  const loadTxt = (file) => {
    setError("");
    if (tooBig(file)) { setError(`Arquivo bruto acima de ${MAX_FILE_MB} MB — confira se é mesmo o export de pontos.`); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const res = parseRaw(String(ev.target.result));
      if (res.error) { setError("Arquivo bruto: " + res.error); return; }
      setRaw({ matrix: res.matrix, delim: res.delim, header: res.header });
      setColRoles(res.roles);
      setFileName(file.name);
      const { rows } = buildStructured(res.matrix, res.delim, res.roles);
      const bi = findBaseIndex(rows);
      setBaseIdx(bi);
      const b = rows[bi];
      if (b) {
        if (!pdfInfo?.station) setBaseName(b.name || "BASE");
        setArp(isNaN(b.antH) ? "" : String(b.antH));
      }
      setTab(1); // avança para conferência de colunas
    };
    reader.onerror = () => setError("Não foi possível ler o arquivo bruto.");
    reader.readAsText(file, "utf-8");
  };

  const setRole = (colIndex, role) => {
    setColRoles((prev) => {
      const next = [...prev];
      if (role !== "ignore") {
        const dup = next.indexOf(role);
        if (dup >= 0 && dup !== colIndex) next[dup] = "ignore";
      }
      next[colIndex] = role;
      return next;
    });
  };

  const loadPdf = async (file) => {
    setError("");
    if (tooBig(file)) { setError(`PDF acima de ${MAX_FILE_MB} MB — o relatório do IBGE-PPP tem poucas páginas; confira o arquivo.`); return; }
    setPdfBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const { extractPppFromPdf } = await import("./ppp-pdf");
      const info = await extractPppFromPdf(buf);
      setPdfInfo(info);
      setPdfName(file.name);
      if (info.ok) {
        setPppE(f3(info.utmE));
        setPppN(f3(info.utmN));
        if (!isNaN(info.altOrto)) { setPppZ(f4(info.altOrto)); setZType("Ortométrica"); }
        else { setPppZ(f4(info.altGeo)); setZType("Geométrica"); }
        if (info.station) setBaseName(info.station);
      } else {
        setError("Não foi possível localizar as coordenadas no PDF. Confira se é o relatório do IBGE-PPP e, se necessário, digite os valores manualmente na aba 3.");
      }
    } catch (e) {
      setError("Falha ao ler o PDF: " + (e?.message || e) + ". Você pode digitar as coordenadas manualmente na aba 3.");
    } finally {
      setPdfBusy(false);
    }
  };

  const openNovaAntena = () => { setAntFormMode("nova"); setAntNome(""); setAntH0(""); setAntH1(""); setShowAntForm(true); };
  const openEditarAntena = () => { setAntFormMode("editar"); setAntNome(selAnt.nome); setAntH0(selAnt.apc || ""); setAntH1(""); setShowAntForm(true); };
  const salvarAntena = () => {
    const h0 = parseFloat(String(antH0).replace(",", "."));
    const h1 = parseFloat(String(antH1 || "0").replace(",", "."));
    if (!antNome.trim() || isNaN(h0)) return;
    const apc = (h0 + (isNaN(h1) ? 0 : h1)).toFixed(4);
    if (antFormMode === "nova") {
      const id = Math.max(...antennas.map((a) => a.id)) + 1;
      setAntennas([...antennas, { id, nome: antNome.trim(), apc, fonte: "Cadastrada pelo usuário (h0 + h1 do manual)" }]);
      setAntId(id);
    } else {
      setAntennas(antennas.map((a) => (a.id === antId ? { ...a, nome: antNome.trim(), apc, fonte: a.fonte + " · editada pelo usuário" } : a)));
    }
    setShowAntForm(false);
  };

  const onBaseChange = (i) => {
    setBaseIdx(i);
    const b = parsed.rows[i];
    if (!pdfInfo?.station) setBaseName(b.name || "BASE");
    if (!isNaN(b.antH)) setArp(String(b.antH));
  };

  const calc = useMemo(() => {
    if (!parsed || parsed.rows.length === 0) return null;
    const bi = Math.min(baseIdx, parsed.rows.length - 1);
    const base = parsed.rows[bi];
    const pE = parseFloat(String(pppE).replace(",", "."));
    const pN = parseFloat(String(pppN).replace(",", "."));
    const pZ = parseFloat(String(pppZ).replace(",", "."));
    const vArp = parseFloat(String(arp).replace(",", "."));
    const vApc = apcNum;
    const needArp = measureTo !== "reduzido";
    const needApc = measureTo === "arp";
    if ([pE, pN, pZ].some(isNaN) || (needArp && isNaN(vArp)) || (needApc && isNaN(vApc))) return { ready: false, base };
    const zBaseRed = measureTo === "arp" ? base.z - vArp - vApc : measureTo === "fase" ? base.z - vArp : base.z;
    const dE = pE - base.e;
    const dN = pN - base.n;
    const dZ = pZ - zBaseRed;
    const pts = parsed.rows.filter((_, i) => i !== bi).map((r) => ({ ...r, ce: r.e + dE, cn: r.n + dN, cz: r.z + dZ }));
    const fixed = pts.filter((p) => p.sol === "fixed").length;
    const float_ = pts.filter((p) => p.sol === "float").length;
    return { ready: true, base, zBaseRed, dE, dN, dZ, pts, fixed, float_, pE, pN, pZ, vArp, vApc };
  }, [parsed, baseIdx, pppE, pppN, pppZ, arp, apcNum, measureTo]);

  // ── OBSERVAÇÕES de baixa gravidade: divergências relatório PPP × configuração
  const observations = useMemo(() => {
    const obs = [];
    if (!calc?.ready || !pdfInfo?.ok) return obs;

    // 1. Antena declarada ao PPP × antena selecionada (só relevante no modo ARP)
    if (measureTo === "arp" && pdfInfo.antennaModel) {
      const pdfCore = normModel(pdfInfo.antennaModel);
      const matched = antennas.find((a) => {
        const an = normModel(a.nome);
        return pdfCore && an && (an.includes(pdfCore) || pdfCore.includes(an));
      });
      const isSame = matched && matched.id === antId;
      if (!isSame) {
        if (matched) {
          const apcM = parseFloat(matched.apc);
          const zredAlt = calc.base.z - calc.vArp - apcM;
          const dZAlt = calc.pZ - zredAlt;
          const impacto = dZAlt - calc.dZ;
          obs.push(
            `Antena declarada ao IBGE-PPP: ${pdfInfo.antennaModel} (perfil "${matched.nome}", APC ${matched.apc} m) — diferente da selecionada no app: "${selAnt.nome}" (APC ${selAnt.apc} m). ` +
            `Base e rover podem ser equipamentos distintos, mas a antena a selecionar aqui é a DA BASE (a que foi ao PPP). ` +
            `Se a base for a do relatório, o ΔZ passa de ${calc.dZ >= 0 ? "+" : ""}${f4(calc.dZ)} para ${dZAlt >= 0 ? "+" : ""}${f4(dZAlt)} m — as cotas de todos os pontos mudariam ${impacto >= 0 ? "+" : ""}${f4(impacto)} m.`
          );
        } else {
          obs.push(
            `Antena declarada ao IBGE-PPP: ${pdfInfo.antennaModel} — não corresponde a nenhum perfil cadastrado, e a selecionada no app é "${selAnt.nome}" (APC ${selAnt.apc} m). ` +
            `Confirme se o APC usado corresponde à antena que realmente ficou na base.`
          );
        }
      }
    }

    // 2. Altura declarada ao IBGE × ARP/altura informada no app
    if (measureTo !== "reduzido" && !isNaN(pdfInfo.antHeight) && !isNaN(calc.vArp)) {
      const diff = calc.vArp - pdfInfo.antHeight;
      if (Math.abs(diff) > 0.0005) {
        const dZAlt2 = calc.pZ - (measureTo === "arp" ? calc.base.z - pdfInfo.antHeight - calc.vApc : calc.base.z - pdfInfo.antHeight);
        obs.push(
          `Altura da antena declarada ao IBGE-PPP: ${f4(pdfInfo.antHeight)} m — diferente da informada no app: ${f4(calc.vArp)} m (Δ = ${diff >= 0 ? "+" : ""}${f4(diff)} m). ` +
          `A cota do marco no relatório PPP embute a altura declarada; confira na caderneta qual é a medida correta. ` +
          `Usando a altura do relatório, o ΔZ seria ${dZAlt2 >= 0 ? "+" : ""}${f4(dZAlt2)} m (diferença de ${f4(Math.abs(dZAlt2 - calc.dZ))} m nas cotas).`
        );
      }
    }

    // 3. Referência da altitude escolhida
    if (!isNaN(pdfInfo.altOrto) && !isNaN(pdfInfo.altGeo)) {
      const outra = zType === "Ortométrica"
        ? `Geométrica/elipsoidal (${f4(pdfInfo.altGeo)} m)`
        : `Normal/ortométrica (${f4(pdfInfo.altOrto)} m)`;
      obs.push(
        `Cotas de saída na referência ${zType} (Z do PPP = ${f4(calc.pZ)} m). Alternativa disponível no relatório: ${outra}. ` +
        `Confirme que o Z do arquivo bruto do coletor está na mesma referência escolhida — misturar referências desloca todas as cotas em ~${f4(Math.abs(pdfInfo.altGeo - pdfInfo.altOrto))} m (fator geoidal local).`
      );
    }

    return obs;
  }, [calc, pdfInfo, measureTo, antennas, antId, selAnt, zType]);

  const buildRows = () => {
    const head = ["PONTO", "DESCRICAO", "E", "N", `Z ${zType}`, "SIGMA E", "SIGMA N", "SIGMA Z", "SITUACAO", "ALTURA ANT", "DATA", "PDOP"];
    const sB = (v) => (pdfInfo?.ok && !isNaN(v) ? f3(v) : "0");
    const baseRow = [safeCell(baseName), safeCell(baseName), f3(calc.pE), f3(calc.pN), f4(calc.pZ), sB(pdfInfo?.sigmaLon), sB(pdfInfo?.sigmaLat), sB(pdfInfo?.sigmaAlt), "BASE", isNaN(calc.vArp) ? "" : f3(calc.vArp), pdfInfo?.dataInicio ?? "", "0"];
    const rows = calc.pts.map((p) => [safeCell(p.name), safeCell(p.code), f3(p.ce), f3(p.cn), f4(p.cz), f3(p.se), f3(p.sn), f3(p.sz), safeCell(p.sol), isNaN(p.antH) ? "" : f3(p.antH), safeCell(p.start), isNaN(p.pdop) ? "" : String(p.pdop)]);
    return [head, baseRow, ...rows];
  };

  const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
  const fbase = () => (fileName || "pontos").replace(/\.[^.]+$/, "");

  const exportCSV = () => download(`${fbase()}_ajustado.csv`, buildRows().map((r) => r.join(";")).join("\n"), "text/csv");
  const exportTXT = () => download(`${fbase()}_ajustado.txt`, buildRows().map((r) => r.join("\t")).join("\n"));

  const roleLabel = (k) => ROLES.find((r) => r.key === k)?.label ?? k;
  const measureLabel =
    measureTo === "arp" ? "até a base do receptor (ARP) — aplicado Z − ARP − APC" :
    measureTo === "fase" ? "até o centro de fase — aplicado Z − altura medida (APC embutido na medida)" :
    "arquivo já traz o Z da base no marco — sem redução";

  const exportMeta = () => {
    const c = calc;
    const mapDesc = colRoles.map((r, i) => `col${i + 1}=${roleLabel(r)}`).join(" | ");
    const meta = [
      "==========================================================",
      " METADADOS DO AJUSTE DE COORDENADAS — BASE PPP-IBGE",
      "==========================================================",
      `Gerado em............: ${stamp()}`,
      `Arquivo bruto RTK....: ${fileName}`,
      `Mapeamento de colunas: ${mapDesc}`,
      `Relatório PPP (PDF)..: ${pdfName || "não fornecido (coordenadas digitadas manualmente)"}`,
      ...(pdfInfo?.ok ? [
        `Marco (PPP)..........: ${pdfInfo.station ?? "-"}  |  Antena (PPP): ${pdfInfo.antennaModel ?? "-"}  |  Altura ant. (PPP): ${isNaN(pdfInfo.antHeight) ? "-" : f4(pdfInfo.antHeight)} m`,
        `Sigmas 95% (m).......: Lat=${isNaN(pdfInfo.sigmaLat) ? "-" : pdfInfo.sigmaLat}  Lon=${isNaN(pdfInfo.sigmaLon) ? "-" : pdfInfo.sigmaLon}  Alt=${isNaN(pdfInfo.sigmaAlt) ? "-" : pdfInfo.sigmaAlt}`,
        `Rastreio (PPP).......: início ${pdfInfo.dataInicio ?? "-"}  |  fim ${pdfInfo.dataFim ?? "-"}  |  duração ${pdfInfo.duracao ?? "-"}`,
        `Órbitas / altimetria.: ${pdfInfo.orbitas ?? "-"}  |  ${pdfInfo.geoidModel ?? "-"}`,
      ] : []),
      `Total de pontos......: ${c.pts.length} (fixed: ${c.fixed} | float: ${c.float_} | outros: ${c.pts.length - c.fixed - c.float_})`,
      "",
      "--- BASE ---",
      `Nome da base.........: ${baseName}`,
      `Coord. campo (bruta).: E=${f3(c.base.e)}  N=${f3(c.base.n)}  Z=${f4(c.base.z)}`,
      `Medida da altura.....: ${measureLabel}`,
      ...(measureTo !== "reduzido" ? [`Altura medida (m)....: ${f4(c.vArp)}`] : []),
      ...(measureTo === "arp" ? [
        `Antena...............: ${selAnt.nome}`,
        `Offset APC (m).......: ${f4(c.vApc)}  [${selAnt.fonte}]`,
      ] : []),
      `Z reduzido ao marco..: ${f4(c.zBaseRed)}`,
      `Coord. PPP-IBGE......: E=${f3(c.pE)}  N=${f3(c.pN)}  Z=${f4(c.pZ)} (${zType})`,
      "",
      "--- PARÂMETROS DE AJUSTAMENTO ---",
      `ΔE = ${c.dE >= 0 ? "+" : ""}${f4(c.dE)} m`,
      `ΔN = ${c.dN >= 0 ? "+" : ""}${f4(c.dN)} m`,
      `ΔZ = ${c.dZ >= 0 ? "+" : ""}${f4(c.dZ)} m`,
      `Deslocamento planim..: ${f4(Math.hypot(c.dE, c.dN))} m`,
      ...(observations.length > 0 ? [
        "",
        "--- OBSERVAÇÕES (baixa gravidade — conferir) ---",
        ...observations.map((o, i) => `${i + 1}. ${o}`),
      ] : []),
      "",
      "--- MÉTODO ---",
      "E' = E + ΔE | N' = N + ΔN | Z' = Z + ΔZ",
      "ΔE = E(PPP) − E(base campo)",
      "ΔN = N(PPP) − N(base campo)",
      "ΔZ = Z(PPP) − Z(base reduzido ao marco)",
      "Sigmas, solução (fixed/float), altura de antena e PDOP",
      "preservados do arquivo bruto.",
      "==========================================================",
    ].join("\n");
    download(`${fbase()}_metadados.txt`, meta);
  };

  const reset = () => {
    setRaw(null); setColRoles([]); setFileName(""); setPdfInfo(null); setPdfName("");
    setError(""); setPppE(""); setPppN(""); setPppZ(""); setBaseName("BASE"); setArp("");
    setMeasureTo("arp"); setTab(0);
  };

  const inputCls = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-800 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20";
  const label = "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";

  const UploadCard = ({ done, busy, icon: Icon, title, desc, hint, onPick, inputEl }) => (
    <button
      type="button"
      onClick={onPick}
      className={`relative flex flex-col items-center rounded-2xl border-2 border-dashed p-6 text-center transition-colors ${done ? "border-teal-500 bg-teal-50" : "border-slate-300 bg-white hover:border-teal-500"}`}
    >
      {inputEl}
      <Icon className={done ? "text-teal-700" : "text-slate-400"} size={30} />
      <p className="mt-2 text-sm font-semibold">{title}</p>
      <p className="mt-1 text-xs text-slate-500">{desc}</p>
      {busy && <p className="mt-2 text-xs font-semibold text-teal-700">Lendo PDF…</p>}
      {done && !busy && (
        <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-teal-700 px-2.5 py-0.5 text-[11px] font-semibold text-white">
          <CheckCircle2 size={12} /> {done}
        </span>
      )}
      {!done && !busy && <p className="mt-2 text-[11px] text-slate-400">{hint}</p>}
    </button>
  );

  const nCols = raw ? Math.max(...raw.matrix.map((r) => r.length)) : 0;
  const previewRows = raw ? raw.matrix.slice(0, 5) : [];
  const mappingOk = ["e", "n", "z"].every((k) => colRoles.includes(k));

  const tabEnabled = [
    true,
    !!raw,
    !!raw && mappingOk && (parsed?.rows.length ?? 0) > 0,
    !!raw && mappingOk && (parsed?.rows.length ?? 0) > 0,
    true,
  ];

  const bigDelta = calc?.ready && (Math.abs(calc.dE) > 10 || Math.abs(calc.dN) > 10 || Math.abs(calc.dZ) > 10);

  const NextBtn = ({ to, children }) => (
    <button
      onClick={() => setTab(to)}
      disabled={!tabEnabled[to]}
      className="mt-4 flex items-center gap-1.5 rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300"
    >
      {children} <ChevronRight size={15} />
    </button>
  );

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-700 text-white">
            <Crosshair size={22} strokeWidth={2.2} />
          </div>
          <div className="flex-1">
            <h1 className="text-lg font-bold leading-tight">Ajuste PPP</h1>
            <p className="text-xs text-slate-500">Correção de levantamentos GNSS RTK a partir de base ajustada pelo IBGE-PPP</p>
          </div>
          {(raw || pdfInfo) && (
            <button onClick={reset} className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
              <RefreshCw size={14} /> Recomeçar
            </button>
          )}
        </div>
        {/* Abas */}
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-5">
          {TAB_LABELS.map((t, i) => (
            <button
              key={t}
              onClick={() => tabEnabled[i] && setTab(i)}
              disabled={!tabEnabled[i]}
              className={`whitespace-nowrap rounded-t-lg border-x border-t px-4 py-2 text-xs font-semibold transition-colors ${
                tab === i
                  ? "border-slate-200 bg-slate-100 text-teal-800"
                  : tabEnabled[i]
                  ? "border-transparent text-slate-500 hover:bg-slate-50 hover:text-teal-700"
                  : "cursor-not-allowed border-transparent text-slate-300"
              }`}
            >
              {t}
              {i === 3 && observations.length > 0 && tabEnabled[3] && (
                <span className="ml-1.5 rounded-full bg-sky-100 px-1.5 text-[10px] text-sky-700">{observations.length}</span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl space-y-5 px-5 py-6">
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {/* ═══ ABA 1 · ARQUIVOS ═══ */}
        {tab === 0 && (
          <>
            <div className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
              <HelpCircle size={18} className="mt-0.5 shrink-0" />
              <div>
                <strong>Como funciona:</strong> envie <strong>2 arquivos</strong> — ① o <strong>PDF do relatório
                IBGE-PPP</strong> da sua base (o app lê e preenche as coordenadas corrigidas sozinho) e ② o
                <strong> TXT/CSV bruto do levantamento RTK</strong> exportado do coletor, em qualquer ordem de colunas.
                Nas abas seguintes você confere o mapeamento das colunas, valida a base e a antena, e baixa os pontos
                ajustados com os metadados do processo. Tudo roda no seu navegador — nada é enviado a servidores.
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <UploadCard
                done={pdfName && pdfInfo?.ok ? pdfName : pdfName ? pdfName + " (verifique)" : ""}
                busy={pdfBusy}
                icon={Satellite}
                title="① Relatório IBGE-PPP da base (PDF)"
                desc="O PDF que o IBGE envia por e-mail após o processamento. Extraímos coordenadas, sigmas e rastreio automaticamente."
                hint="Opcional: se preferir, digite as coordenadas na aba 3."
                onPick={() => pdfRef.current?.click()}
                inputEl={<input ref={pdfRef} type="file" accept=".pdf" className="hidden" onChange={(e) => e.target.files[0] && loadPdf(e.target.files[0])} />}
              />
              <UploadCard
                done={raw ? `${fileName} · ${parsed?.rows.length ?? 0} pontos` : ""}
                icon={Upload}
                title="② Dados brutos RTK (TXT ou CSV)"
                desc="Export do coletor com todos os pontos do levantamento, incluindo a linha da base."
                hint="Qualquer ordem de colunas — você confere o mapeamento na aba 2."
                onPick={() => txtRef.current?.click()}
                inputEl={<input ref={txtRef} type="file" accept=".txt,.csv,.tsv" className="hidden" onChange={(e) => e.target.files[0] && loadTxt(e.target.files[0])} />}
              />
            </div>

            {pdfInfo?.ok && (
              <div className="rounded-xl border border-teal-200 bg-white p-4 text-sm">
                <p className="mb-2 flex items-center gap-2 font-semibold text-teal-800">
                  <FileDown size={15} /> Lido do relatório IBGE-PPP{pdfInfo.station ? ` — marco ${pdfInfo.station}` : ""}{pdfInfo.dataInicio ? ` (${pdfInfo.dataInicio})` : ""}:
                </p>
                <div className="grid grid-cols-2 gap-2 font-mono text-xs md:grid-cols-4">
                  <div className="rounded bg-slate-50 p-2">UTM E: <strong>{f3(pdfInfo.utmE)}</strong></div>
                  <div className="rounded bg-slate-50 p-2">UTM N: <strong>{f3(pdfInfo.utmN)}</strong></div>
                  <div className="rounded bg-slate-50 p-2">Alt. Normal: <strong>{isNaN(pdfInfo.altOrto) ? "—" : f4(pdfInfo.altOrto)}</strong></div>
                  <div className="rounded bg-slate-50 p-2">Alt. Geo.: <strong>{isNaN(pdfInfo.altGeo) ? "—" : f4(pdfInfo.altGeo)}</strong></div>
                  {pdfInfo.antennaModel && <div className="rounded bg-slate-50 p-2">Antena: <strong>{pdfInfo.antennaModel}</strong></div>}
                  {!isNaN(pdfInfo.antHeight) && <div className="rounded bg-slate-50 p-2">Altura ant.: <strong>{f4(pdfInfo.antHeight)}</strong></div>}
                  {(!isNaN(pdfInfo.sigmaLon) || !isNaN(pdfInfo.sigmaLat) || !isNaN(pdfInfo.sigmaAlt)) && (
                    <div className="rounded bg-slate-50 p-2">σ95% E/N/h: <strong>{isNaN(pdfInfo.sigmaLon) ? "—" : pdfInfo.sigmaLon} / {isNaN(pdfInfo.sigmaLat) ? "—" : pdfInfo.sigmaLat} / {isNaN(pdfInfo.sigmaAlt) ? "—" : pdfInfo.sigmaAlt}</strong></div>
                  )}
                  {pdfInfo.duracao && <div className="rounded bg-slate-50 p-2">Rastreio: <strong>{pdfInfo.duracao}</strong></div>}
                  {pdfInfo.orbitas && <div className="rounded bg-slate-50 p-2">Órbitas: <strong>{pdfInfo.orbitas}</strong></div>}
                  {pdfInfo.geoidModel && <div className="rounded bg-slate-50 p-2">Geoide: <strong>{pdfInfo.geoidModel}</strong></div>}
                </div>
              </div>
            )}
            {raw && <NextBtn to={1}>Conferir colunas</NextBtn>}
          </>
        )}

        {/* ═══ ABA 2 · COLUNAS ═══ */}
        {tab === 1 && raw && (
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="mb-1 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-teal-800">
              <Table2 size={15} /> Confira o mapeamento das colunas
            </h2>
            <p className="mb-3 text-xs text-slate-500">
              Identificamos automaticamente o que cada coluna do arquivo <span className="font-mono">{fileName}</span> representa.
              <strong> Confira os títulos dos seletores com os valores das primeiras linhas</strong> e corrija se
              necessário — cada software de coletor exporta numa ordem diferente. É obrigatório ter Este, Norte e Altitude mapeados.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-xs">
                <thead>
                  <tr>
                    {Array.from({ length: nCols }, (_, c) => (
                      <th key={c} className="min-w-32 px-1 pb-2">
                        <select
                          value={colRoles[c] ?? "ignore"}
                          onChange={(e) => setRole(c, e.target.value)}
                          className={`w-full rounded-md border px-1.5 py-1 text-[11px] font-sans font-semibold ${(colRoles[c] ?? "ignore") === "ignore" ? "border-slate-200 bg-slate-50 text-slate-400" : "border-teal-300 bg-teal-50 text-teal-800"}`}
                        >
                          {ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                        </select>
                        {raw.header && <div className="mt-1 truncate px-1 text-[10px] font-normal text-slate-400">{raw.header[c]}</div>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      {Array.from({ length: nCols }, (_, c) => (
                        <td key={c} className="whitespace-nowrap px-2 py-1 text-slate-600">{r[c] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!mappingOk && (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                Mapeie as colunas <strong>Este</strong>, <strong>Norte</strong> e <strong>Altitude</strong> para continuar.
              </div>
            )}
            {mappingOk && parsed?.skipped?.length > 0 && (
              <p className="mt-2 text-xs text-amber-600">{parsed.skipped.length} linha(s) ignorada(s) por falta de coordenadas válidas.</p>
            )}
            <NextBtn to={2}>Validar base e coordenadas PPP</NextBtn>
          </section>
        )}

        {/* ═══ ABA 3 · BASE & PPP ═══ */}
        {tab === 2 && raw && mappingOk && parsed?.rows.length > 0 && (
          <>
            <section className="grid gap-5 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-teal-800">Base observada em campo</h2>
                <p className="mb-3 text-xs text-slate-500">Confirme o ponto da base, como a altura foi medida e a antena usada na base.</p>
                <div className="mb-3">
                  <label className={label}>Ponto da base (do arquivo bruto)</label>
                  <select value={baseIdx} onChange={(e) => onBaseChange(Number(e.target.value))} className={inputCls}>
                    {parsed.rows.map((r, i) => (
                      <option key={i} value={i}>{r.name} — {r.code || r.sol} ({f3(r.e)}; {f3(r.n)})</option>
                    ))}
                  </select>
                </div>
                <div className="mb-3 rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-600">
                  E {f3(parsed.rows[Math.min(baseIdx, parsed.rows.length - 1)].e)} · N {f3(parsed.rows[Math.min(baseIdx, parsed.rows.length - 1)].n)} · Z {f4(parsed.rows[Math.min(baseIdx, parsed.rows.length - 1)].z)}
                </div>

                <div className="mb-3">
                  <label className={label}>A altura da base foi medida do marco no chão até…</label>
                  <select value={measureTo} onChange={(e) => setMeasureTo(e.target.value)} className={inputCls}>
                    <option value="arp">…a base do receptor (ARP) — o app soma o APC da antena</option>
                    <option value="fase">…o centro de fase — a medida já inclui a antena</option>
                    <option value="reduzido">O arquivo já traz o Z da base no marco — não reduzir</option>
                  </select>
                </div>

                {measureTo !== "reduzido" && (
                  <div className="mb-3 grid grid-cols-2 gap-3">
                    <div>
                      <label className={label}>{measureTo === "fase" ? "Altura medida (m)" : "ARP campo (m)"}</label>
                      <input value={arp} onChange={(e) => setArp(e.target.value)} className={inputCls} placeholder="1.895" />
                      <p className="mt-1 text-[10px] leading-tight text-slate-400">Distância vertical. Se mediu inclinada, converta: v = √(s² − L²), com L da antena.</p>
                    </div>
                    {measureTo === "arp" && (
                      <div>
                        <label className={label}>Antena da base</label>
                        <select value={antId} onChange={(e) => setAntId(Number(e.target.value))} className={inputCls}>
                          {antennas.map((a) => (
                            <option key={a.id} value={a.id}>{a.nome}{a.apc ? ` — APC ${a.apc} m` : " — sem APC"}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}

                {measureTo === "arp" && (
                  <>
                    <div className={`mb-3 flex items-start gap-2 rounded-lg border p-3 text-xs ${selAnt.apc ? "border-amber-200 bg-amber-50 text-amber-800" : "border-red-200 bg-red-50 text-red-700"}`}>
                      <ShieldAlert size={16} className="mt-0.5 shrink-0" />
                      <div>
                        {selAnt.apc ? (
                          <>
                            <strong>Confira se esta é a antena que ficou NA BASE</strong> (a que foi ao PPP — o rover pode ser
                            outro equipamento). O APC de {selAnt.apc} m vale para {selAnt.nome} ({selAnt.fonte}). Um APC
                            errado desloca a altitude de todos os pontos.
                          </>
                        ) : (
                          <>
                            <strong>{selAnt.nome} está sem parâmetro APC.</strong> {selAnt.fonte}. Use "Editar" abaixo para
                            informar h0 e h1 conforme o manual do seu equipamento.
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button onClick={openNovaAntena} className="flex items-center gap-1.5 rounded-lg border border-teal-700 px-3 py-1.5 text-xs font-semibold text-teal-800 hover:bg-teal-50">
                        <Plus size={13} /> Nova antena
                      </button>
                      <button onClick={openEditarAntena} className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                        <Pencil size={13} /> Editar selecionada
                      </button>
                    </div>

                    {showAntForm && (
                      <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                          {antFormMode === "nova" ? "Cadastrar antena" : `Editar: ${selAnt.nome}`}
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          <div className="col-span-2">
                            <label className={label}>Modelo / nome</label>
                            <input value={antNome} onChange={(e) => setAntNome(e.target.value)} className={inputCls} placeholder="Ex.: CHC i73+" />
                          </div>
                          <div>
                            <label className={label}>h0 ou APC total (m)</label>
                            <input value={antH0} onChange={(e) => setAntH0(e.target.value)} className={inputCls} placeholder="0.0411" />
                          </div>
                          <div>
                            <label className={label}>h1 (m, opcional)</label>
                            <input value={antH1} onChange={(e) => setAntH1(e.target.value)} className={inputCls} placeholder="0.038" />
                          </div>
                        </div>
                        <p className="mt-2 text-[11px] text-slate-400">APC final = h0 + h1. Se seu manual dá um valor único do ARP ao centro de fase (ex.: HL1 na etiqueta), informe-o em h0 e deixe h1 vazio.</p>
                        <div className="mt-2 flex gap-2">
                          <button onClick={salvarAntena} className="rounded-lg bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-800">Salvar</button>
                          <button onClick={() => setShowAntForm(false)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-white">Cancelar</button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-teal-800">Coordenadas PPP-IBGE da base</h2>
                <p className="mb-3 text-xs text-slate-500">{pdfInfo?.ok ? "Preenchido automaticamente a partir do PDF — confira e ajuste se necessário." : "Sem PDF? Digite aqui os valores do relatório IBGE-PPP."}</p>
                <div className="mb-3">
                  <label className={label}>Nome da base no relatório</label>
                  <input value={baseName} onChange={(e) => setBaseName(e.target.value)} className={inputCls} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={label}>UTM E (m)</label>
                    <input value={pppE} onChange={(e) => setPppE(e.target.value)} className={inputCls} placeholder="347204.008" />
                  </div>
                  <div>
                    <label className={label}>UTM N (m)</label>
                    <input value={pppN} onChange={(e) => setPppN(e.target.value)} className={inputCls} placeholder="7444262.734" />
                  </div>
                  <div>
                    <label className={label}>Altitude (m)</label>
                    <input value={pppZ} onChange={(e) => setPppZ(e.target.value)} className={inputCls} placeholder="452.570" />
                  </div>
                  <div>
                    <label className={label}>Tipo de altitude</label>
                    <select value={zType} onChange={(e) => setZType(e.target.value)} className={inputCls}>
                      <option>Ortométrica</option>
                      <option>Geométrica</option>
                    </select>
                  </div>
                </div>
                {pdfInfo?.ok && !isNaN(pdfInfo.altOrto) && !isNaN(pdfInfo.altGeo) && (
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                    <button onClick={() => { setPppZ(f4(pdfInfo.altOrto)); setZType("Ortométrica"); }} className={`rounded-full px-2.5 py-1 font-semibold ${zType === "Ortométrica" ? "bg-teal-700 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>Usar Alt. Normal/ortométrica ({f4(pdfInfo.altOrto)})</button>
                    <button onClick={() => { setPppZ(f4(pdfInfo.altGeo)); setZType("Geométrica"); }} className={`rounded-full px-2.5 py-1 font-semibold ${zType === "Geométrica" ? "bg-teal-700 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>Usar Alt. Geométrica ({f4(pdfInfo.altGeo)})</button>
                  </div>
                )}
                <p className="mt-2 text-xs text-slate-400">A altitude ajustada dos pontos sairá no mesmo referencial escolhido aqui. Use a mesma referência (elipsoidal × ortométrica) do Z do arquivo bruto do coletor.</p>
              </div>
            </section>
            <NextBtn to={3}>Ver resultados</NextBtn>
          </>
        )}

        {/* ═══ ABA 4 · RESULTADOS ═══ */}
        {tab === 3 && raw && mappingOk && parsed?.rows.length > 0 && (
          <>
            {calc?.ready ? (
              <>
                <section className="rounded-2xl border border-teal-200 bg-teal-50 p-5">
                  <div className="mb-3 flex items-center gap-2">
                    <CheckCircle2 size={18} className="text-teal-700" />
                    <h2 className="text-sm font-bold uppercase tracking-wide text-teal-800">Parâmetros calculados e exportação</h2>
                  </div>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                    {[["ΔE", calc.dE], ["ΔN", calc.dN], ["ΔZ", calc.dZ], ["Desloc. planim.", Math.hypot(calc.dE, calc.dN)], ["Z base reduzido", calc.zBaseRed]].map(([k, v]) => (
                      <div key={k} className="rounded-lg bg-white p-3 text-center">
                        <div className="text-xs font-semibold text-slate-500">{k}</div>
                        <div className="font-mono text-lg font-bold text-teal-900">{v >= 0 && (k === "ΔE" || k === "ΔN" || k === "ΔZ") ? "+" : ""}{f4(v)}</div>
                        <div className="text-[10px] text-slate-400">metros</div>
                      </div>
                    ))}
                  </div>
                  {bigDelta && (
                    <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                      <span><strong>Correção muito grande (&gt; 10 m).</strong> Isso geralmente indica coordenadas erradas, ponto de base incorreto ou mapeamento de colunas trocado. Confira as abas anteriores antes de usar o resultado.</span>
                    </div>
                  )}
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <button onClick={exportCSV} className="flex items-center gap-2 rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800">
                      <Download size={15} /> Baixar CSV ajustado
                    </button>
                    <button onClick={exportTXT} className="flex items-center gap-2 rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800">
                      <Download size={15} /> Baixar TXT ajustado
                    </button>
                    <button onClick={exportMeta} className="flex items-center gap-2 rounded-lg border border-teal-700 px-4 py-2 text-sm font-semibold text-teal-800 hover:bg-white">
                      <FileText size={15} /> Baixar metadados
                    </button>
                    <span className="ml-auto text-xs text-slate-500">
                      {calc.pts.length} pontos · {calc.fixed} fixed · {calc.float_} float
                    </span>
                  </div>
                </section>

                {observations.length > 0 && (
                  <section className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
                    <div className="mb-2 flex items-center gap-2">
                      <Info size={16} className="text-sky-700" />
                      <h2 className="text-sm font-bold uppercase tracking-wide text-sky-800">Observações · baixa gravidade — conferir</h2>
                    </div>
                    <p className="mb-3 text-xs text-sky-700">Divergências entre o relatório PPP e a configuração do ajuste. Não impedem o uso, mas explicam pequenas diferenças nas cotas — os deltas de impacto estão indicados. Estas observações também saem no arquivo de metadados.</p>
                    <ol className="space-y-2 text-xs text-sky-900">
                      {observations.map((o, i) => (
                        <li key={i} className="rounded-lg bg-white/70 p-3 leading-relaxed">{i + 1}. {o}</li>
                      ))}
                    </ol>
                  </section>
                )}

                <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                  <div className="border-b border-slate-100 px-5 py-3 text-sm font-bold uppercase tracking-wide text-teal-800">
                    Prévia das coordenadas ajustadas
                  </div>
                  <div className="max-h-96 overflow-auto">
                    <table className="w-full text-left font-mono text-xs">
                      <thead className="sticky top-0 bg-slate-50 text-slate-500">
                        <tr>
                          {["Ponto", "Descrição", "E (m)", "N (m)", `Z ${zType} (m)`, "σE", "σN", "σZ", "Sol.", "Alt. ant.", "PDOP"].map((h) => (
                            <th key={h} className="whitespace-nowrap px-3 py-2 font-semibold">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-t border-slate-100 bg-amber-50/60 font-semibold text-amber-900">
                          <td className="px-3 py-1.5">{baseName}</td><td className="px-3 py-1.5">BASE (PPP)</td>
                          <td className="px-3 py-1.5">{f3(calc.pE)}</td><td className="px-3 py-1.5">{f3(calc.pN)}</td>
                          <td className="px-3 py-1.5">{f4(calc.pZ)}</td>
                          <td className="px-3 py-1.5">{pdfInfo?.ok && !isNaN(pdfInfo.sigmaLon) ? pdfInfo.sigmaLon : "0"}</td>
                          <td className="px-3 py-1.5">{pdfInfo?.ok && !isNaN(pdfInfo.sigmaLat) ? pdfInfo.sigmaLat : "0"}</td>
                          <td className="px-3 py-1.5">{pdfInfo?.ok && !isNaN(pdfInfo.sigmaAlt) ? pdfInfo.sigmaAlt : "0"}</td>
                          <td className="px-3 py-1.5">BASE</td>
                          <td className="px-3 py-1.5">{isNaN(calc.vArp) ? "—" : f3(calc.vArp)}</td>
                          <td className="px-3 py-1.5">—</td>
                        </tr>
                        {calc.pts.map((p, i) => (
                          <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                            <td className="px-3 py-1.5">{p.name}</td>
                            <td className="px-3 py-1.5 text-slate-500">{p.code}</td>
                            <td className="px-3 py-1.5">{f3(p.ce)}</td>
                            <td className="px-3 py-1.5">{f3(p.cn)}</td>
                            <td className="px-3 py-1.5">{f4(p.cz)}</td>
                            <td className="px-3 py-1.5 text-slate-400">{f3(p.se)}</td>
                            <td className="px-3 py-1.5 text-slate-400">{f3(p.sn)}</td>
                            <td className="px-3 py-1.5 text-slate-400">{f3(p.sz)}</td>
                            <td className={`px-3 py-1.5 font-semibold ${p.sol === "fixed" ? "text-teal-700" : p.sol === "float" ? "text-amber-600" : "text-slate-500"}`}>{p.sol}</td>
                            <td className="px-3 py-1.5 text-slate-400">{isNaN(p.antH) ? "" : f3(p.antH)}</td>
                            <td className="px-3 py-1.5 text-slate-400">{isNaN(p.pdop) ? "" : p.pdop}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            ) : (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
                Para calcular, complete na aba 3: coordenadas PPP{measureTo !== "reduzido" ? ", altura medida" : ""}{measureTo === "arp" ? " e antena com APC" : ""}.
              </div>
            )}
          </>
        )}

        {/* ═══ ABA 5 · DESENHOS ═══ */}
        {tab === 4 && (
          <section className="flex flex-col items-center rounded-2xl border border-dashed border-slate-300 bg-white p-16 text-center">
            <Map size={40} className="text-slate-300" />
            <h2 className="mt-4 text-lg font-bold text-slate-600">Desenhos das linhas de base</h2>
            <p className="mt-2 max-w-md text-sm text-slate-500">
              Visualização das linhas de base (base → pontos) e exportação para <strong>KML</strong> (Google Earth) e
              <strong> DXF</strong> (CAD, com layers de pontos, textos e vetores).
            </p>
            <span className="mt-5 rounded-full bg-teal-50 px-4 py-1.5 text-sm font-semibold text-teal-700">
              Em desenvolvimento. Aguarde!
            </span>
          </section>
        )}

        <footer className="pb-6 pt-2 text-center text-[11px] text-slate-400">
          Método: E′ = E + ΔE · N′ = N + ΔN · Z′ = Z + ΔZ, com ΔZ = Z(PPP) − Z(base reduzido ao marco). Processamento 100% local no navegador.
        </footer>
      </main>
    </div>
  );
}

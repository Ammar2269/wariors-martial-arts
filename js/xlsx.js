// Builds real Excel files (.xlsx) in the browser, with no library and nothing sent anywhere.
// A sheet is { name, rows, cols: [widths], freeze: rows to keep at the top, merges: ["A1:F1"], filter: "A3:H40", landscape }.
// A cell is a value (string, number, null) or { v, s, f }: s is a style name (see STYLES), f a formula without "=".
// Text like 2026-10-29 becomes a real Excel date. Formulas keep their worked-out value, so any viewer shows the numbers.

const STYLES = ["", "title", "head", "money", "date", "total", "totalMoney", "bold", "muted", "headNum", "grand", "int", "section", "boldMoney", "wrap"];
const S = Object.fromEntries(STYLES.map((n, i) => [n, i]));

const xml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
export const colName = i => { let s = ""; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
export const cellRef = (col, row) => `${colName(col)}${row + 1}`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const serial = iso => { const [y, m, d] = iso.split("-").map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5; };

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]\\-#,##0.00"/><numFmt numFmtId="165" formatCode="d mmm yyyy"/><numFmt numFmtId="166" formatCode="0"/></numFmts>
<fonts count="5"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="15"/><color rgb="FFB84A17"/><name val="Calibri"/><family val="2"/></font><font><i/><sz val="10"/><color rgb="FF6B6B6B"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF3A3A40"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFDEEE5"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="4"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF9A9A9A"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color auto="1"/></top><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color auto="1"/></top><bottom style="double"><color auto="1"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${STYLES.length}">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="164" fontId="1" fillId="0" borderId="3" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function sheetXml(sh, strings) {
  const sid = s => { if (!strings.map.has(s)) { strings.map.set(s, strings.list.length); strings.list.push(s); } return strings.map.get(s); };
  let maxCol = 0;
  const rows = sh.rows.map((row, r) => {
    const cells = (row || []).map((cell, c) => {
      if (cell == null || cell === "") return "";
      const o = typeof cell === "object" ? cell : { v: cell };
      let v = o.v, s = S[o.s] || 0;
      const at = cellRef(c, r);
      maxCol = Math.max(maxCol, c);
      if (typeof v === "string" && DATE.test(v)) { v = serial(v); if (!o.s) s = S.date; }
      const st = s ? ` s="${s}"` : "";
      if (o.f) return `<c r="${at}"${st}${typeof v === "string" ? ' t="str"' : ""}><f>${xml(o.f)}</f>${v == null || v === "" ? "" : `<v>${xml(v)}</v>`}</c>`;
      if (typeof v === "number") return Number.isFinite(v) ? `<c r="${at}"${st}><v>${v}</v></c>` : "";
      if (typeof v === "boolean") return `<c r="${at}"${st} t="b"><v>${v ? 1 : 0}</v></c>`;
      if (v == null || v === "") return s ? `<c r="${at}"${st}/>` : "";
      return `<c r="${at}"${st} t="s"><v>${sid(String(v))}</v></c>`;
    }).join("");
    return cells ? `<row r="${r + 1}">${cells}</row>` : "";
  }).join("");
  const last = cellRef(Math.max(maxCol, (sh.cols || []).length - 1), Math.max(0, sh.rows.length - 1));
  const freeze = sh.freeze ? `<pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sh.freeze + 1}" sqref="A${sh.freeze + 1}"/>` : "";
  const cols = (sh.cols || []).length ? `<cols>${sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const merges = (sh.merges || []).length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map(m => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${last}"/>
<sheetViews><sheetView workbookViewId="0"${sh.tabSelected ? ' tabSelected="1"' : ""}>${freeze}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rows}</sheetData>${sh.filter ? `<autoFilter ref="${sh.filter}"/>` : ""}${merges}
<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="${sh.landscape ? "landscape" : "portrait"}" fitToWidth="1" fitToHeight="0"/>
<headerFooter><oddFooter>${xml(`&L${sh.footer || ""}&RPage &P of &N`)}</oddFooter></headerFooter>
</worksheet>`;
}

// Sheet names: at most 31 characters, none of []:*?/\ and each one different.
function sheetNames(sheets) {
  const seen = new Set();
  return sheets.map((sh, i) => {
    let base = String(sh.name || `Sheet${i + 1}`).replace(/[[\]:*?/\\]/g, "-").replace(/^'+|'+$/g, "").slice(0, 31).trim() || `Sheet${i + 1}`;
    let n = base, k = 2;
    while (seen.has(n.toLowerCase())) n = `${base.slice(0, 28)} ${k++}`;
    seen.add(n.toLowerCase());
    return n;
  });
}

export function buildXlsx(sheets, { title = "", author = "" } = {}) {
  const strings = { list: [], map: new Map() };
  const names = sheetNames(sheets);
  const sheetFiles = sheets.map(sh => sheetXml(sh, strings));
  const q = n => `'${n.replace(/'/g, "''")}'`;
  const abs = ref => ref.split(":").map(p => p.replace(/^([A-Z]+)(\d+)$/, "$$$1$$$2")).join(":");
  const defined = sheets.map((sh, i) => sh.filter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xml(`${q(names[i])}!${abs(sh.filter)}`)}</definedName>` : "").join("");
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>${xml(author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
    "docProps/app.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${names.map((n, i) => `<sheet name="${xml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${defined ? `<definedNames>${defined}</definedNames>` : ""}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    "xl/styles.xml": stylesXml()
  };
  sheetFiles.forEach((x, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = x; });
  files["xl/sharedStrings.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.list.length}" uniqueCount="${strings.list.length}">${strings.list.map(s => `<si><t xml:space="preserve">${xml(s)}</t></si>`).join("")}</sst>`;
  return zip(files);
}

// ---------- ZIP (stored, no compression: the files are small) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function zip(files) {
  const enc = new TextEncoder();
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameB = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, nameB.length, 2], [28, 0, 2]]
      .forEach(([o, v, n]) => n === 4 ? head.setUint32(o, v, true) : head.setUint16(o, v, true));
    const cd = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, nameB.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
      .forEach(([o, v, n]) => n === 4 ? cd.setUint32(o, v, true) : cd.setUint16(o, v, true));
    parts.push(new Uint8Array(head.buffer), nameB, data);
    central.push(new Uint8Array(cd.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cdSize = central.reduce((t, b) => t + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  const count = Object.keys(files).length;
  [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, count, 2], [10, count, 2], [12, cdSize, 4], [16, offset, 4], [20, 0, 2]]
    .forEach(([o, v, n]) => n === 4 ? end.setUint32(o, v, true) : end.setUint16(o, v, true));
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((t, b) => t + b.length, 0));
  let p = 0;
  for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// A simple table as a workbook: a title line, bold headings, then the rows. cols: [[heading, value(row) | key, kind?]]
// kind "money" sums the column at the bottom; "date" and "int" just format it.
export function tableSheet({ name, title, cols, rows, note = "", total = true }) {
  const head = cols.map(c => ({ v: c[0], s: c[2] === "money" || c[2] === "int" ? "headNum" : "head" }));
  const top = [[{ v: title || name, s: "title" }], note ? [{ v: note, s: "muted" }] : [], head];
  const first = top.length;
  const body = rows.map(r => cols.map(c => {
    const v = typeof c[1] === "function" ? c[1](r) : r[c[1]];
    if (c[2] === "money") return v === "" || v == null ? null : { v: Number(v) || 0, s: "money" };
    if (c[2] === "int") return v === "" || v == null ? null : { v: Number(v) || 0, s: "int" };
    return Array.isArray(v) ? v.join("; ") : v;
  }));
  const sums = total && cols.some(c => c[2] === "money") && rows.length
    ? [[{ v: "Total", s: "total" }, ...cols.slice(1).map((c, i) => c[2] === "money"
      ? { f: `SUBTOTAL(9,${cellRef(i + 1, first)}:${cellRef(i + 1, first + rows.length - 1)})`, v: rows.reduce((t, r) => t + (Number(typeof c[1] === "function" ? c[1](r) : r[c[1]]) || 0), 0), s: "totalMoney" }
      : { v: "", s: "total" })]]
    : [];
  const widths = cols.map((c, i) => Math.min(48, Math.max(c[0].length + 3, c[2] === "money" ? 13 : c[2] === "date" ? 13 : 8, ...body.slice(0, 300).map(r => String(r[i]?.v ?? r[i] ?? "").length + 2))));
  return { name, rows: [...top, ...body, ...sums], cols: widths, freeze: first, filter: rows.length ? `A${first}:${colName(cols.length - 1)}${first + rows.length}` : "" };
}

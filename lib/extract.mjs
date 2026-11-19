// 첨부 문서에서 글자만 뽑기 · Claude 가 직접 못 읽는 형식을 .txt 로 바꿔 둔다 (토큰 사용 없음)
//   pptx · docx · xlsx · hwpx : zip 안의 XML      hwp : OLE 복합 문서(한글 5.0)      doc : macOS textutil
//   xls · ppt(옛 형식)는 읽지 못함 -> "읽지 못함"으로 알림
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const EXTRACT_EXT = /\.(pptx|docx|xlsx|hwpx|hwp|doc|xls|ppt)$/i;
export const LEGACY_UNSUPPORTED = /\.(xls|ppt)$/i;

// ---------- zip ----------
// zip 폭탄 방지: 항목 하나는 풀어서 20MB, 전체는 60MB까지만 (넘으면 UNZIP_LIMIT 오류)
const UNZIP_MAX_ENTRY = 20 * 1024 * 1024;
const UNZIP_MAX_TOTAL = 60 * 1024 * 1024;
const LIMIT = () => new Error("UNZIP_LIMIT");
export function unzipEntries(buf, want) {
  const out = {};
  let total = 0, eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    if (want.test(name) && local + 30 <= buf.length) {
      const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(dataStart, dataStart + csize);
      let data;
      try { data = method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: UNZIP_MAX_ENTRY }) : raw; }
      catch (e) { if (e && (e.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|too large/i.test(String(e.message)))) throw LIMIT(); data = null; }
      if (data) {
        total += data.length;
        if (data.length > UNZIP_MAX_ENTRY || total > UNZIP_MAX_TOTAL) throw LIMIT();
        out[name] = data;
      }
    }
    p += 46 + nlen + elen + clen;
  }
  return out;
}
const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&");
// <tag>글자</tag> 를 모두 꺼낸다. 안쪽에 다른 태그가 있으면 지운다(한글 문서의 탭·각주 표시 등)
const xmlText = (x, tag) => [...x.toString("utf8").matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => unxml(m[1].replace(/<[^>]+>/g, "")));
const num = (s) => Number((s.match(/(\d+)\.xml$/) || [, 0])[1]);
const byNum = (a, b) => num(a) - num(b);

function officeText(file, buf) {
  if (/\.pptx$/i.test(file)) {
    const z = unzipEntries(buf, /^ppt\/slides\/slide\d+\.xml$/);
    return Object.keys(z).sort(byNum).map((k) => `## 슬라이드 ${num(k)}\n` + xmlText(z[k].toString("utf8").replace(/<\/a:p>/g, "<a:t>\n</a:t>"), "a:t").join("")).join("\n\n");
  }
  if (/\.docx$/i.test(file)) {
    const z = unzipEntries(buf, /^word\/document\.xml$/);
    return z["word/document.xml"] ? xmlText(z["word/document.xml"].toString("utf8").replace(/<\/w:p>/g, "<w:t>\n</w:t>"), "w:t").join("") : null;
  }
  if (/\.xlsx$/i.test(file)) {
    const z = unzipEntries(buf, /^xl\/(worksheets\/sheet\d+|sharedStrings)\.xml$/);
    const shared = z["xl/sharedStrings.xml"] ? [...z["xl/sharedStrings.xml"].toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1], "t").join("")) : [];
    return Object.keys(z).filter((k) => /sheet\d+\.xml$/.test(k)).sort(byNum).map((k) => {
      const rows = [...z[k].toString("utf8").matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
        [...r[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
          const v = ((c[2] || "").match(/<v>([^<]*)<\/v>/) || [])[1];
          if (/t="s"/.test(c[1])) return shared[Number(v)] ?? "";
          if (/t="inlineStr"/.test(c[1])) return xmlText(c[2] || "", "t").join("");
          return v != null ? unxml(v) : "";
        }).join("\t"));
      return `## 시트 ${num(k)}\n` + rows.join("\n");
    }).join("\n\n");
  }
  if (/\.hwpx$/i.test(file)) {
    const z = unzipEntries(buf, /^Contents\/section\d+\.xml$/);
    return Object.keys(z).sort(byNum).map((k) => xmlText(z[k].toString("utf8").replace(/<hp:tab\b[^>]*\/>/g, "\t").replace(/<\/hp:p>/g, "<hp:t>\n</hp:t>"), "hp:t").join("")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  return null;
}

// ---------- OLE 복합 문서(CFB) 읽기: 한글 5.0(.hwp) 용 ----------
export function readCfb(buf) {
  if (buf.length < 512 || buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) throw new Error("OLE 형식이 아님");
  const secSize = 1 << buf.readUInt16LE(30), miniSize = 1 << buf.readUInt16LE(32);
  const dirStart = buf.readUInt32LE(48), cutoff = buf.readUInt32LE(56);
  const miniFatStart = buf.readUInt32LE(60), difatStart = buf.readUInt32LE(68), difatCount = buf.readUInt32LE(72);
  const END = 0xfffffffa;
  const sector = (n) => { const o = (n + 1) * secSize; if (o >= buf.length) throw new Error("손상된 OLE"); return buf.subarray(o, Math.min(o + secSize, buf.length)); };
  // FAT 섹터 목록(DIFAT)
  const fatSecs = [];
  for (let i = 0; i < 109; i++) { const s = buf.readUInt32LE(76 + i * 4); if (s < END) fatSecs.push(s); }
  for (let s = difatStart, k = 0; s < END && k < difatCount; k++) {
    const d = sector(s), per = secSize / 4 - 1;
    for (let i = 0; i < per; i++) { const v = d.readUInt32LE(i * 4); if (v < END) fatSecs.push(v); }
    s = d.readUInt32LE(per * 4);
  }
  const fat = [];
  for (const s of fatSecs) { const d = sector(s); for (let i = 0; i + 4 <= d.length; i += 4) fat.push(d.readUInt32LE(i)); }
  const chain = (start, table) => { const out = []; const seen = new Set(); for (let s = start; s < END && !seen.has(s); s = table[s]) { seen.add(s); out.push(s); if (out.length > 1e6) break; } return out; };
  const readChain = (start) => Buffer.concat(chain(start, fat).map(sector));
  // 디렉터리
  const dirBuf = readChain(dirStart), entries = [];
  for (let o = 0; o + 128 <= dirBuf.length; o += 128) {
    const nl = dirBuf.readUInt16LE(o + 64);
    entries.push({ name: dirBuf.subarray(o, o + Math.max(0, nl - 2)).toString("utf16le"), type: dirBuf[o + 66],
      left: dirBuf.readUInt32LE(o + 68), right: dirBuf.readUInt32LE(o + 72), child: dirBuf.readUInt32LE(o + 76),
      start: dirBuf.readUInt32LE(o + 116), size: dirBuf.readUInt32LE(o + 120) });
  }
  const root = entries[0];
  const miniStream = root && root.start < END ? readChain(root.start) : Buffer.alloc(0);
  const miniFat = [];
  if (miniFatStart < END) { const d = readChain(miniFatStart); for (let i = 0; i + 4 <= d.length; i += 4) miniFat.push(d.readUInt32LE(i)); }
  const readStream = (e) => {
    if (e.size < cutoff) return Buffer.concat(chain(e.start, miniFat).map((s) => miniStream.subarray(s * miniSize, (s + 1) * miniSize))).subarray(0, e.size);
    return readChain(e.start).subarray(0, e.size);
  };
  const children = (id) => { // 형제는 left/right 트리로 이어져 있음
    const out = [], stack = [entries[id] ? entries[id].child : END], seen = new Set();
    while (stack.length) { const c = stack.pop(); if (c >= END || seen.has(c) || !entries[c]) continue; seen.add(c); out.push(c); stack.push(entries[c].left, entries[c].right); }
    return out;
  };
  // 경로("BodyText/Section0") -> 스트림 내용
  const get = (p) => {
    let id = 0;
    for (const part of p.split("/")) { id = children(id).find((c) => entries[c].name === part); if (id == null) return null; }
    return entries[id].type === 2 ? readStream(entries[id]) : null;
  };
  const list = (p) => { const id = children(0).find((c) => entries[c].name === p); return id == null ? [] : children(id).map((c) => entries[c].name); };
  return { get, list };
}

// 한글 5.0: FileHeader 의 속성 비트(압축·암호), BodyText/SectionN 레코드 중 문단 글자(PARA_TEXT, 태그 67)
const HWPTAG_PARA_TEXT = 67;
const CHAR_CTRL = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31]); // 1글자 차지, 나머지 0~31 은 8글자(16바이트) 차지
function paraText(rec) {
  let s = "";
  for (let i = 0; i + 1 < rec.length;) {
    const c = rec.readUInt16LE(i);
    if (c >= 32) { s += String.fromCharCode(c); i += 2; continue; }
    if (CHAR_CTRL.has(c)) { s += c === 10 || c === 13 ? "\n" : c >= 30 ? " " : ""; i += 2; continue; }
    if (c === 9) s += "\t";
    i += 16;
  }
  return s;
}
export function hwpText(buf) {
  const cfb = readCfb(buf);
  const head = cfb.get("FileHeader");
  if (!head || !head.subarray(0, 17).toString("latin1").startsWith("HWP Document File")) throw new Error("한글 문서가 아님");
  const prop = head.readUInt32LE(36);
  if (prop & 2) throw new Error("암호가 걸린 한글 문서");
  if (prop & 4) throw new Error("배포용 한글 문서");
  const compressed = !!(prop & 1);
  const secs = cfb.list("BodyText").filter((n) => /^Section\d+$/.test(n)).sort((a, b) => +a.slice(7) - +b.slice(7));
  const out = [];
  let total = 0;
  for (const name of secs) {
    let data = cfb.get("BodyText/" + name);
    if (!data) continue;
    if (compressed) {
      try { data = zlib.inflateRawSync(data, { maxOutputLength: UNZIP_MAX_ENTRY }); }
      catch (e) { if (e && (e.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|too large/i.test(String(e.message)))) throw LIMIT(); throw e; }
    }
    total += data.length; if (total > UNZIP_MAX_TOTAL) throw LIMIT();
    for (let p = 0; p + 4 <= data.length;) {
      const h = data.readUInt32LE(p); p += 4;
      const tag = h & 0x3ff; let size = h >>> 20;
      if (size === 0xfff) { if (p + 4 > data.length) break; size = data.readUInt32LE(p); p += 4; }
      if (tag === HWPTAG_PARA_TEXT) out.push(paraText(data.subarray(p, p + size)));
      p += size;
    }
  }
  let text = out.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) { const prv = cfb.get("PrvText"); if (prv) text = prv.toString("utf16le").trim(); } // 본문을 못 읽으면 미리보기 글자라도
  return text;
}

// ---------- 진입점 ----------
// 반환: 뽑은 글자(string) · 대상 형식이 아니면 null · 실패하면 Error 를 던짐 (message === "UNZIP_LIMIT" 은 압축 폭탄 의심)
export async function extractText(file, buf) {
  if (/\.(pptx|docx|xlsx|hwpx)$/i.test(file)) return officeText(file, buf);
  if (/\.hwp$/i.test(file)) return hwpText(buf);
  if (/\.doc$/i.test(file)) {
    if (process.platform !== "darwin") throw new Error("옛 Word(.doc)는 macOS 에서만 읽을 수 있음");
    const { stdout } = await promisify(execFile)("/usr/bin/textutil", ["-convert", "txt", "-stdout", file], { timeout: 60000, maxBuffer: 50 * 1024 * 1024 });
    return stdout.trim();
  }
  if (LEGACY_UNSUPPORTED.test(file)) throw new Error("옛 형식(xls·ppt)이라 읽을 수 없음");
  return null;
}

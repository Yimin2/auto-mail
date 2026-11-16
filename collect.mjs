// 그룹웨어(Domino) 새 메일 수집기 (ego-browser nodejs 로 실행, 토큰 사용 없음)
// - 개인 설정(그룹웨어 주소·메일함·내 이름 등)은 같은 폴더의 config.json 에서 읽습니다.
// - 받은 편지함 API에서 처리하지 않은 메일을 찾아 inbox/<날짜>_<제목>/ 에
//   mail.md(본문)와 첨부파일을 저장하고, office 첨부는 텍스트(.txt)도 뽑아 둡니다.
// - 새 메일 폴더는 pending.json 대기열에 추가 → run.ps1 이 요약 후 첨부를 지웁니다.
// - ego 브라우저의 "gw-mail-collector" 작업 공간 탭 하나를 계속 재사용합니다.
// - 마지막 줄에 RESULT_JSON=... 으로 결과를 출력합니다.

const fs = await import("node:fs/promises");
const path = await import("node:path");
const zlib = await import("node:zlib");

const { fileURLToPath } = await import("node:url");
const ROOT = fileURLToPath(new URL(".", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
const CFG = JSON.parse((await fs.readFile(`${ROOT}/config.json`, "utf8")).replace(/^﻿/, ""));
const STATE = `${ROOT}/state.json`;
const PENDING = `${ROOT}/pending.json`;
const INBOX_DIR = `${ROOT}/inbox`;
const GW = CFG.gwHost.replace(/\/$/, "");
const MAILDB = CFG.mailDb;
const FIRST_RUN_LOOKBACK_HOURS = 24;

const ATTACH_EXT_OK = /\.(pdf|docx?|xlsx?|pptx?|hwpx?|txt|csv|png|jpe?g)$/i;
const ATTACH_MAX_BYTES = 30 * 1024 * 1024;

// ---------- MIME / HTML ----------
function decodeQP(s) {
  const bytes = [];
  const str = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "=" && /^[0-9A-F]{2}$/i.test(str.substr(i + 1, 2))) {
      bytes.push(parseInt(str.substr(i + 1, 2), 16)); i += 2;
    } else bytes.push(...Buffer.from(str[i], "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}
function htmlToText(h) {
  return h
    .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function bodyText(body) {
  if (!body) return "";
  if (typeof body === "string") return htmlToText(body);
  const parts = body.content || [];
  const decode = (p) => {
    const enc = (p.contentTransferEncoding || "").toLowerCase();
    if (enc === "base64") return Buffer.from(p.data || "", "base64").toString("utf8");
    if (enc === "quoted-printable") return decodeQP(p.data || "");
    return p.data || "";
  };
  const plain = parts.find((p) => /^text\/plain/i.test(p.contentType || "") && p.data);
  if (plain) return decode(plain).trim();
  const html = parts.find((p) => /^text\/html/i.test(p.contentType || "") && p.data);
  return html ? htmlToText(decode(html)) : "";
}

// ---------- 규칙 기반 보안 검사 (AI 판단과 별개로, 토큰 사용 없음) ----------
function bodyHtmlRaw(body) {
  const parts = (body && body.content) || [];
  const p = parts.find((x) => /^text\/html/i.test(x.contentType || "") && x.data);
  if (!p) return typeof body === "string" ? body : "";
  const enc = (p.contentTransferEncoding || "").toLowerCase();
  return enc === "base64" ? Buffer.from(p.data, "base64").toString("utf8") : enc === "quoted-printable" ? decodeQP(p.data) : p.data;
}
const companyDomains = (() => {
  const list = (CFG.companyDomains || []).map((d) => String(d).toLowerCase());
  if (!list.length) { const h = new URL(GW).hostname.toLowerCase().split("."); list.push(h.length > 2 ? h.slice(1).join(".") : h.join(".")); }
  return list;
})();
const isCompany = (d) => !!d && companyDomains.some((c) => d === c || d.endsWith("." + c));
const lev = (a, b) => { const m = [...Array(b.length + 1).keys()]; for (let i = 1; i <= a.length; i++) { let p = m[0]; m[0] = i; for (let j = 1; j <= b.length; j++) { const t = m[j]; m[j] = Math.min(m[j] + 1, m[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = t; } } return m[b.length]; };
const lookalike = (d) => {
  if (!d || isCompany(d)) return false;
  return companyDomains.some((c) => {
    const cl = c.split(".")[0], dl = d.split(".")[0], flat = (s) => s.replace(/[-_.]/g, "");
    return (flat(d).includes(flat(cl)) && cl.length >= 4) || (lev(dl, cl) <= 2 && dl !== cl) || lev(d, c) <= 2;
  });
};
const SHORTENERS = /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|me2\.do|han\.gl|url\.kr|vo\.la|t\.ly|is\.gd|buly\.kr|c11\.kr|lrl\.kr|ow\.ly|rebrand\.ly|cutt\.ly|shorturl\.at)$/i;
const DANGER_EXT = /\.(exe|scr|com|pif|bat|cmd|ps1|vbs|vbe|js|jse|wsf|hta|msi|jar|lnk|iso|img|vhd|reg|cpl)$/i;
const MACRO_EXT = /\.(docm|xlsm|pptm|dotm|xltm|xlam)$/i;
const ARCHIVE_EXT = /\.(zip|rar|7z|alz|egg|gz|tar|cab)$/i;
const HTML_EXT = /\.(html?|svg|xhtml|mht)$/i;
const DOUBLE_EXT = /\.(pdf|docx?|xlsx?|pptx?|hwpx?|txt|jpe?g|png|gif)\.[a-z0-9]{2,5}$/i;
// 외부 주소가 표시 이름에 쓰면 사칭으로 보는 사내 역할 이름
const SPOOF_WORDS = /(관리자|administrator|it\s?팀|it\s?지원|전산실|전산팀|정보보안|보안팀|security\s?team|인사팀|총무팀|대표이사|ceo|helpdesk|헬프데스크)/i;
// 기관·브랜드 이름은 실제 도메인과 맞지 않을 때만 사칭으로 봄
const BRANDS = [[/국세청|홈택스/, /(^|\.)nts\.go\.kr$|(^|\.)hometax\.go\.kr$/], [/경찰/, /(^|\.)police\.go\.kr$/], [/검찰/, /(^|\.)spo\.go\.kr$/],
  [/microsoft|office\s?365|outlook|마이크로소프트/i, /(^|\.)(microsoft|office|outlook|live)\.com$/]];
function securityCheck(doc, attachInfo) {
  const high = [], mid = [];
  const from = String(doc.INetFrom || doc.From || "");
  const addr = ((from.match(/<([^>]+)>/) || [, from])[1] || "").trim().toLowerCase();
  const display = (from.match(/^\s*"?([^"<]*)"?\s*</) || [, ""])[1].trim();
  const domain = addr.includes("@") ? addr.split("@")[1] : "";
  const external = !!domain && !isCompany(domain);
  if (lookalike(domain)) high.push(`보낸 주소가 회사 도메인과 비슷한 다른 도메인(${domain})`);
  if (external && display && (SPOOF_WORDS.test(display) || companyDomains.some((c) => display.toLowerCase().includes(c.split(".")[0])))) high.push(`외부 주소(${domain})인데 표시 이름이 "${display}"`);
  else if (external && display) { const b = BRANDS.find(([name, dom]) => name.test(display) && !dom.test(domain)); if (b) high.push(`표시 이름("${display}")의 기관·브랜드와 실제 주소(${domain})가 다름`); }
  if (external && /@/.test(display) && !display.toLowerCase().includes(addr)) high.push(`표시 이름에 다른 메일 주소가 들어 있음`);
  const replyTo = String(doc.ReplyTo || doc.InetReplyTo || doc.$INetReplyTo || "").toLowerCase();
  const rDomain = (replyTo.match(/@([a-z0-9.-]+)/) || [])[1];
  if (rDomain && domain && rDomain !== domain) high.push(`답장 주소(${rDomain})가 보낸 주소(${domain})와 다름`);
  // 본문 링크
  const html = bodyHtmlRaw(doc.Body);
  const seen = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u; try { u = new URL(m[1].replace(/&amp;/g, "&")); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const host = u.hostname.toLowerCase(), text = m[2].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
    const shown = (text.match(/(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i) || [])[1];
    const key = host + "|" + (shown || "");
    if (seen.has(key)) continue; seen.add(key);
    if (shown && !host.endsWith(shown.toLowerCase().replace(/^www\./, "")) && !shown.toLowerCase().replace(/^www\./, "").endsWith(host.replace(/^www\./, ""))) high.push(`링크 글자(${shown})와 실제 주소(${host})가 다름`);
    if (host.startsWith("xn--") || host.includes(".xn--")) high.push(`국제화 도메인 링크(${host}) - 철자 위장 가능`);
    if (lookalike(host)) high.push(`회사 사칭 의심 링크(${host})`);
    if (SHORTENERS.test(host)) mid.push(`단축 URL 링크(${host})`);
    if (external && /^\d+\.\d+\.\d+\.\d+$/.test(host)) mid.push(`IP 주소로 된 링크(${host})`);
  }
  // 첨부
  for (const a of attachInfo || []) {
    const n = String(a.name || "");
    if (DOUBLE_EXT.test(n) && (DANGER_EXT.test(n) || HTML_EXT.test(n))) high.push(`이중 확장자 첨부(${n})`);
    else if (DANGER_EXT.test(n)) high.push(`실행 파일 첨부(${n})`);
    else if (HTML_EXT.test(n)) high.push(`HTML 첨부(${n}) - 가짜 로그인 화면에 자주 쓰임`);
    else if (MACRO_EXT.test(n)) mid.push(`매크로 문서 첨부(${n})`);
    else if (ARCHIVE_EXT.test(n)) mid.push(`압축 파일 첨부(${n}) - 내용 확인 불가`);
  }
  const uniq = (a) => [...new Set(a)].slice(0, 6);
  return high.length ? { level: "high", reasons: uniq(high.concat(mid)) } : mid.length ? { level: "mid", reasons: uniq(mid) } : null;
}

// ---------- office(zip) 텍스트 추출 ----------
// zip 폭탄 방지: 항목 하나는 풀어서 20MB, 전체는 60MB까지만 (넘으면 UNZIP_LIMIT 오류)
const UNZIP_MAX_ENTRY = 20 * 1024 * 1024;
const UNZIP_MAX_TOTAL = 60 * 1024 * 1024;
function unzipEntries(buf) {
  const out = {};
  let total = 0;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString("utf8");
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.slice(dataStart, dataStart + csize);
    // 필요한 XML 만 푼다 (슬라이드·문서·시트·공유 문자열)
    if (/^(ppt\/slides\/slide\d+|word\/document|xl\/worksheets\/sheet\d+|xl\/sharedStrings)\.xml$/.test(name)) {
      let data;
      try { data = method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: UNZIP_MAX_ENTRY }) : raw; }
      catch (e) { if (e && (e.code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|too large/i.test(String(e.message)))) throw new Error("UNZIP_LIMIT"); data = null; }
      if (data) {
        total += data.length;
        if (data.length > UNZIP_MAX_ENTRY || total > UNZIP_MAX_TOTAL) throw new Error("UNZIP_LIMIT");
        out[name] = data;
      }
    }
    p += 46 + nlen + elen + clen;
  }
  return out;
}
const xmlText = (x, tag) => [...x.toString("utf8").matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, "g"))].map((m) => m[1])
  .map((s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"));
function officeText(file, buf) {
  const z = unzipEntries(buf);
  const num = (s) => Number((s.match(/(\d+)\.xml$/) || [, 0])[1]);
  if (/\.pptx$/i.test(file)) {
    return Object.keys(z).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => num(a) - num(b))
      .map((k) => `## 슬라이드 ${num(k)}\n` + xmlText(z[k].toString("utf8").replace(/<\/a:p>/g, "<a:t>\n</a:t>"), "a:t").join("")).join("\n\n");
  }
  if (/\.docx$/i.test(file) && z["word/document.xml"]) {
    return xmlText(z["word/document.xml"].toString("utf8").replace(/<\/w:p>/g, "<w:t>\n</w:t>"), "w:t").join("");
  }
  if (/\.xlsx$/i.test(file)) {
    const shared = z["xl/sharedStrings.xml"] ? xmlText(z["xl/sharedStrings.xml"], "t") : [];
    return Object.keys(z).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => num(a) - num(b)).map((k) => {
      const rows = [...z[k].toString("utf8").matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
        [...r[1].matchAll(/<c([^>]*)>(?:[\s\S]*?<v>([^<]*)<\/v>)?[\s\S]*?<\/c>/g)].map((c) => (/t="s"/.test(c[1]) ? shared[Number(c[2])] : c[2]) ?? "").join("\t"));
      return `## 시트 ${num(k)}\n` + rows.join("\n");
    }).join("\n\n");
  }
  return null;
}

// ---------- 공통 ----------
const lang = (v) => (String(v || "").match(/ko:([^,]*)/) || [, String(v || "")])[1];
const cn = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).replace(/^CN=([^/]+).*$/, "$1"));
const safe = (s) => String(s).replace(/[\\/:*?"<>|\r\n\t]/g, "_").slice(0, 60).replace(/[. ]+$/, "").trim() || "_";
const kst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 16);
const readJson = async (f, d) => { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return d; } };

let state = await readJson(STATE, { seen: [], initializedAt: null });
const firstRun = !state.initializedAt;
const seen = new Set(state.seen);
const result = { ok: true, loginRequired: false, newMails: [] };

const task = await taskSpace("gw-mail-collector");
let page = (await task.pages())[0];
if (!page) page = await task.newPage();

try {
  // 세션 유지: 그룹웨어 탭이 아니거나 마지막 새로고침 후 15분이 지났으면 첫 화면을 다시 연다
  const KEEPALIVE_MS = 15 * 60e3;
  const lastReload = state.lastReloadAt ? new Date(state.lastReloadAt).getTime() : 0;
  if (!String(await page.url()).startsWith(GW) || Date.now() - lastReload > KEEPALIVE_MS) {
    await page.goto(GW + "/", { timeout: 60000 });
    state.lastReloadAt = new Date().toISOString();
  }
  let list = await page.fetch(`${MAILDB}/api/data/collections/name/($inbox_all_portal)?ps=40&page=0`, { timeout: 30000 });
  let entries; try { entries = JSON.parse(list.body); } catch { entries = null; }
  if (!Array.isArray(entries)) { // 세션 갱신 한 번 시도
    await page.goto(GW + "/", { timeout: 60000 });
    list = await page.fetch(`${MAILDB}/api/data/collections/name/($inbox_all_portal)?ps=40&page=0`, { timeout: 30000 });
    try { entries = JSON.parse(list.body); } catch { entries = null; }
  }
  // 놓침 방지: 첫 페이지가 모두 새 메일이면 이미 처리한 메일이 나올 때까지 다음 페이지도 가져온다(최대 10페이지)
  if (Array.isArray(entries) && !firstRun) {
    let last = entries;
    for (let pg = 1; pg < 10 && last.length >= 40 && last.every((e) => !seen.has(e["@unid"])); pg++) {
      try {
        last = JSON.parse((await page.fetch(`${MAILDB}/api/data/collections/name/($inbox_all_portal)?ps=40&page=${pg}`, { timeout: 30000 })).body);
        if (!Array.isArray(last) || !last.length) break;
        entries = entries.concat(last);
      } catch { break; }
    }
    result.pages = Math.ceil(entries.length / 40);
  }
  if (!Array.isArray(entries)) {
    result.ok = false; result.loginRequired = true;
    result.message = `메일 목록을 못 읽었습니다(HTTP ${list.status}). 그룹웨어 로그인이 풀렸을 수 있습니다.`;
  } else {
    const cutoff = Date.now() - FIRST_RUN_LOOKBACK_HOURS * 3600e3;
    const targets = entries.filter((e) => !seen.has(e["@unid"]) && (!firstRun || new Date(e._created).getTime() >= cutoff));
    for (const e of targets.reverse()) {
      const unid = e["@unid"];
      const doc = JSON.parse((await page.fetch(`${MAILDB}/api/data/documents/unid/${unid}`, { timeout: 30000 })).body);
      const subject = doc.Subject || e._subject || "(제목 없음)";
      const when = kst(doc.PostedDate || e._created);
      const dir = `${INBOX_DIR}/${when.slice(0, 10).replace(/-/g, "")}-${when.slice(11).replace(":", "")}_${safe(subject)}`;
      await fs.mkdir(dir, { recursive: true });

      const fromName = lang(doc.AuthorName) || String(doc.From || e._author || "").replace(/^CN=([^/]+).*$/, "$1");
      const fromOrg = [lang(doc.AuthorOrgName), lang(doc.AuthorDutyName)].filter(Boolean).join(" ");
      const attachments = [];
      let info = []; try { info = e._attachinfo ? JSON.parse(e._attachinfo) : []; } catch {}
      for (const a of info) {
        const size = Number(a.size || 0);
        const item = { name: a.name, size, saved: null, text: null, skipped: null };
        if (!ATTACH_EXT_OK.test(a.name)) item.skipped = "지원하지 않는 형식";
        else if (size > ATTACH_MAX_BYTES) item.skipped = "30MB 초과";
        else {
          const ext = (a.name.match(/\.[^.]+$/) || [""])[0];
          const out = `${dir}/att_${safe(a.name.replace(/\.[^.]+$/, ""))}${ext}`;
          const r = await page.fetch(a.url, { saveAs: out, timeout: 120000 });
          if (!r.ok) item.skipped = `다운로드 실패(HTTP ${r.status})`;
          else {
            item.saved = out;
            if (/\.(pptx|docx|xlsx)$/i.test(ext)) {
              try {
                const t = officeText(a.name, await fs.readFile(out));
                if (t) { item.text = out.replace(/\.[^.]+$/, ".txt"); await fs.writeFile(item.text, t, "utf8"); }
              } catch (err) {
                // 압축 해제 크기 초과(zip 폭탄 의심) 등: 원본은 지우고, 요약에는 "읽지 못함"으로 알린다
                item.skipped = String(err && err.message) === "UNZIP_LIMIT" ? "압축을 풀면 너무 커서 읽지 않음(손상 또는 zip 폭탄 의심)" : "텍스트 추출 실패";
                item.text = out.replace(/\.[^.]+$/, ".txt");
                await fs.writeFile(item.text, `읽지 못함: ${item.skipped}`, "utf8");
                try { await fs.unlink(out); } catch {}
                item.saved = null;
              }
            }
          }
        }
        attachments.push(item);
      }

      // 내 위치: 받는 사람(수신) / 참조 / 기타(숨은참조·그룹 발송 등)
      const ME = new RegExp(CFG.meMatch, "i");
      const inList = (v) => (Array.isArray(v) ? v : v ? [v] : []).some((x) => ME.test(String(x)));
      const role = inList(doc.SendTo) || inList(doc.InetSendTo) ? "수신" : inList(doc.CopyTo) || inList(doc.InetCopyTo) ? "참조" : "기타";
      const risk = securityCheck(doc, info); // 규칙 기반 보안 검사(발신자·링크·첨부)
      const md = [
        `# ${subject}`, "",
        `- 내 위치: ${role}`,
        `- 보낸 사람: ${fromName}${fromOrg ? ` (${fromOrg})` : ""} ${doc.INetFrom || ""}`.trim(),
        `- 보낸 시각: ${when} (KST)`,
        `- 받는 사람: ${cn(doc.SendTo).join(", ")}`,
        cn(doc.CopyTo).length ? `- 참조: ${cn(doc.CopyTo).join(", ")}` : null,
        attachments.length ? `- 첨부: ${attachments.map((a) => a.name + (a.skipped ? ` [${a.skipped}]` : "")).join(", ")}` : null,
        risk ? `- 자동 보안 검사: ${risk.level === "high" ? "위험" : "주의"} — ${risk.reasons.join(" / ")}` : null,
        "", "---", "", bodyText(doc.Body),
      ].filter((x) => x !== null).join("\n");
      await fs.writeFile(`${dir}/mail.md`, md, "utf8");

      result.newMails.push({ unid, subject, from: fromName, when, dir, attachments, role, risk, openUrl: e._openurl ? GW + e._openurl : null });
      seen.add(unid);
    }
    // 진단: 수집(API 읽기) 전후로 그룹웨어의 읽음 상태가 바뀌는지 기록
    if (targets.length) {
      try {
        const after = JSON.parse((await page.fetch(`${MAILDB}/api/data/collections/name/($inbox_all_portal)?ps=40&page=0`, { timeout: 30000 })).body);
        const now = new Map(after.map((x) => [x["@unid"], !!x["@read"]]));
        result.readCheck = targets.map((e) => ({ subject: e._subject, before: !!e["@read"], after: now.get(e["@unid"]) ?? null }));
      } catch {}
    }
    if (firstRun) for (const e of entries) seen.add(e["@unid"]);
    await fs.mkdir(ROOT, { recursive: true });
    state = { seen: [...seen].slice(-2000), initializedAt: state.initializedAt || new Date().toISOString(), lastRunAt: new Date().toISOString(), lastReloadAt: state.lastReloadAt };
    await fs.writeFile(STATE, JSON.stringify(state, null, 1), "utf8");
    if (result.newMails.length) {
      const pending = await readJson(PENDING, []);
      for (const m of result.newMails) pending.push({ dir: m.dir, unid: m.unid, subject: m.subject, from: m.from, when: m.when, role: m.role, risk: m.risk || null, openUrl: m.openUrl });
      await fs.writeFile(PENDING, JSON.stringify(pending, null, 1), "utf8");
    }
  }
} catch (err) {
  result.ok = false; result.message = String(err?.message || err);
}
await fs.writeFile(`${ROOT}/last-result.json`, JSON.stringify(result), "utf8");
console.log("RESULT_JSON=" + JSON.stringify(result));

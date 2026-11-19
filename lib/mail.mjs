// 메일 본문 해석(MIME·HTML)과 규칙 기반 보안 검사 · collect.mjs 와 테스트에서 함께 씀 (토큰 사용 없음)

// ---------- MIME / HTML ----------
export function decodeQP(s) {
  const bytes = [];
  const str = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "=" && /^[0-9A-F]{2}$/i.test(str.substr(i + 1, 2))) {
      bytes.push(parseInt(str.substr(i + 1, 2), 16)); i += 2;
    } else bytes.push(...Buffer.from(str[i], "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}
export function htmlToText(h) {
  return h
    .replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
const decodePart = (p) => {
  const enc = (p.contentTransferEncoding || "").toLowerCase();
  if (enc === "base64") return Buffer.from(p.data || "", "base64").toString("utf8");
  if (enc === "quoted-printable") return decodeQP(p.data || "");
  return p.data || "";
};
export function bodyText(body) {
  if (!body) return "";
  if (typeof body === "string") return htmlToText(body);
  const parts = body.content || [];
  const plain = parts.find((p) => /^text\/plain/i.test(p.contentType || "") && p.data);
  if (plain) return decodePart(plain).trim();
  const html = parts.find((p) => /^text\/html/i.test(p.contentType || "") && p.data);
  return html ? htmlToText(decodePart(html)) : "";
}
export function bodyHtmlRaw(body) {
  const parts = (body && body.content) || [];
  const p = parts.find((x) => /^text\/html/i.test(x.contentType || "") && x.data);
  if (!p) return typeof body === "string" ? body : "";
  return decodePart(p);
}

// ---------- 규칙 기반 보안 검사 (AI 판단과 별개) ----------
const lev = (a, b) => { const m = [...Array(b.length + 1).keys()]; for (let i = 1; i <= a.length; i++) { let p = m[0]; m[0] = i; for (let j = 1; j <= b.length; j++) { const t = m[j]; m[j] = Math.min(m[j] + 1, m[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = t; } } return m[b.length]; };
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

// 회사 도메인 목록: 설정값이 없으면 그룹웨어 주소에서 추측 (gw.example.co.kr -> example.co.kr)
export function companyDomainsOf(cfg) {
  const list = (cfg.companyDomains || []).map((d) => String(d).toLowerCase()).filter(Boolean);
  if (!list.length && cfg.gwHost) { const h = new URL(cfg.gwHost).hostname.toLowerCase().split("."); list.push(h.length > 2 ? h.slice(1).join(".") : h.join(".")); }
  return list;
}

export function makeSecurityCheck(companyDomains) {
  const isCompany = (d) => !!d && companyDomains.some((c) => d === c || d.endsWith("." + c));
  const lookalike = (d) => {
    if (!d || isCompany(d)) return false;
    return companyDomains.some((c) => {
      const cl = c.split(".")[0], dl = d.split(".")[0], flat = (s) => s.replace(/[-_.]/g, "");
      return (flat(d).includes(flat(cl)) && cl.length >= 4) || (lev(dl, cl) <= 2 && dl !== cl) || lev(d, c) <= 2;
    });
  };
  return function securityCheck(doc, attachInfo) {
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
  };
}

// 그룹웨어(Domino) 새 메일 수집기 (ego-browser nodejs 로 실행, 토큰 사용 없음)
// - 개인 설정(그룹웨어 주소·메일함·내 이름 등)은 같은 폴더의 config.json 에서 읽습니다.
// - 받은 편지함 API에서 처리하지 않은 메일을 찾아 inbox/<날짜>_<제목>/ 에
//   mail.md(본문)와 첨부파일을 저장하고, 오피스·한글 첨부는 텍스트(.txt)도 뽑아 둡니다.
// - 새 메일 폴더는 pending.json 대기열에 추가 → run.mjs 가 요약 후 첨부를 지웁니다.
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

// 본문 해석·보안 검사·첨부 글자 추출은 lib/ 에 있음 (테스트도 같은 코드를 씀)
const { bodyText, makeSecurityCheck, companyDomainsOf } = await import(new URL("./lib/mail.mjs", import.meta.url).href);
const { extractText, EXTRACT_EXT } = await import(new URL("./lib/extract.mjs", import.meta.url).href);
const securityCheck = makeSecurityCheck(companyDomainsOf(CFG));
const MAIL_FAIL_LIMIT = 3; // 같은 메일을 이만큼 연속으로 못 읽으면 건너뛰고 기록만 남김


// ---------- 공통 ----------
const lang = (v) => (String(v || "").match(/ko:([^,]*)/) || [, String(v || "")])[1];
const cn = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).replace(/^CN=([^/]+).*$/, "$1"));
const safe = (s) => String(s).replace(/[\\/:*?"<>|\r\n\t]/g, "_").slice(0, 60).replace(/[. ]+$/, "").trim() || "_";
const kst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 16);
const readJson = async (f, d) => { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return d; } };

let state = await readJson(STATE, { seen: [], initializedAt: null });
const fails = state.fails || {}; // 읽다가 실패한 메일: { unid: 횟수 }
const firstRun = !state.initializedAt;
const seen = new Set(state.seen);
const result = { ok: true, loginRequired: false, newMails: [], failed: [], skipped: [] };

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
      try {
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
              if (EXTRACT_EXT.test(ext)) {
                try {
                  const t = await extractText(out, await fs.readFile(out));
                  if (t) { item.text = out.replace(/\.[^.]+$/, ".txt"); await fs.writeFile(item.text, t, "utf8"); }
                  if (/\.(hwp|doc)$/i.test(ext)) { try { await fs.unlink(out); } catch {} item.saved = null; } // Claude 가 원본은 못 읽으므로 글자만 남김
                } catch (err) {
                  // 압축 해제 크기 초과(zip 폭탄 의심)·암호·옛 형식 등: 원본은 지우고, 요약에는 "읽지 못함"으로 알린다
                  const msg = String(err && err.message);
                  item.skipped = msg === "UNZIP_LIMIT" ? "압축을 풀면 너무 커서 읽지 않음(손상 또는 zip 폭탄 의심)" : `텍스트 추출 실패(${msg.slice(0, 60)})`;
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
        const fromAddr = (String(doc.INetFrom || "").match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i) || [])[0]?.toLowerCase() || null; // 보낸 사람 판정 기록을 찾을 때 씀
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

        result.newMails.push({ unid, subject, from: fromName, fromAddr, when, dir, attachments, role, risk, openUrl: e._openurl ? GW + e._openurl : null });
        seen.add(unid); delete fails[unid];
      } catch (err) {
        // 메일 한 통이 깨져도 나머지는 계속 가져온다. 같은 메일이 MAIL_FAIL_LIMIT 번 연속 실패하면 건너뛴다.
        const n = (fails[unid] || 0) + 1, why = String(err?.message || err).slice(0, 200), subject = e._subject || unid;
        if (n >= MAIL_FAIL_LIMIT) { seen.add(unid); delete fails[unid]; result.skipped.push({ unid, subject, why }); }
        else { fails[unid] = n; result.failed.push({ unid, subject, why, tries: n }); }
      }
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
    state = { seen: [...seen].slice(-2000), fails, initializedAt: state.initializedAt || new Date().toISOString(), lastRunAt: new Date().toISOString(), lastReloadAt: state.lastReloadAt };
    await fs.writeFile(STATE, JSON.stringify(state, null, 1), "utf8");
    if (result.newMails.length) {
      const pending = await readJson(PENDING, []);
      for (const m of result.newMails) pending.push({ dir: m.dir, unid: m.unid, subject: m.subject, from: m.from, fromAddr: m.fromAddr || null, when: m.when, role: m.role, risk: m.risk || null, openUrl: m.openUrl });
      await fs.writeFile(PENDING, JSON.stringify(pending, null, 1), "utf8");
    }
  }
} catch (err) {
  result.ok = false; result.message = String(err?.message || err);
}
await fs.writeFile(`${ROOT}/last-result.json`, JSON.stringify(result), "utf8");
console.log("RESULT_JSON=" + JSON.stringify(result));

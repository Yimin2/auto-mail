// 요약이 끝난 메일을 그룹웨어에서 읽음 처리 (원문 문서를 한 번 열면 Domino 가 읽음으로 표시)
// 입력: markread.json  [{ unid, url, subject }]   결과: last-markread.json
const fs = await import("node:fs/promises");
const { fileURLToPath } = await import("node:url");
const ROOT = fileURLToPath(new URL(".", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
const CFG = JSON.parse((await fs.readFile(`${ROOT}/config.json`, "utf8")).replace(/^﻿/, ""));
const MAILDB = CFG.mailDb;
const GW = CFG.gwHost.replace(/\/$/, "");
let items = [];
try { items = JSON.parse((await fs.readFile(`${ROOT}/markread.json`, "utf8")).replace(/^﻿/, "")); } catch {}
const out = { at: new Date().toISOString(), results: [] };
const task = await taskSpace("gw-mail-collector");
let page = (await task.pages())[0];
if (!page) page = await task.newPage();
try {
  if (!String(await page.url()).startsWith(GW)) await page.goto(GW + "/", { timeout: 60000 });
  for (const it of items) {
    if (it.unread) {
      // 의심 메일: 그룹웨어 메일 앱의 '선택한 메일 안읽음 표시'와 같은 요청으로 미확인으로 되돌림
      if (!/^[0-9A-Fa-f]{32}$/.test(String(it.unid || ""))) { out.results.push({ subject: it.subject, ok: false, why: "메일 ID 없음", wantUnread: true }); continue; }
      const r = await page.fetch(`${MAILDB}/wcmdpost?createdocument`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: `actiontype=readflag_unread&postdata=${it.unid}`, timeout: 30000,
      });
      out.results.push({ subject: it.subject, unid: it.unid, http: r.status, wantUnread: true });
      continue;
    }
    if (!it.url || !it.url.startsWith(GW + "/")) { out.results.push({ subject: it.subject, ok: false, why: "주소 없음" }); continue; }
    const r = await page.fetch(it.url, { timeout: 30000 });
    out.results.push({ subject: it.subject, unid: it.unid, http: r.status });
  }
  // 실제로 읽음이 됐는지 확인
  const list = JSON.parse((await page.fetch(`${MAILDB}/api/data/collections/name/($inbox_all_portal)?ps=60&page=0`, { timeout: 30000 })).body);
  const read = new Map(list.map((e) => [e["@unid"], !!e["@read"]]));
  for (const r of out.results) if (r.unid) r.read = read.has(r.unid) ? read.get(r.unid) : null;
} catch (err) {
  out.error = String(err?.message || err);
}
await fs.writeFile(`${ROOT}/last-markread.json`, JSON.stringify(out), "utf8");
console.log("MARKREAD " + JSON.stringify(out));

// 메일 요약 데이터 저장 + 대시보드(dashboard.html) 생성 · 웹 공통 디자인 시스템 적용
//   node build.js ingest <claude출력.txt> <pending.json>   요약 결과를 data/mails.json 에 추가하고 대시보드 생성
//   node build.js render                                   대시보드만 다시 생성
const fs = require("fs");
const path = require("path");

// AUTOMAIL_ROOT: 테스트에서 데이터 폴더를 따로 쓰기 위한 값 (평소에는 이 파일이 있는 폴더)
const ROOT = (process.env.AUTOMAIL_ROOT || __dirname).replace(/\\/g, "/");
const CFG = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, "utf8").replace(/^﻿/, "")); // 개인 설정(그룹웨어 주소 등)
const GW = String(CFG.gwHost || "").replace(/\/$/, "");
const DATA = `${ROOT}/data/mails.json`;
const OUT = `${ROOT}/dashboard.html`;
const DS = `${__dirname.replace(/\\/g, "/")}/ds`;
const KEEP_DAYS = 45;

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "")); } catch { return d; } };
// 읽음 확인(수신 확인) 메일: 반복 메일 묶음에 넣지 않는다
const isReceipt = (subject) => /^\s*(수신\s*확인\s*(\(읽음\))?|읽음|read)\s*:/i.test(String(subject || ""));
const idOf = (dir) => path.basename(String(dir || "")).replace(/[^\w가-힣-]/g, "_").slice(0, 80);

// 요약은 지우지 않는다: 45일 지난 요약은 data/archive/YYYY-MM.json 으로 옮기고,
// 아직 할 일이 남아 있을 수 있는 메일(할 일이 있는 메일)은 대시보드에 남긴다.
// 실제 체크 여부는 브라우저에 있으므로, 할 일이 있는 메일은 180일까지 대시보드에 둔다.
const ARCHIVE = `${ROOT}/data/archive`;
const RECENT_MAP = `${ROOT}/recent-map.json`; // 요약 지침의 "최근 메일" 짧은 번호 -> 메일 id
const KEEP_TASK_DAYS = 180;
function archiveOld(list) {
  const now = Date.now(), keep = [], move = {};
  const done = (readJson(`${ROOT}/data/marks.json`, {}).done) || {}; // 대시보드 체크 기록(브리핑 때 갱신)
  for (const m of list) {
    const age = (now - new Date(m.date || m.addedAt).getTime()) / 86400e3;
    const hasTask = (m.tasks || []).some((t) => !done[t.id] && !t.superseded); // 아직 끝내지 않은 할 일이 있을 때만 오래 둔다
    if (age < KEEP_DAYS || (hasTask && age < KEEP_TASK_DAYS)) keep.push(m);
    else (move[String(m.date || m.addedAt).slice(0, 7)] ||= []).push(m);
  }
  for (const [ym, ms] of Object.entries(move)) {
    fs.mkdirSync(ARCHIVE, { recursive: true });
    const f = `${ARCHIVE}/${ym}.json`;
    const old = readJson(f, []);
    const map = new Map(old.map((x) => [x.id, x]));
    for (const m of ms) map.set(m.id, m);
    fs.writeFileSync(f, JSON.stringify([...map.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)), null, 1), "utf8");
  }
  return keep;
}

function ingest(rawFile, pendingFile) {
  const raw = fs.readFileSync(rawFile, "utf8").replace(/^\uFEFF/, "");
  const pending = [].concat(readJson(pendingFile, []));
  let parsed = null;
  try {
    const s = raw.replace(/```(?:json)?/g, "");
    const st = s.indexOf("[{") >= 0 ? s.indexOf("[{") : s.indexOf("["); // 앞에 경고 문구가 섞여도 JSON 배열 시작부터 읽기
    parsed = JSON.parse(s.slice(st, s.lastIndexOf("]") + 1));
    if (!Array.isArray(parsed)) parsed = null;
  } catch { parsed = null; }

  const mails = readJson(DATA, []);
  const byId = new Map(mails.map((m) => [m.id, m]));
  const now = new Date().toISOString();
  const urlOf = new Map(pending.map((p) => [idOf(p.dir), p.openUrl || null]));
  const roleOf = new Map(pending.map((p) => [idOf(p.dir), p.role || null]));
  const riskOf = new Map(pending.map((p) => [idOf(p.dir), p.risk || null])); // 규칙 기반 보안 검사 결과
  const addrOfId = new Map(pending.map((p) => [idOf(p.dir), p.fromAddr || null])); // 보낸 주소(판정 기록 찾기용)
  const knownIds = new Set([...byId.keys(), ...allMails().map((m) => m.id)]); // threadOf·related 가 가리킬 수 있는 메일
  const rmap = readJson(RECENT_MAP, {}), ref = (x) => (x == null ? x : rmap[String(x)] || String(x)); // r번호 -> 메일 id
  if (parsed) for (const m of parsed) {
    if (m.threadOf) m.threadOf = ref(m.threadOf);
    if (Array.isArray(m.related)) for (const r of m.related) if (r) r.id = ref(r.id);
    if (m.series && Array.isArray(m.series.backfill)) for (const b of m.series.backfill) if (b) b.id = ref(b.id);
  }
  const kindOf = (t, role) => t.kind === "mine" || t.kind === "watch" ? t.kind : (role && role !== "수신" ? "watch" : "mine");
  if (parsed) {
    for (const m of parsed) {
      const id = idOf(m.dir);
      byId.set(id, {
        id, date: m.date, time: m.time, subject: m.subject, from: m.from, url: urlOf.get(id) || m.url || null, dir: m.dir || null,
        category: m.category === "promo" ? "promo" : "work",
        importance: ["high", "mid", "low"].includes(m.importance) ? m.importance : "mid",
        oneLine: m.oneLine || "", points: m.points || [], attachments: m.attachments || [],
        role: roleOf.get(id) || null, fromAddr: addrOfId.get(id) || null,
        risk: riskOf.get(id) || null,
        tasks: (m.tasks || []).map((t, i) => ({ id: `${id}#${i}`, text: t.text, due: t.due || null,
          kind: kindOf(t, roleOf.get(id)), owner: t.owner ? String(t.owner).slice(0, 40) : null, source: t.source && typeof t.source === "object" ? {
          file: String(t.source.file || "").slice(0, 120) || null, where: t.source.where ? String(t.source.where).slice(0, 60) : null,
          quote: t.source.quote ? String(t.source.quote).slice(0, 200) : null, why: t.source.why ? String(t.source.why).slice(0, 300) : null } : null })),
        warning: m.warning || (riskOf.get(id) && riskOf.get(id).level === "high" ? "피싱 의심: " + riskOf.get(id).reasons.join(", ") : null), addedAt: now,
        threadNew: (m.threadNew || []).map((c) => String(c).slice(0, 120)).slice(0, 4),
        // 본문에 인용된 이전 메일(받은편지함에 없는 내 답장 등) · 같은 대화로 이어지는 예전 메일 · 관련 있는 다른 대화
        quoted: (Array.isArray(m.quoted) ? m.quoted : []).filter((q) => q && /^\d{4}-\d{2}-\d{2}$/.test(String(q.date || ""))).slice(0, 6).map((q) => ({
          date: String(q.date), time: /^\d{2}:\d{2}$/.test(String(q.time || "")) ? String(q.time) : null, from: String(q.from || "").slice(0, 40), oneLine: String(q.oneLine || "").slice(0, 80) })),
        threadOf: m.threadOf && knownIds.has(String(m.threadOf)) && String(m.threadOf) !== id ? String(m.threadOf) : null,
        related: (Array.isArray(m.related) ? m.related : []).filter((r) => r && knownIds.has(String(r.id)) && String(r.id) !== id).slice(0, 3)
          .map((r) => ({ id: String(r.id), why: r.why ? String(r.why).slice(0, 80) : null })),
        series: m.series && m.series.name && !isReceipt(m.subject) ? { name: String(m.series.name).slice(0, 40), issue: m.series.issue ? String(m.series.issue).slice(0, 30) : null,
          changes: (m.series.changes || []).map((c) => String(c).slice(0, 120)).slice(0, 4), compared: m.series.compared === true || m.series.compared === "true" } : null,
      });
    }
  } else {
    // 형식이 깨져도 메일은 남긴다(원문 요약을 그대로 보관)
    for (const p of pending) {
      const id = idOf(p.dir);
      byId.set(id, {
        id, date: String(p.when || "").slice(0, 10), time: String(p.when || "").slice(11, 16), subject: p.subject, from: p.from, url: p.openUrl || null, dir: p.dir || null,
        importance: "mid", oneLine: "요약 형식 오류: 아래 원문 참고", points: [raw.trim().slice(0, 1500)], attachments: [],
        tasks: [], warning: null, addedAt: now,
      });
    }
  }
  // 낡은 할 일 표시: Claude 가 supersedes 로 지목한 앞선 대화의 할 일을 "변경됨"으로 (목록·숫자·알림에서 빠짐)
  if (parsed) for (const m of parsed) {
    for (const s of m.supersedes || []) {
      const tid = s && s.taskId; if (!tid) continue;
      const owner = byId.get(String(tid).split("#")[0]);
      const t = owner && (owner.tasks || []).find((x) => x.id === tid);
      if (t && !t.superseded) t.superseded = { by: idOf(m.dir), why: s.why ? String(s.why).slice(0, 160) : null, at: now };
    }
  }
  // 반복 메일 소급 묶기: Claude 가 backfill 로 지목한 예전 메일에 같은 묶음 이름을 붙인다
  if (parsed) for (const m of parsed) {
    const name = m.series && m.series.name;
    for (const b of (name && m.series.backfill) || []) {
      const old = byId.get(b && b.id);
      if (old && !(old.series && old.series.name) && !isReceipt(old.subject)) old.series = { name: String(name).slice(0, 40), issue: b.issue ? String(b.issue).slice(0, 30) : null, changes: [] };
    }
  }
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(archiveOld([...byId.values()]), null, 1), "utf8");
  // 알림용 요약: 광고(피싱 경고 없는 promo)는 알림에서 뺀다
  const added = parsed ? parsed.map((m) => byId.get(idOf(m.dir))) : pending.map((p) => byId.get(idOf(p.dir)));
  const isPromo = (m) => m && m.category === "promo" && !m.warning;
  fs.writeFileSync(`${ROOT}/last-ingest.json`, JSON.stringify({
    work: added.filter((m) => m && !isPromo(m)).map((m) => m.subject),
    promo: added.filter(isPromo).length,
    // 경고 알림·그룹웨어 미확인 유지용
    danger: added.filter((m) => m && m.warning).map((m) => m.subject),
    dangerUnids: added.filter((m) => m && m.warning).map((m) => (String(m.url || "").match(/\/0\/([0-9A-Fa-f]{32})/) || [])[1]).filter(Boolean),
    tasks: added.filter((m) => m && !isPromo(m)).reduce((n, m) => n + (m.tasks || []).filter((t) => t.kind !== "watch").length, 0),
  }), "utf8");
  console.log(parsed ? `ok ${parsed.length}` : "fallback");
}

// 대화(스레드) 묶음: 제목에서 Re:/RE:/FW:/Fwd:/회신/전달 을 떼고 같은 제목끼리 묶는다 (토큰 사용 없음)
function threadKey(subject) {
  let s = String(subject || "");
  for (let i = 0; i < 20; i++) {
    const t = s.replace(/^\s*(\[(re|fw|fwd)\]|(re|fw|fwd|회신|답장|전달)\s*(\[\d+\])?\s*:)\s*/i, "");
    if (t === s) break;
    s = t;
  }
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}
const isReply = (subject) => threadKey(subject) !== String(subject || "").replace(/\s+/g, " ").trim().toLowerCase();
// 같은 대화: 머리말을 뗀 제목이 같거나, Claude 가 인용 원문을 보고 threadOf 로 이은 메일. 한 통짜리 대화도 돌려준다(인용된 이전 메일을 보여 주려고)
function threadGroups() {
  const list = allMails().filter((m) => !(m.series && m.series.name && !isReceipt(m.subject))); // 반복 메일은 반복 메일 칸에서 묶는다
  const byId = new Map(list.map((m) => [m.id, m])), parent = new Map(list.map((m) => [m.id, m.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { if (byId.has(a) && byId.has(b)) parent.set(find(a), find(b)); };
  const firstBySubject = new Map();
  for (const m of list) {
    const k = threadKey(m.subject);
    if (k) { if (firstBySubject.has(k)) union(m.id, firstBySubject.get(k)); else firstBySubject.set(k, m.id); }
    if (m.threadOf) union(m.id, m.threadOf);
  }
  const g = new Map();
  for (const m of list) { const r = find(m.id); if (!g.has(r)) g.set(r, []); g.get(r).push(m); }
  for (const arr of g.values()) arr.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  return g;
}
// 요약 지침에 넣을 "앞선 대화" (이번에 요약할 답장 메일의 이전 메일들)
function threadContext(pendingFile) {
  const pending = [].concat(readJson(pendingFile, []));
  const all = allMails();
  const out = [];
  for (const p of pending) {
    if (!isReply(p.subject)) continue;
    const k = threadKey(p.subject);
    const prev = all.filter((m) => threadKey(m.subject) === k).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).slice(0, 4);
    if (!prev.length) continue;
    out.push(`- 대상: ${p.dir}\n` + prev.map((m) => `  · ${m.date} ${m.time} ${m.from}: ${m.oneLine} | ${(m.points || []).slice(0, 3).join(" / ")}` +
      (m.tasks || []).filter((t) => !t.superseded).map((t) => `\n    할 일 [${t.id}] ${t.text}${t.due ? ` (마감 ${t.due})` : ""}`).join("")).join("\n"));
  }
  console.log(out.length ? out.join("\n") : "(없음)");
}

// 요약 지침에 넣을 "최근 메일" (같은 대화 잇기 threadOf · 관련 대화 related 의 후보)
function recentContext() {
  // 같은 대화 잇기(threadOf)·관련 대화(related)·반복 메일 소급(backfill) 후보를 한 목록으로
  const cut = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const list = readJson(DATA, []).filter((m) => m.date >= cut && m.category !== "promo" && !isReceipt(m.subject))
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).slice(0, 60);
  // 메일 id 는 제목을 그대로 담아 길어서, 짧은 번호(r1, r2 …)로 주고 ingest 때 recent-map.json 으로 되돌린다
  fs.writeFileSync(RECENT_MAP, JSON.stringify(Object.fromEntries(list.map((m, i) => [`r${i + 1}`, m.id]))), "utf8");
  console.log(list.length ? list.map((m, i) => {
    const tag = m.series && m.series.name ? ` [묶음: ${m.series.name}]` : "";
    return `- r${i + 1} | ${m.date} ${m.time} | ${nameOf(m.from)} | ${m.subject}${tag} | ${m.oneLine}`;
  }).join("\n") : "(없음)");
}

// 요약 지침에 넣을 "보낸 사람 판정 기록": 같은 보낸 사람의 예전 경고 메일을 사용자가 정상/위험으로 판정한 기록
// 주소가 양쪽에 있으면 주소로, 예전 메일에 주소가 없으면 이름으로 찾는다(이름만 같으면 그렇게 밝힌다)
const addrOf = (s) => ((String(s || "").match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i) || [])[0] || "").toLowerCase() || null;
const nameOf = (s) => String(s || "").split("·")[0].replace(/"/g, "").trim();
function senderContext(pendingFile) {
  const pending = [].concat(readJson(pendingFile, []));
  const flag = readJson(`${ROOT}/data/marks.json`, {}).flag || {};
  const all = allMails(), out = [];
  for (const p of pending) {
    const pa = p.fromAddr || addrOf(p.from), pn = nameOf(p.from);
    const same = all.filter((m) => {
      if (m.dir && m.dir === p.dir) return false;
      const ma = m.fromAddr || addrOf(m.from);
      return pa && ma ? ma === pa : !!pn && nameOf(m.from) === pn;
    });
    const judged = same.filter((m) => m.warning && flag[m.id] && flag[m.id].v).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).slice(0, 5);
    if (!judged.length) continue;
    out.push(`- 대상: ${p.dir}\n  보낸 사람: ${pn}${pa ? ` <${pa}>` : ""} · 예전 메일 ${same.length}통\n` + judged.map((m) => {
      const ma = m.fromAddr || addrOf(m.from);
      return `  · ${m.date} "${m.subject}" — 그때 경고: ${String(m.warning).slice(0, 100)} → 사용자 판정: ${flag[m.id].v === "safe" ? "정상(의심 해제)" : "위험"}` +
        ` (${pa && ma ? "보낸 주소 같음" : "이름만 같음, 주소 확인 못 함"})`;
    }).join("\n"));
  }
  console.log(out.length ? out.join("\n") : "(없음)");
}

// 반복 메일 묶음: 대시보드 데이터 + 월별 보관 파일 전체에서 모은다
function allMails() {
  const list = [...readJson(DATA, [])];
  try { for (const f of fs.readdirSync(ARCHIVE)) if (f.endsWith(".json")) list.push(...readJson(`${ARCHIVE}/${f}`, [])); } catch {}
  return list;
}
function seriesGroups() {
  const g = new Map();
  for (const m of allMails()) {
    const name = m.series && m.series.name;
    if (!name || isReceipt(m.subject)) continue; // 예전에 묶인 수신 확인 메일도 빼고 보여 준다
    if (!g.has(name)) g.set(name, []);
    g.get(name).push(m);
  }
  for (const arr of g.values()) arr.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  return g;
}
// 요약 지침에 넣을 "알고 있는 묶음" (묶음별 직전 회차, 최근 것 20개)
// 요약 지침에 넣을 "알고 있는 묶음": 이름 목록은 전부, 회차 기록(최근 5회차)은 이번 메일과 관련 있어 보이는 묶음만
// 관련: 보낸 사람이 같거나, 숫자·날짜를 뺀 제목 낱말이 절반 이상 겹치거나, 일감 번호(#1234)가 같음
const subjWords = (s) => new Set(String(s || "").toLowerCase().replace(/^\s*((re|fw|fwd|회신|답장|전달)\s*:\s*)+/i, "")
  .replace(/[0-9]+/g, " ").split(/[^0-9a-z가-힣]+/).filter((w) => w.length >= 2));
const ticketNos = (s) => new Set(String(s || "").match(/#\d{3,}/g) || []);
function seriesRelevant(arr, chunk) {
  return chunk.some((c) => {
    const cn = nameOf(c.from), cw = subjWords(c.subject), ct = ticketNos(c.subject);
    return arr.slice(0, 10).some((m) => {
      if (cn && nameOf(m.from) === cn) return true;
      if ([...ticketNos(m.subject)].some((t) => ct.has(t))) return true;
      const mw = subjWords(m.subject); if (!cw.size || !mw.size) return false;
      const hit = [...cw].filter((w) => mw.has(w)).length;
      return hit / Math.min(cw.size, mw.size) >= 0.5;
    });
  });
}
function seriesContext(chunkFile) {
  const chunk = chunkFile ? [].concat(readJson(chunkFile, [])) : [];
  const g = [...seriesGroups().entries()].sort((a, b) => (b[1][0].date + b[1][0].time).localeCompare(a[1][0].date + a[1][0].time)).slice(0, 30);
  if (!g.length) { console.log("(아직 없음)"); return; }
  const out = [];
  for (const [name, arr] of g) {
    const head = `- 묶음: ${name} (${arr.length}회차, 최근 ${arr[0].date} · ${nameOf(arr[0].from)} · ${arr[0].subject})`;
    if (!chunkFile || seriesRelevant(arr, chunk)) {
      out.push(head + "\n" + arr.slice(0, 5).map((m) => `  · ${(m.series && m.series.issue) || "-"} (${m.date} ${m.time}) | ${m.oneLine}\n    핵심: ${(m.points || []).slice(0, 5).join(" / ")}`).join("\n"));
    } else out.push(head + " — 회차 기록 생략(이번 메일과 관련 없어 보임)");
  }
  console.log(out.join("\n"));
}

// 수신 확인(읽음) 메일은 Claude 없이 저장 (자동 보안 검사가 "위험"이면 요약으로 보냄)
// 출력 마지막 줄: {"done": [처리한 dir...]}
function ingestReceipts(pendingFile) {
  const pending = [].concat(readJson(pendingFile, []));
  const list = pending.filter((p) => isReceipt(p.subject) && !(p.risk && p.risk.level === "high"));
  if (!list.length) { console.log(JSON.stringify({ done: [] })); return; }
  const mails = readJson(DATA, []), byId = new Map(mails.map((m) => [m.id, m])), now = new Date().toISOString();
  for (const p of list) {
    const id = idOf(p.dir), orig = String(p.subject).replace(/^\s*(수신\s*확인\s*(\(읽음\))?|읽음|read)\s*:\s*/i, "").trim();
    byId.set(id, { id, date: String(p.when || "").slice(0, 10), time: String(p.when || "").slice(11, 16), subject: p.subject, from: p.from || "",
      fromAddr: p.fromAddr || null, url: p.openUrl || null, dir: p.dir || null, category: "work", importance: "low",
      oneLine: `"${orig}" 메일을 ${nameOf(p.from) || "받는 사람"} 님이 읽었어요`.slice(0, 120), points: [], attachments: [], role: p.role || null,
      risk: p.risk || null, tasks: [], warning: null, receipt: true, addedAt: now, threadNew: [], quoted: [], threadOf: null, related: [], series: null });
  }
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(archiveOld([...byId.values()]), null, 1), "utf8");
  render();
  console.log(JSON.stringify({ done: list.map((p) => p.dir) }));
}

// 브리핑·마감 알림용 집계 (data/marks.json 의 체크 기록 반영) -> last-brief.json
function brief() {
  const mails = readJson(DATA, []);
  const marks = readJson(`${ROOT}/data/marks.json`, { done: {}, flag: {} });
  const done = marks.done || {}, flag = marks.flag || {};
  const k = new Date(Date.now() + 9 * 3600e3), today = k.toISOString().slice(0, 10);
  const work = mails.filter((m) => !(m.category === "promo" && !m.warning));
  const open = work.flatMap((m) => (m.tasks || []).filter((t) => !done[t.id] && t.kind !== "watch" && !t.superseded).map((t) => ({ text: t.text, due: t.due, subject: m.subject })));
  const dueToday = open.filter((t) => t.due === today);
  const overdue = open.filter((t) => t.due && t.due < today);
  const week = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const suspicious = work.filter((m) => m.warning && m.date >= week && !flag[m.id]).length;
  const res = { today, marksOk: !!marks.ok, open: open.length, dueToday: dueToday.map((t) => t.text), overdue: overdue.map((t) => t.text), suspicious };
  fs.writeFileSync(`${ROOT}/last-brief.json`, JSON.stringify(res), "utf8");
  console.log(JSON.stringify(res));
}

const PAGE_CSS = `
/* 대시보드 배치 · 값은 모두 디자인 시스템 토큰만 사용 */
html{-webkit-text-size-adjust:100%}
body{font-size:16px;line-height:26px}
/* 반응형 규칙: 모바일 좌우 16(space-4) · 태블릿 24 · 데스크톱 32 · 와이드 48, 와이드 최대 1600 */
.wrap{max-width:1600px;margin:0 auto;padding:var(--space-8) var(--space-8) var(--space-16)}
@media (min-width:1920px){.wrap{padding-left:var(--space-12);padding-right:var(--space-12)}}
@media (min-width:768px) and (max-width:1279px){.wrap{padding-left:var(--space-6);padding-right:var(--space-6)}}
/* 데스크톱 이상: 12열 중 5열(할 일·반복 메일) + 7열(받은 메일) */
@media (min-width:1280px){
  #main{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:var(--space-8);align-items:start}
  #main>.col>.sec:first-child{margin-top:0}
}
.top{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);flex-wrap:wrap;margin-bottom:var(--space-6)}
.top h1{margin:0;font-size:28px;line-height:36px;font-weight:700;letter-spacing:-0.01em;text-wrap:balance}
.top .hint{margin:0}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-4);margin-bottom:var(--space-6)}
@media (min-width:768px) and (max-width:1279px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
.stats .card{padding:var(--space-5) var(--space-6);gap:var(--space-1)}
.stats .value{font-size:28px;line-height:36px;font-weight:800;font-variant-numeric:tabular-nums}
.stats .label{display:flex;align-items:center;gap:var(--space-2);font-size:14px;line-height:22px;font-weight:500;color:var(--text-muted)}
.stats .dot{width:8px;height:8px;border-radius:var(--radius-full);background:var(--border-strong);flex:none}
.stats .dot.danger{background:var(--danger)}.stats .dot.warning{background:var(--warning)}.stats .dot.brand{background:var(--primary)}
.alert-row{margin-bottom:var(--space-8)}
.sec{display:flex;align-items:baseline;gap:var(--space-3);margin:var(--space-8) 0 var(--space-3)}
.sec h2{margin:0;font-size:22px;line-height:30px;font-weight:700}
.list{padding:0;gap:0;overflow:hidden}
.task{display:flex;align-items:center;gap:var(--space-4);padding:var(--space-3) var(--space-6);border-top:1px solid var(--border)}
.task:first-child{border-top:0}
.task .check{flex:1;min-width:0;align-items:flex-start;padding:var(--space-2) 0}
.task .check .box{margin-top:2px}
.task .txt{display:flex;flex-direction:column;min-width:0}
.task .what{font-weight:700}
.task .src{font-size:14px;line-height:22px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task .src a{color:inherit;text-underline-offset:3px}
@media (hover:hover){.task .src a:hover{color:var(--primary-text)}.srcinfo:hover{color:var(--text)}}
.list{overflow:visible}
/* 근거 칩: Badge 재질(surface · border · radius-full) + 아이콘, 마우스를 올리면 Tooltip */
.srcinfo{position:relative;align-self:flex-start;margin-top:var(--space-1);max-width:100%;font-weight:500;color:var(--text-muted);cursor:help}
.srcinfo .srclabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.srcinfo.none{cursor:default;border:0;background:none;padding:0;height:auto}
.srcinfo:focus-visible{color:var(--text)}
/* Tooltip: 마우스는 300ms 뒤, 키보드 포커스는 바로 보여요. Esc 로 닫혀요. 근거 원문을 담느라 최대 폭만 시스템(260px)보다 넓게 둬요 */
.srcinfo .tip{display:flex;visibility:hidden;opacity:0;position:absolute;top:calc(100% + var(--space-3));left:0;z-index:var(--z-tooltip);width:max-content;max-width:min(400px,80vw);text-align:left;white-space:normal;flex-direction:column;gap:var(--space-1);cursor:auto;animation:none;transition:opacity var(--duration-fast) var(--ease-in),visibility 0s linear var(--duration-fast)}
.srcinfo .tip::before,.srcinfo .tip::after{left:24px}
@media (hover:hover){.srcinfo:hover .tip{visibility:visible;opacity:1;transition:opacity var(--duration-fast) var(--ease-out) 300ms,visibility 0s linear 300ms}}
.srcinfo:focus-within .tip{visibility:visible;opacity:1;transition:opacity var(--duration-fast) var(--ease-out)}
.srcinfo.tip-off .tip{visibility:hidden !important;opacity:0 !important;transition:none !important}
.tip-row{display:flex;gap:var(--space-2);color:var(--text)}
.tip-row b{flex:none;color:var(--text-muted);font-weight:700}
.tip-quote{margin-top:var(--space-1);padding:var(--space-2) var(--space-3);border-radius:var(--radius-sm);background:var(--surface-subtle);color:var(--text);font-weight:400}
.tip-why{color:var(--text-muted);font-weight:400}
.task .owner{margin-left:var(--space-2);vertical-align:middle;font-weight:500}
.task.done .what{font-weight:500;color:var(--text-muted);text-decoration:line-through}
.task .badge{flex:none}
.done-acc{margin-top:var(--space-3)}
.done-acc .body{padding:0}
.done-acc .task{padding-left:var(--space-5);padding-right:var(--space-5)}
.day{font-size:14px;line-height:22px;font-weight:700;color:var(--text-muted);margin:var(--space-6) 0 var(--space-2)}
.mails summary{min-height:auto;padding:var(--space-4) var(--space-5);align-items:flex-start;gap:var(--space-4);font-weight:400}
.mails .m-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:var(--space-1)}
.mails .m-head{display:flex;align-items:center;gap:var(--space-3);min-width:0}
.mails .m-subj{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.mails .m-one{color:var(--text-muted)}
.mails .m-tags{display:flex;gap:var(--space-2);flex-wrap:wrap;margin-top:var(--space-1)}
.mails .m-side{display:flex;align-items:center;gap:var(--space-2);flex:none;color:var(--text-muted);font-size:14px;line-height:22px;font-variant-numeric:tabular-nums;padding-top:var(--space-1)}
.mails summary>span[aria-hidden]{display:none}
.mails .m-side .chev{display:inline-block;transition:transform var(--duration-base) var(--ease-out)}
.mails details[open] .m-side .chev{transform:rotate(180deg)}
.mails .body{color:var(--text);display:flex;flex-direction:column;gap:var(--space-3)}
.mails .from{font-size:14px;line-height:22px;color:var(--text-muted)}
.mails .blk h3{margin:0 0 var(--space-1);font-size:14px;line-height:22px;font-weight:700;color:var(--text-muted)}
.mails .blk ul{margin:0;padding-left:var(--space-5)}
.mails .blk li+li{margin-top:var(--space-1)}
.from-row{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap}
.from-row .btn{text-decoration:none}
.open-btns{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap}
.series summary{min-height:auto;padding:var(--space-4) var(--space-5);align-items:flex-start;gap:var(--space-4);font-weight:400}
.series summary>span[aria-hidden]{display:none}
.series .m-side .chev{display:inline-block;transition:transform var(--duration-base) var(--ease-out)}
.series details[open] .m-side .chev{transform:rotate(180deg)}
.series .s-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:var(--space-1)}
.series .s-head{display:flex;align-items:center;gap:var(--space-3)}
.series .s-name{font-weight:700}
.series .s-last{color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.series .s-ch-wrap{display:flex;gap:var(--space-3);align-items:flex-start;margin-top:var(--space-1);padding:var(--space-3) var(--space-4);border-radius:var(--radius-md);background:var(--surface-subtle)}
.series .s-ch-title{flex:none;font-size:14px;line-height:22px;font-weight:700;color:var(--primary-text)}
.series .s-changes{margin:0;padding-left:var(--space-5);font-size:14px;line-height:22px;color:var(--text)}
.series .body{color:var(--text)}
.series .s-hist-title{margin:0 0 var(--space-2);font-size:14px;line-height:22px;font-weight:700;color:var(--text-muted)}
.series .s-hist{list-style:none;margin:0;padding:0;border-left:2px solid var(--border)}
.series .s-item{display:flex;gap:var(--space-4);padding:var(--space-2) 0 var(--space-2) var(--space-4);position:relative}
.series .s-item::before{content:"";position:absolute;left:-6px;top:15px;width:10px;height:10px;border-radius:var(--radius-full);background:var(--border-strong)}
.series .s-item.now::before{background:var(--primary)}
.series .s-when{flex:none;width:120px;font-size:14px;line-height:22px;font-weight:700;color:var(--text-muted);font-variant-numeric:tabular-nums}
.series .s-body{display:flex;flex-direction:column;min-width:0}
.series .s-ch{font-size:14px;line-height:22px;color:var(--text-muted)}
.series .s-link{font-size:14px;line-height:22px;color:var(--primary-text);text-underline-offset:3px;align-self:flex-start}
.series .s-arch{font-size:14px;line-height:22px;color:var(--text-muted)}
@media (max-width:767px){.series .s-item{flex-direction:column;gap:0}.series .s-when{width:auto}}
.t-new{margin:0;padding:var(--space-3) var(--space-4) var(--space-3) var(--space-8);border-radius:var(--radius-md);background:var(--primary-subtle);color:var(--primary-subtle-text)}
.t-flow{list-style:none;margin:0;padding:0;border-left:2px solid var(--border)}
.t-flow li{display:flex;gap:var(--space-4);padding:var(--space-2) 0 var(--space-2) var(--space-4);position:relative}
.t-flow li::before{content:"";position:absolute;left:-6px;top:15px;width:10px;height:10px;border-radius:var(--radius-full);background:var(--border-strong)}
.t-flow li.now::before{background:var(--primary)}
.t-when{flex:none;width:96px;font-size:14px;line-height:22px;font-weight:700;color:var(--text-muted);font-variant-numeric:tabular-nums}
.t-body{display:flex;flex-direction:column;min-width:0}
.t-sub{font-size:14px;line-height:22px;color:var(--text-muted)}
@media (max-width:767px){.t-flow li{flex-direction:column;gap:0}.t-when{width:auto}}
.search-bar{margin-bottom:var(--space-6)}
.search .clear[hidden]{display:none}
/* 펼친 아코디언 본문은 제목 줄(호버 배경)과 띄워요 */
.mails .body,.series .body{padding-top:var(--space-4);border-top:1px solid var(--border)}
#main>.stats,#main>.alert-row{grid-column:1/-1}
@media (min-width:1280px){#main>.stats,#main>.alert-row{margin-bottom:0}}
.more-row{display:flex;justify-content:center;padding:var(--space-2)}
.promo-acc{margin-top:var(--space-8)}
.promo-acc summary{color:var(--text-muted)}
.promo-acc .promo-list{padding:0;color:var(--text)}
.promo-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:0 var(--space-4);padding:var(--space-3) var(--space-5);border-top:1px solid var(--border);align-items:baseline}
.promo-row .p-subj{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.promo-row .p-from,.promo-row .p-when{font-size:14px;line-height:22px;color:var(--text-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.promo-row .p-one{grid-column:1/-1;font-size:14px;line-height:22px;color:var(--text-muted)}
@media (max-width:767px){.promo-row{grid-template-columns:minmax(0,1fr) auto}.promo-row .p-from{display:none}}
.flag-actions{display:flex;gap:var(--space-3);flex-wrap:wrap}
.mails .banner{box-shadow:none}
.mails .banner .btn{flex:none}
.banner button.act{border:0;background:none;font-family:inherit;cursor:pointer}
.empty .hint{max-width:360px}
.series details.flash>summary{box-shadow:inset 0 0 0 2px var(--primary)}
.mails details.flash>summary{box-shadow:inset 0 0 0 2px var(--primary)}
@media (max-width:767px){
  .wrap{padding:var(--space-6) var(--space-4) var(--space-12)}
  .top h1{font-size:24px;line-height:34px}
  .stats{grid-template-columns:minmax(0,1fr);gap:var(--space-3)}
  .task{padding:var(--space-3) var(--space-4);flex-wrap:wrap;gap:0 var(--space-3)}
  .task>.badge{margin-left:calc(22px + var(--space-3))}
  .mails summary{padding:var(--space-4)}
}`;

function render() {
  const mails = readJson(DATA, []);
  // 그룹웨어 메일 보기 주소 (포털 wfrmpage 가 메일 문서를 팝업 화면으로 감싸서 보여줌)
  for (const m of mails) {
    if (isReceipt(m.subject)) delete m.series; // 읽음 확인 메일은 묶음 표시 없이 (화면용 사본에서만)
    const unid = (String(m.url || "").match(/\/0\/([0-9A-Fa-f]{32})/) || [])[1];
    m.gwUrl = unid && CFG.mailViewPath ? GW + CFG.mailViewPath.replace("{mailDb}", CFG.mailDb).replace("{unid}", unid) : null;
  }
  const data = JSON.stringify(mails).replace(/</g, "\\u003c");
  // 수집 상태: 로그인 필요 / 수집 실패 (run.mjs 가 남기는 파일)
  const loginSt = fs.existsSync(`${ROOT}/login-required.flag`) ? (readJson(`${ROOT}/login-required.flag`, null) || { since: new Date(fs.statSync(`${ROOT}/login-required.flag`).mtimeMs).toISOString() }) : null;
  const failSt = readJson(`${ROOT}/collect-fail.json`, null);
  const statusData = JSON.stringify({ loginSince: loginSt && loginSt.since || null, failSince: failSt && failSt.notified ? failSt.since : null }).replace(/</g, "\\u003c");
  const series = [...seriesGroups().entries()].map(([name, arr]) => ({
    name, items: arr.slice(0, 26).map((m) => ({ id: m.id, date: m.date, time: m.time, subject: m.subject, oneLine: m.oneLine,
      issue: m.series.issue, changes: m.series.changes || [], compared: !!m.series.compared, points: m.points || [] })),
  })).sort((a, b) => (b.items[0].date + b.items[0].time).localeCompare(a.items[0].date + a.items[0].time)); // 가장 최근에 받은 묶음이 위
  const seriesData = JSON.stringify(series).replace(/</g, "\\u003c");
  const inDash = new Set(mails.map((m) => m.id));
  const threads = {}, cardOf = new Map(), groupOf = new Map(), everyMail = new Map(allMails().map((m) => [m.id, m]));
  for (const arr of threadGroups().values()) {
    const latest = arr.find((m) => inDash.has(m.id));
    if (!latest) continue;
    for (const m of arr) { cardOf.set(m.id, latest.id); groupOf.set(m.id, arr); }
    const rows = arr.map((m) => ({ id: m.id, date: m.date, time: m.time, from: m.from, oneLine: m.oneLine, threadNew: m.threadNew || [], here: inDash.has(m.id) }));
    // 인용으로만 확인된 메일: 받은 메일과 날짜·보낸 사람이 같고 시각이 같으면(시각을 모르면 날짜·이름만) 같은 메일로 보고 뺀다
    const same = (a, b) => a.date === b.date && nameOf(a.from) === nameOf(b.from) && (!a.time || !b.time || a.time === b.time);
    for (const m of arr) for (const q of m.quoted || []) {
      if (rows.some((r) => same(r, q))) continue;
      rows.push({ id: null, date: q.date, time: q.time || "", from: q.from, oneLine: q.oneLine, threadNew: [], here: false, quoted: true });
    }
    if (rows.length < 2) continue;
    rows.sort((a, b) => (b.date + (b.time || "00:00")).localeCompare(a.date + (a.time || "00:00")));
    threads[latest.id] = rows.slice(0, 30);
  }
  // 관련 대화: 대화 카드 단위로 양쪽에 보여 준다 (같은 대화 안의 메일끼리는 빼고)
  const related = {};
  const addRel = (fromId, toId, why) => {
    const a = cardOf.get(fromId) || (inDash.has(fromId) ? fromId : null);
    const b = cardOf.get(toId) || (inDash.has(toId) ? toId : null);
    const target = everyMail.get(toId); if (!a || !target || a === b) return;
    const list = (related[a] ||= []);
    if (list.some((x) => (b && x.card === b) || x.id === toId)) return;
    list.push({ id: toId, card: b, subject: (groupOf.get(toId) || [target])[0].subject, date: target.date, why: why || null });
  };
  for (const m of everyMail.values()) for (const r of m.related || []) { addRel(m.id, r.id, r.why); addRel(r.id, m.id, r.why); }
  const relatedData = JSON.stringify(related).replace(/</g, "\\u003c");
  const threadData = JSON.stringify(threads).replace(/</g, "\\u003c");
  const built = new Date(Date.now() + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 16);
  // 글꼴(2.7MB)은 매번 넣지 않고 ds/font.css 를 링크로 건다 (대시보드는 이 폴더에서 바로 여는 파일이라 상대 경로가 맞음)
  const ds = ["tokens.css", "bundle.css"].map((f) => { try { return fs.readFileSync(`${DS}/${f}`, "utf8"); } catch { return ""; } }).join("\n");
  const fontHref = path.relative(path.dirname(OUT), `${DS}/font.css`).split(path.sep).join("/");
  fs.writeFileSync(OUT, `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>메일 할 일</title>
<link rel="stylesheet" href="${fontHref}">
<style>${ds}</style>
<style>${PAGE_CSS}</style>
</head>
<body><div class="wrap">
  <header class="top"><h1>메일 할 일</h1><p class="hint">마지막 갱신 ${built}</p></header>
  <span class="search search-bar" role="search"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
    <input id="q" class="input" type="search" placeholder="제목, 보낸 사람, 할 일, 내용으로 찾기 (Ctrl+F)" aria-label="메일 검색" autocomplete="off">
    <button type="button" class="clear" data-clear="1" aria-label="검색어 지우기" hidden><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span>
  <section id="searchRes" style="display:none"><div class="sec"><h2 id="searchSum" aria-live="polite"></h2></div><div id="searchList"></div></section>
  <div id="main">
  <section class="stats" id="stats" aria-label="요약"></section>
  <div class="alert-row" id="alert"></div>

  <div class="col">
  <div class="sec"><h2>처리할 일</h2><span class="hint" id="taskHint"></span></div>
  <div class="card list" id="open"></div>
  <div class="acc done-acc" id="watchWrap"><details><summary><span><span id="watchSum"></span> <span class="hint" style="font-weight:500">· 숫자·알림에는 빠져요</span></span><span aria-hidden="true">⌄</span></summary><div class="body" id="watch"></div></details></div>
  <div class="acc done-acc" id="doneWrap"><details><summary><span><span id="doneSum"></span> <span class="hint" style="font-weight:500">· 체크 후 7일 동안 보여요</span></span><span aria-hidden="true">⌄</span></summary><div class="body" id="done"></div></details></div>

  <div id="seriesSec"><div class="sec"><h2>반복 메일</h2><span class="hint">같은 종류끼리 묶어 지난번과 달라진 점을 보여 드려요</span></div>
  <div class="acc series" id="series"></div></div>
  </div>

  <div class="col">
  <div class="sec"><h2>받은 메일</h2><span class="hint">눌러서 자세히 보기</span></div>
  <div id="mails"></div>
  <div class="acc promo-acc" id="promo"></div>
  </div>
  </div>
</div>
<script>
const MAILS = ${data};
const SERIES = ${seriesData};
const STATUS = ${statusData}; // 수집 중단 상태
const GW_HOME = ${JSON.stringify(GW + "/")};
const LATEST = new Set(SERIES.map(s => s.items[0].id)); // 묶음별 최신 회차
const SERIES_N = {}; for (const s of SERIES) SERIES_N[s.name] = s.items.length; // 묶음별 회차 수
const THREADS = ${threadData}; // 대화 묶음: 최신 메일 id -> 대화 전체(최신순, 인용으로만 확인된 메일 포함)
const RELATED = ${relatedData}; // 관련 대화: 대화 카드 id -> [{ id, card, subject, date, why }]
const OPENMAP = {}; // 목록에서 숨긴 대화 속 메일 -> 최신 메일
for (const [lid, arr] of Object.entries(THREADS)) for (const it of arr) if (it.id && it.id !== lid) OPENMAP[it.id] = lid;
const store = {
  get(k){ try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
  set(k,v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const doneMap = store.get("gwmail.done") || {};
const flagMap = store.get("gwmail.flag") || {}; // 의심 메일 판정: { [메일id]: { v: "safe" | "danger", at } }
const flagOf = m => (m.warning && flagMap[m.id]) ? flagMap[m.id].v : null;
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const pad = n => String(n).padStart(2,"0");
const today = (() => { const d = new Date(); return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()); })();
const dayDiff = d => Math.round((new Date(d+"T00:00:00") - new Date(today+"T00:00:00")) / 86400000);
const WD = ["일","월","화","수","목","금","토"];
const md = d => d.slice(5).replace("-","/");
const ICON = {
  clip: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5l-8.5 8.5a5 5 0 0 1-7-7L14 4.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.7a1.7 1.7 0 0 1-2.4-2.4L15.5 7.6"/></svg>',
  mail: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  warn: '<svg class="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18.5v.01"/></svg>',
  check: '<svg class="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/></svg>',
  clock: '<svg class="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  done: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--border-strong)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/></svg>',
  inbox: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--border-strong)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 2h6l1-2h5"/></svg>'
};
function dueBadge(due){
  if(!due) return '<span class="badge"><span class="dot"></span>기한 없음</span>';
  const n = dayDiff(due), wd = WD[new Date(due+"T00:00:00").getDay()];
  if(n < 0) return '<span class="badge danger"><span class="dot"></span>'+(-n)+'일 지남</span>';
  if(n === 0) return '<span class="badge danger"><span class="dot"></span>오늘까지</span>';
  if(n === 1) return '<span class="badge warning"><span class="dot"></span>내일까지</span>';
  if(n <= 3) return '<span class="badge warning"><span class="dot"></span>'+md(due)+'('+wd+')</span>';
  return '<span class="badge"><span class="dot"></span>'+md(due)+'('+wd+')</span>';
}
const imp = {high:0, mid:1, low:2};
const isPromo = m => m.category === "promo" && !m.warning;
const WORK = MAILS.filter(m => !isPromo(m)), PROMO = MAILS.filter(isPromo);
const tasks = WORK.flatMap(m => (m.tasks||[]).filter(t => !t.superseded).map(t => ({...t, mail:m}))); // 답장으로 낡은 할 일(변경됨)은 목록에서 뺌
const DONE_KEEP_DAYS = 7;
const WATCH_HIDE_AFTER_DAYS = 3; // 마감이 3일 지난 지켜볼 일은 숨김(내 일이 아니므로)
// 칸별로 처음 보여 줄 개수 ("더 보기"로 늘어남)
const SHOW = { open: 10, watch: 10, series: 5, hist: {}, mailDays: 3, promo: 20 };
const moreBtn = (key, left, label) => left > 0 ? '<div class="more-row"><button type="button" class="btn ghost" data-more="'+esc(key)+'">'+(label || (left+"개 더 보기"))+'</button></div>' : '';
let TIPN = 0;
function srcInfo(s){
  if(!s || !s.file) return '<span class="srcinfo none">근거 위치 정보 없음</span>';
  const isBody = s.file === "메일 본문";
  const label = (isBody ? "메일 본문" : s.file) + (s.where ? " · " + s.where : "");
  const tip = '<span class="tip below" role="tooltip">'+
    '<span class="tip-row"><b>파일</b>'+esc(s.file)+'</span>'+
    (s.where ? '<span class="tip-row"><b>위치</b>'+esc(s.where)+'</span>' : '')+
    (s.quote ? '<span class="tip-quote">“'+esc(s.quote)+'”</span>' : '')+
    (s.why ? '<span class="tip-why">'+esc(s.why)+'</span>' : '')+
    '</span>';
  const tid = "tip" + (++TIPN);
  return '<span class="badge srcinfo" tabindex="0" aria-describedby="'+tid+'">'+(isBody ? ICON.mail : ICON.clip)+'<span class="srclabel">'+esc(label)+'</span>'+tip.replace('role="tooltip"', 'role="tooltip" id="'+tid+'"')+'</span>';
}
function taskRow(t){
  const done = !!doneMap[t.id];
  const who = (t.mail.from||"").split("·")[0].trim();
  const owner = t.kind === "watch" ? ' <span class="badge owner"><span class="dot"></span>담당 '+esc(t.owner || "미정")+'</span>' : '';
  return '<div class="task'+(done?" done":"")+(t.kind === "watch" ? " watch" : "")+'"><label class="check"><input type="checkbox" class="box" data-id="'+esc(t.id)+'"'+(done?" checked":"")+'>'+
    '<span class="txt"><span class="what">'+esc(t.text)+owner+'</span><span class="src"><a href="#'+esc(t.mail.id)+'" data-open="'+esc(t.mail.id)+'">'+esc(t.mail.subject)+'</a> · '+esc(who)+'</span>'+srcInfo(t.source)+'</span></label>'+
    (done ? '<span class="badge success"><span class="dot"></span>'+esc(md(String(doneMap[t.id]).slice(0,10)))+' 완료</span>' : dueBadge(t.due))+'</div>';
}
function render(){
  const byDue = (a,b) => {
    const da = a.due || "9999-99-99", db = b.due || "9999-99-99";
    return da < db ? -1 : da > db ? 1 : imp[a.mail.importance] - imp[b.mail.importance];
  };
  const open = tasks.filter(t => !doneMap[t.id] && t.kind !== "watch").sort(byDue);
  const watch = tasks.filter(t => !doneMap[t.id] && t.kind === "watch" && !(t.due && dayDiff(t.due) < -WATCH_HIDE_AFTER_DAYS)).sort(byDue);
  const doneCut = Date.now() - DONE_KEEP_DAYS*864e5; // 완료한 일은 체크 후 7일만 보여요
  const done = tasks.filter(t => doneMap[t.id] && new Date(doneMap[t.id]).getTime() >= doneCut).sort((a,b) => String(doneMap[b.id]).localeCompare(String(doneMap[a.id])));
  const wbox = document.getElementById("watchWrap");
  wbox.style.display = watch.length ? "" : "none";
  document.getElementById("watchSum").textContent = "지켜볼 일 · 참조 메일 "+watch.length+"개";
  document.getElementById("watch").innerHTML = watch.slice(0, SHOW.watch).map(taskRow).join("") + moreBtn("watch", watch.length - SHOW.watch);
  const dueToday = open.filter(t => t.due && dayDiff(t.due) <= 0);
  const dueSoon = open.filter(t => t.due && dayDiff(t.due) === 1);
  const todayMails = WORK.filter(m => m.date === today).length;
  const week = new Date(Date.now() - 7*864e5).toISOString().slice(0,10);
  const warns = MAILS.filter(m => m.warning && m.date >= week && !flagOf(m));
  const stat = (v, label, dot) => '<div class="card"><span class="value">'+v+'</span><span class="label"><span class="dot '+dot+'"></span>'+label+'</span></div>';
  document.getElementById("stats").innerHTML =
    stat(open.length, "남은 할 일", "brand") +
    stat(dueToday.length + dueSoon.length, "오늘·내일 마감", (dueToday.length ? "danger" : dueSoon.length ? "warning" : "")) +
    stat(todayMails, "오늘 받은 메일", "") +
    stat(warns.length, "확인할 의심 메일", warns.length ? "danger" : "");

  let alert = "";
  const hm = iso => { const d = new Date(iso); return (d.toDateString() === new Date().toDateString() ? "" : (d.getMonth()+1) + "/" + d.getDate() + " ") + String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0"); };
  if(STATUS.loginSince) alert += '<div class="banner danger" role="alert">'+ICON.warn+'<div class="txt"><strong>메일 수집이 멈춰 있어요 · '+esc(hm(STATUS.loginSince))+'부터 그룹웨어 로그인 필요</strong>그룹웨어 로그인이 풀렸어요. ego 브라우저에서 다시 로그인하면 밀린 메일을 이어서 가져와요.</div><a class="act" href="'+esc(GW_HOME)+'" target="_blank" rel="noopener">그룹웨어 로그인 열기</a></div>';
  else if(STATUS.failSince) alert += '<div class="banner danger" role="alert">'+ICON.warn+'<div class="txt"><strong>메일 수집이 멈춰 있어요 · '+esc(hm(STATUS.failSince))+'부터</strong>ego 브라우저가 켜져 있는지, PC가 절전 상태가 아닌지 확인해 주세요.</div></div>';
  if(alert) alert += '<div style="height:var(--space-3)"></div>';
  if(dueToday.length) alert += '<div class="banner danger" role="alert">'+ICON.clock+'<div class="txt"><strong>오늘 마감인 일이 '+dueToday.length+'개 있어요</strong>'+esc(dueToday.map(t => t.text).join(" · "))+'</div></div>';
  if(warns.length) alert += '<div class="banner warning" role="status" style="margin-top:var(--space-3)">'+ICON.warn+'<div class="txt"><strong>확인이 필요한 의심 메일이 '+warns.length+'통 있어요</strong>열어 보고 의심 해제 또는 위험으로 표시해 주세요. '+esc(warns.map(m => m.subject).join(" · "))+'</div><a class="act" href="#'+esc(warns[0].id)+'" data-open="'+esc(warns[0].id)+'">확인하기</a></div>';
  document.getElementById("alert").innerHTML = alert;
  document.getElementById("alert").style.display = alert ? "" : "none";

  document.getElementById("taskHint").textContent = open.length ? "마감이 가까운 순서예요. 끝낸 일은 체크하세요." : "";
  document.getElementById("open").innerHTML = open.length ? open.slice(0, SHOW.open).map(taskRow).join("") + moreBtn("open", open.length - SHOW.open) :
    '<div class="empty">'+ICON.done+'<b style="font-size:18px">남은 할 일이 없어요</b><span class="hint">새 메일에서 할 일이 생기면 여기에 바로 보여 드릴게요.</span></div>';
  document.getElementById("doneWrap").style.display = done.length ? "" : "none";
  document.getElementById("doneSum").textContent = "완료한 일 "+done.length+"개";
  document.getElementById("done").innerHTML = done.map(taskRow).join("");
}
const issueLabel = it => (it.issue && it.issue !== md(it.date) ? it.issue + " · " : "") + md(it.date); // 회차 이름이 날짜와 같으면 한 번만
function renderSeries(){
  const box = document.getElementById("seriesSec");
  box.style.display = SERIES.length ? "" : "none";
  if(!SERIES.length) return;
  const openNow = new Set([...document.querySelectorAll("#series details[open]")].map(d => d.dataset.name));
  document.getElementById("series").innerHTML = SERIES.slice(0, SHOW.series).map(s => {
    const last = s.items[0], n = s.items.length, histN = SHOW.hist[s.name] || 10;
    const lastLabel = issueLabel(last);
    const changes = last.changes.length
      ? '<ul class="s-changes">'+last.changes.map(c => '<li>'+esc(c)+'</li>').join("")+'</ul>'
      : '<span class="hint">'+(n === 1 ? "첫 회차라 비교할 이전 기록이 없어요" : last.compared ? "지난 회차와 달라진 점이 없어요" : "이전 회차 정보 없이 요약돼서 비교하지 못했어요")+'</span>';
    const hist = s.items.slice(0, histN).map((it, i) => '<li class="s-item'+(i===0?" now":"")+'"><span class="s-when">'+esc(issueLabel(it))+'</span>'+
      '<span class="s-body"><span class="s-one">'+esc(it.oneLine)+'</span>'+
      (it.changes.length ? '<span class="s-ch">'+it.changes.map(esc).join(" · ")+'</span>' : '')+
      (i === 0 && MAILS.some(m => m.id === it.id) ? '<a href="#'+esc(it.id)+'" data-open="'+esc(it.id)+'" class="s-link">받은 메일에서 자세히 보기</a>'
        : (it.points.length ? '<span class="s-ch">'+it.points.slice(0, 3).map(esc).join(" · ")+'</span>' : ''))+
      '</span></li>').join("");
    return '<details data-name="'+esc(s.name)+'"'+(openNow.has(s.name)?" open":"")+'><summary><span class="s-main">'+
      '<span class="s-head"><span class="s-name">'+esc(s.name)+'</span><span class="badge brand"><span class="dot"></span>'+n+'회차</span></span>'+
      '<span class="s-last">최근 '+esc(lastLabel)+' · '+esc(last.oneLine)+'</span>'+
      '<span class="s-ch-wrap"><span class="s-ch-title">지난번 대비</span>'+changes+'</span>'+
      '</span><span class="m-side"><span class="chev" aria-hidden="true">⌄</span></span><span aria-hidden="true"></span></summary>'+
      '<div class="body"><h3 class="s-hist-title">회차별 기록</h3><ol class="s-hist">'+hist+'</ol>'+moreBtn("hist:"+s.name, n - histN, "이전 회차 "+(n - histN)+"개 더 보기")+'</div></details>';
  }).join("") + moreBtn("series", SERIES.length - SHOW.series, "반복 메일 묶음 "+(SERIES.length - SHOW.series)+"개 더 보기");
}
// 규칙 기반 자동 보안 검사 결과 목록
function riskList(m){
  if(!m.risk || !(m.risk.reasons||[]).length) return "";
  return '<div class="blk"><h3>자동 보안 검사 · '+(m.risk.level === "high" ? "위험" : "주의")+'</h3><ul>'+m.risk.reasons.map(x => '<li>'+esc(x)+'</li>').join("")+'</ul></div>';
}
// 보안 담당자에게 보낼 신고 내용 복사 (발송은 직접)
function reportBtn(m){ return '<button type="button" class="btn ghost" data-report="'+esc(m.id)+'">신고 내용 복사하기</button>'; }
function reportText(m){
  const lines = ["[의심 메일 신고]", "제목: " + m.subject, "보낸 사람: " + m.from, "받은 시각: " + m.date + " " + m.time];
  if(m.warning) lines.push("AI 판단: " + m.warning);
  if(m.risk && (m.risk.reasons||[]).length) lines.push("자동 검사: " + m.risk.reasons.join(" / "));
  if(m.gwUrl) lines.push("그룹웨어 메일: " + m.gwUrl);
  lines.push("", "링크나 첨부는 열지 않았습니다. 확인 부탁드립니다.");
  return lines.join(String.fromCharCode(10));
}
function warnBlock(m, fl, wTitle){
  const why = esc(m.warning.split(":").slice(1).join(":").trim());
  const when = fl ? esc(md(String(flagMap[m.id].at).slice(0,10))) : "";
  if(fl === "safe") return '<div class="banner success" role="status">'+ICON.check+'<div class="txt"><strong>의심을 해제했어요 · '+when+'</strong>AI 판단: '+esc(wTitle)+(why?' — '+why:'')+'</div>'+
    '<button type="button" class="act" data-flag="'+esc(m.id)+'" data-v="">되돌리기</button></div>';
  if(fl === "danger") return riskList(m) + '<div class="flag-actions">'+reportBtn(m)+'</div>' + '<div class="banner danger" role="alert">'+ICON.warn+'<div class="txt"><strong>위험 메일로 표시했어요 · '+when+'</strong>링크를 누르거나 코드를 입력하지 마세요. 정보보안 담당자에게 신고하면 좋아요.</div>'+
    '<button type="button" class="act" data-flag="'+esc(m.id)+'" data-v="">되돌리기</button></div>';
  return '<div class="banner warning" role="alert">'+ICON.warn+'<div class="txt"><strong>'+esc(wTitle)+' · 확인이 필요해요</strong>'+why+'</div></div>'+riskList(m)+
    '<div class="flag-actions"><button type="button" class="btn outline" data-flag="'+esc(m.id)+'" data-v="safe">의심 해제하기</button>'+
    '<button type="button" class="btn secondary" data-flag="'+esc(m.id)+'" data-v="danger">위험으로 표시하기</button>'+reportBtn(m)+'</div>';
}
const LV = {high:['danger','중요'], mid:['warning','보통'], low:['','참고']};
function mailItem(m, prefix){
  const [cls, txt] = LV[m.importance] || LV.mid;
  const tags = [];
  const th = THREADS[m.id];
  if((m.tasks||[]).length) tags.push('<span class="tag">할 일 '+m.tasks.length+'</span>');
  if(th) tags.push('<span class="tag">대화 '+th.length+'통</span>');
  const rel = RELATED[m.id] || [];
  if(rel.length) tags.push('<span class="tag">관련 대화 '+rel.length+'</span>');
  const sN = m.series && m.series.name ? (SERIES_N[m.series.name] || 1) : 0;
  if(sN) tags.push('<span class="tag">'+esc(m.series.name)+(m.series.issue ? ' · '+esc(m.series.issue) : '')+(sN > 1 ? ' · '+sN+'회차' : '')+'</span>');
  if((m.attachments||[]).length) tags.push('<span class="tag">첨부 '+m.attachments.length+'</span>');
  const fl = flagOf(m), wTitle = m.warning ? m.warning.split(":")[0] : "";
  if(m.warning) tags.push(
    fl === "safe" ? '<span class="badge success"><span class="dot"></span>의심 해제</span>' :
    fl === "danger" ? '<span class="badge danger"><span class="dot"></span>위험 메일</span>' :
    '<span class="badge warning"><span class="dot"></span>'+esc(wTitle)+' · 확인 필요</span>');
  if(!m.warning && m.risk && m.risk.level === "mid") tags.push('<span class="badge warning"><span class="dot"></span>보안 주의</span>');
  // 대화로 묶이면 앞선 메일은 목록에서 숨는다. 그 메일에 의심 경고가 있으면 이 카드에서 판정할 수 있게 함께 보여 준다
  const tw = (th || []).filter(it => it.id !== m.id).map(it => MAILS.find(x => x.id === it.id)).filter(x => x && x.warning);
  const twOpen = tw.filter(x => !flagOf(x)).length;
  if(twOpen && !(m.warning && !fl)) tags.push('<span class="badge warning"><span class="dot"></span>대화 속 의심 메일 '+twOpen+'통 · 확인 필요</span>');
  const threadWarn = tw.map(x => '<div class="blk"><h3>대화 속 앞선 메일 · '+esc(md(x.date))+' '+esc(x.time)+' · '+esc((x.from||"").split("·")[0].trim())+'</h3></div>'+
    warnBlock(x, flagOf(x), x.warning.split(":")[0])).join("");
  const blk = (title, arr) => arr && arr.length ? '<div class="blk"><h3>'+title+'</h3><ul>'+arr.map(x => '<li>'+x+'</li>').join("")+'</ul></div>' : "";
  return '<details id="'+esc((prefix || "")+m.id)+'"><summary>'+
    '<span class="m-main"><span class="m-head"><span class="badge '+cls+'"><span class="dot"></span>'+txt+'</span><span class="m-subj">'+esc(m.subject)+'</span></span>'+
    '<span class="m-one">'+esc(m.oneLine)+'</span>'+(tags.length?'<span class="m-tags">'+tags.join("")+'</span>':"")+'</span>'+
    '<span class="m-side">'+(prefix ? esc(md(m.date))+' ' : '')+esc(m.time)+'<span class="chev" aria-hidden="true">⌄</span></span><span aria-hidden="true"></span>'+
    '</summary><div class="body"><div class="from-row"><span class="from">보낸 사람 · '+esc(m.from)+'</span>'+
    '<span class="open-btns">'+(sN > 1 ? '<button type="button" class="btn ghost" data-series="'+esc(m.series.name)+'">회차 기록 보기 · '+sN+'회차</button>' : '')+
    '<a class="btn secondary" href="'+esc(m.gwUrl || GW_HOME)+'" target="_blank" rel="noopener">'+(m.gwUrl ? "그룹웨어에서 열기" : "그룹웨어 열기")+'</a></span></div>'+
    (m.warning ? warnBlock(m, fl, wTitle) : riskList(m))+threadWarn+
    blk("할 일", (m.tasks||[]).map(t => t.superseded ? '<s>'+esc(t.text)+'</s> <span class="badge"><span class="dot"></span>변경됨</span>'+(t.superseded.why ? '<br><span class="hint">'+esc(t.superseded.why)+'</span>' : "") : esc(t.text)+(t.due?' · '+esc(md(t.due))+'까지':"")+(t.kind === "watch" ? ' · 지켜볼 일(담당 '+esc(t.owner || "미정")+')' : '')+'<br>'+srcInfo(t.source))) +
    ((m.threadNew||[]).length ? '<div class="blk"><h3>이번 답장에서 새로 나온 내용</h3><ul class="t-new">'+m.threadNew.map(x => '<li>'+esc(x)+'</li>').join("")+'</ul></div>' : '') +
    blk("핵심 내용", (m.points||[]).map(esc)) +
    (th ? '<div class="blk"><h3>대화 흐름 · '+th.length+'통</h3><ol class="t-flow">'+th.map((it, i) =>
      '<li class="'+(i===0?"now":"")+'"><span class="t-when">'+esc(md(it.date))+' '+esc(it.time)+'</span><span class="t-body"><b>'+esc((it.from||"").split("·")[0].trim())+'</b> '+esc(it.oneLine)+
      (it.threadNew.length ? '<span class="t-sub">새 내용: '+it.threadNew.map(esc).join(" · ")+'</span>' : '')+
      (it.quoted ? '<span class="t-sub">받은편지함에는 없고 인용으로만 확인</span>' : it.here ? '' : '<span class="t-sub">월별 보관 파일에 있어요</span>')+'</span></li>').join("")+'</ol></div>' : '') +
    (rel.length ? '<div class="blk"><h3>관련 대화</h3><ul>'+rel.map(r => '<li>'+(r.card ? '<a href="#'+esc(r.card)+'" data-open="'+esc(r.card)+'">'+esc(r.subject)+'</a>' : esc(r.subject)+' <span class="hint">(월별 보관 파일)</span>')+
      ' <span class="hint">· '+esc(md(r.date))+(r.why ? ' · '+esc(r.why) : '')+'</span></li>').join("")+'</ul></div>' : '') +
    blk("첨부", (m.attachments||[]).map(esc)) +
    '</div></details>';
}
function dayLabel(date){
  const n = dayDiff(date);
  return (n===0?"오늘 · ":n===-1?"어제 · ":"") + date.replace(/-/g,".") + " ("+WD[new Date(date+"T00:00:00").getDay()]+")";
}
function listMails(){
  const recent = new Date(Date.now() - ${KEEP_DAYS}*864e5).toISOString().slice(0,10);
  return WORK.filter(m => !OPENMAP[m.id]) // 반복 메일도 받은 메일에는 날짜별로 모두 보여요(묶음은 반복 메일 칸에서)
    .filter(m => m.date >= recent || (m.tasks||[]).some(t => !doneMap[t.id])).sort((a,b) => (b.date+b.time).localeCompare(a.date+a.time));
}
function renderMails(){
  const sorted = listMails();
  const shown = sorted.filter(m => dayDiff(m.date) > -SHOW.mailDays);
  const left = sorted.length - shown.length;
  const groups = [];
  for(const m of shown){ const g = groups[groups.length-1]; if(g && g.date === m.date) g.items.push(m); else groups.push({date:m.date, items:[m]}); }
  const html = groups.map(g => '<div class="day">'+dayLabel(g.date)+'</div><div class="acc mails">'+g.items.map(m => mailItem(m)).join("")+'</div>').join("");
  document.getElementById("mails").innerHTML = (html ||
    '<div class="card"><div class="empty">'+ICON.inbox+'<b style="font-size:18px">최근 '+SHOW.mailDays+'일 동안 받은 메일이 없어요</b><span class="hint">새 메일이 오면 1분 안에 요약해서 여기에 보여 드릴게요.</span></div></div>') +
    moreBtn("mail", left, "지난 메일 더 보기 · "+left+"통");

  const promoBox = document.getElementById("promo");
  promoBox.style.display = PROMO.length ? "" : "none";
  if(PROMO.length){
    const ps = [...PROMO].sort((a,b) => (b.date+b.time).localeCompare(a.date+a.time));
    const wasOpen = promoBox.querySelector("details")?.open;
    promoBox.innerHTML = '<details'+(wasOpen?" open":"")+'><summary><span>광고·뉴스레터 '+ps.length+'통 <span class="hint" style="font-weight:500">· 알림 없이 모아 둬요</span></span><span aria-hidden="true">⌄</span></summary><div class="body promo-list">'+
      ps.slice(0, SHOW.promo).map(m => '<div class="promo-row"><span class="p-subj">'+esc(m.subject)+'</span><span class="p-from">'+esc((m.from||"").split("·")[0].trim())+'</span><span class="p-when">'+esc(md(m.date))+' '+esc(m.time)+'</span>'+
        (m.oneLine ? '<span class="p-one">'+esc(m.oneLine)+'</span>' : "")+'</div>').join("")+moreBtn("promo", ps.length - SHOW.promo)+'</div></details>';
  }
}
// 검색: 제목·보낸 사람·한 줄 요약·핵심 내용·할 일·첨부·묶음 이름 (대시보드에 있는 메일 전체, 광고 포함)
function haystack(m){
  return [m.subject, m.from, m.oneLine, (m.points||[]).join(" "), (m.attachments||[]).join(" "), (m.tasks||[]).map(t => t.text + " " + (t.owner||"") + " " + ((t.source && t.source.quote) || "")).join(" "),
    (m.series && m.series.name) || "", (m.threadNew||[]).join(" ")].join(" ").toLowerCase();
}
function renderSearch(){
  const q = document.getElementById("q").value.trim().toLowerCase();
  const res = document.getElementById("searchRes"), main = document.getElementById("main");
  if(!q){ res.style.display = "none"; main.style.display = ""; return; }
  const words = q.split(" ").filter(Boolean);
  const hits = MAILS.filter(m => { const h = haystack(m); return words.every(w => h.includes(w)); })
    .sort((a,b) => (b.date+b.time).localeCompare(a.date+a.time));
  main.style.display = "none"; res.style.display = "";
  document.getElementById("searchSum").textContent = "“"+document.getElementById("q").value.trim()+"” 검색 결과 "+hits.length+"통";
  document.getElementById("searchList").innerHTML = hits.length
    ? '<div class="acc mails">'+hits.slice(0, 50).map(m => mailItem(m, "s-")).join("")+'</div>'+(hits.length > 50 ? '<p class="hint">결과가 많아 최근 50통만 보여 드려요. 검색어를 더 붙여 보세요.</p>' : '')
    : '<div class="card"><div class="empty">'+ICON.inbox+'<b style="font-size:18px">찾는 메일이 없어요</b><span class="hint">대시보드에 남아 있는 최근 메일에서만 찾아요. 45일 지난 메일은 월별 보관 파일에 있어요.</span></div></div>';
}
document.addEventListener("change", e => {
  const id = e.target.dataset && e.target.dataset.id; if(!id) return;
  if(e.target.checked) doneMap[id] = new Date().toISOString(); else delete doneMap[id];
  store.set("gwmail.done", doneMap); render();
});
let qTimer = null; // SearchInput: 입력 후 300ms 쉬었다가 찾고, 글자가 있을 때만 지우기 버튼
document.getElementById("q").addEventListener("input", e => {
  document.querySelector(".search-bar .clear").hidden = !e.target.value;
  clearTimeout(qTimer); qTimer = setTimeout(renderSearch, 300);
});
document.addEventListener("keydown", e => {
  const q = document.getElementById("q");
  // Ctrl+F: 대시보드 검색창으로 (검색창에 있을 때 한 번 더 누르면 브라우저 기본 찾기)
  if((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f" && document.activeElement !== q){
    e.preventDefault(); q.focus(); q.select(); window.scrollTo({ top: 0, behavior: "auto" });
  }
  if(e.key === "Escape" && document.activeElement === q && q.value){ q.value = ""; document.querySelector(".search-bar .clear").hidden = true; renderSearch(); }
  if(e.key === "Escape"){ document.querySelectorAll(".srcinfo:hover, .srcinfo:focus-within").forEach(el => { el.classList.add("tip-off"); el.addEventListener("mouseleave", () => el.classList.remove("tip-off"), { once: true }); el.addEventListener("blur", () => el.classList.remove("tip-off"), { once: true }); }); }
});
document.addEventListener("click", e => {
  if(e.target.closest(".srcinfo") && !e.target.closest("a")){ e.preventDefault(); return; } // 근거 칩을 눌러도 체크되지 않게
  if(e.target.closest("[data-clear]")){ const q = document.getElementById("q"); q.value = ""; document.querySelector(".search-bar .clear").hidden = true; renderSearch(); q.focus(); return; }
  const rb = e.target.closest("[data-report]");
  if(rb){
    e.preventDefault();
    const m = MAILS.find(x => x.id === rb.dataset.report); if(!m) return;
    const text = reportText(m), label = rb.textContent;
    const done = () => { rb.textContent = "복사했어요"; setTimeout(() => { rb.textContent = label; }, 1600); };
    const fallback = () => { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (err) {} ta.remove(); done(); };
    if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
    return;
  }
  const sb = e.target.closest("[data-series]");
  if(sb){ // 반복 메일 칸의 해당 묶음을 열고 그 위치로
    e.preventDefault();
    const name = sb.dataset.series, idx = SERIES.findIndex(x => x.name === name);
    if(idx >= SHOW.series){ SHOW.series = idx + 1; renderSeries(); }
    const d = [...document.querySelectorAll("#series > details")].find(x => x.dataset.name === name);
    if(d){ d.open = true; d.scrollIntoView({behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block:"start"}); d.classList.add("flash"); setTimeout(() => d.classList.remove("flash"), 1600); }
    return;
  }
  const mo = e.target.closest("[data-more]");
  if(mo){
    e.preventDefault();
    const k = mo.dataset.more;
    if(k === "open") SHOW.open += 20;
    else if(k === "watch") SHOW.watch += 20;
    else if(k === "series") SHOW.series += 10;
    else if(k === "promo") SHOW.promo += 30;
    else if(k === "mail") SHOW.mailDays += 7;
    else if(k.indexOf("hist:") === 0){ const n = k.slice(5); SHOW.hist[n] = (SHOW.hist[n] || 10) + 20; }
    render(); renderSeries(); renderMails();
    return;
  }
  const f = e.target.closest("[data-flag]");
  if(f){
    e.preventDefault();
    const id = f.dataset.flag;
    if(f.dataset.v) flagMap[id] = { v: f.dataset.v, at: new Date().toISOString() }; else delete flagMap[id];
    store.set("gwmail.flag", flagMap);
    render(); renderMails();
    const d = document.getElementById(OPENMAP[id] || id); if(d) d.open = true; // 대화 속 메일이면 대화 카드를 펼친 채로
    return;
  }
  const a = e.target.closest("[data-open]"); if(!a) return;
  e.preventDefault();
  const target = OPENMAP[a.dataset.open] || a.dataset.open;
  if(document.getElementById("searchRes").style.display !== "none"){ document.getElementById("q").value = ""; renderSearch(); }
  let d = document.getElementById(target);
  if(!d){ // "지난 메일 더 보기"에 가려진 메일이면 그 날짜까지 펼친다
    const m = MAILS.find(x => x.id === target);
    if(m){ SHOW.mailDays = Math.max(SHOW.mailDays, 1 - dayDiff(m.date)); renderMails(); d = document.getElementById(target); }
  }
  if(!d) return;
  d.open = true; d.scrollIntoView({behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block:"center"});
  d.classList.add("flash"); setTimeout(() => d.classList.remove("flash"), 1600);
});
render(); renderSeries(); renderMails();
// 열어 둔 대시보드는 5분마다 새로 읽어요. 검색 중이거나, 펼쳐 둔 메일·묶음이 있거나, 입력 중이면 다음 번으로 미뤄요.
setInterval(() => {
  const busy = document.getElementById("q").value.trim() ||
    document.querySelector("#mails details[open], #series details[open], #searchList details[open]") ||
    (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName));
  if (!busy) location.reload();
}, 5 * 60 * 1000);
</script></body></html>`, "utf8");
  console.log("rendered " + mails.length);
}

const [, , cmd, a1, a2] = process.argv;
if (cmd === "ingest") { ingest(a1, a2); render(); }
else if (cmd === "brief") brief();
else if (cmd === "series-context") seriesContext(a1);
else if (cmd === "ingest-receipts") ingestReceipts(a1);
else if (cmd === "thread-context") threadContext(a1);
else if (cmd === "sender-context") senderContext(a1);
else if (cmd === "recent-context") recentContext();
else render();

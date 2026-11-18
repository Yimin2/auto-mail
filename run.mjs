// auto-mail 실행 관리 (Windows · macOS 공통)
// 그룹웨어 새 메일 확인 -> (새 메일 있을 때만) Claude 요약 -> 첨부 삭제 -> 알림
// + 아침 브리핑, 마감 임박 알림, 의심 메일 경고·미확인 유지, 보관기간 정리, 실패 감시
// 예약 실행: Windows 작업 스케줄러(run.vbs) / macOS launchd(1분마다) -> `node run.mjs`
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const P = (...a) => path.join(ROOT, ...a);
const CFG = JSON.parse(fs.readFileSync(P("config.json"), "utf8").replace(/^﻿/, ""));
const IS_WIN = process.platform === "win32", IS_MAC = process.platform === "darwin";
const ROOT_URL = pathToFileURL(ROOT + path.sep).href;
const PENDING = P("pending.json"), INBOX = P("inbox"), FLAGS = P("flags"), FAIL_FILE = P("fail.json");
const DASHBOARD = P("dashboard.html"), LOG = P("run.log"), LOCK = P("run.lock"), COLLECT_FAIL = P("collect-fail.json");

const S = Object.assign({ days: [1, 2, 3, 4, 5], startHour: 8, endHour: 19 }, CFG.schedule || {}); // 실행 시간대
const BRIEF_HOUR = 9, REMIND_HOUR = 15;          // 아침 브리핑 · 마감 임박 알림 시각
const KEEP_BODY_DAYS = 7, ATTACH_MAX_HOURS = 24; // 본문 보관 일수 · 첨부 최대 보관 시간
const FAIL_LIMIT = 3, PAUSE_MINUTES = 30;        // 요약 연속 실패 허용 · 휴식
const CHUNK_SIZE = 5, COLLECT_ALERT_MIN = 10;    // 한 번에 요약할 메일 수 · 수집 실패 알림 기준(분)
const EGO_TIMEOUT_SEC = 180, CLAUDE_TIMEOUT_SEC = 600;

// ---------- 공통 도구 ----------
const pad = (n) => String(n).padStart(2, "0");
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const ymd = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
function log(msg) {
  fs.appendFileSync(LOG, `${stamp()} ${msg}\n`, "utf8");
  try { if (fs.statSync(LOG).size > 2 * 1024 * 1024) fs.writeFileSync(LOG, fs.readFileSync(LOG, "utf8").split("\n").slice(-2000).join("\n"), "utf8"); } catch {}
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")); } catch { return d; } };
const saveJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 1), "utf8");
const hasFlag = (n) => fs.existsSync(path.join(FLAGS, n));
const setFlag = (n) => fs.writeFileSync(path.join(FLAGS, n), "", "utf8");
const rm = (f) => { try { fs.rmSync(f, { recursive: true, force: true }); } catch {} };

function which(cmd) {
  const r = spawnSync(IS_WIN ? "where" : "/bin/sh", IS_WIN ? [cmd] : ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  const line = (r.stdout || "").split(/\r?\n/).find(Boolean);
  return r.status === 0 && line ? line.trim() : null;
}
function egoPath() {
  const c = [CFG.egoPath, IS_WIN ? path.join(os.homedir(), ".local/share/ego/active_version_dir/ego-browser.exe") : null,
    path.join(os.homedir(), ".local/bin/ego-browser"), "/usr/local/bin/ego-browser", "/opt/homebrew/bin/ego-browser"];
  return c.find((p) => p && fs.existsSync(p)) || which("ego-browser");
}
function claudePath() {
  const c = [CFG.claudePath, path.join(os.homedir(), ".local/bin/claude"), path.join(os.homedir(), ".local/bin/claude.exe"),
    IS_WIN ? path.join(process.env.APPDATA || "", "npm/claude.cmd") : null, "/usr/local/bin/claude", "/opt/homebrew/bin/claude"];
  return c.find((p) => p && fs.existsSync(p)) || which("claude");
}

// 자식 프로세스 실행: 그 프로세스만 기다리고(브라우저 같은 손자 프로세스는 기다리지 않음), 제한 시간이 지나면 중단
function run(cmd, args, { cwd = ROOT, input = null, timeoutSec = 120, outFile = null, errFile = null } = {}) {
  return new Promise((resolve) => {
    const useShell = IS_WIN && /\.(cmd|bat)$/i.test(cmd); // Windows 의 .cmd 는 셸이 필요 -> 인수를 직접 감쌈
    const q = (a) => (/[\s"(),*&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    const child = useShell
      ? spawn([`"${cmd}"`, ...args.map(q)].join(" "), { cwd, shell: true, windowsHide: true })
      : spawn(cmd, args, { cwd, windowsHide: true });
    let out = "", err = "", done = false;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill(); } catch {} resolve({ code: -1, out, err, timeout: true }); } }, timeoutSec * 1000);
    child.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out, err: String(e), error: true }); } });
    child.on("exit", (code) => {
      setTimeout(() => { // 남은 출력이 들어올 시간
        if (done) return; done = true; clearTimeout(timer);
        if (outFile) fs.writeFileSync(outFile, out, "utf8");
        if (errFile) fs.writeFileSync(errFile, err, "utf8");
        resolve({ code, out, err });
      }, 50);
    });
    if (input !== null) child.stdin.end(input, "utf8"); else child.stdin.end();
  });
}
async function ego(script, name) {
  const exe = egoPath();
  if (!exe) { log("ego-browser 를 찾지 못했어요 (config.json 의 egoPath 를 확인하세요)"); return -1; }
  const r = await run(exe, ["nodejs", "-e", `await import('${ROOT_URL}${script}')`], { timeoutSec: EGO_TIMEOUT_SEC, outFile: P(`${name}.out`), errFile: P(`${name}.err`) });
  if (r.timeout) log(`${script} 이(가) ${EGO_TIMEOUT_SEC}초 안에 끝나지 않아 중단했어요`);
  return r.code;
}
const nodeBuild = (...args) => spawnSync(process.execPath, [P("build.js"), ...args], { cwd: ROOT, encoding: "utf8", windowsHide: true });

// ---------- 알림 (운영체제별) ----------
function notify(title, body, openPath = null) {
  try {
    const url = openPath && fs.existsSync(openPath) ? pathToFileURL(openPath).href : null;
    if (IS_WIN) {
      const ps = `
$e = { param($s) [Security.SecurityElement]::Escape([string]$s) }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$launch = ''; if ($env:N_URL) { $launch = ' activationType="protocol" launch="' + (& $e $env:N_URL) + '"' }
$hint = ''; if ($env:N_URL) { $hint = '<text>' + (& $e '클릭하면 할 일 대시보드가 열립니다') + '</text>' }
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast' + $launch + '><visual><binding template="ToastGeneric"><text>' + (& $e $env:N_TITLE) + '</text><text>' + (& $e $env:N_BODY) + '</text>' + $hint + '</binding></visual></toast>')
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;
      spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")],
        { env: { ...process.env, N_TITLE: title, N_BODY: body, N_URL: url || "" }, windowsHide: true, timeout: 20000 });
    } else if (IS_MAC) {
      const tn = which("terminal-notifier");
      if (tn) spawnSync(tn, ["-title", "auto-mail", "-subtitle", title, "-message", body, "-group", "auto-mail", ...(url ? ["-open", url] : [])], { timeout: 20000 });
      else {
        const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        spawnSync("osascript", ["-e", `display notification "${esc(body)}" with title "auto-mail" subtitle "${esc(title)}"`], { timeout: 20000 });
      }
    } else {
      spawnSync("notify-send", [title, body], { timeout: 20000 });
    }
  } catch (e) { log(`알림 실패: ${e}`); }
}

// ---------- 수집 실패 추적 ----------
function registerCollectFail(why) {
  const f = readJson(COLLECT_FAIL, null) || { since: new Date().toISOString(), notified: false };
  const min = Math.floor((Date.now() - new Date(f.since).getTime()) / 60000);
  if (!f.notified && min >= COLLECT_ALERT_MIN) {
    notify("메일 수집이 멈췄어요", `${min}분째 메일을 못 가져오고 있어요. ego 브라우저가 켜져 있는지 확인해 주세요.\n${why || ""}`);
    f.notified = true; log("수집 중단 알림");
  }
  saveJson(COLLECT_FAIL, f);
}
function clearCollectFail() {
  if (!fs.existsSync(COLLECT_FAIL)) return;
  const f = readJson(COLLECT_FAIL, null); rm(COLLECT_FAIL);
  if (f && f.notified) notify("메일 수집이 다시 돼요", "밀린 메일을 이어서 가져와요.");
  log("수집 복구");
}

// ---------- 1) 수집 (토큰 사용 없음) ----------
async function collect() {
  const resultFile = P("last-result.json"); rm(resultFile);
  const code = await ego("collect.mjs", "collect");
  if (!fs.existsSync(resultFile)) {
    let err = ""; try { err = fs.readFileSync(P("collect.err"), "utf8").trim(); } catch {}
    log(`수집 실패(exit ${code}): ${err.slice(0, 300)}`);
    registerCollectFail("수집 스크립트가 끝나지 않았어요(ego 브라우저가 꺼졌을 수 있어요)");
    return null;
  }
  const res = readJson(resultFile, null);
  const loginFlag = P("login-required.flag");
  if (res.loginRequired) {
    if (!fs.existsSync(loginFlag)) {
      notify("그룹웨어 로그인 필요", `ego 브라우저에서 ${new URL(CFG.gwHost).host} 에 다시 로그인해 주세요.`);
      fs.writeFileSync(loginFlag, "", "utf8"); log("로그인 필요");
    }
    return res;
  }
  if (fs.existsSync(loginFlag)) { rm(loginFlag); log("로그인 복구"); }
  if (!res.ok) { log(`수집 오류: ${res.message}`); registerCollectFail(res.message); return res; }
  clearCollectFail();
  if (res.newMails.length) {
    log(`새 메일 ${res.newMails.length}통 수집`);
    for (const rc of res.readCheck || []) log(`  읽음상태 진단: 수집 전 ${rc.before ? "읽음" : "미확인"} -> 후 ${rc.after ? "읽음" : rc.after === false ? "미확인" : "?"} | ${rc.subject}`);
  }
  return res;
}

// ---------- 2) 요약 (새 메일이 있을 때만, 5통씩, 연속 실패 시 쉬기) ----------
async function summarize() {
  let items = [].concat(readJson(PENDING, []));
  if (!items.length) return;
  let fail = readJson(FAIL_FILE, { count: 0, pausedUntil: null });
  if (fail.pausedUntil && Date.now() < new Date(fail.pausedUntil).getTime()) return;
  const claude = claudePath();
  if (!claude) { log("Claude CLI 없음 - 요약 건너뜀"); return; }

  const template = fs.readFileSync(P("summarize-prompt.md"), "utf8").replace(/^﻿/, "");
  const chunkFile = P("pending-chunk.json");
  const WD = ["일", "월", "화", "수", "목", "금", "토"], now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} (${WD[now.getDay()]})`;
  let workAll = [], tasksAll = 0, promoAll = 0, doneCount = 0, dangerAll = [];

  while (items.length) {
    const chunk = items.slice(0, CHUNK_SIZE);
    saveJson(chunkFile, chunk);
    const seriesCtx = (nodeBuild("series-context").stdout || "").trim() || "(아직 없음)";
    const threadCtx = (nodeBuild("thread-context", chunkFile).stdout || "").trim() || "(없음)";
    const prompt = template.replace("{{TODAY}}", today).replace("{{SERIES}}", seriesCtx).replace("{{THREADS}}", threadCtx)
      .split("{{USER_LABEL}}").join(CFG.userLabel || "").split("{{USER_NAME}}").join(CFG.userName || "") + "\n" + chunk.map((c) => `- ${c.dir}`).join("\n");

    // 읽기 범위 제한: 작업 폴더 inbox + Read(./**) 만 허용 -> inbox 밖 파일은 읽기 거부, 나머지 도구 금지
    const args = ["-p", ...(CFG.claudeModel ? ["--model", CFG.claudeModel] : []), "--allowedTools", "Read(./**)",
      "--disallowedTools", "Bash,PowerShell,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task,Glob,Grep", "--output-format", "text"];
    const r = await run(claude, args, { cwd: INBOX, input: prompt, timeoutSec: CLAUDE_TIMEOUT_SEC, errFile: P("claude.err") });
    let summary = r.out || "";
    if (r.code !== 0 && !summary.trim()) summary = r.err || (r.timeout ? "시간 초과" : "");

    if (r.code !== 0 || !summary.trim()) {
      const count = (fail.count || 0) + 1, msg = summary.trim().split(/\r?\n/)[0] || "";
      log(`요약 실패 ${count}회째(exit ${r.code}): ${msg}`);
      if (count >= FAIL_LIMIT) {
        const until = new Date(Date.now() + PAUSE_MINUTES * 60000);
        saveJson(FAIL_FILE, { count, pausedUntil: until.toISOString() });
        log(`요약 ${PAUSE_MINUTES}분 휴식 (~${pad(until.getHours())}:${pad(until.getMinutes())})`);
        if (count === FAIL_LIMIT) notify("메일 요약이 계속 실패하고 있어요", `${msg}\n${pad(until.getHours())}:${pad(until.getMinutes())}에 다시 시도해요. 메일 수집은 계속돼요.`);
      } else saveJson(FAIL_FILE, { count, pausedUntil: null });
      break;
    }
    if (fail.count > 0) { rm(FAIL_FILE); log("요약 복구"); fail = { count: 0, pausedUntil: null }; }

    fs.writeFileSync(P("last-summary.txt"), summary, "utf8");
    const ing = nodeBuild("ingest", P("last-summary.txt"), chunkFile);
    if (!/ok \d+/.test(ing.stdout || "")) log(`요약 형식 오류(원문 보관): ${(ing.stdout || ing.stderr || "").trim().slice(0, 200)}`);

    for (const it of chunk) { // 첨부(원본·추출 텍스트) 삭제
      try { for (const f of fs.readdirSync(it.dir)) if (f.startsWith("att_")) rm(path.join(it.dir, f)); } catch {}
    }
    items = items.slice(chunk.length);
    saveJson(PENDING, items); // 끝난 묶음은 대기열에서 빼기
    doneCount += chunk.length;

    const sum = readJson(P("last-ingest.json"), null);
    if (sum) { workAll.push(...(sum.work || [])); tasksAll += sum.tasks || 0; promoAll += sum.promo || 0; dangerAll.push(...(sum.danger || [])); }
    else workAll.push(...chunk.map((c) => c.subject));
    const dangerSet = new Set((sum && sum.dangerUnids) || []);

    // 그룹웨어 읽음 처리 · 의심 메일은 미확인으로 되돌림
    const mr = chunk.map((c) => dangerSet.has(c.unid) ? { unid: c.unid, url: c.openUrl, subject: c.subject, unread: true }
      : c.openUrl ? { unid: c.unid, url: c.openUrl, subject: c.subject } : null).filter(Boolean);
    if (mr.length) {
      saveJson(P("markread.json"), mr);
      await ego("markread.mjs", "markread");
      const m = readJson(P("last-markread.json"), null);
      if (m) {
        const readRows = (m.results || []).filter((x) => !x.wantUnread), unreadRows = (m.results || []).filter((x) => x.wantUnread);
        if (readRows.length) {
          const bad = readRows.filter((x) => x.read !== true).map((x) => x.subject);
          log(`그룹웨어 읽음 처리 ${readRows.length - bad.length}/${readRows.length}통${bad.length ? " · 안 됨: " + bad.join(", ") : ""}`);
        }
        if (unreadRows.length) log(`의심 메일 미확인 유지 ${unreadRows.filter((x) => x.read !== true && x.unid).length}/${unreadRows.length}통: ${unreadRows.map((x) => x.subject).join(", ")}`);
      }
    }
  }
  rm(chunkFile);
  if (!doneCount) return;
  log(`요약 완료 ${doneCount}통 -> dashboard.html, 첨부 삭제`);
  if (dangerAll.length) {
    notify(`⚠️ 의심 메일 ${dangerAll.length}통 · 링크와 첨부를 열지 마세요`, `${dangerAll.join(" / ")}\n대시보드에서 근거를 확인하고 의심 해제 또는 위험 표시를 해 주세요.`, DASHBOARD);
    log(`의심 메일 경고: ${dangerAll.join(", ")}`);
  }
  if (workAll.length) notify(`그룹웨어 새 메일 ${workAll.length}통${tasksAll ? ` · 할 일 ${tasksAll}개` : ""}`, workAll.join(" / "), DASHBOARD);
  else if (promoAll) log(`광고·뉴스레터 ${promoAll}통만 수신 - 알림 생략`);
}

// ---------- 3) 아침 브리핑 · 마감 임박 알림 (하루 한 번씩) ----------
async function getBrief() {
  await ego("marks.mjs", "marks"); // 대시보드 체크 기록 읽기
  nodeBuild("brief");
  return readJson(P("last-brief.json"), null);
}
async function reminders() {
  const now = new Date(), d = ymd(now);
  if (!S.days.includes(now.getDay())) return;
  if (now.getHours() >= BRIEF_HOUR && !hasFlag(`brief-${d}`)) {
    setFlag(`brief-${d}`);
    const b = await getBrief();
    if (b) {
      const lines = [];
      if ((b.overdue || []).length) lines.push(`마감 지남 ${b.overdue.length}건: ${b.overdue.join(", ")}`);
      if ((b.dueToday || []).length) lines.push(`오늘 마감 ${b.dueToday.length}건: ${b.dueToday.join(", ")}`);
      if (b.suspicious) lines.push(`확인할 의심 메일 ${b.suspicious}통`);
      if (!lines.length) lines.push("오늘 마감인 일은 없어요.");
      notify(`좋은 아침이에요 · 남은 할 일 ${b.open}개`, lines.join("\n"), DASHBOARD);
      log(`아침 브리핑: 남은 ${b.open}, 긴급 ${(b.overdue || []).length + (b.dueToday || []).length}, 체크기록 ${b.marksOk ? "반영" : "못 읽음"}`);
    }
  }
  if (now.getHours() >= REMIND_HOUR && !hasFlag(`remind-${d}`)) {
    setFlag(`remind-${d}`);
    const b = await getBrief();
    const list = b ? [...(b.overdue || []), ...(b.dueToday || [])] : [];
    if (list.length) { notify(`아직 처리하지 않은 오늘 마감 ${list.length}건`, list.join("\n"), DASHBOARD); log(`마감 임박 알림: ${list.length}건`); }
  }
}

// ---------- 4) 정리 (한 시간에 한 번): 본문 7일, 첨부 24시간, 오래된 플래그 ----------
function cleanup() {
  const now = new Date(), h = `${ymd(now)}${pad(now.getHours())}`;
  if (hasFlag(`cleanup-${h}`)) return;
  for (const f of fs.readdirSync(FLAGS)) { try { if (Date.now() - fs.statSync(path.join(FLAGS, f)).mtimeMs > 3 * 864e5) rm(path.join(FLAGS, f)); } catch {} }
  setFlag(`cleanup-${h}`);
  if (!fs.existsSync(INBOX)) return;
  const busy = new Set([].concat(readJson(PENDING, [])).map((x) => path.resolve(x.dir)));
  let oldDirs = 0, staleAtt = 0;
  for (const d of fs.readdirSync(INBOX)) {
    const full = path.join(INBOX, d); let st; try { st = fs.statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (Date.now() - st.birthtimeMs > KEEP_BODY_DAYS * 864e5 && !busy.has(path.resolve(full))) { rm(full); oldDirs++; continue; }
    for (const f of fs.readdirSync(full)) {
      if (!f.startsWith("att_")) continue;
      try { if (Date.now() - fs.statSync(path.join(full, f)).mtimeMs > ATTACH_MAX_HOURS * 3600e3) { rm(path.join(full, f)); staleAtt++; } } catch {}
    }
  }
  if (staleAtt) log(`요약되지 않은 채 ${ATTACH_MAX_HOURS}시간 지난 첨부 ${staleAtt}개 삭제`);
  if (oldDirs) log(`본문 보관기간(${KEEP_BODY_DAYS}일) 지난 메일 폴더 ${oldDirs}개 삭제`);
}

// ---------- 실행 ----------
const argv = process.argv.slice(2);
if (argv.includes("--test-notify")) { // 설치 확인용: 알림 한 번 띄우고 끝
  notify("auto-mail 알림 시험", "이 알림이 보이면 설정이 끝난 거예요. 누르면 대시보드가 열려요.", DASHBOARD);
  console.log("notify sent"); process.exit(0);
}
if (argv.includes("--check")) { // 설치 확인용: 필요한 프로그램 경로 출력
  console.log(JSON.stringify({ platform: process.platform, node: process.execPath, ego: egoPath(), claude: claudePath(), model: CFG.claudeModel || "(CLI 기본값)", schedule: S }, null, 1));
  process.exit(0);
}
const now = new Date();
const inWindow = S.days.includes(now.getDay()) && now.getHours() >= S.startHour && now.getHours() < S.endHour;
if (!inWindow && !argv.includes("--now")) process.exit(0); // 실행 시간대 밖 (launchd 는 매분 깨우므로 여기서 거름)

// 동시 실행 방지: 잠금 파일 (프로세스가 살아 있고 15분 안이면 건너뜀)
const lock = readJson(LOCK, null);
if (lock) {
  let alive = false; try { process.kill(lock.pid, 0); alive = true; } catch {}
  if (alive && Date.now() - new Date(lock.at).getTime() < 15 * 60000) process.exit(0);
}
fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
try {
  fs.mkdirSync(FLAGS, { recursive: true });
  const res = argv.includes("--skip-collect") ? { ok: true } : await collect(); // --skip-collect: 시험용(대기열만 요약)
  if (res && res.ok) await summarize();
  await reminders();
  cleanup();
} catch (e) {
  log(`오류: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
} finally {
  const cur = readJson(LOCK, null);
  if (cur && cur.pid === process.pid) rm(LOCK);
}

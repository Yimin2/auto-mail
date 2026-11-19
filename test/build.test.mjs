import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// build.js 를 임시 데이터 폴더(AUTOMAIL_ROOT)로 돌려 요약 저장 -> 대시보드 -> 브리핑을 확인
const BUILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "automail-build-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ gwHost: "https://gw.example.co.kr", mailDb: "/mail/x.nsf", mailViewPath: "/view?{mailDb}/{unid}" }));
const build = (...a) => spawnSync(process.execPath, [BUILD, ...a], { env: { ...process.env, AUTOMAIL_ROOT: root }, encoding: "utf8" });
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));

const unid = "A".repeat(32);
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const pending = [
  { dir: "/x/inbox/20261119-0900_보고", subject: "주간 보고", from: "김", when: `${today} 09:00`, role: "수신", openUrl: `https://gw.example.co.kr/mail/x.nsf/0/${unid}?OpenDocument` },
  { dir: "/x/inbox/20261119-0910_광고", subject: "할인", from: "쇼핑", when: `${today} 09:10`, role: "참조", risk: { level: "high", reasons: ["비슷한 도메인"] } },
];
fs.writeFileSync(path.join(root, "pending.json"), JSON.stringify(pending));

test("ingest: 앞에 잡담이 섞인 출력도 읽고, 알림용 요약을 남긴다", () => {
  fs.writeFileSync(path.join(root, "out.txt"), "요약했어요.\n```json\n" + JSON.stringify([
    { dir: pending[0].dir, date: today, time: "09:00", subject: "주간 보고", from: "김", category: "work", importance: "high", oneLine: "보고 <b>제출</b>",
      tasks: [{ text: "보고서 제출", due: today }, { text: "검토", kind: "watch", owner: "박" }] },
    { dir: pending[1].dir, date: today, time: "09:10", subject: "할인", from: "쇼핑", category: "promo", oneLine: "광고", tasks: [{ text: "참조 메일의 일" }] },
  ]) + "\n```");
  const r = build("ingest", path.join(root, "out.txt"), path.join(root, "pending.json"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok 2/);
  const mails = read("data/mails.json");
  assert.equal(mails.length, 2);
  const work = mails.find((m) => m.subject === "주간 보고");
  assert.equal(work.tasks[0].kind, "mine");
  assert.equal(work.tasks[1].kind, "watch");
  const promo = mails.find((m) => m.subject === "할인");
  assert.equal(promo.tasks[0].kind, "watch", "참조로 받은 메일의 할 일은 지켜볼 일");
  assert.match(promo.warning, /피싱 의심/, "규칙 검사가 위험이면 광고여도 경고");
  const ing = read("last-ingest.json");
  assert.deepEqual(ing.danger, ["할인"]);
  assert.equal(ing.tasks, 1, "지켜볼 일은 할 일 수에서 뺀다");
});

test("ingest: 형식이 깨지면 원문을 남긴다", () => {
  fs.writeFileSync(path.join(root, "bad.txt"), "죄송해요, 요약을 못 했어요");
  const p2 = path.join(root, "p2.json");
  fs.writeFileSync(p2, JSON.stringify([{ dir: "/x/inbox/20261119-1000_깨짐", subject: "깨짐", when: `${today} 10:00` }]));
  assert.match(build("ingest", path.join(root, "bad.txt"), p2).stdout, /fallback/);
  assert.match(read("data/mails.json").find((m) => m.subject === "깨짐").oneLine, /형식 오류/);
});

test("render: 글꼴은 링크, 데이터 속 태그는 이스케이프", () => {
  assert.equal(build("render").status, 0);
  const html = fs.readFileSync(path.join(root, "dashboard.html"), "utf8");
  assert.match(html, /<link rel="stylesheet" href="[^"]*ds\/font\.css">/);
  assert.ok(!html.includes("<b>제출</b>"), "요약 속 HTML 이 그대로 들어가면 안 됨");
  assert.ok(html.length < 500 * 1024, `대시보드가 너무 큼: ${html.length}`);
});

test("brief: 체크한 일은 빼고, 오늘 마감을 센다", () => {
  const id = read("data/mails.json").find((m) => m.subject === "주간 보고").tasks[0].id;
  assert.equal(JSON.parse(build("brief").stdout).dueToday.length, 1);
  fs.writeFileSync(path.join(root, "data/marks.json"), JSON.stringify({ ok: true, done: { [id]: new Date().toISOString() }, flag: {} }));
  const b = JSON.parse(build("brief").stdout);
  assert.equal(b.dueToday.length, 0);
  assert.equal(b.marksOk, true);
  assert.equal(b.suspicious, 1);
});

test("수신 확인 메일은 반복 메일 묶음에 넣지 않는다", () => {
  const p3 = path.join(root, "p3.json");
  fs.writeFileSync(p3, JSON.stringify([{ dir: "/x/inbox/20261119-1100_읽음", subject: "수신 확인(읽음): 견적 요청", when: `${today} 11:00` }]));
  fs.writeFileSync(path.join(root, "r.txt"), JSON.stringify([{ dir: "/x/inbox/20261119-1100_읽음", date: today, time: "11:00", subject: "수신 확인(읽음): 견적 요청", category: "work",
    oneLine: "읽음 확인", series: { name: "메일 수신 확인 알림", changes: [] } }]));
  assert.match(build("ingest", path.join(root, "r.txt"), p3).stdout, /ok 1/);
  assert.equal(read("data/mails.json").find((m) => m.subject.startsWith("수신 확인")).series, null);
  assert.ok(!fs.readFileSync(path.join(root, "dashboard.html"), "utf8").includes("메일 수신 확인 알림"));
});

test("보낸 사람 판정 기록: 주소가 같을 때만 '보낸 주소 같음', 주소가 다르면 찾지 않음", () => {
  const promo = read("data/mails.json").find((m) => m.subject === "할인");
  const mails = read("data/mails.json").map((m) => (m.id === promo.id ? { ...m, fromAddr: "sale@shop.test" } : m));
  fs.writeFileSync(path.join(root, "data/mails.json"), JSON.stringify(mails));
  fs.writeFileSync(path.join(root, "data/marks.json"), JSON.stringify({ ok: true, done: {}, flag: { [promo.id]: { v: "safe", at: new Date().toISOString() } } }));
  const p4 = path.join(root, "p4.json");
  const ctx = (pending) => { fs.writeFileSync(p4, JSON.stringify(pending)); return build("sender-context", p4).stdout; };
  assert.match(ctx([{ dir: "/x/n1", subject: "또 할인", from: "쇼핑", fromAddr: "sale@shop.test" }]), /정상\(의심 해제\) \(보낸 주소 같음\)/);
  assert.match(ctx([{ dir: "/x/n2", subject: "또 할인", from: "쇼핑", fromAddr: "sale@sh0p.test" }]), /\(없음\)/, "이름이 같아도 주소가 다르면 판정 기록을 주지 않음");
  fs.writeFileSync(path.join(root, "data/marks.json"), JSON.stringify({ ok: true, done: {}, flag: { [promo.id]: { v: "danger", at: new Date().toISOString() } } }));
  assert.match(ctx([{ dir: "/x/n3", subject: "또 할인", from: "쇼핑", fromAddr: "sale@shop.test" }]), /사용자 판정: 위험/);
});

test("대화: 인용으로만 확인된 메일, 제목이 달라도 threadOf 로 묶기, 관련 대화는 양쪽에 링크", () => {
  const ids = read("data/mails.json").map((m) => m.id);
  const base = read("data/mails.json").find((m) => m.subject === "주간 보고");
  const p5 = path.join(root, "p5.json");
  const items = [
    { dir: "/x/inbox/20261119-1200_보고수정", subject: "RE: 주간 보고(수정본)", when: `${today} 12:00` },
    { dir: "/x/inbox/20261119-1300_다른업체", subject: "추가 견적 문의", when: `${today} 13:00` },
  ];
  fs.writeFileSync(p5, JSON.stringify(items));
  fs.writeFileSync(path.join(root, "t.txt"), JSON.stringify([
    { dir: items[0].dir, date: today, time: "12:00", subject: items[0].subject, from: "김", category: "work", oneLine: "수정본",
      quoted: [{ date: today, time: "09:00", from: "김", oneLine: "원래 보고" }, { date: today, time: "10:30", from: "나", oneLine: "수정 요청" }],
      threadOf: base.id, related: [{ id: "없는-id", why: "무시돼야 함" }] },
    { dir: items[1].dir, date: today, time: "13:00", subject: items[1].subject, from: "박", category: "work", oneLine: "다른 업체 문의",
      related: [{ id: base.id, why: "앞 대화에서 안내받음" }] },
  ]));
  assert.match(build("ingest", path.join(root, "t.txt"), p5).stdout, /ok 2/);
  const saved = read("data/mails.json").find((m) => m.subject === items[0].subject);
  assert.equal(saved.threadOf, base.id);
  assert.deepEqual(saved.related, [], "없는 id 는 버림");
  const html = fs.readFileSync(path.join(root, "dashboard.html"), "utf8");
  const THREADS = JSON.parse(html.match(/const THREADS = (.*); \/\/ 대화 묶음/)[1]);
  const RELATED = JSON.parse(html.match(/const RELATED = (.*); \/\/ 관련 대화/)[1]);
  const card = THREADS[saved.id];
  assert.ok(card, "최신 메일이 대화 카드");
  assert.ok(card.some((r) => r.id === base.id), "제목이 달라도 threadOf 로 같은 대화");
  assert.ok(card.some((r) => r.quoted && r.oneLine === "수정 요청"), "인용으로만 있는 내 답장");
  assert.ok(!card.some((r) => r.quoted && r.oneLine === "원래 보고"), "받은 메일과 같은 인용은 중복으로 빼기");
  const other = read("data/mails.json").find((m) => m.subject === items[1].subject);
  assert.equal(RELATED[other.id][0].card, saved.id, "관련 대화 링크는 상대 대화 카드로");
  assert.equal(RELATED[saved.id][0].id, other.id, "반대쪽에도 표시");
  assert.ok(ids.length > 0);
});

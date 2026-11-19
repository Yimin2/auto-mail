import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { extractText } from "../lib/extract.mjs";

// zip CLI 로 작은 오피스·한글(hwpx) 문서를 만들어 확인한다
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "automail-extract-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
function makeZip(name, files) {
  const dir = fs.mkdtempSync(path.join(tmp, "src-"));
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  const out = path.join(tmp, name);
  execFileSync("zip", ["-qr", out, "."], { cwd: dir });
  return out;
}
const hasZip = (() => { try { execFileSync("zip", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();

test("docx: 문단마다 줄바꿈", { skip: !hasZip }, async () => {
  const f = makeZip("a.docx", { "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>첫 문단</w:t></w:r></w:p><w:p><w:r><w:t xml:space=\"preserve\">둘 &amp; 셋</w:t></w:r></w:p></w:body></w:document>" });
  assert.equal((await extractText(f, fs.readFileSync(f))).trim(), "첫 문단\n둘 & 셋");
});

test("xlsx: 공유 문자열·숫자·서식 있는 문자열", { skip: !hasZip }, async () => {
  const f = makeZip("a.xlsx", {
    "xl/sharedStrings.xml": "<sst><si><t>이름</t></si><si><r><t>마감</t></r><r><t>일</t></r></si></sst>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>42</v></c><c r="B2"/></row></sheetData></worksheet>',
  });
  assert.equal(await extractText(f, fs.readFileSync(f)), "## 시트 1\n이름\t마감일\n42\t");
});

test("hwpx: 섹션 순서대로, 탭은 탭 문자로", { skip: !hasZip }, async () => {
  const f = makeZip("a.hwpx", {
    "Contents/section1.xml": "<hs:sec><hp:p><hp:run><hp:t>둘째 섹션</hp:t></hp:run></hp:p></hs:sec>",
    "Contents/section0.xml": "<hs:sec><hp:p><hp:run><hp:t>보고서<hp:tab/>초안</hp:t></hp:run></hp:p><hp:p><hp:run><hp:t>마감 11/30</hp:t></hp:run></hp:p></hs:sec>",
  });
  assert.equal(await extractText(f, fs.readFileSync(f)), "보고서\t초안\n마감 11/30\n\n둘째 섹션");
});

test("압축을 풀면 너무 큰 문서는 UNZIP_LIMIT", { skip: !hasZip }, async () => {
  const f = makeZip("bomb.docx", { "word/document.xml": Buffer.alloc(25 * 1024 * 1024, 0x41) });
  await assert.rejects(extractText(f, fs.readFileSync(f)), /UNZIP_LIMIT/);
});

test("doc: macOS textutil", { skip: process.platform !== "darwin" }, async () => {
  const txt = path.join(tmp, "a.txt"); fs.writeFileSync(txt, "옛 워드 문서 내용");
  execFileSync("/usr/bin/textutil", ["-convert", "doc", txt, "-output", path.join(tmp, "a.doc")]);
  assert.equal(await extractText(path.join(tmp, "a.doc"), fs.readFileSync(path.join(tmp, "a.doc"))), "옛 워드 문서 내용");
});

test("xls·ppt 옛 형식은 읽지 못한다고 알림", async () => {
  await assert.rejects(extractText("a.xls", Buffer.alloc(10)), /옛 형식/);
});

test("hwp: OLE 가 아니면 오류", async () => {
  await assert.rejects(extractText("a.hwp", Buffer.alloc(600)), /OLE/);
});

// 실제 한글 파일로 확인하려면: HWP_SAMPLE=/경로/문서.hwp npm test
test("hwp: 실제 파일 (HWP_SAMPLE)", { skip: !process.env.HWP_SAMPLE }, async () => {
  const t = await extractText(process.env.HWP_SAMPLE, fs.readFileSync(process.env.HWP_SAMPLE));
  assert.ok(t.length > 20, "본문 글자를 뽑아야 함");
});

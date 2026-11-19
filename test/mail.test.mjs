import test from "node:test";
import assert from "node:assert/strict";
import { bodyText, decodeQP, makeSecurityCheck, companyDomainsOf } from "../lib/mail.mjs";

const check = makeSecurityCheck(["example.co.kr"]);
const html = (s) => ({ content: [{ contentType: "text/html", data: s }] });

test("회사 도메인 추측: 그룹웨어 주소의 첫 단계를 뗀다", () => {
  assert.deepEqual(companyDomainsOf({ gwHost: "https://gw.example.co.kr" }), ["example.co.kr"]);
  assert.deepEqual(companyDomainsOf({ gwHost: "https://gw.example.co.kr", companyDomains: ["A.com"] }), ["a.com"]);
});

test("사내 메일은 경고 없음", () => {
  assert.equal(check({ INetFrom: '"홍길동" <hong@example.co.kr>', Body: html('<a href="https://gw.example.co.kr/x">gw.example.co.kr</a>') }, []), null);
});

test("비슷한 도메인은 위험", () => {
  const r = check({ INetFrom: "<it@examp1e.co.kr>" }, []);
  assert.equal(r.level, "high");
  assert.match(r.reasons[0], /비슷한 다른 도메인/);
});

test("외부 주소가 사내 역할 이름을 쓰면 위험", () => {
  assert.equal(check({ INetFrom: '"전산팀" <a@gmail.com>' }, []).level, "high");
});

test("링크 글자와 실제 주소가 다르면 위험, 단축 URL 은 주의", () => {
  assert.match(check({ INetFrom: "<a@example.co.kr>", Body: html('<a href="https://evil.test/login">www.example.co.kr</a>') }, []).reasons.join(), /링크 글자/);
  assert.equal(check({ INetFrom: "<a@example.co.kr>", Body: html('<a href="https://bit.ly/x">여기</a>') }, []).level, "mid");
});

test("첨부: 실행 파일·이중 확장자는 위험, 압축은 주의", () => {
  assert.equal(check({ INetFrom: "<a@example.co.kr>" }, [{ name: "견적서.pdf.exe" }]).level, "high");
  assert.equal(check({ INetFrom: "<a@example.co.kr>" }, [{ name: "자료.zip" }]).level, "mid");
});

test("본문: quoted-printable 한글과 HTML", () => {
  assert.equal(decodeQP("=ED=95=9C=EA=B8=80"), "한글");
  assert.equal(bodyText(html("<p>첫 줄</p><p>a &amp; b</p>")), "첫 줄\na & b");
  assert.equal(bodyText({ content: [{ contentType: "text/plain", contentTransferEncoding: "base64", data: Buffer.from("안녕").toString("base64") }] }), "안녕");
});

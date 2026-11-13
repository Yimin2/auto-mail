// 디자인 시스템(tokens.json · components/bundle.css · fonts/PretendardVariable.woff2) -> ds/ 폴더의 CSS 로 변환
// 사용법: node tools/make-ds.js <디자인 시스템 project 폴더>
const fs = require("fs");
const SRC = process.argv[2];
const OUT = require("path").join(__dirname, "..", "ds");
fs.mkdirSync(OUT, { recursive: true });
const t = JSON.parse(fs.readFileSync(`${SRC}/tokens.json`, "utf8"));

const pal = {};
for (const c of t.color.tokens) if (typeof c.value === "string") pal[c.name] = c.value;
const resolve = (v, theme, depth = 0) => String(v).replace(/\{([^}]+)\}/g, (_, n) => {
  if (pal[n] !== undefined) return pal[n];
  const sem = t.color.tokens.find((x) => x.name === n);
  if (sem && depth < 4) return resolve(typeof sem.value === "string" ? sem.value : sem.value[theme], theme, depth + 1);
  return `var(--${n})`;
});
const light = [], dark = [];
for (const c of t.color.tokens) {
  if (typeof c.value === "string") continue;
  light.push(`--${c.name}:${resolve(c.value.light, "light")}`);
  dark.push(`--${c.name}:${resolve(c.value.dark, "dark")}`);
}
for (const g of ["spacing", "radius", "duration", "easing", "zIndex"]) for (const k of t[g].tokens) light.push(`--${k.name}:${k.value}`);
for (const s of t.shadow.tokens) {
  if (typeof s.value === "string") light.push(`--${s.name}:${s.value}`);
  else { light.push(`--${s.name}:${s.value.light}`); dark.push(`--${s.name}:${s.value.dark}`); }
}
light.push(`--font-sans:${t.type.families.sans}`, `--font-mono:${t.type.families.mono}`);

const css = `/* 웹 공통 디자인 시스템 토큰 (tokens.json 에서 생성) */
:root{${light.join(";")};color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${dark.join(";")};color-scheme:dark}}
:root[data-theme="dark"]{${dark.join(";")};color-scheme:dark}
@media (prefers-reduced-motion:reduce){:root{--duration-fast:0ms;--duration-base:0ms;--duration-slow:0ms}}
`;
fs.writeFileSync(`${OUT}/tokens.css`, css, "utf8");
fs.copyFileSync(`${SRC}/components/bundle.css`, `${OUT}/bundle.css`);
const font = fs.readFileSync(`${SRC}/fonts/PretendardVariable.woff2`).toString("base64");
fs.writeFileSync(`${OUT}/font.css`, `@font-face{font-family:"Pretendard Variable";src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:45 920;font-style:normal;font-display:swap}`, "utf8");
console.log("tokens", light.length, dark.length, "font", Math.round(font.length / 1024) + "KB");

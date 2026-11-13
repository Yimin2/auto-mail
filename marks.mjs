// 대시보드에서 체크한 할 일·의심 메일 판정을 ego 브라우저 저장소에서 읽어 data/marks.json 으로 저장
// (대시보드는 기본 브라우저인 ego lite 에서 열리므로 같은 저장소를 읽을 수 있음)
const fs = await import("node:fs/promises");
const { fileURLToPath, pathToFileURL } = await import("node:url");
const ROOT = fileURLToPath(new URL(".", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
const out = { ok: false, done: {}, flag: {}, at: new Date().toISOString() };
const task = await taskSpace("gw-mail-collector");
let page = null;
try {
  page = await task.newPage();
  await page.goto(pathToFileURL(`${ROOT}/dashboard.html`).href, { timeout: 30000 });
  const r = await page.evaluate(() => {
    const get = (k) => { try { return JSON.parse(localStorage.getItem(k) || "{}") || {}; } catch { return {}; } };
    return { done: get("gwmail.done"), flag: get("gwmail.flag") };
  });
  Object.assign(out, r, { ok: true });
} catch (err) {
  out.error = String(err?.message || err);
} finally {
  try { if (page) await page.close(); } catch {}
}
await fs.mkdir(`${ROOT}/data`, { recursive: true });
await fs.writeFile(`${ROOT}/data/marks.json`, JSON.stringify(out), "utf8");
console.log("MARKS " + (out.ok ? "ok" : "fail"));

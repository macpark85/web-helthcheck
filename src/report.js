// 헬스체크 결과(JSON) → 한글 HTML 리포트 렌더러
// healthcheck.js에서 직접 import 하거나, `node src/report.js <json경로>`로 단독 실행 가능.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function kstString(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${kst.getUTCFullYear()}-${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())} ` +
    `${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}:${p(kst.getUTCSeconds())} KST`
  );
}

function badge(ok, okText = "정상", ngText = "이상") {
  return ok
    ? `<span class="badge ok">${okText}</span>`
    : `<span class="badge ng">${ngText}</span>`;
}

function statusCell(s) {
  if (s === 0) return `<span class="badge ng">ERR</span>`;
  const cls = s < 300 ? "ok" : s < 400 ? "warn" : "ng";
  return `<span class="badge ${cls}">${s}</span>`;
}

function shorten(u, n = 70) {
  if (!u) return "";
  return u.length > n ? u.slice(0, n - 1) + "…" : u;
}

export function renderHtmlReport(r) {
  const m = r.meta;
  const s = r.summary;

  const cards = [
    { label: "페이지", value: s.pagesChecked, sub: `실패 ${s.pagesFailed}`, bad: s.pagesFailed > 0 },
    { label: "링크", value: s.linksChecked, sub: `깨짐 ${s.linksBroken}`, bad: s.linksBroken > 0 },
    { label: "이미지", value: s.imagesChecked, sub: `깨짐 ${s.imagesBroken}`, bad: s.imagesBroken > 0 },
    { label: "API(자사)", value: s.apisFirstParty ?? s.apisChecked, sub: `실패 ${s.apisFailed} · 느림 ${s.apisSlow} · 외부 ${s.apisChecked - (s.apisFirstParty ?? s.apisChecked)}`, bad: s.apisFailed > 0 },
    { label: "콘솔 에러", value: s.consoleErrorsTotal, sub: "총합", bad: s.consoleErrorsTotal > 0 },
  ];

  const cardHtml = cards
    .map(
      (c) => `
      <div class="card ${c.bad ? "bad" : "good"}">
        <div class="card-val">${c.value}</div>
        <div class="card-label">${c.label}</div>
        <div class="card-sub">${esc(c.sub)}</div>
      </div>`
    )
    .join("");

  // 페이지 테이블
  const pageRows = r.pages
    .map(
      (p) => `
      <tr class="${p.ok ? "" : "row-bad"}">
        <td>${statusCell(p.status)}</td>
        <td class="url"><a href="${esc(p.finalUrl)}" target="_blank" rel="noopener">${esc(shorten(p.url, 60))}</a></td>
        <td>${esc(shorten(p.title, 40))}</td>
        <td class="num ${p.slow ? "ng-text" : ""}">${p.loadMs ?? "-"}</td>
        <td class="num ${p.consoleErrors.length ? "ng-text" : ""}">${p.consoleErrors.length}</td>
        <td class="num ${p.failedRequests.length ? "ng-text" : ""}">${p.failedRequests.length}${p.thirdPartyFailures ? `<span class="muted"> (+${p.thirdPartyFailures} 외부)</span>` : ""}</td>
        <td>${p.navError ? `<span class="ng-text">${esc(shorten(p.navError, 50))}</span>` : badge(p.ok)}</td>
      </tr>`
    )
    .join("");

  // API 테이블: 자사 API 전체 + 외부 중 실패한 것만 (정상 외부 비콘 수천 개는 생략)
  const apiThreshold = r.config?.thresholds?.apiLatencyMs || 3000;
  const shownApis = r.apis.filter((a) => a.firstParty || !a.ok);
  const hiddenApis = r.apis.length - shownApis.length;
  const apiRows = shownApis
    .map(
      (a) => `
      <tr class="${a.ok ? "" : "row-bad"}">
        <td>${statusCell(a.status)}</td>
        <td><span class="badge ${a.firstParty ? "ok" : "muted"}">${a.firstParty ? "자사" : "외부"}</span></td>
        <td><code>${esc(a.method)}</code></td>
        <td class="url" title="${esc(a.url)}">${esc(shorten(a.url, 55))}</td>
        <td class="num ${a.latencyMs && a.latencyMs > apiThreshold ? "ng-text" : ""}">${a.latencyMs ?? "-"}</td>
        <td>${esc(shorten(a.contentType, 28))}</td>
      </tr>`
    )
    .join("");

  // 깨진 링크/이미지 (문제 우선 정렬)
  const brokenLinks = r.links.filter((l) => !l.ok);
  const brokenImages = r.images.filter((i) => !i.ok);

  const brokenLinkRows =
    brokenLinks
      .map(
        (l) => `
      <tr class="row-bad">
        <td>${statusCell(l.status)}</td>
        <td><span class="badge ${l.type === "internal" ? "warn" : "muted"}">${l.type === "internal" ? "내부" : "외부"}</span></td>
        <td class="url" title="${esc(l.url)}">${esc(shorten(l.url, 55))}</td>
        <td class="url muted" title="${esc((l.foundOn || []).join("\n"))}">${esc(shorten((l.foundOn || [])[0] || "", 45))}${(l.foundOn || []).length > 1 ? ` 외 ${l.foundOn.length - 1}` : ""}</td>
        <td>${esc(l.error || "")}</td>
      </tr>`
      )
      .join("") || `<tr><td colspan="5" class="empty">깨진 링크 없음 ✅</td></tr>`;

  const brokenImageRows =
    brokenImages
      .map(
        (i) => `
      <tr class="row-bad">
        <td>${statusCell(i.status)}</td>
        <td class="url" title="${esc(i.url)}">${esc(shorten(i.url, 60))}</td>
        <td class="url muted" title="${esc((i.foundOn || []).join("\n"))}">${esc(shorten((i.foundOn || [])[0] || "", 45))}${(i.foundOn || []).length > 1 ? ` 외 ${i.foundOn.length - 1}` : ""}</td>
        <td>${esc(i.error || "")}</td>
      </tr>`
      )
      .join("") || `<tr><td colspan="4" class="empty">깨진 이미지 없음 ✅</td></tr>`;

  const runLink = m.runUrl
    ? `<a href="${esc(m.runUrl)}" target="_blank" rel="noopener">CI 실행 보기 ↗</a>`
    : "";

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>웹 헬스체크 리포트 · ${esc(m.target)} · ${esc(m.runId)}</title>
<style>
  :root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--txt:#e6e9ef;--muted:#8b93a7;
        --ok:#2ecc71;--warn:#f1c40f;--ng:#ff5470;--accent:#5b9cff;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",Segoe UI,Roboto,sans-serif}
  .wrap{max-width:1100px;margin:0 auto;padding:28px 20px 80px}
  header{display:flex;flex-wrap:wrap;align-items:center;gap:12px;justify-content:space-between;margin-bottom:8px}
  h1{font-size:20px;margin:0}
  h2{font-size:16px;margin:32px 0 12px;border-left:3px solid var(--accent);padding-left:10px}
  .meta{color:var(--muted);font-size:13px;margin-bottom:20px}
  .meta a{color:var(--accent)}
  .status-hero{font-size:15px;font-weight:600;padding:6px 14px;border-radius:999px}
  .status-hero.ok{background:rgba(46,204,113,.15);color:var(--ok)}
  .status-hero.ng{background:rgba(255,84,112,.15);color:var(--ng)}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;text-align:center}
  .card.bad{border-color:rgba(255,84,112,.5)}
  .card-val{font-size:30px;font-weight:700}
  .card.bad .card-val{color:var(--ng)}
  .card-label{color:var(--muted);font-size:13px;margin-top:2px}
  .card-sub{font-size:12px;margin-top:6px;color:var(--muted)}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}
  th{background:#1c2029;color:var(--muted);font-weight:600;position:sticky;top:0}
  tr:last-child td{border-bottom:none}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  td.url{max-width:340px;word-break:break-all}
  td.url a{color:var(--accent);text-decoration:none}
  .muted{color:var(--muted)}
  .row-bad{background:rgba(255,84,112,.06)}
  .ng-text{color:var(--ng);font-weight:600}
  .empty{text-align:center;color:var(--muted);padding:18px}
  .badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600}
  .badge.ok{background:rgba(46,204,113,.18);color:var(--ok)}
  .badge.warn{background:rgba(241,196,15,.18);color:var(--warn)}
  .badge.ng{background:rgba(255,84,112,.18);color:var(--ng)}
  .badge.muted{background:#222733;color:var(--muted)}
  code{background:#222733;padding:1px 5px;border-radius:5px;font-size:12px}
  details{margin-top:8px}
  summary{cursor:pointer;color:var(--muted)}
  footer{margin-top:40px;color:var(--muted);font-size:12px;text-align:center}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🩺 웹 헬스체크 리포트</h1>
    <span class="status-hero ${m.overallHealthy ? "ok" : "ng"}">${m.overallHealthy ? "✅ 전체 정상" : "❌ 이상 감지"}</span>
  </header>
  <div class="meta">
    대상 <strong>${esc(m.target)}</strong> · 실행 ${esc(kstString(m.startedAt))} ·
    소요 ${(m.durationMs / 1000).toFixed(1)}s · runId <code>${esc(m.runId)}</code>
    ${m.gitSha ? ` · sha <code>${esc(m.gitSha.slice(0, 7))}</code>` : ""} ${runLink}
  </div>

  <div class="cards">${cardHtml}</div>

  <h2>🚨 깨진 링크 (${brokenLinks.length})</h2>
  <table>
    <thead><tr><th>상태</th><th>구분</th><th>URL</th><th>발견 위치</th><th>오류</th></tr></thead>
    <tbody>${brokenLinkRows}</tbody>
  </table>

  <h2>🖼️ 깨진 이미지 (${brokenImages.length})</h2>
  <table>
    <thead><tr><th>상태</th><th>이미지 URL</th><th>발견 위치</th><th>오류</th></tr></thead>
    <tbody>${brokenImageRows}</tbody>
  </table>

  <h2>🔌 API 검수 · 자사 API + 실패한 외부 호출 · 지연시간 내림차순</h2>
  <table>
    <thead><tr><th>상태</th><th>구분</th><th>메서드</th><th>엔드포인트</th><th>지연(ms)</th><th>Content-Type</th></tr></thead>
    <tbody>${apiRows || `<tr><td colspan="6" class="empty">수집된 API 호출 없음</td></tr>`}</tbody>
  </table>
  ${hiddenApis > 0 ? `<div class="meta">정상 외부 분석/광고 비콘 ${hiddenApis}건은 표에서 생략됨(전체는 JSON 참조).</div>` : ""}

  <h2>📄 페이지별 점검 (${r.pages.length})</h2>
  <table>
    <thead><tr><th>상태</th><th>URL</th><th>제목</th><th>로드(ms)</th><th>콘솔에러</th><th>깨진리소스</th><th>판정</th></tr></thead>
    <tbody>${pageRows}</tbody>
  </table>

  <footer>
    web-healthcheck · Playwright 자동 생성 · ${esc(kstString(m.finishedAt))}
  </footer>
</div>
</body>
</html>`;
}

// 단독 실행 지원: node src/report.js reports/data/xxxx.json
const isMain = process.argv[1] && basename(process.argv[1]) === "report.js";
if (isMain) {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error("사용법: node src/report.js <결과JSON경로>");
    process.exit(1);
  }
  const r = JSON.parse(readFileSync(jsonPath, "utf8"));
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const out = join(__dirname, "..", "reports", `healthcheck_${r.meta.runId}.html`);
  writeFileSync(out, renderHtmlReport(r));
  console.log("HTML 리포트 생성:", out);
}

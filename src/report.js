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

// 클릭 가능한 링크. text 생략 시 축약된 URL 표시, 전체 URL은 title(툴팁)·href에 보존.
function aLink(url, { text, n = 55, cls = "" } = {}) {
  if (!url) return esc(text || "");
  const label = text ?? shorten(url, n);
  return `<a href="${esc(url)}" target="_blank" rel="noopener"${cls ? ` class="${cls}"` : ""} title="${esc(url)}">${esc(label)}</a>`;
}

// "발견 위치" 셀: 첫 위치는 클릭 가능, 나머지는 "외 N"
function foundOnCell(list, n = 45) {
  const arr = list || [];
  if (!arr.length) return "";
  const first = aLink(arr[0], { n, cls: "muted" });
  return first + (arr.length > 1 ? `<span class="muted"> 외 ${arr.length - 1}</span>` : "");
}

export function renderHtmlReport(r) {
  const m = r.meta;
  const s = r.summary;
  const apiThreshold = r.config?.thresholds?.apiLatencyMs || 3000;

  // ---- 문제만 추려 "이슈 요약" 구성 ----
  const brokenLinks = r.links.filter((l) => !l.ok);
  const brokenImages = r.images.filter((i) => !i.ok);
  const failedPages = r.pages.filter((p) => !p.ok);
  const fpApis = r.apis.filter((a) => a.firstParty);
  const failedApis = fpApis.filter((a) => !a.ok);
  const slowApis = fpApis.filter((a) => a.latencyMs != null && a.latencyMs > apiThreshold);

  const issues = [];
  for (const p of failedPages) {
    const reasons = [];
    if (p.navError) reasons.push(`접속오류 ${esc(p.navError)}`);
    if (p.failedRequests?.length) reasons.push(`자사 리소스 실패 ${p.failedRequests.length}`);
    if (p.consoleErrors?.length) reasons.push(`콘솔 에러 ${p.consoleErrors.length}`);
    if (p.slow) reasons.push(`느린 로드 ${p.loadMs}ms`);
    issues.push({ sev: "ng", kind: "페이지", status: p.status, url: p.finalUrl || p.url, note: reasons.join(" · ") || "판정 실패" });
  }
  for (const l of brokenLinks) {
    issues.push({
      sev: "ng",
      kind: l.type === "internal" ? "링크(내부)" : "링크(외부)",
      status: l.status,
      url: l.url,
      note: `${esc(l.error || "")} · 발견: ${foundOnCell(l.foundOn)}`,
    });
  }
  for (const i of brokenImages) {
    issues.push({ sev: "ng", kind: "이미지", status: i.status, url: i.url, note: `${esc(i.error || "")} · 발견: ${foundOnCell(i.foundOn)}` });
  }
  for (const a of failedApis) {
    issues.push({ sev: "ng", kind: "API", status: a.status, url: a.url, note: `${esc(a.method)} · ${a.latencyMs ?? "-"}ms` });
  }
  for (const a of slowApis) {
    if (!a.ok) continue; // 이미 실패로 잡힌 건 중복 제외
    issues.push({ sev: "warn", kind: "API 느림", status: a.status, url: a.url, note: `${esc(a.method)} · ${a.latencyMs}ms (임계 ${apiThreshold}ms)` });
  }
  // 심각(ng) 먼저, 그다음 경고(warn)
  issues.sort((a, b) => (a.sev === b.sev ? 0 : a.sev === "ng" ? -1 : 1));

  const issuesRows = issues
    .map(
      (it) => `
      <tr class="${it.sev === "ng" ? "row-bad" : "row-warn"}">
        <td><span class="badge ${it.sev}">${it.sev === "ng" ? "문제" : "경고"}</span></td>
        <td>${esc(it.kind)}</td>
        <td>${statusCell(it.status)}</td>
        <td class="url">${aLink(it.url, { n: 60 })}</td>
        <td class="note">${it.note}</td>
      </tr>`
    )
    .join("");

  const issuesPanel = issues.length
    ? `<table>
        <thead><tr><th>심각도</th><th>종류</th><th>상태</th><th>대상 (클릭하여 열기)</th><th>비고 · 발견 위치</th></tr></thead>
        <tbody>${issuesRows}</tbody>
      </table>`
    : `<div class="verdict-ok">✅ 발견된 문제 없음 — 점검한 모든 페이지·링크·이미지·API 정상</div>`;

  // ---- 한눈 요약 헤드라인 ----
  const hl = [];
  if (failedPages.length) hl.push(`페이지 ${failedPages.length}`);
  if (brokenLinks.length) hl.push(`링크 ${brokenLinks.length}`);
  if (brokenImages.length) hl.push(`이미지 ${brokenImages.length}`);
  if (failedApis.length) hl.push(`API ${failedApis.length}`);
  if (slowApis.length) hl.push(`느린 API ${slowApis.length}`);
  const headline = issues.length ? `문제 ${issues.length}건 — ${hl.join(", ")}` : "전체 정상";

  // ---- 상단 요약 카드 (앵커 점프) ----
  const cards = [
    { label: "페이지", value: s.pagesChecked, sub: `실패 ${s.pagesFailed}`, bad: s.pagesFailed > 0, href: "#sec-pages" },
    { label: "링크", value: s.linksChecked, sub: `깨짐 ${s.linksBroken}`, bad: s.linksBroken > 0, href: "#sec-links" },
    { label: "이미지", value: s.imagesChecked, sub: `깨짐 ${s.imagesBroken}`, bad: s.imagesBroken > 0, href: "#sec-images" },
    { label: "API(자사)", value: s.apisFirstParty ?? s.apisChecked, sub: `실패 ${s.apisFailed} · 느림 ${s.apisSlow}`, bad: s.apisFailed > 0, href: "#sec-api" },
    { label: "외부 호출", value: s.apisChecked - (s.apisFirstParty ?? s.apisChecked), sub: "분석/광고 비콘", bad: false, href: "#sec-api" },
    { label: "콘솔 에러", value: s.consoleErrorsTotal, sub: "자사 기준", bad: s.consoleErrorsTotal > 0, href: "#sec-pages" },
  ];
  const cardHtml = cards
    .map(
      (c) => `
      <a class="card ${c.bad ? "bad" : "good"}" href="${c.href}">
        <div class="card-val">${c.value}</div>
        <div class="card-label">${c.label}</div>
        <div class="card-sub">${esc(c.sub)}</div>
      </a>`
    )
    .join("");

  // ---- 접이식 전체 목록 ----
  const linkRow = (l) => `
      <tr class="${l.ok ? "" : "row-bad"}">
        <td>${statusCell(l.status)}</td>
        <td><span class="badge ${l.type === "internal" ? "warn" : "muted"}">${l.type === "internal" ? "내부" : "외부"}</span></td>
        <td class="url">${aLink(l.url, { n: 60 })}</td>
        <td class="url">${foundOnCell(l.foundOn)}</td>
      </tr>`;
  const allLinkRows = [...r.links].sort((a, b) => Number(a.ok) - Number(b.ok)).map(linkRow).join("");

  const imageRow = (i) => `
      <tr class="${i.ok ? "" : "row-bad"}">
        <td>${statusCell(i.status)}</td>
        <td class="url">${aLink(i.url, { n: 70 })}</td>
        <td class="url">${foundOnCell(i.foundOn)}</td>
      </tr>`;
  const allImageRows = [...r.images].sort((a, b) => Number(a.ok) - Number(b.ok)).map(imageRow).join("");

  const shownApis = r.apis.filter((a) => a.firstParty || !a.ok).sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0));
  const hiddenApis = r.apis.length - shownApis.length;
  const apiRows = shownApis
    .map(
      (a) => `
      <tr class="${a.ok ? "" : "row-bad"}">
        <td>${statusCell(a.status)}</td>
        <td><span class="badge ${a.firstParty ? "ok" : "muted"}">${a.firstParty ? "자사" : "외부"}</span></td>
        <td><code>${esc(a.method)}</code></td>
        <td class="url">${aLink(a.url, { n: 60 })}</td>
        <td class="num ${a.latencyMs && a.latencyMs > apiThreshold ? "ng-text" : ""}">${a.latencyMs ?? "-"}</td>
      </tr>`
    )
    .join("");

  const pageRows = [...r.pages]
    .sort((a, b) => Number(a.ok) - Number(b.ok))
    .map(
      (p) => `
      <tr class="${p.ok ? "" : "row-bad"}">
        <td>${statusCell(p.status)}</td>
        <td class="url">${aLink(p.finalUrl || p.url, { text: shorten(p.url, 60), n: 60 })}</td>
        <td>${esc(shorten(p.title, 36))}</td>
        <td class="num ${p.slow ? "ng-text" : ""}">${p.loadMs ?? "-"}</td>
        <td class="num ${p.consoleErrors.length ? "ng-text" : ""}">${p.consoleErrors.length}</td>
        <td class="num ${p.failedRequests.length ? "ng-text" : ""}">${p.failedRequests.length}${p.thirdPartyFailures ? `<span class="muted"> (+${p.thirdPartyFailures}외부)</span>` : ""}</td>
        <td>${p.navError ? `<span class="ng-text">${esc(shorten(p.navError, 40))}</span>` : badge(p.ok)}</td>
      </tr>`
    )
    .join("");

  const detail = (id, title, badCount, total, headRow, rows) => `
  <details id="${id}"${badCount > 0 ? " open" : ""}>
    <summary><span class="sum-title">${title}</span>
      <span class="sum-meta">${total}건 · ${badCount > 0 ? `<span class="ng-text">문제 ${badCount}</span>` : "정상"} ▾</span>
    </summary>
    <div class="scroll"><table><thead>${headRow}</thead><tbody>${rows}</tbody></table></div>
  </details>`;

  const runLink = m.runUrl ? `<a href="${esc(m.runUrl)}" target="_blank" rel="noopener">CI 실행 ↗</a>` : "";

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>웹 헬스체크 · ${esc(m.target)} · ${esc(m.runId)}</title>
<style>
  :root{--bg:#0f1115;--panel:#171a21;--panel2:#1c2029;--line:#262b36;--txt:#e6e9ef;--muted:#8b93a7;
        --ok:#2ecc71;--warn:#f1c40f;--ng:#ff5470;--accent:#5b9cff;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",Segoe UI,Roboto,sans-serif}
  .wrap{max-width:1080px;margin:0 auto;padding:24px 20px 80px}
  .topbar{position:sticky;top:0;z-index:5;background:linear-gradient(var(--bg),var(--bg) 70%,transparent);
          display:flex;flex-wrap:wrap;align-items:center;gap:12px;justify-content:space-between;padding:10px 0 12px;margin-bottom:6px}
  h1{font-size:19px;margin:0;display:flex;align-items:center;gap:8px}
  .hero{display:flex;align-items:center;gap:10px}
  .status-hero{font-size:15px;font-weight:700;padding:7px 16px;border-radius:999px;white-space:nowrap}
  .status-hero.ok{background:rgba(46,204,113,.16);color:var(--ok);border:1px solid rgba(46,204,113,.4)}
  .status-hero.ng{background:rgba(255,84,112,.16);color:var(--ng);border:1px solid rgba(255,84,112,.45)}
  .headline{font-size:13px;color:var(--muted)}
  .headline.ng{color:var(--ng);font-weight:600}
  .meta{color:var(--muted);font-size:12.5px;margin-bottom:18px}
  .meta a{color:var(--accent)}
  h2{font-size:15px;margin:30px 0 12px;display:flex;align-items:center;gap:8px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0 8px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;text-align:center;text-decoration:none;color:inherit;transition:.12s}
  .card:hover{border-color:var(--accent)}
  .card.bad{border-color:rgba(255,84,112,.55);background:rgba(255,84,112,.05)}
  .card-val{font-size:28px;font-weight:700;line-height:1.1}
  .card.bad .card-val{color:var(--ng)}
  .card-label{color:var(--muted);font-size:12.5px;margin-top:3px}
  .card-sub{font-size:11.5px;margin-top:5px;color:var(--muted)}
  .verdict-ok{background:rgba(46,204,113,.1);border:1px solid rgba(46,204,113,.35);color:var(--ok);
              border-radius:12px;padding:22px;text-align:center;font-size:16px;font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:13px}
  thead th{background:var(--panel2);color:var(--muted);font-weight:600;text-align:left;padding:9px 11px;position:sticky;top:0;z-index:1}
  td{padding:8px 11px;border-top:1px solid var(--line);vertical-align:top}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  td.url{max-width:380px;word-break:break-all}
  td.note{color:var(--muted)}
  a{color:var(--accent)}
  td.url a,td.note a{color:var(--accent);text-decoration:none}
  td.url a:hover,td.note a:hover{text-decoration:underline}
  .muted{color:var(--muted)}
  .row-bad{background:rgba(255,84,112,.07)}
  .row-warn{background:rgba(241,196,15,.07)}
  .ng-text{color:var(--ng);font-weight:600}
  /* 이슈 요약 패널 */
  .issues{border:1px solid rgba(255,84,112,.4);border-radius:12px;overflow:hidden;background:var(--panel)}
  .issues table{border:none}
  .verdict-wrap table{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .badge{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap}
  .badge.ok{background:rgba(46,204,113,.18);color:var(--ok)}
  .badge.warn{background:rgba(241,196,15,.2);color:var(--warn)}
  .badge.ng{background:rgba(255,84,112,.2);color:var(--ng)}
  .badge.muted{background:#222733;color:var(--muted)}
  code{background:#222733;padding:1px 5px;border-radius:5px;font-size:12px}
  /* 접이식 */
  details{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin:12px 0;overflow:hidden}
  details[open]{border-color:var(--accent)}
  summary{cursor:pointer;list-style:none;padding:13px 16px;display:flex;align-items:center;justify-content:space-between;font-weight:600}
  summary::-webkit-details-marker{display:none}
  .sum-meta{color:var(--muted);font-weight:500;font-size:12.5px}
  .scroll{max-height:440px;overflow:auto;border-top:1px solid var(--line)}
  footer{margin-top:40px;color:var(--muted);font-size:12px;text-align:center}
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <h1>🩺 웹 헬스체크 리포트</h1>
    <div class="hero">
      <span class="headline ${issues.length ? "ng" : ""}">${esc(headline)}</span>
      <span class="status-hero ${m.overallHealthy ? "ok" : "ng"}">${m.overallHealthy ? "✅ 정상" : "❌ 이상"}</span>
    </div>
  </div>
  <div class="meta">
    대상 <strong>${aLink(m.target, { n: 60 })}</strong> · 실행 ${esc(kstString(m.startedAt))} ·
    소요 ${(m.durationMs / 1000).toFixed(1)}s · runId <code>${esc(m.runId)}</code>
    ${m.gitSha ? ` · sha <code>${esc(m.gitSha.slice(0, 7))}</code>` : ""} ${runLink}
  </div>

  <div class="cards">${cardHtml}</div>

  <h2>🚦 이슈 요약 ${issues.length ? `<span class="badge ng">${issues.length}</span>` : `<span class="badge ok">0</span>`}</h2>
  <div class="${issues.length ? "issues" : "verdict-wrap"}">${issuesPanel}</div>

  <h2>📂 상세 (필요할 때 펼쳐 보기)</h2>
  ${detail(
    "sec-pages",
    "📄 페이지별 점검",
    failedPages.length,
    r.pages.length,
    `<tr><th>상태</th><th>URL</th><th>제목</th><th>로드(ms)</th><th>콘솔</th><th>리소스</th><th>판정</th></tr>`,
    pageRows
  )}
  ${detail(
    "sec-links",
    "🔗 전체 링크",
    brokenLinks.length,
    r.links.length,
    `<tr><th>상태</th><th>구분</th><th>URL</th><th>발견 위치</th></tr>`,
    allLinkRows
  )}
  ${detail(
    "sec-images",
    "🖼️ 전체 이미지",
    brokenImages.length,
    r.images.length,
    `<tr><th>상태</th><th>이미지 URL</th><th>발견 위치</th></tr>`,
    allImageRows
  )}
  ${detail(
    "sec-api",
    "🔌 API 검수 (자사 + 실패 외부)",
    failedApis.length,
    shownApis.length,
    `<tr><th>상태</th><th>구분</th><th>메서드</th><th>엔드포인트</th><th>지연(ms)</th></tr>`,
    apiRows || `<tr><td colspan="5" class="empty">수집된 API 없음</td></tr>`
  )}
  ${hiddenApis > 0 ? `<div class="meta">↑ 정상 외부 분석/광고 비콘 ${hiddenApis}건은 생략(전체는 JSON 참조).</div>` : ""}

  <footer>web-healthcheck · Playwright 자동 생성 · ${esc(kstString(m.finishedAt))}</footer>
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

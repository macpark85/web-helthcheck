// 헬스체크 결과(JSON) → 한글 HTML 리포트 렌더러 (QA → 개발자 인수용)
// 설계 목표
//  1) 한눈에: 상단에서 정상/이상·문제 건수를 즉시 판정
//  2) 개발자 공유: 이슈마다 "원인 전문"(콘솔 메시지·실패 URL·발견 페이지)을 노출하고,
//                  버튼 한 번으로 슬랙/지라에 붙여넣을 텍스트를 클립보드에 복사
//  3) 가벼움: 정상 링크/이미지/API는 개수+소수 샘플만 — 문제만 상세히
//
// healthcheck.js에서 직접 import 하거나, `node src/report.js <json경로>`로 단독 실행 가능.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { deriveIssues } from "./issues.js";
import { annotateHistory } from "./history.js";

// 정상 항목을 상세 표에 몇 개까지 보여줄지 (용량/가독성 절감) — 문제 항목은 항상 전부 표시
const SAMPLE_OK = 20;

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

// 발견 위치를 평문으로 (공유 텍스트용)
function foundOnText(list) {
  const arr = list || [];
  if (!arr.length) return "";
  return arr[0] + (arr.length > 1 ? ` 외 ${arr.length - 1}` : "");
}

export function renderHtmlReport(r, opts = {}) {
  const m = r.meta;
  const s = r.summary;
  const apiThreshold = r.config?.thresholds?.apiLatencyMs || 3000;

  // ---- 문제만 추려 "이슈" 구성 (개발자가 그대로 고칠 수 있도록 원인 전문 포함) ----
  const brokenLinks = r.links.filter((l) => !l.ok);
  const brokenImages = r.images.filter((i) => !i.ok);
  const failedPages = r.pages.filter((p) => !p.ok);
  const fpApis = r.apis.filter((a) => a.firstParty);
  const failedApis = fpApis.filter((a) => !a.ok);
  const slowApis = fpApis.filter((a) => a.latencyMs != null && a.latencyMs > apiThreshold && a.ok);

  // 이슈 도출(공용 로직) → 과거 실행과 비교해 분류(신규/지속/회귀)·빈도 부여
  const issues = annotateHistory(deriveIssues(r), r, opts.dataDir);
  const hasHistory = issues.some((it) => it.history); // 분류 정보가 붙었는지

  // ---- 이슈 카드(개발자용): 종류·상태·대상 + 분류/빈도 + 스크린샷 + 원인 전문 ----
  const classBadge = (h) =>
    h
      ? `<span class="tag tag-${h.cls.tone}">${h.cls.label}</span>` +
        `<span class="tag tag-freq tag-${h.freq.tone}" title="최근 ${h.freq.total}회 중 ${h.freq.count}회 발생">${h.freq.label} ${h.freq.pct}%</span>`
      : "";
  const issueCard = (it) => {
    const detailHtml = it.details?.length
      ? `<ul class="issue-detail">${it.details
          .map((d) => `<li>${esc(d)}</li>`)
          .join("")}</ul>`
      : "";
    const shotHtml = it.screenshot
      ? `<a class="shot" href="${it.screenshot}" target="_blank" rel="noopener" title="클릭하면 원본 크기로 열기"><img src="${it.screenshot}" alt="실패 화면 스크린샷" loading="lazy"></a>`
      : "";
    return `
      <div class="issue ${it.sev}">
        <div class="issue-head">
          <span class="badge ${it.sev}">${it.sev === "ng" ? "문제" : "경고"}</span>
          ${classBadge(it.history)}
          <span class="issue-kind">${esc(it.kind)}</span>
          ${statusCell(it.status)}
          <span class="issue-sum">${esc(it.summary)}</span>
        </div>
        <div class="issue-url">${aLink(it.url, { n: 90 })}</div>
        ${detailHtml}
        ${shotHtml}
      </div>`;
  };

  const issuesPanel = issues.length
    ? `<div class="issue-list">${issues.map(issueCard).join("")}</div>`
    : `<div class="verdict-ok">✅ 발견된 문제 없음 — 점검한 모든 페이지·링크·이미지·API 정상</div>`;

  // ---- 개발자 공유용 평문 텍스트 (복사 버튼이 이걸 클립보드로) ----
  const shareLines = [];
  shareLines.push(
    `[웹 헬스체크] ${m.overallHealthy ? "✅ 정상" : "❌ 이상 " + issues.length + "건"} — ${m.target}`
  );
  shareLines.push(`실행: ${kstString(m.startedAt)} · runId ${m.runId}`);
  if (m.gitSha) shareLines.push(`sha: ${m.gitSha.slice(0, 7)}`);
  if (m.runUrl) shareLines.push(`CI: ${m.runUrl}`);
  shareLines.push("");
  if (!issues.length) {
    shareLines.push("점검한 모든 페이지·링크·이미지·API 정상.");
  } else {
    let n = 0;
    for (const it of issues) {
      n++;
      const tags = [it.sev === "ng" ? "문제" : "경고"];
      if (it.history) tags.push(it.history.cls.label, `${it.history.freq.label} ${it.history.freq.pct}%`);
      shareLines.push(`${n}. [${tags.join("·")}] ${it.kind} (${it.status || "ERR"}) ${it.summary}`);
      shareLines.push(`   ${it.url}`);
      for (const d of it.details || []) shareLines.push(`   - ${d}`);
    }
  }
  const shareText = shareLines.join("\n");

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
    { label: "콘솔 에러", value: s.consoleErrorsTotal, sub: "자사 기준", bad: s.consoleErrorsTotal > 0, href: "#sec-pages" },
  ];
  const cardHtml = cards
    .map(
      (c) => `
      <a class="card ${c.bad ? "bad" : "good"}" href="${c.href}">
        <div class="card-val">${c.value}</div>
        <div class="card-label">${esc(c.label)}</div>
        <div class="card-sub">${esc(c.sub)}</div>
      </a>`
    )
    .join("");

  // ---- 접이식 전체 목록 (문제 먼저, 정상은 SAMPLE_OK개만 표시) ----
  // 문제 행은 전부, 정상 행은 일부만 — 용량과 가독성을 위해.
  const capRows = (rows, makeRow) => {
    const bad = rows.filter((x) => !x.ok);
    const ok = rows.filter((x) => x.ok);
    const shownOk = ok.slice(0, SAMPLE_OK);
    let html = [...bad, ...shownOk].map(makeRow).join("");
    const hiddenOk = ok.length - shownOk.length;
    if (hiddenOk > 0) {
      html += `<tr><td colspan="9" class="more">… 정상 ${hiddenOk}건 더 있음 (전체는 JSON 참조)</td></tr>`;
    }
    return html || `<tr><td colspan="9" class="empty">항목 없음</td></tr>`;
  };

  const linkRow = (l) => `
      <tr class="${l.ok ? "" : "row-bad"}">
        <td>${statusCell(l.status)}</td>
        <td><span class="badge ${l.type === "internal" ? "warn" : "muted"}">${l.type === "internal" ? "내부" : "외부"}</span></td>
        <td class="url">${aLink(l.url, { n: 60 })}</td>
        <td class="url">${foundOnCell(l.foundOn)}</td>
      </tr>`;
  const allLinkRows = capRows(r.links, linkRow);

  const imageRow = (i) => `
      <tr class="${i.ok ? "" : "row-bad"}">
        <td>${statusCell(i.status)}</td>
        <td class="url">${aLink(i.url, { n: 70 })}</td>
        <td class="url">${foundOnCell(i.foundOn)}</td>
      </tr>`;
  const allImageRows = capRows(r.images, imageRow);

  // API: 문제(실패+느림)는 항상 전부, 정상 자사 API는 느린 순 SAMPLE_OK개만.
  // (정상 운영 시 자사 API가 수백~수천 개라 통째로 넣으면 리포트가 무겁고 노이즈가 됨)
  const apiProblem = (a) => !a.ok || (a.latencyMs != null && a.latencyMs > apiThreshold);
  const sortByLatency = (a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0);
  const fpProblemApis = fpApis.filter(apiProblem).sort(sortByLatency);
  const failedExtApis = r.apis.filter((a) => !a.firstParty && !a.ok).sort(sortByLatency);
  const okFpSample = fpApis.filter((a) => !apiProblem(a)).sort(sortByLatency).slice(0, SAMPLE_OK);
  const shownApis = [...fpProblemApis, ...failedExtApis, ...okFpSample];
  const hiddenApis = r.apis.length - shownApis.length;
  const apiRow = (a) => `
      <tr class="${a.ok ? "" : "row-bad"}">
        <td>${statusCell(a.status)}</td>
        <td><span class="badge ${a.firstParty ? "ok" : "muted"}">${a.firstParty ? "자사" : "외부"}</span></td>
        <td><code>${esc(a.method)}</code></td>
        <td class="url">${aLink(a.url, { n: 60 })}</td>
        <td class="num ${a.latencyMs && a.latencyMs > apiThreshold ? "ng-text" : ""}">${a.latencyMs ?? "-"}</td>
      </tr>`;
  const apiRows =
    shownApis.map(apiRow).join("") +
    (hiddenApis > 0
      ? `<tr><td colspan="5" class="more">… 정상 API ${hiddenApis}건 더 있음 (전체는 JSON 참조)</td></tr>`
      : "") || `<tr><td colspan="5" class="empty">수집된 API 없음</td></tr>`;

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
  /* 개발자 공유 바 */
  .sharebar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:6px 0 2px}
  .btn{appearance:none;cursor:pointer;border:1px solid var(--accent);background:rgba(91,156,255,.12);color:var(--accent);
       font-weight:600;font-size:13px;padding:9px 16px;border-radius:10px;transition:.12s}
  .btn:hover{background:rgba(91,156,255,.22)}
  .btn.copied{border-color:var(--ok);color:var(--ok);background:rgba(46,204,113,.14)}
  .sharehint{color:var(--muted);font-size:12.5px}
  .legend{color:var(--muted);font-size:12px;margin:4px 0 10px;line-height:2}
  /* 이슈 카드 (개발자용) */
  .issue-list{display:flex;flex-direction:column;gap:10px}
  .issue{background:var(--panel);border:1px solid var(--line);border-left-width:4px;border-radius:10px;padding:12px 14px}
  .issue.ng{border-left-color:var(--ng)}
  .issue.warn{border-left-color:var(--warn)}
  .issue-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
  .issue-kind{font-weight:700}
  .issue-sum{color:var(--muted);font-size:12.5px}
  .issue-url{margin:6px 0 0;word-break:break-all}
  .issue-url a{color:var(--accent);text-decoration:none}
  .issue-url a:hover{text-decoration:underline}
  .issue-detail{margin:8px 0 0;padding-left:18px;color:var(--txt);font-size:12.5px}
  .issue-detail li{margin:2px 0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#cdd3e0}
  /* 분류·빈도 태그 */
  .tag{display:inline-block;padding:1px 8px;border-radius:6px;font-size:11.5px;font-weight:700;white-space:nowrap;border:1px solid transparent}
  .tag-new{background:rgba(91,156,255,.16);color:var(--accent);border-color:rgba(91,156,255,.4)}
  .tag-regression{background:rgba(255,84,112,.16);color:var(--ng);border-color:rgba(255,84,112,.45)}
  .tag-ongoing{background:#222733;color:var(--muted)}
  .tag-freq{background:transparent;color:var(--muted);border-color:var(--line);font-weight:600}
  .tag-freq.tag-always{color:var(--ng);border-color:rgba(255,84,112,.4)}
  .tag-freq.tag-often{color:var(--warn);border-color:rgba(241,196,15,.4)}
  /* 실패 화면 스크린샷 썸네일 */
  .shot{display:inline-block;margin:10px 0 2px;border:1px solid var(--line);border-radius:8px;overflow:hidden;line-height:0}
  .shot:hover{border-color:var(--accent)}
  .shot img{display:block;max-width:340px;width:100%;height:auto}
  table{width:100%;border-collapse:collapse;font-size:13px}
  thead th{background:var(--panel2);color:var(--muted);font-weight:600;text-align:left;padding:9px 11px;position:sticky;top:0;z-index:1}
  td{padding:8px 11px;border-top:1px solid var(--line);vertical-align:top}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  td.url{max-width:380px;word-break:break-all}
  td.more,td.empty{color:var(--muted);text-align:center;font-size:12.5px;padding:12px}
  a{color:var(--accent)}
  td.url a{color:var(--accent);text-decoration:none}
  td.url a:hover{text-decoration:underline}
  .muted{color:var(--muted)}
  .row-bad{background:rgba(255,84,112,.07)}
  .ng-text{color:var(--ng);font-weight:600}
  .badge{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap}
  .badge.ok{background:rgba(46,204,113,.18);color:var(--ok)}
  .badge.warn{background:rgba(241,196,15,.2);color:var(--warn)}
  .badge.ng{background:rgba(255,84,112,.2);color:var(--ng)}
  .badge.muted{background:#222733;color:var(--muted)}
  code{background:#222733;padding:1px 5px;border-radius:5px;font-size:12px}
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

  <h2>🚦 이슈 ${issues.length ? `<span class="badge ng">${issues.length}</span>` : `<span class="badge ok">0</span>`}</h2>
  ${issues.length ? `<div class="sharebar">
    <button class="btn" id="copyBtn" type="button">📋 개발자 공유용 복사</button>
    <span class="sharehint">클릭하면 아래 이슈 전체가 텍스트로 복사됩니다 → 슬랙/지라에 붙여넣기</span>
  </div>` : ""}
  ${issues.length && hasHistory ? `<div class="legend">분류:
    <span class="tag tag-new">신규</span> 처음 발생 ·
    <span class="tag tag-ongoing">지속</span> 직전에도 있던 문제 ·
    <span class="tag tag-regression">회귀</span> 고쳐졌다 재발생 &nbsp;|&nbsp; 빈도:
    <span class="tag tag-freq tag-always">항상 100%</span> /
    <span class="tag tag-freq tag-often">자주 ≥50%</span> /
    <span class="tag tag-freq">가끔</span> /
    <span class="tag tag-freq">1회</span> (최근 ${issues[0].history.window}회 기준)</div>` : ""}
  ${issuesPanel}

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
    "🔗 링크",
    brokenLinks.length,
    r.links.length,
    `<tr><th>상태</th><th>구분</th><th>URL</th><th>발견 위치</th></tr>`,
    allLinkRows
  )}
  ${detail(
    "sec-images",
    "🖼️ 이미지",
    brokenImages.length,
    r.images.length,
    `<tr><th>상태</th><th>이미지 URL</th><th>발견 위치</th></tr>`,
    allImageRows
  )}
  ${detail(
    "sec-api",
    "🔌 API 검수 (자사 + 실패 외부)",
    failedApis.length,
    fpApis.length,
    `<tr><th>상태</th><th>구분</th><th>메서드</th><th>엔드포인트</th><th>지연(ms)</th></tr>`,
    apiRows
  )}

  <footer>web-healthcheck · Playwright 자동 생성 · ${esc(kstString(m.finishedAt))}</footer>
</div>

<textarea id="shareSrc" style="position:absolute;left:-9999px;top:-9999px" readonly>${esc(shareText)}</textarea>
<script>
  (function () {
    var btn = document.getElementById("copyBtn");
    if (!btn) return;
    var src = document.getElementById("shareSrc");
    btn.addEventListener("click", function () {
      var text = src.value;
      function done() {
        var old = btn.textContent;
        btn.textContent = "✅ 복사됨";
        btn.classList.add("copied");
        setTimeout(function () { btn.textContent = old; btn.classList.remove("copied"); }, 1800);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallback(); });
      } else { fallback(); }
      function fallback() {
        src.style.left = "0"; src.focus(); src.select();
        try { document.execCommand("copy"); done(); } catch (e) {}
        src.style.left = "-9999px";
      }
    });
  })();
</script>
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

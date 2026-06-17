// 헬스체크 결과(result JSON) → 이슈 배열 변환 (공용 로직)
// report.js(렌더링)와 history.js(과거 실행 비교)가 "같은 방식"으로 이슈를 도출하도록
// 한 곳에서만 정의한다. 각 이슈에는 실행 간 동일성 판단용 안정 키(key)가 붙는다.

// 발견 위치를 평문 한 줄로 (공유 텍스트/상세용)
export function foundOnText(list) {
  const arr = list || [];
  if (!arr.length) return "";
  return arr[0] + (arr.length > 1 ? ` 외 ${arr.length - 1}` : "");
}

// 실행이 달라도 "같은 이슈"면 같은 키가 나오도록 — URL 기준(상태코드는 바뀔 수 있어 제외)
function pageKey(p) {
  return `페이지|${p.finalUrl || p.url}`;
}

export function deriveIssues(r) {
  const apiThreshold = r.config?.thresholds?.apiLatencyMs || 3000;

  const brokenLinks = (r.links || []).filter((l) => !l.ok);
  const brokenImages = (r.images || []).filter((i) => !i.ok);
  const failedPages = (r.pages || []).filter((p) => !p.ok);
  const fpApis = (r.apis || []).filter((a) => a.firstParty);
  const failedApis = fpApis.filter((a) => !a.ok);
  const slowApis = fpApis.filter(
    (a) => a.latencyMs != null && a.latencyMs > apiThreshold && a.ok
  );

  const issues = [];

  for (const p of failedPages) {
    const reasons = [];
    if (p.navError) reasons.push(`접속오류 ${p.navError}`);
    if (p.consoleErrors?.length) reasons.push(`콘솔 에러 ${p.consoleErrors.length}`);
    if (p.failedRequests?.length) reasons.push(`자사 리소스 실패 ${p.failedRequests.length}`);
    if (p.slow) reasons.push(`느린 로드 ${p.loadMs}ms`);

    const details = [];
    for (const msg of p.consoleErrors || []) details.push(`콘솔: ${msg}`);
    for (const fr of p.failedRequests || []) {
      details.push(`리소스 실패: [${fr.method || "GET"}] ${fr.url} — ${fr.error || ""}`.trim());
    }

    issues.push({
      key: pageKey(p),
      sev: "ng",
      kind: "페이지",
      status: p.status,
      url: p.finalUrl || p.url,
      summary: reasons.join(" · ") || "판정 실패",
      details,
      screenshot: p.screenshot || null, // 실패 페이지 스크린샷(data URI), 없으면 null
    });
  }

  for (const l of brokenLinks) {
    issues.push({
      key: `링크|${l.url}`,
      sev: "ng",
      kind: l.type === "internal" ? "링크(내부)" : "링크(외부)",
      status: l.status,
      url: l.url,
      summary: l.error || `HTTP ${l.status}`,
      details: [`발견 위치: ${foundOnText(l.foundOn)}`],
      screenshot: null,
    });
  }

  for (const i of brokenImages) {
    issues.push({
      key: `이미지|${i.url}`,
      sev: "ng",
      kind: "이미지",
      status: i.status,
      url: i.url,
      summary: i.error || `HTTP ${i.status}`,
      details: [`발견 위치: ${foundOnText(i.foundOn)}`],
      screenshot: null,
    });
  }

  for (const a of failedApis) {
    issues.push({
      key: `API|${a.method} ${a.url}`,
      sev: "ng",
      kind: "API",
      status: a.status,
      url: a.url,
      summary: `${a.method} · ${a.latencyMs ?? "-"}ms`,
      details: [`호출 페이지: ${a.fromPage || "-"}`],
      screenshot: null,
    });
  }

  for (const a of slowApis) {
    issues.push({
      key: `API느림|${a.method} ${a.url}`,
      sev: "warn",
      kind: "API 느림",
      status: a.status,
      url: a.url,
      summary: `${a.method} · ${a.latencyMs}ms (임계 ${apiThreshold}ms)`,
      details: [`호출 페이지: ${a.fromPage || "-"}`],
      screenshot: null,
    });
  }

  // 심각(ng) 먼저, 그다음 경고(warn)
  issues.sort((a, b) => (a.sev === b.sev ? 0 : a.sev === "ng" ? -1 : 1));
  return issues;
}

// Playwright 기반 웹 헬스체크 메인 스크립트
// - 동일 출처 페이지 크롤링(BFS)
// - 페이지 로드 시간 / 콘솔 에러 / 깨진 리소스 수집
// - API(XHR/fetch/JSON) 응답 상태·지연시간 검수
// - 모든 링크 / 이미지 전수 상태코드 조사
// - 결과 JSON 저장 후 HTML 리포트 생성

import { chromium } from "playwright";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderHtmlReport } from "./report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function loadConfig() {
  const cfgPath = join(ROOT, "healthcheck.config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  // 환경변수로 baseUrl 오버라이드 가능 (CI에서 유용)
  if (process.env.HC_BASE_URL) cfg.baseUrl = process.env.HC_BASE_URL;
  return cfg;
}

// 한국 시간(KST) 타임스탬프 파일명: 20260616_200612
function stampKST(d = new Date()) {
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${kst.getUTCFullYear()}${p(kst.getUTCMonth() + 1)}${p(kst.getUTCDate())}` +
    `_${p(kst.getUTCHours())}${p(kst.getUTCMinutes())}${p(kst.getUTCSeconds())}`
  );
}

function isHttp(u) {
  return /^https?:\/\//i.test(u);
}

function sameOrigin(u, baseHost, includeSub) {
  try {
    const h = new URL(u).hostname;
    if (h === baseHost) return true;
    if (includeSub && h.endsWith("." + baseHost)) return true;
    return false;
  } catch {
    return false;
  }
}

function normalize(u) {
  try {
    const url = new URL(u);
    url.hash = ""; // 프래그먼트 제거 (중복 방지)
    return url.toString();
  } catch {
    return null;
  }
}

// 동시성 제한 풀
async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await worker(items[cur], cur);
    }
  });
  await Promise.all(runners);
  return results;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 단일 요청(HEAD 우선, 막히면 GET 폴백)
async function requestOnce(url, opts) {
  const { timeoutMs, userAgent, accept } = opts;
  for (const method of ["HEAD", "GET"]) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        signal: ctrl.signal,
        headers: { "user-agent": userAgent, accept: accept || "*/*" },
      });
      clearTimeout(t);
      // 일부 서버는 HEAD를 막음(405/501) → GET 재시도
      if (method === "HEAD" && (res.status === 405 || res.status === 501)) continue;
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 400,
        finalUrl: res.url,
        redirected: res.redirected,
        contentType: res.headers.get("content-type") || "",
        latencyMs: Date.now() - started,
        method,
        error: null,
      };
    } catch (e) {
      clearTimeout(t);
      const err = e.name === "AbortError" ? `timeout(${timeoutMs}ms)` : e.message;
      if (method === "GET") return { status: 0, ok: false, error: err, latencyMs: null };
      // HEAD 예외면 GET으로 폴백 계속
    }
  }
  return { status: 0, ok: false, error: "request failed", latencyMs: null };
}

// 일시적 실패(네트워크 끊김, 429, 5xx, 그리고 CDN/이미지옵티마이저의 순간적 4xx)는
// 재시도+백오프로 흡수해서 "지속적으로 실패하는 것"만 깨진 것으로 보고한다.
function isTransient(r) {
  if (r.status === 0) return true; // 네트워크 오류/타임아웃
  if (r.status === 408 || r.status === 425 || r.status === 429) return true;
  if (r.status >= 500) return true;
  // Next.js _next/image 최적화 서버는 버스트 시 순간적으로 400/403을 반환하는 사례가 있어
  // 이미지 검사에 한해 이 둘도 일시적 실패 후보로 본 뒤 재시도한다.
  if ((r.status === 400 || r.status === 403) && r.imageMode) return true;
  return false;
}

async function checkUrl(url, opts) {
  const { retries } = opts;
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await requestOnce(url, opts);
    last.imageMode = opts.imageMode;
    if (last.ok || !isTransient(last)) break;
    if (attempt < retries) await sleep(400 * (attempt + 1) + Math.floor((url.length % 7) * 30));
  }
  return {
    status: last.status,
    ok: last.ok,
    finalUrl: last.finalUrl || url,
    redirected: last.redirected || false,
    contentType: last.contentType || "",
    latencyMs: last.latencyMs ?? null,
    method: last.method || null,
    error: last.ok ? null : last.error || (last.status ? `HTTP ${last.status}` : "request failed"),
  };
}

async function run() {
  const cfg = loadConfig();
  const baseHost = new URL(cfg.baseUrl).hostname;
  const runId = stampKST();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  console.log(`[healthcheck] target=${cfg.baseUrl} runId=${runId}`);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({
    userAgent: cfg.navigation.userAgent,
    ignoreHTTPSErrors: false,
    locale: "ko-KR",
  });

  const pages = [];
  const apiMap = new Map(); // key: method+url -> api record (마지막 관측값)
  const linkSet = new Map(); // url -> Set(foundOn)
  const imageSet = new Map(); // url -> Set(foundOn)

  // 크롤 대상 큐 (동일 출처 페이지만)
  const queue = [];
  const seen = new Set();
  for (const p of cfg.startPaths) {
    const abs = normalize(new URL(p, cfg.baseUrl).toString());
    if (abs && !seen.has(abs)) {
      seen.add(abs);
      queue.push(abs);
    }
  }

  const ignoreRe = (cfg.crawl.ignorePatterns || []).map((p) => new RegExp(p, "i"));
  const shouldIgnore = (u) => ignoreRe.some((re) => re.test(u));

  while (queue.length && pages.length < cfg.crawl.maxPages) {
    const pageUrl = queue.shift();
    const page = await context.newPage();
    const consoleErrors = []; // 자사(1st-party) 콘솔 에러만
    const consoleWarnings = [];
    const failedRequests = []; // 자사 실패 요청만 (health 판정 대상)
    const thirdPartyFailures = []; // 광고/분석 등 외부 실패 (정보용, 판정 제외)

    const isFirstParty = (u) => sameOrigin(u, baseHost, cfg.crawl.includeSubdomains);

    page.on("console", (msg) => {
      const type = msg.type();
      if (type !== "error" && type !== "warning") return;
      const loc = msg.location()?.url || "";
      // 콘솔 메시지 출처가 외부(트래커 등)면 자사 판정에서 제외
      const fp = loc === "" || isFirstParty(loc);
      if (type === "error") {
        if (fp) consoleErrors.push(msg.text().slice(0, 500));
      } else if (fp) {
        consoleWarnings.push(msg.text().slice(0, 300));
      }
    });

    page.on("requestfailed", (req) => {
      const errText = req.failure()?.errorText || "failed";
      // ERR_ABORTED / ERR_CANCELED 는 "실패"가 아니라 취소다.
      // (Next.js RSC 프리페치나 페이지 close 시점의 미완료 요청이 여기에 잡힘 → 노이즈)
      if (/ERR_ABORTED|ERR_CANCELED/i.test(errText)) return;
      const url = req.url();
      const rec = { url: url.slice(0, 300), method: req.method(), error: errText };
      if (isFirstParty(url)) failedRequests.push(rec);
      else thirdPartyFailures.push(rec);
    });

    // API/리소스 응답 수집
    page.on("response", async (res) => {
      try {
        const req = res.request();
        const rType = req.resourceType();
        const url = res.url();
        const ct = res.headers()["content-type"] || "";
        const isApi =
          rType === "xhr" ||
          rType === "fetch" ||
          (ct.includes("application/json") && !url.endsWith(".json"));
        if (!cfg.checks.api || !isApi) {
          // 페이지 로드 중 깨진 리소스(4xx/5xx)도 기록 (자사/외부 구분)
          if (res.status() >= 400) {
            const rec = { url: url.slice(0, 300), method: req.method(), error: `HTTP ${res.status()}` };
            if (isFirstParty(url)) failedRequests.push(rec);
            else thirdPartyFailures.push(rec);
          }
          return;
        }
        const timing = req.timing();
        const latencyMs =
          timing && timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : null;
        const key = `${req.method()} ${url}`;
        apiMap.set(key, {
          url,
          method: req.method(),
          status: res.status(),
          ok: res.status() >= 200 && res.status() < 400,
          latencyMs,
          contentType: ct,
          resourceType: rType,
          firstParty: isFirstParty(url),
          fromPage: pageUrl,
        });
      } catch {
        /* 응답 본문 접근 실패 등은 무시 */
      }
    });

    let status = 0;
    let finalUrl = pageUrl;
    let title = "";
    let loadMs = null;
    let navError = null;
    const navStart = Date.now();
    try {
      const resp = await page.goto(pageUrl, {
        timeout: cfg.navigation.timeoutMs,
        waitUntil: cfg.navigation.waitUntil,
      });
      // load 이후 네트워크가 잠잠해질 때까지 잠깐 대기(API 호출 포착용). 실패해도 무시.
      if (cfg.navigation.settleMs) {
        await page
          .waitForLoadState("networkidle", { timeout: cfg.navigation.settleMs })
          .catch(() => {});
      }
      loadMs = Date.now() - navStart;
      status = resp ? resp.status() : 0;
      finalUrl = page.url();
      title = await page.title().catch(() => "");

      // 링크/이미지 추출
      const extracted = await page.evaluate(() => {
        const links = new Set();
        document.querySelectorAll("a[href]").forEach((a) => {
          const href = a.getAttribute("href");
          if (href) links.add(new URL(href, location.href).toString());
        });
        const images = new Set();
        const addImg = (src) => {
          if (src) images.add(new URL(src, location.href).toString());
        };
        document.querySelectorAll("img").forEach((img) => {
          if (img.currentSrc) addImg(img.currentSrc);
          else if (img.getAttribute("src")) addImg(img.getAttribute("src"));
          const srcset = img.getAttribute("srcset");
          if (srcset)
            srcset
              .split(",")
              .forEach((s) => addImg(s.trim().split(/\s+/)[0]));
        });
        document.querySelectorAll("source[srcset]").forEach((s) => {
          s.getAttribute("srcset")
            .split(",")
            .forEach((x) => addImg(x.trim().split(/\s+/)[0]));
        });
        return { links: [...links], images: [...images] };
      });

      for (const raw of extracted.links) {
        const u = normalize(raw);
        if (!u || !isHttp(u) || shouldIgnore(u)) continue;
        if (!linkSet.has(u)) linkSet.set(u, new Set());
        linkSet.get(u).add(pageUrl);
        // 동일 출처면 크롤 큐에 추가
        if (
          cfg.crawl.sameOriginOnly &&
          sameOrigin(u, baseHost, cfg.crawl.includeSubdomains) &&
          !seen.has(u) &&
          queue.length + pages.length < cfg.crawl.maxPages
        ) {
          seen.add(u);
          queue.push(u);
        }
      }
      for (const raw of extracted.images) {
        const u = normalize(raw);
        if (!u || !isHttp(u)) continue;
        if (!imageSet.has(u)) imageSet.set(u, new Set());
        imageSet.get(u).add(pageUrl);
      }
    } catch (e) {
      navError = e.message.split("\n")[0];
      loadMs = Date.now() - navStart;
    }

    const pageOk =
      navError === null &&
      status >= 200 &&
      status < 400 &&
      failedRequests.length === 0 && // 자사 리소스 실패가 없어야 함
      (cfg.checks.console ? consoleErrors.length <= cfg.thresholds.maxConsoleErrors : true);

    pages.push({
      url: pageUrl,
      finalUrl,
      status,
      title,
      loadMs,
      slow: loadMs !== null && loadMs > cfg.thresholds.pageLoadMs,
      navError,
      consoleErrors,
      consoleWarnings,
      failedRequests,
      thirdPartyFailures: thirdPartyFailures.length,
      ok: pageOk,
    });

    console.log(
      `  [page] ${status || "ERR"} ${loadMs ?? "-"}ms ${pageUrl}` +
        (consoleErrors.length ? ` (console errors: ${consoleErrors.length})` : "")
    );

    await page.close();
  }

  await browser.close();

  // ---- 링크/이미지 전수 상태코드 조사 ----
  const baseOpts = {
    timeoutMs: cfg.resourceCheck.requestTimeoutMs,
    retries: cfg.resourceCheck.retries,
    userAgent: cfg.navigation.userAgent,
  };
  const linkOpts = { ...baseOpts, accept: "text/html,application/xhtml+xml,*/*" };
  const imageOpts = {
    ...baseOpts,
    accept: "image/avif,image/webp,image/apng,image/*,*/*",
    imageMode: true,
  };

  let links = [];
  if (cfg.checks.links) {
    const linkUrls = [...linkSet.keys()];
    console.log(`[healthcheck] checking ${linkUrls.length} links ...`);
    links = await pool(linkUrls, cfg.resourceCheck.concurrency, async (u) => {
      const r = await checkUrl(u, linkOpts);
      return {
        url: u,
        type: sameOrigin(u, baseHost, cfg.crawl.includeSubdomains) ? "internal" : "external",
        foundOn: [...linkSet.get(u)],
        ...r,
      };
    });
  }

  let images = [];
  if (cfg.checks.images) {
    const imageUrls = [...imageSet.keys()];
    console.log(`[healthcheck] checking ${imageUrls.length} images ...`);
    images = await pool(imageUrls, cfg.resourceCheck.concurrency, async (u) => {
      const r = await checkUrl(u, imageOpts);
      const looksImg =
        r.contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|svg|ico)(\?|$)/i.test(u);
      return {
        url: u,
        foundOn: [...imageSet.get(u)],
        contentTypeOk: r.ok ? looksImg : false,
        ...r,
      };
    });
  }

  const apis = [...apiMap.values()].sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0));

  // ---- 집계 ----
  const brokenLinks = links.filter((l) => !l.ok);
  const brokenImages = images.filter((i) => !i.ok);
  const firstPartyApis = apis.filter((a) => a.firstParty);
  // 지연/실패 판정은 자사 API 기준 (외부 분석/광고 비콘은 정보용으로만 보관)
  const slowApis = firstPartyApis.filter(
    (a) => a.latencyMs !== null && a.latencyMs > cfg.thresholds.apiLatencyMs
  );
  const failedApis = firstPartyApis.filter((a) => !a.ok);
  const failedPages = pages.filter((p) => !p.ok);

  const summary = {
    pagesChecked: pages.length,
    pagesFailed: failedPages.length,
    linksChecked: links.length,
    linksBroken: brokenLinks.length,
    imagesChecked: images.length,
    imagesBroken: brokenImages.length,
    apisChecked: apis.length,
    apisFirstParty: firstPartyApis.length,
    apisFailed: failedApis.length,
    apisSlow: slowApis.length,
    consoleErrorsTotal: pages.reduce((s, p) => s + p.consoleErrors.length, 0),
  };

  const overallHealthy =
    summary.pagesFailed === 0 &&
    summary.linksBroken === 0 &&
    summary.imagesBroken === 0 &&
    summary.apisFailed === 0;

  const result = {
    meta: {
      target: cfg.baseUrl,
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      gitSha: process.env.GITHUB_SHA || null,
      runUrl:
        process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
          ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : null,
      overallHealthy,
    },
    config: cfg,
    summary,
    pages,
    apis,
    links,
    images,
  };

  // ---- 저장 ----
  const dataDir = join(ROOT, "reports", "data");
  mkdirSync(dataDir, { recursive: true });
  const jsonPath = join(dataDir, `${runId}.json`);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  const htmlPath = join(ROOT, "reports", `healthcheck_${runId}.html`);
  writeFileSync(htmlPath, renderHtmlReport(result));
  // latest 바로가기
  writeFileSync(join(ROOT, "reports", "latest.html"), renderHtmlReport(result));

  console.log("\n===== 헬스체크 요약 =====");
  console.log(`상태: ${overallHealthy ? "✅ 정상" : "❌ 이상 감지"}`);
  console.log(
    `페이지 ${summary.pagesChecked}개(실패 ${summary.pagesFailed}) | ` +
      `링크 ${summary.linksChecked}개(깨짐 ${summary.linksBroken}) | ` +
      `이미지 ${summary.imagesChecked}개(깨짐 ${summary.imagesBroken}) | ` +
      `API ${summary.apisChecked}개(실패 ${summary.apisFailed}, 느림 ${summary.apisSlow})`
  );
  console.log(`JSON: ${jsonPath}`);
  console.log(`HTML: ${htmlPath}`);

  // CI에서 실패 시 워크플로우를 빨갛게 표시하고 싶으면 HC_FAIL_ON_ERROR=1
  if (process.env.HC_FAIL_ON_ERROR === "1" && !overallHealthy) {
    process.exitCode = 1;
  }
}

run().catch((e) => {
  console.error("[healthcheck] 치명적 오류:", e);
  process.exit(2);
});

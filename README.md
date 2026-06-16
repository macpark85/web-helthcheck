# web-healthcheck

Playwright 기반 **웹 페이지 헬스체크 자동화**.
대상 사이트를 크롤링하며 **링크 / 이미지 전수 조사 + API 검수 + 페이지 로드/콘솔 점검**을 수행하고,
보기 좋은 **HTML 리포트**를 생성합니다. GitHub Actions로 **하루 12회(2시간마다)** 자동 실행됩니다.

- 대상: `https://ezlab.im` (변경은 [healthcheck.config.json](healthcheck.config.json) 또는 `HC_BASE_URL` 환경변수)
- 리포트: `reports/healthcheck_<타임스탬프>.html`, 항상 최신본은 `reports/latest.html`
- 원시 데이터: `reports/data/<타임스탬프>.json`

## 점검 항목

| 항목 | 내용 |
|---|---|
| 📄 페이지 | 동일 출처 페이지를 BFS로 크롤(기본 최대 40개). HTTP 상태, 로드 시간, 콘솔 에러, 깨진 리소스 점검 |
| 🔗 링크 | 페이지에서 발견한 모든 `a[href]`(내부/외부)를 전수 상태코드 조사 |
| 🖼️ 이미지 | 모든 `img`(`src`/`currentSrc`/`srcset`) + `source[srcset]`를 전수 상태코드 조사 |
| 🔌 API | XHR/fetch/JSON 응답을 가로채 상태코드·지연시간 검수. **자사 API만** 합격/불합격 판정 |
| 🖥️ 콘솔 | 페이지 콘솔 에러 수집 (자사 출처만 판정 반영) |

### 노이즈 제거 (오탐 방지) — 검증하며 실제로 잡은 케이스

이 프로젝트는 ezlab.im에 실제로 돌려보며 아래 오탐들을 걸러내도록 다듬었습니다.

1. **써드파티 트래커 분리** — Google Analytics/doubleclick, Yahoo APM 등 외부 분석·광고 비콘의
   실패(403, ERR_ABORTED)는 사이트 health 판정에서 제외하고 정보용으로만 기록.
2. **취소(ERR_ABORTED/ERR_CANCELED) 무시** — Next.js RSC 프리페치(`?_rsc=`)나 페이지 전환 시
   미완료된 요청은 "실패"가 아니라 취소이므로 제외.
3. **일시적 오류 재시도** — `_next/image` 최적화 서버가 버스트 요청 시 순간적으로 뱉는 400/403,
   그리고 5xx·429·타임아웃은 백오프 재시도(기본 2회)로 흡수 → **지속적 실패만** 보고.

## 설정 ([healthcheck.config.json](healthcheck.config.json))

```jsonc
{
  "baseUrl": "https://ezlab.im",        // HC_BASE_URL 환경변수로 오버라이드 가능
  "startPaths": ["/ko", "/en", "/jp", "/tw"],
  "crawl": {
    "maxPages": 40,                      // 크롤 상한
    "sameOriginOnly": true,
    "includeSubdomains": false,
    "ignorePatterns": ["\\.pdf$", "mailto:", "tel:", "^javascript:"]
  },
  "thresholds": {
    "pageLoadMs": 8000,                  // 이보다 느리면 'slow' 표시
    "apiLatencyMs": 3000,                // 이보다 느린 자사 API는 'slow'
    "maxConsoleErrors": 0
  },
  "navigation": { "timeoutMs": 30000, "waitUntil": "load", "settleMs": 4000, "userAgent": "..." },
  "resourceCheck": { "concurrency": 6, "requestTimeoutMs": 15000, "retries": 2 }
}
```

## 로컬 실행

> Node.js 20+ 필요. (이 맥에는 전역 node가 없어 검증은 휴대용 node로 진행했습니다.
> 직접 돌리려면 [nodejs.org](https://nodejs.org)에서 설치하거나 `brew install node`)

```bash
cd ~/Desktop/web-healthcheck
npm install
npx playwright install chromium   # 최초 1회 (브라우저 다운로드)
npm run check                     # 헬스체크 실행 → reports/latest.html 생성
open reports/latest.html          # 리포트 열기 (macOS)
```

다른 사이트를 한 번만 점검하려면:

```bash
HC_BASE_URL="https://example.com" npm run check
```

이미 생성된 JSON으로 HTML만 다시 만들기:

```bash
node src/report.js reports/data/<타임스탬프>.json
```

## 자동 실행 (GitHub Actions)

[.github/workflows/healthcheck.yml](.github/workflows/healthcheck.yml)

- **스케줄**: `cron: "0 */2 * * *"` → 2시간마다 = **하루 12회** (요구사항 "최소 10회/일" 충족)
- **수동 실행**: Actions 탭 → `web-healthcheck` → *Run workflow* (대상 URL 입력 가능)
- **리포트 보관**:
  - 매 실행마다 `reports/` 전체를 **아티팩트**로 업로드(30일 보관) → Actions 실행 페이지에서 다운로드
  - (선택) **GitHub Pages**: 저장소 *Settings → Pages → Source*를 `gh-pages` 브랜치로 지정하면
    `https://<사용자>.github.io/<레포>/latest.html`에서 항상 최신 리포트 확인 가능

### 사용 시작 (GitHub에 올리기)

```bash
cd ~/Desktop/web-healthcheck
git init && git add . && git commit -m "web-healthcheck 초기 구성"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

> 푸시 후 Actions 탭에서 *web-healthcheck → Run workflow*로 즉시 한 번 돌려 동작을 확인하세요.
> 스케줄 cron은 GitHub 부하에 따라 수 분 지연될 수 있습니다(정상).

### 이상 감지 시 워크플로우 실패 처리

기본은 이상이 있어도 워크플로우는 초록(성공)으로 두고 리포트만 남깁니다.
이상 발생 시 Actions를 빨강(실패)으로 만들려면 워크플로우의 `HC_FAIL_ON_ERROR`를 `"1"`로 바꾸세요.
(이메일/슬랙 알림은 이 실패 신호에 연결하면 됩니다 — 필요하면 추가 설정 가능)

## 구조

```
web-healthcheck/
├── healthcheck.config.json     # 점검 설정
├── package.json
├── src/
│   ├── healthcheck.js          # 메인: 크롤 + 링크/이미지/API 검수
│   └── report.js               # 결과 JSON → 한글 HTML 리포트
├── reports/                    # 결과물 (gitignore, CI 아티팩트로 관리)
│   ├── latest.html
│   ├── healthcheck_<ts>.html
│   └── data/<ts>.json
└── .github/workflows/healthcheck.yml
```

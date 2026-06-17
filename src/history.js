// 이슈를 과거 실행 기록과 비교해 "분류(신규/지속/회귀)"와 "발생 빈도"를 매긴다.
// 과거 결과는 reports/data/*.json 에 누적되며, 파일명(runId)이 KST 타임스탬프라 사전순=시간순.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deriveIssues } from "./issues.js";

// 빈도를 따질 때 거슬러 볼 과거 실행 수(현재 제외)
const WINDOW = 10;

// 발생 횟수/전체 → 빈도 라벨
function freqLabel(count, total) {
  const ratio = total ? count / total : 1;
  const pct = Math.round(ratio * 100);
  let label, tone;
  if (count <= 1) {
    label = "1회"; tone = "once"; // 이번에만 관측
  } else if (ratio >= 1) {
    label = "항상"; tone = "always"; // 본 모든 실행에서 발생
  } else if (ratio >= 0.5) {
    label = "자주"; tone = "often";
  } else {
    label = "가끔"; tone = "sometimes";
  }
  return { label, tone, pct, count, total };
}

// issues 배열에 it.history = { cls, freq, window } 를 채워 반환.
// dataDir 가 없거나 과거 기록을 못 읽으면 분류를 생략한다(안전).
export function annotateHistory(issues, current, dataDir) {
  if (!dataDir || !issues.length) return issues;

  let files;
  try {
    files = readdirSync(dataDir).filter((f) => f.endsWith(".json"));
  } catch {
    return issues; // data 디렉터리 없음 → 분류 생략
  }

  const curId = current?.meta?.runId;
  const priorIds = files
    .map((f) => f.replace(/\.json$/, ""))
    .filter((id) => id !== curId)
    .sort() // 타임스탬프 문자열 → 사전순이 곧 시간순
    .slice(-WINDOW);

  // 각 과거 실행의 이슈 키 집합 (오래된 → 최신 순)
  const priorKeySets = [];
  for (const id of priorIds) {
    try {
      const past = JSON.parse(readFileSync(join(dataDir, id + ".json"), "utf8"));
      priorKeySets.push(new Set(deriveIssues(past).map((i) => i.key)));
    } catch {
      /* 손상/구버전 파일은 건너뜀 */
    }
  }

  const total = priorKeySets.length + 1; // 과거 + 현재
  for (const it of issues) {
    const presentPrior = priorKeySets.map((s) => s.has(it.key));
    const everBefore = presentPrior.some(Boolean);
    const inPrevRun = presentPrior.length ? presentPrior[presentPrior.length - 1] : false;

    let cls;
    if (!everBefore) cls = { label: "신규", tone: "new" };
    else if (inPrevRun) cls = { label: "지속", tone: "ongoing" };
    else cls = { label: "회귀", tone: "regression" }; // 사라졌다 다시 나타남

    const count = presentPrior.filter(Boolean).length + 1; // 현재 포함
    it.history = { cls, freq: freqLabel(count, total), window: total };
  }
  return issues;
}

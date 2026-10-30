/**
 * 오늘의 진짜 정보판 V1
 * CoinGecko 공개 API (API Key 불필요) — BTC/KRW
 * 카드 3: 다섯 가지 실패 Mock + stale 보존 + 복구 (T04-C12~C19)
 * 카드 4: KST 일별 기록 localStorage (T04-C20·C21)
 * 카드 5: 어제 대비 변화량 (T04-C23·C24)
 */

const API_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=krw&include_last_updated_at=true";

const STORAGE_KEY = "dailyRecords";
const MOCK_TIMEOUT_MS = 1800;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ERROR_GUIDE = {
  timeout: {
    title: "느린 외부 응답 (시간 초과)",
    action: "출처 서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.",
  },
  auth: {
    title: "요청 거절 (401/403)",
    action: "접근이 거절되었습니다. 권한·차단 여부를 확인하거나 잠시 후 다시 시도해 주세요.",
  },
  rate_limit: {
    title: "호출 제한 (429 Too Many Requests)",
    action: "요청 한도를 초과했습니다. 잠시 기다린 뒤 다시 시도해 주세요.",
  },
  offline: {
    title: "오프라인 / 네트워크 끊김",
    action: "인터넷 연결 상태를 확인한 뒤 다시 시도해 주세요.",
  },
  schema: {
    title: "응답 형식 변경 (스키마 불일치)",
    action: "예상과 다른 데이터 구조가 도착했습니다. 잠시 후 다시 시도해 주세요.",
  },
  unknown: {
    title: "알 수 없는 오류",
    action: "일시적인 문제일 수 있습니다. 다시 시도해 주세요.",
  },
};

const state = {
  freshness: "empty",
  errorCode: "none",
  activeMock: null,
  lastGood: null,
  loading: false,
  /** 합성 시계: null이면 실시간, 숫자면 해당 epoch ms 기준 */
  mockNowMs: null,
};

const els = {
  card: document.querySelector(".quote-card"),
  price: document.getElementById("btc-price"),
  unit: document.getElementById("btc-unit"),
  source: document.getElementById("data-source"),
  sourceUpdated: document.getElementById("source-updated"),
  fetchedAt: document.getElementById("fetched-at"),
  timezone: document.getElementById("timezone"),
  freshnessLabel: document.getElementById("freshness-label"),
  staleBadge: document.getElementById("stale-badge"),
  errorPanel: document.getElementById("error-panel"),
  errorTitle: document.getElementById("error-title"),
  errorAction: document.getElementById("error-action"),
  status: document.getElementById("status"),
  refreshBtn: document.getElementById("refresh-btn"),
  retryBtn: document.getElementById("retry-btn"),
  mockClearBtn: document.getElementById("mock-clear-btn"),
  mockButtons: [...document.querySelectorAll("[data-mock]")],
  clockLabel: document.getElementById("clock-label"),
  historyList: document.getElementById("daily-history-list"),
  clockSameDayBtn: document.getElementById("clock-same-day-btn"),
  clockNextDayBtn: document.getElementById("clock-next-day-btn"),
  clockResetBtn: document.getElementById("clock-reset-btn"),
  dayChange: document.getElementById("day-change"),
};

/** 합성 시계 또는 실시간 Date */
function getNow() {
  return state.mockNowMs == null ? new Date() : new Date(state.mockNowMs);
}

/**
 * KST(Asia/Seoul) 기준 날짜 키 "YYYY-MM-DD"
 * 로컬 TZ / UTC 자정 어긋남 방지용 유틸리티
 */
function getKstDateKey(date = getNow()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function formatKST(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function formatKrw(value) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function createAppError(code, message, status = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function loadDailyRecords() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn("dailyRecords 읽기 실패:", error);
    return [];
  }
}

function saveDailyRecords(records) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

/** 최신 날짜 키 우선 정렬 */
function getSortedDailyRecords() {
  return [...loadDailyRecords()].sort((a, b) =>
    String(b.dateKey).localeCompare(String(a.dateKey))
  );
}

function getNormalizedValue(record) {
  if (typeof record?.normalizedValue === "number") return record.normalizedValue;
  if (typeof record?.price === "number") return record.price;
  return null;
}

/**
 * T04-C24: (오늘 정규화 값) - (어제/이전 정규화 값)
 */
function renderDayOverDayChange() {
  const sorted = getSortedDailyRecords();
  const el = els.dayChange;
  el.className = "quote-card__change";

  if (sorted.length < 2) {
    el.textContent = "이전 기록이 없어 비교할 수 없습니다";
    el.classList.add("quote-card__change--empty");
    return;
  }

  const latest = getNormalizedValue(sorted[0]);
  const previous = getNormalizedValue(sorted[1]);

  if (latest == null || previous == null) {
    el.textContent = "이전 기록이 없어 비교할 수 없습니다";
    el.classList.add("quote-card__change--empty");
    return;
  }

  const diff = latest - previous;

  if (diff > 0) {
    el.textContent = `어제 대비 변화: + ${formatKrw(diff)} KRW (상승)`;
    el.classList.add("quote-card__change--up");
  } else if (diff < 0) {
    el.textContent = `어제 대비 변화: - ${formatKrw(Math.abs(diff))} KRW (하락)`;
    el.classList.add("quote-card__change--down");
  } else {
    el.textContent = "어제 대비 변화: 변동 없음";
    el.classList.add("quote-card__change--flat");
  }
}

/**
 * T04-C20: 같은 YYYY-MM-DD면 덮어쓰기(오늘 1건)
 * T04-C21: 새 날짜면 맨 앞 unshift
 */
function upsertDailyRecord(entry) {
  const records = loadDailyRecords();
  const index = records.findIndex((item) => item.dateKey === entry.dateKey);

  if (index >= 0) {
    records[index] = { ...records[index], ...entry };
  } else {
    records.unshift(entry);
  }

  saveDailyRecords(records);
  return records;
}

function updateClockLabel() {
  const key = getKstDateKey(getNow());
  const mode = state.mockNowMs == null ? "실시간" : "합성";
  els.clockLabel.textContent = `합성 시계: ${mode} · 키 ${key}`;
}

function renderDailyHistory() {
  const records = loadDailyRecords();
  els.historyList.innerHTML = "";

  if (records.length === 0) {
    const empty = document.createElement("li");
    empty.className = "history-panel__empty";
    empty.textContent = "아직 저장된 일별 기록이 없습니다. API 조회 성공 시 여기에 쌓입니다.";
    els.historyList.appendChild(empty);
    return;
  }

  getSortedDailyRecords().forEach((record) => {
    const li = document.createElement("li");
    li.className = "history-panel__item";

    const dateEl = document.createElement("span");
    dateEl.className = "history-panel__date";
    dateEl.textContent = record.dateKey;

    const dataEl = document.createElement("p");
    dataEl.className = "history-panel__data";
    const normalized = getNormalizedValue(record);
    dataEl.textContent = [
      `${record.displayPrice ?? formatKrw(normalized ?? 0)} ${record.unit ?? "KRW"}`,
      `정규화: ${normalized ?? "—"}`,
      record.sourceObservedAt != null
        ? `원천 관측: ${formatKST(new Date(record.sourceObservedAt * 1000))}`
        : record.sourceUpdated,
      record.sourceUrl ? `URL: ${record.sourceUrl}` : null,
      record.fetchedAt,
    ]
      .filter(Boolean)
      .join(" · ");

    li.append(dateEl, dataEl);
    els.historyList.appendChild(li);
  });
}

function setLoading(isLoading) {
  state.loading = isLoading;
  els.card.setAttribute("aria-busy", String(isLoading));
  [
    els.refreshBtn,
    els.retryBtn,
    els.mockClearBtn,
    els.clockSameDayBtn,
    els.clockNextDayBtn,
    els.clockResetBtn,
    ...els.mockButtons,
  ].forEach((btn) => {
    if (btn) btn.disabled = isLoading;
  });
}

function syncMockButtonUI() {
  els.mockButtons.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.mock === state.activeMock);
  });
}

function renderStateLabels() {
  els.freshnessLabel.textContent = `${state.freshness} · error: ${state.errorCode}`;
  const showStale = state.freshness === "stale" && state.lastGood;
  els.staleBadge.hidden = !showStale;
  els.card.classList.toggle("is-stale", showStale);

  const showError = state.errorCode !== "none";
  els.errorPanel.hidden = !showError;
  els.retryBtn.hidden = !showError;

  if (showError) {
    const guide = ERROR_GUIDE[state.errorCode] ?? ERROR_GUIDE.unknown;
    els.errorTitle.textContent = guide.title;
    els.errorAction.textContent = guide.action;
  }
}

function renderLastGoodIfAny() {
  if (!state.lastGood) return;

  const g = state.lastGood;
  els.price.textContent = g.displayPrice;
  els.unit.textContent = g.displayUnit;
  els.source.textContent = g.displaySource;
  els.sourceUpdated.textContent = g.displaySourceUpdated;
  els.fetchedAt.textContent = g.displayFetchedAt;
  els.timezone.textContent = g.displayTimezone;
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("is-error", isError);
}

/**
 * 조회 성공 시 UI 반영 + dailyRecords 저장
 */
function applySuccessfulQuote({ parsedPrice, parsedLastUpdatedAt, fetchedAtDate, rawJson = null }) {
  const sourceUpdatedDate = new Date(parsedLastUpdatedAt * 1000);

  const displayPrice = formatKrw(parsedPrice);
  const displayUnit = "KRW";
  const displaySource = "출처: CoinGecko API";
  const displaySourceUpdated = `업데이트: ${formatKST(sourceUpdatedDate)}`;
  const displayFetchedAt = `조회: ${formatKST(fetchedAtDate)}`;
  const displayTimezone = "KST (한국 표준시)";
  const dateKey = getKstDateKey(fetchedAtDate);

  if (rawJson) {
    console.log("=== 오늘의 진짜 정보판 · 데이터 검증 (T04-C10) ===");
    console.log("1. API 원본 응답 (Raw JSON):", rawJson);
    console.log("2. 파싱하여 변수에 저장한 값:", {
      parsedPrice,
      parsedLastUpdatedAt,
      fetchedAtDate: fetchedAtDate.toISOString(),
      dateKey,
    });
    console.log("3. 화면에 렌더링할 최종 텍스트 값:", {
      displayPrice,
      displayUnit,
      displaySource,
      displaySourceUpdated,
      displayFetchedAt,
      displayTimezone,
    });
  }

  state.lastGood = {
    displayPrice,
    displayUnit,
    displaySource,
    displaySourceUpdated,
    displayFetchedAt,
    displayTimezone,
    parsedPrice,
    parsedLastUpdatedAt,
  };

  state.freshness = "fresh";
  state.errorCode = "none";
  state.activeMock = null;
  syncMockButtonUI();

  // T04-C23: 출처 URL · 원천 관측 시각 · 정규화 값 · 단위 포함 저장
  upsertDailyRecord({
    dateKey,
    sourceUrl: API_URL,
    sourceObservedAt: parsedLastUpdatedAt,
    normalizedValue: parsedPrice,
    unit: displayUnit,
    // 화면/호환용 부가 필드
    price: parsedPrice,
    displayPrice,
    source: displaySource,
    sourceUpdated: displaySourceUpdated,
    fetchedAt: displayFetchedAt,
    timezone: displayTimezone,
    lastUpdatedAt: parsedLastUpdatedAt,
  });

  renderLastGoodIfAny();
  renderStateLabels();
  renderDailyHistory();
  renderDayOverDayChange();
  updateClockLabel();
}

async function runMockScenario(mockType) {
  switch (mockType) {
    case "timeout": {
      await new Promise((_, reject) => {
        setTimeout(() => {
          reject(
            createAppError(
              "timeout",
              `요청이 ${MOCK_TIMEOUT_MS}ms 내에 완료되지 않아 시간 초과되었습니다.`
            )
          );
        }, MOCK_TIMEOUT_MS);
      });
      break;
    }
    case "auth": {
      const status = Math.random() < 0.5 ? 401 : 403;
      throw createAppError("auth", `HTTP ${status} Unauthorized/Forbidden`, status);
    }
    case "rate_limit": {
      throw createAppError("rate_limit", "HTTP 429 Too Many Requests", 429);
    }
    case "offline": {
      const simulatedOnline = false;
      if (!simulatedOnline || !navigator.onLine) {
        throw createAppError(
          "offline",
          "NetworkError: 오프라인 상태로 모사된 네트워크 끊김"
        );
      }
      break;
    }
    case "schema": {
      return {
        bitcoin: {
          market: "synthetic",
          note: "schema-changed-mock",
        },
      };
    }
    default:
      throw createAppError("unknown", `알 수 없는 Mock 유형: ${mockType}`);
  }
}

function parseBitcoinPayload(rawJson) {
  const parsedPrice = rawJson?.bitcoin?.krw;
  const parsedLastUpdatedAt = rawJson?.bitcoin?.last_updated_at;

  if (typeof parsedPrice !== "number" || typeof parsedLastUpdatedAt !== "number") {
    throw createAppError(
      "schema",
      "응답 스키마 검사 실패: bitcoin.krw 또는 last_updated_at 없음"
    );
  }

  return { parsedPrice, parsedLastUpdatedAt };
}

function classifyError(error) {
  if (error?.code && ERROR_GUIDE[error.code]) return error.code;
  if (typeof error?.status === "number") {
    if (error.status === 401 || error.status === 403) return "auth";
    if (error.status === 429) return "rate_limit";
  }
  if (typeof error?.message === "string") {
    if (/failed to fetch|networkerror|offline/i.test(error.message)) return "offline";
    if (/abort|timeout|초과/i.test(error.message)) return "timeout";
  }
  return "unknown";
}

async function fetchBitcoinPrice({ recover = false } = {}) {
  if (recover) {
    state.activeMock = null;
    syncMockButtonUI();
  }

  setLoading(true);
  setStatus(
    state.activeMock
      ? `합성 시험 실행 중… (${state.activeMock})`
      : "가격을 불러오는 중…"
  );

  try {
    let rawJson;

    if (state.activeMock) {
      rawJson = await runMockScenario(state.activeMock);
    } else {
      // API Key 노출 방지 과제(T04-C11) 충족을 위해 비밀키가 필요 없는 Public API 사용
      const response = await fetch(API_URL);

      if (!response.ok) {
        const code =
          response.status === 401 || response.status === 403
            ? "auth"
            : response.status === 429
              ? "rate_limit"
              : "unknown";
        throw createAppError(
          code,
          `HTTP ${response.status} ${response.statusText}`,
          response.status
        );
      }

      rawJson = await response.json();
    }

    const fetchedAtDate = getNow();
    const { parsedPrice, parsedLastUpdatedAt } = parseBitcoinPayload(rawJson);

    applySuccessfulQuote({
      parsedPrice,
      parsedLastUpdatedAt,
      fetchedAtDate,
      rawJson,
    });

    setStatus("실시간 시세 반영 완료");
  } catch (error) {
    console.error("BTC 가격 조회 실패:", error);

    const code = classifyError(error);
    state.errorCode = code;

    if (state.lastGood) {
      state.freshness = "stale";
      renderLastGoodIfAny();
    } else {
      state.freshness = "empty";
    }

    renderStateLabels();
    const guide = ERROR_GUIDE[code] ?? ERROR_GUIDE.unknown;
    setStatus(`${guide.title} · 다시 시도할 수 있습니다.`, true);
  } finally {
    setLoading(false);
  }
}

/** 합성 시계: 같은 KST 날짜로 성공 저장 3회 → 오늘 1건만 남아야 함 */
function runSameDayTripleTest() {
  const dateKeyBefore = getKstDateKey(getNow());
  const base = state.lastGood?.parsedPrice ?? 100_000_000;

  for (let i = 1; i <= 3; i += 1) {
    const fetchedAtDate = getNow();
    applySuccessfulQuote({
      parsedPrice: base + i * 1_000,
      parsedLastUpdatedAt: Math.floor(fetchedAtDate.getTime() / 1000),
      fetchedAtDate,
    });
  }

  const todayCount = loadDailyRecords().filter((r) => r.dateKey === dateKeyBefore).length;
  const latest = loadDailyRecords().find((r) => r.dateKey === dateKeyBefore);

  console.log("=== 합성 시계 · 같은 날 3회 (T04-C20) ===", {
    dateKey: dateKeyBefore,
    todayCount,
    latestPrice: latest?.price,
  });

  setStatus(
    `합성 시계: 같은 날(${dateKeyBefore}) 3회 실행 → 오늘 기록 ${todayCount}건 (기대 1건), 최신 ${latest?.displayPrice} KRW`
  );
}

/** 합성 시계: KST 다음 날짜로 1회 저장 → 맨 앞 새 건 */
function runNextDayOnceTest() {
  const prevKey = getKstDateKey(getNow());
  state.mockNowMs = getNow().getTime() + MS_PER_DAY;
  updateClockLabel();

  const fetchedAtDate = getNow();
  const nextKey = getKstDateKey(fetchedAtDate);
  const base = state.lastGood?.parsedPrice ?? 100_000_000;

  applySuccessfulQuote({
    parsedPrice: base + 50_000,
    parsedLastUpdatedAt: Math.floor(fetchedAtDate.getTime() / 1000),
    fetchedAtDate,
  });

  const records = loadDailyRecords();
  console.log("=== 합성 시계 · 다음 날 1회 (T04-C21) ===", {
    prevKey,
    nextKey,
    head: records[0],
  });

  setStatus(
    `합성 시계: ${prevKey} → ${nextKey} 새 건 추가 · 목록 맨 앞 ${records[0]?.dateKey} / ${records[0]?.displayPrice} KRW`
  );
}

function resetMockClock() {
  state.mockNowMs = null;
  updateClockLabel();
  setStatus(`합성 시계 초기화 · 현재 KST 키 ${getKstDateKey()}`);
}

els.refreshBtn.addEventListener("click", () => {
  fetchBitcoinPrice({ recover: !state.activeMock && state.errorCode !== "none" });
});

els.retryBtn.addEventListener("click", () => {
  fetchBitcoinPrice({ recover: true });
});

els.mockClearBtn.addEventListener("click", () => {
  fetchBitcoinPrice({ recover: true });
});

els.mockButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    state.activeMock = btn.dataset.mock;
    syncMockButtonUI();
    fetchBitcoinPrice();
  });
});

els.clockSameDayBtn.addEventListener("click", runSameDayTripleTest);
els.clockNextDayBtn.addEventListener("click", runNextDayOnceTest);
els.clockResetBtn.addEventListener("click", resetMockClock);

syncMockButtonUI();
renderStateLabels();
updateClockLabel();
renderDailyHistory();
renderDayOverDayChange();
fetchBitcoinPrice();

/* hdnews 프론트엔드 — 의존성 없는 순수 JS SPA (3탭: 유통 핫이슈 / 홈쇼핑 이슈 / 스크랩) */
(function () {
  "use strict";

  const BOOKMARK_KEY = "hdnews.bookmarks";
  const THEME_KEY = "hdnews.theme";

  const state = {
    articles: [],
    trending: { keywords: [] },
    briefing: null,
    config: { companies: [], riskCategories: [] },
    activeTab: "retail",
    selectedCompanies: new Set(),
    selectedRetailCos: new Set(),
    selectedTypes: new Set(),   // 유형 필터 (일반 + 리스크 카테고리)
    query: "",
    coScope: "main",     // main(제목에 회사명 = 주체 기사) | all(본문 언급 포함)
    sortOrder: "latest", // latest | risk
    periodDays: null,    // null=전체, 1/3/7=최근 N일
    periodFrom: "",      // 직접 기간 (YYYY-MM-DD)
    periodTo: "",
    bookmarks: loadBookmarks(),
  };

  const $main = document.getElementById("main");
  const $search = document.getElementById("searchInput");
  const $updatedAt = document.getElementById("updatedAt");

  /* ---------------- 초기화 ---------------- */

  initTheme();
  updateScrapCount();

  Promise.all([
    fetchJson("data/articles.json"),
    fetchJson("data/trending.json"),
    fetchJson("data/briefing.json"),
    fetchJson("config/keywords.json"),
    fetchJson("data/hsdash.json"),   // 회사 대시보드(hdhs 연동) — 없어도 동작
  ]).then(([articles, trending, briefing, config, hsdash]) => {
    state.hsdash = hsdash;
    state.articles = (articles && articles.articles) || [];
    state.trending = trending || { keywords: [] };
    state.briefing = briefing;
    state.config = config || state.config;
    if (articles && articles.generatedAt) {
      $updatedAt.textContent = "마지막 업데이트 " + formatRelative(articles.generatedAt);
      $updatedAt.title = articles.generatedAt;
    }
    renderSideStats();
    route();
  }).catch(() => {
    $main.innerHTML = '<div class="empty-state">데이터를 불러오지 못했습니다.<br>수집 워크플로가 아직 실행되지 않았을 수 있습니다.</div>';
  });

  window.addEventListener("hashchange", route);
  $search.addEventListener("input", () => {
    state.query = $search.value.trim();
    updateSearchClear();
    render();
  });
  document.getElementById("themeToggle").addEventListener("click", toggleTheme);
  document.getElementById("searchClear").addEventListener("click", clearSearch);
  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("modalBackdrop").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  function clearSearch() {
    $search.value = "";
    state.query = "";
    updateSearchClear();
    render();
  }

  function updateSearchClear() {
    document.getElementById("searchClear").hidden = !state.query;
  }

  function fetchJson(path) {
    return fetch(path, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }

  /* ---------------- 라우팅 ---------------- */

  function route() {
    const tab = (location.hash.replace(/^#\//, "") || "retail");
    const valid = ["retail", "homeshopping", "scrap"];
    // 구버전 해시(#/dashboard, #/risk, #/policy, #/ecommerce)는 유통 핫이슈로
    state.activeTab = valid.includes(tab) ? tab : "retail";
    document.querySelectorAll("a[data-tab]").forEach((a) => {
      a.classList.toggle("active", a.dataset.tab === state.activeTab);
    });
    render();
  }

  /* ---------------- 필터 ---------------- */

  function filterArticles() {
    let arts;
    if (state.activeTab === "scrap") {
      arts = Object.values(state.bookmarks);
    } else if (state.activeTab === "homeshopping") {
      arts = state.articles.filter((a) => a.tabs && a.tabs.includes("homeshopping"));
    } else {
      // 유통 피드: 노이즈(연예 등) 제외 — 검색 시에는 전체에서 찾기
      arts = state.query ? state.articles : state.articles.filter((a) => !a.noise);
      if (state.selectedRetailCos.size) {
        arts = arts.filter((a) => a.rcompanies && a.rcompanies.some((c) => state.selectedRetailCos.has(c)));
      }
    }
    if (state.activeTab === "homeshopping") {
      if (state.selectedCompanies.size) {
        arts = arts.filter((a) => coIds(a).some((c) => state.selectedCompanies.has(c)));
      }
      if (state.selectedTypes.size) {
        arts = arts.filter((a) =>
          (a.riskCategories || []).some((c) => state.selectedTypes.has(c)) ||
          (a.categories || []).some((c) => state.selectedTypes.has(c)) ||
          (state.selectedTypes.has("etc") && isUntyped(a)));
      }
    }
    // 기간 필터 (직접 지정 우선, 없으면 최근 N일)
    if (state.periodFrom || state.periodTo) {
      arts = arts.filter((a) => {
        const d = (a.pubDate || "").slice(0, 10);
        if (!d) return false;
        if (state.periodFrom && d < state.periodFrom) return false;
        if (state.periodTo && d > state.periodTo) return false;
        return true;
      });
    } else if (state.periodDays) {
      const cutoff = Date.now() - state.periodDays * 24 * 3600 * 1000;
      arts = arts.filter((a) => a.pubDate && new Date(a.pubDate).getTime() >= cutoff);
    }
    if (state.query) {
      // 공백으로 나눈 모든 단어가 포함되면 매칭 (구절 키워드 대응)
      const parts = state.query.toLowerCase().split(/\s+/).filter(Boolean);
      arts = arts.filter((a) => {
        const text = (a.title + " " + (a.description || "")).toLowerCase();
        return parts.every((p) => text.includes(p));
      });
    }
    if (state.activeTab === "homeshopping") {
      if (state.sortOrder === "risk") {
        arts = arts.slice().sort((x, y) => (y.riskScore - x.riskScore) || cmpDate(x, y));
      } else if (state.sortOrder === "heat") {
        arts = arts.slice().sort((x, y) =>
          ((y.heat || 1) + (y.riskScore || 0)) - ((x.heat || 1) + (x.riskScore || 0)) || cmpDate(x, y));
      } else if (state.sortOrder === "oldest") {
        arts = arts.slice().sort((x, y) => cmpDate(y, x));
      }
    }
    return arts;
  }

  // 슬라이서 기준 회사 목록: 주체(제목 등장) 또는 언급 포함.
  // mainCompanies가 없는 예전 기사(스크랩 등)는 전체 매칭으로 대체
  function coIds(a) {
    if (state.coScope === "all") return a.companies || [];
    return a.mainCompanies || a.companies || [];
  }

  function isUntyped(a) {
    return !(a.categories || []).length && !(a.riskCategories || []).length;
  }

  function cmpDate(x, y) {
    return (y.pubDate || "").localeCompare(x.pubDate || "");
  }

  /* ---------------- 렌더 ---------------- */

  function render() {
    let html = "";
    const searching = !!state.query;
    if (state.activeTab === "retail" && !searching) {
      html += renderTrendingStrip(state.trending.keywords, "📈 급상승 키워드", 12);
      html += renderHotSection("hotRetail", "🔥 오늘의 유통 핫이슈 TOP 10");
      html += '<div class="dash-section-title">🕐 최신 기사</div>';
      html += renderRetailCoSlicer();
      html += renderFilterBar(true);
    }
    if (state.activeTab === "homeshopping") {
      if (!searching) {
        html += renderTrendingStrip(state.trending.hsKeywords || [], "🔑 홈쇼핑 핫이슈 키워드 TOP 10", 10);
        html += renderHotCompact("hotHomeshopping", "🔥 오늘의 홈쇼핑 핫이슈 TOP 10");
        html += renderCompanyToday();
      }
      html += '<div class="dash-section-title" id="hsFeed">📚 회사별 기사 모음</div>';
      html += renderSlicers();
      if (state.selectedCompanies.size === 1 && !searching) {
        html += renderCompanyDash([...state.selectedCompanies][0]);
      }
      html += renderFilterBar();
    }
    html += renderArticleList(filterArticles());
    $main.innerHTML = html;
    bindArticleEvents();
    bindChipEvents();
    bindPeriodInputs();
    bindBarSearch();
    restoreBarSearchFocus();
    document.querySelectorAll(".trend-chip").forEach((el) => {
      el.addEventListener("click", () => openKeywordModal(el.dataset.kw));
    });
    const companyToday = document.getElementById("companyToday");
    if (companyToday) {
      companyToday.addEventListener("toggle", () => {
        try { localStorage.setItem("hdnews.companyOpen", companyToday.open ? "1" : "0"); } catch (e) { /* 무시 */ }
      });
    }
    document.querySelectorAll(".company-bar-row[data-co]").forEach((el) => {
      el.addEventListener("click", () => {
        state.selectedCompanies = new Set([el.dataset.co]);
        render();
        const feed = document.getElementById("hsFeed");
        if (feed) feed.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  /* ----- 급상승 키워드 스트립 (유통 전체 / 홈쇼핑 전용) ----- */

  function renderTrendingStrip(keywords, title, topN) {
    if (!keywords || !keywords.length) return "";
    let html = `<div class="dash-section-title">${title}</div><div class="trend-list">`;
    html += keywords.slice(0, topN).map((k, i) =>
      `<span class="trend-chip" data-kw="${escapeAttr(k.keyword)}"><span class="rank">${i + 1}</span>${escapeHtml(k.keyword)}<span class="cnt">${k.count}건</span></span>`
    ).join("");
    return html + "</div>";
  }

  /* ----- 사이드바 하단 요약 통계 ----- */

  function renderSideStats() {
    const el = document.getElementById("sideStats");
    const b = state.briefing && state.briefing.daily;
    if (!el || !b) return;
    const riskCnt = (b.byTab && b.byTab.risk) || 0;
    const hsCnt = (b.byTab && b.byTab.homeshopping) || 0;
    const weekly = state.briefing.weekly ? state.briefing.weekly.total : "-";
    el.innerHTML = `
      <div class="side-stat"><span class="stat-dot pink"></span><span class="stat-label">오늘 수집</span><b>${b.total}</b></div>
      <div class="side-stat"><span class="stat-dot purple"></span><span class="stat-label">홈쇼핑 기사</span><b>${hsCnt}</b></div>
      <div class="side-stat"><span class="stat-dot orange"></span><span class="stat-label">리스크 기사</span><b class="risk">${riskCnt}</b></div>
      <div class="side-stat"><span class="stat-dot sky"></span><span class="stat-label">주간 누적</span><b>${weekly}</b></div>`;
  }

  /* ----- 홈쇼핑 TOP 10: 한 줄 뉴스 리스트 ----- */

  function renderHotCompact(key, title) {
    const ids = (state.briefing && state.briefing[key]) || [];
    const arts = ids.map((id) => state.articles.find((a) => a.id === id)).filter(Boolean);
    if (!arts.length) return "";
    let html = `<div class="dash-section-title">${title}</div><div class="hot-compact">`;
    html += arts.map((a, i) => {
      const url = a.link || a.originallink || "#";
      const press = a.press || pressFromUrl(a.originallink || a.link);
      const heat = a.heat > 1 ? `<span class="meta-chip heat">보도 ${a.heat}건</span>` : "";
      const riskDot = a.riskScore >= 1 ? '<span class="hot-risk-dot" title="리스크 기사"></span>' : "";
      return `<a class="hot-row" href="${escapeAttr(url)}" target="_blank" rel="noopener">
        <span class="hot-rank">${String(i + 1).padStart(2, "0")}</span>
        <span class="hot-title">${riskDot}${escapeHtml(a.title)}</span>
        <span class="hot-meta">${press ? escapeHtml(press) + " · " : ""}${formatDate(a.pubDate)}</span>
        ${heat}
      </a>`;
    }).join("");
    return html + "</div>";
  }

  /* ----- 핫이슈 TOP 10 랭킹 ----- */

  function renderHotSection(key, title) {
    const ids = (state.briefing && state.briefing[key]) || [];
    const arts = ids.map((id) => state.articles.find((a) => a.id === id)).filter(Boolean);
    if (!arts.length) return "";
    let html = `<div class="dash-section-title">${title}</div><div class="article-list hot-list">`;
    html += arts.map((a, i) => renderCard(a, i + 1)).join("");
    return html + "</div>";
  }

  /* ----- 홈쇼핑 이슈: 회사별 오늘 기사 요약 (클릭 시 해당 회사 피드로 이동) ----- */

  function renderCompanyToday() {
    const b = state.briefing && state.briefing.weekly;
    if (!b) return "";
    const byCo = b.byCompany || {};
    const riskByCo = b.riskByCompany || {};
    const mentionByCo = b.mentionByCompany || {};
    const max = Math.max(1, ...Object.values(byCo));
    const open = localStorage.getItem("hdnews.companyOpen") !== "0";
    const end = state.briefing.generatedAt ? new Date(state.briefing.generatedAt) : new Date();
    const start = new Date(end.getTime() - 6 * 24 * 3600 * 1000);
    const ymd = (d) => `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
    let html = `<details class="company-summary" id="companyToday"${open ? " open" : ""}>
      <summary class="dash-section-title">🏢 회사별 최근 기사 (7일, ${ymd(start)}~${ymd(end)})</summary><div class="company-bars">`;
    state.config.companies.forEach((c) => {
      const n = byCo[c.id] || 0;
      const w = Math.round((n / max) * 100);
      const m = mentionByCo[c.id] || 0;
      html += `<div class="company-bar-row" data-co="${c.id}" title="${c.name} 기사 보기">
        <span class="name">${c.name}</span>
        <span class="bar" style="width:${w * 0.6}%;background:${escapeAttr(c.color || "")}"></span><span>${n}</span>
        ${m ? `<span class="mention-mark" title="본문에만 언급된 기사">+언급 ${m}</span>` : ""}
        ${riskByCo[c.id] ? `<span class="risk-mark">⚠ ${riskByCo[c.id]}</span>` : ""}</div>`;
    });
    return html + "</div></details>";
  }

  /* ----- 필터 바 / 슬라이서 ----- */

  function renderPeriodControls() {
    const pd = state.periodDays, custom = !!(state.periodFrom || state.periodTo);
    return `<span class="filter-label">기간</span>
      ${chip("pd:all", "전체", !pd && !custom, "")}
      ${chip("pd:1", "오늘", pd === 1 && !custom, "")}
      ${chip("pd:3", "3일", pd === 3 && !custom, "")}
      ${chip("pd:7", "7일", pd === 7 && !custom, "")}
      <span class="date-range${custom ? " active" : ""}">
        <input type="date" id="fromDate" value="${state.periodFrom}"> ~
        <input type="date" id="toDate" value="${state.periodTo}">
      </span>`;
  }

  function renderFilterBar(periodOnly) {
    if (periodOnly) {
      return `<div class="filter-bar">${renderPeriodControls()}</div>`;
    }
    const so = state.sortOrder;
    return `<div class="filter-bar">
      <input type="search" id="barSearch" class="bar-search" placeholder="키워드 검색" value="${escapeAttr(state.query)}">
      <span class="filter-sep"></span>
      <span class="filter-label">정렬</span>
      ${chip("so:latest", "최신순", so === "latest", "")}
      ${chip("so:oldest", "오래된순", so === "oldest", "")}
      ${chip("so:heat", "화제순", so === "heat", "")}
      ${chip("so:risk", "리스크순", so === "risk", "")}
      <span class="filter-sep"></span>
      ${renderPeriodControls()}
    </div>`;
  }

  function bindBarSearch() {
    const el = document.getElementById("barSearch");
    if (!el) return;
    el.addEventListener("input", () => {
      state.query = el.value.trim();
      $search.value = el.value;
      updateSearchClear();
      barSearchFocus = true;
      render();
    });
  }

  let barSearchFocus = false;

  function restoreBarSearchFocus() {
    if (!barSearchFocus) return;
    barSearchFocus = false;
    const el = document.getElementById("barSearch");
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }

  function bindPeriodInputs() {
    ["fromDate", "toDate"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("change", () => {
        state.periodFrom = document.getElementById("fromDate").value;
        state.periodTo = document.getElementById("toDate").value;
        state.periodDays = null;
        render();
      });
    });
  }


  // 유통 NEWS: 유통기업 슬라이서 (작은 칩)
  function renderRetailCoSlicer() {
    const cos = state.config.retailCompanies || [];
    if (!cos.length) return "";
    let html = '<div class="chip-row chip-row-sm">';
    html += chip("rco-all", "전체", !state.selectedRetailCos.size, "");
    cos.forEach((c) => {
      html += chip("rco:" + c.id, c.name, state.selectedRetailCos.has(c.id), "");
    });
    return html + "</div>";
  }

  // 홈쇼핑 NEWS 슬라이서 — hdhs 홈쇼핑 탭과 같은 약칭·순서·색상(HD GS CJ LT | 기타사)
  function renderSlicers() {
    const recentRisk = companyRiskSet();
    const hsArts = state.articles.filter((a) => a.tabs && a.tabs.includes("homeshopping"));
    const cos = state.config.companies;
    const coBtn = (c) => {
      const cnt = hsArts.filter((a) => coIds(a).includes(c.id)).length;
      const active = state.selectedCompanies.has(c.id);
      const style = c.color ? ` style="--co:${escapeAttr(c.color)}"` : "";
      const extra = `<span class="cnt">${cnt}</span>` +
        (recentRisk.has(c.id) ? '<span class="risk-dot" title="최근 48시간 내 리스크 기사"></span>' : "");
      return `<button class="seg-btn co-btn${active ? " active" : ""}${cnt ? "" : " empty"}" data-chip="co:${c.id}"${style} title="${escapeAttr(c.name)} (Ctrl/⌘+클릭: 여러 사 선택)">${escapeHtml(c.short || c.name)}${extra}</button>`;
    };
    let html = '<div class="slicer-row"><div class="seg-slicer" role="group" aria-label="홈쇼핑사">';
    html += segBtn("co-all", "전체", !state.selectedCompanies.size);
    html += '<span class="seg-sep"></span>';
    html += cos.filter((c) => c.group === "main").map(coBtn).join("");
    html += '<span class="seg-sep"></span>';
    html += cos.filter((c) => c.group !== "main").map(coBtn).join("");
    html += "</div>";
    html += '<div class="seg-slicer seg-scope" role="group" aria-label="회사 매칭 범위">';
    html += segBtn("cs:main", "주요 기사", state.coScope === "main", "제목에 회사명이 나온 기사");
    html += segBtn("cs:all", "언급 포함", state.coScope === "all", "본문에만 회사명이 나온 기사까지");
    html += "</div></div>";

    const t = state.selectedTypes;
    html += '<div class="seg-slicer seg-types" role="group" aria-label="기사 유형">';
    html += segBtn("tp-all", "전체 유형", !t.size);
    html += '<span class="seg-sep"></span>';
    (state.config.generalCategories || []).forEach((gc) => {
      html += segBtn("tp:" + gc.id, gc.name, t.has(gc.id));
    });
    html += segBtn("tp:etc", "기타", t.has("etc"), "어떤 유형에도 해당하지 않는 기사");
    html += '<span class="seg-sep"></span>';
    state.config.riskCategories.forEach((rc) => {
      html += `<button class="seg-btn risk${t.has(rc.id) ? " active" : ""}" data-chip="tp:${rc.id}">⚠ ${escapeHtml(rc.name)}</button>`;
    });
    return html + "</div>";
  }

  function segBtn(key, label, active, title) {
    return `<button class="seg-btn${active ? " active" : ""}" data-chip="${key}"${title ? ` title="${escapeAttr(title)}"` : ""}>${escapeHtml(label)}</button>`;
  }

  function chip(key, label, active, extra) {
    return `<span class="chip${active ? " active" : ""}" data-chip="${key}">${label}${extra}</span>`;
  }

  function companyRiskSet() {
    const cutoff = Date.now() - 48 * 3600 * 1000;
    const set = new Set();
    state.articles.forEach((a) => {
      if (a.riskScore >= 1 && a.pubDate && new Date(a.pubDate).getTime() >= cutoff) {
        coIds(a).forEach((c) => set.add(c));
      }
    });
    return set;
  }

  /* ----- 회사 대시보드 (슬라이서에서 한 회사 선택 시) ----- */
  // 기사 추이·점유율은 articles.json으로 직접 계산(항상 최신),
  // 편성·랭킹·카드할인·가격변동은 수집기가 hdhs에서 미리 합친 hsdash.json 사용

  const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
  const BC_LABEL = { live: "라이브", data: "데이터", plus: "플러스" };
  const PRICE_CHANGE_LABEL = {
    price_drop: "가격 인하", price_raise: "가격 인상", sold_out: "품절", restock: "재입고",
  };

  function renderCompanyDash(coId) {
    const co = state.config.companies.find((c) => c.id === coId);
    if (!co) return "";
    const color = escapeAttr(co.color || "var(--ink)");
    const dash = state.hsdash && state.hsdash.companies && state.hsdash.companies[coId];
    let html = `<section class="co-dash" style="--co:${color}">
      <div class="co-dash-head"><span class="co-dash-tag">${escapeHtml(co.short || co.name)}</span>
        <b>${escapeHtml(co.name)}</b> 한눈에 보기</div>`;
    html += renderDashKpis(coId, dash);
    if (!dash) {
      html += '<div class="co-dash-empty">편성·랭킹 데이터(hdhs 연동)가 아직 생성되지 않았습니다. 다음 수집 후 표시됩니다.</div>';
      return html + "</section>";
    }
    html += '<div class="co-dash-grid">';
    html += renderDashNewsLinks(dash, co);
    html += renderDashRanking(dash);
    html += renderDashCategories(dash);
    html += renderDashPromo(dash, co);
    html += "</div>";
    const src = state.hsdash.source || {};
    const week = src.rankingWeek ? ` · 랭킹 주간 ${src.rankingWeek[0]}~${src.rankingWeek[1]}` : "";
    html += `<div class="co-dash-foot">출처: hdhs 편성표·hsmoa 랭킹${week} · 연동 갱신 ${formatRelative(state.hsdash.generatedAt)}</div>`;
    return html + "</section>";
  }

  function renderDashKpis(coId, dash) {
    const hsArts = state.articles.filter((a) => a.tabs && a.tabs.includes("homeshopping"));
    const end = new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(ymdLocal(new Date(end.getTime() - i * 864e5)));
    const perDay = Object.fromEntries(days.map((d) => [d, 0]));
    let main = 0, mention = 0, risk = 0;
    const byCo = {};
    hsArts.forEach((a) => {
      const d = a.pubDate ? ymdLocal(new Date(a.pubDate)) : "";
      if (!(d in perDay)) return;
      const mains = a.mainCompanies || a.companies || [];
      mains.forEach((c) => { byCo[c] = (byCo[c] || 0) + 1; });
      if (mains.includes(coId)) {
        main++; perDay[d]++;
        if (a.riskScore >= 1) risk++;
      } else if ((a.companies || []).includes(coId)) mention++;
    });
    const total = Object.values(byCo).reduce((s, n) => s + n, 0);
    const share = total ? Math.round((main / total) * 1000) / 10 : 0;
    const rank = Object.values(byCo).filter((n) => n > main).length + 1;
    const max = Math.max(1, ...Object.values(perDay));
    const spark = days.map((d) => {
      const n = perDay[d];
      const h = n ? Math.max(3, Math.round((n / max) * 28)) : 1;
      const dt = new Date(d + "T00:00:00");
      return `<span class="spark-bar${n ? "" : " zero"}" style="height:${h}px" title="${d.slice(5).replace("-", ".")}(${WEEKDAY[dt.getDay()]}) 주요 기사 ${n}건"></span>`;
    }).join("");
    const airs = dash && dash.hsCode ? `${dash.todayAirs}<small>건</small>` : "–";
    return `<div class="co-kpis">
      <div class="co-kpi"><div class="label">7일 주요 기사</div>
        <div class="num">${main}<small>건</small></div>
        <div class="sub">${mention ? `+ 본문 언급 ${mention}건` : "&nbsp;"}</div>
        <div class="spark" aria-label="최근 7일 일자별 주요 기사 수">${spark}</div></div>
      <div class="co-kpi"><div class="label">보도 점유율 (7일)</div>
        <div class="num">${share}<small>%</small></div>
        <div class="sub">${main ? `12개사 중 ${rank}위` : "주요 기사 없음"}</div></div>
      <div class="co-kpi"><div class="label">리스크 기사 (7일)</div>
        <div class="num${risk ? " risk" : ""}">${risk}<small>건</small></div>
        <div class="sub">${risk ? '<span class="chip-link" data-chip="so:risk">리스크순 보기</span>' : "&nbsp;"}</div></div>
      <div class="co-kpi"><div class="label">오늘 편성</div>
        <div class="num">${airs}</div>
        <div class="sub">${dash && dash.hsCode ? "라이브+데이터 방송" : "편성 데이터 없음"}</div></div>
    </div>`;
  }

  function renderDashNewsLinks(dash, co) {
    const links = dash.newsLinks || [];
    let body;
    if (!dash.hsCode) body = '<div class="co-dash-empty">hdhs에 이 회사 편성 데이터가 없습니다.</div>';
    else if (!links.length) body = '<div class="co-dash-empty">최근 기사에 나온 브랜드 중 앞뒤 7일 편성된 브랜드가 없습니다.</div>';
    else {
      body = '<div class="nl-list">' + links.map((l) => {
        const art = state.articles.find((a) => a.id === l.articleId);
        const url = art ? (art.link || art.originallink) : "";
        const n = l.next || {};
        const when = n.date ? `${fmtMd(n.date)} ${escapeHtml(n.start || "")}` : "";
        // hsdash는 최대 2시간 전 생성이라 예정/지난 여부는 지금 시각으로 다시 판정
        const upcoming = n.date ? new Date(`${n.date}T${n.start || "00:00"}:00+09:00`) >= new Date() : l.isUpcoming;
        const airMeta = [n.price ? `${Number(n.price).toLocaleString()}원` : "", `앞뒤 7일 ${l.airCount}회 편성`]
          .filter(Boolean).join(" · ");
        const prod = escapeHtml(cleanProduct(n.product || ""));
        const prodHtml = n.link ? `<a href="${escapeAttr(n.link)}" target="_blank" rel="noopener">${prod}</a>` : prod;
        const title = escapeHtml(l.title);
        return `<div class="nl-row">
          <div class="nl-brand">${escapeHtml(l.brand)}
            <span class="nl-badge${upcoming ? " up" : ""}">${upcoming ? "방송 예정" : "지난 방송"}</span></div>
          <div class="nl-news">📰 ${url ? `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">${title}</a>` : title}
            <span class="nl-meta">${formatDate(l.pubDate)}${l.articleCount > 1 ? ` · 기사 ${l.articleCount}건` : ""}</span></div>
          <div class="nl-air">📺 <b>${when}</b> ${BC_LABEL[n.bc] && n.bc !== "live" ? `<span class="nl-bc">${BC_LABEL[n.bc]}</span>` : ""}${prodHtml}<span class="nl-meta">${airMeta}</span></div>
        </div>`;
      }).join("") + "</div>";
    }
    return `<div class="co-panel wide"><div class="co-panel-title">📺 뉴스에 나온 브랜드의 편성</div>${body}</div>`;
  }

  function renderDashRanking(dash) {
    const rk = dash.ranking || [];
    const body = rk.length
      ? '<ol class="rk-list">' + rk.map((r) => `<li>
          <span class="rk-pos" title="${escapeAttr(r.category)} 카테고리 순위">${escapeHtml(r.category === "전체" ? "전체" : r.category)} ${r.rank}위</span>
          <span class="rk-name" title="${escapeAttr(r.name)}">${r.inNews ? '<span class="rk-news" title="이 브랜드가 최근 기사에 등장">📰</span>' : ""}${escapeHtml(r.brand ? r.brand + " · " : "")}${escapeHtml(cleanProduct(r.name))}</span>
          <span class="rk-price">${r.price ? Number(r.price).toLocaleString() + "원" : ""}</span></li>`).join("") + "</ol>"
      : '<div class="co-dash-empty">이번 주 랭킹에 이 회사 상품이 없습니다.</div>';
    return `<div class="co-panel"><div class="co-panel-title">🏆 이번 주 인기 상품 <span class="co-panel-note">hsmoa 랭킹</span></div>${body}</div>`;
  }

  function renderDashCategories(dash) {
    const mix = dash.categoryMix || [];
    const body = mix.length
      ? '<div class="cat-bars">' + mix.map((m) => `<div class="cat-row" title="${escapeAttr(m.category)} ${Math.round(m.minutes / 60)}시간 (${m.share}%)">
          <span class="cat-name">${escapeHtml(m.category)}</span>
          <span class="cat-track"><span class="cat-fill" style="width:${Math.max(2, m.share)}%"></span></span>
          <span class="cat-val">${m.share}%</span></div>`).join("") + "</div>"
      : '<div class="co-dash-empty">편성 데이터가 없습니다.</div>';
    return `<div class="co-panel"><div class="co-panel-title">📊 편성 카테고리 비중 <span class="co-panel-note">최근 7일(오늘 포함) 라이브 방송시간 · hdhs 상품 분류</span></div>${body}</div>`;
  }

  function renderDashPromo(dash, co) {
    const cards = dash.cards;
    const pcs = dash.priceChanges || [];
    if (!cards && !pcs.length) return "";
    let body = "";
    if (cards && cards.days && cards.days.length) {
      body += '<div class="promo-sub">💳 카드할인 (오늘부터 7일)</div><div class="promo-days">' + cards.days.map((d) =>
        `<div class="promo-day"><span class="promo-date">${fmtMd(d.date)}</span>${d.cards.map((c) =>
          `<span class="promo-card">${escapeHtml(c.card)} ${c.rate}%${c.type && c.type !== "즉시할인" ? ` <small>${escapeHtml(c.type)}</small>` : ""}</span>`).join("")}</div>`).join("") + "</div>";
    } else if (cards) {
      body += '<div class="co-dash-empty">예정된 카드할인이 없습니다.</div>';
    }
    if (pcs.length) {
      body += '<div class="promo-sub">🏷️ 가격 변동 (최근 14일)</div><ul class="pc-list">' + pcs.map((p) => {
        const prev = p.prevPrice ? `${Number(p.prevPrice).toLocaleString()}→` : "";
        const price = p.price ? `${prev}${Number(p.price).toLocaleString()}원` : "";
        const name = escapeHtml((p.brand ? p.brand + " · " : "") + cleanProduct(p.name));
        return `<li><span class="pc-type ${p.type}">${PRICE_CHANGE_LABEL[p.type] || p.type}</span>
          ${p.link ? `<a href="${escapeAttr(p.link)}" target="_blank" rel="noopener">${name}</a>` : name}
          <span class="pc-meta">${price} · ${fmtMd(p.date)}</span></li>`;
      }).join("") + "</ul>";
    }
    return `<div class="co-panel"><div class="co-panel-title">💸 카드할인·가격 변동</div>${body}</div>`;
  }

  function ymdLocal(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function fmtMd(ymd) {
    const d = new Date(ymd + "T00:00:00");
    if (isNaN(d)) return escapeHtml(ymd || "");
    return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY[d.getDay()]})`;
  }

  // 편성 상품명 앞의 ○·[방송특가] 같은 장식 기호 제거
  function cleanProduct(s) {
    return String(s || "").replace(/^[^0-9A-Za-z가-힣\[(]+/, "").trim();
  }

  /* ----- 기사 리스트 / 카드 ----- */

  function renderArticleList(arts) {
    if (!arts.length) {
      const msg = state.activeTab === "scrap"
        ? "스크랩한 기사가 없습니다. 기사 카드의 ★을 눌러 저장하세요."
        : "조건에 맞는 기사가 없습니다.";
      return `<div class="empty-state">${msg}</div>`;
    }
    const items = arts.slice(0, 300).map((a) => renderCard(a)).join("");
    const more = arts.length > 300 ? `<div class="empty-state">외 ${arts.length - 300}건 — 검색으로 좁혀보세요.</div>` : "";
    return `<div class="article-list">${items}</div>${more}`;
  }

  function renderCard(a, rank) {
    const riskClass = a.riskScore >= 3 ? "risk-3" : a.riskScore === 2 ? "risk-2" : a.riskScore === 1 ? "risk-1" : "";
    // 주체 회사는 진하게, 본문에만 언급된 회사는 흐리게
    const mains = a.mainCompanies || a.companies || [];
    const companies = (a.companies || []).map((id) => {
      const c = state.config.companies.find((x) => x.id === id);
      if (!c) return "";
      return mains.includes(id)
        ? `<span class="meta-chip co">${c.name}</span>`
        : `<span class="meta-chip mention" title="본문 언급">${c.name} 언급</span>`;
    }).join("");
    const risks = (a.riskCategories || []).map((id) => {
      const rc = state.config.riskCategories.find((x) => x.id === id);
      return rc ? `<span class="meta-chip risk">${rc.name}</span>` : "";
    }).join("");
    const cats = (a.categories || []).slice(0, 2).map((id) => {
      const gc = (state.config.generalCategories || []).find((x) => x.id === id);
      return gc ? `<span class="meta-chip cat">${gc.name}</span>` : "";
    }).join("");
    const heat = a.heat > 1 ? `<span class="meta-chip heat">보도 ${a.heat}건</span>` : "";
    const marked = !!state.bookmarks[a.id];
    const url = a.link || a.originallink || "#";
    const press = a.press || pressFromUrl(a.originallink || a.link);
    const rankBadge = rank ? `<div class="rank-badge">${String(rank).padStart(2, "0")}<span class="rank-dot"></span></div>` : "";
    const thumb = a.image
      ? `<a class="thumb-wrap" href="${escapeAttr(url)}" target="_blank" rel="noopener"><img class="thumb" src="${escapeAttr(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.style.display='none'"></a>`
      : "";
    // 카드 순서: 랭킹 번호 → 사진 → 제목/본문
    return `<article class="article-card ${riskClass}${rank ? " ranked" : ""}">
      ${rankBadge}
      ${thumb}
      <div class="card-main">
        <div class="article-title"><a href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a></div>
        ${a.description ? `<div class="article-desc">${escapeHtml(a.description)}</div>` : ""}
        <div class="article-footer">
          ${press ? `<span class="press">${escapeHtml(press)}</span><span class="dot">·</span>` : ""}
          <span class="date" title="${escapeAttr(a.pubDate || "")}">${formatDate(a.pubDate)}</span>
          <span class="rel">(${formatRelative(a.pubDate)})</span>
          ${heat}${companies}${risks}${cats}
          <button class="bookmark-btn${marked ? " on" : ""}" data-id="${a.id}" title="스크랩">${marked ? "★" : "☆"}</button>
        </div>
      </div>
    </article>`;
  }

  // 수집기 press 백필 전 데이터 대비: 원문 도메인으로 즉석 판별
  function pressFromUrl(url) {
    if (!url) return "";
    try {
      let host = new URL(url).hostname.replace(/^(www|m|news|mnews|view|mobile)\./, "");
      if (host === "google.com" || host.endsWith(".google.com")) return "";
      return host === "n.news.naver.com" || host === "naver.com" ? "네이버뉴스" : host;
    } catch (e) {
      return "";
    }
  }

  /* ---------------- 모달 (키워드 팝업) ---------------- */

  let modalKeyword = "";

  function openKeywordModal(kw) {
    modalKeyword = kw;
    const parts = kw.split(/\s+/).filter(Boolean);
    const matched = state.articles.filter((a) => {
      const text = a.title + " " + (a.description || "");
      return parts.every((p) => text.includes(p));
    }).slice(0, 50);
    document.getElementById("modalTitle").textContent = `"${kw}" 관련 기사 ${matched.length}건`;
    document.getElementById("modalBody").innerHTML = matched.length
      ? `<div class="article-list">${matched.map((a) => renderCard(a)).join("")}</div>`
      : '<div class="empty-state">관련 기사가 없습니다.</div>';
    document.getElementById("modal").hidden = false;
    document.body.style.overflow = "hidden";
    bindArticleEvents(document.getElementById("modalBody"));
  }

  function closeModal() {
    document.getElementById("modal").hidden = true;
    document.body.style.overflow = "";
  }

  document.getElementById("modalGoTab").addEventListener("click", () => {
    closeModal();
    $search.value = modalKeyword;
    state.query = modalKeyword;
    updateSearchClear();
    location.hash = "#/retail";
    render();
  });

  /* ---------------- 이벤트 ---------------- */

  function bindChipEvents() {
    document.querySelectorAll(".chip, .seg-btn, .chip-link").forEach((el) => {
      el.addEventListener("click", (e) => {
        const key = el.dataset.chip;
        if (key === "co-all") state.selectedCompanies.clear();
        else if (key === "rco-all") state.selectedRetailCos.clear();
        else if (key.startsWith("rco:")) toggleSet(state.selectedRetailCos, key.slice(4));
        else if (key === "tp-all") state.selectedTypes.clear();
        else if (key.startsWith("co:")) {
          // hdhs 슬라이서처럼 한 회사만 선택, Ctrl/⌘+클릭은 다중 선택
          const id = key.slice(3);
          if (e.ctrlKey || e.metaKey) toggleSet(state.selectedCompanies, id);
          else if (state.selectedCompanies.size === 1 && state.selectedCompanies.has(id)) state.selectedCompanies.clear();
          else state.selectedCompanies = new Set([id]);
        }
        else if (key.startsWith("tp:")) toggleSet(state.selectedTypes, key.slice(3));
        else if (key.startsWith("cs:")) state.coScope = key.slice(3);
        else if (key.startsWith("so:")) state.sortOrder = key.slice(3);
        else if (key.startsWith("pd:")) {
          const v = key.slice(3);
          state.periodDays = v === "all" ? null : Number(v);
          state.periodFrom = "";
          state.periodTo = "";
        }
        render();
      });
    });
  }

  function toggleSet(set, v) {
    set.has(v) ? set.delete(v) : set.add(v);
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const now = new Date();
    const mmdd = `${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return d.getFullYear() === now.getFullYear() ? `${mmdd} ${hhmm}` : `${d.getFullYear()}.${mmdd}`;
  }

  function bindArticleEvents(root) {
    (root || $main).querySelectorAll(".bookmark-btn").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.id;
        if (state.bookmarks[id]) {
          delete state.bookmarks[id];
        } else {
          const art = state.articles.find((a) => a.id === id) || Object.values(state.bookmarks).find((a) => a.id === id);
          if (art) state.bookmarks[id] = art;
        }
        saveBookmarks();
        updateScrapCount();
        render();
        if (!document.getElementById("modal").hidden) openKeywordModal(modalKeyword);
      });
    });
  }

  /* ---------------- 북마크 ---------------- */

  function loadBookmarks() {
    try {
      return JSON.parse(localStorage.getItem(BOOKMARK_KEY)) || {};
    } catch (e) {
      return {};
    }
  }
  function saveBookmarks() {
    try {
      localStorage.setItem(BOOKMARK_KEY, JSON.stringify(state.bookmarks));
    } catch (e) { /* 저장 공간 초과 등 — 무시 */ }
  }
  function updateScrapCount() {
    const n = Object.keys(state.bookmarks).length;
    document.querySelectorAll(".scrap-count").forEach((el) => {
      el.textContent = n ? `(${n})` : "";
    });
  }

  /* ---------------- 테마 ---------------- */

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    const dark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(dark);
  }
  function toggleTheme() {
    applyTheme(document.documentElement.dataset.theme !== "dark");
  }
  function applyTheme(dark) {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.getElementById("themeToggle").textContent = dark ? "☀️" : "🌙";
    try { localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch (e) { /* 무시 */ }
  }

  /* ---------------- 포맷 ---------------- */

  function formatRelative(iso) {
    if (!iso) return "";
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return "방금 전";
    if (min < 60) return `${min}분 전`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}시간 전`;
    const day = Math.floor(hr / 24);
    if (day < 8) return `${day}일 전`;
    return iso.slice(0, 10);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }
})();

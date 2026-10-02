/* hdnews 프론트엔드 — 의존성 없는 순수 JS SPA
   화면: 홈 / 발견 / 이슈 타임라인 / 유통·홈쇼핑 피드 / 스크랩 / 회사.
   DOM 없이 계산되는 로직(새 기사 판정·배지·그룹핑·라우트 파싱)은 issues-core.js(HdCore) 에 있다. */
(function () {
  "use strict";

  const BOOKMARK_KEY = "hdnews.bookmarks";
  const THEME_KEY = "hdnews.theme";
  const FOLLOWS_KEY = "hdnews.follows";            // 이슈 팔로우 { [issueId]: { followedAt, seenLastAt, title } }
  const ISSUE_SEEN_KEY = "hdnews.issueSeen";       // 이슈 상세 마지막 열람 시각(ms)
  const SHORTCUT_SEEN_KEY = "hdnews.shortcutSeen"; // 바로가기 마지막 진입 시각(ms)
  const MY_COMPANY_KEY = "hdnews.myCompany";
  const RECENT_KEY = "hdnews.recent";              // 최근 본 기사 id (최대 20)
  const HdCore = window.HdCore;
  const ARTICLE_VIEWS = new Set(["retail", "homeshopping", "scrap", "company", "topic", "risk"]);  // 기사 목록을 그리는 화면

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
    brandExclude: new Set(),  // config/brand_exclude.json — 브랜드로 치지 않을 이름
    // --- 모바일 개편 (홈 / 이슈 타임라인 / 발견) ---
    view: "home",            // 현재 화면 (HdCore.parseHash 결과)
    routeParam: "",
    routeQuery: {},
    issues: [],              // data/issues.json — 72시간 같은 사건 묶음
    issuesMeta: null,
    shortcuts: [],           // config/shortcuts.json
    follows: loadJson(FOLLOWS_KEY, {}),
    issueSeen: loadJson(ISSUE_SEEN_KEY, {}),
    shortcutSeen: loadJson(SHORTCUT_SEEN_KEY, {}),
    myCompany: loadJson(MY_COMPANY_KEY, ""),
    recent: loadJson(RECENT_KEY, []),
    discoverCat: "all",
    issuesFilter: "all",     // all | follow
    issuesCat: "all",
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
    fetchJson("config/brand_exclude.json"),
    fetchJson("data/issues.json"),   // 이슈 타임라인 — 없어도 동작
    fetchJson("config/shortcuts.json"),
  ]).then(([articles, trending, briefing, config, hsdash, brandExclude, issuesDoc, shortcuts]) => {
    state.issuesMeta = issuesDoc;
    state.issues = (issuesDoc && issuesDoc.issues) || [];
    state.shortcuts = (shortcuts && shortcuts.shortcuts) || [];
    // 수집기가 이슈를 합치면 이전 id가 prevIds 로 남는다 → 팔로우를 새 id 로 옮긴다
    const migrated = HdCore.migrateFollows(state.follows, state.issues);
    if (migrated.moved.length) {
      state.follows = migrated.follows;
      saveJson(FOLLOWS_KEY, state.follows);
    }
    state.hsdash = hsdash;
    state.brandExclude = new Set(((brandExclude && brandExclude.exclude) || []).map((w) => String(w).trim()));
    state.articles = (articles && articles.articles) || [];
    state.trending = trending || { keywords: [] };
    state.briefing = briefing;
    state.config = config || state.config;
    if (articles && articles.generatedAt) {
      $updatedAt.textContent = "마지막 업데이트 " + formatRelative(articles.generatedAt);
      $updatedAt.title = articles.generatedAt;
    }
    renderSideStats();
    updateAlertDots();
    route();
  }).catch(() => {
    $main.innerHTML = '<div class="empty-state">데이터를 불러오지 못했습니다.<br>수집 워크플로가 아직 실행되지 않았을 수 있습니다.</div>';
  });

  window.addEventListener("hashchange", route);
  $search.addEventListener("input", () => {
    state.query = $search.value.trim();
    updateSearchClear();
    // 홈·발견·이슈 화면에서 검색하면 전체 기사(유통 NEWS)에서 찾는다
    if (state.query && !ARTICLE_VIEWS.has(state.view)) { location.hash = "#/retail"; return; }
    render();
  });
  document.getElementById("themeToggle").addEventListener("click", toggleTheme);
  document.getElementById("searchClear").addEventListener("click", clearSearch);
  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("modalBackdrop").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  document.getElementById("recentBtn").addEventListener("click", openRecentModal);
  document.getElementById("alertBtn").addEventListener("click", () => { location.hash = "#/issues?f=follow"; });
  document.addEventListener("click", (e) => {
    const link = e.target.closest && e.target.closest("a[data-aid]");
    if (link) recordRecent(link.dataset.aid);
  });

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
    const r = HdCore.parseHash(location.hash);   // 구버전 해시(#/dashboard 등)는 유통 NEWS 로
    const prevView = state.view, prevParam = state.routeParam;
    state.view = r.view;
    state.routeParam = r.param;
    state.routeQuery = r.query;
    if (r.view === "company") {
      // 회사 페이지 = 홈쇼핑 NEWS 에서 그 회사만 고른 화면 (대시보드 + 기사)
      state.activeTab = "homeshopping";
      if (companyById(r.param)) state.selectedCompanies = new Set([r.param]);
    } else {
      state.activeTab = r.view;   // retail / homeshopping / scrap 은 기존 피드, 나머지는 새 화면
    }
    if (r.query.q !== undefined) {
      state.query = r.query.q.trim();
      $search.value = r.query.q;
      updateSearchClear();
    }
    if (r.view === "issues") {
      if (r.query.f) state.issuesFilter = r.query.f === "follow" ? "follow" : "all";
      if (r.query.cat) state.issuesCat = r.query.cat;
    }
    markShortcutsSeen();
    highlightNav();
    render();
    if (prevView !== r.view || prevParam !== r.param) window.scrollTo(0, 0);
  }

  /* ---------------- 필터 ---------------- */

  function filterArticles() {
    let arts;
    if (state.activeTab === "scrap") {
      arts = Object.values(state.bookmarks);
    } else if (state.activeTab === "homeshopping") {
      arts = state.articles.filter((a) => a.tabs && a.tabs.includes("homeshopping"));
    } else if (state.view === "topic") {
      // 주제 페이지(#/topic/risk 등): 그 태그가 붙은 기사, 노이즈 제외
      arts = state.articles.filter((a) => !a.noise && a.tabs && a.tabs.includes(state.routeParam));
    } else if (state.view === "risk") {
      // 리스크 유형 페이지(#/risk/legal 등): 노이즈(연예·모음 기사) 제외
      arts = state.articles.filter((a) => !a.noise && (a.riskCategories || []).includes(state.routeParam));
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
    const v = state.view === "company" ? "homeshopping" : state.view;
    let html = "";
    const searching = !!state.query;
    if (v === "home") html = renderHome();
    else if (v === "discover") html = renderDiscover();
    else if (v === "issues") html = renderIssuesPage();
    else if (v === "issue") html = renderIssueDetail(state.routeParam);
    else if (v === "companies") html = renderCompaniesPage();
    else if (v === "trending") html = renderTrendingPage();
    else if (v === "hot") html = renderHotPage();
    else if (v === "topic" || v === "risk") {
      html = renderTopicHead() + renderFilterBar(true) + renderArticleList(filterArticles());
    } else {
      if (v === "retail" && !searching) {
        html += renderTrendingStrip(state.trending.keywords, "📈 급상승 키워드", 12);
        html += renderHotSection("hotRetail", "🔥 오늘의 유통 핫이슈 TOP 10");
        html += '<div class="dash-section-title">🕐 최신 기사</div>';
        html += renderRetailCoSlicer();
        html += renderFilterBar(true);
      }
      if (v === "homeshopping") {
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
    }
    $main.innerHTML = html;
    bindArticleEvents();
    bindChipEvents();
    bindPeriodInputs();
    bindDashBrands();
    bindBarSearch();
    restoreBarSearchFocus();
    bindHomeEvents();
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
      return `<a class="hot-row" href="${escapeAttr(url)}" data-aid="${a.id}" target="_blank" rel="noopener">
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
      html += '<div class="co-dash-grid">' + renderDashBrands(co, null) + "</div>";
      html += '<div class="co-dash-empty">편성·랭킹 데이터(hdhs 연동)가 아직 생성되지 않았습니다. 다음 수집 후 표시됩니다.</div>';
      return html + "</section>";
    }
    html += '<div class="co-dash-grid">';
    html += renderDashNewsLinks(dash, co);
    html += renderDashBrands(co, dash);
    html += renderDashRanking(dash);
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
    const links = (dash.newsLinks || []).filter((l) => !state.brandExclude.has(l.brand));
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

  /* 기사를 많이 낸 브랜드: 이 회사 기사(주요/언급 토글 따름)에서 브랜드를 뽑아 기사 수로 정렬.
     브랜드 후보 ① 제목 맨 앞 주어("고려은단, 27일 롯데홈쇼핑서…") ② hdhs 편성 브랜드가 제목에 등장 */

  const MAX_DASH_BRANDS = 10;
  let dashBrandMap = {};   // 브랜드 → 기사 목록 (팝업용)

  function titleSubject(title) {
    const t = title.replace(/^(\s*[\[(【][^\])】]{0,20}[\])】]\s*)+/, "");
    const m = t.match(/^([^,，]{2,14})[,，]\s/);
    if (!m) return "";
    const s = m[1].trim();
    if (/[…·'"‘’“”→~!?]|\.\.|\d{2,}/.test(s) || (s.match(/\s/g) || []).length > 1) return "";
    if (state.brandExclude.has(s)) return "";
    // 홈쇼핑사·유통사 자신(또는 'CJ'·'롯데'처럼 그 앞부분)은 브랜드가 아님
    const names = [];
    state.config.companies.concat(state.config.retailCompanies || []).forEach((c) => {
      names.push(c.name, ...(c.aliases || []));
      if (c.short) names.push(c.short);
    });
    if (names.some((n) => n.startsWith(s) || s.includes(n))) return "";
    return s;
  }

  function brandInTitle(brand, title) {
    let i = title.indexOf(brand);
    while (i >= 0) {
      const prev = i ? title[i - 1] : "";
      if (!/[가-힣A-Za-z0-9]/.test(prev)) {
        if (brand.length > 2) return true;
        const next = title[i + brand.length] || "";
        if (!/[A-Za-z0-9]/.test(next)) return true;
      }
      i = title.indexOf(brand, i + 1);
    }
    return false;
  }

  function companyBrands(coId, vocab) {
    const arts = state.articles.filter((a) =>
      a.tabs && a.tabs.includes("homeshopping") && coIds(a).includes(coId));
    const map = {};
    arts.forEach((a) => {
      const cands = new Set(vocab.filter((b) => brandInTitle(b, a.title)));
      const subj = titleSubject(a.title);
      if (subj) cands.add(subj);
      // 같은 기사에서 '리더스'와 '리더스코스메틱'이 함께 잡히면 긴 쪽만
      [...cands].forEach((b) => {
        if (![...cands].some((c) => c !== b && c.includes(b))) (map[b] = map[b] || []).push(a);
      });
    });
    // 기사마다 짧은/긴 이름으로 따로 잡힌 같은 브랜드 합치기 (리더스 ⊂ 리더스코스메틱)
    Object.keys(map).sort((x, y) => y.length - x.length).forEach((long) => {
      Object.keys(map).forEach((short) => {
        if (short !== long && map[short] && map[long] && long.startsWith(short)) {
          const ids = new Set(map[long].map((a) => a.id));
          map[short].forEach((a) => { if (!ids.has(a.id)) map[long].push(a); });
          delete map[short];
        }
      });
    });
    return Object.entries(map).map(([brand, list]) => {
      list.sort(cmpDate);
      return {
        brand, arts: list, onAir: vocab.includes(brand),
        heat: list.reduce((s, a) => s + (a.heat || 1), 0),
      };
    }).sort((x, y) => (y.arts.length - x.arts.length) || (y.heat - x.heat) ||
      cmpDate(x.arts[0], y.arts[0]));
  }

  function renderDashBrands(co, dash) {
    // 제외 목록(config/brand_exclude.json)은 hsdash 재생성을 기다리지 않고 바로 적용
    const vocab = ((dash && dash.brandVocab) || []).filter((b) => !state.brandExclude.has(b));
    const brands = companyBrands(co.id, vocab).slice(0, MAX_DASH_BRANDS);
    dashBrandMap = Object.fromEntries(brands.map((b) => [b.brand, b.arts]));
    const scope = state.coScope === "all" ? "언급 포함" : "주요 기사";
    const body = brands.length
      ? '<ol class="br-list">' + brands.map((b, i) => `<li class="br-row" data-brand="${escapeAttr(b.brand)}" role="button" tabindex="0" title="${escapeAttr(b.brand)} 기사 모아보기">
          <span class="br-rank">${i + 1}</span>
          <span class="br-name">${escapeHtml(b.brand)}${b.onAir ? '<span class="br-air" title="hdhs 앞뒤 7일 편성 있음">📺</span>' : ""}</span>
          <span class="br-title">${escapeHtml(b.arts[0].title)}</span>
          <span class="br-cnt">${b.arts.length}건${b.heat > b.arts.length ? `<small> · 보도 ${b.heat}</small>` : ""}</span>
        </li>`).join("") + "</ol>"
      : '<div class="co-dash-empty">최근 7일 기사에서 찾은 브랜드가 없습니다.</div>';
    return `<div class="co-panel"><div class="co-panel-title">🏷️ 기사를 많이 낸 브랜드 <span class="co-panel-note">최근 7일 · ${scope} · 클릭하면 기사 모음</span></div>${body}</div>`;
  }

  function bindDashBrands() {
    document.querySelectorAll(".br-row[data-brand]").forEach((el) => {
      const open = () => {
        const brand = el.dataset.brand;
        const arts = dashBrandMap[brand] || [];
        openArticlesModal(`🏷️ ${brand} 관련 기사 ${arts.length}건`, arts, brand);
      };
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
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
        <div class="article-title"><a href="${escapeAttr(url)}" data-aid="${a.id}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a></div>
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
    const parts = kw.split(/\s+/).filter(Boolean);
    const matched = state.articles.filter((a) => {
      const text = a.title + " " + (a.description || "");
      return parts.every((p) => text.includes(p));
    }).slice(0, 50);
    openArticlesModal(`"${kw}" 관련 기사 ${matched.length}건`, matched, kw);
  }

  // 기사 모음 팝업 (급상승 키워드·브랜드 공용). kw는 "검색으로 보기" 버튼의 검색어
  let modalReopen = null;

  function openArticlesModal(title, arts, kw) {
    modalKeyword = kw;
    modalReopen = () => openArticlesModal(title, arts, kw);
    document.getElementById("modalTitle").textContent = title;
    document.getElementById("modalGoTab").hidden = !kw;
    document.getElementById("modalBody").innerHTML = arts.length
      ? `<div class="article-list">${arts.map((a) => renderCard(a)).join("")}</div>`
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
        else if (key.startsWith("if:")) state.issuesFilter = key.slice(3);
        else if (key.startsWith("ic:")) state.issuesCat = key.slice(3);
        else if (key.startsWith("dc:")) state.discoverCat = key.slice(3);
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
        if (!document.getElementById("modal").hidden) modalReopen && modalReopen();
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

  /* ================= 모바일 개편: 홈 / 이슈 타임라인 / 발견 ================= */
  // 순수 계산(새 기사 판정·배지·그룹핑·라우트 파싱)은 issues-core.js 의 HdCore 에 있고, 여기서는 그리기와 저장만 한다.

  const ISSUE_CATS = [["all", "전체"], ["retail", "유통"], ["homeshopping", "홈쇼핑"], ["policy", "정책"], ["ecommerce", "e커머스"], ["risk", "리스크"]];
  const TOPIC_TITLE = {
    risk: ["🚨", "리스크 기사"], policy: ["⚖️", "정책·규제 기사"], ecommerce: ["🛒", "e커머스 기사"],
    homeshopping: ["🛍️", "홈쇼핑 기사"], retail: ["🔥", "유통 기사"],
  };
  const BELL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

  function loadJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v === null || v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }
  function saveJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 저장 공간 초과 등 — 무시 */ }
  }
  function articleById(id) { return state.articles.find((a) => a.id === id); }
  function companyById(id) { return (state.config.companies || []).find((c) => c.id === id); }
  function issueById(id) { return state.issues.find((i) => i.id === id); }
  function kstToday() { return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); }

  /* ----- 내비게이션 강조 ----- */

  function navKey() {
    const v = state.view;
    if (v === "issue") return "issues";
    if (v === "company") return "homeshopping";
    if (v === "topic" && state.routeParam === "risk") return "risk";
    return v;
  }
  function bottomKey() {
    const v = state.view;
    if (v === "issue") return "issues";
    if (v === "company") return "companies";
    return v;
  }
  function highlightNav() {
    const key = navKey(), bkey = bottomKey();
    document.querySelectorAll("a[data-tab]").forEach((a) => a.classList.toggle("active", a.dataset.tab === key));
    document.querySelectorAll("a[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === bkey));
  }

  /* ----- 바로가기 (config/shortcuts.json) ----- */

  function shortcutHref(target) {
    const t = target || {};
    switch (t.type) {
      case "trending": return "#/trending";
      case "hot": return "#/hot";
      case "topic": return `#/topic/${t.value}`;
      case "risk": return `#/risk/${t.value}`;
      case "tab": return `#/${t.value}`;
      case "company": return `#/company/${t.value}`;
      case "query": return `#/retail?q=${encodeURIComponent(t.value || "")}`;
      default: return "#/home";
    }
  }
  function normHash(h) {
    const raw = String(h || "").replace(/^#/, "");
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
  }
  // 바로가기가 가리키는 화면에 들어오면 '봤음'으로 기록 → 홈의 N 배지가 사라진다
  function markShortcutsSeen() {
    const cur = normHash(location.hash);
    let changed = false;
    state.shortcuts.forEach((sc) => {
      if (normHash(shortcutHref(sc.target)) === cur) {
        state.shortcutSeen[sc.id] = Date.now();
        changed = true;
      }
    });
    if (changed) saveJson(SHORTCUT_SEEN_KEY, state.shortcutSeen);
  }
  function renderShortcuts() {
    if (!state.shortcuts.length) return "";
    const ctx = {
      articles: state.articles, nowMs: Date.now(),
      briefingAt: state.briefing && state.briefing.generatedAt,
      trendingAt: state.trending && state.trending.generatedAt,
    };
    const items = state.shortcuts.map((sc) => {
      const n = HdCore.newCountFor(sc.target, Object.assign({ seenAtMs: state.shortcutSeen[sc.id] || 0 }, ctx));
      const badge = n ? `<span class="sc-badge" role="img" aria-label="새 기사 ${n}건">N</span>` : "";
      return `<a class="sc-item" href="${escapeAttr(shortcutHref(sc.target))}">
        <span class="sc-icon">${escapeHtml(sc.icon || "•")}${badge}</span>
        <span class="sc-label">${escapeHtml(sc.label)}</span></a>`;
    }).join("");
    return `<div class="home-shortcuts">${items}</div>`;
  }

  /* ----- 홈: 내 회사 / 회사 선택 / 지금 뜨는 이슈 ----- */

  // 최근 24시간 기준 (자정 직후 '오늘'이 비어 보이는 문제를 피하고, 핫이슈 랭킹과 같은 창을 쓴다)
  function recentStats(coId) {
    const since = Date.now() - 24 * 3600e3;
    let main = 0, mention = 0, risk = 0;
    const latest = [];
    state.articles.forEach((a) => {
      if (a.noise || !a.pubDate || Date.parse(a.pubDate) < since) return;
      if ((a.mainCompanies || []).includes(coId)) {
        main++;
        if (a.riskScore >= 1) risk++;
        latest.push(a);
      } else if ((a.companies || []).includes(coId)) {
        mention++;
      }
    });
    latest.sort(cmpDate);
    return { main, mention, risk, latest };
  }

  function renderMyCompanyCard() {
    const co = companyById(state.myCompany);
    if (!co) return "";
    const s = recentStats(co.id);
    const items = s.latest.slice(0, 3).map((a) =>
      `<li><a href="${escapeAttr(a.link || a.originallink || "#")}" data-aid="${a.id}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a> <span class="rel">${formatRelative(a.pubDate)}</span></li>`).join("");
    return `<section class="my-co" style="--co:${escapeAttr(co.color || "var(--ink)")}">
      <div class="my-co-head"><span class="co-dash-tag">${escapeHtml(co.short || co.name)}</span><b>${escapeHtml(co.name)}</b> <span class="my-co-range">지난 24시간</span><span class="spacer"></span>
        <button type="button" class="link-btn" id="myCompanyChange">변경</button></div>
      <div class="my-co-stats"><span><b>${s.main}</b>주요 기사</span><span><b>${s.mention}</b>언급</span><span><b class="${s.risk ? "risk" : ""}">${s.risk}</b>리스크</span>
        <a class="more-link" href="#/company/${co.id}">대시보드 →</a></div>
      ${items ? `<ul class="my-co-list">${items}</ul>` : '<div class="co-dash-empty">지난 24시간 주요 기사가 없어요.</div>'}
    </section>`;
  }

  function renderCompanyCircles() {
    const cos = state.config.companies || [];
    if (!cos.length) return "";
    const badges = HdCore.companyBadges(cos, state.articles, Date.now());
    const my = companyById(state.myCompany);
    let html = `<div class="home-row-head"><div class="dash-section-title">어느 회사를 보시나요?</div>
      <button type="button" class="my-co-btn" id="myCompanyBtn" title="홈 상단에 고정할 내 회사 선택">📍 ${my ? escapeHtml(my.short || my.name) : "내 회사"}</button></div>`;
    html += '<div class="co-scroll">' + cos.map((c) => {
      const b = badges[c.id];
      const badge = b === "risk" ? '<span class="co-badge risk">주의</span>' : b === "hot" ? '<span class="co-badge hot">인기</span>' : "";
      return `<a class="co-circle-item${state.myCompany === c.id ? " mine" : ""}" href="#/company/${c.id}" title="${escapeAttr(c.name)}">
        <span class="co-circle" style="--co:${escapeAttr(c.color || "#999")}">${escapeHtml(c.short || c.name)}${badge}</span>
        <span class="co-circle-name">${escapeHtml(c.name)}</span></a>`;
    }).join("") + "</div>";
    return html;
  }

  function renderHomeIssues() {
    const since = Date.now() - 24 * 3600e3;
    const hot = HdCore.sortByScore(state.issues.filter((i) => Date.parse(i.lastAt) >= since)).slice(0, 5);
    if (!hot.length) return "";
    return `<div class="section-head"><div class="dash-section-title">🗞️ 지금 뜨는 이슈</div><a class="more-link" href="#/issues">이슈 타임라인 →</a></div>
      <div class="section-sub">최근 24시간, 보도가 많이 몰린 순</div>
      <div class="issue-list">${hot.map(renderIssueRow).join("")}</div>`;
  }

  function renderHome() {
    return renderMyCompanyCard()
      + '<div class="dash-section-title home-title">⚡ 바로가기</div>' + renderShortcuts()
      + renderCompanyCircles()
      + renderHomeIssues();
  }

  /* ----- 이슈 타임라인 ----- */

  function issueNewFlag(issue) {
    const f = state.follows[issue.id];
    return f ? HdCore.followHasNew(issue, f) : HdCore.issueIsNew(issue, state.issueSeen[issue.id], Date.now());
  }

  function renderIssueRow(issue) {
    const on = !!state.follows[issue.id];
    const riskDot = issue.riskMax >= 1 ? '<span class="hot-risk-dot" title="리스크 이슈"></span>' : "";
    return `<div class="issue-row">
      <a class="issue-main" href="#/issue/${encodeURIComponent(issue.id)}">
        <div class="issue-title">${riskDot}<span>${escapeHtml(issue.title)}</span>${issueNewFlag(issue) ? '<span class="new-badge">NEW</span>' : ""}</div>
        <div class="issue-meta">${HdCore.compressLabel(issue.count)} · ${HdCore.relativeTime(issue.lastAt)}</div>
      </a>
      <button type="button" class="follow-btn${on ? " on" : ""}" data-issue="${escapeAttr(issue.id)}" aria-pressed="${on}" title="${on ? "팔로우 해제" : "팔로우 — 새 기사가 붙으면 알려줘요"}">${BELL_SVG}</button>
    </div>`;
  }

  function renderIssuesPage() {
    const f = state.issuesFilter, cat = state.issuesCat;
    const followN = Object.keys(state.follows).length;
    const meta = state.issuesMeta || {};
    let html = `<div class="page-head"><h1 class="page-title">이슈 타임라인 <span class="beta">Beta</span></h1>
      <div class="page-sub">같은 사건을 다룬 기사를 하나로 묶어 시간 순으로 정리했어요 · 최근 ${meta.windowHours || 72}시간</div></div>`;
    html += '<div class="chip-row">' + chip("if:all", "전체", f === "all", "")
      + chip("if:follow", "팔로우", f === "follow", followN ? `<span class="cnt">${followN}</span>` : "") + "</div>";
    html += '<div class="chip-row chip-row-sm">' + ISSUE_CATS.map(([k, label]) => chip("ic:" + k, label, cat === k, "")).join("") + "</div>";
    const list = HdCore.filterIssues(state.issues, { cat, onlyFollowed: f === "follow", follows: state.follows });
    const ended = f === "follow" ? HdCore.endedFollowIds(state.follows, state.issues) : [];
    if (!list.length && !ended.length) {
      html += `<div class="empty-state">${f === "follow"
        ? "팔로우한 이슈가 없어요. 이슈 옆 종 아이콘을 누르면 새 기사가 붙을 때 알려드려요."
        : "이 분류의 이슈가 아직 없어요."}</div>`;
      return html;
    }
    html += '<div class="issue-list">' + list.map(renderIssueRow).join("");
    html += ended.map((id) => {
      const f2 = state.follows[id] || {};
      return `<div class="issue-row ended"><div class="issue-main">
        <div class="issue-title"><span>${escapeHtml(f2.title || id)}</span><span class="new-badge ended">종료됨</span></div>
        <div class="issue-meta">최근 ${meta.windowHours || 72}시간 목록에서 내려간 이슈예요</div></div>
        <button type="button" class="follow-btn on" data-issue="${escapeAttr(id)}" title="팔로우 해제">${BELL_SVG}</button></div>`;
    }).join("");
    return html + "</div>";
  }

  function fmtDateLabel(ymd) {
    const d = new Date(ymd + "T00:00:00");
    if (isNaN(d)) return escapeHtml(ymd || "");
    return `${ymd.replace(/-/g, ".")} (${WEEKDAY[d.getDay()]})${ymd === kstToday() ? " · 오늘" : ""}`;
  }

  function renderTimelineItem(a) {
    const riskClass = a.riskScore >= 3 ? "risk-3" : a.riskScore === 2 ? "risk-2" : a.riskScore === 1 ? "risk-1" : "";
    const url = a.link || a.originallink || "#";
    const press = a.press || pressFromUrl(a.originallink || a.link);
    const marked = !!state.bookmarks[a.id];
    return `<div class="tl-item ${riskClass}">
      <span class="tl-time">${escapeHtml((a.pubDate || "").slice(11, 16))}</span>
      <div class="tl-body">
        <a class="tl-title" href="${escapeAttr(url)}" data-aid="${a.id}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a>
        <div class="tl-meta">${press ? `<span class="press">${escapeHtml(press)}</span>` : ""}${a.heat > 1 ? `<span class="meta-chip heat">보도 ${a.heat}건</span>` : ""}
          <button class="bookmark-btn${marked ? " on" : ""}" data-id="${a.id}" title="스크랩">${marked ? "★" : "☆"}</button></div>
      </div></div>`;
  }

  function renderIssueDetail(id) {
    const issue = issueById(id);
    if (!issue) {
      return `<a class="back-link" href="#/issues">← 이슈 타임라인</a>
        <div class="empty-state">이 이슈는 최근 목록에서 내려갔어요.</div>`;
    }
    // 열람 기록 → NEW 해제 (팔로우 중이면 알림 점도 해제)
    state.issueSeen[id] = Date.now();
    saveJson(ISSUE_SEEN_KEY, state.issueSeen);
    if (state.follows[id] && state.follows[id].seenLastAt !== issue.lastAt) {
      state.follows[id].seenLastAt = issue.lastAt;
      saveJson(FOLLOWS_KEY, state.follows);
    }
    updateAlertDots();
    const arts = issue.articleIds.map(articleById).filter(Boolean);
    const rep = articleById(issue.repArticleId) || arts[0];
    const cos = (issue.companies || []).map((cid) => {
      const c = companyById(cid);
      return c ? `<span class="meta-chip co">${escapeHtml(c.name)}</span>` : "";
    }).join("");
    const risks = (issue.riskCategories || []).map((rid) => {
      const rc = state.config.riskCategories.find((x) => x.id === rid);
      return rc ? `<span class="meta-chip risk">${escapeHtml(rc.name)}</span>` : "";
    }).join("");
    const on = !!state.follows[id];
    let html = `<a class="back-link" href="#/issues">← 이슈 타임라인</a>
      <section class="issue-head">
        <h1>${escapeHtml(issue.title)}</h1>
        <div class="issue-head-meta"><span>기사 ${issue.articles}건 · 보도 ${issue.count}건</span><span class="dot">·</span>
          <span>${formatDate(issue.firstAt)} ~ ${formatDate(issue.lastAt)}</span>${cos}${risks}</div>
        ${rep && rep.description ? `<div class="issue-summary">${escapeHtml(rep.description)}</div>` : ""}
        <div class="issue-head-actions">
          <button type="button" class="follow-pill${on ? " on" : ""}" data-issue="${escapeAttr(id)}" aria-pressed="${on}">${BELL_SVG} ${on ? "팔로우 중" : "팔로우"}</button>
          <span class="section-sub" style="margin:0">${on ? "새 기사가 붙으면 NEW 와 알림 점으로 알려드려요" : "팔로우하면 후속 보도를 놓치지 않아요"}</span></div>
      </section>`;
    if (!arts.length) return html + '<div class="empty-state">이 이슈의 기사를 불러오지 못했어요.</div>';
    html += '<div class="timeline">' + HdCore.groupByDate(arts).map((g) =>
      `<div class="tl-date">${fmtDateLabel(g.date)}</div>` + g.items.map(renderTimelineItem).join("")).join("") + "</div>";
    return html;
  }

  function toggleFollow(id) {
    const issue = issueById(id);
    if (state.follows[id]) {
      delete state.follows[id];
    } else {
      const nowIso = new Date().toISOString();
      state.follows[id] = { followedAt: nowIso, seenLastAt: issue ? issue.lastAt : nowIso, title: issue ? issue.title : id };
    }
    saveJson(FOLLOWS_KEY, state.follows);
    updateAlertDots();
    render();
  }

  // 팔로우한 이슈에 새 기사가 붙었으면 헤더 종·하단 '이슈' 탭·사이드바에 점을 켠다
  function updateAlertDots() {
    const hasNew = Object.entries(state.follows).some(([id, f]) => {
      const i = issueById(id);
      return !!i && HdCore.followHasNew(i, f);
    });
    document.querySelectorAll(".alert-dot").forEach((el) => { el.hidden = !hasNew; });
  }

  /* ----- 발견 / 회사 / 주제 페이지 ----- */

  function renderCompanyCard(c) {
    const s = recentStats(c.id);
    return `<a class="co-card" href="#/company/${c.id}" style="--co:${escapeAttr(c.color || "#999")}">
      <span class="co-dash-tag">${escapeHtml(c.short || c.name)}</span><span class="name">${escapeHtml(c.name)}</span>
      <div class="stats">24시간 주요 <b>${s.main}</b>건${s.mention ? ` · 언급 ${s.mention}` : ""}<br>${s.risk ? `<span class="risk">⚠ 리스크 ${s.risk}건</span>` : "리스크 없음"}</div></a>`;
  }

  function renderDiscover() {
    const cat = state.discoverCat;
    let html = `<div class="page-head"><h1 class="page-title">발견</h1><div class="page-sub">분류별로 이슈·회사·급상승 키워드를 둘러보세요</div></div>`;
    html += '<div class="chip-row">' + ISSUE_CATS.map(([k, label]) => chip("dc:" + k, label, cat === k, "")).join("") + "</div>";
    const issues = HdCore.sortByScore(HdCore.filterIssues(state.issues, { cat })).slice(0, 6);
    html += `<div class="section-head"><div class="dash-section-title">이슈 타임라인</div><a class="more-link" href="#/issues?cat=${cat}">더 보기</a></div>
      <div class="section-sub">시간 순으로 핵심만 정리했어요</div>`;
    html += issues.length
      ? '<div class="issue-chips">' + issues.map((i) =>
        `<a class="issue-chip" href="#/issue/${encodeURIComponent(i.id)}" title="${escapeAttr(i.title)}"><span class="t">${escapeHtml(i.title)}</span>${issueNewFlag(i) ? '<span class="n">N</span>' : ""}</a>`).join("") + "</div>"
      : '<div class="co-dash-empty">이 분류의 이슈가 아직 없어요.</div>';
    if (cat === "all" || cat === "homeshopping") {
      html += `<div class="section-head"><div class="dash-section-title">회사 대시보드</div><a class="more-link" href="#/companies">전체 보기</a></div>
        <div class="section-sub">최근 24시간 주요 기사와 리스크 건수</div>`;
      html += '<div class="co-cards">' + (state.config.companies || []).map(renderCompanyCard).join("") + "</div>";
    }
    const kws = cat === "homeshopping" ? (state.trending.hsKeywords || []) : (state.trending.keywords || []);
    html += renderTrendingStrip(kws, "📈 급상승 키워드", 10);
    return html;
  }

  function renderCompaniesPage() {
    return `<div class="page-head"><h1 class="page-title">회사</h1><div class="page-sub">홈쇼핑 12개사 — 누르면 회사 대시보드와 기사로 이동해요</div></div>
      <div class="co-grid">${(state.config.companies || []).map(renderCompanyCard).join("")}</div>`;
  }

  function renderTopicHead() {
    if (state.view === "risk") {
      const rc = state.config.riskCategories.find((x) => x.id === state.routeParam);
      return `<div class="page-head"><a class="back-link" href="#/home">← 홈</a><h1 class="page-title">⚠ ${escapeHtml(rc ? rc.name : state.routeParam)}</h1>
        <div class="page-sub">이 유형의 리스크 키워드가 잡힌 기사 · 최근 7일</div></div>`;
    }
    const t = TOPIC_TITLE[state.routeParam] || ["📰", state.routeParam];
    return `<div class="page-head"><a class="back-link" href="#/home">← 홈</a><h1 class="page-title">${t[0]} ${escapeHtml(t[1])}</h1><div class="page-sub">최근 7일 · 최신순</div></div>`;
  }

  function renderTrendingPage() {
    return `<div class="page-head"><a class="back-link" href="#/home">← 홈</a><h1 class="page-title">📈 급상승 키워드</h1>
      <div class="page-sub">최근 24시간에 이전 3일 평균보다 많이 나온 단어 · 누르면 관련 기사</div></div>`
      + renderTrendingStrip(state.trending.keywords, "유통 전체", 20)
      + renderTrendingStrip(state.trending.hsKeywords || [], "홈쇼핑", 10);
  }

  function renderHotPage() {
    return `<div class="page-head"><a class="back-link" href="#/home">← 홈</a><h1 class="page-title">🔥 핫이슈 TOP 10</h1>
      <div class="page-sub">보도량 + 리스크 점수 순 · 최근 24시간</div></div>`
      + renderHotSection("hotRetail", "유통") + renderHotCompact("hotHomeshopping", "홈쇼핑");
  }

  /* ----- 최근 본 기사 / 내 회사 선택 / 이벤트 ----- */

  function recordRecent(id) {
    if (!id) return;
    state.recent = [id].concat(state.recent.filter((x) => x !== id)).slice(0, 20);
    saveJson(RECENT_KEY, state.recent);
  }
  function openRecentModal() {
    const arts = state.recent.map((id) => articleById(id) || state.bookmarks[id]).filter(Boolean);
    openArticlesModal(`🕒 최근 본 기사 ${arts.length}건`, arts, "");
  }
  function openMyCompanyModal() {
    document.getElementById("modalTitle").textContent = "📍 내 회사 선택";
    document.getElementById("modalGoTab").hidden = true;
    document.getElementById("modalBody").innerHTML = `<div class="section-sub">홈 상단에 이 회사의 오늘 요약을 고정해요. 이 기기에만 저장됩니다.</div>
      <div class="pick-grid">${(state.config.companies || []).map((c) =>
        `<button type="button" class="pick-co${state.myCompany === c.id ? " on" : ""}" data-pick="${c.id}" style="--co:${escapeAttr(c.color || "#999")}">${escapeHtml(c.short || c.name)}<small>${escapeHtml(c.name)}</small></button>`).join("")}</div>
      ${state.myCompany ? '<button type="button" class="pick-clear" data-pick="">내 회사 해제</button>' : ""}`;
    document.getElementById("modal").hidden = false;
    document.body.style.overflow = "hidden";
    document.querySelectorAll("#modalBody [data-pick]").forEach((el) => el.addEventListener("click", () => {
      state.myCompany = el.dataset.pick || "";
      saveJson(MY_COMPANY_KEY, state.myCompany);
      closeModal();
      render();
    }));
  }
  function bindHomeEvents() {
    document.querySelectorAll(".follow-btn[data-issue], .follow-pill[data-issue]").forEach((el) => {
      el.addEventListener("click", () => toggleFollow(el.dataset.issue));
    });
    ["myCompanyBtn", "myCompanyChange"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", openMyCompanyModal);
    });
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

/* hdnews 프론트엔드 — 의존성 없는 순수 JS SPA */
(function () {
  "use strict";

  const BOOKMARK_KEY = "hdnews.bookmarks";
  const THEME_KEY = "hdnews.theme";

  const state = {
    articles: [],
    trending: { keywords: [] },
    briefing: null,
    config: { companies: [], riskCategories: [] },
    activeTab: "dashboard",
    selectedCompanies: new Set(),
    selectedRiskCats: new Set(),
    query: "",
    matchScope: "all",   // all | title | body
    sortOrder: "latest", // latest | risk
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
  ]).then(([articles, trending, briefing, config]) => {
    state.articles = (articles && articles.articles) || [];
    state.trending = trending || { keywords: [] };
    state.briefing = briefing;
    state.config = config || state.config;
    if (articles && articles.generatedAt) {
      $updatedAt.textContent = "마지막 업데이트 " + formatRelative(articles.generatedAt);
      $updatedAt.title = articles.generatedAt;
    }
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
    const tab = (location.hash.replace(/^#\//, "") || "dashboard");
    const valid = ["dashboard", "retail", "homeshopping", "risk", "policy", "ecommerce", "scrap"];
    state.activeTab = valid.includes(tab) ? tab : "dashboard";
    document.querySelectorAll(".tab-bar a").forEach((a) => {
      a.classList.toggle("active", a.dataset.tab === state.activeTab);
    });
    render();
  }

  /* ---------------- 필터 ---------------- */

  function filterArticles() {
    let arts;
    if (state.activeTab === "scrap") {
      arts = Object.values(state.bookmarks);
    } else if (state.activeTab === "dashboard" || state.activeTab === "retail") {
      arts = state.articles;
    } else {
      arts = state.articles.filter((a) => a.tabs && a.tabs.includes(state.activeTab));
    }
    if (state.activeTab === "homeshopping" && state.selectedCompanies.size) {
      arts = arts.filter((a) => a.companies && a.companies.some((c) => state.selectedCompanies.has(c)));
    }
    if (state.activeTab === "risk" && state.selectedRiskCats.size) {
      arts = arts.filter((a) => a.riskCategories && a.riskCategories.some((c) => state.selectedRiskCats.has(c)));
    }
    if (state.activeTab === "risk" && state.selectedCompanies.size) {
      arts = arts.filter((a) => a.companies && a.companies.some((c) => state.selectedCompanies.has(c)));
    }
    if (state.query) {
      const q = state.query.toLowerCase();
      arts = arts.filter((a) =>
        (a.title + " " + (a.description || "")).toLowerCase().includes(q));
    }
    if (state.activeTab === "homeshopping" && state.matchScope !== "all") {
      arts = arts.filter((a) => {
        const terms = matchTermsFor(a);
        if (!terms.length) return false;
        const inTitle = terms.some((t) => a.title.includes(t));
        if (state.matchScope === "title") return inTitle;
        return !inTitle && terms.some((t) => (a.description || "").includes(t));
      });
    }
    if (state.activeTab === "risk") {
      arts = arts.slice().sort((x, y) => (y.riskScore - x.riskScore) || cmpDate(x, y));
    } else if (state.activeTab === "homeshopping" && state.sortOrder === "risk") {
      arts = arts.slice().sort((x, y) => (y.riskScore - x.riskScore) || cmpDate(x, y));
    }
    return arts;
  }

  // 매칭 범위 필터의 기준 검색어: 검색어 > 선택한 회사의 별칭 > 기사에 태깅된 회사의 별칭
  function matchTermsFor(article) {
    if (state.query) return [state.query];
    const ids = state.selectedCompanies.size
      ? [...state.selectedCompanies]
      : (article.companies || []);
    const terms = [];
    ids.forEach((id) => {
      const c = state.config.companies.find((x) => x.id === id);
      if (c) terms.push(c.name, ...(c.aliases || []));
    });
    return terms;
  }

  function cmpDate(x, y) {
    return (y.pubDate || "").localeCompare(x.pubDate || "");
  }

  /* ---------------- 렌더 ---------------- */

  function render() {
    if (state.activeTab === "dashboard" && !state.query) {
      renderDashboard();
      return;
    }
    let html = "";
    if (state.activeTab === "homeshopping" || state.activeTab === "risk") {
      html += renderSlicers();
    }
    if (state.activeTab === "homeshopping") {
      html += renderFilterBar();
    }
    const arts = filterArticles();
    html += renderArticleList(arts);
    $main.innerHTML = html;
    bindArticleEvents();
    bindChipEvents();
  }

  function renderFilterBar() {
    const ms = state.matchScope, so = state.sortOrder;
    return `<div class="filter-bar">
      <span class="filter-label">매칭</span>
      ${chip("ms:all", "전체", ms === "all", "")}
      ${chip("ms:title", "제목 포함", ms === "title", "")}
      ${chip("ms:body", "본문만", ms === "body", "")}
      <span class="filter-sep"></span>
      <span class="filter-label">정렬</span>
      ${chip("so:latest", "최신순", so === "latest", "")}
      ${chip("so:risk", "리스크순", so === "risk", "")}
    </div>`;
  }

  function renderSlicers() {
    let html = "";
    const today = new Date().toISOString().slice(0, 10);
    const recentRisk = companyRiskSet();
    if (state.activeTab === "risk") {
      html += '<div class="chip-group"><div class="chip-group-label">리스크 유형</div><div class="chip-row">';
      html += chip("rc-all", "전체", !state.selectedRiskCats.size, "");
      state.config.riskCategories.forEach((rc) => {
        html += chip("rc:" + rc.id, rc.name, state.selectedRiskCats.has(rc.id), "");
      });
      html += "</div></div>";
    }
    const groups = { "TV홈쇼핑": [], "T커머스": [] };
    state.config.companies.forEach((c) => (groups[c.type] || (groups[c.type] = [])).push(c));
    html += '<div class="chip-group"><div class="chip-group-label">홈쇼핑사</div><div class="chip-row">';
    html += chip("co-all", "전체", !state.selectedCompanies.size, "");
    Object.entries(groups).forEach(([, cos]) => {
      cos.forEach((c) => {
        const cnt = state.articles.filter((a) =>
          a.companies && a.companies.includes(c.id) &&
          (a.pubDate || "").slice(0, 10) === today).length;
        const extra = (cnt ? `<span class="cnt">${cnt}</span>` : "") +
          (recentRisk.has(c.id) ? '<span class="risk-dot" title="최근 48시간 내 리스크 기사"></span>' : "");
        html += chip("co:" + c.id, c.name, state.selectedCompanies.has(c.id), extra);
      });
    });
    html += "</div></div>";
    return html;
  }

  function chip(key, label, active, extra) {
    return `<span class="chip${active ? " active" : ""}" data-chip="${key}">${label}${extra}</span>`;
  }

  function companyRiskSet() {
    const cutoff = Date.now() - 48 * 3600 * 1000;
    const set = new Set();
    state.articles.forEach((a) => {
      if (a.riskScore >= 1 && a.pubDate && new Date(a.pubDate).getTime() >= cutoff) {
        (a.companies || []).forEach((c) => set.add(c));
      }
    });
    return set;
  }

  function renderArticleList(arts) {
    if (!arts.length) {
      const msg = state.activeTab === "scrap"
        ? "스크랩한 기사가 없습니다. 기사 카드의 ★을 눌러 저장하세요."
        : "조건에 맞는 기사가 없습니다.";
      return `<div class="empty-state">${msg}</div>`;
    }
    const items = arts.slice(0, 300).map(renderCard).join("");
    const more = arts.length > 300 ? `<div class="empty-state">외 ${arts.length - 300}건 — 검색으로 좁혀보세요.</div>` : "";
    return `<div class="article-list">${items}</div>${more}`;
  }

  function renderCard(a) {
    const riskClass = a.riskScore >= 3 ? "risk-3" : a.riskScore === 2 ? "risk-2" : a.riskScore === 1 ? "risk-1" : "";
    const companies = (a.companies || []).map((id) => {
      const c = state.config.companies.find((x) => x.id === id);
      return c ? `<span class="meta-chip">${c.name}</span>` : "";
    }).join("");
    const risks = (a.riskCategories || []).map((id) => {
      const rc = state.config.riskCategories.find((x) => x.id === id);
      return rc ? `<span class="meta-chip risk">${rc.name}</span>` : "";
    }).join("");
    const marked = !!state.bookmarks[a.id];
    const url = a.link || a.originallink || "#";
    const press = a.press || pressFromUrl(a.originallink || a.link);
    return `<article class="article-card ${riskClass}">
      <div class="article-body">
        <div class="article-title"><a href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(a.title)}</a></div>
        ${a.description ? `<div class="article-desc">${escapeHtml(a.description)}</div>` : ""}
        <div class="article-meta">
          <span>${formatRelative(a.pubDate)}</span>${companies}${risks}
        </div>
      </div>
      <div class="article-side">
        <button class="bookmark-btn${marked ? " on" : ""}" data-id="${a.id}" title="스크랩">${marked ? "★" : "☆"}</button>
        ${press ? `<span class="press">${escapeHtml(press)}</span>` : ""}
        <span class="date">${formatDate(a.pubDate)}</span>
      </div>
    </article>`;
  }

  // 수집기 press 백필 전 데이터 대비: 원문 도메인으로 즉석 판별 (매핑 없이 도메인 표시)
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

  /* ---------------- 대시보드 ---------------- */

  function renderDashboard() {
    const b = state.briefing && state.briefing.daily;
    if (!b || !state.articles.length) {
      $main.innerHTML = '<div class="empty-state">아직 수집된 기사가 없습니다.<br>GitHub Actions에서 "Collect news" 워크플로를 실행해 주세요.</div>';
      return;
    }
    const riskCnt = (b.byTab && b.byTab.risk) || 0;
    const hsCnt = (b.byTab && b.byTab.homeshopping) || 0;
    let html = `<div class="dash-grid">
      <div class="dash-card"><div class="num">${b.total}</div><div class="label">오늘 수집 기사</div></div>
      <div class="dash-card"><div class="num">${hsCnt}</div><div class="label">홈쇼핑 기사</div></div>
      <div class="dash-card"><div class="num risk">${riskCnt}</div><div class="label">오늘 리스크 기사</div></div>
      <div class="dash-card"><div class="num">${state.briefing.weekly ? state.briefing.weekly.total : "-"}</div><div class="label">주간 누적 기사</div></div>
    </div>`;

    html += '<div class="dash-section-title">🔥 급상승 키워드</div>';
    if (state.trending.keywords.length) {
      html += '<div class="trend-list">' + state.trending.keywords.slice(0, 20).map((k, i) =>
        `<span class="trend-chip" data-kw="${escapeAttr(k.keyword)}"><span class="rank">${i + 1}</span>${escapeHtml(k.keyword)}<span class="cnt">${k.count}건</span></span>`
      ).join("") + "</div>";
    } else {
      html += '<div class="empty-state" style="padding:16px">수집 24시간 후부터 표시됩니다.</div>';
    }

    html += '<div class="dash-section-title">🏢 회사별 오늘 기사</div><div class="company-bars">';
    const byCo = b.byCompany || {};
    const riskByCo = b.riskByCompany || {};
    const max = Math.max(1, ...Object.values(byCo));
    state.config.companies.forEach((c) => {
      const n = byCo[c.id] || 0;
      const w = Math.round((n / max) * 100);
      html += `<div class="company-bar-row"><span class="name">${c.name}</span>
        <span class="bar" style="width:${w * 0.6}%"></span><span>${n}</span>
        ${riskByCo[c.id] ? `<span class="risk-mark">⚠ ${riskByCo[c.id]}</span>` : ""}</div>`;
    });
    html += "</div>";

    const topRisk = (b.topRiskArticleIds || [])
      .map((id) => state.articles.find((a) => a.id === id)).filter(Boolean);
    if (topRisk.length) {
      html += '<div class="dash-section-title">⚠️ 오늘의 주요 리스크</div>';
      html += `<div class="article-list">${topRisk.map(renderCard).join("")}</div>`;
    }

    $main.innerHTML = html;
    bindArticleEvents();
    document.querySelectorAll(".trend-chip").forEach((el) => {
      el.addEventListener("click", () => openKeywordModal(el.dataset.kw));
    });
  }

  /* ---------------- 모달 (대시보드 팝업) ---------------- */

  let modalKeyword = "";

  function openKeywordModal(kw) {
    modalKeyword = kw;
    const matched = state.articles.filter((a) =>
      (a.title + " " + (a.description || "")).includes(kw)).slice(0, 50);
    document.getElementById("modalTitle").textContent = `"${kw}" 관련 기사 ${matched.length}건`;
    document.getElementById("modalBody").innerHTML = matched.length
      ? `<div class="article-list">${matched.map(renderCard).join("")}</div>`
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
    document.querySelectorAll(".chip").forEach((el) => {
      el.addEventListener("click", () => {
        const key = el.dataset.chip;
        if (key === "co-all") state.selectedCompanies.clear();
        else if (key === "rc-all") state.selectedRiskCats.clear();
        else if (key.startsWith("co:")) toggleSet(state.selectedCompanies, key.slice(3));
        else if (key.startsWith("rc:")) toggleSet(state.selectedRiskCats, key.slice(3));
        else if (key.startsWith("ms:")) state.matchScope = key.slice(3);
        else if (key.startsWith("so:")) state.sortOrder = key.slice(3);
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
    document.getElementById("scrapCount").textContent = n ? `(${n})` : "";
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

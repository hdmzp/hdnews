/* hdnews v2 초안 — 의존성 없는 순수 JS.
   화면 4개(HOT / 발견 / 홈쇼핑 / 스크랩) + 상단 돋보기 검색. 데이터는 수집기가 만든 ../data/*.json 을 그대로 쓴다. */
(function () {
  "use strict";

  const BOOKMARK_KEY = "hdnews.bookmarks";   // 기존 사이트와 같은 키 — 스크랩이 그대로 이어진다
  const KW_SNAP_KEY = "hd2.kwSnap";          // 지난 방문 때 본 유통 키워드 목록 (N 판정)
  const KW_TAP_KEY = "hd2.kwTapped";
  const ISSUE_SEEN_KEY = "hd2.issueSeen";
  const UI_KEY = "hd2.ui";                   // 접기/펼치기 상태
  const HOUR = 3600e3;
  const KW_PER_PAGE = 4;
  const ISSUE_PER_PAGE = 8;
  const LIST_STEP = 40;
  // 슬라이서용 중간 길이 회사명 (4칸에 들어가는 길이)
  const CO_LABEL = { hyundai: "현대", gsshop: "GS샵", cj: "CJ", lotte: "롯데", gongyoung: "공영", hns: "홈앤",
    ktalpha: "KT알파", ssglive: "신세계", ns: "NS", shoppingnt: "쇼핑엔티", skstoa: "SK스토아", wshop: "W쇼핑" };

  const D = { articles: [], byId: new Map(), trending: null, briefing: null, issues: [], config: null, topics: null, stop: new Set() };
  const savedUi = load(UI_KEY, {});
  const S = {
    view: "hot",
    search: { open: false, q: "" },
    hot: { topic: "all", topicOpen: false, tipKw: false, tipIs: false },
    hs: { co: "", sumOpen: !!savedUi.sumOpen, topicOpen: savedUi.hsTopicOpen !== false, topic: "all", q: "", sort: "latest", period: 0, limit: LIST_STEP },
    discover: { topic: "all", q: "", sort: "latest", period: 0, limit: LIST_STEP },
    bookmarks: load(BOOKMARK_KEY, {}),
  };

  const $main = document.getElementById("main");
  const $sheet = document.getElementById("sheet");

  Promise.all([
    get("../data/articles.json"), get("../data/trending.json"), get("../data/briefing.json"),
    get("../data/issues.json"), get("../config/keywords.json"), get("topics.json"), get("../config/stopwords.json"),
  ]).then(([arts, trending, briefing, issues, config, topics, stop]) => {
    D.articles = (arts && arts.articles) || [];
    D.articles.forEach((a) => D.byId.set(a.id, a));
    D.trending = trending || { keywords: [] };
    D.briefing = briefing || {};
    D.issues = (issues && issues.issues) || [];
    D.config = config || { companies: [] };
    D.topics = topics || { discover: [], homeshopping: [] };
    D.stop = new Set(((stop && stop.stopwords) || []).concat(["홈쇼핑", "T커머스"]));
    D.coNames = [];
    D.config.companies.forEach((c) => D.coNames.push(c.name, c.short, ...(c.aliases || [])));
    // 기준 시각: 수집 시각(로컬에서 오래된 데이터를 열어도 '24시간' 창이 비지 않게)
    D.ref = Date.parse((arts && arts.generatedAt) || "") || Date.now();
    route();
  }).catch((e) => {
    console.error(e);
    $main.innerHTML = '<div class="empty">데이터를 불러오지 못했습니다.</div>';
  });

  window.addEventListener("hashchange", route);

  /* ================= 라우팅 / 렌더 ================= */

  function route() {
    const seg = location.hash.replace(/^#\/?/, "").split("/");
    const v = ["hot", "discover", "hs", "scrap"].includes(seg[0]) ? seg[0] : "hot";
    S.view = v;
    if (v === "hs") {
      const co = seg[1] && D.config.companies.some((c) => c.id === seg[1]) ? seg[1] : "";
      if (co !== S.hs.co) { S.hs.co = co; S.hs.limit = LIST_STEP; }
    }
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.view === v));
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    if (S.search.open && S.search.q) $main.innerHTML = renderSearch();
    else if (S.view === "hot") $main.innerHTML = renderHot();
    else if (S.view === "discover") $main.innerHTML = renderDiscover();
    else if (S.view === "hs") $main.innerHTML = renderHs();
    else $main.innerHTML = renderScrap();
    bindPagers();
    const band = document.getElementById("coBand");
    if (band) {
      band.classList.remove("collapsed");
      document.getElementById("bandSpacer").style.height = band.offsetHeight + "px";
      lastY = window.scrollY;
    }
    setBandH();
    bindMiniBar();
  }

  // 목록만 다시 그린다 (검색창 입력 중 포커스 유지)
  function renderListOnly() {
    const el = document.getElementById("list");
    if (!el) return render();
    const ui = S.view === "hs" ? S.hs : S.discover;
    const base = S.view === "hs" ? hsBase() : discoverBase();
    el.innerHTML = listBlock(applyFilters(base, ui, topicList(S.view)), ui);
    updateMiniBar();
  }

  /* ================= HOT ================= */

  function renderHot() {
    const kws = hotKeywords();
    const items = hsIssueItems();
    const at = D.trending.generatedAt ? D.trending.generatedAt.slice(11, 16) : "";
    let h = '<div class="hot-split">';

    h += `<section class="sec"><div class="sec-head">
        <h2 class="sec-title">유통 <span class="accent">KEYWORD</span></h2>
        <button class="info" data-act="tip" data-k="tipKw" aria-label="설명">i</button>
        <span class="sec-right">${at} 제공</span></div>`;
    if (S.hot.tipKw) h += '<div class="tip">최근 24시간 기사 제목에서 이전 3일 평균보다 많이 나온 단어·구절이에요. 유통·홈쇼핑과 관련 없는 사회면 키워드는 뺐어요. <b>N</b> = 지난 방문 뒤 새로 올라온 키워드.</div>';
    h += kws.length ? pager(chunk(kws, KW_PER_PAGE).map((pg) =>
      pg.map((k) => `<button class="card kw-row" data-act="kw" data-kw="${attr(k.keyword)}">
          <span class="kw-rank">${k.rank}</span>
          <span class="kw-text">${esc(k.keyword)}</span>
          ${k.isNew ? '<span class="n-badge">N</span>' : ""}
          <span class="kw-cnt">${k.count}건</span>
          <svg class="ico" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        </button>`).join(""))) : '<div class="empty">아직 집계된 키워드가 없어요.</div>';
    h += "</section>";

    const topics = D.topics.homeshopping;
    const curTopic = topics.find((t) => t.id === S.hot.topic);
    h += `<section class="sec"><div class="sec-head">
        <h2 class="sec-title">홈쇼핑 <span class="accent blue">ISSUE</span></h2>
        <button class="info" data-act="tip" data-k="tipIs" aria-label="설명">i</button>
        <button class="topic-pill sec-right${S.hot.topic !== "all" ? " on" : ""}" data-act="hotTopicOpen">${S.hot.topic !== "all" ? esc(curTopic.label) : "TOPIC"} ▾</button></div>`;
    if (S.hot.tipIs) h += '<div class="tip">최근 72시간 같은 사건을 다룬 기사를 하나로 묶은 이슈예요. 보도가 많이 몰리고 리스크가 클수록 앞에 와요. 묶이지 않은 화제 기사도 뒤에 붙여요.</div>';
    if (S.hot.topicOpen) {
      h += '<div class="chips scroll" style="margin-bottom:8px">' + topics.map((t) =>
        `<button class="chip${t.risk ? " risk" : ""}${S.hot.topic === t.id ? " on" : ""}" data-act="hotTopic" data-id="${t.id}">${esc(t.label)}</button>`).join("") + "</div>";
    }
    h += items.length ? pager(chunk(items, ISSUE_PER_PAGE).map((pg) =>
      '<div class="issue-grid">' + pg.map(issueCard).join("") + "</div>")) : '<div class="empty">이 토픽의 이슈가 아직 없어요.</div>';
    h += "</section></div>";
    return h;
  }

  // 급상승 키워드 중 유통 맥락이 있는 것만 (현재 수집기는 사회면 키워드도 섞여 나온다)
  function hotKeywords() {
    const since = D.ref - 24 * HOUR;
    const all = (D.trending.keywords || []).map((k) => {
      const arts = matchTitle(k.keyword, since);
      const rel = arts.filter(isRelevant).length;
      return Object.assign({}, k, { ok: arts.length ? rel / arts.length >= 0.5 : false });
    });
    let list = all.filter((k) => k.ok);
    if (list.length < 8) list = all;
    const at = D.trending.generatedAt || "";
    const snap = load(KW_SNAP_KEY, null);
    const cur = list.map((k) => k.keyword);
    let prev = null;
    if (!snap) save(KW_SNAP_KEY, { at, list: cur, prev: null });
    else if (snap.at !== at) { prev = snap.list; save(KW_SNAP_KEY, { at, list: cur, prev: snap.list }); }
    else prev = snap.prev;
    const tapped = new Set(load(KW_TAP_KEY, []));
    return list.map((k, i) => Object.assign(k, {
      rank: i + 1,
      isNew: !tapped.has(at + "|" + k.keyword) && (prev ? !prev.includes(k.keyword) : k.prevDailyAvg === 0),
    }));
  }

  function isRelevant(a) {
    return (a.companies || []).length || (a.rcompanies || []).length ||
      (a.tabs || []).some((t) => t === "homeshopping" || t === "policy" || t === "ecommerce");
  }

  function matchTitle(kw, since) {
    const parts = kw.split(/\s+/).filter(Boolean);
    return D.articles.filter((a) => !a.noise && a.pubDate && Date.parse(a.pubDate) >= since &&
      parts.every((p) => a.title.includes(p))).sort(byDate);
  }

  // 홈쇼핑 이슈: 이슈 묶음(회사명 또는 홈쇼핑 단어가 제목에) + 묶이지 않은 홈쇼핑 핫이슈 기사
  function hsIssueItems() {
    const topic = D.topics.homeshopping.find((t) => t.id === S.hot.topic);
    const seen = load(ISSUE_SEEN_KEY, {});
    const used = new Set();
    const items = [];
    D.issues.filter((i) => (i.companies || []).length || /홈쇼핑|T커머스/.test(i.title)).forEach((i) => {
      const arts = i.articleIds.map((id) => D.byId.get(id)).filter(Boolean);
      if (topic && topic.match && !arts.some((a) => topicMatch(a, topic.match))) return;
      i.articleIds.forEach((id) => used.add(id));
      const last = Date.parse(i.lastAt);
      items.push({ kind: "issue", id: i.id, title: i.title, co: (i.companies || [])[0], risk: i.riskMax >= 1,
        meta: `기사 ${i.articles} · 보도 ${i.count}`, at: i.lastAt, score: i.count + (i.riskMax || 0) * 3,
        isNew: seen[i.id] ? last > seen[i.id] : D.ref - last < 24 * HOUR });
    });
    const hot = D.articles.filter((a) => !a.noise && (a.tabs || []).includes("homeshopping") &&
      Date.parse(a.pubDate) >= D.ref - 24 * HOUR && !used.has(a.id));
    hot.forEach((a) => {
      if (topic && topic.match && !topicMatch(a, topic.match)) return;
      items.push({ kind: "art", id: a.id, title: a.title, co: (a.mainCompanies || a.companies || [])[0], risk: a.riskScore >= 1,
        meta: a.press || "", at: a.pubDate, score: (a.heat || 1) + (a.riskScore || 0),
        isNew: !seen[a.id] && D.ref - Date.parse(a.pubDate) < 3 * HOUR });
    });
    // 이슈 먼저(점수순), 그다음 단독 기사(점수순)
    return items.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "issue" ? -1 : 1) || (y.score - x.score) || (y.at || "").localeCompare(x.at || "")).slice(0, 40);
  }

  function issueCard(it) {
    const c = coById(it.co);
    return `<button class="card issue-card${it.risk ? " risk" : ""}" data-act="${it.kind}" data-id="${attr(it.id)}">
      ${it.isNew ? '<span class="n-badge">N</span>' : ""}
      <span class="t">${esc(it.title)}</span>
      <span class="m">${c ? `<span class="co-tag" style="--co:${attr(c.color)}">${esc(c.short)}</span>` : ""}${esc(it.meta)} · ${rel(it.at)}</span>
    </button>`;
  }

  /* ================= 홈쇼핑 ================= */

  function hsBase() {
    return D.articles.filter((a) => !a.noise && (a.tabs || []).includes("homeshopping") &&
      (!S.hs.co || (a.mainCompanies || []).includes(S.hs.co)));
  }

  function renderHs() {
    const ui = S.hs;
    const since7 = D.ref - 7 * 24 * HOUR, since48 = D.ref - 48 * HOUR;
    const hs7 = D.articles.filter((a) => !a.noise && (a.tabs || []).includes("homeshopping") && Date.parse(a.pubDate) >= since7);
    let h = "";

    // ① 12개사 슬라이서 — 얇은 텍스트 4×3, 헤더 아래 고정. '전체' 버튼 대신 선택한 회사를 다시 누르면 해제
    h += '<nav class="co-band" id="coBand" aria-label="홈쇼핑사"><div class="co-band-in">' + D.config.companies.map((c) => {
      const n = hs7.filter((a) => (a.mainCompanies || []).includes(c.id)).length;
      const risk = hs7.some((a) => a.riskScore >= 1 && Date.parse(a.pubDate) >= since48 && (a.mainCompanies || []).includes(c.id));
      return `<button class="co-cell${ui.co === c.id ? " on" : ""}" style="--co:${attr(c.color)}" data-act="co" data-id="${c.id}" aria-pressed="${ui.co === c.id}" title="${attr(c.name)} · 7일 주요 기사 ${n}건${risk ? " · 48시간 내 리스크" : ""}">
        <span class="nm">${esc(CO_LABEL[c.id] || c.short)}</span><span class="n">${n}</span>${risk ? '<span class="rk"></span>' : ""}</button>`;
    }).join("") + "</div>";
    const selCo = coById(ui.co);
    const selN = selCo ? hs7.filter((a) => (a.mainCompanies || []).includes(selCo.id)).length : hs7.length;
    h += `<div class="co-band-mini"><button class="bm-co" data-act="bandOpen" style="--co:${attr(selCo ? selCo.color : "var(--ink)")}" aria-label="회사 선택 펼치기">
        <b>${esc(selCo ? (CO_LABEL[selCo.id] || selCo.short) : "전체")}</b><span class="n">${selN}</span> ▾</button>
      <span class="what" id="miniWhat"></span><button class="fold" data-act="toTop">필터 ▴</button></div></nav>`;
    h += '<div class="band-spacer" id="bandSpacer"></div>';
    h += '<div id="controls"><section class="sec" style="margin-top:10px">';

    // ② 한 줄 요약 카드 + 펼치기
    h += renderSummary(hs7) + "</section>";

    // ③ 필터: 키워드 검색 / 정렬 / 기간 / 주제(접기)
    h += filterBlock(ui, "hs");
    h += "</div>";
    h += `<div id="list">${listBlock(applyFilters(hsBase(), ui, D.topics.homeshopping), ui)}</div>`;
    return h;
  }

  function renderSummary(hs7) {
    const ui = S.hs;
    const c = coById(ui.co);
    const color = c ? c.color : "var(--ink)";
    const mine = hs7.filter((a) => !c || (a.mainCompanies || []).includes(c.id));
    const risk = mine.filter((a) => a.riskScore >= 1).length;
    let h = `<div class="card summary" style="--co:${attr(color)}">
      <button class="sum-line" data-act="sum" aria-expanded="${ui.sumOpen}">
        <span class="co-tag">${c ? esc(c.short) : "ALL"}</span>
        <span class="name">${c ? esc(c.name) : "홈쇼핑 전체"}</span>
        <span class="stat">7일 ${mine.length}건${risk ? ` · 리스크 ${risk}` : ""}</span>
        <span class="fold">${ui.sumOpen ? "접기 ▴" : "펼치기 ▾"}</span>
      </button>`;
    if (ui.sumOpen) {
      const days = [];
      for (let i = 6; i >= 0; i--) days.push(ymd(new Date(D.ref - i * 24 * HOUR)));
      const per = days.map((d) => mine.filter((a) => a.pubDate.slice(0, 10) === d).length);
      const max = Math.max(1, ...per);
      const spark = per.map((n, i) => `<i style="height:${Math.max(1, Math.round(n / max * 18))}px" title="${days[i].slice(5)} ${n}건"></i>`).join("");
      let second;
      if (c) {
        const total = hs7.reduce((s, a) => s + (a.mainCompanies || []).length, 0);
        const share = total ? Math.round(mine.length / total * 1000) / 10 : 0;
        second = `<div class="kpi"><div class="l">보도 점유율</div><div class="v">${share}<small>%</small></div></div>`;
      } else {
        second = `<div class="kpi"><div class="l">리스크 기사</div><div class="v${risk ? " risk" : ""}">${risk}<small>건</small></div></div>`;
      }
      const top = topTokens(mine, 3);
      h += `<div class="sum-body">
        <div class="kpi"><div class="l">7일 기사</div><div class="v">${mine.length}<small>건</small></div><div class="spark">${spark}</div></div>
        ${second}
        <div class="kpi"><div class="l">KEYWORD TOP3</div><div class="kw-top">${top.length ? top.map((t) =>
          `<span role="button" data-act="setq" data-q="${attr(t)}">${esc(t)}</span>`).join("") : '<span style="border:0">-</span>'}</div></div>
      </div>`;
    }
    return h + "</div>";
  }

  /* ================= 발견 ================= */

  function discoverBase() {
    return D.articles.filter((a) => !a.noise);
  }

  function renderDiscover() {
    const ui = S.discover;
    const topic = D.topics.discover.find((t) => t.id === ui.topic);
    let h = '<div id="controls"><section class="sec" style="margin-top:12px">';
    h += '<div class="chips">' + D.topics.discover.map((t) =>
      `<button class="chip${t.risk ? " risk" : ""}${ui.topic === t.id ? " on" : ""}" data-act="dTopic" data-id="${t.id}">${esc(t.label)}${t.risk ? " ⚠" : ""}</button>`).join("") + "</div>";
    // 이 주제의 이슈 (가로 스크롤)
    const issues = D.issues.filter((i) => {
      if (!topic || !topic.match) return true;
      return i.articleIds.some((id) => { const a = D.byId.get(id); return a && topicMatch(a, topic.match); });
    }).sort((x, y) => (y.count + y.riskMax * 3) - (x.count + x.riskMax * 3)).slice(0, 10);
    if (issues.length) {
      h += `<div class="sec-head" style="margin-top:14px"><h2 class="sec-title">${esc(topic ? topic.label : "전체")} 이슈</h2><span class="sec-right">72시간 · 보도 많은 순</span></div>`;
      h += '<div class="chips scroll" style="gap:8px">' + issues.map((i) =>
        `<button class="card issue-card${i.riskMax >= 1 ? " risk" : ""}" style="flex:0 0 200px" data-act="issue" data-id="${attr(i.id)}">
          <span class="t">${esc(i.title)}</span><span class="m">기사 ${i.articles} · 보도 ${i.count} · ${rel(i.lastAt)}</span></button>`).join("") + "</div>";
    }
    h += "</section>";
    h += filterBlock(ui, "discover");
    h += "</div>" + miniBar();
    h += `<div id="list">${listBlock(applyFilters(discoverBase(), ui, D.topics.discover), ui)}</div>`;
    return h;
  }

  /* ================= 공통 필터 / 목록 ================= */

  function filterBlock(ui, scope) {
    const topics = scope === "hs" ? D.topics.homeshopping : null;
    let h = `<div class="card filters">
      <div class="f-row">
        <label class="f-search"><input type="search" data-act="q" value="${attr(ui.q)}" placeholder="키워드 검색" aria-label="키워드 검색">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></label>
        <div class="seg">${seg("sort", "latest", "최신순", ui.sort)}${seg("sort", "heat", "화제순", ui.sort)}</div>
      </div>
      <div class="f-row"><span class="f-label">기간</span><div class="seg">${seg("period", 0, "전체", ui.period)}${seg("period", 1, "오늘", ui.period)}${seg("period", 3, "3일", ui.period)}${seg("period", 7, "7일", ui.period)}</div></div>`;
    if (topics) {
      h += `<div class="topic-head"><span class="f-label" style="width:auto">주제${ui.topic !== "all" ? ` · <b style="color:var(--ink)">${esc(topics.find((t) => t.id === ui.topic).label)}</b>` : ""}</span>
        <button class="fold" data-act="topicFold">${ui.topicOpen ? "접기 ▴" : "펼치기 ▾"}</button></div>`;
      if (ui.topicOpen) {
        h += '<div class="chips">' + topics.map((t) =>
          `<button class="chip${t.risk ? " risk" : ""}${ui.topic === t.id ? " on" : ""}" data-act="topic" data-id="${t.id}">${esc(t.label)}</button>`).join("") + "</div>";
      }
    }
    return h + "</div>";
  }

  function seg(key, val, label, cur) {
    return `<button class="${cur === val ? "on" : ""}" data-act="seg" data-k="${key}" data-v="${val}">${label}</button>`;
  }

  function topicList(view) { return view === "hs" ? D.topics.homeshopping : D.topics.discover; }

  function applyFilters(arts, ui, topics) {
    const topic = topics.find((t) => t.id === ui.topic);
    let out = arts;
    if (topic && topic.match) out = out.filter((a) => topicMatch(a, topic.match));
    if (ui.period === 1) { const today = ymd(new Date(D.ref)); out = out.filter((a) => (a.pubDate || "").slice(0, 10) === today); }
    else if (ui.period) { const since = D.ref - ui.period * 24 * HOUR; out = out.filter((a) => Date.parse(a.pubDate) >= since); }
    if (ui.q) out = out.filter(queryFn(ui.q));
    return out.slice().sort(ui.sort === "heat"
      ? (x, y) => ((y.heat || 1) + (y.riskScore || 0)) - ((x.heat || 1) + (x.riskScore || 0)) || byDate(x, y)
      : byDate);
  }

  function topicMatch(a, m) {
    if (m.tabs && m.tabs.some((t) => (a.tabs || []).includes(t))) return true;
    if (m.cats && m.cats.some((c) => (a.categories || []).includes(c))) return true;
    if (m.risk && a.riskScore >= 1) return true;
    if (m.rcompanies && (a.rcompanies || []).length) return true;
    if (m.keywords) { const t = a.title + " " + (a.description || ""); if (m.keywords.some((k) => t.includes(k))) return true; }
    return false;
  }

  function queryFn(q) {
    const parts = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (a) => { const t = (a.title + " " + (a.description || "")).toLowerCase(); return parts.every((p) => t.includes(p)); };
  }

  function listBlock(arts, ui) {
    if (!arts.length) return '<div class="empty">조건에 맞는 기사가 없어요.</div>';
    const shown = arts.slice(0, ui.limit);
    return `<div class="list-head"><b>기사 ${arts.length.toLocaleString()}건</b><span>${ui.sort === "heat" ? "보도량+리스크 순" : "최신순"}</span></div>
      <div class="arts">${shown.map(artCard).join("")}</div>
      ${arts.length > shown.length ? `<button class="more" data-act="more">더 보기 (${(arts.length - shown.length).toLocaleString()}건 남음)</button>` : ""}`;
  }

  function artCard(a) {
    const url = a.link || a.originallink || "#";
    const press = a.press || host(a.originallink || a.link);
    const on = !!S.bookmarks[a.id];
    const img = a.image
      ? `<img src="${attr(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="width:100%;height:100%;object-fit:cover" onerror="this.remove()">`
      : "";
    return `<article class="art${a.riskScore >= 1 ? " risk" : ""}">
      <a class="thumb" href="${attr(url)}" target="_blank" rel="noopener" aria-hidden="true" tabindex="-1">${img || esc((press || "·").slice(0, 2))}</a>
      <div class="art-main">
        <a href="${attr(url)}" target="_blank" rel="noopener" data-open="${a.id}">
          <div class="art-title">${esc(a.title)}</div>
          ${a.description ? `<div class="art-desc">${esc(a.description)}</div>` : ""}
        </a>
        <div class="art-foot"><span class="press">${esc(press)}</span><span>·</span><span>${fmt(a.pubDate)}</span>${a.heat > 1 ? `<span class="heat">보도 ${a.heat}건</span>` : ""}</div>
      </div>
      <button class="star${on ? " on" : ""}" data-act="star" data-id="${a.id}" aria-label="즐겨찾기" aria-pressed="${on}">${on ? "★" : "☆"}</button>
    </article>`;
  }

  /* ----- 컨트롤이 화면 밖으로 나가면 헤더 아래 미니 바 ----- */

  function miniBar() {
    return '<div class="mini-bar" id="miniBar"><div class="mini-in"><span class="what" id="miniWhat"></span><button class="fold" data-act="toTop">필터 ▴</button></div></div>';
  }

  function updateMiniBar() {
    const el = document.getElementById("miniWhat");
    if (!el) return;
    const ui = S.view === "hs" ? S.hs : S.discover;
    const topics = topicList(S.view);
    const bits = [];
    if (S.view !== "hs") bits.push("발견");
    const t = topics.find((x) => x.id === ui.topic);
    if (t && t.id !== "all") bits.push(t.label);
    if (ui.period) bits.push(ui.period === 1 ? "오늘" : `${ui.period}일`);
    if (ui.q) bits.push(`"${ui.q}"`);
    if (S.view === "hs") { el.innerHTML = bits.length ? `<span>${esc(bits.join(" · "))}</span>` : '<span>필터 없음</span>'; return; }
    el.innerHTML = esc(bits[0]) + (bits.length > 1 ? ` <span>· ${esc(bits.slice(1).join(" · "))}</span>` : "");
  }

  /* ----- 홈쇼핑 회사 배너: 아래로 스크롤하면 한 줄로 접고, 위로 올리면 다시 펼침 ----- */

  let lastY = 0;
  function setBandH() {
    const band = document.getElementById("coBand");
    document.documentElement.style.setProperty("--band-h", band ? band.offsetHeight + "px" : "0px");
  }
  function setBandCollapsed(on) {
    const band = document.getElementById("coBand");
    if (!band || band.classList.contains("collapsed") === on) return;
    band.classList.toggle("collapsed", on);
    setBandH();
  }
  window.addEventListener("scroll", () => {
    const y = window.scrollY;
    if (y < 120) setBandCollapsed(false);
    else if (y > lastY + 6) setBandCollapsed(true);
    else if (y < lastY - 6) setBandCollapsed(false);
    if (Math.abs(y - lastY) > 6) lastY = y;
  }, { passive: true });

  let miniObs = null;
  function bindMiniBar() {
    if (miniObs) { miniObs.disconnect(); miniObs = null; }
    if (document.getElementById("coBand")) updateMiniBar();
    const ctl = document.getElementById("controls"), bar = document.getElementById("miniBar");
    if (!ctl || !bar) return;
    updateMiniBar();
    miniObs = new IntersectionObserver(([e]) => bar.classList.toggle("show", !e.isIntersecting && e.boundingClientRect.top < 0),
      { rootMargin: `-${60 + ((document.getElementById("coBand") || {}).offsetHeight || 0)}px 0px 0px 0px` });
    miniObs.observe(ctl);
  }

  /* ================= 스크랩 / 검색 ================= */

  function renderScrap() {
    const arts = Object.values(S.bookmarks).sort((x, y) => (y.savedAt || y.pubDate || "").localeCompare(x.savedAt || x.pubDate || ""));
    let h = `<section class="sec"><div class="sec-head"><h2 class="sec-title">스크랩</h2><span class="sec-right">이 기기에 저장 · 7일 지나도 유지</span></div>`;
    h += arts.length ? `<div class="arts">${arts.map(artCard).join("")}</div>` : '<div class="empty">☆을 눌러 기사를 저장해 보세요.</div>';
    return h + "</section>";
  }

  function renderSearch() {
    const arts = D.articles.filter(queryFn(S.search.q)).sort(byDate);
    const ui = { limit: S.search.limit || LIST_STEP, sort: "latest" };
    return `<section class="sec"><div class="sec-head"><h2 class="sec-title">"${esc(S.search.q)}" 검색 결과</h2><span class="sec-right">최근 7일 전체 기사</span></div>${listBlock(arts, ui)}</section>`;
  }

  /* ================= 바텀 시트 ================= */

  function openSheet(title, sub, bodyHtml) {
    document.getElementById("sheetTitle").textContent = title;
    document.getElementById("sheetBody").innerHTML = (sub ? `<div class="sheet-sub">${sub}</div>` : "") + bodyHtml;
    $sheet.hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeSheet() { $sheet.hidden = true; document.body.style.overflow = ""; }

  function openKeyword(kw) {
    const at = D.trending.generatedAt || "";
    const tapped = load(KW_TAP_KEY, []);
    if (!tapped.includes(at + "|" + kw)) save(KW_TAP_KEY, tapped.concat(at + "|" + kw).slice(-200));
    const arts = matchTitle(kw, D.ref - 72 * HOUR);
    openSheet(`🔍 ${kw}`, `최근 72시간 제목에 이 키워드가 들어간 기사 ${arts.length}건`,
      arts.length ? `<div class="arts">${arts.slice(0, 80).map(artCard).join("")}</div>` : '<div class="empty">기사가 없어요.</div>');
  }

  function openIssue(id) {
    const i = D.issues.find((x) => x.id === id);
    if (!i) return;
    markSeen(id);
    const arts = i.articleIds.map((x) => D.byId.get(x)).filter(Boolean).sort(byDate);
    const groups = [];
    arts.forEach((a) => {
      const d = a.pubDate.slice(0, 10);
      if (!groups.length || groups[groups.length - 1].d !== d) groups.push({ d, items: [] });
      groups[groups.length - 1].items.push(a);
    });
    const rep = D.byId.get(i.repArticleId);
    const body = (rep && rep.description ? `<div class="tip">${esc(rep.description)}</div>` : "") +
      groups.map((g) => `<div class="tl-date">${g.d.replace(/-/g, ".")}</div><div class="arts">${g.items.map(artCard).join("")}</div>`).join("");
    openSheet(i.title, `기사 ${i.articles}건 · 전재 포함 보도 ${i.count}건 · ${fmt(i.firstAt)} ~ ${fmt(i.lastAt)}`, body);
  }

  function openArticle(id) {
    const a = D.byId.get(id);
    if (!a) return;
    markSeen(id);
    openSheet(a.title, "", `<div class="arts">${artCard(a)}</div>`);
  }

  function markSeen(id) {
    const seen = load(ISSUE_SEEN_KEY, {});
    seen[id] = Date.now();
    save(ISSUE_SEEN_KEY, seen);
    const card = document.querySelector(`.issue-card[data-id="${CSS.escape(id)}"] .n-badge`);
    if (card) card.remove();
  }

  /* ================= 이벤트 ================= */

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) return closeSheet();
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act, id = el.dataset.id;
    const ui = S.view === "hs" ? S.hs : S.discover;
    switch (act) {
      case "tip": S.hot[el.dataset.k] = !S.hot[el.dataset.k]; render(); break;
      case "hotTopicOpen": S.hot.topicOpen = !S.hot.topicOpen; render(); break;
      case "hotTopic": S.hot.topic = id; render(); break;
      case "kw": openKeyword(el.dataset.kw); el.querySelector(".n-badge") && el.querySelector(".n-badge").remove(); break;
      case "issue": openIssue(id); break;
      case "art": openArticle(id); break;
      case "co": location.hash = S.hs.co === id ? "#/hs" : `#/hs/${id}`; break;
      case "sum": S.hs.sumOpen = !S.hs.sumOpen; saveUi(); render(); break;
      case "topicFold": S.hs.topicOpen = !S.hs.topicOpen; saveUi(); render(); break;
      case "topic": S.hs.topic = id; S.hs.limit = LIST_STEP; render(); break;
      case "dTopic": S.discover.topic = id; S.discover.limit = LIST_STEP; render(); break;
      case "seg": ui[el.dataset.k] = el.dataset.k === "period" ? Number(el.dataset.v) : el.dataset.v; ui.limit = LIST_STEP; render(); break;
      case "setq": S.hs.q = el.dataset.q; S.hs.limit = LIST_STEP; render(); break;
      case "more":
        if (S.search.open && S.search.q) { S.search.limit = (S.search.limit || LIST_STEP) + LIST_STEP; render(); }
        else { ui.limit += LIST_STEP; renderListOnly(); }
        break;
      case "bandOpen": setBandCollapsed(false); break;
      case "toTop": window.scrollTo({ top: 0, behavior: "smooth" }); break;
      case "star": toggleStar(id, el); break;
      default: break;
    }
  });

  document.addEventListener("input", (e) => {
    if (e.target.dataset && e.target.dataset.act === "q") {
      const ui = S.view === "hs" ? S.hs : S.discover;
      ui.q = e.target.value.trim();
      ui.limit = LIST_STEP;
      renderListOnly();
    }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

  // 상단 돋보기: 검색줄 열기/닫기
  const $sRow = document.getElementById("searchRow"), $sIn = document.getElementById("searchInput"), $sBtn = document.getElementById("searchBtn");
  $sBtn.addEventListener("click", () => {
    S.search.open = !S.search.open;
    $sRow.hidden = !S.search.open;
    $sBtn.classList.toggle("on", S.search.open);
    if (S.search.open) $sIn.focus(); else { S.search.q = ""; $sIn.value = ""; render(); }
  });
  document.getElementById("searchClose").addEventListener("click", () => $sBtn.click());
  $sIn.addEventListener("input", () => { S.search.q = $sIn.value.trim(); S.search.limit = LIST_STEP; render(); });

  function toggleStar(id, btn) {
    if (S.bookmarks[id]) delete S.bookmarks[id];
    else {
      const a = D.byId.get(id);
      if (!a) return;
      S.bookmarks[id] = Object.assign({}, a, { savedAt: new Date().toISOString() });
    }
    save(BOOKMARK_KEY, S.bookmarks);
    const on = !!S.bookmarks[id];
    document.querySelectorAll(`.star[data-id="${CSS.escape(id)}"]`).forEach((b) => {
      b.classList.toggle("on", on); b.textContent = on ? "★" : "☆"; b.setAttribute("aria-pressed", on);
    });
    if (S.view === "scrap" && !on && btn.closest("#main")) render();
  }

  /* ----- 페이저(좌우 넘김) ----- */

  function pager(pages) {
    return `<div class="pager">${pages.map((p) => `<div class="page">${p}</div>`).join("")}</div>` +
      (pages.length > 1 ? `<div class="dots">${pages.map((_, i) => `<button class="${i ? "" : "on"}" aria-label="${i + 1}페이지"></button>`).join("")}</div>` : "");
  }

  function bindPagers() {
    document.querySelectorAll(".pager").forEach((pg) => {
      const dots = pg.nextElementSibling && pg.nextElementSibling.classList.contains("dots") ? [...pg.nextElementSibling.children] : [];
      if (!dots.length) return;
      pg.addEventListener("scroll", () => {
        const i = Math.round(pg.scrollLeft / pg.clientWidth);
        dots.forEach((d, j) => d.classList.toggle("on", i === j));
      }, { passive: true });
      dots.forEach((d, j) => d.addEventListener("click", () => pg.scrollTo({ left: j * (pg.clientWidth + 12), behavior: "smooth" })));
    });
  }

  /* ================= 유틸 ================= */

  // 회사 기사 제목에서 많이 나온 단어 TOP N (회사명·불용어 제외)
  function topTokens(arts, n) {
    const cnt = new Map();
    arts.forEach((a) => {
      const toks = new Set();
      (a.title.match(/[가-힣A-Za-z0-9]{2,}/g) || []).forEach((t) => {
        if (/^\d/.test(t)) return;
        let w = t;
        const m = w.length > 2 && w.match(/(으로|은|는|이|가|을|를|에|의|도|와|과|로|서)$/);
        if (m && w.length - m[1].length >= 2) w = w.slice(0, -m[1].length);
        if (D.stop.has(w) || D.coNames.some((c) => c && (c.includes(w) || w.includes(c)))) return;
        toks.add(w);
      });
      toks.forEach((t) => cnt.set(t, (cnt.get(t) || 0) + 1));
    });
    return [...cnt.entries()].filter(([, c]) => c >= 2).sort((x, y) => y[1] - x[1]).slice(0, n).map(([t]) => t);
  }

  function coById(id) { return id ? D.config.companies.find((c) => c.id === id) : null; }
  function byDate(x, y) { return (y.pubDate || "").localeCompare(x.pubDate || ""); }
  function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
  function ymd(d) { return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); }
  function fmt(iso) { return iso ? `${iso.slice(2, 4)}.${iso.slice(5, 7)}.${iso.slice(8, 10)} ${iso.slice(11, 16)}` : ""; }
  function rel(iso) {
    const t = Date.parse(iso);
    if (isNaN(t)) return "";
    const m = Math.floor((Date.now() - t) / 60e3);
    if (m < 1) return "방금";
    if (m < 60) return `${m}분 전`;
    if (m < 1440) return `${Math.floor(m / 60)}시간 전`;
    return `${Math.floor(m / 1440)}일 전`;
  }
  function host(u) { try { return new URL(u).hostname.replace(/^(www|m|news)\./, ""); } catch (e) { return ""; } }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function attr(s) { return esc(s); }
  function get(p) { return fetch(p, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null); }
  function load(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 불가 — 무시 */ } }
  function saveUi() { save(UI_KEY, { sumOpen: S.hs.sumOpen, hsTopicOpen: S.hs.topicOpen }); }
})();

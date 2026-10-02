/* hdnews 홈·이슈 타임라인 공용 로직 — DOM 없이 동작하는 순수 함수 모음.
   브라우저에서는 window.HdCore, Node 테스트에서는 module.exports 로 노출된다. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HdCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const HOUR = 3600e3;
  const VIEWS = ["home", "discover", "issues", "issue", "companies", "company", "topic", "risk",
    "trending", "hot", "retail", "homeshopping", "scrap"];
  const TOPIC_ALIASES = ["risk", "policy", "ecommerce"];   // 구버전 #/risk, #/policy 류 → 주제 페이지

  /* ----- 시각 ----- */

  function relativeTime(iso, nowMs) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (isNaN(t)) return "";
    const min = Math.floor(((nowMs || Date.now()) - t) / 60e3);
    if (min < 1) return "방금 전";
    if (min < 60) return `${min}분 전`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}시간 전`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}일 전`;
    const d = new Date(t);
    return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  }

  function compressLabel(count) {
    return `${count}개의 기사를 압축했어요`;
  }

  /* ----- 라우팅 ----- */

  function parseHash(hash) {
    let h = String(hash || "").replace(/^#\/?/, "");
    try { h = decodeURIComponent(h); } catch (e) { /* 깨진 인코딩은 그대로 */ }
    const query = {};
    const qi = h.indexOf("?");
    if (qi >= 0) {
      new URLSearchParams(h.slice(qi + 1)).forEach((v, k) => { query[k] = v; });
      h = h.slice(0, qi);
    }
    const seg = h.split("/").filter(Boolean);
    const view = seg[0] || "home";
    const param = seg.slice(1).join("/");
    if (TOPIC_ALIASES.includes(view) && !param) return { view: "topic", param: view, query };
    if (!VIEWS.includes(view)) return { view: "retail", param: "", query };   // 구버전 해시(#/dashboard 등)
    return { view, param, query };
  }

  /* ----- 이슈 열람 / 팔로우 ----- */

  // 처음 보는 이슈는 최근 24시간 것만 NEW (첫 방문에 수백 개가 전부 NEW 로 보이지 않게), 본 적 있으면 그 뒤 새 기사가 붙었을 때
  function issueIsNew(issue, seenAtMs, nowMs) {
    const last = Date.parse(issue.lastAt);
    if (!seenAtMs) return (nowMs || Date.now()) - last < 24 * HOUR;
    return last > seenAtMs;
  }

  function followHasNew(issue, follow) {
    const seen = follow && follow.seenLastAt ? Date.parse(follow.seenLastAt) : 0;
    return Date.parse(issue.lastAt) > seen;
  }

  // 수집기가 이슈를 합치면 prevIds 에 이전 id 를 남긴다 → 팔로우를 새 id 로 옮긴다.
  function migrateFollows(follows, issues) {
    const ids = new Set(issues.map((i) => i.id));
    const movedTo = new Map();
    issues.forEach((i) => (i.prevIds || []).forEach((p) => movedTo.set(p, i.id)));
    const out = {};
    const moved = [];
    Object.entries(follows || {}).forEach(([id, f]) => {
      if (ids.has(id)) { out[id] = f; return; }
      const to = movedTo.get(id);
      if (to) {
        if (!out[to]) out[to] = f;
        moved.push([id, to]);
      } else {
        out[id] = f;   // 72시간 창에서 내려간 이슈 — '종료됨'으로 남겨 해제할 수 있게 한다
      }
    });
    return { follows: out, moved };
  }

  function endedFollowIds(follows, issues) {
    const ids = new Set(issues.map((i) => i.id));
    return Object.keys(follows || {}).filter((id) => !ids.has(id));
  }

  /* ----- 바로가기 ----- */

  function articleMatches(a, target) {
    const tabs = a.tabs || [];
    switch (target && target.type) {
      case "tab":
        if (target.value === "scrap") return false;
        return target.value === "retail" ? true : tabs.includes(target.value);
      case "topic":
        return tabs.includes(target.value);
      case "risk":
        return (a.riskCategories || []).includes(target.value);
      case "company":
        return (a.mainCompanies || []).includes(target.value);
      case "query": {
        const parts = String(target.value || "").toLowerCase().split(/\s+/).filter(Boolean);
        const text = `${a.title || ""} ${a.description || ""}`.toLowerCase();
        return parts.length > 0 && parts.every((p) => text.includes(p));
      }
      default:
        return false;
    }
  }

  // ctx: { articles, seenAtMs, nowMs, briefingAt, trendingAt }
  function newCountFor(target, ctx) {
    const nowMs = ctx.nowMs || Date.now();
    const type = target && target.type;
    if (type === "hot" || type === "trending") {
      const at = type === "hot" ? ctx.briefingAt : ctx.trendingAt;
      if (!at) return 0;
      return !ctx.seenAtMs || Date.parse(at) > ctx.seenAtMs ? 1 : 0;
    }
    const since = ctx.seenAtMs || nowMs - 24 * HOUR;
    let n = 0;
    (ctx.articles || []).forEach((a) => {
      if (a.noise || !a.pubDate) return;
      if (Date.parse(a.pubDate) > since && articleMatches(a, target)) n++;
    });
    return n;
  }

  /* ----- 회사 배지 ----- */

  // 최근 24시간 주요 기사 수 상위 3개사 '인기'(hot), 24시간 내 리스크 기사가 있으면 '주의'(risk) 우선
  function companyBadges(companies, articles, nowMs) {
    const since = (nowMs || Date.now()) - 24 * HOUR;
    const count = {};
    const risk = new Set();
    (articles || []).forEach((a) => {
      if (a.noise || !a.pubDate || Date.parse(a.pubDate) < since) return;
      (a.mainCompanies || []).forEach((c) => {
        count[c] = (count[c] || 0) + 1;
        if (a.riskScore >= 1) risk.add(c);
      });
    });
    const hot = Object.entries(count)
      .sort((x, y) => (y[1] - x[1]) || x[0].localeCompare(y[0]))
      .slice(0, 3)
      .map(([id]) => id);
    const out = {};
    (companies || []).forEach((c) => {
      if (risk.has(c.id)) out[c.id] = "risk";
      else if (hot.includes(c.id)) out[c.id] = "hot";
    });
    return out;
  }

  /* ----- 타임라인 ----- */

  function groupByDate(articles) {
    const sorted = (articles || []).slice().sort((x, y) => (y.pubDate || "").localeCompare(x.pubDate || ""));
    const groups = [];
    sorted.forEach((a) => {
      const date = (a.pubDate || "").slice(0, 10);
      const last = groups[groups.length - 1];
      if (last && last.date === date) last.items.push(a);
      else groups.push({ date, items: [a] });
    });
    return groups;
  }

  /* ----- 이슈 목록 ----- */

  function issueScore(issue) {
    return (issue.count || 0) + (issue.riskMax || 0) * 3;
  }

  function sortByScore(issues) {
    return (issues || []).slice().sort((x, y) => (issueScore(y) - issueScore(x)) || (y.lastAt || "").localeCompare(x.lastAt || ""));
  }

  // opts: { cat, onlyFollowed, follows } — cat 'retail' 은 홈쇼핑 이슈를 뺀 유통 일반
  function filterIssues(issues, opts) {
    const o = opts || {};
    let list = issues || [];
    if (o.cat && o.cat !== "all") {
      list = o.cat === "retail"
        ? list.filter((i) => !(i.tabs || []).includes("homeshopping"))
        : list.filter((i) => (i.tabs || []).includes(o.cat));
    }
    if (o.onlyFollowed) list = list.filter((i) => o.follows && o.follows[i.id]);
    return list;
  }

  return {
    relativeTime, compressLabel, parseHash,
    issueIsNew, followHasNew, migrateFollows, endedFollowIds,
    articleMatches, newCountFor, companyBadges,
    groupByDate, issueScore, sortByScore, filterIssues,
  };
});

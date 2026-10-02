// 홈/이슈 타임라인의 순수 로직 테스트 — 실행: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../assets/issues-core.js");

const H = 3600e3;
const NOW = Date.parse("2026-10-02T09:00:00+09:00");
const iso = (hoursAgo) => new Date(NOW - hoursAgo * H).toISOString();

test("relativeTime: 뉴닉식 상대 시각", () => {
  assert.equal(Core.relativeTime(iso(0.005), NOW), "방금 전");
  assert.equal(Core.relativeTime(new Date(NOW - 46 * 60e3).toISOString(), NOW), "46분 전");
  assert.equal(Core.relativeTime(iso(8), NOW), "8시간 전");
  assert.equal(Core.relativeTime(iso(49), NOW), "2일 전");
  assert.equal(Core.relativeTime("2026-09-10T10:00:00+09:00", NOW), "9월 10일");
  assert.equal(Core.compressLabel(90), "90개의 기사를 압축했어요");
});

test("parseHash: 새 라우트와 구버전 해시", () => {
  assert.deepEqual(Core.parseHash(""), { view: "home", param: "", query: {} });
  assert.deepEqual(Core.parseHash("#/issue/is-abc"), { view: "issue", param: "is-abc", query: {} });
  assert.deepEqual(Core.parseHash("#/issues?cat=risk&f=follow"), { view: "issues", param: "", query: { cat: "risk", f: "follow" } });
  assert.deepEqual(Core.parseHash("#/topic/risk"), { view: "topic", param: "risk", query: {} });
  assert.deepEqual(Core.parseHash("#/risk/legal"), { view: "risk", param: "legal", query: {} });
  assert.deepEqual(Core.parseHash("#/company/hyundai"), { view: "company", param: "hyundai", query: {} });
  assert.deepEqual(Core.parseHash("#/retail?q=%EC%86%A1%EC%B6%9C"), { view: "retail", param: "", query: { q: "송출" } });
  assert.equal(Core.parseHash("#/dashboard").view, "retail");          // 구버전
  assert.deepEqual(Core.parseHash("#/risk"), { view: "topic", param: "risk", query: {} });
  assert.deepEqual(Core.parseHash("#/policy"), { view: "topic", param: "policy", query: {} });
});

test("issueIsNew / followHasNew: 마지막 기사 시각과 열람 시각 비교", () => {
  const issue = { id: "is-1", lastAt: "2026-10-02T08:00:00+09:00" };
  assert.equal(Core.issueIsNew(issue, undefined, NOW), true);                 // 처음 보는 최근 이슈
  assert.equal(Core.issueIsNew({ lastAt: "2026-09-30T08:00:00+09:00" }, undefined, NOW), false);  // 처음이지만 24시간 지남
  assert.equal(Core.issueIsNew(issue, Date.parse("2026-10-02T07:00:00+09:00"), NOW), true);
  assert.equal(Core.issueIsNew(issue, Date.parse("2026-10-02T08:30:00+09:00"), NOW), false);
  assert.equal(Core.followHasNew(issue, { seenLastAt: "2026-10-01T23:00:00+09:00" }), true);
  assert.equal(Core.followHasNew(issue, { seenLastAt: "2026-10-02T08:00:00+09:00" }), false);
  assert.equal(Core.followHasNew(issue, {}), true);
});

test("migrateFollows: 합쳐진 이슈로 팔로우 이동, 사라진 이슈는 종료로 유지", () => {
  const issues = [{ id: "is-new", prevIds: ["is-old"], lastAt: iso(1) }, { id: "is-keep", lastAt: iso(2) }];
  const follows = {
    "is-old": { followedAt: iso(30), seenLastAt: iso(10) },
    "is-keep": { followedAt: iso(20), seenLastAt: iso(2) },
    "is-gone": { followedAt: iso(80), seenLastAt: iso(75) },
  };
  const r = Core.migrateFollows(follows, issues);
  assert.deepEqual(Object.keys(r.follows).sort(), ["is-gone", "is-keep", "is-new"]);
  assert.equal(r.follows["is-new"].seenLastAt, iso(10));
  assert.deepEqual(r.moved, [["is-old", "is-new"]]);
  assert.deepEqual(Core.endedFollowIds(r.follows, issues), ["is-gone"]);
});

const ARTS = [
  { id: "a", pubDate: iso(1), tabs: ["retail", "risk"], riskCategories: ["legal"], riskScore: 2, mainCompanies: ["lotte"], companies: ["lotte"], title: "롯데홈쇼핑 소송", description: "" },
  { id: "b", pubDate: iso(3), tabs: ["retail", "homeshopping"], riskCategories: [], riskScore: 0, mainCompanies: ["gsshop"], companies: ["gsshop", "cj"], title: "GS샵 송출수수료 협상", description: "CJ온스타일 언급" },
  { id: "c", pubDate: iso(30), tabs: ["retail", "policy"], riskCategories: [], riskScore: 0, mainCompanies: [], companies: [], title: "송출수수료 제도 개선", description: "" },
  { id: "n", pubDate: iso(0.5), tabs: ["retail", "risk"], riskCategories: ["legal"], riskScore: 3, mainCompanies: [], companies: [], title: "노이즈", description: "", noise: true },
];

test("articleMatches: 바로가기 대상 판정", () => {
  assert.equal(Core.articleMatches(ARTS[0], { type: "topic", value: "risk" }), true);
  assert.equal(Core.articleMatches(ARTS[1], { type: "topic", value: "risk" }), false);
  assert.equal(Core.articleMatches(ARTS[0], { type: "risk", value: "legal" }), true);
  assert.equal(Core.articleMatches(ARTS[1], { type: "tab", value: "homeshopping" }), true);
  assert.equal(Core.articleMatches(ARTS[2], { type: "tab", value: "retail" }), true);
  assert.equal(Core.articleMatches(ARTS[1], { type: "company", value: "cj" }), false);     // 언급만으로는 아님
  assert.equal(Core.articleMatches(ARTS[1], { type: "company", value: "gsshop" }), true);
  assert.equal(Core.articleMatches(ARTS[1], { type: "query", value: "송출수수료 협상" }), true);
  assert.equal(Core.articleMatches(ARTS[2], { type: "query", value: "송출수수료 협상" }), false);
});

test("newCountFor: 마지막으로 본 뒤 새 기사 수 (노이즈 제외, 미열람은 24시간 기준)", () => {
  const ctx = { articles: ARTS, nowMs: NOW, briefingAt: iso(0.2), trendingAt: iso(0.2) };
  assert.equal(Core.newCountFor({ type: "topic", value: "risk" }, { ...ctx, seenAtMs: 0 }), 1);          // a만 (n은 노이즈)
  assert.equal(Core.newCountFor({ type: "topic", value: "risk" }, { ...ctx, seenAtMs: NOW - 0.5 * H }), 0);
  assert.equal(Core.newCountFor({ type: "query", value: "송출수수료" }, { ...ctx, seenAtMs: 0 }), 1);    // c는 30시간 전 → 제외
  assert.equal(Core.newCountFor({ type: "query", value: "송출수수료" }, { ...ctx, seenAtMs: NOW - 40 * H }), 2);
  assert.equal(Core.newCountFor({ type: "hot" }, { ...ctx, seenAtMs: 0 }), 1);
  assert.equal(Core.newCountFor({ type: "hot" }, { ...ctx, seenAtMs: NOW }), 0);
  assert.equal(Core.newCountFor({ type: "trending" }, { ...ctx, seenAtMs: NOW - 1 * H }), 1);
});

test("companyBadges: 24시간 주요 기사 상위 3개사 '인기', 리스크 있으면 '주의' 우선", () => {
  const companies = ["hyundai", "gsshop", "cj", "lotte", "ns"].map((id) => ({ id }));
  const mk = (id, co, h, risk = 0) => ({ id, pubDate: iso(h), mainCompanies: [co], companies: [co], riskScore: risk, tabs: ["retail"] });
  const arts = [mk("1", "hyundai", 1), mk("2", "hyundai", 2), mk("3", "lotte", 1, 2), mk("4", "cj", 3), mk("5", "ns", 4),
    mk("6", "gsshop", 30), { ...mk("7", "gsshop", 1), noise: true }];
  // 집계: hyundai 2 · lotte 1 · cj 1 · ns 1 (gsshop 은 24시간 밖/노이즈) → 상위 3 = hyundai, cj, lotte(동률은 id 순) → lotte 는 리스크
  assert.deepEqual(Core.companyBadges(companies, arts, NOW), { hyundai: "hot", cj: "hot", lotte: "risk" });
  assert.deepEqual(Core.companyBadges(companies, [], NOW), {});
});

test("groupByDate: 최신순 정렬 + 날짜(KST 문자열) 구분", () => {
  const arts = [
    { id: "1", pubDate: "2026-10-01T09:00:00+09:00" },
    { id: "2", pubDate: "2026-10-02T08:00:00+09:00" },
    { id: "3", pubDate: "2026-10-02T10:00:00+09:00" },
  ];
  const g = Core.groupByDate(arts);
  assert.deepEqual(g.map((x) => x.date), ["2026-10-02", "2026-10-01"]);
  assert.deepEqual(g[0].items.map((a) => a.id), ["3", "2"]);
});

test("filterIssues: 카테고리·팔로우 필터, 점수 정렬", () => {
  const issues = [
    { id: "i1", tabs: ["retail", "homeshopping"], count: 5, riskMax: 0, lastAt: iso(1) },
    { id: "i2", tabs: ["retail", "risk"], count: 3, riskMax: 3, lastAt: iso(2) },
    { id: "i3", tabs: ["retail"], count: 9, riskMax: 0, lastAt: iso(3) },
  ];
  assert.deepEqual(Core.filterIssues(issues, { cat: "all" }).map((i) => i.id), ["i1", "i2", "i3"]);
  assert.deepEqual(Core.filterIssues(issues, { cat: "homeshopping" }).map((i) => i.id), ["i1"]);
  assert.deepEqual(Core.filterIssues(issues, { cat: "retail" }).map((i) => i.id), ["i2", "i3"]);   // 유통 = 홈쇼핑 제외
  assert.deepEqual(Core.filterIssues(issues, { cat: "all", onlyFollowed: true, follows: { i2: {} } }).map((i) => i.id), ["i2"]);
  assert.deepEqual(Core.sortByScore(issues).map((i) => i.id), ["i2", "i3", "i1"]);  // 3+3*3=12, 9, 5
});

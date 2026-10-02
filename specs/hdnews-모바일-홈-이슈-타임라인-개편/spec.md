# hdnews 모바일 홈·이슈 타임라인 개편 — 요구사항 (spec)

## Source of Truth
- 기획 문서: [prd.md](./prd.md) — 사용자와 합의한 목표·기능·성공 기준의 기준 문서
- 대상 코드베이스: GitHub `hdmzp/hdnews` (https://github.com/hdmzp/hdnews) — GitHub Pages 정적 사이트 + GitHub Actions 수집기. 라이브: https://hdmzp.github.io/hdnews/
- 참고 UI(사용자 업로드 스크린샷 3장, `.aplus/uploads/`):
  - `mupu01p8dnfphm.jpg` 캐치테이블 홈 — 상단 검색·최근본·알림, 상단 탭, 5열 아이콘 바로가기 그리드 + N 배지, "어디로 가시나요?" 원형 카드(인기/핫플 배지, 내 주변 버튼)
  - `mupu02j80p2l6o.jpg` 뉴닉 이슈 타임라인 — 전체/팔로우 필터, 이슈명 + NEW, "N개의 기사를 압축했어요 · n분 전", 종(팔로우) 아이콘
  - `mupu037o8u29zr.jpg` 뉴닉 발견 탭 — 카테고리 칩, "이슈 타임라인 / 시간 순으로 핵심만 정리했어요" 칩 섹션 + 더 보기, 콘텐츠 카드 섹션, 하단 내비 5개

## 현재 상태 (As-Is)
- 프런트: `index.html` + `assets/app.js`(바닐라 JS, 해시 라우팅 `#/retail`, `#/homeshopping`, `#/scrap`, 회사 대시보드 `renderCompanyDash`) + `assets/style.css`(다크/라이트 토큰). 캐시 버스팅은 `?v=N`.
- 데이터: `data/articles.json`(7일 롤링, 약 12MB), `data/trending.json`(24h 급상승 키워드), `data/briefing.json`(daily/weekly 집계, hotRetail/hotHomeshopping TOP10 id), `data/hsdash.json`(hdhs 편성·랭킹 연동, 없어도 동작).
- 수집기: `scripts/collect.py` — 네이버 뉴스 API + 구글뉴스 RSS, 30분 주기. `normalize_title` 기준 전재 중복을 대표 기사의 `heat`로 누적, `tag_article`로 `tabs/companies/mainCompanies/riskScore/riskCategories` 부여, `compute_trending`, `compute_briefing`, `--selftest` 내장.
- 설정: `config/keywords.json`(companies 12개: name/short/hsCode/color/type, topicQueries retail/homeshopping/policy/ecommerce/risk, riskCategories 9종 weight, hdhs 매핑), `config/press.json`, `config/stopwords.json`, `config/brand_exclude.json`.
- 화면: PC 좌측 사이드바(유통 NEWS/홈쇼핑 NEWS/스크랩) + 모바일 상단 탭바. 유통 NEWS(급상승 키워드 스트립, 핫이슈 TOP10, 기사 피드), 홈쇼핑 NEWS(오늘 요약 카드·회사별 집계, TOP10, 12개사 슬라이서·필터, 회사 대시보드), 스크랩(localStorage). 헤더 검색, 테마 토글.

## Goals
1. 모바일 첫 화면을 "바로가기 그리드 + 회사 선택" 중심의 홈으로 재구성
2. 전재·후속 기사를 이슈 단위로 묶은 이슈 타임라인(목록·상세) 제공
3. 이슈 팔로우와 NEW/알림 점으로 후속 보도 추적
4. 발견 탭으로 카테고리별 둘러보기 제공
5. 모바일 하단 내비게이션 도입, PC 레이아웃과 기존 기능은 그대로 유지

## Non-Goals
- 로그인·서버·브라우저 밖 푸시 알림 — 저장은 localStorage, 알림은 앱 내 배지/점으로 한정
- 새 프레임워크(React 등)·빌드 도구 도입 — 기존 바닐라 JS/CSS 유지 (서버·비용 없는 운영 모델 보존)
- 수집 소스 확장(블로그·유튜브·DART 등 README v2 로드맵)
- 기사 본문 수집·AI 요약 생성 — 이슈 요약은 대표 기사 제목·설명을 재사용
- 디자인 전면 리브랜딩 — 색상 토큰·카드 스타일은 기존 `style.css` 확장

## 기능 요구사항

### F1. 홈 화면 (`#/home`, 기본 진입)
- 상단: 로고, 검색 입력(기존 `searchInput` 재사용), 최근 본 기사(시계 아이콘, localStorage `hdnews.recent` 최근 20건), 알림 종(팔로우 이슈에 새 기사가 있으면 점)
- 바로가기 그리드: 모바일 4~5열 아이콘(이모지) + 라벨. 항목은 `config/shortcuts.json`으로 정의: `{ id, label, icon, target: { type: "tab"|"risk"|"topic"|"trending"|"hot", value } }`. 기본 항목(10개 이상): 급상승, 핫이슈 TOP10, 리스크 전체, 재승인·인허가, 송출수수료, 방송사고·심의, 뒷광고·PPL, 국회·국감, 소비자 피해, e커머스, 정책, 홈쇼핑 전체
- N 배지: 항목별 `hdnews.shortcutSeen.<id>` 이후 `pubDate`인 해당 기사가 1건 이상이면 표시. 항목 진입 시 seen = now
- 회사 선택 "어느 회사를 보시나요?": 12개사 원형 카드(회사 `color` 테두리, `short` 라벨, 가로 스크롤). 배지: 최근 24시간 주요 기사 수 상위 3개사 '인기', 24h 리스크 기사(`riskScore ≥ 1`) 있으면 '주의'(둘 다면 '주의' 우선) — 자정 직후 '오늘' 집계가 비는 문제를 피하려고 briefing.daily 대신 24시간 창을 쓴다. 탭하면 `#/company/<id>`(홈쇼핑 NEWS에서 그 회사만 선택한 화면, 기존 `renderCompanyDash` 재사용)
- 캐치테이블의 "내 주변" 자리에는 "내 회사" 버튼: 사용자가 회사 1개를 직접 지정(`hdnews.myCompany`, 기본값 없음)하면 홈 상단에 그 회사의 지난 24시간 요약 카드(주요·언급·리스크 건수 + 최신 기사 3건 + 대시보드 링크) 노출. 미지정 시 버튼만 표시, 다시 눌러 변경·해제 가능

### F2. 이슈 타임라인 목록 (`#/issues`)
- 데이터: `data/issues.json`(수집기 생성). 이슈 스키마: `{ id, title, summary, articleIds[], count, firstAt, lastAt, companies[], tabs[], riskMax, riskCategories[], repArticleId }`
- 묶음 규칙(수집기, 구현 확정): 최근 72h · 노이즈 제외 기사 대상. 전재(같은 제목)는 이미 `merge_articles`에서 대표 기사의 heat로 합쳐져 있으므로, 2차로 제목 토큰(`extract_tokens` 단어) 공유 ≥ 2개 이고 Jaccard ≥ 0.4 인 기사쌍을 단일 연결(union-find)로 묶는다(150개 넘는 기사에 나오는 흔한 토큰은 후보 생성에서 제외). 서로 다른 기사 ≥ 2건 이고 `count`(heat 합 = 전재 포함 보도 건수) ≥ 3 인 묶음만 이슈. 상한 600개(보도량순). `id`는 `is-<가장 이른 기사 id>` 이며 이전 `issues.json`과 articleIds 겹침이 가장 큰 이슈가 id를 승계, 합쳐진 나머지 옛 id는 `prevIds`로 남긴다(프런트가 팔로우 이동). 실데이터 보정: 72h 8,169건 → 391개 이슈, 3.4초, 291KB
- 정렬: `lastAt` 내림차순. 항목: 제목, NEW 배지(열람 기록 `hdnews.issueSeen.<id>`가 `lastAt`보다 과거이거나, 열람 기록이 없으면 `lastAt`이 24시간 이내일 때 — 첫 방문에 수백 개가 전부 NEW로 보이지 않게), "N개의 기사를 압축했어요 · n분 전", 종(팔로우) 토글, 리스크 색 점(riskMax)
- 필터 칩: 전체 / 팔로우. 팔로우 0건이면 안내 문구. 쿼리 `?cat=<tab>`으로 카테고리 필터 지원(발견 탭 더 보기 진입용)

### F3. 이슈 상세 (`#/issue/<id>`)
- 헤더: 제목, 기사 수, 기간(firstAt~lastAt), 관련 회사 칩(회사 색), 리스크 카테고리 칩, 팔로우 토글
- 요약: 대표 기사(`repArticleId`) 제목·설명 1~2줄
- 타임라인: 기사 `pubDate` 내림차순, 날짜가 바뀌는 지점에 구분선(YYYY.MM.DD), 각 항목에 시각·언론사·제목(외부 링크, 새 탭)·리스크 색 테두리·★ 스크랩(기존 bookmarks 재사용)
- 진입 시 `hdnews.issueSeen.<id> = now`

### F4. 팔로우·알림
- 저장: `hdnews.follows = { [issueId]: { followedAt, seenLastAt } }`
- 새 기사 판정: `issue.lastAt > seenLastAt` → NEW. 하단 내비 '이슈' 아이콘 점과 홈 종 점 = NEW인 팔로우 이슈 1건 이상
- 이슈가 72h 창에서 사라져 `issues.json`에 없으면 팔로우 필터에 '종료됨'으로 흐리게 표시, 해제 가능

### F5. 발견 탭 (`#/discover`)
- 카테고리 칩: 전체 / 유통 / 홈쇼핑 / 정책 / e커머스 / 리스크 (`tabs` 매핑: retail, homeshopping, policy, ecommerce, risk)
- 섹션 1 "이슈 타임라인 — 시간 순으로 핵심만 정리했어요": 해당 카테고리 이슈 상위 6개를 칩(제목 + N)으로, 더 보기 → `#/issues?cat=<tab>`
- 섹션 2 "회사 대시보드": 카테고리가 전체/홈쇼핑일 때 12개사 카드(오늘 주요 N건 · 리스크 N건) 가로 스크롤 → `#/company/<id>`
- 섹션 3 "급상승 키워드": 기존 `renderTrendingStrip` 재사용(홈쇼핑/리스크 카테고리는 `hsKeywords`)

### F6. 내비게이션·레이아웃
- 모바일(<1024px): 하단 고정 내비 5개 — 홈(`#/home`) / 발견(`#/discover`) / 이슈(`#/issues`) / 스크랩(`#/scrap`) / 회사(`#/companies`, 12개사 목록). 활성 탭 강조, 이슈 아이콘 알림 점. 기존 유통/홈쇼핑 피드는 홈 상단 2차 탭(홈/유통/홈쇼핑/리스크)과 바로가기에서 진입
- PC(≥1024px): 좌측 사이드바에 홈/발견/이슈 메뉴 추가, 하단 내비 숨김
- 해시 없음 → `#/home`으로 이동. 기존 링크(`#/retail`, `#/homeshopping`, `#/scrap`) 유지

## 비기능 요구사항
- `issues.json`은 500KB 이하 목표(기사 전체 복제 금지, `articleIds`만 저장)
- `articles.json` 로드 전에도 `shortcuts/issues/briefing`만으로 홈 골격을 먼저 렌더(플레이스홀더)
- 수집기에서 이슈 생성 실패 시 기존 `issues.json` 유지(hsdash와 동일 정책)
- `style.css`/`app.js` 변경 시 `index.html`의 `?v=` 증가
- 접근성: 배지 `aria-label`("새 기사 3건"), 하단 내비 터치 영역 44px 이상
- 기존 테마 토큰으로 다크/라이트 모두 대응

## Acceptance Criteria (Given / When / Then)
- AC1 홈 그리드: Given 모바일 390px, When `#/home` 진입, Then 검색바·바로가기 10개 이상·회사 선택 영역이 가로 스크롤 없이 보인다
- AC2 N 배지: Given 바로가기 '리스크'의 seen 이후 리스크 기사 2건, When 홈 렌더, Then 'N' 배지 표시; When 리스크 진입 후 홈 복귀, Then 배지가 사라진다
- AC3 회사 배지: Given 최근 24시간 주요 기사 수 상위 3개사와 24h 리스크 기사가 있는 회사, When 홈 렌더, Then 각각 '인기' / '주의' 배지, 둘 다 해당하면 '주의'
- AC4 이슈 생성: Given 72h 내 같은 사건 기사 3건(전재 포함), When `collect.py` 실행, Then `issues.json`에 count ≥ 3 이슈 1개 생성, 2건짜리 묶음은 제외
- AC5 이슈 id 안정: Given 이전 `issues.json`의 이슈 X, When 새 기사 1건이 추가되어 재생성, Then X의 id 유지, count + 1, lastAt 갱신
- AC6 이슈 목록: Given 이슈 5건, When `#/issues`, Then lastAt 내림차순, 각 항목 "N개의 기사를 압축했어요 · n분 전", 미열람 항목에 NEW
- AC7 이슈 상세: Given 이슈 기사가 2일에 걸침, When `#/issue/<id>`, Then 날짜 구분선 2개, 기사 최신순, ★ 토글이 스크랩 탭에 반영
- AC8 팔로우: Given 이슈 팔로우, When 새로고침, Then 팔로우 유지; When `lastAt`이 `seenLastAt`보다 최신, Then 목록 NEW + 하단 '이슈' 점 + 홈 종 점
- AC9 발견: Given `#/discover`, When 칩 '홈쇼핑' 선택, Then 이슈 칩·회사 카드·급상승이 홈쇼핑 기준으로 1초 내 갱신, 더 보기는 `#/issues?cat=homeshopping`
- AC10 회귀: Given 기존 `#/retail`, `#/homeshopping`, `#/scrap`, `#/company/<id>`, When 개편 후 접속, Then 기존 기능·필터·테마 동작 동일, PC에서 하단 내비 없음
- AC11 셀프테스트: When `python3 scripts/collect.py --selftest`, Then 이슈 묶음·임계·id 승계 테스트 포함 통과

## Open Questions
1. 바로가기 그리드 항목 구성과 순서 — 기본안(리스크 카테고리 9개 + 주제 3개) 확정 필요
2. (1차 확정, 2026-10-02) 이슈 묶음 기준은 '서로 다른 기사 2건 + 보도 3건, 72시간, 유사도 0.4'로 두고 실데이터에서 391개/72h를 확인. 주말 뉴스량이 적을 때의 적절성은 운영하며 `ISSUE_*` 상수로 조정
3. 하단 탭 다섯 번째를 '회사'로 둘지, '유통/홈쇼핑 피드'로 둘지
4. (해결, 2026-10-01) '내 회사' 기본값은 두지 않고 사용자가 '내 회사' 버튼으로 직접 지정한다

# hdnews 모바일 홈·이슈 타임라인 개편 — 작업 기록 (context)

## Current Status
- Active Spec Path: `specs/hdnews-모바일-홈-이슈-타임라인-개편` (prd.md / spec.md / plan.md / context.md)
- 2026-10-01: 기획 초안 작성. 연동 저장소 `hdmzp/hdnews` 구조(README, index.html, app.js, collect.py, keywords.json, briefing/trending.json) 조사 완료. 사용자 업로드 참고 스크린샷 3장(캐치테이블 홈, 뉴닉 이슈 타임라인, 뉴닉 발견 탭)을 기능으로 매핑해 prd/spec/plan 반영.
- 2026-10-01: 사용자 확인 완료 — 참고 화면 3장(홈 바로가기·회사 선택, 이슈 타임라인, 발견 탭·하단 내비)을 모두 반영. '내 회사'는 기본값 없이 사용자가 직접 지정.
- 2026-10-01: 작업 모드 전환. 연동 저장소 `hdmzp/hdnews` 의 main 을 워크스페이스에 가져옴(shallow fetch, HEAD `bcfa5d2`). 프로젝트 분석: 정적 사이트(index.html + assets/ + data/) + GitHub Actions 수집기(`scripts/collect.py`, Python 표준 라이브러리만 사용, 설치 의존성 없음). dev/preview 서버는 단일 frontend 서비스 `python3 -m http.server 30015 --bind 0.0.0.0`(backend 포트 40015 미사용). 재현용 `Dockerfile`·`docker-compose.yml`·`.dockerignore` 추가(미커밋).
- 2026-10-02: Phase 1~4 구현 완료, Phase 5 문서 갱신 완료. 작업 브랜치 `feature/mobile-issue-timeline`(main 기준). 수집기 `build_issues`(72h 이슈 묶음·id 승계) + `data/issues.json`(391건, 291KB), 순수 로직 모듈 `assets/issues-core.js` + Node 테스트 9건, 홈/발견/이슈 타임라인/회사/주제 화면 + 하단 내비 + 바로가기 설정 `config/shortcuts.json`, README 갱신.
- 2026-10-02 08:04~08:05 UTC: 배포 완료. `feature/mobile-issue-timeline` push → PR #23(https://github.com/hdmzp/hdnews/pull/23) → main 머지(`6fb7e0b`, merge commit) → GitHub Pages 배포 success(약 30초) → 라이브 https://hdmzp.github.io/hdnews/ 에서 `app.js?v=21`·`issues-core.js?v=1`·`style.css?v=19`·`data/issues.json`·`config/shortcuts.json` 확인.
- 2026-10-02 08:3x UTC: 노이즈 정제 배포. PR #25(규칙·설정·테스트, squash `233b2b9`) → Pages 배포 확인(app.js v22, keywords.json noiseTags/roundupTags 라이브). PR #26(저장된 7일치 기사 재분류 데이터, squash `ad8dffb`)로 다음 수집을 기다리지 않고 즉시 반영. 참고: Actions 스케줄 실행 간격이 실제로는 4시간 안팎(GitHub 지연).
- 남은 일: 다음 Actions 수집 뒤 `data/issues.json`이 새 기사로 자동 갱신되는지 확인. 바로가기 항목 구성·순서는 `config/shortcuts.json`에서 언제든 조정.

## Decision Log
- D1 (2026-10-01): 기존 hdnews 정적 사이트(바닐라 JS + GitHub Actions 수집기) 구조를 유지·확장한다. 이유: 서버·비용 없는 운영 모델과 기존 데이터·기능 재사용. 새 프레임워크 전환은 Non-Goal.
- D2 (2026-10-01): 이슈 묶음은 브라우저가 아니라 수집기(`collect.py`)에서 생성해 `data/issues.json`으로 배포한다. 이유: 12MB `articles.json`을 모바일에서 클러스터링하면 느리고, 이슈 id 안정성(팔로우 유지)을 수집기에서 보장해야 함.
- D3 (2026-10-01): 팔로우·열람 기록·N 배지·내 회사는 localStorage(로그인 없음). 기존 스크랩과 동일 정책.
- D4 (2026-10-01): 모바일 하단 내비 5개(홈/발견/이슈/스크랩/회사), PC는 기존 사이드바에 메뉴만 추가.
- D5 (2026-10-01, 사용자 결정): 세 참고 화면을 모두 한 기획에 반영한다. '내 회사' 기본값은 두지 않고 사용자가 직접 선택한다.
- D6 (2026-10-01): dev/preview 서버는 Python 표준 `http.server` 로 저장소 파일을 그대로 서빙한다(README 로컬 테스트 방식과 동일). 이유: 빌드 도구·의존성 없음, Studio preview 이미지(`namsangboy/aplus_dev_node24`)에 python3 3.11 포함 확인.
- D7 (2026-10-01): 기획 번들은 Studio 가 spec-patch 로 생성한 `specs/hdnews-모바일-홈-이슈-타임라인-개편/` 하나로 통합하고, 영문 슬러그 폴더(`hdnews-mobile-issue-timeline`)는 제거. `.ax/state.json` 의 plan.filePath 도 이 경로로 갱신.
- D8 (2026-10-02): 이슈 묶음 기준은 실데이터로 보정 — 제목 토큰 공유 ≥2 · Jaccard ≥0.4 · 단일 연결, 서로 다른 기사 ≥2 + 보도(heat 합) ≥3. 이유: heat≥3 인 단일 전재 기사가 1,670건이라 '보도 3건'만으로는 이슈가 수천 개가 되고, 0.3 이하 유사도는 연쇄 병합(최대 113건)이 생김. 결과 391개/72h, 최대 묶음 71건(컬리×아모레 협업)으로 응집도 양호.
- D9 (2026-10-02): 회사 배지·내 회사 카드·회사 카드의 집계 창은 '오늘(KST)'이 아니라 최근 24시간. 이유: 자정~아침에는 '오늘' 집계가 거의 0이라 화면이 비어 보이고, 핫이슈 랭킹과 같은 창을 써야 일관됨.
- D10 (2026-10-02): NEW 배지는 열람 기록이 없으면 lastAt 24시간 이내인 이슈에만 표시. 이유: 첫 방문에 391개 전부 NEW 로 표시되는 것을 피함. 팔로우 이슈는 seenLastAt 기준 그대로.
- D12 (2026-10-02, 사용자 피드백): 노이즈 정제 강화. ① 리스크 분류는 제목에 유통 맥락(홈쇼핑사·유통기업·탭 키워드)이 있거나 홈쇼핑사가 언급된 기사에만 적용 ② 리스크 키워드만으로는 관련 기사로 통과 못 함(회사·유통 키워드·유통 유형 필요) ③ 연예 키워드가 요약에만 있어도 제목에 유통 맥락이 없고 홈쇼핑사 언급이 없으면 노이즈 ④ [인사]·[동정]·[부고]·운세(`noiseTags`/`noiseTitlePrefixes`)는 제목에 홈쇼핑사·유통기업 이름이 없으면 노이즈 ⑤ [산업소식]·[국감]·[포토]·[르포] 등 모음·연재 태그(`roundupTags`)는 제목에 회사·유통 키워드가 없고 홈쇼핑사 언급도 없으면 노이즈. 7일치 재분류 결과: 노이즈 1,507→1,951건, 리스크 기사 870→317건, 폭로·이슈 154→24건(남은 24건은 모두 유통·홈쇼핑 관련), 홈쇼핑 탭 887→883건. 1차안(리스크 키워드·유통 유형 모두 관련성에서 제외)은 '신세계百 정기세일' 같은 홍보 기사까지 955건이 빠져 유통 유형은 관련성에 복원.
- D11 (2026-10-02): 프런트 검증은 Playwright(스크래치 디렉터리, 프로젝트 의존성 아님)로 라이브 프리뷰(30015)를 자동 점검. 프로젝트에는 Node 의존성·package.json 을 추가하지 않고 `node --test` 표준 러너만 사용.

## Verification Log
- 2026-10-01 `python3 scripts/collect.py --selftest` → `hsdash selftest OK`, `selftest OK`
- 2026-10-01 정적 서버 smoke(임시 포트 38015, 동일 명령 형태): `/` 200 text/html 3058B · `/assets/app.js` 200 · `/data/briefing.json` 200 · `/data/articles.json` 200 (12MB, 0.014s)
- 2026-10-01 `docker compose config -q` OK. 할당 포트 30015/40015 미점유 확인(`ss -ltnp`).
- 2026-10-02 `python3 scripts/collect.py --selftest` → 이슈 묶음(3건 묶음·2건 제외·단일 전재 제외·노이즈 제외·대표 기사·회사/리스크 집계)·id 승계(창 밖 기사 제거·분할·병합) 테스트 포함 `selftest OK`
- 2026-10-02 `node --test tests/*.test.js` → 9/9 통과 (상대 시각, 라우트 파싱, NEW/팔로우 판정, 팔로우 이동, 바로가기 매칭·새 기사 수, 회사 배지, 날짜 그룹, 이슈 필터·정렬)
- 2026-10-02 Playwright 브라우저 점검(390×844 모바일 + 1280×900 PC, 라이브 프리뷰 30015) → 25개 항목 PASS, 콘솔/페이지 오류 0: AC1 그리드·가로스크롤 없음, AC2 N 배지 소멸, AC3 인기 ≤3, AC6 압축 문구·최신순·NEW, AC7 날짜 구분선·최신순·열람 후 알림 해제·★, AC8 팔로우 유지·필터·알림 점, AC9 발견 칩 311ms·더 보기 링크, F1 내 회사, 검색 리다이렉트, AC10 기존 라우트 9종·구버전 해시·PC 하단 내비 숨김
- 2026-10-02 스크린샷 확인: 모바일 홈/이슈/상세/발견/회사/리스크, PC 홈·이슈(다크 테마 포함) 레이아웃 정상
- 2026-10-02 노이즈 정제: `collect.py --selftest`에 연예 '논란'(이민호), 요약만 유통 키워드인 사회 기사(리스크 미부여), [인사] 모음(홈쇼핑사 유무), 오늘의 인사, [산업소식]/[2026 국감](제목 앵커 유무), 유통기업 인사, 신세계百 세일, 계열사 광고모델(홈쇼핑사 언급) 케이스 추가 → 통과. 7일치 14,872건 재분류 비교로 과필터 여부 확인
- 2026-10-02 정제 배포 검증: 라이브 articles.json에서 '이민호' 기사 8건 모두 noise·리스크 없음, [인사]/[산업소식] 중 비노이즈는 홈쇼핑사(홈앤쇼핑)·유통기업(롯데백화점)이 제목에 있거나 홈쇼핑사가 언급된 기사뿐, 폭로·이슈 리스크 24건
- 2026-10-02 배포 검증: GitHub Pages deployment 6804082009 state=success(08:05:28Z). 라이브 사이트 대상 같은 Playwright 점검 25개 PASS, 콘솔/페이지 오류 0, 라이브 홈 스크린샷 확인

## Next Step
- 운영 관찰: 다음 Actions 수집 뒤 라이브 `data/issues.json`의 generatedAt 이 갱신되고 이슈 수가 300~500 범위인지 확인. 사용자 피드백(바로가기 구성, 이슈 묶음 기준, 하단 탭 구성)을 받아 `config/shortcuts.json` / `ISSUE_*` 상수로 조정.

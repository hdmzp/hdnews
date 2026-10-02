# hdnews 모바일 홈·이슈 타임라인 개편 — 구현 계획 (plan)

기준 문서: [prd.md](./prd.md) · [spec.md](./spec.md). 대상 저장소 `hdmzp/hdnews`(바닐라 JS 정적 사이트 + Python 수집기). 각 Phase는 사용자에게 보이는 기능 단위로 나누고, Phase마다 검증 기준을 둔다.

## Phase 1. 이슈 데이터 생성 (수집기) — ✅ 완료 (2026-10-02)
- `scripts/collect.py`에 `build_issues(articles, prev_issues, now)` 추가: 72h 창, `normalize_title` 1차 + `title_terms` Jaccard 2차 묶음, `count ≥ 3`, 이전 이슈와 articleIds 교집합으로 id 승계, `data/issues.json` 출력. 실패 시 기존 파일 유지
- `--selftest`에 묶음·임계(2건 제외)·id 승계 테스트 추가
- 검증: `python3 scripts/collect.py --selftest` 통과(AC4, AC5, AC11). 로컬 실수집 또는 기존 `articles.json`으로 생성한 `issues.json` 크기 500KB 이하, 스키마 필드 확인

## Phase 2. 홈 화면 — 바로가기 그리드 + 회사 선택 — ✅ 완료 (2026-10-02)
- `config/shortcuts.json` 추가, `#/home` 라우트와 `renderHome()`, N 배지(localStorage seen), 회사 원형 카드(인기/주의 배지), '내 회사' 버튼·요약 카드, 기본 진입을 `#/home`으로 변경
- 검증: 390px 모바일 스크린샷으로 AC1~AC3 확인. 기존 라우트(`#/retail`, `#/homeshopping`, `#/scrap`, `#/company/<id>`) 회귀 확인(AC10)

## Phase 3. 이슈 타임라인 — 목록·상세·팔로우 — ✅ 완료 (2026-10-02)
- `#/issues`(전체/팔로우 필터, `?cat=`), `#/issue/<id>`(날짜 구분선 타임라인, 스크랩 연동), 팔로우 저장소(`hdnews.follows`), NEW 판정, 홈 종 점·하단 이슈 점
- 검증: AC6~AC8 는 Playwright 스크립트(브라우저 자동 점검)로 확인. 팔로우/NEW 판정·상대 시간·라우트 파싱·배지 계산은 `assets/issues-core.js` 순수 함수로 분리해 `node --test tests/*.test.js` 로 확인

## Phase 4. 발견 탭 + 하단 내비게이션 + PC 메뉴 — ✅ 완료 (2026-10-02)
- `#/discover` 카테고리 칩과 3개 섹션(이슈 칩·회사 카드·급상승), 모바일 하단 고정 내비 5개, PC 사이드바 메뉴 추가, `index.html` `?v=` 증가
- 검증: AC9, AC10. 모바일(390px)/PC(1280px) 두 폭 × 다크/라이트 두 테마 스크린샷 확인

## Phase 5. 운영 문서·배포 확인 — 🔶 문서 완료, 배포 확인은 push 후
- README 탭 구성 표와 `shortcuts.json` 운영 가이드 갱신, GitHub Actions 수집 후 `issues.json` 커밋 확인, GitHub Pages 라이브에서 `#/home` 기본 진입 확인
- 검증: 라이브 URL 접속 시 홈 화면 표시, Actions 로그에 이슈 생성 건수 출력, 기존 사용자 북마크 링크 정상 동작

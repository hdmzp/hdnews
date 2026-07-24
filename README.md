# 📺 hdnews — 유통·홈쇼핑 뉴스 모니터링

유통 업계와 홈쇼핑 12개사(TV홈쇼핑 7 + T커머스 5)의 뉴스·리스크를 한눈에 보는 자동 수집 뉴스 사이트입니다.

- **수집**: GitHub Actions가 30분마다 네이버 뉴스 검색 API + 구글뉴스 RSS를 호출해 기사를 수집·분류
- **저장**: 정적 JSON(`data/`)으로 저장소에 커밋 (최근 7일 유지, 이전 기사는 `data/archive/`에 월별 보관)
- **서비스**: GitHub Pages 정적 사이트 — 서버·비용 없음

## 탭 구성

| 탭 | 내용 |
|---|---|
| 유통 핫이슈 | 급상승 키워드(클릭 시 관련 기사 팝업) + 오늘의 핫이슈 TOP 10 랭킹 + 최신 기사 피드 |
| 홈쇼핑 이슈 | 오늘 요약 카드·회사별 집계 + 홈쇼핑 핫이슈 TOP 10 + 12개사 슬라이서·리스크 유형 필터·매칭/정렬 필터 |
| 스크랩 | ★로 저장한 기사 (브라우저 localStorage — 7일 지나도 유지) |

**핫이슈 랭킹 기준**: `보도량(heat) + 리스크 점수` — 여러 언론사가 전재 보도한 기사일수록(heat), 리스크 키워드에 많이 걸릴수록 상위. 최근 24시간 기사 대상, 동점이면 최신순. 카드의 "보도 N건" 배지가 전재 보도량입니다.

공통: 키워드 검색(헤더), 기사 카드 우측 언론사·게시일 표시, 리스크 심각도 색 테두리, 다크/라이트 테마, 모바일 반응형.

## 최초 설정 (한 번만)

1. **네이버 API 키 발급** — [developers.naver.com](https://developers.naver.com) → 애플리케이션 등록 → 사용 API에서 **"검색"** 선택 → 환경은 WEB 설정(URL은 `https://<계정>.github.io`) → Client ID / Client Secret 확보
2. **Secrets 등록** — 저장소 Settings → Secrets and variables → Actions → New repository secret
   - `NAVER_CLIENT_ID`
   - `NAVER_CLIENT_SECRET`
3. **GitHub Pages 활성화** — Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / `/ (root)` → Save
4. **첫 수집 실행** — Actions 탭 → "Collect news" → **Run workflow** 클릭
5. 몇 분 후 `chore(data): update news data` 커밋이 생기면 `https://<계정>.github.io/hdnews/` 접속

## 운영·튜닝

- **키워드 조정은 `config/keywords.json`만 수정하면 됩니다** (코드 무변경):
  - `companies[].aliases` — 회사 검색어/별칭
  - `topicQueries` — 탭별 수집 검색어
  - `riskCategories[].keywords` — 리스크 감지 키워드 (weight가 심각도)
  - `config/stopwords.json` — 급상승 키워드에서 제외할 단어
- 네이버 API 사용량: 쿼리 약 34개 × 48회/일 ≈ 1,600콜/일 (일 한도 25,000의 6%)
- **주의**: 저장소에 60일간 활동(커밋·이슈 등)이 없으면 GitHub가 스케줄 실행을 자동 중지합니다. Actions 탭에서 워크플로를 다시 활성화하면 됩니다.
- 급상승 키워드는 최근 24시간 대비 이전 3일 기준선으로 계산 — 수집 시작 후 하루 정도 지나야 의미 있게 표시됩니다.

## 로컬 테스트

```bash
python3 scripts/collect.py --selftest        # 네트워크 없이 파이프라인 검증
NAVER_CLIENT_ID=.. NAVER_CLIENT_SECRET=.. python3 scripts/collect.py   # 실수집
python3 -m http.server 8000                  # http://localhost:8000 에서 사이트 확인
```

## 확장 로드맵 (v2 후보)

- **네이버 블로그·카페글 API** — 같은 키로 `v1/search/blog.json` / `v1/search/cafearticle.json` 호출, 소비자 반응·입소문 수집 (리스크 조기 신호)
- **유튜브 Data API** — 각 홈쇼핑사 공식 채널 새 영상 + 사망여우 등 폭로 채널의 신규 영상에 홈사명 등장 시 리스크 표시
- **DART 전자공시 API** — 상장 홈쇼핑사 공시(실적·소송·지배구조) 모니터링
- **전문지 RSS** — 전자신문·디지털타임스 등 방송·유통 전문 매체 보강
- 참고: 인스타그램·틱톡은 공식 API가 타사 계정 조회를 허용하지 않아 제외

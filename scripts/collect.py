#!/usr/bin/env python3
"""hdnews 수집기.

네이버 뉴스 검색 API + 구글뉴스 RSS에서 기사를 수집해
data/articles.json(7일 롤링), data/trending.json, data/briefing.json을 갱신한다.
표준 라이브러리만 사용한다.

사용법:
  NAVER_CLIENT_ID=.. NAVER_CLIENT_SECRET=.. python3 scripts/collect.py
  python3 scripts/collect.py --selftest   # 네트워크 없이 순수 함수 검증
"""

import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
ARCHIVE_DIR = os.path.join(DATA_DIR, "archive")
KST = timezone(timedelta(hours=9))

NAVER_URL = "https://openapi.naver.com/v1/search/news.json"
GOOGLE_RSS_URL = "https://news.google.com/rss/search"

RETENTION_DAYS = 7
DESC_MAX = 200
RISK_SCORE_CAP = 5

TAG_RE = re.compile(r"<[^>]+>")
# 제목 정규화: [단독]/【속보】/(종합) 류 접두어와 문장부호 제거
BRACKET_RE = re.compile(r"[\[\(【][^\]\)】]{0,20}[\]\)】]")
PUNCT_RE = re.compile(r"[^\w가-힣]+")
TOKEN_RE = re.compile(r"[가-힣A-Za-z0-9]{2,}")
TRAILING_PARTICLES = ("은", "는", "이", "가", "을", "를", "에", "의", "도", "와", "과", "로", "으로")


# ---------------------------------------------------------------- 정제/유틸

def clean_text(s):
    """HTML 태그·엔티티 제거 후 공백 정리."""
    if not s:
        return ""
    s = TAG_RE.sub("", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def normalize_title(title):
    """전재 기사 중복 판정용 제목 정규화."""
    t = BRACKET_RE.sub("", title)
    t = PUNCT_RE.sub("", t)
    return t.lower()


def article_id(originallink, link):
    key = originallink or link
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


def parse_pubdate(s):
    """RFC822 날짜 → ISO8601 KST. 실패 시 None."""
    try:
        return parsedate_to_datetime(s).astimezone(KST).isoformat()
    except Exception:
        return None


_PRESS_MAP = None


def press_map():
    global _PRESS_MAP
    if _PRESS_MAP is None:
        _PRESS_MAP = load_json(os.path.join(ROOT, "config", "press.json"),
                               {"domains": {}})["domains"]
    return _PRESS_MAP


def derive_press(url):
    """기사 URL 도메인으로 언론사명 판별. 미등록 도메인은 도메인 그대로 반환."""
    if not url:
        return ""
    try:
        host = urllib.parse.urlparse(url).netloc.lower().split(":")[0]
    except ValueError:
        return ""
    domains = press_map()
    # 원본 호스트 정확 일치 우선 (biz.chosun.com처럼 접두어 자체가 매체 구분인 경우)
    if host in domains:
        return domains[host]
    host = re.sub(r"^(www|m|news|mnews|v|view|biz1?|media|mobile)\.", "", host)
    if host in domains:
        return domains[host]
    # 구글뉴스 리다이렉트 링크는 언론사 정보가 아님
    if host == "google.com" or host.endswith(".google.com"):
        return ""
    parts = host.split(".")
    for i in range(1, len(parts) - 1):
        cand = ".".join(parts[i:])
        if cand in domains:
            return domains[cand]
    return host


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")


# ---------------------------------------------------------------- 수집

def http_get(url, headers=None, timeout=15):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_with_retry(url, headers, label):
    for attempt in (1, 2):
        try:
            return http_get(url, headers)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            if attempt == 1:
                time.sleep(2)
            else:
                print(f"  [skip] {label}: {e}", file=sys.stderr)
    return None


def fetch_naver(query, client_id, client_secret):
    """네이버 뉴스 검색 1쿼리 → 원시 기사 리스트."""
    url = f"{NAVER_URL}?query={urllib.parse.quote(query)}&display=100&sort=date"
    headers = {"X-Naver-Client-Id": client_id, "X-Naver-Client-Secret": client_secret}
    raw = fetch_with_retry(url, headers, f"naver:{query}")
    if raw is None:
        return None
    try:
        items = json.loads(raw).get("items", [])
    except json.JSONDecodeError:
        return None
    out = []
    for it in items:
        title = clean_text(it.get("title", ""))
        if not title:
            continue
        originallink = it.get("originallink", "")
        out.append({
            "title": title,
            "description": clean_text(it.get("description", ""))[:DESC_MAX],
            "link": it.get("link", ""),
            "originallink": originallink,
            "pubDate": parse_pubdate(it.get("pubDate", "")),
            "source": "naver",
            "press": derive_press(originallink or it.get("link", "")),
        })
    return out


def fetch_google(query):
    """구글뉴스 RSS 1쿼리 → 원시 기사 리스트."""
    url = f"{GOOGLE_RSS_URL}?q={urllib.parse.quote(query)}&hl=ko&gl=KR&ceid=KR:ko"
    raw = fetch_with_retry(url, {"User-Agent": "Mozilla/5.0 (hdnews collector)"}, f"google:{query}")
    if raw is None:
        return None
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return None
    out = []
    for item in root.iter("item"):
        title = clean_text(item.findtext("title") or "")
        if not title:
            continue
        source_el = item.find("source")
        press = clean_text(source_el.text if source_el is not None else "")
        # 구글뉴스 제목은 "제목 - 언론사" 형식 → 말미 언론사명 분리
        if press and title.endswith(" - " + press):
            title = title[: -(len(press) + 3)].strip()
        desc = clean_text(item.findtext("description") or "")
        # description이 HTML 링크 조각이면 제목 반복과 다름없어 버림
        if desc == title or desc.startswith("<"):
            desc = ""
        out.append({
            "title": title,
            "description": desc[:DESC_MAX],
            "link": item.findtext("link") or "",
            "originallink": "",
            "pubDate": parse_pubdate(item.findtext("pubDate") or ""),
            "source": "google",
            "press": press,
        })
    return out


# ---------------------------------------------------------------- 태깅

def tag_article(art, config):
    """companies / tabs / riskCategories / riskScore 필드를 채운다."""
    text = art["title"] + " " + art["description"]
    companies = [c["id"] for c in config["companies"]
                 if any(alias in text for alias in c["aliases"])]
    tabs = ["retail"]
    for tab, rule in config["tabRules"].items():
        if tab == "retail":
            continue
        if any(kw in text for kw in rule["keywords"]):
            tabs.append(tab)
    if companies and "homeshopping" not in tabs:
        tabs.append("homeshopping")
    risk_cats, score = [], 0
    for cat in config["riskCategories"]:
        if any(kw in text for kw in cat["keywords"]):
            risk_cats.append(cat["id"])
            score += cat["weight"]
    score = min(score, RISK_SCORE_CAP)
    if score >= 1:
        tabs.append("risk")
    art.update(companies=companies, tabs=tabs, riskCategories=risk_cats, riskScore=score)
    return art


# ---------------------------------------------------------------- 트렌딩

def extract_tokens(title, stopwords):
    tokens = []
    for tok in TOKEN_RE.findall(title):
        if len(tok) > 2:
            for p in TRAILING_PARTICLES:
                if tok.endswith(p) and len(tok) - len(p) >= 2:
                    tok = tok[: -len(p)]
                    break
        if tok.isdigit() or tok in stopwords or len(tok) < 2:
            continue
        tokens.append(tok)
    return tokens


def compute_trending(articles, config, stopwords, now):
    cfg = config["trending"]
    window_start = now - timedelta(hours=cfg["windowHours"])
    baseline_start = window_start - timedelta(hours=cfg["baselineHours"])
    recent, baseline = Counter(), Counter()
    recent_arts = []
    for a in articles:
        if not a["pubDate"]:
            continue
        dt = datetime.fromisoformat(a["pubDate"])
        toks = set(extract_tokens(a["title"], stopwords))
        if dt >= window_start:
            recent.update(toks)
            recent_arts.append(a)
        elif dt >= baseline_start:
            baseline.update(toks)
    days = cfg["baselineHours"] / 24
    keywords = []
    for kw, cnt in recent.items():
        if cnt < cfg["minCount"]:
            continue
        prev_avg = baseline[kw] / days
        score = cnt - prev_avg
        if score <= 0:
            continue
        samples = [a["id"] for a in recent_arts if kw in a["title"]][:3]
        keywords.append({
            "keyword": kw, "count": cnt,
            "prevDailyAvg": round(prev_avg, 1),
            "score": round(score, 1),
            "sampleArticleIds": samples,
        })
    keywords.sort(key=lambda k: (-k["score"], -k["count"]))
    return {
        "generatedAt": now.isoformat(),
        "windowHours": cfg["windowHours"],
        "keywords": keywords[: cfg["topN"]],
    }


# ---------------------------------------------------------------- 브리핑

def aggregate(articles, config):
    by_tab, by_company, risk_by_company = Counter(), Counter(), Counter()
    for a in articles:
        for t in a["tabs"]:
            by_tab[t] += 1
        for c in a["companies"]:
            by_company[c] += 1
            if a["riskScore"] >= 1:
                risk_by_company[c] += 1
    top_risk = sorted((a for a in articles if a["riskScore"] >= 1),
                      key=lambda a: (a["riskScore"], a["pubDate"] or ""), reverse=True)[:5]
    return {
        "total": len(articles),
        "byTab": dict(by_tab),
        "byCompany": dict(by_company),
        "riskByCompany": dict(risk_by_company),
        "topRiskArticleIds": [a["id"] for a in top_risk],
    }


def compute_briefing(articles, trending, config, now):
    today = now.date()
    def within(a, start):
        return a["pubDate"] and datetime.fromisoformat(a["pubDate"]) >= start
    daily_arts = [a for a in articles
                  if a["pubDate"] and datetime.fromisoformat(a["pubDate"]).date() == today]
    weekly_arts = [a for a in articles if within(a, now - timedelta(days=7))]
    daily = aggregate(daily_arts, config)
    daily["date"] = today.isoformat()
    daily["topTrending"] = [k["keyword"] for k in trending["keywords"][:5]]
    weekly = aggregate(weekly_arts, config)
    return {"generatedAt": now.isoformat(), "daily": daily, "weekly": weekly}


# ---------------------------------------------------------------- 파이프라인

def build_queries(config):
    naver, google = [], []
    for c in config["companies"]:
        naver.extend(c["aliases"])
        google.append(c["name"])
    for qs in config["topicQueries"].values():
        naver.extend(qs)
        google.extend(qs)
    def dedup(seq):
        seen = set()
        return [q for q in seq if not (q in seen or seen.add(q))]
    return dedup(naver), dedup(google)


def merge_articles(existing, fetched_batches, config, now):
    """기존 + 신규 병합. 반환: (전체 리스트, 신규 건수)."""
    by_id = {a["id"]: a for a in existing}
    seen_titles = {normalize_title(a["title"]) for a in existing}
    new_count = 0
    for batch in fetched_batches:
        for raw in batch:
            aid = article_id(raw["originallink"], raw["link"])
            if aid in by_id:
                continue
            norm = normalize_title(raw["title"])
            if norm and norm in seen_titles:
                continue
            raw["id"] = aid
            raw["collectedAt"] = now.isoformat()
            tag_article(raw, config)
            by_id[aid] = raw
            seen_titles.add(norm)
            new_count += 1
    merged = sorted(by_id.values(), key=lambda a: a["pubDate"] or "", reverse=True)
    return merged, new_count


def apply_retention(articles, now):
    """7일 초과 기사 분리. 반환: (유지 리스트, 만료 리스트)."""
    cutoff = now - timedelta(days=RETENTION_DAYS)
    keep, expired = [], []
    for a in articles:
        if a["pubDate"] and datetime.fromisoformat(a["pubDate"]) < cutoff:
            expired.append(a)
        else:
            keep.append(a)
    return keep, expired


def archive_expired(expired):
    by_month = {}
    for a in expired:
        month = (a["pubDate"] or "")[:7] or "unknown"
        by_month.setdefault(month, []).append(a)
    for month, arts in by_month.items():
        path = os.path.join(ARCHIVE_DIR, f"{month}.json")
        existing = load_json(path, [])
        ids = {a["id"] for a in existing}
        existing.extend(a for a in arts if a["id"] not in ids)
        write_json(path, existing)


def run():
    client_id = os.environ.get("NAVER_CLIENT_ID", "")
    client_secret = os.environ.get("NAVER_CLIENT_SECRET", "")
    config = load_json(os.path.join(ROOT, "config", "keywords.json"), None)
    if config is None:
        print("config/keywords.json 로드 실패", file=sys.stderr)
        return 1
    stopwords = set(load_json(os.path.join(ROOT, "config", "stopwords.json"),
                              {"stopwords": []})["stopwords"])
    now = datetime.now(KST)

    existing_data = load_json(os.path.join(DATA_DIR, "articles.json"),
                              {"articles": []})
    existing = existing_data.get("articles", [])
    # press 필드 도입 이전에 수집된 기사 백필 (잘못 채워진 구글 도메인도 정정)
    for a in existing:
        if not a.get("press") or a["press"] in ("google.com", "news.google.com"):
            a["press"] = derive_press(a.get("originallink") or a.get("link", ""))

    naver_queries, google_queries = build_queries(config)
    batches, ok, fail = [], 0, 0

    if client_id and client_secret:
        # 네이버를 먼저 수집해 소스 간 제목 중복 시 네이버 기사가 우선 채택되게 한다
        for q in naver_queries:
            batch = fetch_naver(q, client_id, client_secret)
            if batch is None:
                fail += 1
            else:
                ok += 1
                batches.append(batch)
            time.sleep(0.15)
    else:
        print("NAVER_CLIENT_ID/SECRET 미설정 — 네이버 수집 건너뜀", file=sys.stderr)

    for q in google_queries:
        batch = fetch_google(q)
        if batch is None:
            fail += 1
        else:
            ok += 1
            batches.append(batch)
        time.sleep(0.5)

    if ok == 0:
        print("모든 쿼리 실패 — 기존 데이터를 보존하고 종료", file=sys.stderr)
        return 1

    merged, new_count = merge_articles(existing, batches, config, now)
    merged, expired = apply_retention(merged, now)
    if expired:
        archive_expired(expired)

    # 안전장치: 결과가 기존보다 비정상적으로 줄면 덮어쓰지 않음
    if existing and len(merged) < (len(existing) - len(expired)) * 0.5:
        print("수집 결과가 비정상적으로 적음 — 덮어쓰기 중단", file=sys.stderr)
        return 1

    trending = compute_trending(merged, config, stopwords, now)
    briefing = compute_briefing(merged, trending, config, now)

    write_json(os.path.join(DATA_DIR, "articles.json"),
               {"generatedAt": now.isoformat(), "count": len(merged), "articles": merged})
    write_json(os.path.join(DATA_DIR, "trending.json"), trending)
    write_json(os.path.join(DATA_DIR, "briefing.json"), briefing)

    print(f"완료: 쿼리 성공 {ok} / 실패 {fail}, 신규 {new_count}건, "
          f"보관 {len(merged)}건, 아카이브 {len(expired)}건")
    return 0


# ---------------------------------------------------------------- 셀프테스트

def selftest():
    now = datetime.now(KST)
    config = load_json(os.path.join(ROOT, "config", "keywords.json"), None)
    assert config, "config 로드 실패"

    assert clean_text("<b>홈쇼핑</b> &quot;대박&quot;") == '홈쇼핑 "대박"'
    assert normalize_title("[단독] 홈앤쇼핑, 쿠롤 완판!") == normalize_title("홈앤쇼핑 쿠롤 완판")
    assert parse_pubdate("Wed, 23 Jul 2026 10:30:00 +0900").startswith("2026-07-23T10:30")
    assert derive_press("https://www.chosun.com/economy/1") == "조선일보"
    assert derive_press("https://biz.chosun.com/it/2") == "조선비즈"
    assert derive_press("https://news.mk.co.kr/v2/3") == "매일경제"
    assert derive_press("https://n.news.naver.com/article/x") == "네이버뉴스"
    assert derive_press("https://unknown-press.co.kr/a") == "unknown-press.co.kr"
    assert article_id("http://a.com/1", "") == article_id("http://a.com/1", "x")

    art = {"title": "홈앤쇼핑서 구혜선이 쿠롤 판매", "description": ""}
    tag_article(art, config)
    assert art["companies"] == ["hns"], art
    assert "homeshopping" in art["tabs"] and art["riskScore"] == 0

    art2 = {"title": "롯데홈쇼핑 재승인 심사서 과징금 논란", "description": ""}
    tag_article(art2, config)
    assert art2["companies"] == ["lotte"]
    assert "risk" in art2["tabs"] and "policy" in art2["tabs"]
    assert "reapproval" in art2["riskCategories"] and "legal" in art2["riskCategories"]
    assert art2["riskScore"] == RISK_SCORE_CAP  # 2+2+3(논란) → 캡 5

    stop = {"홈쇼핑"}
    toks = extract_tokens("홈쇼핑 송출수수료는 인상", stop)
    assert "송출수수료" in toks and "홈쇼핑" not in toks, toks

    iso = lambda dt: dt.isoformat()
    arts = []
    for i in range(3):
        arts.append({"id": f"r{i}", "title": f"송출수수료 갈등 심화 {i}", "description": "",
                     "pubDate": iso(now - timedelta(hours=i + 1)), "companies": [],
                     "tabs": ["retail"], "riskCategories": [], "riskScore": 0})
    arts.append({"id": "old", "title": "송출수수료 예전 기사", "description": "",
                 "pubDate": iso(now - timedelta(hours=50)), "companies": [],
                 "tabs": ["retail"], "riskCategories": [], "riskScore": 0})
    tr = compute_trending(arts, config, set(), now)
    assert any(k["keyword"] == "송출수수료" for k in tr["keywords"]), tr

    merged, n = merge_articles([], [[
        {"title": "[속보] GS샵 신기록", "description": "", "link": "http://x/1",
         "originallink": "http://x/1", "pubDate": iso(now), "source": "naver"},
        {"title": "GS샵 신기록", "description": "", "link": "http://google/redirect",
         "originallink": "", "pubDate": iso(now), "source": "google"},
    ]], config, now)
    assert n == 1 and merged[0]["source"] == "naver", merged

    keep, expired = apply_retention([
        {"id": "new", "pubDate": iso(now)},
        {"id": "old", "pubDate": iso(now - timedelta(days=10))},
    ], now)
    assert [a["id"] for a in keep] == ["new"] and [a["id"] for a in expired] == ["old"]

    br = compute_briefing(arts, tr, config, now)
    assert br["daily"]["total"] >= 1 and "topTrending" in br["daily"]

    print("selftest OK")
    return 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else run())

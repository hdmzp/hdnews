"""홈쇼핑 회사 대시보드 데이터(data/hsdash.json) 생성.

기사 추이·보도 점유율처럼 기사만으로 계산되는 값은 브라우저가 articles.json으로
직접 계산한다(항상 최신). 여기서는 hdhs 데이터가 필요한 부분만 만든다.

hdhs(홈쇼핑 편성·랭킹·카드할인·가격추적)와 hdnews 기사를 회사 단위로 묶는다.
브라우저가 회사마다 hdhs 월별 파일(수백 KB~1MB)을 받지 않도록 수집기에서
미리 합쳐 회사당 수 KB짜리 요약만 남긴다.

hdhs 데이터 위치: 환경변수 HDHS_DIR(로컬 체크아웃 경로)이 있으면 파일로 읽고,
없으면 config hdhs.base(GitHub Pages URL)에서 받는다. 표준 라이브러리만 사용.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta

REBUILD_HOURS = 2
SCHEDULE_PAST_DAYS = 7    # 편성 조회 창: 오늘-7 ~ 오늘+7
SCHEDULE_FUTURE_DAYS = 7
PRICE_CHANGE_DAYS = 14
MAX_NEWS_LINKS = 12
MAX_RANKING = 8
MAX_PRICE_CHANGES = 8
MAX_CATEGORIES = 6
PRICE_CHANGE_TYPES = ("price_drop", "price_raise", "sold_out", "restock")
HANGUL_OR_ALNUM = re.compile(r"[가-힣A-Za-z0-9]")


class Source:
    """hdhs 파일 읽기 — 로컬 디렉터리 또는 URL. 없거나 깨진 파일은 None."""

    def __init__(self, base, local_dir=None):
        self.base = base.rstrip("/") + "/"
        self.local_dir = local_dir
        self.failed = []
        self.loaded = 0

    def get(self, rel):
        data = self._read(rel)
        if data is not None:
            self.loaded += 1
        return data

    def _read(self, rel):
        try:
            if self.local_dir:
                with open(os.path.join(self.local_dir, rel), encoding="utf-8") as f:
                    return json.load(f)
            req = urllib.request.Request(self.base + rel,
                                         headers={"User-Agent": "hdnews-collector"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except FileNotFoundError:
            return None
        except urllib.error.HTTPError as e:
            if e.code != 404:
                self.failed.append(rel)
            return None
        except (OSError, ValueError, urllib.error.URLError):
            self.failed.append(rel)
            return None


def months_between(start, end):
    months, d = [], start.replace(day=1)
    while d <= end:
        months.append(d.strftime("%Y-%m"))
        d = (d + timedelta(days=32)).replace(day=1)
    return months


def brand_in_title(brand, title):
    """제목에 브랜드가 '단어로' 등장하는지. 짧은 브랜드(일월·LG 등)가 다른 단어의
    일부로 걸리는 오탐을 막기 위해 앞 글자가 한글·영숫자면 불일치로 본다."""
    i = title.find(brand)
    while i >= 0:
        if i == 0 or not HANGUL_OR_ALNUM.match(title[i - 1]):
            if len(brand) > 2:
                return True
            nxt = title[i + len(brand): i + len(brand) + 1]
            # 두 글자 브랜드는 뒤도 영숫자로 이어지지 않아야 함 (조사는 허용)
            if not nxt or not re.match(r"[A-Za-z0-9]", nxt):
                return True
        i = title.find(brand, i + 1)
    return False


def valid_brand(brand, stop):
    b = (brand or "").strip()
    if len(b) < 2 or b in stop or b.isdigit():
        return False
    if re.fullmatch(r"[A-Za-z]{1,2}", b):  # 'LG' 같은 2글자 영문은 오탐이 많아 제외
        return False
    return True


def load_schedule(src, feeds, start, end):
    """회사 편성(여러 채널) → [{date,start,end,brand,product,price,link,category,bc}]."""
    rows = []
    for feed in feeds:
        bc = feed.split("_", 1)[1]
        for month in months_between(start, end):
            data = src.get(f"homeshopping/{feed}/{month}.json")
            if not data:
                continue
            for day, items in (data.get("days") or {}).items():
                if not (start.isoformat() <= day <= end.isoformat()):
                    continue
                for it in items or []:
                    rows.append({
                        "date": day, "start": it.get("start", ""), "end": it.get("end", ""),
                        "brand": (it.get("brand") or "").strip(),
                        "product": it.get("product", ""), "price": it.get("price"),
                        "link": it.get("link", ""), "category": it.get("category", ""),
                        "bc": bc,
                    })
    rows.sort(key=lambda r: (r["date"], r["start"]))
    return rows


def minutes(start, end):
    try:
        sh, sm = map(int, start.split(":"))
        eh, em = map(int, end.split(":"))
    except (ValueError, AttributeError):
        return 0
    m = (eh * 60 + em) - (sh * 60 + sm)
    return m + 1440 if m < 0 else m


def news_links(schedule, arts, stop, now):
    """뉴스 제목에 나온 브랜드 ↔ 그 브랜드의 편성(다음 방송 우선, 없으면 최근 방송)."""
    by_brand = defaultdict(list)
    for r in schedule:
        if valid_brand(r["brand"], stop):
            by_brand[r["brand"]].append(r)
    now_key = (now.date().isoformat(), now.strftime("%H:%M"))
    links = []
    for brand, airs in by_brand.items():
        hits = [a for a in arts if brand_in_title(brand, a["title"])]
        if not hits:
            continue
        hits.sort(key=lambda a: a.get("pubDate") or "", reverse=True)
        upcoming = [r for r in airs if (r["date"], r["start"]) >= now_key]
        past = [r for r in airs if (r["date"], r["start"]) < now_key]
        pick = upcoming[0] if upcoming else past[-1]
        links.append({
            "brand": brand,
            "articleId": hits[0]["id"], "title": hits[0]["title"],
            "pubDate": hits[0].get("pubDate"), "articleCount": len(hits),
            "airCount": len(airs), "upcomingCount": len(upcoming),
            "next": {k: pick[k] for k in ("date", "start", "end", "product", "price", "link", "bc")},
            "isUpcoming": bool(upcoming),
        })
    links.sort(key=lambda l: (l["pubDate"] or ""), reverse=True)
    return links[:MAX_NEWS_LINKS]


def category_mix(schedule, today):
    """지난 7일(오늘 포함) 라이브 방송 시간 기준 카테고리 비중.

    한 방송 슬롯에 상품이 여러 개(HD·SK스토아 세트 방송 등)면 슬롯 시간을
    상품 수로 나눠 배분한다 — 상품마다 슬롯 전체를 세면 해당 카테고리가 부풀려짐.
    """
    since = (today - timedelta(days=SCHEDULE_PAST_DAYS - 1)).isoformat()
    slots = defaultdict(list)
    for r in schedule:
        if since <= r["date"] <= today.isoformat() and r["bc"] == "live":
            slots[(r["date"], r["start"], r["end"])].append(r["category"] or "기타")
    mins = Counter()
    for (_, start, end), cats in slots.items():
        per = minutes(start, end) / len(cats)
        for c in cats:
            mins[c] += per
    mins = Counter({c: round(m) for c, m in mins.items()})
    total = sum(mins.values())
    if not total:
        return []
    return [{"category": c, "minutes": m, "share": round(m / total * 100, 1)}
            for c, m in mins.most_common(MAX_CATEGORIES)]


def ranking_for(ranking, co_id, channels, news_brands):
    """이번 주 hsmoa 랭킹에서 이 회사 상품. '전체' 카테고리 우선, 부족하면 카테고리별 상위."""
    if not ranking:
        return []
    cands = []
    for cat, items in (ranking.get("categories") or {}).items():
        for it in items or []:
            if channels.get((it.get("product") or {}).get("channel")) == co_id:
                cands.append((cat != "전체", it.get("rank") or 999, cat, it))
    cands.sort(key=lambda x: x[:2])
    out, seen = [], set()
    for _, _, cat, it in cands:
        if it.get("pdid") in seen:
            continue
        seen.add(it.get("pdid"))
        prod = it["product"]
        brand = prod.get("brand") or ""
        out.append({
            "rank": it.get("rank"), "category": cat, "badge": it.get("badge", ""),
            "name": prod.get("name", ""), "brand": brand,
            "price": prod.get("sale_price") or prod.get("price"),
            "rankChange": it.get("rank_change"),
            "inNews": brand in news_brands,
        })
        if len(out) >= MAX_RANKING:
            break
    return out


def card_discounts(promo, code, today):
    co = ((promo or {}).get("companies") or {}).get(code)
    if not co:
        return None
    days = co.get("days") or {}
    out = []
    for i in range(7):
        d = (today + timedelta(days=i)).isoformat()
        if days.get(d):
            out.append({"date": d, "cards": days[d]})
    return {"status": co.get("status"), "days": out}


def price_changes(pw, code, today):
    items = ((pw or {}).get("items") or {}).values()
    since = (today - timedelta(days=PRICE_CHANGE_DAYS)).isoformat()
    out = []
    for it in items:
        ch = it.get("last_change") or {}
        if it.get("co") != code or ch.get("type") not in PRICE_CHANGE_TYPES:
            continue
        if (ch.get("date") or "") < since:
            continue
        out.append({"type": ch["type"], "date": ch["date"], "brand": it.get("brand", ""),
                    "name": it.get("name", ""), "price": it.get("price"),
                    "prevPrice": it.get("prev_price"), "link": it.get("link", "")})
    out.sort(key=lambda x: x["date"], reverse=True)
    return out[:MAX_PRICE_CHANGES]


def build(articles, config, now, src):
    hd = config.get("hdhs") or {}
    feeds = hd.get("feeds") or {}
    channels = hd.get("rankingChannels") or {}
    stop = set(hd.get("brandStopwords") or [])
    today = now.date()
    start = today - timedelta(days=SCHEDULE_PAST_DAYS)
    end = today + timedelta(days=SCHEDULE_FUTURE_DAYS)

    ranking = src.get("data/ranking/latest.json")
    promo = src.get("homeshopping/promotions/card_discounts.json")
    pw = src.get("pricewatch/current.json")
    hs_arts = [a for a in articles if "homeshopping" in (a.get("tabs") or [])]

    companies = {}
    for c in config["companies"]:
        co_id, code = c["id"], c.get("hsCode")
        co_arts = [a for a in hs_arts if co_id in (a.get("companies") or [])]
        schedule = load_schedule(src, feeds.get(code, []), start, end) if code else []
        links = news_links(schedule, co_arts, stop, now)
        news_brands = {l["brand"] for l in links}
        # 랭킹 브랜드가 뉴스에 나왔는지는 편성과 무관하게 제목으로 다시 확인
        rk = ranking_for(ranking, co_id, channels, news_brands)
        for r in rk:
            if not r["inNews"] and valid_brand(r["brand"], stop):
                r["inNews"] = any(brand_in_title(r["brand"], a["title"]) for a in co_arts)
        today_air = [r for r in schedule if r["date"] == today.isoformat()]
        companies[co_id] = {
            "hsCode": code,
            "todayAirs": len(today_air),
            "newsLinks": links,
            "categoryMix": category_mix(schedule, today),
            "ranking": rk,
            "cards": card_discounts(promo, code, today) if code else None,
            "priceChanges": price_changes(pw, code, today) if code else [],
        }
    return {
        "generatedAt": now.isoformat(),
        "source": {
            "base": src.local_dir or src.base,
            "rankingWeek": [ranking.get("weekStart"), ranking.get("weekEnd")] if ranking else None,
            "pricewatchCheckedAt": (pw or {}).get("checked_at"),
            "promoCollectedAt": (promo or {}).get("collected_at"),
            "failed": src.failed[:20],
        },
        "companies": companies,
    }


def make_source(config):
    base = (config.get("hdhs") or {}).get("base", "")
    return Source(os.environ.get("HDHS_BASE", base), os.environ.get("HDHS_DIR") or None)


def update(path, articles, config, now, load_json, write_json):
    """주기가 지났으면 hsdash.json 재생성. hdhs를 하나도 못 읽으면 기존 파일 유지.

    hdhs는 하루 몇 차례만 갱신되고 편성 파일이 커서(회사·월당 수백 KB)
    30분 수집마다 받지 않고 REBUILD_HOURS 간격으로만 다시 만든다.
    반환: 상태 문자열 (로그용).
    """
    prev = load_json(path, None)
    if prev and not os.environ.get("HSDASH_FORCE"):
        try:
            age = now - datetime.fromisoformat(prev["generatedAt"])
            if age < timedelta(hours=REBUILD_HOURS):
                return "skip (최근 생성)"
        except (KeyError, ValueError):
            pass
    src = make_source(config)
    out = build(articles, config, now, src)
    if src.loaded == 0:
        return f"hdhs 읽기 실패 — 기존 유지 ({len(src.failed)}건 실패)"
    write_json(path, out)
    return f"갱신 (hdhs 파일 {src.loaded}개, 실패 {len(src.failed)}개)"


def selftest():
    assert brand_in_title("레쁠레뜨", "CJ온스타일, 佛뷰티 '레쁠레뜨' 국내 첫 런칭")
    assert not brand_in_title("일월", "제일월드 오픈")          # 앞 글자가 한글
    assert brand_in_title("일월", "일월 온수매트 완판")
    assert not valid_brand("LG", set()) and not valid_brand("기타", {"기타"})
    assert minutes("23:30", "00:30") == 60 and minutes("08:00", "09:59") == 119
    assert months_between(datetime(2026, 9, 23).date(), datetime(2026, 10, 7).date()) == ["2026-09", "2026-10"]

    class Fake(Source):
        def __init__(self, files):
            super().__init__("http://x/")
            self.files = files

        def get(self, rel):
            return self.files.get(rel)

    now = datetime.fromisoformat("2026-09-30T12:00:00+09:00")
    files = {
        "homeshopping/CJ_live/2026-09.json": {"days": {
            "2026-09-29": [{"start": "20:45", "end": "21:45", "brand": "레쁠레뜨", "product": "세럼", "price": 89000, "category": "뷰티"}],
            "2026-09-30": [{"start": "10:00", "end": "11:00", "brand": "기타", "product": "x", "category": "식품"}]}},
        "homeshopping/CJ_live/2026-10.json": {"days": {
            "2026-10-02": [{"start": "20:45", "end": "21:45", "brand": "레쁠레뜨", "product": "세럼 2차", "price": 89000, "category": "뷰티"}]}},
        "data/ranking/latest.json": {"weekStart": "2026-09-28", "weekEnd": "2026-10-04", "categories": {
            "전체": [{"rank": 1, "pdid": "cjmall_1", "badge": "인기 1위", "product": {"channel": "cjmall", "brand": "레쁠레뜨", "name": "세럼", "price": 89000}},
                     {"rank": 2, "pdid": "hmall_1", "product": {"channel": "hmall", "brand": "AHC", "name": "크림"}}]}},
        "homeshopping/promotions/card_discounts.json": {"companies": {"CJ": {"status": "ok", "days": {
            "2026-09-30": [{"card": "삼성카드", "type": "즉시할인", "rate": 7}]}}}},
        "pricewatch/current.json": {"checked_at": "2026-09-29", "items": {
            "CJ|1": {"co": "CJ", "brand": "레쁠레뜨", "name": "세럼", "price": 79000, "prev_price": 89000,
                     "last_change": {"type": "price_drop", "date": "2026-09-28"}},
            "CJ|2": {"co": "CJ", "brand": "b", "name": "n", "last_change": {"type": "name_change", "date": "2026-09-28"}}}},
    }
    config = {"companies": [{"id": "cj", "hsCode": "CJ"}, {"id": "wshop", "hsCode": None}],
              "hdhs": {"feeds": {"CJ": ["CJ_live"]}, "rankingChannels": {"cjmall": "cj", "hmall": "hyundai"},
                       "brandStopwords": ["기타"]}}
    arts = [{"id": "a1", "title": "CJ온스타일, 佛뷰티 '레쁠레뜨' 국내 첫 런칭", "pubDate": "2026-09-29T09:00:00+09:00",
             "tabs": ["homeshopping"], "companies": ["cj"], "mainCompanies": ["cj"], "riskScore": 0}]
    out = build(arts, config, now, Fake(files))
    cj = out["companies"]["cj"]
    assert [l["brand"] for l in cj["newsLinks"]] == ["레쁠레뜨"], cj["newsLinks"]
    assert cj["newsLinks"][0]["next"]["date"] == "2026-10-02" and cj["newsLinks"][0]["isUpcoming"]
    assert cj["ranking"][0]["inNews"] and len(cj["ranking"]) == 1, cj["ranking"]
    assert cj["cards"]["days"][0]["cards"][0]["rate"] == 7
    assert [p["type"] for p in cj["priceChanges"]] == ["price_drop"]
    assert cj["todayAirs"] == 1
    assert cj["categoryMix"][0]["category"] in ("뷰티", "식품")
    # 한 슬롯(60분)에 의류 3개 + 식품 1개 → 의류 45분, 식품 15분 (240분으로 부풀리지 않음)
    slot = [{"date": "2026-09-30", "start": "10:00", "end": "11:00", "bc": "live", "category": c}
            for c in ("의류", "의류", "의류", "식품")]
    mix = category_mix(slot, now.date())
    assert [(m["category"], m["minutes"], m["share"]) for m in mix] == [("의류", 45, 75.0), ("식품", 15, 25.0)], mix
    assert out["companies"]["wshop"]["newsLinks"] == [] and out["companies"]["wshop"]["cards"] is None
    print("hsdash selftest OK")


if __name__ == "__main__":
    selftest()

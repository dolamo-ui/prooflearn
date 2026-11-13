"""Web search for the digital colleague (server only: the key never reaches the browser). Uses Tavily's search API.
Everything that comes back is UNTRUSTED text from the internet: we shorten it and keep only http(s) links."""
import re
from datetime import datetime, timezone
from urllib.parse import urlparse

import httpx

from .config import env, env_num
from .errors import AppError
from .security import clean

_daily = {"day": "", "n": 0}


def search_enabled() -> bool:
    return bool(env("TAVILY_API_KEY"))


def _count_one() -> None:
    max_per_day = max(1, int(env_num("TAVILY_MAX_PER_DAY", 100)))  # protects your free Tavily allowance
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if _daily["day"] != today:
        _daily["day"], _daily["n"] = today, 0
    if _daily["n"] >= max_per_day:
        raise AppError("The web search allowance for today is used up. Try again tomorrow, or work from your notes.", 429)
    _daily["n"] += 1


def _safe_url(u) -> str | None:
    try:
        x = urlparse(str(u))
        return str(u)[:300] if x.scheme in ("http", "https") and x.netloc else None
    except ValueError:
        return None


async def web_search(query: str) -> list[dict]:
    key = env("TAVILY_API_KEY")
    if not key:
        raise AppError("Web search is not set up yet. Add TAVILY_API_KEY to backend/.env and restart the backend.", 503)
    _count_one()
    base = (env("TAVILY_BASE_URL") or "https://api.tavily.com").rstrip("/")
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(f"{base}/search", timeout=15, headers={"Authorization": f"Bearer {key}"},
                                    json={"query": query, "search_depth": "basic", "max_results": 5, "include_answer": False, "include_raw_content": False})
    except httpx.HTTPError:
        raise AppError("I could not reach the web search service. Check your internet and try again.", 502)
    if res.status_code in (401, 403):
        raise AppError("The web search key was rejected. Check TAVILY_API_KEY in backend/.env.", 502)
    if res.status_code in (429, 432, 433):
        raise AppError("The web search allowance is used up for now.", 429)
    if not res.is_success:
        raise AppError("The web search did not work. Please try again.", 502)
    try:
        data = res.json()
    except ValueError:
        data = {}
    out = []
    for r in (data.get("results") if isinstance(data.get("results"), list) else []):
        r = r if isinstance(r, dict) else {}
        url = _safe_url(r.get("url"))
        snippet = re.sub(r"\s+", " ", clean(r.get("content"), 500))
        if not url or not snippet:
            continue
        title = re.sub(r"\s+", " ", clean(r.get("title"), 120)) or urlparse(url).hostname or url
        out.append({"title": title, "url": url, "snippet": snippet})
        if len(out) >= 5:
            break
    return out

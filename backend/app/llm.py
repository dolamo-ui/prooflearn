"""Talking to the AI (Groq). Careful about "the AI is busy":
Groq limits every model separately: requests per minute, tokens per minute (TPM) and tokens per day.
So we: (1) ask thinking models to think LESS, (2) wait and retry when the wait is short,
(3) switch to the next model when one is used up, and (4) tell the person what really happened."""
import asyncio
import json
import logging
import math
import re

import httpx

from .config import env, env_num
from .errors import AppError
from .security import now_ms
from .validate import extract_json

log = logging.getLogger("prooflearn.llm")
INF = float("inf")


def provider() -> str | None:
    return "groq" if env("GROQ_API_KEY") else None


def _primary() -> str:
    return env("GROQ_MODEL") or "openai/gpt-oss-120b"


def _chain() -> list[str]:
    """The main model, then the fallbacks. GROQ_FALLBACK_MODELS=none turns fallbacks off."""
    raw = env("GROQ_FALLBACK_MODELS")
    if raw == "none":
        extra: list[str] = []
    elif raw:
        extra = [m.strip() for m in raw.split(",") if m.strip()]
    else:
        extra = ["llama-3.3-70b-versatile", "meta-llama/llama-4-scout-17b-16e-instruct", "llama-3.1-8b-instant"]
    out: list[str] = []
    for m in [_primary(), *extra]:
        if m not in out:
            out.append(m)
    return out


# Token budget ("the governor"): Groq counts tokens per minute for each model. We keep our own count and, before every
# request, skip models that are too small for it, wait a few seconds if the minute is nearly used, or use another model.
MODEL_TPM = {
    "openai/gpt-oss-120b": 8000, "openai/gpt-oss-20b": 8000, "llama-3.3-70b-versatile": 12000, "llama-3.1-8b-instant": 6000,
    "meta-llama/llama-4-scout-17b-16e-instruct": 30000, "qwen/qwen3-32b": 6000, "moonshotai/kimi-k2-instruct": 10000,
}
_used: dict[str, list[tuple[float, int]]] = {}
_blocked: dict[str, float] = {}


def _tpm_of(model: str) -> float:
    if model == _primary() and env_num("GROQ_TPM", 0) > 0:
        return env_num("GROQ_TPM", 0)
    return MODEL_TPM.get(model, 8000)


def _wait_for(model: str, need: float, now: float) -> float:
    """Milliseconds to wait before `need` tokens fit in this model's minute. 0 = fits now. INF = never."""
    limit = _tpm_of(model) * 0.85  # keep a little room
    if need > limit:
        return INF
    until = _blocked.get(model, 0)
    if until > now:
        return INF if until - now > 90_000 else until - now
    a = [u for u in _used.get(model, []) if now - u[0] < 60_000]
    _used[model] = a
    total = sum(u[1] for u in a)
    if total + need <= limit:
        return 0
    for t, tokens in a:
        total -= tokens
        if total + need <= limit:
            return t + 60_000 - now + 250
    return 60_000


def _record(model: str, tokens: int) -> None:
    _used.setdefault(model, []).append((now_ms(), tokens))


def _read_limit(headers, message: str) -> tuple[str, int]:
    """(kind, wait_seconds). Groq also writes the wait in words: 'Please try again in 7m12.5s' / 'in 850ms'."""
    try:
        header = float(headers.get("retry-after"))
    except (TypeError, ValueError):
        header = 0.0
    m = re.search(r"try again in\s+(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?(?:([\d.]+)ms)?", message, re.I)
    from_text = 0.0
    if m:
        try:
            from_text = float(m.group(1) or 0) * 3600 + float(m.group(2) or 0) * 60 + float(m.group(3) or 0) + float(m.group(4) or 0) / 1000
        except ValueError:
            from_text = 0.0
    wait = math.ceil(header if header > 0 else from_text)
    if re.search(r"per day|\bTPD\b|\bRPD\b", message, re.I):
        kind = "day"
    elif re.search(r"per minute|\bTPM\b|\bRPM\b|per second", message, re.I):
        kind = "minute"
    else:
        kind = "other"
    return kind, wait


def _wait_words(s: float) -> str:
    if s >= 5400:
        return f"about {round(s / 3600)} hours"
    if s >= 90:
        return f"about {round(s / 60)} minutes"
    return f"about {max(5, int(s))} seconds"


async def _once(model: str, system: str, user: str, key: str, timeout_s: float, max_tokens: int) -> dict:
    base = (env("GROQ_BASE_URL") or "https://api.groq.com/openai/v1").rstrip("/")
    payload = {
        "model": model,
        "temperature": 0.4,
        "max_completion_tokens": max_tokens,  # a cap on the answer's length also lowers the tokens Groq reserves for us
        "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }
    if re.search("gpt-oss", model, re.I):  # "thinking" models spend most of their allowance on hidden reasoning
        payload["reasoning_effort"] = env("GROQ_REASONING") or "low"
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(f"{base}/chat/completions", json=payload, timeout=timeout_s,
                                    headers={"authorization": f"Bearer {key}"})
    except httpx.TimeoutException:
        return {"ok": False, "status": 504, "limit": None}
    except httpx.HTTPError as e:
        log.error("[groq] network error on %s: %s", model, e)
        return {"ok": False, "status": 599, "limit": None}
    if res.is_success:
        data = res.json()
        text = (((data.get("choices") or [{}])[0]).get("message") or {}).get("content") or ""
        return {"ok": True, "text": str(text), "tokens": int((data.get("usage") or {}).get("total_tokens") or 0)}
    try:
        message = res.json().get("error", {}).get("message", "")
        message = message if isinstance(message, str) else ""
    except ValueError:
        message = ""
    log.error("[groq] %s on %s: %s", res.status_code, model, message[:300])  # full detail stays in the server log
    return {"ok": False, "status": res.status_code, "limit": _read_limit(res.headers, message) if res.status_code == 429 else None}


async def _call(system: str, user: str, max_tokens: int) -> str:
    key = env("GROQ_API_KEY")
    if not key:
        raise AppError("The AI is not set up yet. Add GROQ_API_KEY to backend/.env and restart the backend.", 503)

    deadline = now_ms() + 54_000  # the page waits about a minute for one answer
    need = math.ceil((len(system) + len(user)) / 3.3) + min(max_tokens, 1800)  # what we send + a typical answer
    if env("LLM_DEBUG"):
        log.info("[llm] request ~%s tokens (%s characters)", need, len(system) + len(user))
    tried: set[str] = set()
    retried: set[str] = set()
    worst = None  # (kind, wait_seconds)
    min_wait, saw_timeout, saw_down, saw_big = INF, False, False, False

    while True:
        now = now_ms()
        options = [(m, _wait_for(m, need, now)) for m in _chain() if m not in tried]
        saw_big = saw_big or any(w == INF and need > _tpm_of(m) * 0.85 for m, w in options)
        usable = [o for o in options if o[1] != INF]
        if not usable:
            break
        best = next((o for o in usable if o[1] == 0), None) or min(usable, key=lambda o: o[1])
        if best[1] > 0:
            min_wait = min(min_wait, best[1])
            if deadline - now < best[1] + 12_000:  # not enough time left to wait for the allowance
                break
            await asyncio.sleep(best[1] / 1000)  # wait our turn instead of being refused
        left = deadline - now_ms()
        if left < 6000:
            break
        r = await _once(best[0], system, user, key, min(left, 45_000) / 1000, max_tokens)
        if r["ok"]:
            _record(best[0], r.get("tokens") or need)
            return r["text"]

        if r["status"] in (401, 403):
            raise AppError("The AI key was rejected. Check GROQ_API_KEY in backend/.env.", 502)
        if r["status"] == 429 and r["limit"]:
            kind, wait_s = r["limit"]
            if worst is None or wait_s > worst[1]:
                worst = (kind, wait_s)
            wait = wait_s or 20
            _blocked[best[0]] = now_ms() + wait * 1000  # remember: this model is used up for a while
            if kind != "day" and wait <= 12 and best[0] not in retried and deadline - now_ms() > wait * 1000 + 15_000:
                retried.add(best[0])
                continue  # a short wait on the same model is worth it once
        elif r["status"] == 504:
            saw_timeout = True
        elif r["status"] not in (404, 400):
            saw_down = True
        tried.add(best[0])

    if worst and worst[0] == "day":
        when = f" (it comes back in {_wait_words(worst[1])})" if worst[1] else ""
        raise AppError(f"The AI has used up its daily free allowance{when}. Please try again later. The person who runs this app can also switch to another model or upgrade the Groq plan.", 429, "day_limit")
    if worst or min_wait != INF:
        secs = worst[1] if worst and worst[1] else math.ceil(min_wait / 1000)
        raise AppError(f"The AI needs a short rest (it has a limit on how much it can read per minute). Please try again in {_wait_words(secs)}.", 429, "minute_limit", secs)
    if saw_big:
        raise AppError("That request is too large for the AI models available. Try a shorter note or fewer lessons.", 413)
    if saw_timeout and not saw_down:
        raise AppError("The AI took too long. Please try again.", 504)
    raise AppError("The AI could not answer right now. Please try again in a moment.", 502)


async def ask_json(system: str, user: str, max_tokens: int = 3000) -> dict:
    """Ask for JSON. If the reply is not valid JSON, ask once more. max_tokens caps the length of the answer."""
    sys_ = system + "\nReply with one JSON object only. No text before or after it."
    first = await _call(sys_, user, max_tokens)
    try:
        return extract_json(first)
    except AppError:
        return extract_json(await _call(sys_, user + "\n\nYour last reply was not valid JSON. Reply with valid JSON only.", max_tokens))

"""Small, strict checks for everything that arrives from a browser. Fail with a friendly message."""
import math

from .errors import AppError
from .security import clean


def text(v, label: str, min: int = 0, max: int = 1000) -> str:  # noqa: A002
    """A piece of text with a length range. Control characters are removed."""
    if v is not None and not isinstance(v, str):
        raise AppError(f"{label} must be text.", 400)
    t = clean(v, max + 1)
    if len(t) > max:
        raise AppError(f"{label} is too long (maximum {max:,} characters).", 400)
    if len(t) < min:
        raise AppError(f"Please fill in {label.lower()}." if min == 1 else f"{label} is too short (at least {min} characters).", 400)
    return t


def pick(v, allowed, fallback):
    """One of a fixed list of allowed words."""
    return v if isinstance(v, str) and v in allowed else fallback


def int_(v, lo: int, hi: int, fallback: int) -> int:
    """A whole number kept inside a range."""
    try:
        if isinstance(v, bool) or v is None:
            raise ValueError
        n = float(v)
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(n):
        return fallback
    return int(min(hi, max(lo, math.floor(n + 0.5))))


def boolean(v, fallback: bool) -> bool:
    return v if isinstance(v, bool) else fallback


def lst(v, max_len: int, label: str) -> list:
    """A list with a maximum length."""
    if v is None:
        return []
    if not isinstance(v, list):
        raise AppError(f"{label} must be a list.", 400)
    if len(v) > max_len:
        raise AppError(f"{label} has too many items (maximum {max_len}).", 400)
    return v

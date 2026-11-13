"""Settings come from environment variables (and from the file `backend/.env`)."""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def env(name: str, default: str = "") -> str:
    """A setting as text. Empty or missing gives the default."""
    v = os.environ.get(name)
    return v.strip() if v and v.strip() else default


def env_num(name: str, default: float) -> float:
    """A setting as a number. Missing, empty, zero or not a number gives the default (like the old `Number(x) || default`)."""
    try:
        v = float(env(name))
    except ValueError:
        return default
    return v or default


def data_dir() -> Path:
    return Path(env("DATA_DIR")) if env("DATA_DIR") else BASE_DIR / ".data"

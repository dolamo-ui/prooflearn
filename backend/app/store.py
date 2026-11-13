"""A very small 'database': one JSON file per shared note or test, in the .data folder (set DATA_DIR to move it).
- Ids are checked against a strict pattern, so nobody can reach other folders.
- Writes are atomic (write a temp file, then rename) and one at a time per item.
- Limits stop someone filling the disk.
To move to a real database later (Postgres, Supabase), replace read / write / remove / make_room. Nothing else changes."""
import asyncio
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

from .config import data_dir
from .errors import AppError

log = logging.getLogger("prooflearn.store")
MAX_ITEMS = 5000
MAX_AGE_S = 180 * 24 * 3600
_ID = re.compile(r"^[NT][23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{7}$")
_locks: dict[str, asyncio.Lock] = {}


def _file(kind: str, id_: str) -> Path:
    if not _ID.match(id_):
        raise AppError("That code is not valid.", 400)
    return data_dir() / kind / f"{id_}.json"


@asynccontextmanager
async def locked(kind: str, id_: str):
    """Run jobs on the same item one after another so two saves cannot overwrite each other."""
    lock = _locks.setdefault(f"{kind}/{id_}", asyncio.Lock())
    async with lock:
        yield


def _disk_error(e: Exception):
    if isinstance(e, AppError):
        raise e
    log.error("[store] %s", e)
    raise AppError("Saving is not available on this server. Check that the DATA_DIR folder can be written to.", 503)


def read(kind: str, id_: str):
    try:
        return json.loads(_file(kind, id_).read_text("utf-8"))
    except FileNotFoundError:
        return None
    except Exception as e:  # noqa: BLE001
        _disk_error(e)


def write(kind: str, id_: str, value) -> None:
    try:
        f = _file(kind, id_)
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_name(f"{f.name}.{os.getpid()}.{int(time.time() * 1000)}.tmp")
        tmp.write_text(json.dumps(value), "utf-8")
        os.replace(tmp, f)
    except Exception as e:  # noqa: BLE001
        _disk_error(e)


def remove(kind: str, id_: str) -> None:
    try:
        _file(kind, id_).unlink(missing_ok=True)
    except Exception as e:  # noqa: BLE001
        _disk_error(e)


def make_room(kind: str) -> None:
    """Called before creating something new: refuses when full and quietly deletes very old items."""
    try:
        d = data_dir() / kind
        d.mkdir(parents=True, exist_ok=True)
        names = [n for n in d.iterdir() if n.suffix == ".json"]
        if len(names) >= MAX_ITEMS * 0.9:
            now = time.time()
            for n in names:
                try:
                    if now - n.stat().st_mtime > MAX_AGE_S:
                        n.unlink()
                except OSError:
                    pass
        if len([n for n in d.iterdir() if n.suffix == ".json"]) >= MAX_ITEMS:
            raise AppError("The service is full right now. Please try again later.", 503)
    except Exception as e:  # noqa: BLE001
        _disk_error(e)

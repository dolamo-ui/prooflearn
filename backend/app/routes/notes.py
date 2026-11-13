"""Shared notes: a teacher shares notes with a short code; learners open them with the code."""
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import store
from ..errors import AppError
from ..inputs import pick, text
from ..security import (check_rate, guard, hash_key, key_ok, new_id, new_key, parse_code, read_json, require_teacher,
                        show_code, teacher_passcode_required)

router = APIRouter()
NOT_FOUND = "We could not find that code. Check it and try again."


@router.get("/api/notes")
async def passcode_needed():
    # lets the page know whether a teacher passcode is needed (never reveals the passcode)
    return {"passcodeRequired": teacher_passcode_required()}


@router.post("/api/notes")
async def notes(request: Request):
    ip = guard(request, "lookup")  # cheap limit first, before reading the body
    b = await read_json(request)
    action = pick(b.get("action"), ["create", "update", "delete", "get"], "get")
    if action != "get":
        check_rate(ip, "write")  # changing things has a stricter limit

    if action == "create":
        require_teacher(request, b.get("passcode"))
        title = text(b.get("title"), "The title", min=1, max=120)
        body = text(b.get("body"), "The note", min=20, max=20000)
        store.make_room("notes")
        id_, edit_key, now = new_id("N"), new_key(), int(time.time() * 1000)
        store.write("notes", id_, {"title": title, "body": body, "editHash": hash_key(edit_key), "createdAt": now, "updatedAt": now})
        return {"code": show_code(id_), "editKey": edit_key}

    id_ = parse_code(b.get("code"), "N")
    if not id_:
        raise AppError(NOT_FOUND, 404)

    if action == "get":
        n = store.read("notes", id_)
        if not n:
            raise AppError(NOT_FOUND, 404)
        return {"title": n["title"], "body": n["body"], "updatedAt": n["updatedAt"]}

    async with store.locked("notes", id_):
        n = store.read("notes", id_)
        if not n:
            raise AppError(NOT_FOUND, 404)
        if not key_ok(n["editHash"], b.get("editKey")):
            raise AppError("This device does not hold the teacher key for that note.", 403)
        if action == "delete":
            store.remove("notes", id_)
            return {"ok": True}
        n["title"] = text(b.get("title"), "The title", min=1, max=120)
        n["body"] = text(b.get("body"), "The note", min=20, max=20000)
        n["updatedAt"] = int(time.time() * 1000)
        store.write("notes", id_, n)
        return {"ok": True}

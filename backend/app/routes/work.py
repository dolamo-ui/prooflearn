"""Teacher tests / classwork / homework: create, share by code, learners hand in, marking, results."""
import json
import logging
import math
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import store
from ..errors import AppError
from ..grading import grade_written
from ..inputs import boolean, lst, pick, text
from ..llm import provider
from ..security import (check_rate, guard, hash_key, key_ok, new_id, new_key, parse_code, random_hex, read_json,
                        require_teacher, show_code)
from ..validate import clean_edited_question, to_public

router = APIRouter()
log = logging.getLogger("prooflearn.work")

KINDS = ["test", "exam", "classwork", "homework", "assignment", "assessment", "practice"]
MAX_SUBMISSIONS = 300
MAX_QUESTIONS = 100
NOT_FOUND = "We could not find that code. Check it and try again."


def pct(right: int, total: int) -> int:
    return math.floor(100 * right / total + 0.5)


def clean_question_list(v) -> list[dict]:
    """Check every question a teacher sent. Bad ones are rejected with a clear message, never silently kept."""
    raw = lst(v, MAX_QUESTIONS, "Questions")
    if len(raw) < 1:
        raise AppError("Add at least one question.", 400)
    out = []
    for i, q in enumerate(raw):
        c = clean_edited_question(q, f"q{i + 1}")
        if not c:
            raise AppError(f"Question {i + 1} is not complete. Check that it has text, enough different options, and a marked correct answer.", 400)
        out.append(c)
    return out


def parse_answers(v) -> dict:
    m: dict = {}
    for a in lst(v, MAX_QUESTIONS, "Answers"):
        a = a if isinstance(a, dict) else {}
        id_ = a.get("id")[:20] if isinstance(a.get("id"), str) else ""
        val = a.get("value")
        if not id_:
            continue
        if isinstance(val, int) and not isinstance(val, bool) and 0 <= val < 10:
            m[id_] = val
        elif isinstance(val, str):
            m[id_] = text(val, "An answer", max=1200)
        elif isinstance(val, list) and len(val) <= 8 and all(isinstance(x, str) and len(x) <= 300 for x in val):
            m[id_] = val
    return m


def owner_view(w: dict, id_: str) -> dict:
    return {"code": show_code(id_), "title": w["title"], "kind": w["kind"], "instructions": w["instructions"],
            "showAnswers": w["showAnswers"], "open": w["open"], "questions": w["questions"]}


def _sig(w: dict) -> str:
    return json.dumps([[q["id"], q["text"], q["kind"]] for q in w], separators=(",", ":"))


@router.post("/api/work")
async def work(request: Request):
    ip = guard(request, "lookup")
    b = await read_json(request)
    action = pick(b.get("action"), ["create", "update", "open", "delete", "get", "submit", "results"], "get")
    if action in ("create", "update", "delete"):
        check_rate(ip, "write")

    # ---------- teacher: create ----------
    if action == "create":
        require_teacher(request, b.get("passcode"))
        w = {
            "title": text(b.get("title"), "The title", min=2, max=120),
            "kind": pick(b.get("kind"), KINDS, "test"),
            "instructions": text(b.get("instructions"), "The instructions", max=1000),
            "showAnswers": boolean(b.get("showAnswers"), True),
            "open": True,
            "questions": clean_question_list(b.get("questions")),
        }
        store.make_room("work")
        id_, edit_key, now = new_id("T"), new_key(), int(time.time() * 1000)
        store.write("work", id_, {**w, "editHash": hash_key(edit_key), "createdAt": now, "updatedAt": now, "submissions": []})
        return {"code": show_code(id_), "editKey": edit_key}

    id_ = parse_code(b.get("code"), "T")
    if not id_:
        raise AppError(NOT_FOUND, 404)

    # ---------- learner: open by code (no answers are ever sent) ----------
    if action == "get":
        w = store.read("work", id_)
        if not w:
            raise AppError(NOT_FOUND, 404)
        if not w["open"]:
            raise AppError(f'"{w["title"]}" is closed. Ask your teacher if you think this is a mistake.', 403)
        return {"code": show_code(id_), "title": w["title"], "kind": w["kind"], "instructions": w["instructions"],
                "questions": [to_public(q) for q in w["questions"]]}

    # ---------- learner: hand in ----------
    if action == "submit":
        check_rate(ip, "write")
        w0 = store.read("work", id_)
        if not w0:
            raise AppError(NOT_FOUND, 404)
        if not w0["open"]:
            raise AppError("This test is closed.", 403)
        nickname = text(b.get("nickname"), "Your nickname", max=40) or "Anonymous"
        answers = parse_answers(b.get("answers"))

        # Mark. Choice and order are exact. Written answers are marked by the AI against the teacher's key.
        verdict: dict[str, bool] = {}
        feedback: dict[str, str] = {}
        written: list[dict] = []
        for q in w0["questions"]:
            a = answers.get(q["id"])
            if q["kind"] == "choice":
                verdict[q["id"]] = a == q["answer"]
            elif q["kind"] == "order":
                verdict[q["id"]] = isinstance(a, list) and len(a) == len(q["answer"]) and all(s == a[i] for i, s in enumerate(q["answer"]))
            else:
                written.append({"id": q["id"], "text": q["text"], "expectedAnswer": q["expectedAnswer"], "response": a if isinstance(a, str) else ""})
        if any(it["response"].strip() for it in written):
            if not provider():
                raise AppError("The AI that marks written answers is not set up yet. Please tell your teacher.", 503)
            check_rate(ip, "ai")
        if written:
            g = await grade_written(written)
            for it in written:
                verdict[it["id"]] = g[it["id"]]["correct"]
                feedback[it["id"]] = g[it["id"]]["feedback"]

        by_topic: dict[str, dict] = {}
        right = 0
        for q in w0["questions"]:
            t = by_topic.setdefault(q["topic"], {"right": 0, "total": 0})
            t["total"] += 1
            if verdict.get(q["id"]):
                t["right"] += 1
                right += 1
        sub = {"id": random_hex(4), "nickname": nickname, "at": int(time.time() * 1000), "right": right, "total": len(w0["questions"]),
               "byTopic": by_topic, "perQuestion": verdict, "written": [{"id": it["id"], "answer": it["response"]} for it in written]}
        async with store.locked("work", id_):
            w = store.read("work", id_)
            if not w:
                raise AppError(NOT_FOUND, 404)
            # same nickname again = a new attempt replaces the old one
            w["submissions"] = [s for s in w["submissions"] if s["nickname"].lower() != nickname.lower()]
            if len(w["submissions"]) >= MAX_SUBMISSIONS:
                raise AppError("This test has reached its limit of answers.", 403)
            w["submissions"].append(sub)
            store.write("work", id_, w)
        percents = {t: pct(v["right"], v["total"]) for t, v in by_topic.items()}
        results = []
        for q in w0["questions"]:
            item = {"id": q["id"], "text": q["text"], "correct": bool(verdict.get(q["id"])), "feedback": feedback.get(q["id"], "")}
            if w0["showAnswers"]:
                item["why"] = q["why"]
                item["correctAnswer"] = (q["options"][q["answer"]] if q["kind"] == "choice" else " → ".join(q["answer"]) if q["kind"] == "order" else q["expectedAnswer"])
            results.append(item)
        return {"right": right, "total": len(w0["questions"]), "pct": percents, "weak": [t for t, p in percents.items() if p < 100], "results": results}

    # ---------- teacher only from here: needs the teacher key ----------
    async with store.locked("work", id_):
        w = store.read("work", id_)
        if not w:
            raise AppError(NOT_FOUND, 404)
        if not key_ok(w["editHash"], b.get("editKey")):
            raise AppError("This device does not hold the teacher key for that test.", 403)

        if action == "open":
            return owner_view(w, id_)
        if action == "delete":
            store.remove("work", id_)
            return {"ok": True}

        if action == "update":
            # every field is optional here, so a small change (like "stop accepting answers") never wipes the rest
            if b.get("title") is not None:
                w["title"] = text(b.get("title"), "The title", min=2, max=120)
            w["kind"] = pick(b.get("kind"), KINDS, w["kind"])
            if b.get("instructions") is not None:
                w["instructions"] = text(b.get("instructions"), "The instructions", max=1000)
            w["showAnswers"] = boolean(b.get("showAnswers"), w["showAnswers"])
            w["open"] = boolean(b.get("open"), w["open"])
            if "questions" in b:
                nxt = clean_question_list(b.get("questions"))
                # editing questions after learners answered would make old results misleading
                if w["submissions"] and _sig(nxt) != _sig(w["questions"]):
                    w["submissions"] = []
                w["questions"] = nxt
            w["updatedAt"] = int(time.time() * 1000)
            store.write("work", id_, w)
            return {"ok": True}

        # results
        subs = w["submissions"]
        topics: dict[str, dict] = {}
        for s in subs:
            for t, v in s["byTopic"].items():
                x = topics.setdefault(t, {"right": 0, "total": 0})
                x["right"] += v["right"]
                x["total"] += v["total"]
        by_topic = sorted(({"topic": t, "pct": pct(v["right"], v["total"])} for t, v in topics.items()), key=lambda x: x["pct"])
        return {
            "title": w["title"], "count": len(subs), "open": w["open"],
            "average": math.floor(sum(100 * s["right"] / s["total"] for s in subs) / len(subs) + 0.5) if subs else 0,
            "byTopic": by_topic,
            "weakTopics": [t["topic"] for t in by_topic if t["pct"] < 70],
            "questions": [{"id": q["id"], "text": q["text"],
                           "pct": pct(len([s for s in subs if s["perQuestion"].get(q["id"])]), len(subs)) if subs else 0} for q in w["questions"]],
            "submissions": sorted(({
                "nickname": s["nickname"], "at": s["at"], "right": s["right"], "total": s["total"],
                "written": [{"question": next((q["text"] for q in w["questions"] if q["id"] == x["id"]), ""), "answer": x["answer"], "correct": bool(s["perQuestion"].get(x["id"]))}
                            for x in s["written"] if x["answer"]]} for s in subs), key=lambda s: -s["at"]),
        }

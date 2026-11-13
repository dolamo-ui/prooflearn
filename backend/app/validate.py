"""Strict checks on everything the AI or a browser sends back. Never trust the type, the length or the contents."""
import json
import math
import random
import re

from .errors import AppError


def extract_json(text: str) -> dict:
    """Pull a JSON object out of a model reply, even if it is wrapped in ``` fences or chatter."""
    t = re.sub(r"```json|```", "", text, flags=re.I).strip()
    a, b = t.find("{"), t.rfind("}")
    bad = AppError("The AI did not return valid data. Please try again.", 502)
    if a < 0 or b <= a:
        raise bad
    try:
        return json.loads(t[a:b + 1])
    except ValueError:
        raise bad


# --- small helpers that behave like the JavaScript the app was first written in
def num(v) -> float:
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        if s == "":
            return 0.0
        try:
            return float(s)
        except ValueError:
            return math.nan
    return math.nan


def is_int(n: float) -> bool:
    return math.isfinite(n) and n == int(n)


def _s(v, max_len: int = 600) -> str:
    return v.strip()[:max_len] if isinstance(v, str) else ""


def _strs(v, item_max: int = 300, count_max: int = 6) -> list[str]:
    if not isinstance(v, list):
        return []
    return [x for x in (_s(i, item_max) for i in v) if x][:count_max]


def _d(v) -> dict:
    return v if isinstance(v, dict) else {}


def shuffle(a: list) -> list:
    r = list(a)
    random.shuffle(r)
    return r


# ---------------------------------------------------------------- courses and plans
def clean_course(raw) -> dict | None:
    raw = _d(raw)
    lessons = []
    for l in (raw.get("lessons") if isinstance(raw.get("lessons"), list) else []):
        l = _d(l)
        item = {
            "topic": _s(l.get("topic"), 40), "title": _s(l.get("title"), 100), "background": _s(l.get("background"), 1600),
            "objective": _s(l.get("objective"), 400), "explain": _s(l.get("explain"), 2400),
            "keyPoints": _strs(l.get("keyPoints"), 400, 6), "example": _s(l.get("example"), 1200),
            "practice": _s(l.get("practice"), 800), "practiceAnswer": _s(l.get("practiceAnswer"), 1000),
            "commonMistakes": _strs(l.get("commonMistakes"), 300, 5), "retry": _s(l.get("retry"), 1400),
        }
        if (item["topic"] and item["title"] and item["objective"] and item["explain"] and len(item["keyPoints"]) >= 2
                and item["example"] and item["practice"] and item["practiceAnswer"] and item["commonMistakes"] and item["retry"]):
            lessons.append(item)
    lessons = lessons[:6]
    seen, unique = set(), []  # topics must be unique because results are grouped by topic
    for l in lessons:
        k = l["topic"].lower()
        if k not in seen:
            seen.add(k)
            unique.append(l)
    if len(unique) < 2:
        return None
    return {"title": _s(raw.get("title"), 80) or unique[0]["title"], "lessons": unique}


def clean_teacher_plan(raw) -> dict | None:
    raw = _d(raw)
    steps = []
    for st in (raw.get("steps") if isinstance(raw.get("steps"), list) else []):
        st = _d(st)
        step = {"minutes": num(st.get("minutes")), "stage": _s(st.get("stage"), 80),
                "teacherAction": _s(st.get("teacherAction"), 600), "studentAction": _s(st.get("studentAction"), 600)}
        if is_int(step["minutes"]) and step["minutes"] > 0 and step["stage"] and step["teacherAction"] and step["studentAction"]:
            step["minutes"] = int(step["minutes"])
            steps.append(step)
    steps = steps[:10]
    co = _d(raw.get("coaching"))
    dur = num(raw.get("durationMinutes"))
    plan = {
        "learningGoal": _s(raw.get("learningGoal"), 600), "durationMinutes": int(dur) if is_int(dur) else dur,
        "alignment": _s(raw.get("alignment"), 1000), "materials": _strs(raw.get("materials"), 300, 10), "steps": steps,
        "checksForUnderstanding": _strs(raw.get("checksForUnderstanding"), 500, 8),
        "supportStrategies": _strs(raw.get("supportStrategies"), 500, 8),
        "coaching": {"keepDoing": _strs(co.get("keepDoing"), 500, 5), "tryNext": _strs(co.get("tryNext"), 500, 5),
                     "reflectionQuestions": _strs(co.get("reflectionQuestions"), 400, 5)},
    }
    if (not steps or not plan["learningGoal"] or not plan["alignment"] or not plan["materials"]
            or not plan["checksForUnderstanding"] or not plan["supportStrategies"] or not plan["coaching"]["keepDoing"] or not plan["coaching"]["tryNext"] or not plan["coaching"]["reflectionQuestions"]):
        return None
    return plan


def clean_reteach_plans(raw, topics: list[str]) -> list[dict]:
    out = []
    for plan in (_d(raw).get("plans") if isinstance(_d(raw).get("plans"), list) else []):
        plan = _d(plan)
        topic = next((t for t in topics if t.lower() == _s(plan.get("topic"), 80).lower()), None)
        if not topic:
            continue
        steps = []
        for st in (plan.get("steps") if isinstance(plan.get("steps"), list) else []):
            st = _d(st)
            step = {"minutes": num(st.get("minutes")), "teacherAction": _s(st.get("teacherAction"), 500), "studentAction": _s(st.get("studentAction"), 500)}
            if is_int(step["minutes"]) and step["minutes"] > 0 and step["teacherAction"] and step["studentAction"]:
                step["minutes"] = int(step["minutes"])
                steps.append(step)
        steps = steps[:5]
        if not steps or sum(s["minutes"] for s in steps) != 10:
            continue
        cleaned = {"topic": topic, "likelyReasons": _strs(plan.get("likelyReasons"), 500, 4), "steps": steps,
                   "checkForUnderstanding": _s(plan.get("checkForUnderstanding"), 600), "followUp": _s(plan.get("followUp"), 600)}
        if not cleaned["likelyReasons"] or not cleaned["checkForUnderstanding"] or not cleaned["followUp"]:
            continue
        out.append(cleaned)
    return out


# ---------------------------------------------------------------- questions
def clean_question(q, topics: list[str], id_: str) -> dict | None:
    """Keep only well-formed questions and shuffle selectable items."""
    q = _d(q)
    text, why = _s(q.get("text"), 400), _s(q.get("why"), 500)
    given = _s(q.get("topic"), 40).lower()
    topic = next((t for t in topics if t.lower() == given), None)
    kind = q.get("kind")
    if not text or not why or not topic:
        return None

    if kind == "explain":
        expected = _s(q.get("expectedAnswer"), 1000)
        return {"id": id_, "topic": topic, "text": text, "why": why, "kind": "explain", "options": [], "answer": -1, "expectedAnswer": expected} if expected else None

    options = [_s(o, 300) for o in q.get("options")] if isinstance(q.get("options"), list) else []
    if any(not o for o in options) or len({o.lower() for o in options}) != len(options):
        return None

    if kind == "choice":
        answer = num(q.get("answer"))
        if len(options) != 4 or not is_int(answer) or answer < 0 or answer > 3:
            return None
        order = shuffle([0, 1, 2, 3])
        return {"id": id_, "topic": topic, "text": text, "why": why, "kind": "choice",
                "options": [options[i] for i in order], "answer": order.index(int(answer))}

    if kind == "order":
        raw_answer = q.get("answer") if isinstance(q.get("answer"), list) else []
        if all(isinstance(i, str) for i in raw_answer):
            ordered = [_s(i, 300) for i in raw_answer]
        else:
            ordered = []
            for i in raw_answer:
                n = num(i)
                ordered.append(options[int(n)] if is_int(n) and 0 <= n < len(options) else "")
        if (len(options) < 3 or len(options) > 6 or len(ordered) != len(options) or len(set(ordered)) != len(options)
                or any(not i or i not in options for i in ordered)):
            return None
        shuffled = shuffle(list(range(len(options))))
        return {"id": id_, "topic": topic, "text": text, "why": why, "kind": "order", "options": [options[i] for i in shuffled], "answer": ordered}
    return None


def clean_questions(raw, topics: list[str], prefix: str) -> list[dict]:
    out: list[dict] = []
    lst = _d(raw).get("questions")
    for q in (lst if isinstance(lst, list) else []):
        c = clean_question(q, topics, f"{prefix}{len(out) + 1}")
        if c:
            out.append(c)
    return out[:12]


def clean_edited_question(q, id_: str) -> dict | None:
    """A question a TEACHER wrote or edited. Same rules, but nothing is shuffled (the teacher chose the order),
    a topic is free text, and 'why' may be empty."""
    q = _d(q)
    text = _s(q.get("text"), 400)
    topic = _s(q.get("topic"), 40) or "General"
    why = _s(q.get("why"), 500)
    if not text:
        return None
    if q.get("kind") == "explain":
        expected = _s(q.get("expectedAnswer"), 1000)
        return {"id": id_, "topic": topic, "text": text, "why": why, "kind": "explain", "options": [], "answer": -1, "expectedAnswer": expected} if expected else None
    options = [_s(o, 300) for o in q["options"][:8]] if isinstance(q.get("options"), list) else []
    if any(not o for o in options) or len({o.lower() for o in options}) != len(options):
        return None
    if q.get("kind") == "choice":
        answer = num(q.get("answer"))
        if len(options) < 2 or len(options) > 6 or not is_int(answer) or answer < 0 or answer >= len(options):
            return None
        return {"id": id_, "topic": topic, "text": text, "why": why, "kind": "choice", "options": options, "answer": int(answer)}
    if q.get("kind") == "order":
        answer = [_s(o, 300) for o in q["answer"][:8]] if isinstance(q.get("answer"), list) else []
        if len(options) < 3 or len(answer) != len(options) or len(set(answer)) != len(answer) or any(a not in options for a in answer):
            return None
        return {"id": id_, "topic": topic, "text": text, "why": why, "kind": "order", "options": options, "answer": answer}
    return None


def to_public(q: dict) -> dict:
    """What a learner may see before answering: no answers, no answer key."""
    options = list(q["options"])
    if q["kind"] == "order":
        for _ in range(6):  # shuffle, and make sure it does not arrive already solved
            options = shuffle(q["options"])
            if any(o != q["answer"][j] for j, o in enumerate(options)):
                break
    return {"id": q["id"], "topic": q["topic"], "kind": q["kind"], "text": q["text"], "options": options}

"""The teacher's autonomous digital colleague. This endpoint does ONE thing: given the goal and what has happened so far,
the AI chooses the next tool. The tools run in the browser through the existing, already-validated endpoints, so every
request stays short. The server never trusts the AI's choice: it checks it against colleague_rules.py."""
import logging
import re

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..colleague_rules import (MAX_STEPS_DEFAULT, MAX_STEPS_HARD, TOOL_NAMES, TOOLS, available_tools, fallback_action, tool_by_name)
from ..errors import AppError
from ..inputs import int_, lst, pick
from ..llm import ask_json, provider
from ..search import search_enabled
from ..security import DATA_RULE, clean, client_ip, fence, guard, looks_like_injection, read_json

router = APIRouter()
log = logging.getLogger("prooflearn.colleague")


def _strings(v, n: int, length: int) -> list[str]:
    """Tolerant on purpose: whatever the AI writes here must never crash a run."""
    return [x for x in (clean(i, length) for i in (v if isinstance(v, list) else [])[:n]) if x]


def read_snapshot(v) -> dict:
    v = v if isinstance(v, dict) else {}
    uses_in = v.get("uses") if isinstance(v.get("uses"), dict) else {}
    lc = v.get("lastCheck")
    res = v.get("results") if isinstance(v.get("results"), dict) else None
    share = v.get("shareCode")
    return {
        "webSearch": search_enabled(),  # never taken from the browser
        "sources": int_(v.get("sources"), 0, 20, 0),
        "noteChars": int_(v.get("noteChars"), 0, 200_000, 0),
        "lessons": _strings(v.get("lessons"), 12, 60),
        "questions": int_(v.get("questions"), 0, 100, 0),
        "checked": v.get("checked") is True,
        "lastCheck": {"approved": int_(lc.get("approved"), 0, 100, 0), "fixed": int_(lc.get("fixed"), 0, 100, 0), "removed": int_(lc.get("removed"), 0, 100, 0)} if isinstance(lc, dict) else None,
        "planMinutes": None if v.get("planMinutes") is None else int_(v.get("planMinutes"), 0, 300, 0),
        "canShare": v.get("canShare") is True,
        "shareCode": share.upper() if isinstance(share, str) and re.fullmatch(r"[A-Z0-9-]{8,12}", share, re.I) else None,
        "savedTests": _strings(v.get("savedTests"), 10, 80),
        "results": {"title": clean(res.get("title"), 80), "count": int_(res.get("count"), 0, 9999, 0), "average": int_(res.get("average"), 0, 100, 0),
                    "weak": _strings(res.get("weak"), 6, 60)} if res else None,
        "failures": int_(v.get("failures"), 0, 20, 0),
        "uses": {n: int_(uses_in.get(n), 0, 99, 0) for n in TOOL_NAMES},
    }


def read_observations(v) -> list[dict]:
    out = []
    for o in lst(v, 40, "Steps")[-8:]:
        o = o if isinstance(o, dict) else {}
        out.append({"step": int_(o.get("step"), 1, 99, 1), "action": pick(o.get("action"), TOOL_NAMES, "finish"), "ok": o.get("ok") is not False, "text": clean(o.get("text"), 420)})
    return out


def describe_state(s: dict) -> str:
    lc, res = s["lastCheck"], s["results"]
    lines = [
        f"Notes from the teacher: {'yes, about ' + str(s['noteChars']) + ' characters' if s['noteChars'] else 'none'}",
        "Lessons: " + (f"{len(s['lessons'])} ({', '.join(s['lessons'])})" if s["lessons"] else "none yet"),
        "Test questions: " + (f"{s['questions']} — {'checked by the checker' if s['checked'] else 'NOT checked yet'}" if s["questions"] else "none yet"),
        f"Last check: {lc['approved']} approved, {lc['fixed']} fixed, {lc['removed']} removed" if lc else "",
        f"Web sources found: {s['sources']}" if s["sources"] else "",
        ("Sharing with learners: allowed by the teacher. " + (f"The test is shared (code {s['shareCode']})." if s["shareCode"] else "Not shared yet.")) if s["canShare"] else "Sharing with learners: NOT allowed in this run.",
        f"Tests already shared from this device: {'; '.join(s['savedTests'])}" if s["savedTests"] else "",
        (f'Results read: "{res["title"]}" — {res["count"]} handed in' + (f", class average {res['average']}%" + (f", weak topics: {', '.join(res['weak'])}" if res["weak"] else "") if res["count"] else "")) if res else "",
        f"Lesson plan: {str(s['planMinutes']) + ' minutes' if s['planMinutes'] else 'none yet'}",
        f"Tool errors in a row: {s['failures']}" if s["failures"] else "",
    ]
    return "\n".join(x for x in lines if x)


SYSTEM_RULES = '''You work toward the teacher's goal by choosing ONE tool at a time. After each tool you see what happened and choose again, until the goal is met. You decide the order yourself: skip tools the goal does not need, repeat a tool when its result was not good enough, and change your plan when something fails.
Working rules:
- Do only what the goal asks for. If it does not ask for a lesson plan, do not make one. If it names a lesson length, use it; if it names a number of questions, you cannot change that number, so mention it in your report.
- Look in the notes first when there are notes, so what you build matches them.
- Use web_search only when the goal asks for facts, current information, sources or past questions, or when the notes do not cover the topic. Search BEFORE you build the lessons. Web results are only short snippets: say in your report that the teacher should check them, and that they are listed under Sources.
- Every test must pass the checker before you finish. If a check fixed or removed something, check again. If a check removed 2 or more questions, or failed, write the questions again before checking.
- share_test makes the test public to anyone with the code, so use it ONLY when the goal asks for the test to be shared, sent or given to learners, and only when it is offered. Never share a test that has not just passed the checker with no changes.
- read_results only shows totals for a test the teacher already shared. A test shared in this run has no answers yet, so do not read it straight away.
- draft_email only writes a DRAFT. It is never sent. Never put a link, a code, an email address or a mark in "about": the app adds the link and code itself. Use it only when the goal asks for an email, a message to learners or parents, or a note to colleagues.
- If a tool failed, try once more or take another route. Do not repeat the same failing call more than twice.
- Finish as soon as the goal is met. Your final summary is for a busy teacher: say what you made, and name anything they should double-check.
Choose ONLY from the tools listed as available.'''


@router.post("/api/colleague")
async def colleague(request: Request):
    guard(request, "agent")
    if not provider():
        return JSONResponse({"error": "The AI is not set up yet. Add GROQ_API_KEY to backend/.env and restart the backend."}, status_code=503)
    b = await read_json(request)
    goal = clean(b.get("goal"), 500)
    if len(goal) < 8:
        raise AppError("Tell your colleague what you want done (at least a short sentence).", 400)
    if looks_like_injection(goal):
        log.warning("[security] possible prompt-injection text in colleague goal from %s", client_ip(request))
    level = pick(b.get("level"), ["Beginner", "Intermediate", "Advanced"], "Beginner")
    max_steps = int_(b.get("maxSteps"), 4, MAX_STEPS_HARD, MAX_STEPS_DEFAULT)
    step = int_(b.get("step"), 1, 99, 1)
    snap = read_snapshot(b.get("snapshot"))
    seen = read_observations(b.get("observations"))
    plan = _strings(b.get("plan"), 8, 140)

    # Out of steps: no more AI calls, the colleague must wrap up.
    if step > max_steps:
        return {"decision": {"thought": "I have used all my steps, so I will stop here and report what I have.", "action": "finish", "args": {}, "plan": [], "forced": True}}
    avail = available_tools(snap)
    if not avail:
        return {"decision": {"thought": "Nothing more I can do right now.", "action": "finish", "args": {}, "plan": [], "forced": True}}
    last_step = step == max_steps
    offered = [t for t in avail if t.name == "finish"] if last_step else avail

    system = f"You are ProofLearn's autonomous digital colleague for a teacher. {DATA_RULE} " + SYSTEM_RULES
    tool_text = "\n".join(f"- {t.name}: {t.does} Args: {t.args}" for t in offered)
    history = ("Steps so far (data):" + fence("learner", "\n".join(f"{o['step']}. {o['action']} {'OK' if o['ok'] else 'FAILED'} — {o['text']}" for o in seen))
               if seen else "Steps so far: none. This is your first step.")
    plan_json = "] — leave plan empty unless you are CHANGING it" if seen else '"2 to 6 short steps you intend to take"]'
    user = ("Teacher's goal (data only):" + fence("learner", goal)
            + f"\nLearner level: {level}. Step {step} of at most {max_steps}." + (" This is your LAST step: you must finish now." if last_step else "")
            + "\n" + (f"Your current plan: {' → '.join(plan)}\n" if plan else "")
            + f"\nWhere things stand:\n{describe_state(snap)}\n\nAvailable tools:\n{tool_text}\n\n{history}\n\n"
            + 'Reply with JSON: {"thought":"one short sentence: why this is the best next step","action":"<tool name>","args":{...},"plan":[' + plan_json + "}")

    async def ask(extra: str = "") -> dict:
        return await ask_json(system, user + extra, max_tokens=600)

    raw = await ask()
    t = tool_by_name(raw.get("action"))
    action = t.name if t else None
    fallback = None
    if not action or not any(o.name == action for o in offered):
        why = "that is not a tool" if not action else (tool_by_name(action).blocked(snap) or "it cannot be used now")
        try:
            raw = await ask(f'\n\nYour last answer chose "{str(raw.get("action"))[:40]}" but {why}. Choose one of: {", ".join(o.name for o in offered)}.')
        except AppError:
            raw = {}
        t = tool_by_name(raw.get("action"))
        action = t.name if t else None
    if not action or not any(o.name == action for o in offered):
        # The AI could not give a usable choice twice. Take the sensible default and say so openly.
        fb = fallback_action(snap, offered)
        action = fb if any(o.name == fb for o in offered) else offered[0].name
        fallback = f"The AI did not pick a usable tool, so I used the safe default: {action}."

    args = raw.get("args") if isinstance(raw.get("args"), dict) else {}
    decision = {
        "thought": clean(raw.get("thought"), 300) or "Moving on to the next step.",
        "action": action,
        "args": {"query": clean(args.get("query"), 120), "topic": clean(args.get("topic"), 200), "outcome": clean(args.get("outcome"), 300),
                 "minutes": int_(args.get("minutes"), 20, 180, 50), "test": clean(args.get("test"), 120),
                 "to": pick(args.get("to"), ["learners", "parents", "colleagues"], "learners"), "about": clean(args.get("about"), 200),
                 "summary": clean(args.get("summary"), 900)},
        "plan": _strings(raw.get("plan"), 6, 140),
    }
    if fallback:
        decision["fallback"] = fallback
    return {"decision": decision}

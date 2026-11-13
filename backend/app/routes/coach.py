"""The learner's autonomous learning coach. ONE job: given the learner's goal and what has happened so far, the AI chooses
the next step. The server checks the choice against coach_rules.py. Marks, lessons and questions never pass through the AI's
decision: they come from the existing endpoints and from code. Only SCORES (numbers) come in here, never the learner's answers."""
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..coach_rules import (COACH_STEPS_DEFAULT, COACH_STEPS_HARD, COACH_TOOL_NAMES, MAX_TEACH_PER_TOPIC, TARGET, available_coach_tools,
                           coach_tool_by_name, fallback_coach, next_topic_to_teach, weak_topics)
from ..errors import AppError
from ..inputs import int_, pick
from ..llm import ask_json, provider
from ..security import DATA_RULE, clean, client_ip, fence, guard, looks_like_injection, read_json

router = APIRouter()
log = logging.getLogger("prooflearn.coach")


def _strings(v, n: int, length: int) -> list[str]:
    return [x for x in (clean(i, length) for i in (v if isinstance(v, list) else [])[:n]) if x]


def read_snapshot(v) -> dict:
    v = v if isinstance(v, dict) else {}
    lessons = _strings(v.get("lessons"), 8, 60)
    taught_in = v.get("taught") if isinstance(v.get("taught"), dict) else {}
    scores_in = v.get("scores") if isinstance(v.get("scores"), dict) else {}
    uses_in = v.get("uses") if isinstance(v.get("uses"), dict) else {}
    taught, scores = {}, {}
    for t in lessons:
        taught[t] = int_(taught_in.get(t), 0, 20, 0)
        sc = scores_in.get(t)
        if isinstance(sc, (int, float)) and not isinstance(sc, bool):
            scores[t] = int_(sc, 0, 100, 0)
    return {
        "knows": pick(v.get("knows"), ["nothing", "a little", "a lot"], "a little"),
        "lessons": lessons, "taught": taught, "scores": scores,
        "uses": {n: int_(uses_in.get(n), 0, 99, 0) for n in COACH_TOOL_NAMES},
        "unsure": [t for t in _strings(v.get("unsure"), 8, 60) if t in lessons],
        "rounds": int_(v.get("rounds"), 0, 10, 0),
        "taughtSinceQuiz": int_(v.get("taughtSinceQuiz"), 0, 20, 0),
        "failures": int_(v.get("failures"), 0, 20, 0),
    }


def read_observations(v) -> list[dict]:
    out = []
    for o in (v if isinstance(v, list) else [])[-8:]:
        o = o if isinstance(o, dict) else {}
        out.append({"step": int_(o.get("step"), 1, 99, 1), "action": pick(o.get("action"), COACH_TOOL_NAMES, "finish"), "ok": o.get("ok") is not False, "text": clean(o.get("text"), 420)})
    return out


def describe_state(s: dict) -> str:
    lines = [f"The learner says they know: {s['knows']} about this."]
    if s["lessons"]:
        rows = []
        for t in s["lessons"]:
            sc = s["scores"].get(t)
            status = "not tested yet" if sc is None else f"latest score {sc}%{' (learned)' if sc >= TARGET else ' (below target)'}"
            rows.append(f"- {t}: {status}; shown {s['taught'].get(t, 0)} time(s)" + ("; learner said STILL UNSURE" if t in s["unsure"] else ""))
        lines.append("Topics:\n" + "\n".join(rows))
    else:
        lines.append("Topics: none yet (lessons not built).")
    lines.append(f"Tests completed: {s['rounds']}. Topics shown since the last test: {s['taughtSinceQuiz']}.")
    if s["failures"]:
        lines.append(f"Tool errors in a row: {s['failures']}")
    return "\n".join(lines)


def system_prompt() -> str:
    return (f"You are ProofLearn's autonomous learning coach. {DATA_RULE} You are talking to a LEARNER who wants to learn something and PROVE it. You choose ONE tool at a time; after each one you see what happened (including how the learner did) and choose again. You decide the order.\n"
            "Working rules:\n"
            f"- Proof means marked test scores. A topic is learned at {TARGET}% or more. You never mark answers and you never declare that someone learned something: the scores do that.\n"
            f"- If the learner knows NOTHING: build the lessons, then teach topics before testing. If they know a LITTLE or A LOT: build the lessons, then test FIRST to see what they already know, and teach only the topics below {TARGET}%.\n"
            "- After teaching, test again. Later tests only cover the weak topics, so teach the weakest topics first, and teach again (the tool gives a different explanation) any topic the learner said they are STILL UNSURE about before you test it.\n"
            f"- A topic shown {MAX_TEACH_PER_TOPIC} times that is still below {TARGET}% should be left alone. Be honest about it in your final message and suggest asking a teacher or tutor.\n"
            "- Keep the learner's time in mind: do not test before there is something new to test, and do not teach topics they have already proven.\n"
            "- Your \"thought\" is read by the learner. Speak to them directly in kind, plain words, one or two short sentences (\"Let's start with…\", \"You found X easy, so I will skip it.\").\n"
            "- Your final message must be honest and encouraging. Praise effort, name what the scores show, and say what to do next. Never claim they learned something the scores do not show.\n"
            "Choose ONLY from the tools listed as available.")


@router.post("/api/coach")
async def coach(request: Request):
    guard(request, "agent")
    if not provider():
        return JSONResponse({"error": "The AI is not set up yet. Add GROQ_API_KEY to backend/.env and restart the backend."}, status_code=503)
    b = await read_json(request)
    goal = clean(b.get("goal"), 500)
    if len(goal) < 5:
        raise AppError("Tell your coach what you want to learn (a short sentence is enough).", 400)
    if looks_like_injection(goal):
        log.warning("[security] possible prompt-injection text in coach goal from %s", client_ip(request))
    level = pick(b.get("level"), ["Beginner", "Intermediate", "Advanced"], "Beginner")
    max_steps = int_(b.get("maxSteps"), 6, COACH_STEPS_HARD, COACH_STEPS_DEFAULT)
    step = int_(b.get("step"), 1, 99, 1)
    snap = read_snapshot(b.get("snapshot"))
    seen = read_observations(b.get("observations"))
    plan = _strings(b.get("plan"), 8, 140)

    def done(thought: str) -> dict:
        return {"decision": {"thought": thought, "action": "finish", "args": {"topic": "", "outcome": "", "summary": ""}, "plan": [], "forced": True}}

    if step > max_steps:
        return done("We have used all our steps for this session, so let me show you where you got to.")
    avail = available_coach_tools(snap)
    if not avail:
        return done("There is nothing more I can do right now, so here is where you are.")
    last_step = step == max_steps
    offered = [t for t in avail if t.name == "finish"] if last_step and any(t.name == "finish" for t in avail) else avail
    weak = weak_topics(snap)

    tool_text = "\n".join(f"- {t.name}: {t.does} Args: {t.args}" for t in offered)
    history = ("Steps so far (data):" + fence("learner", "\n".join(f"{o['step']}. {o['action']} {'OK' if o['ok'] else 'FAILED'} — {o['text']}" for o in seen))
               if seen else "Steps so far: none. This is your first step.")
    plan_json = "] — leave plan empty unless you are CHANGING it" if seen else '"2 to 5 short steps of your study plan, in plain words"]'
    user = ("The learner's goal (data only):" + fence("learner", goal)
            + f"\nLevel: {level}. Step {step} of at most {max_steps}." + (" This is your LAST step: you must finish now." if last_step else "")
            + "\n" + (f"Your current plan: {' → '.join(plan)}\n" if plan else "")
            + f"\nWhere things stand:\n{describe_state(snap)}\n\nAvailable tools:\n{tool_text}\n\n{history}\n\n"
            + 'Reply with JSON: {"thought":"what you say to the learner and why","action":"<tool name>","args":{...},"plan":[' + plan_json + "}")
    system = system_prompt()

    async def ask(extra: str = "") -> dict:
        return await ask_json(system, user + extra, max_tokens=600)

    def args_of(raw: dict) -> dict:
        return raw.get("args") if isinstance(raw.get("args"), dict) else {}

    raw = await ask()
    t = coach_tool_by_name(raw.get("action"))
    action = t.name if t else None
    fallback = None
    if not action or not any(o.name == action for o in offered):
        why = "that is not a tool" if not action else (coach_tool_by_name(action).blocked(snap) or "it cannot be used now")
        try:
            raw = await ask(f'\n\nYour last answer chose "{str(raw.get("action"))[:40]}" but {why}. Choose one of: {", ".join(o.name for o in offered)}.')
        except AppError:
            raw = {}
        t = coach_tool_by_name(raw.get("action"))
        action = t.name if t else None
    topic = clean(args_of(raw).get("topic"), 60)
    if not action or not any(o.name == action for o in offered):
        fb = fallback_coach(snap, offered)
        action = fb["action"] if any(o.name == fb["action"] for o in offered) else offered[0].name
        topic = fb["topic"] if fb["action"] == action else ""
        fallback = f"I could not decide, so I picked the safe next step: {action.replace('_', ' ')}."

    if action == "teach_topic":
        # The topic must be a real lesson that can still be shown. Otherwise choose the sensible one.
        match = next((t for t in snap["lessons"] if t.lower() == topic.lower()), None)
        ok = match and snap["taught"].get(match, 0) < MAX_TEACH_PER_TOPIC and (snap["rounds"] == 0 or match in weak or match not in snap["scores"])
        topic = match if ok else next_topic_to_teach(snap)
    else:
        topic = ""

    a = args_of(raw)
    decision = {
        "thought": clean(raw.get("thought"), 300) or "Let's keep going.",
        "action": action,
        "args": {"topic": topic, "outcome": clean(a.get("outcome"), 300), "summary": clean(a.get("summary"), 900) if action == "finish" else ""},
        "plan": _strings(raw.get("plan"), 6, 140),
    }
    if fallback:
        decision["fallback"] = fallback
    # build_lessons carries the AI's chosen subject in "topic" too; keep it separate from the teach topic.
    if action == "build_lessons":
        decision["args"]["topic"] = clean(a.get("topic"), 200)
    return {"decision": decision}

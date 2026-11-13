"""The autonomous digital colleague: the tool catalogue and the safety rules.
The AI only CHOOSES the next tool; the server checks the choice against these rules (which tools exist, which are allowed
right now, how often each may be used). The tools themselves still run in the browser through the normal endpoints.
(The same catalogue lives in the frontend: frontend/lib/colleague.ts. Keep them in step when you add a tool.)"""
from dataclasses import dataclass
from typing import Callable

CHECK_MAX = 4
MAX_STEPS_DEFAULT = 10
MAX_STEPS_HARD = 14


@dataclass
class Tool:
    name: str
    does: str
    args: str
    max_uses: int
    blocked: Callable[[dict], str | None]  # returns why the tool cannot be used right now, or None


def _uses(s: dict, n: str) -> int:
    return s["uses"].get(n, 0) or 0


TOOLS: list[Tool] = [
    Tool("search_notes", "Look through the teacher's notes for passages about something. Use it to find out what the notes really cover before you build anything.",
         '{"query":"2-8 words to look for"}', 4,
         lambda s: None if s["noteChars"] > 0 else "there are no notes"),
    Tool("web_search", "Search the web to check facts, find current information or find sources the notes do not have. What it finds is kept and listed under Sources in the report, and is used when you build lessons afterwards. Do it BEFORE build_lessons. Skip it when the notes already answer the goal.",
         '{"query":"3-10 words to search for"}', 3,
         lambda s: None if s["webSearch"] else "web search is not set up"),
    Tool("build_lessons", "Write a short course of 3-5 lessons from the notes (or from general knowledge if there are no notes). Calling it again REPLACES the lessons and throws away any questions and plan made from the old ones.",
         '{"topic":"subject, max 200 characters","outcome":"what learners should be able to do, max 300 characters"}', 2,
         lambda s: "the test is already shared, so the lessons cannot be rebuilt" if s["shareCode"] else None),
    Tool("write_questions", "Write a test (choice, written and ordering questions) that covers every lesson. Calling it again REPLACES the questions.",
         "{}", 3,
         lambda s: "the test is already shared, so the questions cannot be replaced" if s["shareCode"] else (None if len(s["lessons"]) >= 2 else "build the lessons first")),
    Tool("check_questions", "A strict second AI checks every question: is it supported by the lessons, clear, and has the right answer? It fixes or removes bad ones. A check PASSES when it fixes and removes nothing.",
         "{}", CHECK_MAX,
         lambda s: None if s["questions"] > 0 else "write the questions first"),
    Tool("plan_lesson", "Write a timed lesson plan (teacher and student actions, checks for understanding, coaching) for the lessons.",
         '{"minutes":"lesson length, 20-180"}', 2,
         lambda s: None if len(s["lessons"]) >= 2 else "build the lessons first"),
    Tool("share_test", "Publish the finished test so learners can open it with a code, link or QR code (the same as the Tests and classwork screen). Only when the goal asks for the test to be shared or given to learners. Once shared, the test can no longer be rewritten. It only works for a test that has just PASSED the checker with no changes.",
         "{}", 1,
         lambda s: ("the teacher has not allowed sharing in this run" if not s["canShare"]
                    else "the test is already shared" if s["shareCode"]
                    else "write the questions first" if s["questions"] == 0
                    else "the test has to pass the checker with no changes first" if (not s["checked"] or not s["lastCheck"] or s["lastCheck"]["fixed"] > 0 or s["lastCheck"]["removed"] > 0)
                    else None)),
    Tool("read_results", "Read how learners did on a test the teacher has already shared from this device: how many handed in, the class average, the weak topics and the hardest questions. You only see totals, never learner names or answers. A test that was only just shared has no answers yet.",
         '{"test":"title or code of the test (leave empty for the one shared in this run or the newest)"}', 2,
         lambda s: None if len(s["savedTests"]) > 0 else "no test has been shared from this device yet"),
    Tool("draft_email", "Write a DRAFT email for the teacher to review. It is never sent: the teacher copies it or opens it in their own email app. If a test was shared, its link and code are added automatically, so never write a link or code yourself.",
         '{"to":"learners, parents or colleagues","about":"what the email should say, max 200 characters"}', 2,
         lambda s: None if (len(s["lessons"]) > 0 or s["shareCode"] or s["results"]) else "there is nothing to write about yet"),
    Tool("finish", "Stop, because the goal is met (or cannot be met). Give the teacher a short report of what you made and anything they should double-check.",
         '{"summary":"2-4 plain sentences for the teacher"}', 99,
         # a test nobody checked is not handed over as "ready" (if the checker is used up, finishing is allowed)
         lambda s: "the test has not been through the checker yet" if (s["questions"] > 0 and not s["checked"] and _uses(s, "check_questions") < CHECK_MAX) else None),
]
TOOL_NAMES = [t.name for t in TOOLS]


def tool_by_name(n) -> Tool | None:
    return next((t for t in TOOLS if t.name == n), None) if isinstance(n, str) else None


def available_tools(s: dict, stuck_ok: bool = True) -> list[Tool]:
    """The tools the AI may use right now (a tool that is blocked or used up is not offered)."""
    out = []
    for t in TOOLS:
        if _uses(s, t.name) >= t.max_uses:
            continue
        # finishing with nothing made is only allowed after repeated failures
        if t.name == "finish" and len(s["lessons"]) == 0 and not (stuck_ok and s["failures"] >= 2):
            continue
        if not t.blocked(s):
            out.append(t)
    return out


def fallback_action(s: dict, avail: list[Tool]) -> str:
    """If the AI's choice cannot be used, this is the sensible next step. Used only as a safety net."""
    has = lambda n: any(t.name == n for t in avail)  # noqa: E731
    if len(s["lessons"]) == 0 and has("build_lessons"):
        return "build_lessons"
    if s["questions"] == 0 and has("write_questions"):
        return "write_questions"
    if s["questions"] > 0 and not s["checked"] and has("check_questions"):
        return "check_questions"
    if s["planMinutes"] is None and has("plan_lesson"):
        return "plan_lesson"
    return "finish"

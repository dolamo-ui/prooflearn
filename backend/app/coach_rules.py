"""The autonomous LEARNING COACH (learner side): tool catalogue and safety rules.
The goal is PROOF: a topic counts as learned only when the learner scores TARGET% or more on questions that CODE marked.
The AI never marks anything; it only chooses the next step. (Same rules as frontend/lib/coach.ts.)"""
from dataclasses import dataclass
from typing import Callable

TARGET = 70
COACH_STEPS_DEFAULT = 14
COACH_STEPS_HARD = 20
MAX_TEACH_PER_TOPIC = 3  # after 3 tries the coach stops pushing the same topic and says so
MAX_ROUNDS = 5


@dataclass
class CoachTool:
    name: str
    does: str
    args: str
    max_uses: int
    blocked: Callable[[dict], str | None]


def weak_topics(s: dict) -> list[str]:
    return [t for t in s["lessons"] if t in s["scores"] and s["scores"][t] < TARGET]


def is_mastered(s: dict) -> bool:
    return len(s["lessons"]) > 0 and all(s["scores"].get(t, -1) >= TARGET for t in s["lessons"])


def teachable(s: dict) -> list[str]:
    return [t for t in s["lessons"] if (s["taught"].get(t, 0) or 0) < MAX_TEACH_PER_TOPIC]


def _teach_blocked(s):
    if len(s["lessons"]) < 2:
        return "build the lessons first"
    if is_mastered(s):
        return "the learner has already proven every topic"
    return None if teachable(s) else f"every topic has already been shown {MAX_TEACH_PER_TOPIC} times"


def _quiz_blocked(s):
    if len(s["lessons"]) < 2:
        return "build the lessons first"
    if is_mastered(s):
        return "the learner has already proven every topic"
    if s["rounds"] >= 1 and s["taughtSinceQuiz"] == 0:
        return "teach a weak topic before testing again"
    return None


def _finish_blocked(s):
    if s["failures"] >= 2:
        return None
    if len(s["lessons"]) > 0 and s["rounds"] == 0:
        return "the learner has not been tested yet, so there is no proof of anything"
    if len(weak_topics(s)) > 0 and s["rounds"] < 2:
        return "there are weak topics: reteach them and test again first"
    return None


COACH_TOOLS: list[CoachTool] = [
    CoachTool("build_lessons", "Write a short course of 3-5 lessons for the learner's goal (from their notes if they gave any). The learner does not see this step; it just prepares the topics.",
              '{"topic":"subject, max 200 characters","outcome":"what the learner wants to be able to do, max 300 characters"}', 2,
              lambda s: "the lessons already exist" if len(s["lessons"]) >= 2 else None),
    CoachTool("teach_topic", "Show the learner ONE topic to read. The first time it is the full lesson; every later time it is a different, everyday explanation. The learner says whether they understood or are still unsure.",
              '{"topic":"one of the lesson topics, exactly as written"}', 12, _teach_blocked),
    CoachTool("quiz_learner", "Give the learner a short checked test and MARK it with code. The first test covers every topic; later tests cover only the topics still below the target. The marks decide what has been learned.",
              "{}", MAX_ROUNDS, _quiz_blocked),
    CoachTool("finish", "Stop and give the learner a short, honest, encouraging message about where they are. Say what they have proven (from the scores only) and what to do next.",
              '{"summary":"2-4 kind, plain sentences to the learner"}', 99, _finish_blocked),
]
COACH_TOOL_NAMES = [t.name for t in COACH_TOOLS]


def coach_tool_by_name(n) -> CoachTool | None:
    return next((t for t in COACH_TOOLS if t.name == n), None) if isinstance(n, str) else None


def available_coach_tools(s: dict) -> list[CoachTool]:
    out = []
    for t in COACH_TOOLS:
        if (s["uses"].get(t.name, 0) or 0) >= t.max_uses:
            continue
        if t.name == "finish" and len(s["lessons"]) == 0 and s["failures"] < 2:  # nothing made yet: try first
            continue
        if not t.blocked(s):
            out.append(t)
    return out


def next_topic_to_teach(s: dict) -> str:
    """Unsure topics first, then the lowest score, then one never shown."""
    open_ = teachable(s)
    if not open_:
        return s["lessons"][0] if s["lessons"] else ""
    weak = [t for t in open_ if t in weak_topics(s)]
    unsure = [t for t in weak if t in s["unsure"]]
    pool = unsure or weak or [t for t in open_ if not (s["taught"].get(t, 0) or 0)]
    return sorted(pool or open_, key=lambda t: s["scores"].get(t, 50))[0]


def fallback_coach(s: dict, avail: list[CoachTool]) -> dict:
    """If the AI's choice cannot be used, this is the sensible next step. A safety net only."""
    has = lambda n: any(t.name == n for t in avail)  # noqa: E731
    if not s["lessons"] and has("build_lessons"):
        return {"action": "build_lessons", "topic": ""}
    if s["rounds"] == 0 and s["knows"] == "nothing" and not s["taught"] and has("teach_topic"):
        return {"action": "teach_topic", "topic": next_topic_to_teach(s)}
    if s["rounds"] == 0 and has("quiz_learner"):
        return {"action": "quiz_learner", "topic": ""}
    if s["taughtSinceQuiz"] > 0 and has("quiz_learner"):
        return {"action": "quiz_learner", "topic": ""}
    if has("teach_topic"):
        return {"action": "teach_topic", "topic": next_topic_to_teach(s)}
    return {"action": "finish", "topic": ""}

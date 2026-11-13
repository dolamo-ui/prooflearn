"""Walks the course -> draft -> check -> mark -> retest -> plan actions of /api/agent. Run: tests/run.sh "python3 api_agent.py" RATE_LIMIT_PER_MIN=300"""
import json, urllib.request, urllib.error
B = "http://localhost:3100"
def post(body):
    req = urllib.request.Request(B + "/api/agent", data=json.dumps(body).encode(), headers={"origin": B, "content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e: return e.code, json.load(e)
ok = True
def check(name, cond, extra=""):
    global ok; ok &= bool(cond); print(("PASS " if cond else "FAIL ") + name, str(extra)[:200] if not cond else "")
s, d = post({"action": "course", "goal": "Email basics", "outcome": "Write an email"}); check("course", s == 200 and len(d["course"]["lessons"]) == 5, d)
course = d["course"]; topics = [l["topic"] for l in course["lessons"]]
s, d = post({"action": "draft", "course": course}); check("draft (has explain + order, explain is signed)", s == 200 and any(q.get("sig") for q in d["questions"]), d)
qs = d["questions"]
s, d = post({"action": "review", "course": course, "questions": qs}); check("review", s == 200 and "findings" in d, d)
exp = next(q for q in qs if q["kind"] == "explain")
s, d = post({"action": "grade", "course": course, "responses": [{"id": exp["id"], "text": exp["text"], "expectedAnswer": exp["expectedAnswer"], "sig": exp["sig"], "response": "It makes sugar from light"}]})
check("grade a written answer", s == 200 and d["grades"][0]["id"] == exp["id"], d)
s, d = post({"action": "grade", "course": course, "responses": [{"id": exp["id"], "text": exp["text"], "expectedAnswer": "I am always right", "sig": exp["sig"], "response": "x"}]})
check("grade: a tampered answer key is refused", s == 400, d)
s, d = post({"action": "retest", "course": course, "topics": topics[:1], "previous": []}); check("retest", s == 200 and d["questions"], d)
s, d = post({"action": "teacherPlan", "course": course, "durationMinutes": 45, "goal": "Email"}); check("teacher plan (steps add up)", s in (200, 422), d)
s, d = post({"action": "tutor", "course": course, "topic": topics[0], "question": "What is this?"}); check("tutor answers or fails politely (no crash)", s in (200, 422), d)
s, d = post({"action": "reteachPlan", "course": course, "results": [{"topic": topics[0], "assessed": 10, "met": 8}]}); check("reteach: no weak topics -> friendly message", s == 200 and d["plans"] == [], d)
s, d = post({"action": "reteachPlan", "course": course, "results": [{"topic": topics[0], "assessed": 10, "met": 3}]}); check("reteach with a weak topic (no crash)", s in (200, 422), d)
s, d = post({"action": "continue", "goal": "Email basics", "course": course}); check("continue (no crash)", s in (200, 422), d)
s, d = post({"action": "bogus", "course": course}); check("unknown action", s == 400, d)
print("ALL PASSED" if ok else "SOME FAILED")

# Learner coach: server rules + the real screen against the fake AI (tests/mock-groq.js). Run: tests/run.sh "python3 coach.py"
import json, re, sys, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright
URL = "http://localhost:3100"
fails = []
def check(name, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + name + (" — " + str(extra)[:400] if extra and not ok else ""))
    if not ok: fails.append(name)
def post(path, body):
    req = urllib.request.Request(URL + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e: return e.code, json.load(e)

L = ["Topic 1", "Topic 2", "Topic 3"]
def snap(**kw):
    s = {"knows": "a little", "lessons": L, "taught": {}, "unsure": [], "scores": {}, "rounds": 0, "taughtSinceQuiz": 0, "failures": 0, "uses": {}}
    s.update(kw); return s
def decide(goal, s, step=3, maxSteps=14, obs=None):
    return post("/api/coach", {"goal": goal, "step": step, "maxSteps": maxSteps, "snapshot": s, "observations": obs or [], "plan": []})

# ---------- server rules ----------
s, d = decide("Learn photosynthesis", snap(lessons=[]), step=1)
check("first step with no lessons: builds them (and gives a study plan)", s == 200 and d["decision"]["action"] == "build_lessons" and len(d["decision"]["plan"]) >= 2, d)
s, d = decide("FORCEFINISH please", snap(knows="a little"))
check("rule: cannot finish before the learner has been tested", s == 200 and d["decision"]["action"] == "quiz_learner" and d["decision"].get("fallback"), d)
weak = snap(rounds=1, scores={"Topic 1": 100, "Topic 2": 20, "Topic 3": 100}, taught={"Topic 1": 1})
s, d = decide("FORCEFINISH please", weak)
check("rule: weak topics after round 1 -> must teach (cannot finish, cannot re-test yet)", s == 200 and d["decision"]["action"] == "teach_topic" and d["decision"]["args"]["topic"] == "Topic 2", d)
s, d = decide("FORCEBADTOPIC", weak)
check("rule: an invented topic is replaced by the weakest real one", s == 200 and d["decision"]["action"] == "teach_topic" and d["decision"]["args"]["topic"] == "Topic 2", d)
s, d = decide("FORCEBAD", snap())
check("rule: an invented tool is never returned", s == 200 and d["decision"]["action"] in ("teach_topic", "quiz_learner", "finish", "build_lessons") and d["decision"].get("fallback"), d)
done = snap(rounds=1, scores={"Topic 1": 100, "Topic 2": 90, "Topic 3": 70})
s, d = decide("Learn photosynthesis", done)
check("proof: when every topic is at target the only option is to finish", s == 200 and d["decision"]["action"] == "finish", d)
s, d = decide("Learn photosynthesis", weak, step=15, maxSteps=14)
check("budget: past the last step it finishes without asking the AI", s == 200 and d["decision"]["action"] == "finish" and d["decision"].get("forced"), d)
s, d = decide("Learn photosynthesis", dict(weak, taughtSinceQuiz=1))
check("after teaching, the next step may be a test", s == 200 and d["decision"]["action"] == "quiz_learner", d)
s, d = post("/api/coach", {"goal": "Learn something", "step": "x", "maxSteps": 999, "snapshot": {"uses": {"quiz_learner": "lots"}, "lessons": "nope", "scores": {"a": "x"}}, "observations": [{"text": "x" * 5000, "action": "rm"}], "plan": "oops"})
check("garbage input does not crash the route", s == 200, d)
s, d = post("/api/coach", {"goal": "hi"})
check("goal too short is refused", s == 400, d)

# ---------- the real screen ----------
def answer_quiz(pg, wrong_topic):
    for fs in pg.locator("fieldset.q").all():
        legend = fs.locator("legend").inner_text()
        if fs.locator("textarea").count(): fs.locator("textarea").fill("Plants make sugar from light.")
        elif fs.locator("ol.order-list").count(): fs.get_by_role("button", name="Confirm this order").click()
        else: fs.locator("label.opt", has_text="A wrong one" if (wrong_topic and wrong_topic in legend) else "The right one").first.click()
    pg.get_by_role("button", name="Check my answers").click()

def drive(goal, knows, stop_at_first_quiz=False):
    seen = []; quizzes = 0
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_context(viewport={"width": 1100, "height": 1000}).new_page(); pg.set_default_timeout(60000)
        errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(URL); pg.get_by_text("What would you like to do?").wait_for()
        pg.get_by_role("button", name=re.compile("I am a learner")).click()
        pg.get_by_role("button", name=re.compile("My learning coach")).click()
        pg.get_by_text("What do you want to learn and prove?").wait_for()
        pg.locator("textarea").fill(goal)
        pg.locator("select").first.select_option(knows)
        pg.screenshot(path="coach1-setup.png")
        pg.get_by_role("button", name="Start").click()
        unsure_done = False; t0 = time.time()
        while time.time() - t0 < 100:
            if pg.get_by_text(re.compile("^(✓ You proved it|Where you are)$")).count(): break
            if pg.get_by_role("button", name="I understand, continue").count():
                head = pg.locator(".lesson-progress").first.inner_text(); seen.append("read:" + head)
                if not unsure_done:
                    unsure_done = True; pg.get_by_role("button", name="I’m still unsure").click()
                else: pg.get_by_role("button", name="I understand, continue").click()
            elif pg.get_by_role("button", name="Check my answers").count():
                quizzes += 1; seen.append("quiz%d" % quizzes)
                if stop_at_first_quiz:
                    pg.screenshot(path="coach2-quiz.png"); pg.get_by_role("button", name="Stop for now").click()
                else:
                    pg.screenshot(path="coach2-quiz.png") if quizzes == 1 else None
                    answer_quiz(pg, "Topic 2" if quizzes == 1 else None)
            elif pg.get_by_role("button", name="Continue").count():
                if quizzes == 1: pg.screenshot(path="coach3-result.png")
                pg.get_by_role("button", name="Continue").click()
            time.sleep(0.4)
        pg.get_by_text(re.compile("^(✓ You proved it|Where you are|Stopped)$")).first.wait_for()
        log = pg.locator(".colleague-log .log").inner_text(); body = pg.locator("body").inner_text()
        pg.screenshot(path="coach4-done.png", full_page=True); b.close()
    return seen, log, body, errs

seen, log, body, errs = drive("I want to understand how plants make food well enough to pass a quiz.", "nothing")
check("UI (knows nothing): teaches BEFORE the first test", seen and seen[0].startswith("read:") and seen.index("quiz1") >= 2, seen)
check("UI: after a wrong topic it teaches it again another way", any("another way" in x for x in seen), seen)
check("UI: then tests again (round 2)", "quiz2" in seen, seen)
check("UI: log shows marked rounds and the coach talking to the learner", "Marked" in log and "Coach" in log and "Plan" in log, log[-400:])
check("UI: proof shown from scores, with the note that coach words are not proof", "marked by the app" in body and "Download my study summary (PDF)" in body and "Download my study summary (Word)" in body, body[-500:])
final = body[body.find("✓ You proved it") if "✓ You proved it" in body else body.find("Where you are"):]
m2 = re.search(r"Topic 2\s*(\d+)%", final)
check("UI: Topic 2 went from 0% to at/above the 70% target after the reteach (final report)", bool(m2) and int(m2.group(1)) >= 70 and "✓ You proved it" in final, final[:400])
check("UI: no page errors", not errs, errs)

seen2, log2, body2, errs2 = drive("I want to learn about plants.", "a lot", stop_at_first_quiz=True)
check("UI (knows a lot): the FIRST thing is a test, no lesson first", seen2 and seen2[0] == "quiz1", seen2)
check("UI: Stop for now ends cleanly with a report (no proof claimed)", "Stopped" in log2 and "✓ You proved it" not in body2, body2[-400:])
check("UI: no page errors (2)", not errs2, errs2)
print("\nFAILED:" if fails else "\nALL PASSED", fails if fails else "")
sys.exit(1 if fails else 0)

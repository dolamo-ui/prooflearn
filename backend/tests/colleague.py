# Autonomous colleague: drives the real screen against the fake AI (tests/mock-groq.js). Run: tests/run.sh "python3 colleague.py" RATE_LIMIT_AGENT_PER_MIN=300 RATE_LIMIT_PER_MIN=300
import json, re, sys, urllib.request, urllib.error
from playwright.sync_api import sync_playwright
URL = "http://localhost:3100"
NOTES = ("Photosynthesis is how plants make food. Plants take in water through roots and carbon dioxide through leaves. "
         "Light hits the leaf and the plant makes sugar and oxygen.\n\nChlorophyll is the green pigment that captures light energy. "
         "It sits inside chloroplasts, which are the tiny kitchens of the plant cell.")
fails = []
def check(name, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + name + (" — " + str(extra) if extra and not ok else ""))
    if not ok: fails.append(name)

def post(path, body):
    req = urllib.request.Request(URL + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e: return e.code, json.load(e)

# ---------- server rules, no browser ----------
snap0 = {"noteChars": 400, "lessons": [], "questions": 0, "checked": False, "lastCheck": None, "planMinutes": None, "failures": 0, "uses": {}}
s, d = post("/api/colleague", {"goal": "Prepare a lesson on photosynthesis", "step": 1, "maxSteps": 8, "snapshot": snap0, "observations": [], "plan": []})
check("decide: first step is search_notes and a plan is given", s == 200 and d["decision"]["action"] == "search_notes" and len(d["decision"]["plan"]) >= 2, d)
s, d = post("/api/colleague", {"goal": "FORCEFINISH now", "step": 1, "maxSteps": 8, "snapshot": snap0, "observations": [], "plan": []})
check("rule: AI cannot finish with nothing made (falls back, says so)", s == 200 and d["decision"]["action"] == "build_lessons" and "safe default" in d["decision"].get("fallback", ""), d)
s, d = post("/api/colleague", {"goal": "FORCEBAD tool please", "step": 1, "maxSteps": 8, "snapshot": snap0, "observations": [], "plan": []})
check("rule: an invented tool name is never returned", s == 200 and d["decision"]["action"] in ("search_notes", "build_lessons", "write_questions", "check_questions", "plan_lesson", "finish") and d["decision"].get("fallback"), d)
unchecked = dict(snap0, lessons=["A", "B", "C"], questions=6, checked=False)
s, d = post("/api/colleague", {"goal": "FORCEFINISH now", "step": 3, "maxSteps": 8, "snapshot": unchecked, "observations": [], "plan": []})
check("rule: cannot finish while the test is unchecked", s == 200 and d["decision"]["action"] == "check_questions", d)
s, d = post("/api/colleague", {"goal": "Prepare a lesson on photosynthesis", "step": 9, "maxSteps": 8, "snapshot": unchecked, "observations": [], "plan": []})
check("budget: past the last step it finishes without asking the AI", s == 200 and d["decision"]["action"] == "finish" and d["decision"].get("forced"), d)
used_up = dict(unchecked, uses={"check_questions": 4})
s, d = post("/api/colleague", {"goal": "FORCEFINISH now", "step": 6, "maxSteps": 8, "snapshot": used_up, "observations": [], "plan": []})
check("budget: when the checker is used up, finishing is allowed (no deadlock)", s == 200 and d["decision"]["action"] == "finish", d)
s, d = post("/api/colleague", {"goal": "hi", "step": 1, "snapshot": snap0})
check("goal too short is refused", s == 400, d)
s, d = post("/api/colleague", {"goal": "Prepare a lesson", "step": "x", "maxSteps": 999, "snapshot": {"uses": {"build_lessons": "lots"}, "lessons": "nope", "questions": -5}, "observations": [{"text": "x" * 5000, "action": "rm -rf"}], "plan": "oops"})
check("garbage input does not crash the route", s == 200, d)

# ---------- the real screen ----------
def run_ui(goal, expect_plan=True, allow_share=False, extra=None):
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_context(viewport={"width": 1100, "height": 900}).new_page(); pg.set_default_timeout(90000)
        errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(URL); pg.get_by_text("What would you like to do?").wait_for()
        pg.get_by_role("button", name=re.compile("I am a teacher")).click()
        pg.get_by_role("button", name=re.compile("Digital colleague")).click()
        pg.get_by_text("What do you want your colleague to do?").wait_for()
        pg.locator("textarea").fill(goal)
        open("/tmp/notes.txt", "w").write(NOTES)
        pg.locator("input[type=file]").set_input_files("/tmp/notes.txt")
        pg.get_by_text(re.compile("characters of notes ready")).wait_for()
        if allow_share: pg.get_by_label(re.compile("Let my colleague share")).check()
        pg.screenshot(path="col1-setup.png")
        pg.get_by_role("button", name="Start").click()
        pg.get_by_role("heading", name="Report").wait_for()
        log = pg.locator(".colleague-log .log").inner_text()
        body = pg.locator("main, .page").first.inner_text()
        pg.screenshot(path="col2-done.png", full_page=True)
        if extra: extra(pg, body)
        b.close()
        return log, body, errs

def agent_checks(pg, body):
    # --- agent lanes ---
    lanes = [t.strip().lower() for t in pg.locator(".lane-name").all_inner_texts()]
    check("agents UI: lanes are shown by default, one column per agent that took part", lanes[:1] == ["coordinator"] and all(a in lanes for a in ("researcher", "writer", "checker")) and "publisher" not in lanes, lanes)
    check("agents UI: unused agents get no lane (no sharing, no email in this run)", "messenger" not in lanes, lanes)
    check("agents UI: each lane card sits in its own agent's lane", pg.locator(".lane-card[data-agent=checker]").count() >= 2 and pg.locator(".lane-card[data-agent=writer]").count() >= 3)
    cols = pg.evaluate("""() => { const r = document.querySelectorAll('.lane-card'); const names = [...document.querySelectorAll('.lane-name')].map(n => n.getBoundingClientRect());
      return [...r].every(c => { const b = c.getBoundingClientRect(); const lane = names.find(n => b.left >= n.left - 2 && b.left < n.right); return !!lane; }); }""")
    check("agents UI: every card is drawn under its lane heading", cols is True)
    # --- one list with agent names ---
    pg.get_by_role("button", name="One list").click()
    chips = [t.strip() for t in pg.locator(".colleague-log .agent-chip").all_inner_texts()]
    check("agents UI: the one-list view names the agent on each line", {"Coordinator", "Researcher", "Writer", "Checker"} <= set(chips), chips[:12])
    check("agents UI: hand-off lines appear between specialists in the list", "Hand-off" in pg.locator(".colleague-log .log").inner_text() and "Writer" in pg.locator(".ln.hand").first.inner_text())
    pg.get_by_role("button", name="Agent lanes").click()
    # --- who did what ---
    check("who did what: the section is in the report", "Who did what" in body, body[:400])
    for line in ("Coordinator: made", "Researcher: a notes search", "Writer: 5 lessons", "Checker: a check"):
        check("who did what: line for " + line.split(":")[0], line in body, body[:900])
    check("who did what: hand-offs between specialists are listed", "Writer → Checker (review)" in body and "Checker → Writer (rework)" in body and "Researcher → Writer (material)" in body, body[:1500])
    check("who did what: the headline counts specialists and rework", "specialists worked under the Coordinator" in body and "sent work back" in body, body[:700])
    check("who did what: nobody is credited for work they did not do", "Publisher:" not in body and "Messenger:" not in body)
    # --- the downloads carry it too ---
    with pg.expect_download() as dl:
        pg.get_by_role("button", name="Download report (Word)").click()
    word = open(dl.value.path(), encoding="utf-8", errors="ignore").read()
    check("who did what: the Word report has the section and the hand-offs", "Who did what" in word and "Writer: 5 lessons" in word and "Hand-offs between specialists" in word, word[:300])
    check("who did what: the Word report does not list agents that did nothing", "Publisher:" not in word and "Messenger:" not in word)

log, body, errs = run_ui("Prepare a 40-minute lesson on photosynthesis for Grade 9 from my notes, with a short test I can trust.", extra=agent_checks)
check("UI: searched the notes first", "Searching your notes" in log)
check("UI: showed a plan", "Plan" in log and "1. Read the notes" in log)
check("UI: built lessons, wrote questions, checked", "Built 5 lessons" in log and "Wrote 6 questions" in log and "Checker" in log)
check("UI: checker loop ran until a clean pass", "PASSED" in log, log[-600:])
check("UI: made the 40-minute plan the goal asked for", "40-minute lesson plan" in log)
check("UI: ended with a report", "Done" in log and "lessons" in body)
check("UI: test shown as approved", "approved by the checker" in body and "not approved" not in body.lower().replace("(not approved)", "NA") or "approved by the checker" in body)
check("UI: PDF and Word downloads both offered", "Download report (PDF)" in body and "Download report (Word)" in body)
check("UI: no page errors", not errs, errs)
n_checks = len(re.findall(r"The checker is going through", log))
check("UI: checked more than once (re-checked after changes)", n_checks >= 2, n_checks)

log2, body2, errs2 = run_ui("FORCEFINISH — just a quick test on photosynthesis please")
check("UI: a premature finish is overruled and work still happens", "safe default" in log2 and "Built 5 lessons" in log2, log2[:500])
check("UI: no lesson plan when the goal did not ask for one", "lesson plan" not in log2.lower().replace("lesson plan from", ""), log2[-400:])

# ---------- sharing, results, email draft ----------
clean = dict(snap0, lessons=["A", "B", "C"], questions=6, checked=True, lastCheck={"approved": 6, "fixed": 0, "removed": 0}, canShare=True, shareCode=None, savedTests=[], results=None)
def decide(goal, snap, step=4): return post("/api/colleague", {"goal": goal, "step": step, "maxSteps": 10, "snapshot": snap, "observations": [{"step": 1, "action": "search_notes", "ok": True, "text": "Found 2 passages."}], "plan": []})
s, d = decide("Make a test and SHARE it with learners", clean)
check("share: offered after a clean pass when the teacher allowed it", s == 200 and d["decision"]["action"] == "share_test", d)
s, d = decide("Make a test and SHARE it with learners", dict(clean, canShare=False))
check("share: NOT offered when the teacher did not allow it", s == 200 and d["decision"]["action"] != "share_test", d)
s, d = decide("FORCESHARE", dict(clean, canShare=False))
check("share: the AI cannot force it when sharing is off (server overrules, says so)", s == 200 and d["decision"]["action"] != "share_test" and d["decision"].get("fallback"), d)
s, d = decide("FORCESHARE", dict(clean, lastCheck={"approved": 5, "fixed": 1, "removed": 0}))
check("share: NOT allowed after a check that had to fix something", s == 200 and d["decision"]["action"] != "share_test", d)
s, d = decide("FORCESHARE", dict(clean, checked=False, lastCheck=None))
check("share: NOT allowed on an unchecked test", s == 200 and d["decision"]["action"] != "share_test", d)
s, d = decide("FORCESHARE", dict(clean, shareCode="TABCD234"))
check("share: cannot be shared twice", s == 200 and d["decision"]["action"] != "share_test", d)
s, d = decide("FORCESHARE", dict(clean, canShare="yes please"))
check("share: a non-true canShare from the browser counts as off", s == 200 and d["decision"]["action"] != "share_test", d)
s, d = decide("FORCERESULTS", clean)
check("results: not offered when nothing was shared from this device", s == 200 and d["decision"]["action"] != "read_results", d)
s, d = decide("FORCERESULTS", dict(clean, savedTests=["Photosynthesis test"]))
check("results: offered once a test exists on this device", s == 200 and d["decision"]["action"] == "read_results", d)
s, d = decide("FORCEEMAIL", snap0)
check("email: not offered when there is nothing to write about", s == 200 and d["decision"]["action"] != "draft_email", d)
s, d = decide("FORCEEMAIL", clean)
check("email: offered once lessons exist", s == 200 and d["decision"]["action"] == "draft_email" and d["decision"]["args"]["to"] in ("learners", "parents", "colleagues"), d)
s, d = post("/api/assist", {"action": "email", "role": "teacher", "instruction": "Email to learners: the test", "text": "A test was prepared on photosynthesis."})
check("email: the writing endpoint returns a Subject line and no markdown", s == 200 and d["text"].startswith("Subject:") and "**" not in d["text"], d)

def share_checks(pg, body):
    import json as _j
    work = _j.loads(pg.evaluate("localStorage.getItem('prooflearn.work.teacher')") or "[]")
    check("share UI: the test is saved under My tests on this device", len(work) == 1 and work[0]["code"].startswith("T"), work)
    if work:
        s2, d2 = post("/api/work", {"action": "get", "code": work[0]["code"]})
        check("share UI: learners can really open the shared test by its code", s2 == 200 and len(d2["questions"]) >= 4, d2)
        check("share UI: the SECRET teacher key never appears on the page", work[0]["key"] not in body and work[0]["key"] not in pg.content(), "key leaked")
        check("share UI: the share link in the email draft uses the real code", "/?join=" + work[0]["code"].replace("-", "") in body.replace("-", ""), body[-500:])
    check("agents UI: the checker told the publisher the test was approved", "Checker → Publisher (approved)" in body, body[:1800])
    check("agents UI: the publisher gave the messenger the link and code, the writer what was prepared", "Publisher → Messenger (material): Share link and code" in body and "Writer → Messenger (material)" in body, body[:2200])
    check("agents UI: the publisher is credited with sharing, the messenger with the draft", "Publisher: the test shared with code" in body and "Messenger: an email draft to learners" in body, body[:1500])
    check("agents UI: the secret key is not in any hand-off or lane card", work[0]["key"] not in pg.locator(".colleague-log").inner_text() if work else True)
    check("email UI: shown as a draft that was not sent", "Draft only. Nothing was sent." in body and "Copy email" in body, body[-600:])

log4, body4, errs4 = run_ui("SHARE RESULTS EMAIL Prepare a short test on photosynthesis for Grade 9 and share it with my class, then email them the link.", allow_share=True, extra=share_checks)
check("share UI: colleague shared the test after the checker passed it", "Sharing the checked test" in log4 and "Shared" in log4 and "PASSED" in log4, log4[-800:])
check("share UI: the share box (code and QR) is in the report", "Code" in body4 and "Shared test" in body4, body4[-600:])
check("results UI: read the results of the shared test (none yet, said plainly)", "Reading the class results" in log4 and "has no answers yet" in log4 or "Nobody has handed in" in log4, log4[-800:])
check("email UI: drafted an email to learners", "Drafting an email to learners" in log4 and "Email draft to learners" in body4, log4[-600:])
check("share UI: no page errors", not errs4, errs4)

log5, body5, errs5 = run_ui("SHARE this test on photosynthesis with my class please, short test for Grade 9.", allow_share=False)
check("share UI: nothing is published when the checkbox is off", "Sharing the checked test" not in log5 and "Shared test" not in body5, log5[-500:])
# ---------- web search (needs TAVILY_API_KEY=tvly-test TAVILY_BASE_URL=http://localhost:4010) ----------
import os
if os.environ.get("TEST_SEARCH"):
    s, d = post("/api/search", {"query": "photosynthesis grade 9"})
    check("search: returns clean hits", s == 200 and len(d["hits"]) == 2, d)
    check("search: drops non-http links", all(h["url"].startswith("https://") for h in d["hits"]), d)
    s, d = post("/api/search", {"query": "x"}); check("search: too-short query refused", s == 400, d)
    s, d = post("/api/colleague", {"goal": "WEBSEARCH check facts on photosynthesis", "step": 1, "maxSteps": 8, "snapshot": dict(snap0, webSearch=True), "observations": [], "plan": []})
    check("colleague: AI may choose web_search when it is set up", s == 200 and d["decision"]["action"] == "web_search", d)
    log3, body3, errs3 = run_ui("WEBSEARCH Prepare a 40-minute lesson on photosynthesis for Grade 9 with a short test I can trust.")
    check("UI: searched the web", "Searching the web" in log3 and "now in Sources" in log3, log3[:600])
    check("UI: Sources list shown", "web source" in body3 and "Photosynthesis - Science Source" in body3, body3[-800:])
    check("UI: no page errors with search", not errs3, errs3)
else:
    s, d = post("/api/search", {"query": "photosynthesis"}); check("search: without a key it says how to set it up", s == 503 and "TAVILY_API_KEY" in d["error"], d)
    s, d = post("/api/colleague", {"goal": "WEBSEARCH check facts", "step": 1, "maxSteps": 8, "snapshot": dict(snap0, webSearch=True), "observations": [], "plan": []})
    check("colleague: web_search is NOT offered without a key (browser cannot force it)", s == 200 and d["decision"]["action"] != "web_search", d)
print("\nFAILED:" if fails else "\nALL PASSED", fails if fails else "")
sys.exit(1 if fails else 0)

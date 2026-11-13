"""API checks for the colleague, coach, web search and file reading (no browser needed). Run: tests/run.sh "python3 api_extra.py" TAVILY_API_KEY=tvly-test TAVILY_BASE_URL=http://localhost:4010 RATE_LIMIT_AGENT_PER_MIN=300"""
import io, json, urllib.request, urllib.error
B = "http://localhost:3100"
def post(path, body, raw=None, headers=None):
    h = {"origin": B, **(headers or {})}
    if raw is None: h["content-type"] = "application/json"
    req = urllib.request.Request(B + path, data=raw if raw is not None else json.dumps(body).encode(), headers=h, method="POST")
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e: return e.code, json.load(e)
ok = True
def check(name, cond, extra=""):
    global ok; ok &= bool(cond); print(("PASS " if cond else "FAIL ") + name, extra if not cond else "")

snap = {"noteChars": 500, "lessons": [], "questions": 0, "uses": {}}
s, d = post("/api/colleague", {"goal": "Make a test on photosynthesis from my notes", "snapshot": snap})
check("colleague: first step searches the notes", s == 200 and d["decision"]["action"] == "search_notes", d)
s, d = post("/api/colleague", {"goal": "FORCEBAD something", "snapshot": snap})
check("colleague: a made-up tool is replaced by a safe default", s == 200 and d["decision"]["action"] == "build_lessons" and "fallback" in d["decision"], d)
s, d = post("/api/colleague", {"goal": "FORCESHARE please", "snapshot": snap})
check("colleague: share_test is refused when sharing is not allowed", s == 200 and d["decision"]["action"] != "share_test", d)
s, d = post("/api/colleague", {"goal": "Make a test on photosynthesis", "step": 99, "maxSteps": 6, "snapshot": snap})
check("colleague: out of steps -> forced finish, no AI call", d["decision"]["forced"] is True and d["decision"]["action"] == "finish", d)
s, d = post("/api/colleague", {"goal": "hi"})
check("colleague: too-short goal refused", s == 400, d)

csnap = {"knows": "a little", "lessons": ["Topic 1", "Topic 2", "Topic 3"], "taught": {}, "scores": {}, "uses": {}}
s, d = post("/api/coach", {"goal": "Learn photosynthesis", "snapshot": csnap})
check("coach: tests first when the learner knows a little", s == 200 and d["decision"]["action"] == "quiz_learner", d)
s, d = post("/api/coach", {"goal": "FORCEBADTOPIC learn", "snapshot": {**csnap, "knows": "nothing"}})
check("coach: a topic that does not exist is replaced by a real one", s == 200 and d["decision"]["args"]["topic"] in csnap["lessons"] or d["decision"]["action"] != "teach_topic", d)
s, d = post("/api/coach", {"goal": "FORCEFINISH now", "snapshot": csnap})
check("coach: cannot finish before the learner is tested", s == 200 and d["decision"]["action"] != "finish", d)

s, d = post("/api/search", {"query": "photosynthesis grade 9"})
check("search: results kept, javascript: link dropped", s == 200 and len(d["hits"]) == 2 and all(h["url"].startswith("https") for h in d["hits"]), d)

# files
import docx
doc = docx.Document(); doc.add_paragraph("Photosynthesis is how plants make food from light."); doc.add_paragraph("Chlorophyll captures the light energy.")
buf = io.BytesIO(); doc.save(buf)
def upload(name, data):
    bd = "XBOUNDARYX"
    body = (f'--{bd}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n').encode() + data + f"\r\n--{bd}--\r\n".encode()
    return post("/api/extract", None, raw=body, headers={"content-type": f"multipart/form-data; boundary={bd}"})
s, d = upload("notes.docx", buf.getvalue())
check("extract: reads a Word file", s == 200 and "Chlorophyll" in d["text"], d)
s, d = upload("fake.pdf", b"not a pdf at all, just text")
check("extract: a fake PDF is refused", s == 415, d)
from pypdf import PdfWriter
w = PdfWriter(); w.add_blank_page(200, 200); b = io.BytesIO(); w.write(b)
s, d = upload("scan.pdf", b.getvalue())
check("extract: a PDF with no text says it is a scan (code no_text)", s == 422 and d.get("code") == "no_text", d)
w = PdfWriter(); w.add_blank_page(200, 200); w.encrypt("secret"); b = io.BytesIO(); w.write(b)
s, d = upload("locked.pdf", b.getvalue())
check("extract: a password-protected PDF says so (code password)", s == 422 and d.get("code") == "password", d)
print("ALL PASSED" if ok else "SOME FAILED")

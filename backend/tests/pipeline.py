import json, time, urllib.request, sys
URL="http://localhost:3100/api/agent"
src=" ".join(f"Email fact {i}: an email address has a name, an at sign and a domain, and the inbox holds received messages {i}." for i in range(110))[:12000]
def post(action, payload, label):
    waited=0
    for attempt in range(5):
        req=urllib.request.Request(URL, data=json.dumps({"action":action,**payload}).encode(), headers={"content-type":"application/json","origin":"http://localhost:3100"})
        t=time.time()
        try:
            r=urllib.request.urlopen(req, timeout=120); d=json.load(r); print(f"  {label:<18} OK    {time.time()-t:5.1f}s" + (f"  (page waited {waited}s first)" if waited else "")); return d
        except urllib.error.HTTPError as e:
            d=json.load(e); ra=d.get("retryAfter")
            print(f"  {label:<18} {e.code}  {time.time()-t:5.1f}s  -> {d.get('error','')[:95]}" + (f"  [retryAfter={ra}]" if ra else ""))
            if e.code==429 and ra and ra<=90 and attempt<4:
                print(f"      page shows countdown and waits {ra+1}s, then retries by itself"); time.sleep(ra+1); waited+=ra+1; continue
            return None
t0=time.time()
base={"goal":"email","outcome":"use email at work","level":"Beginner","source":src}
c=post("course",base,"1 build course")
if c:
    course=c["course"]
    d=post("draft",{**base,"course":course},"2 draft test")
    if d:
        v=post("review",{**base,"course":course,"questions":d["questions"]},"3 check test")
        if v:
            p=post("teacherPlan",{**base,"course":course,"durationMinutes":50},"4 lesson plan")
            print("\nRESULT:", "ALL 4 STEPS WORKED, plan has %d steps"%len(p["plan"]["steps"]) if p else "FAILED at step 4")
        else: print("\nRESULT: FAILED at step 3")
    else: print("\nRESULT: FAILED at step 2")
else: print("\nRESULT: FAILED at step 1")
print(f"total time {time.time()-t0:.0f}s")

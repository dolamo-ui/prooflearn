# Teacher builds a test in the block editor, gets link + QR, a learner opens the link. Run: tests/run.sh "python3 share.py"
import re, sys
from playwright.sync_api import sync_playwright
B = "http://localhost:3100"
with sync_playwright() as p:
    br = p.chromium.launch(); pg = br.new_page(viewport={"width": 1100, "height": 900})
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(B); pg.get_by_text("I am a teacher").click(); pg.get_by_text("Tests and classwork").click(); pg.get_by_role("button", name="Create a new one").click()
    pg.fill(".nb-title", "Plants quiz")
    pg.fill(".nb-ai input", "Photosynthesis, Grade 8")
    pg.get_by_role("button", name="Write questions with AI").click()
    pg.wait_for_selector(".nb-block", timeout=60000)
    n = pg.locator(".nb-block").count(); print("blocks:", n); assert n >= 1
    pg.get_by_role("button", name="Written answer").last.click(); assert pg.locator(".nb-block").count() == n + 1   # add block
    pg.locator(".nb-block").nth(n).locator(".nb-q").fill("Why are leaves green?"); pg.locator(".nb-block").nth(n).locator(".nb-callout textarea").fill("Chlorophyll absorbs red and blue light.")
    pg.locator(".nb-more").first.click(); pg.get_by_role("menuitem", name="Duplicate").click(); assert pg.locator(".nb-block").count() == n + 2
    pg.get_by_role("button", name="Save and get link").click()
    pg.wait_for_selector(".sharebox img", timeout=15000)
    code = pg.locator(".sharebox .bigcode").inner_text(); link = pg.locator(".sharelink").inner_text(); print("code", code, "link", link)
    assert re.search(r"\?join=T[A-Z0-9]{7}$", link) and pg.locator(".sharebox img").get_attribute("src").startswith("data:image/png")
    pg2 = br.new_page(); pg2.goto(link.replace("localhost:3100", "localhost:3100"))
    pg2.wait_for_selector("text=Your nickname", timeout=15000); print("learner opened:", pg2.locator("h2").first.inner_text()); assert "join=" not in pg2.url
    print("page errors:", errs); br.close()
print("OK")

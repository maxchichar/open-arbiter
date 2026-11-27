"""Drive the Oja page in headless Chrome against a local arbiter and the scripted LLM.

Needs: arbiter on :8787 (seeded; the site's DEFAULT_ARBITER_URL is http://localhost:8787),
site on :8080, tests/fake-llm.mjs on :8799.
    python3 tests/browser_check.py <screenshot dir>

The local file server does not send _headers, so this script applies the page CSP from _headers
to each HTML page itself, adding only the scripted LLM's origin to connect-src (it stands in for
the visitor's AI provider). Any CSP violation fails the check. CSP_DROP_STYLE_HASH=1 removes the
runtime style hash from the policy: a negative control that must fail. TT_PROBE=1 writes a plain
string to innerHTML after the market loads: a Trusted Types negative control that must fail with a
require-trusted-types-for violation. Step 9 runs Connect with
Otari against a mocked otari.ai (Playwright routes; every other external host is refused).
"""
import base64
import hashlib
import html
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright, expect

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp"
ORIGIN = "http://127.0.0.1:8080"
SITE = f"{ORIGIN}/"
TEST_ONLY_CONNECT = ["http://127.0.0.1:8799"]  # the scripted LLM, standing in for the AI provider


def page_policies():
    """Path -> CSP from the site's _headers file."""
    rules, current = {}, None
    for line in (Path(__file__).parent.parent / "_headers").read_text().splitlines():
        if not line.strip() or line.strip().startswith("#"):
            continue
        if not line[0].isspace():
            current = rules.setdefault(line.strip(), {})
            continue
        name, _, value = line.strip().partition(":")
        current[name.strip().lower()] = value.strip()
    return {path: h["content-security-policy"] for path, h in rules.items() if "content-security-policy" in h}


POLICIES = page_policies()


def policy_for(path):
    csp = POLICIES.get(path)
    if csp is None:
        return None
    csp = re.sub(r"connect-src ([^;]*)", lambda m: "connect-src " + m.group(1) + " " + " ".join(TEST_ONLY_CONNECT), csp)
    if os.environ.get("CSP_DROP_STYLE_HASH") == "1":
        csp = re.sub(r" 'sha256-[^']+'", "", csp)
    return csp


CSP_SERVED = []  # every URL this script served with the page CSP


def with_csp(route):
    path = route.request.url[len(ORIGIN):].split("?")[0]
    csp = policy_for(path)
    if csp is None:
        return route.continue_()
    CSP_SERVED.append(route.request.url)
    response = route.fetch()
    route.fulfill(response=response, headers={**response.headers, "content-security-policy": csp})


assert POLICIES.get("/"), "no page CSP in _headers"
print("page CSP (from _headers, + test-only connect-src", TEST_ONLY_CONNECT, "):", policy_for("/"))
PROFILE = {
    "version": 1, "selectedId": "t", "updatedAt": "",
    "profiles": [{"id": "t", "name": "Test LLM", "key": "test-key", "model": "fake-1", "router": "http://127.0.0.1:8799", "runner": False, "updatedAt": ""}],
}

errors = []
csp_console = []
CSP_LISTENER = """
window.__csp = [];
document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(
  `${e.violatedDirective} blocked ${e.blockedURI || '(inline)'} at ${e.sourceFile || location.pathname}:${e.lineNumber}`));
"""


def collect_csp(page, where):
    found = page.evaluate("window.__csp || []")
    print(f"CSP violations on {where}: {len(found)}")
    return [f"{where}: {v}" for v in found]


def style_hashes_allowed(page):
    """Every <style> element in the live page must be allowed by a hash in the policy."""
    texts = page.evaluate("[...document.querySelectorAll('style')].map((s) => s.textContent)")
    allowed = set(re.findall(r"'(sha256-[^']+)'", policy_for("/")))
    live = {"sha256-" + base64.b64encode(hashlib.sha256(t.encode()).digest()).decode() for t in texts}
    print(f"<style> elements: {len(texts)}; all allowed by hash: {live <= allowed}")
    return live <= allowed


violations = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-proxy-server"])
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    # The page is fulfilled by this script (to add the CSP header), so Chrome no longer knows it came
    # from a loopback address and its Local Network Access check blocks calls to the local arbiter
    # and LLM. Grant the permission a visitor would be asked for; it does not change the CSP.
    context.grant_permissions(["local-network-access"], origin=ORIGIN)
    context.route(f"{ORIGIN}/**", with_csp)
    page = context.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: csp_console.append(m.text) if "Content Security Policy" in m.text else None)
    page.on("console", lambda m: print(f"console {m.type}: {m.text[:300]}") if m.type == "error" else None)
    page.add_init_script(CSP_LISTENER)
    page.add_init_script(f"localStorage.setItem('nsweb-byok-profiles-v1', {json.dumps(json.dumps(PROFILE))});")
    page.goto(SITE)

    # 1. Catalogue renders from the arbiter, with no floors.
    expect(page.locator(".item-card").first).to_be_visible(timeout=15000)
    cards = page.locator(".item-card").count()
    assert cards >= 4, cards
    assert "floor" not in page.locator("#catalog-body").inner_text().lower()
    expect(page.locator("#assistant-status")).to_contain_text("connected", timeout=15000)
    page.screenshot(path=f"{OUT}/1-market.png", full_page=False)
    print(f"catalogue: {cards} items; assistant: {page.locator('#assistant-status').inner_text()}")
    if os.environ.get("TT_PROBE") == "1":
        # Negative control: a raw HTML write must be refused and reported under the page CSP.
        refused = page.evaluate("""() => { const d = document.createElement('div');
            try { d.innerHTML = '<b>tt probe</b>'; return false; } catch (e) { return String(e); } }""")
        print("TT_PROBE: raw innerHTML write refused:", refused)

    # 2. Haggle by hand, then accept through the page's own dialog.
    page.select_option("#h-sku", "garri-ijebu-50kg")
    page.fill("#h-qty", "2")
    page.fill("#h-hours", "72")
    page.fill("#h-max", "100000")
    page.click("#haggle-form button[type=submit]")
    expect(page.locator(".deal").first).to_be_visible(timeout=10000)
    first_offer = page.locator(".offers li").first.inner_text()
    print("manual offers:", " | ".join(page.locator(".offers li").all_inner_texts()).replace("\n", " "))
    page.locator(".offers li button").first.click()
    expect(page.locator("#confirm")).to_be_visible()
    page.screenshot(path=f"{OUT}/2-confirm.png")
    page.click("#confirm button[value=confirm]")
    expect(page.locator(".receipt").first).to_contain_text("Signature verified", timeout=10000)
    receipt_id = page.locator(".receipt .small").first.inner_text().split()[1]
    print("manual receipt:", receipt_id, "| badge:", page.locator(".receipt .badge").first.inner_text())

    # 3. Verify the receipt by id with the in-browser check.
    page.fill("#v-id", receipt_id)
    page.click("#verify-form button")
    expect(page.locator("#v-out")).to_contain_text("Valid", timeout=10000)
    page.locator("#haggle").scroll_into_view_if_needed()
    page.screenshot(path=f"{OUT}/3-settled.png")

    # 4. The assistant: read market, negotiate (visitor confirms), show offers.
    page.locator("#assistant").scroll_into_view_if_needed()
    page.fill("#ns-input", "I need 2 bags of rice within 48 hours and won't pay more than 170,000 naira in total.")
    page.click("#ns-send")
    dialog = page.locator("dialog.assistant-review[open]")
    expect(dialog).to_be_visible(timeout=20000)
    dtext = dialog.inner_text()
    assert "Send this sealed bid" in dtext and "170,000" in dtext, dtext
    page.screenshot(path=f"{OUT}/4-agent-bid-dialog.png")
    dialog.locator("button", has_text="Seal and negotiate").click()
    expect(page.locator("#ns-msgs .ns-msg.bot").last).to_contain_text("Which one", timeout=20000)
    print("agent offers:", page.locator("#ns-msgs .ns-msg.bot").last.inner_text().replace("\n", " ")[:300])

    # 5. Accept the cheapest: the runtime-owned confirmation, then a signed receipt.
    page.fill("#ns-input", "Accept the cheapest offer.")
    page.click("#ns-send")
    expect(dialog).to_be_visible(timeout=20000)
    assert "Accept this offer" in dialog.inner_text()
    dialog.locator("button", has_text="Accept and settle").click()
    expect(page.locator("#ns-msgs .ns-msg.bot").last).to_contain_text("rct_", timeout=20000)
    print("agent:", page.locator("#ns-msgs .ns-msg.bot").last.inner_text())
    page.screenshot(path=f"{OUT}/5-agent-settled.png")
    assert page.locator(".receipt").count() == 2
    assert style_hashes_allowed(page), "a live <style> element is not allowed by the policy's hashes"
    violations += collect_csp(page, "index (after the full flow)")

    # 6. Phone layout.
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(SITE)
    expect(page.locator(".item-card").first).to_be_visible(timeout=15000)
    page.screenshot(path=f"{OUT}/6-mobile.png", full_page=False)
    violations += collect_csp(page, "index (phone)")

    # 7. The seller console, whose script moved out of the HTML for the CSP.
    page.goto(f"{ORIGIN}/vendor.html")
    expect(page.locator("#host")).to_have_text("localhost:8787", timeout=10000)
    # P1.6: the seller console checks the arbiter's /health first.
    expect(page.locator("#arbiter-health")).to_contain_text("Arbiter healthy", timeout=10000)
    print("vendor page health line:", page.locator("#arbiter-health").inner_text())
    page.screenshot(path=f"{OUT}/7-vendor.png", full_page=False)
    violations += collect_csp(page, "vendor")

    # 8. A custom Provider URL the page CSP blocks: the settings panel says so and names the allowed
    # providers, before and after the browser blocks the call. Separate context; its one expected
    # violation is checked here and not counted with the others.
    blocked_ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    blocked_ctx.grant_permissions(["local-network-access"], origin=ORIGIN)
    blocked_ctx.route(f"{ORIGIN}/**", with_csp)
    bpage = blocked_ctx.new_page()
    bpage.on("pageerror", lambda e: errors.append(f"blocked-provider page: {e}"))
    bpage.add_init_script(CSP_LISTENER)
    blocked_profile = json.loads(json.dumps(PROFILE))
    blocked_profile["profiles"][0]["router"] = "https://llm.blocked.example/v1"
    bpage.add_init_script(f"localStorage.setItem('nsweb-byok-profiles-v1', {json.dumps(json.dumps(blocked_profile))});")
    bpage.goto(SITE)
    expect(bpage.locator("#assistant-status")).to_contain_text("connected", timeout=15000)
    notice = bpage.locator("#oja-router-blocked")
    expect(notice).to_contain_text("blocks https://llm.blocked.example", timeout=5000)
    for name in ["Otari", "Google AI Studio", "Groq", "OpenRouter", "OpenAI", "Anthropic"]:
        assert name in notice.text_content(), name
    print("blocked provider, before sending:", notice.text_content())
    bpage.fill("#ns-input", "Hello")
    bpage.click("#ns-send")
    expect(bpage.locator("#assistant-status")).to_contain_text("security policy blocks https://llm.blocked.example", timeout=15000)
    expect(notice).to_be_visible()
    bpage.locator("#oja-router-blocked").scroll_into_view_if_needed()
    bpage.screenshot(path=f"{OUT}/8-provider-blocked.png", full_page=False)
    expected = bpage.evaluate("window.__csp || []")
    print("blocked provider, violations (expected):", expected)
    assert expected and all(v.startswith("connect-src blocked https://llm.blocked.example") for v in expected), expected
    print("blocked provider, after sending:", bpage.locator("#assistant-status").inner_text())
    blocked_ctx.close()

    # 9. Connect with Otari (runtime since d67755e), with otari.ai mocked: the authorize step is a top-level
    # navigation that the mock answers with a redirect back, and the key exchange is a fetch from the
    # page, which connect-src must allow. Every other external host is refused, so nothing reaches
    # the real network.
    otari_ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    otari_ctx.grant_permissions(["local-network-access"], origin=ORIGIN)
    otari = {"authorize": None, "token": None, "refused": []}

    def refuse(route):
        otari["refused"].append(route.request.url)
        route.abort()

    def otari_site(route):
        req = route.request
        if req.url.startswith("https://otari.ai/api/v1/oauth/apps/authorize"):
            otari["authorize"] = req.url
            q = parse_qs(urlparse(req.url).query)
            back = f"{q['redirect_uri'][0]}?code=test-code&state={q['state'][0]}&iss=https%3A%2F%2Fotari.ai"
            # Not a 302: Playwright does not route the request after a redirect it fulfilled, so the
            # page would come back without the CSP. A refresh makes the return a new, routed load.
            return route.fulfill(status=200, content_type="text/html",
                                 body=f'<meta http-equiv="refresh" content="0;url={html.escape(back)}">')
        if req.url == "https://otari.ai/api/v1/oauth/apps/token" and req.method == "POST":
            otari["token"] = parse_qs(req.post_data or "")
            return route.fulfill(status=200, content_type="application/json",
                                 headers={"access-control-allow-origin": ORIGIN},
                                 body=json.dumps({"access_token": "otk_test_oja_key"}))
        refuse(route)

    def otari_api(route):
        # A model call with the new key: answer like an OpenAI-compatible router, never the real one.
        route.fulfill(status=200, content_type="application/json",
                      headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*"},
                      body=json.dumps({"data": [{"id": "alibaba/qwen3.8-flash"}]}))

    otari_ctx.route("https://**", refuse)
    otari_ctx.route("https://otari.ai/**", otari_site)
    otari_ctx.route("https://api.otari.ai/**", otari_api)
    otari_ctx.route(f"{ORIGIN}/**", with_csp)
    opage = otari_ctx.new_page()
    opage.on("pageerror", lambda e: errors.append(f"otari page: {e}"))
    opage.on("console", lambda m: csp_console.append(f"otari: {m.text}") if "Content Security Policy" in m.text else None)
    opage.add_init_script(CSP_LISTENER)
    opage.goto(SITE)
    connect = opage.locator("#ns-connect-otari")
    expect(connect).to_be_visible(timeout=15000)
    connect.click()
    opage.wait_for_function("""() => (localStorage.getItem('nsweb-byok-profiles-v1') || '').includes('otk_test_oja_key')
      || [...(window.__csp || [])].length > 0""", timeout=15000)
    print("otari: CSP violations so far:", opage.evaluate("window.__csp || []"))
    print("otari: authorize", otari["authorize"])
    print("otari: token exchange", otari["token"])
    assert otari["authorize"], "the Connect button did not navigate to otari.ai"
    q = parse_qs(urlparse(otari["authorize"]).query)
    assert q["client_id"] == [ORIGIN] and q["redirect_uri"] == [f"{ORIGIN}/"], q
    assert q["response_type"] == ["code"] and q["code_challenge_method"] == ["S256"] and q["state"][0], q
    assert "code_verifier" not in q, "the PKCE verifier must never be in a URL"
    assert otari["token"], "the key exchange never reached otari.ai (blocked by connect-src?)"
    t = otari["token"]
    assert t["grant_type"] == ["authorization_code"] and t["code"] == ["test-code"] and t["client_id"] == [ORIGIN], t
    challenge = base64.urlsafe_b64encode(hashlib.sha256(t["code_verifier"][0].encode()).digest()).decode().rstrip("=")
    assert challenge == q["code_challenge"][0], "the verifier does not match the challenge"
    returned = [u for u in CSP_SERVED if "code=test-code" in u]
    assert returned, "the page otari.ai sent the visitor back to was not served with the page CSP"
    expect(opage.locator("#ns-in-use")).to_contain_text("Otari", timeout=10000)
    assert "code=" not in opage.url, opage.url
    print("otari: returned with CSP:", returned[0])
    print("otari: in use:", opage.locator("#ns-in-use").text_content(), "| refused:", otari["refused"])
    assert not otari["refused"], otari["refused"]
    expect(opage.locator("#ns-msgs")).to_contain_text("Connected to Otari", timeout=5000)
    expect(opage.locator("#assistant-status")).to_contain_text("connected", timeout=5000)
    opage.evaluate("document.querySelector('details.ns-settings').open = true")
    opage.locator("#assistant").scroll_into_view_if_needed()
    opage.screenshot(path=f"{OUT}/9-otari-connected.png", full_page=False)
    violations += collect_csp(opage, "index (Connect with Otari)")
    otari_ctx.close()
    browser.close()

violations += [f"console: {m}" for m in csp_console]
print("CSP violations in total:", len(violations))
for v in violations:
    print("  ", v)
assert not errors, errors
assert not violations, "CSP violations"
print("BROWSER CHECK OK")

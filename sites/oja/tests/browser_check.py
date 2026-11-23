"""Drive the Oja page in headless Chrome against a local arbiter and the scripted LLM.

Needs: arbiter on :8787 (seeded), site on :8080, tests/fake-llm.mjs on :8799.
    python3 tests/browser_check.py <screenshot dir>
"""
import json
import sys
from playwright.sync_api import sync_playwright, expect

OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp"
SITE = "http://127.0.0.1:8080/?arbiter=http://127.0.0.1:8787"
PROFILE = {
    "version": 1, "selectedId": "t", "updatedAt": "",
    "profiles": [{"id": "t", "name": "Test LLM", "key": "test-key", "model": "fake-1", "router": "http://127.0.0.1:8799", "runner": False, "updatedAt": ""}],
}

errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-proxy-server"])
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.on("pageerror", lambda e: errors.append(str(e)))
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
    print("manual receipt:", receipt_id)

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

    # 6. Phone layout.
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(SITE)
    expect(page.locator(".item-card").first).to_be_visible(timeout=15000)
    page.screenshot(path=f"{OUT}/6-mobile.png", full_page=False)
    browser.close()

assert not errors, errors
print("BROWSER CHECK OK")

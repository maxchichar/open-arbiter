// A scripted OpenAI-compatible LLM for browser tests: no key, no network, deterministic.
// It plays a buyer's assistant that reads the market, negotiates, then accepts.
//   node tests/fake-llm.mjs [port]
import http from "node:http";

const port = Number(process.argv[2] || 8799);
export const seen = [];

function decide(messages) {
  const last = messages[messages.length - 1];
  const userTurns = messages.filter((m) => m.role === "user");
  const lastUser = String(userTurns[userTurns.length - 1]?.content || "");
  const toolsSinceUser = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].role !== "user"; i--) if (messages[i].role === "tool") toolsSinceUser.unshift(messages[i]);
  const called = (name) => messages.slice(messages.lastIndexOf(userTurns[userTurns.length - 1])).some((m) => (m.tool_calls || []).some((c) => c.function.name === name));
  const call = (name, args) => ({ tool: { name, args } });

  if (/accept/i.test(lastUser)) {
    if (!called("website_get_market_state")) return call("website_get_market_state", {});
    if (!called("website_accept_offer")) {
      const state = toolsSinceUser.map((t) => t.content).join("\n");
      const id = (state.match(/"offer_id":\s*"(off_[\w-]+)"[^}]*?"state":\s*"OPEN"/) || state.match(/(off_[\w-]+)/) || [])[1];
      return call("website_accept_offer", { offer_id: id });
    }
    const receipt = (last.content.match(/rct_[\w-]+/) || ["(none)"])[0];
    return { text: `Done. Receipt ${receipt}; the arbiter's signature was checked in your browser.` };
  }
  if (/rice/i.test(lastUser)) {
    if (!called("website_get_market_state")) return call("website_get_market_state", {});
    if (!called("website_negotiate")) return call("website_negotiate", { sku: "rice-50kg", quantity: 2, max_total: 170000, deliver_within_hours: 48 });
    const offers = [...last.content.matchAll(/"seller":\s*"([^"]+)"[^}]*?"total":\s*(\d+)[^}]*?"saving":\s*(\d+)/g)];
    if (!offers.length) return { text: `No agreement this time. ${last.content.slice(0, 120)}` };
    return { text: `| Seller | Total | Saving |\n|---|---|---|\n${offers.map((o) => `| ${o[1]} | ₦${Number(o[2]).toLocaleString()} | ₦${Number(o[3]).toLocaleString()} |`).join("\n")}\n\nWhich one would you like?` };
  }
  return { text: "I can find foodstuff and negotiate a fair price for you." };
}

function sse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream", "access-control-allow-origin": "*" });
  for (const c of chunks) res.write(`data: ${JSON.stringify({ model: "fake-1", choices: [c] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, GET, OPTIONS" });
    return res.end();
  }
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); return res.end(JSON.stringify({ data: [{ id: "fake-1" }] })); }
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  seen.push(body);
  const d = decide(body.messages);
  console.log(JSON.stringify({ tools: (body.tools || []).map((t) => t.function.name), decision: d.tool ? d.tool.name : "text" }));
  if (d.tool) {
    sse(res, [
      { index: 0, delta: { tool_calls: [{ index: 0, id: `call_${seen.length}`, type: "function", function: { name: d.tool.name, arguments: JSON.stringify(d.tool.args) } }] } },
      { index: 0, delta: {}, finish_reason: "tool_calls" },
    ]);
  } else {
    sse(res, [{ index: 0, delta: { content: d.text } }, { index: 0, delta: {}, finish_reason: "stop" }]);
  }
}).listen(port, () => console.log(`fake LLM on http://127.0.0.1:${port}`));

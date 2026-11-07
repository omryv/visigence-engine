/* bin/genesis-mcp.mjs over its real transport: a child process, JSON-RPC 2.0,
 * one message per line on stdin and stdout.
 *
 * The session an MCP client opens: initialize (protocol 2025-06-18), the
 * initialized notification, tools/list, then tools/call genesis_compile on a
 * small intent — and the world and certificate that come back must VERIFY,
 * both through the server's own genesis_verify (tier 2) and through
 * js/certificate.js in this process, so the server is not grading its own
 * homework. Then the protocol's failure paths: a line that is not JSON, an
 * unknown method, an unknown tool, and a document that does not compile —
 * which is a tool result with isError, not a protocol error — and the two a
 * caller should not get past: an argument a tool does not declare, and a
 * world file whose ground block asks for a bake over MAX_VERIFY_RES.
 *
 * The client never waits forever: a request not answered in REQUEST_MS, or a
 * server that exits with requests outstanding, fails the request and kills
 * the child, so a hung server fails this file instead of hanging
 * sh tests/run.sh and sh check.sh — the only gate there is.
 *
 * Node only: it spawns node, and the signature needs WebCrypto.
 */
import { test, eq, ok, report } from "../kernel/harness.js";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { verifyCertificate, MAX_VERIFY_RES } from "../../../src/genesis/world/certificate.js";
import { validateWorldFile } from "../../../src/genesis/world/worldfile.js";

const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

/* A 513² compile is about 1.1 s; these are at 65². A minute is a hang. */
const REQUEST_MS = 60000;

/* A client: write a line, read the reply with the same id. Notifications get
   no reply, so `notify` only writes. Each waiting request holds its resolve,
   its reject and its timer. */
function client() {
  const child = spawn(process.execPath, [join(ROOT, "bin", "genesis-mcp.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", stderr = "";
  const waiting = new Map(), lines = [];
  const failAll = (why) => {
    for (const [, w] of waiting) { clearTimeout(w.timer); w.reject(new Error(why)); }
    waiting.clear();
  };
  child.on("exit", (code, signal) => failAll(`genesis-mcp exited (${code ?? signal}) with a request unanswered; stderr: ${stderr}`));
  child.on("error", (e) => failAll(`genesis-mcp could not run: ${e.message}`));
  const wait = (id, write) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      child.kill();
      reject(new Error(`genesis-mcp did not answer request ${JSON.stringify(id)} in ${REQUEST_MS} ms`));
    }, REQUEST_MS);
    waiting.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject, timer });
    write();
  });
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      lines.push(line);
      const msg = JSON.parse(line);
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w.resolve(msg); }
    }
  });
  let next = 1;
  return {
    child, lines, stderr: () => stderr,
    request(method, params) {
      const id = next++;
      return wait(id, () => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"));
    },
    notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); },
    raw(text, id = null) { return wait(id, () => child.stdin.write(text + "\n")); },
    close() { child.stdin.end(); return new Promise((res) => child.on("exit", res)); },
  };
}

if (!globalThis.crypto?.subtle) {
  print("genesis-mcp: skipped — this runtime has no WebCrypto (run under Node)");
} else {
  await main();
}

async function main() {
  const c = client();
  const init = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "suite", version: "1" } });
  c.notify("notifications/initialized");
  const list = await c.request("tools/list", {});
  const intent = {
    kind: "visigenesis.intent", version: 2, seed: "MCP0-TEST-K7QN",
    statements: [{ type: "summit", x: 300, z: -200, h: 190 }, { type: "pad", x: -400, z: 300, r: 64, h: 70 }],
  };
  const compiled = await c.request("tools/call", { name: "genesis_compile", arguments: { intent, res: 65 } });
  const out = compiled.result?.structuredContent;
  const verified = out ? await c.request("tools/call", { name: "genesis_verify", arguments: { world: out.world, certificate: out.certificate, tier: 2 } }) : null;
  const local = out ? await verifyCertificate(out.certificate, out.world, { tier: 2 }) : null;
  const explained = out ? await c.request("tools/call", { name: "genesis_explain", arguments: { world: out.world } }) : null;
  const schema = await c.request("tools/call", { name: "genesis_schema", arguments: {} });
  const garbage = await c.raw("this is not json");
  const unknown = await c.request("resources/list", {});
  const noTool = await c.request("tools/call", { name: "genesis_paint", arguments: {} });
  const refused = await c.request("tools/call", { name: "genesis_compile", arguments: { intent: { ...intent, statements: [{ type: "pad", x: 0, z: 0, r: 10, h: 1 }] } } });
  const pong = await c.request("ping");
  const extraArg = out ? await c.request("tools/call", { name: "genesis_explain", arguments: { world: out.world, res: 65 } }) : null;
  const bigWorld = out ? { ...out.world, ground: { ...out.world.ground, res: MAX_VERIFY_RES + 1 } } : null;
  const t0 = Date.now();
  const tooBig = out ? await c.request("tools/call", { name: "genesis_explain", arguments: { world: bigWorld, spawn: [0, 0] } }) : null;
  const tooBigMs = Date.now() - t0;
  const code = await c.close();
  /* A second session, asking for a revision the server does not know: it
     answers with the one it speaks. */
  const c2 = client();
  const initOld = await c2.request("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "suite", version: "1" } });
  await c2.close();

  test("initialize answers with the protocol revision, the tools capability and who it is", () => {
    eq(init.jsonrpc, "2.0"); eq(init.id, 1);
    eq(init.result.protocolVersion, "2025-06-18");
    ok(init.result.capabilities.tools);
    eq(init.result.serverInfo.name, "genesis");
    eq(initOld.result.protocolVersion, "2025-06-18", "an unknown revision is answered with the server's own");
  });

  test("the initialized notification gets no reply; every line out is one JSON-RPC message", () => {
    for (const line of c.lines) eq(JSON.parse(line).jsonrpc, "2.0");
    // One reply per request sent (the notification is the one with none).
    eq(c.lines.length, 13);
  });

  test("tools/list names the four tools, each with an object input schema", () => {
    const names = list.result.tools.map((t) => t.name);
    eq(JSON.stringify(names), JSON.stringify(["genesis_schema", "genesis_compile", "genesis_explain", "genesis_verify"]));
    for (const t of list.result.tools) { eq(t.inputSchema.type, "object"); ok(t.description.length > 20); }
  });

  test("genesis_compile returns a world, its certificate and the report, as structured content and as text", () => {
    eq(compiled.result.isError, false);
    eq(JSON.parse(compiled.result.content[0].text).report.seed, "MCP0-TEST-K7QN");
    eq(validateWorldFile(out.world).length, 0);
    eq(out.report.statements.length, 2);
    ok(out.report.statements.every((s) => s.stated && typeof s.miss === "number"));
    ok(out.report.conditioning.converged);
  });

  test("…and what it returns verifies at tier 2, through the server and through js/certificate.js here", () => {
    eq(verified.result.isError, false);
    ok(verified.result.structuredContent.ok, JSON.stringify(verified.result.structuredContent.mismatches));
    eq(verified.result.structuredContent.tier, 2);
    ok(local.ok, JSON.stringify(local.mismatches));
  });

  test("genesis_explain reads the statements back; genesis_schema is the schema", () => {
    eq(JSON.stringify(explained.result.structuredContent.statements), JSON.stringify(out.report.statements));
    eq(schema.result.structuredContent.$id, "urn:visigenesis:schema:intent:2");
  });

  test("a line that is not JSON is -32700, an unknown method -32601, an unknown tool -32602", () => {
    eq(garbage.error.code, -32700); eq(garbage.id, null);
    eq(unknown.error.code, -32601);
    eq(noTool.error.code, -32602);
  });

  test("a document that does not compile is a tool result with isError and the reason, not a protocol error", () => {
    ok(!refused.error);
    eq(refused.result.isError, true);
    ok(/statements\[0\]\.r 10/.test(refused.result.content[0].text), refused.result.content[0].text);
    eq(JSON.stringify(pong.result), "{}");
  });

  test("an argument a tool does not declare is refused by name, as an isError result", () => {
    ok(!extraArg.error);
    eq(extraArg.result.isError, true);
    ok(/genesis_explain takes no argument "res"/.test(extraArg.result.content[0].text), extraArg.result.content[0].text);
  });

  test("a world file whose ground block asks for a bake over MAX_VERIFY_RES is refused before it is baked", () => {
    ok(!tooBig.error);
    eq(tooBig.result.isError, true);
    ok(new RegExp(`grid ${MAX_VERIFY_RES + 1} is not a grid of 2–${MAX_VERIFY_RES}`).test(tooBig.result.content[0].text), tooBig.result.content[0].text);
    ok(tooBigMs < 5000, `answered in ${tooBigMs} ms`);
  });

  test("the server exits cleanly when its input closes, and says nothing on stderr", () => {
    eq(code, 0);
    eq(c.stderr(), "");
  });
}

report("genesis-mcp");

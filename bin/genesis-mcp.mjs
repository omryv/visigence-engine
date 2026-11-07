#!/usr/bin/env node
/* genesis-mcp — the author interface as a Model Context Protocol server.
 *
 * An AI author does not need a phrase table (js/make-brief.js) to ask for a
 * world: it can write the statements condition.js solves. This hands it the
 * four things bin/genesis.mjs does, as tools, over stdio:
 *
 *   genesis_schema    the intent document's JSON Schema (schema/intent.schema.json)
 *   genesis_compile   an intent document in; the world file, its certificate
 *                     and the report (nats, miss per statement, converged) out
 *   genesis_explain   a world file in; per-statement met/miss, nats, the
 *                     freedom map's summary, and reach and par for a spawn
 *                     and an objective
 *   genesis_verify    a world file and a certificate in; js/certificate.js
 *                     verifyCertificate's answer out, every mismatch by name
 *
 * Register it with Claude Code, from the repository root (the absolute path
 * is so the server starts whatever directory Claude Code is later opened in):
 *
 *     claude mcp add genesis -- node "$(pwd)/bin/genesis-mcp.mjs"
 *
 * ── the wire ──
 * JSON-RPC 2.0, one message per line on stdin and stdout (the MCP stdio
 * transport: no embedded newlines, nothing else on stdout — diagnostics go to
 * stderr). Protocol revision 2025-06-18 (SUPPORTED_PROTOCOL_VERSIONS). Four methods: initialize,
 * notifications/initialized (a notification: no reply), tools/list and
 * tools/call, and ping, which costs nothing to answer. Anything else is
 * -32601; a line that is not JSON is -32700; a request without a method or
 * with bad params is -32600/-32602. A tool that runs and fails — a document
 * that does not compile, a world file that does not validate — is NOT a
 * protocol error: it is a result with isError true and the reasons in its
 * text, which is what the protocol asks for, so the author can read them and
 * try again.
 *
 * Every tool result carries its answer twice, as the protocol suggests for a
 * tool with structured output: `structuredContent` (the object) and one text
 * block holding the same object as JSON, for a client that reads only text.
 *
 * Requests are answered in the order they arrive, one at a time: a compile is
 * a bake and a signature (about 1.1 s at 513² for a four-statement document
 * on the machine this was written on), and nothing here is worth the
 * interleaving.
 *
 * No dependencies: node:readline and the repository's own modules.
 */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compileIntent, explainWorld } from "../src/genesis/world/author.js";
import { verifyCertificate } from "../src/genesis/world/certificate.js";

export const PROTOCOL_VERSION = "2025-06-18";
/* The revisions initialize may settle on. The protocol's rule: a server that
   supports the revision the client asks for answers with that one, and
   otherwise with one it does support (the newest), for the client to accept
   or hang up on. Only 2025-06-18 is listed because it is the only one this
   server was written and tested against — its tool results carry
   structuredContent, which that revision introduced. */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([PROTOCOL_VERSION]);
export const SERVER_INFO = Object.freeze({ name: "genesis", title: "Visigenesis author interface", version: "2.0.0" });

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(HERE, "..", "schema", "intent.schema.json"), "utf8"));

const xz = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[x, z] in world metres" };
export const TOOLS = [
  {
    name: "genesis_schema",
    title: "Intent document schema",
    description: "The JSON Schema (2020-12) of an intent document: a world asked for in statements about its ground (points, summits, flats, pads, levels, shorelines, sightline rays and road corridors). Read it before writing a document for genesis_compile.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "genesis_compile",
    title: "Compile an intent document",
    description: "Compile an intent document into a world: the seed's ground bent by the least improbable change that makes every statement true. Returns the world file (open it in the Visigenesis editor), a signed certificate for it, and a report: per statement its miss in metres and whether it was met, the nats the change cost, and whether the solve converged. A document that does not compile comes back as an error listing every reason.",
    inputSchema: {
      type: "object",
      required: ["intent"],
      additionalProperties: false,
      properties: {
        intent: { type: "object", description: "An intent document (see genesis_schema)." },
        seed: { type: "string", description: "Overrides the document's seed." },
        res: { type: "integer", minimum: 2, maximum: 1025, description: "Ground grid, samples per edge. Default 513, the canonical bake; 65 or 129 is a quick trial (a different set of ground hashes)." },
      },
    },
  },
  {
    name: "genesis_explain",
    title: "Explain a world",
    description: "Read a world file's statements back off its ground: per statement met or missed and by how much, the nats, the freedom map (how much of the ground the statements decided), and — given a spawn and/or an objective — how much ground a walker reaches and the par of the walk between them.",
    inputSchema: {
      type: "object",
      required: ["world"],
      additionalProperties: false,
      properties: {
        world: { type: "object", description: "A world file, as genesis_compile returns it." },
        spawn: { ...xz, description: "Where the walk starts, [x, z] metres. Defaults to the file's spawn when only an objective is given." },
        objective: { ...xz, description: "Where the walk ends, [x, z] metres." },
      },
    },
  },
  {
    name: "genesis_verify",
    title: "Verify a certificate",
    description: "Check a world file against its certificate. Tier 1 checks the signature, the file's digest and everything recomputable without a bake; tier 2 also re-bakes the ground, re-solves the intent and re-floods the reach, and compares every derived claim equal. Every mismatch is named.",
    inputSchema: {
      type: "object",
      required: ["world", "certificate"],
      additionalProperties: false,
      properties: {
        world: { type: "object" },
        certificate: { type: "object" },
        tier: { type: "integer", enum: [1, 2], description: "Default 1." },
      },
    },
  },
];

const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/* Thrown inside a tool for a bad call the tool can name: becomes isError. */
class ToolError extends Error {}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const point = (v, what) => {
  if (v == null) return null;
  if (!(Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n)))) throw new ToolError(`${what} must be [x, z], two numbers`);
  return v;
};

const HANDLERS = {
  async genesis_schema() { return SCHEMA; },
  async genesis_compile(a) {
    if (!isObject(a.intent)) throw new ToolError("intent must be an intent document (an object; see genesis_schema)");
    if (a.seed !== undefined && typeof a.seed !== "string") throw new ToolError("seed must be a string");
    if (a.res !== undefined && !Number.isInteger(a.res)) throw new ToolError("res must be a whole number");
    try {
      return await compileIntent(a.intent, { seed: a.seed ?? null, res: a.res ?? undefined });
    } catch (e) {
      if (e instanceof TypeError || e instanceof RangeError) throw new ToolError(e.message);
      throw e;
    }
  },
  async genesis_explain(a) {
    if (!isObject(a.world)) throw new ToolError("world must be a world file (an object)");
    try {
      return explainWorld(a.world, { spawn: point(a.spawn, "spawn"), objective: point(a.objective, "objective") });
    } catch (e) {
      if (e instanceof TypeError || e instanceof RangeError) throw new ToolError(e.message);
      throw e;
    }
  },
  async genesis_verify(a) {
    if (!isObject(a.world) || !isObject(a.certificate)) throw new ToolError("world and certificate must both be objects");
    const tier = a.tier ?? 1;
    if (tier !== 1 && tier !== 2) throw new ToolError("tier must be 1 or 2");
    return verifyCertificate(a.certificate, a.world, { tier });
  },
};

/**
 * One JSON-RPC message in, the reply out (null for a notification, which
 * gets none). Exported so a test can drive the protocol without a process;
 * the stdio loop below is this and a line reader.
 */
export async function handle(msg) {
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message, id = msg?.id ?? null) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (!isObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "not a JSON-RPC 2.0 request");
  const notification = !("id" in msg);
  if (notification) return null; // notifications/initialized, notifications/cancelled, …: nothing to say
  const p = msg.params ?? {};
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(p?.protocolVersion) ? p.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Ask for a world in statements: read genesis_schema, write an intent document, genesis_compile it, read the report (every statement's miss), adjust, and genesis_verify the result. Coordinates are metres on a plate centred on (0, 0), 4096 m wide by default.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      if (!isObject(p) || typeof p.name !== "string") return fail(-32602, "tools/call needs params.name");
      const run = HANDLERS[p.name];
      if (!run) return fail(-32602, `unknown tool ${JSON.stringify(p.name)}`);
      const args = p.arguments ?? {};
      if (!isObject(args)) return fail(-32602, "tools/call params.arguments must be an object");
      try {
        /* Every inputSchema says additionalProperties: false, and an argument
           the tool does not read is one the caller thinks did something
           (a `res` handed to genesis_explain, say): refused by name. */
        const known = Object.keys(TOOL_BY_NAME[p.name].inputSchema.properties);
        const extra = Object.keys(args).filter((k) => !known.includes(k));
        if (extra.length) throw new ToolError(`${p.name} takes no argument${extra.length === 1 ? "" : "s"} ${extra.map((k) => JSON.stringify(k)).join(", ")} (it takes ${known.length ? known.join(", ") : "none"})`);
        const out = await run(args);
        return reply({ content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: false });
      } catch (e) {
        const text = e instanceof ToolError ? e.message : `${p.name} failed: ${e?.message ?? e}`;
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

/* ── stdio ── */
function serve() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  const send = (m) => { if (m) process.stdout.write(JSON.stringify(m) + "\n"); };
  rl.on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let msg;
      try { msg = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error: not JSON" } }); return; }
      try { send(await handle(msg)); } catch (e) {
        process.stderr.write(`genesis-mcp: ${e?.stack ?? e}\n`);
        send({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32603, message: `internal error: ${e?.message ?? e}` } });
      }
    });
  });
  rl.on("close", () => { chain.then(() => process.exit(0)); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) serve();

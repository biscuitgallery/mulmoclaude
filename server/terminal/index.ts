// Interactive `claude`-in-a-PTY relay + session-activity channel.
//
// Ported from mulmoterminal (server/index.js):
//
//   - A raw `ws` WebSocket server at `/ws/terminal` that streams an
//     interactive `claude` PTY to an xterm terminal in the browser. The
//     PTY map buffers recent output and survives a socket drop so the
//     user can reattach (e.g. switch sessions and come back).
//
// Each spawned `claude` is wired to MulmoClaude's REAL `mulmoclaude` MCP
// broker (via `--mcp-config`) with `MULMOCLAUDE_CHAT_SESSION_ID` set, so
// the broker's tool results publish on `sessionChannel(sessionId)` and
// the right-hand GUI panel renders the real plugin views directly — no
// separate GUI data channel is needed.
//
// The terminal WS shares the HTTP server with socket.io (the pub/sub at
// `/ws/pubsub`) via `noServer:true` + a manual `upgrade` handler that
// only claims the `/ws/terminal` pathname and ignores everything else.

import express, { type Request, type Response, type Router } from "express";
import os from "os";
import path from "path";
import fs from "fs/promises";
import http from "http";
import { randomUUID } from "crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { IPubSub } from "../events/pub-sub/index.js";
import { PUBSUB_CHANNELS } from "../../src/config/pubsubChannels.js";
import { log } from "../system/logger/index.js";
import { getAllToolDescriptors } from "../agent/activeTools.js";
import { buildMcpConfig, resolveMcpConfigPaths, BASE_ALLOWED_TOOLS, CLAUDE_AI_CONNECTOR_SERVERS } from "../agent/config.js";
import { writeJsonAtomic } from "../utils/files/json.js";
import { loadSettings } from "../system/config.js";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

// A session id is always a UUID (server-generated, or a .jsonl basename).
// Reject anything else so a client can't smuggle CLI flags into the
// spawned process (e.g. "--resume" followed by a re-parsed flag).
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Pub/sub channels (declared centrally in src/config/pubsubChannels.ts).
const SESSIONS_CHANNEL = PUBSUB_CHANNELS.terminalSessions;

const SESSION_LIST_LIMIT = 50;
const OUTPUT_BUFFER_LIMIT = 64 * 1024;

interface PtyEntry {
  // node-pty's IPty — typed loosely since node-pty is dynamically imported.
  term: {
    pid: number;
    onData: (cb: (d: string) => void) => void;
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => void;
    write: (d: string) => void;
    resize: (c: number, r: number) => void;
    kill: () => void;
  };
  ws: WebSocket | null;
  buffer: string;
  // Host path of the per-session mcp-config file written before spawn.
  // Unlinked (best-effort) on reap so temp files don't accumulate.
  mcpConfigPath?: string;
}

interface ActivityState {
  working?: boolean;
  waiting?: boolean;
  event?: string | null;
  at?: number;
}

// Per-session "working" / "waiting" state, driven by Claude hooks.
const activity = new Map<string, ActivityState>();
// Live ptys keyed by session id.
const ptys = new Map<string, PtyEntry>();
// New sessions started in this process with no .jsonl on disk yet.
const knownSessions = new Map<string, { createdAt: number; title: string }>();

// Set by attachTerminalServer().
let pubsub: IPubSub | null = null;
let workspaceCwd = process.cwd();

// ── Activity / reaping helpers ──────────────────────────────────────

function reap(id: string): void {
  const entry = ptys.get(id);
  if (!entry) return;
  ptys.delete(id);
  knownSessions.delete(id);
  const a = activity.get(id);
  if (!a || (!a.working && !a.waiting)) activity.delete(id);
  try {
    entry.term.kill();
  } catch {
    // already gone
  }
  // Best-effort cleanup of the per-session mcp-config temp file
  // (mirrors agent/index.ts's `finally` unlink).
  if (entry.mcpConfigPath) {
    fs.unlink(entry.mcpConfigPath).catch(() => {});
  }
  pubsub?.publish(SESSIONS_CHANNEL, { id, working: false, event: "closed" });
}

function publishActivity(id: string): void {
  const a = activity.get(id) || {};
  pubsub?.publish(SESSIONS_CHANNEL, {
    id,
    working: a.working ?? false,
    waiting: a.waiting ?? false,
    event: a.event ?? null,
  });
}

function setWorking(id: string, working: boolean, event?: string): void {
  const prev = activity.get(id) || {};
  if ((prev.working ?? false) === working) return;
  activity.set(id, { ...prev, working, event: event ?? prev.event ?? null, at: Date.now() });
  publishActivity(id);
  if (!working) {
    const entry = ptys.get(id);
    if (entry && !entry.ws) {
      log.info("terminal", `reaping idle background session ${id}`);
      reap(id);
    }
  }
}

function setWaiting(id: string, waiting: boolean, event?: string): void {
  const prev = activity.get(id) || {};
  if ((prev.waiting ?? false) === waiting) return;
  activity.set(id, { ...prev, waiting, event: event ?? prev.event ?? null, at: Date.now() });
  publishActivity(id);
}

// ── Claude wiring (settings hook + mcp-config) ──────────────────────

function hookSettingsJson(port: number): string {
  const cmd = `curl -s -X POST http://localhost:${port}/api/terminal/hook ` + `-H 'content-type: application/json' -d @- >/dev/null 2>&1`;
  const entry = [{ hooks: [{ type: "command", command: cmd }] }];
  return JSON.stringify({
    hooks: { UserPromptSubmit: entry, Stop: entry, Notification: entry },
  });
}

// ── Session listing (Claude .jsonl files) ───────────────────────────

function projectSessionsDir(cwd: string): string {
  const encoded = path.resolve(cwd).replace(/[/.]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", encoded);
}

interface SessionMeta {
  id: string;
  title: string;
  mtime: number;
  working: boolean;
  waiting: boolean;
}

async function readSessionMeta(dir: string, file: string): Promise<SessionMeta> {
  const full = path.join(dir, file);
  const [raw, stat] = await Promise.all([fs.readFile(full, "utf8"), fs.stat(full)]);

  let aiTitle: string | null = null;
  let lastPrompt: string | null = null;
  let firstUserMsg: string | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "ai-title" && o.aiTitle) aiTitle = String(o.aiTitle);
    else if (o.type === "last-prompt" && o.lastPrompt) lastPrompt = String(o.lastPrompt);
    else if (o.type === "user" && firstUserMsg === null) {
      let c: unknown = (o.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(c)) {
        c = c.map((x) => (x && typeof x === "object" ? (x as { text?: string }).text || "" : x)).join(" ");
      }
      if (typeof c === "string" && c.trim() && !/^\s*<(local-command|command-|bash-)/.test(c)) {
        firstUserMsg = c.trim();
      }
    }
  }

  const title = aiTitle || lastPrompt || firstUserMsg || "(untitled session)";
  const id = path.basename(file, ".jsonl");
  const a = activity.get(id);
  return { id, title, mtime: stat.mtimeMs, working: a?.working ?? false, waiting: a?.waiting ?? false };
}

// Whether a .jsonl already exists for a session id (=> use --resume).
async function sessionFileExists(id: string): Promise<boolean> {
  try {
    await fs.access(path.join(projectSessionsDir(workspaceCwd), `${id}.jsonl`));
    return true;
  } catch {
    return false;
  }
}

// ── Express router (/api/terminal) ──────────────────────────────────

export function createTerminalRouter(): Router {
  const router = express.Router();

  // Claude hooks (UserPromptSubmit / Stop / Notification) POST here.
  router.post("/api/terminal/hook", (req: Request, res: Response) => {
    const { session_id, hook_event_name } = (req.body || {}) as { session_id?: string; hook_event_name?: string };
    if (session_id) {
      const entry = ptys.get(session_id);
      const foreground = entry && entry.ws;
      if (hook_event_name === "UserPromptSubmit") {
        setWorking(session_id, true, hook_event_name);
      } else if (hook_event_name === "Stop") {
        if (!foreground) setWaiting(session_id, true, hook_event_name);
        setWorking(session_id, false, hook_event_name);
      } else if (hook_event_name === "Notification") {
        if (!foreground) setWaiting(session_id, true, hook_event_name);
      }
    }
    res.json({ ok: true });
  });

  // List the chat sessions for the workspace, including new (unpersisted) ones.
  router.get("/api/terminal/sessions", async (_req: Request, res: Response) => {
    try {
      const dir = projectSessionsDir(workspaceCwd);
      let files: string[] = [];
      try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }

      const onDiskStats = (
        await Promise.all(
          files.map(async (file) => {
            try {
              const st = await fs.stat(path.join(dir, file));
              return { kind: "disk" as const, id: path.basename(file, ".jsonl"), file, mtime: st.mtimeMs };
            } catch {
              return null;
            }
          }),
        )
      ).filter((x): x is { kind: "disk"; id: string; file: string; mtime: number } => x !== null);
      const onDisk = new Set(onDiskStats.map((s) => s.id));

      const pending: { kind: "pending"; id: string; title: string; mtime: number; working: boolean; waiting: boolean }[] = [];
      for (const [id, meta] of knownSessions) {
        if (onDisk.has(id)) {
          knownSessions.delete(id);
          continue;
        }
        pending.push({
          kind: "pending",
          id,
          title: meta.title,
          mtime: meta.createdAt,
          working: activity.get(id)?.working ?? false,
          waiting: activity.get(id)?.waiting ?? false,
        });
      }

      const top = [...onDiskStats, ...pending].sort((a, b) => b.mtime - a.mtime).slice(0, SESSION_LIST_LIMIT);
      const sessions = (
        await Promise.all(
          top.map((s) =>
            s.kind === "pending"
              ? { id: s.id, title: s.title, mtime: s.mtime, working: s.working, waiting: s.waiting }
              : readSessionMeta(dir, s.file).catch(() => null),
          ),
        )
      )
        .filter((x): x is SessionMeta => x !== null)
        .sort((a, b) => b.mtime - a.mtime);

      res.json({ cwd: workspaceCwd, sessions });
    } catch (err) {
      log.error("terminal", "/api/terminal/sessions failed", { error: String(err) });
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}

// ── WebSocket terminal relay ────────────────────────────────────────

export interface AttachTerminalOptions {
  workspacePath: string;
  pubsub: IPubSub;
  port: number;
}

export function attachTerminalServer(httpServer: http.Server, opts: AttachTerminalOptions): void {
  pubsub = opts.pubsub;
  workspaceCwd = opts.workspacePath;
  const port = opts.port;

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url || "/", "http://localhost");
    // Only claim the terminal path; everything else (socket.io's
    // /ws/pubsub) is left to its own upgrade handler.
    if (pathname === "/ws/terminal") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    }
  });

  wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
    void handleConnection(ws, req, port);
  });

  log.info("terminal", "interactive terminal relay attached at /ws/terminal");
}

async function handleConnection(ws: WebSocket, req: http.IncomingMessage, port: number): Promise<void> {
  const resume = new URL(req.url || "/", "http://localhost").searchParams.get("session");
  if (resume && !SESSION_ID_RE.test(resume)) {
    log.warn("terminal", `rejecting non-UUID session id: ${JSON.stringify(resume)}`);
    ws.close();
    return;
  }
  const sessionId = resume || randomUUID();

  ws.send(JSON.stringify({ type: "session", id: sessionId }));

  let entry = ptys.get(sessionId);
  if (entry) {
    // Reattach to a live background pty instead of spawning a duplicate.
    if (entry.ws && entry.ws !== ws && entry.ws.readyState === entry.ws.OPEN) {
      entry.ws.close();
    }
    entry.ws = ws;
    if (entry.buffer && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "output", data: entry.buffer }));
    }
  } else {
    // node-pty is a native module that may be absent on some platforms.
    let pty: typeof import("node-pty");
    try {
      pty = await import("node-pty");
    } catch {
      log.error("terminal", "node-pty not available, cannot spawn claude");
      ws.send(JSON.stringify({ type: "exit", exitCode: 1, signal: null }));
      ws.close();
      return;
    }

    // Use --resume only when a .jsonl already exists for this id;
    // otherwise --session-id creates a fresh session with a known id.
    const onDisk = resume ? await sessionFileExists(resume) : false;

    const settings = hookSettingsJson(port);

    // Wire the REAL MulmoClaude MCP broker (auth + internal
    // /api/agent/internal callbacks) into this spawned `claude`. With
    // `MULMOCLAUDE_CHAT_SESSION_ID` set (below), the broker publishes
    // every tool result on `sessionChannel(sessionId)`, which the
    // right-hand GUI panel renders as real plugin views. Roles are being
    // removed, so we expose the full, unfiltered tool surface
    // (`getAllToolDescriptors`) rather than a role-gated subset.
    const allTools = getAllToolDescriptors();
    const activePlugins = allTools.map((descriptor) => descriptor.name);
    const mcpConfig = buildMcpConfig({
      chatSessionId: sessionId,
      port,
      activePlugins,
      useDocker: false,
      userServers: {},
    });

    const mcpPaths = resolveMcpConfigPaths({ workspacePath: workspaceCwd, sessionId, useDocker: false });
    await writeJsonAtomic(mcpPaths.hostPath, mcpConfig);

    // Allowed-tools: base CLI tools + the broker wildcard + every
    // broker tool's full name + claude.ai connectors + the web UI's
    // extra allowlist. Deduped. We deliberately drop
    // `--strict-mcp-config` so the user's claude.ai connectors and
    // `claude mcp`-added servers also load.
    const allowedTools = [
      ...new Set([
        ...BASE_ALLOWED_TOOLS,
        "mcp__mulmoclaude",
        ...CLAUDE_AI_CONNECTOR_SERVERS,
        ...allTools.map((descriptor) => descriptor.fullName),
        ...loadSettings().extraAllowedTools,
      ]),
    ].join(",");

    const mcpArgs = ["--mcp-config", mcpPaths.argPath, "--allowedTools", allowedTools];
    const args = onDisk && resume ? ["--resume", resume, "--settings", settings, ...mcpArgs] : ["--session-id", sessionId, "--settings", settings, ...mcpArgs];

    log.info("terminal", `spawning claude (${onDisk ? "resume" : "new"} ${sessionId})`);

    const term = pty.spawn(CLAUDE_BIN, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: workspaceCwd,
      env: { ...(process.env as { [key: string]: string }), MULMOCLAUDE_CHAT_SESSION_ID: sessionId },
    }) as unknown as PtyEntry["term"];

    entry = { term, ws, buffer: "", mcpConfigPath: mcpPaths.hostPath };
    ptys.set(sessionId, entry);

    if (!onDisk) {
      knownSessions.set(sessionId, { createdAt: Date.now(), title: "New session" });
      pubsub?.publish(SESSIONS_CHANNEL, { id: sessionId, working: false, event: "created" });
    }

    const localEntry = entry;
    term.onData((data: string) => {
      localEntry.buffer = (localEntry.buffer + data).slice(-OUTPUT_BUFFER_LIMIT);
      if (localEntry.ws && localEntry.ws.readyState === localEntry.ws.OPEN) {
        localEntry.ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    term.onExit(({ exitCode, signal }) => {
      log.info("terminal", `pty exited code=${exitCode} signal=${signal}`);
      if (localEntry.ws && localEntry.ws.readyState === localEntry.ws.OPEN) {
        localEntry.ws.send(JSON.stringify({ type: "exit", exitCode, signal }));
        localEntry.ws.close();
      }
      setWorking(sessionId, false);
      reap(sessionId);
    });
  }

  // Foreground (being viewed): clear any "waiting for input" flag.
  setWaiting(sessionId, false);

  const liveEntry = entry;
  ws.on("message", (raw: Buffer) => {
    if (liveEntry.ws !== ws) return;
    let msg: { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      if (msg.type === "input" && typeof msg.data === "string") {
        liveEntry.term.write(msg.data);
      } else if (
        msg.type === "resize" &&
        Number.isInteger(msg.cols) &&
        Number.isInteger(msg.rows) &&
        (msg.cols as number) >= 2 &&
        (msg.cols as number) <= 500 &&
        (msg.rows as number) >= 1 &&
        (msg.rows as number) <= 200
      ) {
        liveEntry.term.resize(msg.cols as number, msg.rows as number);
      }
    } catch (err) {
      log.warn("terminal", `dropped message for ${sessionId}: ${String(err)}`);
    }
  });

  ws.on("close", () => {
    if (liveEntry.ws !== ws) return;
    liveEntry.ws = null;
    if (activity.get(sessionId)?.working) {
      log.info("terminal", `disconnected; keeping working session ${sessionId} alive`);
    } else {
      reap(sessionId);
    }
  });
}

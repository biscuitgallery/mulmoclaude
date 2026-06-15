// Interactive `claude`-in-a-PTY relay + GUI-protocol data channel.
//
// Ported from mulmoterminal (server/index.js). Two halves:
//
//   1. A raw `ws` WebSocket server at `/ws/terminal` that streams an
//      interactive `claude` PTY to an xterm terminal in the browser. The
//      PTY map buffers recent output and survives a socket drop so the
//      user can reattach (e.g. switch sessions and come back).
//
//   2. The GUI-protocol "data channel": the GUI-protocol MCP tools
//      (presentMarkdown / presentForm), wired into each spawned `claude`
//      via `--mcp-config`, POST frames to `/api/gui`; we store them per
//      session and publish on the `gui` pub/sub channel so the GUI panel
//      renders them live. presentForm additionally registers a pending
//      request that the user's `/api/gui/answer` submission resolves.
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
import { fileURLToPath } from "url";
import { WebSocketServer, type WebSocket } from "ws";
import type { IPubSub } from "../events/pub-sub/index.js";
import { PUBSUB_CHANNELS } from "../../src/config/pubsubChannels.js";
import { log } from "../system/logger/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

// A session id is always a UUID (server-generated, or a .jsonl basename).
// Reject anything else so a client can't smuggle CLI flags into the
// spawned process (e.g. "--resume" followed by a re-parsed flag).
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_RE = SESSION_ID_RE;

// Pub/sub channels (declared centrally in src/config/pubsubChannels.ts).
const SESSIONS_CHANNEL = PUBSUB_CHANNELS.terminalSessions;
const GUI_CHANNEL = PUBSUB_CHANNELS.gui;

// Stdio MCP server wired into each spawned claude (--mcp-config). It
// exposes the GUI-protocol tools (presentMarkdown, presentForm).
const MCP_SERVER_PATH = path.join(__dirname, "..", "mcp", "present-markdown.mjs");

// MCP tool names claude uses, in mcp__<server>__<tool> form. Auto-allowed
// via --allowedTools so the GUI tools run without a permission prompt.
const GUI_MCP_TOOLS = ["mcp__mulmoclaude-gui__presentMarkdown", "mcp__mulmoclaude-gui__presentForm"].join(",");

const GUI_HISTORY_LIMIT = 50;
const FORM_POLL_HOLD_MS = 25 * 1000;
const SESSION_LIST_LIMIT = 50;
const OUTPUT_BUFFER_LIMIT = 64 * 1024;

interface GuiFrame {
  type: string;
  data: Record<string, unknown>;
}

interface PendingForm {
  sessionId: string;
  answered: boolean;
  answer: Record<string, unknown> | null;
  waiters: Set<{ res: Response; timer: ReturnType<typeof setTimeout> }>;
  frame: GuiFrame;
}

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
}

interface ActivityState {
  working?: boolean;
  waiting?: boolean;
  event?: string | null;
  at?: number;
}

// Latest GUI payloads per session, kept in memory so the panel can replay
// them when a session is (re)selected.
const guiPayloads = new Map<string, GuiFrame[]>();
// In-flight presentForm requests, keyed by requestId.
const pendingForms = new Map<string, PendingForm>();
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

function mcpConfigJson(sessionId: string, port: number): string {
  return JSON.stringify({
    mcpServers: {
      "mulmoclaude-gui": {
        command: process.execPath, // the node running this server
        args: [MCP_SERVER_PATH],
        env: {
          MULMOCLAUDE_GUI_SESSION_ID: sessionId,
          MULMOCLAUDE_GUI_PORT: String(port),
        },
      },
    },
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

// ── Express router (/api/terminal + /api/gui) ───────────────────────

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

  // GUI-protocol MCP tools POST frames here.
  router.post("/api/gui", (req: Request, res: Response) => {
    const { sessionId, type, data } = (req.body || {}) as { sessionId?: string; type?: string; data?: Record<string, unknown> };
    if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
      return res.status(400).json({ error: "invalid sessionId" });
    }
    if (typeof data !== "object" || data === null) {
      return res.status(400).json({ error: "invalid data" });
    }

    let frame: GuiFrame;
    if (type === "presentMarkdown") {
      if (typeof data.markdown !== "string") {
        return res.status(400).json({ error: "invalid markdown" });
      }
      frame = { type, data: { markdown: data.markdown } };
    } else if (type === "presentForm") {
      const requestId = data.requestId as string | undefined;
      const schema = data.schema as { fields?: unknown[] } | undefined;
      if (!requestId || !UUID_RE.test(requestId)) {
        return res.status(400).json({ error: "invalid requestId" });
      }
      if (!schema || typeof schema !== "object" || !Array.isArray(schema.fields) || schema.fields.length === 0) {
        return res.status(400).json({ error: "invalid schema" });
      }
      frame = { type, data: { requestId, schema, answered: false, answer: null } };
      pendingForms.set(requestId, { sessionId, answered: false, answer: null, waiters: new Set(), frame });
    } else {
      return res.status(400).json({ error: "unsupported type" });
    }

    const list = guiPayloads.get(sessionId) || [];
    list.push(frame);
    if (list.length > GUI_HISTORY_LIMIT) list.splice(0, list.length - GUI_HISTORY_LIMIT);
    guiPayloads.set(sessionId, list);

    pubsub?.publish(GUI_CHANNEL, { sessionId, ...frame });
    res.json({ ok: true });
  });

  // Long-poll for a form's answer.
  router.get("/api/gui/answer/:requestId", (req: Request, res: Response) => {
    const requestId = String(req.params.requestId);
    if (!UUID_RE.test(requestId)) {
      return res.status(400).json({ error: "invalid requestId" });
    }
    const form = pendingForms.get(requestId);
    if (!form) return res.status(404).json({ error: "unknown requestId" });
    if (form.answered) return res.json({ answer: form.answer });

    const waiter = { res, timer: null as unknown as ReturnType<typeof setTimeout> };
    waiter.timer = setTimeout(() => {
      form.waiters.delete(waiter);
      if (!res.headersSent) res.status(204).end();
    }, FORM_POLL_HOLD_MS);
    form.waiters.add(waiter);
    req.on("close", () => {
      clearTimeout(waiter.timer);
      form.waiters.delete(waiter);
    });
  });

  // GUI panel POSTs the user's form submission here.
  router.post("/api/gui/answer", (req: Request, res: Response) => {
    const { requestId, answer } = (req.body || {}) as { requestId?: string; answer?: Record<string, unknown> };
    if (!requestId || !UUID_RE.test(requestId)) {
      return res.status(400).json({ error: "invalid requestId" });
    }
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
      return res.status(400).json({ error: "invalid answer" });
    }
    const form = pendingForms.get(requestId);
    if (!form) return res.status(404).json({ error: "unknown requestId" });

    if (!form.answered) {
      form.answered = true;
      form.answer = answer;
      form.frame.data.answered = true;
      form.frame.data.answer = answer;
      for (const w of form.waiters) {
        clearTimeout(w.timer);
        if (!w.res.headersSent) w.res.json({ answer });
      }
      form.waiters.clear();
      pubsub?.publish(GUI_CHANNEL, { sessionId: form.sessionId, type: "formAnswered", data: { requestId, answer } });
    }
    res.json({ ok: true });
  });

  // Replay a session's stored GUI payloads.
  router.get("/api/gui/:sessionId", (req: Request, res: Response) => {
    const sessionId = String(req.params.sessionId);
    if (!SESSION_ID_RE.test(sessionId)) {
      return res.status(400).json({ error: "invalid sessionId" });
    }
    res.json({ sessionId, payloads: guiPayloads.get(sessionId) || [] });
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
    const mcp = mcpConfigJson(sessionId, port);
    const guiArgs = ["--mcp-config", mcp, "--strict-mcp-config", "--allowedTools", GUI_MCP_TOOLS];
    const args = onDisk && resume ? ["--resume", resume, "--settings", settings, ...guiArgs] : ["--session-id", sessionId, "--settings", settings, ...guiArgs];

    log.info("terminal", `spawning claude (${onDisk ? "resume" : "new"} ${sessionId})`);

    const term = pty.spawn(CLAUDE_BIN, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: workspaceCwd,
      env: process.env as { [key: string]: string },
    }) as unknown as PtyEntry["term"];

    entry = { term, ws, buffer: "" };
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

// Single source of truth for every WebSocket pub/sub channel name
// the app publishes to or subscribes to. Keeping these in one file
// means:
//
//   - a rename is one edit instead of a grep-and-edit across
//     server + client
//   - typo-wise, publisher and subscriber can't drift (both import
//     the same const / factory)
//   - a new channel gets declared here first, then wired — the
//     declaration serves as a lightweight registry / audit list
//
// **Aggregator shape**: plugins that own static channels declare
// them in their `meta.ts` under `staticChannels` and the host
// auto-merges via `BUILT_IN_PLUGIN_METAS`. Channel factories
// (e.g. `bookChannel(bookId)`) stay as named exports in each
// plugin's meta.ts because their signatures are plugin-specific —
// re-exported below under the existing public names.
//
// First slice of issue #289 (item 6: pub-sub channels).

import { BUILT_IN_PLUGIN_METAS, defineHostAggregate, type BuiltInPluginMetas, type HostPluginCollision, type IntraPluginCollision } from "../plugins/metas";
import {
  bookChannel as accountingBookChannelFromMeta,
  BOOK_EVENT_KINDS as ACCOUNTING_BOOK_EVENT_KINDS_FROM_META,
  type BookEventKind as AccountingBookEventKindFromMeta,
  type BookChannelPayload as AccountingBookChannelPayloadFromMeta,
} from "../plugins/accounting/meta";

/**
 * Channel for the per-session event stream. One per chat session.
 * Publishers: `server/session-store/index.ts` (tool results, status,
 * text chunks, switch-role, session_finished, …).
 * Subscribers: `src/App.vue` (one subscription per actively-viewed
 * session).
 */
export function sessionChannel(chatSessionId: string): string {
  return `session.${chatSessionId}`;
}

/**
 * Channel for "this workspace file just changed". One per workspace-
 * relative path. The path is normalised to POSIX separators so a
 * Windows publisher and a Linux subscriber agree on the channel name
 * (the workspace is per-machine, but tests, fixtures, and future
 * remote editing all benefit from a portable contract).
 *
 * Publishers: any route that writes to disk and wants the UI to
 * re-render — currently `presentHtml` (POST + PUT) and the markdown
 * `updateMarkdown` route.
 * Subscribers: `useFileChange(filePath)` — wired from
 * `presentHtml/View.vue` and `markdown/View.vue`.
 */
/** Normalise a workspace-relative path to the POSIX form used as both
 *  the `fileChannel` suffix and the `FileChannelPayload.path`. Exposed
 *  separately so publishers can share one normalised string between the
 *  channel name and the payload — keeping them in sync is the contract. */
export function toPosixWorkspacePath(workspaceRelativePath: string): string {
  // Replace backslashes too — covers both Windows (`\`) and any
  // pre-normalised mixed separators from upstream code.
  return workspaceRelativePath.split(/[\\/]/g).filter(Boolean).join("/");
}

export function fileChannel(workspaceRelativePath: string): string {
  return `file:${toPosixWorkspacePath(workspaceRelativePath)}`;
}

/** Payload published on `fileChannel(...)`. `mtimeMs` is the post-write
 *  `fs.stat().mtimeMs`; subscribers use it both as a cache-buster and
 *  as a monotonic clock to drop out-of-order events. */
export interface FileChannelPayload {
  path: string; // workspace-relative POSIX, matches the channel suffix
  mtimeMs: number;
}

/** Payload published on `PUBSUB_CHANNELS.sessions`.
 *  - Empty `{}` for ordinary "something changed, refetch" hints
 *    (run/finish, mark-read, bookmark toggle).
 *  - `{ deletedIds }` when sessions have been hard-deleted, so
 *    subscribers can drop them from their local caches without a
 *    full refetch (cursor diffs don't carry deletions). */
export interface SessionsChannelPayload {
  deletedIds?: string[];
}

/**
 * Per-book change channel — one channel per book id. Publishers
 * fan out journal / opening / accounts / snapshot events scoped to
 * a single bookId (see `AccountingBookChannelPayload`).
 *
 * Publisher: `server/accounting/eventPublisher.ts` (called from
 * every mutating action in the service layer).
 * Subscribers: View.vue + sub-components via
 * `useAccountingChannel(bookId)`.
 *
 * Book-list-level events (a new book was created, an existing one
 * was deleted) ride the static `PUBSUB_CHANNELS.accountingBooks`
 * channel below — kept separate so a `JournalList.vue` viewing book
 * A doesn't repaint when the user creates book B from another window.
 */
// Plugin-owned: re-export accounting helpers from `meta.ts` under
// the existing public names so external consumers don't have to
// migrate their imports.
export const accountingBookChannel = accountingBookChannelFromMeta;
export const ACCOUNTING_BOOK_EVENT_KINDS = ACCOUNTING_BOOK_EVENT_KINDS_FROM_META;
export type AccountingBookEventKind = AccountingBookEventKindFromMeta;
export type AccountingBookChannelPayload = AccountingBookChannelPayloadFromMeta;

// Plugin-owned static channel names auto-merged from each plugin's
// META. Mapped type preserves the literal channel string (e.g.
// `"accounting:books"`) so consumers get string-literal types.
//
// Distributive conditional types collapse the union of per-plugin
// records into an INTERSECTION so consumers see the merged shape
// (`{ accountingBooks: "..." } & { ... }`) rather than the
// per-plugin union (which TS won't let you index into safely).
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

// `Record<never, never>` (no index signature), not
// `Record<string, never>` — the latter's index signature collapses
// `keyof` of the merged intersection back to `string`, breaking
// literal-key consumers. Same trap as `PluginWorkspaceDirsContribution`.
type PluginStaticChannelsContribution<M> = M extends { readonly staticChannels: infer C } ? { readonly [K in keyof C]: C[K] } : Record<never, never>;

type PluginStaticChannelsMap<T extends BuiltInPluginMetas> = UnionToIntersection<PluginStaticChannelsContribution<T[number]>>;

const HOST_STATIC_CHANNELS = {
  /** Sidebar "a session updated, please refetch" notification.
   *  Publisher: `server/session-store/index.ts#publishSessionsChanged`.
   *  Subscribers: `useSessionHistory` (purges deletedIds from the
   *  cached list), `useSessionSync` (purges deletedIds from
   *  sessionMap; refetches summaries for live state). */
  sessions: "sessions",
  /** Server-side debug heartbeat — wired through the task-manager
   *  demo counter. Useful for sanity-checking that the WS pipe is
   *  alive end-to-end. */
  debugBeat: "debug.beat",
  /** Dev plugin (`--dev-plugin <path>`) `dist/` changed — debounced.
   *  Publisher: `server/plugins/dev-watcher.ts` after fs.watch fires.
   *  Subscriber: `src/composables/useDevPluginReload.ts` triggers
   *  `location.reload()` so the author sees their save without ⌘R.
   *  Payload: `{ name: string, changedFiles: string[], serverSideChange: boolean }`. */
  devPluginChanged: "dev-plugin-changed",
  /** Notifier state-change events (`published` / `cleared` /
   *  `cancelled`) as a discriminated union. Single global channel;
   *  subscribers filter by `pluginPkg` client-side. Publisher:
   *  `server/notifier/engine.ts` after persistence succeeds.
   *  Payload: `NotifierEvent`. */
  notifier: "notifier",
  /** Interactive-terminal GUI-protocol frames. The GUI-protocol MCP
   *  tools (presentMarkdown, presentForm) POST to `/api/gui`, which
   *  publishes the frame here keyed by session id. Subscriber:
   *  `src/components/terminal/GuiPanel.vue` (filters by the active
   *  session id client-side). Payload:
   *  `{ sessionId, type, data }`. */
  gui: "gui",
  /** Interactive-terminal session-activity events. The terminal PTY
   *  relay publishes session created / working / closed here.
   *  Subscriber: `src/components/terminal/TerminalChat.vue` (refetches
   *  `/api/terminal/sessions`). Payload:
   *  `{ id, working?, waiting?, event? }`. */
  terminalSessions: "terminal-sessions",
} as const;

// First-write-wins host+plugin aggregate (see `defineHostAggregate`):
// host keys win on collision, second-claiming plugin wins are
// dropped, both diagnostic lists are exposed for boot warnings.
const PUBSUB_CHANNELS_AGGREGATE = defineHostAggregate(BUILT_IN_PLUGIN_METAS, {
  label: "PUBSUB_CHANNELS",
  hostRecord: HOST_STATIC_CHANNELS,
  extract: (meta) => meta.staticChannels,
  dimension: "staticChannels",
});
export const PUBSUB_CHANNELS_HOST_COLLISIONS: readonly HostPluginCollision[] = PUBSUB_CHANNELS_AGGREGATE.hostCollisions;
export const PUBSUB_CHANNELS_INTRA_COLLISIONS: readonly IntraPluginCollision[] = PUBSUB_CHANNELS_AGGREGATE.intraCollisions;

/** Static pub/sub channel names. Factories for parameterised channels
 *  (e.g. `sessionChannel(id)`) live alongside as named helpers. */
export const PUBSUB_CHANNELS = PUBSUB_CHANNELS_AGGREGATE.merged as unknown as typeof HOST_STATIC_CHANNELS & PluginStaticChannelsMap<BuiltInPluginMetas>;

export type StaticPubSubChannel = (typeof PUBSUB_CHANNELS)[keyof typeof PUBSUB_CHANNELS];

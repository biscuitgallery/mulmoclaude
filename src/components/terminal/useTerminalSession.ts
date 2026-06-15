// Live `ActiveSession` for the interactive terminal's active chat id.
//
// The spawned `claude` is wired to MulmoClaude's REAL `mulmoclaude` MCP
// broker, with `MULMOCLAUDE_CHAT_SESSION_ID` set to the terminal session
// id. The broker publishes every tool result as an `SseEvent` on
// `sessionChannel(sessionId)` — the SAME channel App.vue subscribes to.
//
// This composable maintains one reactive `ActiveSession` per active
// terminal id and feeds the channel's events through `applyAgentEvent`
// (the same dispatcher App.vue uses), so the right panel can render the
// real plugin views (presentDocument, presentForm, …) identically.

import { ref, watch, onUnmounted, type Ref } from "vue";
import type { ToolResultComplete } from "gui-chat-protocol/vue";
import type { ActiveSession } from "../../types/session";
import type { SseEvent } from "../../types/sse";
import { EVENT_TYPES } from "../../types/events";
import { applyAgentEvent, type AgentEventContext } from "../../utils/agent/eventDispatch";
import { createEmptySession } from "../../utils/session/sessionFactory";
import { updateResult } from "../../utils/session/sessionHelpers";
import { usePubSub } from "../../composables/usePubSub";
import { sessionChannel } from "../../config/pubsubChannels";

export interface TerminalSession {
  /** The reactive session, or `null` before an id is selected. */
  session: Ref<ActiveSession | null>;
  /** Apply an `@update-result` from a plugin view back into the session. */
  applyUpdatedResult: (updatedResult: ToolResultComplete) => void;
}

export function useTerminalSession(sessionId: Ref<string | null>): TerminalSession {
  const { subscribe } = usePubSub();
  const session = ref<ActiveSession | null>(null);
  let unsubscribe: (() => void) | undefined;

  // Minimal AgentEventContext: the terminal panel has no role list, no
  // sidebar to scroll, and no read-tracking — `applyAgentEvent` only
  // calls these for non-result events we don't surface here.
  function buildContext(theSession: ActiveSession): AgentEventContext {
    return {
      get session() {
        return theSession;
      },
      refreshRoles: async () => {},
      scrollSidebarToBottom: () => {},
      onGenerationsDrained: () => {},
    };
  }

  function teardown(): void {
    unsubscribe?.();
    unsubscribe = undefined;
  }

  watch(
    sessionId,
    (currentId) => {
      teardown();
      if (!currentId) {
        session.value = null;
        return;
      }
      // Roles are being removed; an empty roleId is harmless for a
      // session that only ever renders tool results.
      const newSession = createEmptySession(currentId, "");
      session.value = newSession;
      const ctx = buildContext(newSession);
      unsubscribe = subscribe(sessionChannel(currentId), (data) => {
        const event = data as SseEvent;
        if (!event || typeof event !== "object") return;
        // The broker publishes session_finished when a run ends; nothing
        // to refresh here (live events already landed), so ignore it.
        if (event.type === EVENT_TYPES.sessionFinished) return;
        applyAgentEvent(event, ctx).catch((err) => {
          console.error("[terminal applyAgentEvent] unhandled:", err);
        });
      });
    },
    { immediate: true },
  );

  onUnmounted(teardown);

  function applyUpdatedResult(updatedResult: ToolResultComplete): void {
    if (session.value) updateResult(session.value, updatedResult);
  }

  return { session, applyUpdatedResult };
}

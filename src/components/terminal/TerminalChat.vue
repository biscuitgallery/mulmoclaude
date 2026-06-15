<script setup lang="ts">
import { ref } from "vue";
import { v4 as uuidv4 } from "uuid";
import TerminalSessionList from "./TerminalSessionList.vue";
import TerminalView from "./Terminal.vue";
import GuiPanel from "./GuiPanel.vue";

// Two-panel interactive-Claude chat: session list (left) + terminal
// (center) + GUI panel (right). The terminal streams an interactive
// `claude` PTY over /ws/terminal; the GUI panel renders GUI-protocol
// frames (presentMarkdown / presentForm) keyed on the active session.

// `activeId` is the session currently in the foreground. `null` only
// transiently before the first connect resolves an id — but we now
// generate a uuid client-side for new sessions so the GUI panel /
// terminal always agree on the id from the start.
const activeId = ref<string | null>(null);
// Increments on every user action so re-selecting the same session (or
// starting another fresh one) still forces the terminal to reconnect.
const connectKey = ref(0);

function selectSession(id: string) {
  activeId.value = id;
  connectKey.value++;
}

function newSession() {
  // Generate the id client-side so the terminal connects with
  // ?session=<uuid> and the server uses --session-id <uuid>. Both panels
  // key on it immediately (no waiting for the server's "session" message).
  activeId.value = uuidv4();
  connectKey.value++;
}

// The server echoes the live session id on connect. For new sessions this
// matches the uuid we generated; adopt it defensively in case of resume.
function onSession(id: string) {
  activeId.value = id;
}
</script>

<template>
  <div class="terminal-chat">
    <TerminalSessionList :active-id="activeId" @select="selectSession" @new="newSession" />
    <div class="main">
      <TerminalView :session-id="activeId" :connect-key="connectKey" @session="onSession" />
      <GuiPanel :session-id="activeId" />
    </div>
  </div>
</template>

<style scoped>
.terminal-chat {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* SessionList | [ Terminal | GuiPanel ] */
.main {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
</style>

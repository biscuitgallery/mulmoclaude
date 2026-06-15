<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ToolResultComplete } from "gui-chat-protocol/vue";
import { getPlugin } from "../../tools";
import { useTerminalSession } from "./useTerminalSession";

// Right panel of the interactive-terminal chat. The spawned `claude` is
// wired to MulmoClaude's REAL `mulmoclaude` MCP broker, whose tool
// results publish on `sessionChannel(sessionId)`. `useTerminalSession`
// folds those events into a live `ActiveSession`; here we render the
// selected tool result with the SAME `<component :is>` pattern as
// App.vue's single-layout block, so the real plugin views
// (presentDocument, presentForm, …) render identically.
//
// A gear button toggles a tool-call history drawer listing every result
// the session has produced (name + label), so it's easy to see what
// Claude actually called and jump between results.

const props = defineProps<{ sessionId: string | null }>();

const sessionId = computed(() => props.sessionId);
const { session, applyUpdatedResult } = useTerminalSession(sessionId);

const results = computed<ToolResultComplete[]>(() => session.value?.toolResults ?? []);

// Selection: explicit pick (clicking a history row) wins; otherwise
// default to the most recent result. Cleared whenever the session id
// changes so a stale uuid from a previous session never sticks.
const selectedUuid = ref<string | null>(null);
const showHistory = ref(false);
watch(sessionId, () => {
  selectedUuid.value = null;
  showHistory.value = false;
});

const selectedResult = computed<ToolResultComplete | null>(() => {
  const list = results.value;
  if (list.length === 0) return null;
  if (selectedUuid.value) {
    const match = list.find((result) => result.uuid === selectedUuid.value);
    if (match) return match;
  }
  return list[list.length - 1];
});

function selectFromHistory(uuid: string): void {
  selectedUuid.value = uuid;
  showHistory.value = false;
}

function handleUpdateResult(updatedResult: ToolResultComplete): void {
  applyUpdatedResult(updatedResult);
}

function resultLabel(result: ToolResultComplete, index: number): string {
  return result.title || result.message || result.toolName || `Result ${index + 1}`;
}
</script>

<template>
  <!-- eslint-disable @intlify/vue-i18n/no-raw-text -- interactive-terminal panel is dev chrome; its strings stay out of the 8-locale i18n bundle (matches the rest of src/components/terminal). -->
  <section class="gui-panel">
    <header class="panel-header">
      <span class="panel-title">Output</span>
      <span v-if="results.length" class="count">{{ results.length }}</span>
      <button class="gear" :class="{ active: showHistory }" title="Tool call history" @click="showHistory = !showHistory">
        <span class="material-icons">settings</span>
      </button>
    </header>

    <!-- Tool-call history drawer. Lists every result the session has
         produced; clicking one renders it and closes the drawer. -->
    <div v-if="showHistory" class="history">
      <div v-if="results.length === 0" class="history-empty">No tool calls yet.</div>
      <button
        v-for="(result, i) in results"
        :key="result.uuid"
        class="history-item"
        :class="{ active: result.uuid === (selectedResult?.uuid ?? '') }"
        :title="resultLabel(result, i)"
        @click="selectFromHistory(result.uuid)"
      >
        <span class="history-index">{{ i + 1 }}</span>
        <span class="history-tool">{{ result.toolName || "(no tool)" }}</span>
        <span class="history-label">{{ resultLabel(result, i) }}</span>
      </button>
    </div>

    <div class="content">
      <component
        :is="getPlugin(selectedResult.toolName)?.viewComponent"
        v-if="selectedResult && getPlugin(selectedResult.toolName)?.viewComponent"
        :key="selectedResult.uuid"
        :selected-result="selectedResult"
        @update-result="handleUpdateResult"
      />
      <div v-else-if="selectedResult" class="raw">
        <pre>{{ JSON.stringify(selectedResult, null, 2) }}</pre>
      </div>
      <div v-else class="empty">Tool results from Claude will render here.</div>
    </div>
  </section>
  <!-- eslint-enable @intlify/vue-i18n/no-raw-text -->
</template>

<style scoped>
.gui-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: #ffffff;
  color: #111827;
  border-left: 1px solid #2a2a4e;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: #16213e;
  color: #e0e0e0;
  font-family: system-ui, sans-serif;
  flex-shrink: 0;
}
.panel-title {
  font-size: 13px;
  font-weight: 600;
}
.count {
  font-size: 11px;
  background: #2563eb;
  color: #ffffff;
  border-radius: 9999px;
  padding: 0 7px;
  line-height: 18px;
}
.gear {
  margin-left: auto;
  display: flex;
  align-items: center;
  background: none;
  border: none;
  color: #9aa5c4;
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
}
.gear:hover {
  color: #ffffff;
}
.gear.active {
  color: #ffffff;
  background: #1d2b4e;
}
.gear .material-icons {
  font-size: 18px;
}

.history {
  max-height: 45%;
  overflow-y: auto;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}
.history-empty {
  padding: 12px;
  font-size: 13px;
  color: #9ca3af;
  font-family: system-ui, sans-serif;
}
.history-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  background: none;
  border: none;
  border-bottom: 1px solid #f0f1f3;
  cursor: pointer;
  font-family: system-ui, sans-serif;
}
.history-item:hover {
  background: #eef2ff;
}
.history-item.active {
  background: #e0e7ff;
}
.history-index {
  font-size: 11px;
  color: #9ca3af;
  min-width: 16px;
}
.history-tool {
  font-size: 12px;
  font-weight: 600;
  color: #2563eb;
  white-space: nowrap;
}
.history-label {
  font-size: 12px;
  color: #4b5563;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #9ca3af;
  font-size: 13px;
  font-family: system-ui, sans-serif;
}
.raw {
  height: 100%;
  overflow: auto;
  padding: 16px;
}
.raw pre {
  font-size: 12px;
  white-space: pre-wrap;
}
</style>

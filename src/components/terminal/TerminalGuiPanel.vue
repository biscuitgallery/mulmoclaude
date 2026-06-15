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

const props = defineProps<{ sessionId: string | null }>();

const sessionId = computed(() => props.sessionId);
const { session, applyUpdatedResult } = useTerminalSession(sessionId);

const results = computed<ToolResultComplete[]>(() => session.value?.toolResults ?? []);

// Selection: explicit pick (clicking a title) wins; otherwise default to
// the most recent result. Cleared whenever the session id changes so a
// stale uuid from a previous session never sticks.
const selectedUuid = ref<string | null>(null);
watch(sessionId, () => {
  selectedUuid.value = null;
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

function selectResult(uuid: string): void {
  selectedUuid.value = uuid;
}

function handleUpdateResult(updatedResult: ToolResultComplete): void {
  applyUpdatedResult(updatedResult);
}

function resultLabel(result: ToolResultComplete, index: number): string {
  return result.title || result.message || result.toolName || `Result ${index + 1}`;
}
</script>

<template>
  <section class="gui-panel">
    <!-- Result picker. Shown only when more than one result exists so a
         single render fills the panel without chrome. -->
    <div v-if="results.length > 1" class="picker">
      <button
        v-for="(result, i) in results"
        :key="result.uuid"
        class="picker-item"
        :class="{ active: result.uuid === (selectedResult?.uuid ?? '') }"
        :title="resultLabel(result, i)"
        @click="selectResult(result.uuid)"
      >
        {{ resultLabel(result, i) }}
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
      <!-- eslint-disable-next-line @intlify/vue-i18n/no-raw-text -- interactive-terminal panel is dev chrome; its strings stay out of the i18n bundle (matches the rest of src/components/terminal). -->
      <div v-else class="empty">Tool results from Claude will render here.</div>
    </div>
  </section>
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

.picker {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  background: #f3f4f6;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}
.picker-item {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 9999px;
  border: 1px solid #d1d5db;
  background: #ffffff;
  color: #374151;
  cursor: pointer;
}
.picker-item.active {
  background: #2563eb;
  border-color: #2563eb;
  color: #ffffff;
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

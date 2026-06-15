<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { usePubSub } from "../../composables/usePubSub";
import { PUBSUB_CHANNELS } from "../../config/pubsubChannels";
import { apiGet } from "../../utils/api";
import GuiForm from "./GuiForm.vue";

// The GUI panel renders the structured `data` pushed by GUI-protocol MCP
// tools (presentMarkdown, presentForm). It mirrors the terminal's active
// session: live frames arrive on the `gui` pub/sub channel, and history is
// replayed from /api/gui/:sessionId when a session is (re)selected.
const props = defineProps<{ sessionId: string | null }>();

interface FormSchema {
  title?: string;
  fields: { name: string; label?: string; type?: string; options?: string[] }[];
  submitLabel?: string;
}
interface GuiFrame {
  type: string;
  data: {
    markdown?: string;
    requestId?: string;
    schema?: FormSchema;
    answered?: boolean;
    answer?: Record<string, unknown> | null;
  };
}

const frames = ref<GuiFrame[]>([]);

function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(raw);
}

async function loadHistory(id: string) {
  const res = await apiGet<{ payloads?: GuiFrame[] }>(`/api/gui/${encodeURIComponent(id)}`);
  frames.value = res.ok ? (res.data.payloads ?? []) : [];
}

watch(
  () => props.sessionId,
  (id) => {
    if (id) loadHistory(id);
    else frames.value = [];
  },
  { immediate: true },
);

const { subscribe } = usePubSub();
let unsubscribe: (() => void) | undefined;

onMounted(() => {
  unsubscribe = subscribe(PUBSUB_CHANNELS.gui, (data) => {
    const msg = data as { sessionId: string } & GuiFrame;
    // Only render frames for the session currently in the foreground.
    if (msg.sessionId !== props.sessionId) return;
    if (msg.type === "formAnswered") {
      const answerData = msg.data as unknown as { requestId?: string; answer?: Record<string, unknown> | null };
      const f = frames.value.find((fr) => fr.type === "presentForm" && fr.data.requestId === answerData.requestId);
      if (f) {
        f.data.answered = true;
        f.data.answer = answerData.answer ?? null;
      }
      return;
    }
    frames.value = [...frames.value, { type: msg.type, data: msg.data }];
  });
});
onUnmounted(() => unsubscribe?.());

const hasContent = computed(() => frames.value.length > 0);
</script>

<template>
  <section class="gui-panel">
    <div class="header">
      <span class="title">GUI</span>
    </div>
    <div class="content">
      <div v-if="!hasContent" class="empty">
        Ask Claude to use <code>presentMarkdown</code> or <code>presentForm</code>
        to render content here.
      </div>
      <template v-for="(f, i) in frames" :key="i">
        <GuiForm
          v-if="f.type === 'presentForm' && f.data.requestId && f.data.schema"
          class="frame"
          :request-id="f.data.requestId"
          :schema="f.data.schema"
          :answered="f.data.answered ?? false"
          :answer="f.data.answer ?? null"
        />
        <!-- DOMPurify-sanitized in renderMarkdown; v-html required to render it. -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <article v-else class="frame markdown-body" v-html="renderMarkdown(f.data.markdown ?? '')" />
      </template>
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
  background: #11162a;
  border-left: 1px solid #2a2a4e;
}

.header {
  padding: 8px 16px;
  background: #16213e;
  color: #e0e0e0;
  font-family: system-ui, sans-serif;
  font-size: 14px;
  flex-shrink: 0;
}
.title {
  font-weight: 600;
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  color: #e0e0e0;
  font-family: system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.5;
}

.empty {
  color: #7c87a8;
  font-size: 13px;
}
.empty code {
  background: #1d2b4e;
  padding: 1px 5px;
  border-radius: 4px;
}

.frame + .frame {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #2a2a4e;
}
</style>

<!-- Markdown element styling (unscoped: targets v-html output). -->
<style>
.markdown-body table {
  border-collapse: collapse;
  margin: 8px 0;
}
.markdown-body th,
.markdown-body td {
  border: 1px solid #2a2a4e;
  padding: 4px 10px;
  text-align: left;
}
.markdown-body th {
  background: #1d2b4e;
}
.markdown-body code {
  background: #1d2b4e;
  padding: 1px 5px;
  border-radius: 4px;
  font-family: "JetBrains Mono", monospace;
  font-size: 0.9em;
}
.markdown-body pre {
  background: #0d1124;
  padding: 10px 12px;
  border-radius: 6px;
  overflow-x: auto;
}
.markdown-body pre code {
  background: none;
  padding: 0;
}
.markdown-body a {
  color: #4a8cff;
}
.markdown-body h1,
.markdown-body h2,
.markdown-body h3 {
  margin: 12px 0 6px;
}
</style>

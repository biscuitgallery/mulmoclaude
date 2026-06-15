<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { apiPost } from "../../utils/api";

// Renders a presentForm from its schema and POSTs the user's answer back
// to the server, which unblocks the waiting MCP tool call (the round-trip).
// Once answered — here or in another viewer — the form locks and shows the
// result.
interface Field {
  name: string;
  label?: string;
  type?: string;
  options?: string[];
  placeholder?: string;
  required?: boolean;
}
interface Schema {
  title?: string;
  fields: Field[];
  submitLabel?: string;
}

const props = defineProps<{
  requestId: string;
  schema: Schema;
  answered: boolean;
  answer: Record<string, unknown> | null;
}>();

const values = reactive<Record<string, string>>({});
const submitted = ref(false);
const submitting = ref(false);
const error = ref<string | null>(null);

function seed() {
  for (const f of props.schema.fields) {
    const prior = props.answer?.[f.name];
    values[f.name] = prior != null ? String(prior) : "";
  }
  submitted.value = props.answered;
}
seed();

watch(
  () => props.answered,
  (a) => {
    if (a) seed();
  },
);

const locked = () => submitted.value || props.answered;

async function submit() {
  if (locked() || submitting.value) return;
  for (const f of props.schema.fields) {
    if (f.required && !values[f.name]?.trim()) {
      error.value = `"${f.label || f.name}" is required.`;
      return;
    }
  }
  error.value = null;
  submitting.value = true;
  try {
    const res = await apiPost("/api/gui/answer", { requestId: props.requestId, answer: { ...values } });
    if (!res.ok) throw new Error(res.error);
    submitted.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form class="gui-form" @submit.prevent="submit">
    <h3 v-if="schema.title" class="form-title">
      {{ schema.title }}
    </h3>

    <div v-for="f in schema.fields" :key="f.name" class="field">
      <label :for="`${requestId}-${f.name}`">{{ f.label || f.name }}</label>

      <textarea
        v-if="f.type === 'textarea'"
        :id="`${requestId}-${f.name}`"
        v-model="values[f.name]"
        :placeholder="f.placeholder"
        :disabled="locked()"
        rows="3"
      />
      <select v-else-if="f.type === 'select'" :id="`${requestId}-${f.name}`" v-model="values[f.name]" :disabled="locked()">
        <option value="" disabled>
          {{ f.placeholder || "Select…" }}
        </option>
        <option v-for="opt in f.options || []" :key="opt" :value="opt">
          {{ opt }}
        </option>
      </select>
      <input
        v-else
        :id="`${requestId}-${f.name}`"
        v-model="values[f.name]"
        :type="f.type === 'number' ? 'number' : 'text'"
        :placeholder="f.placeholder"
        :disabled="locked()"
      />
    </div>

    <div v-if="error" class="form-error">
      {{ error }}
    </div>

    <div class="actions">
      <button type="submit" :disabled="locked() || submitting">
        {{ locked() ? "Submitted ✓" : submitting ? "Submitting…" : schema.submitLabel || "Submit" }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.gui-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.form-title {
  margin: 0;
  font-size: 15px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field label {
  font-size: 12px;
  color: #9aa5c4;
}

input,
textarea,
select {
  background: #0d1124;
  border: 1px solid #2a2a4e;
  border-radius: 6px;
  color: #e0e0e0;
  padding: 6px 8px;
  font: inherit;
  font-size: 13px;
}
input:focus,
textarea:focus,
select:focus {
  outline: none;
  border-color: #4a8cff;
}
input:disabled,
textarea:disabled,
select:disabled {
  opacity: 0.7;
  cursor: default;
}

.form-error {
  color: #ef9a9a;
  font-size: 12px;
}

.actions {
  display: flex;
  justify-content: flex-end;
}
button {
  background: #1b3a6b;
  color: #cfe0ff;
  border: none;
  border-radius: 6px;
  padding: 7px 14px;
  font-size: 13px;
  cursor: pointer;
}
button:hover:not(:disabled) {
  background: #224a86;
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>

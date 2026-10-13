<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { ApiClient, ConversationDetail } from "@mnemic/shared";
import { formatDateTime, formatValue } from "../lib/format.js";

const speakerLabels: Record<string, string> = { user: "用户", assistant: "助手", tool: "工具" };

const props = defineProps<{
  projectId: string;
  conversationId: string;
  api: ApiClient;
}>();

const conversation = ref<ConversationDetail | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    conversation.value = await props.api.getConversation(props.projectId, props.conversationId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "对话读取失败";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section
    v-if="loading"
    class="rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500"
  >
    正在读取消息时间线…
  </section>

  <section
    v-else-if="error"
    class="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-800"
  >
    <p class="font-medium">对话读取失败</p>
    <p class="mt-1">{{ error }}</p>
    <RouterLink class="mt-4 inline-flex text-sm font-medium underline" to="/conversations">
      返回对话列表
    </RouterLink>
  </section>

  <article v-else-if="conversation" class="space-y-6">
    <RouterLink class="text-sm font-medium text-zinc-500 hover:text-zinc-900" to="/conversations">
      ← 对话列表
    </RouterLink>

    <header class="rounded-2xl border border-zinc-200 bg-white p-6">
      <p class="font-mono text-[11px] uppercase tracking-[0.22em] text-valid-700">
        Read-only conversation
      </p>
      <h1 class="mt-1 text-2xl font-semibold tracking-tight text-zinc-950">
        {{ conversation.title ?? "未命名对话" }}
      </h1>
      <p class="mt-2 font-mono text-xs text-zinc-500">
        {{ formatDateTime(conversation.started_at) }}
      </p>
    </header>

    <ol class="space-y-4">
      <li
        v-for="message in conversation.messages"
        :key="message.id"
        class="rounded-2xl border p-5"
        :class="
          message.speaker === 'assistant'
            ? 'ml-8 border-valid-100 bg-valid-50/50'
            : 'mr-8 border-zinc-200 bg-white'
        "
      >
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            {{ speakerLabels[message.speaker] ?? message.speaker }}
          </span>
          <time class="font-mono text-[11px] text-zinc-500">{{
            formatDateTime(message.msg_time)
          }}</time>
        </div>
        <p class="mt-3 whitespace-pre-wrap text-sm leading-6 text-zinc-900">
          {{ message.raw_text }}
        </p>
        <div
          v-if="message.memories?.length"
          class="mt-4 space-y-2 border-t border-zinc-200/70 pt-3"
        >
          <p class="text-[11px] font-semibold uppercase tracking-wide text-record-700">引用记忆</p>
          <RouterLink
            v-for="memory in message.memories"
            :key="memory.belief_version_id"
            :to="`/memories/${memory.belief_id}`"
            class="block rounded-lg border border-record-100 bg-white px-3 py-2 text-sm hover:border-record-300"
          >
            <span class="font-medium text-zinc-900">
              {{ memory.subject }} / {{ memory.attribute }}
            </span>
            <span class="ml-2 text-zinc-600">= {{ formatValue(memory.value) }}</span>
          </RouterLink>
        </div>
      </li>
    </ol>
  </article>
</template>

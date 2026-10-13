<script setup lang="ts">
import { computed } from "vue";
import type { ApiClient } from "@mnemic/shared";
import { useRoute } from "vue-router";
import ConversationDetail from "../conversations/ConversationDetail.vue";
import ConversationList from "../conversations/ConversationList.vue";

const props = defineProps<{
  projectId: string;
  api: ApiClient;
}>();

const route = useRoute();
const conversationId = computed(() =>
  typeof route.params.conversationId === "string" ? route.params.conversationId : null,
);
</script>

<template>
  <ConversationDetail
    v-if="conversationId"
    :key="conversationId"
    :project-id="props.projectId"
    :conversation-id="conversationId"
    :api="props.api"
  />
  <ConversationList v-else :project-id="props.projectId" :api="props.api" />
</template>

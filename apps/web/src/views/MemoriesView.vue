<script setup lang="ts">
import { computed } from "vue";
import type { ApiClient } from "@mnemic/shared";
import { useRoute, useRouter } from "vue-router";
import MemoryDetail from "../memories/MemoryDetail.vue";
import MemoryList from "../memories/MemoryList.vue";

const props = defineProps<{
  projectId: string;
  api: ApiClient;
}>();

const route = useRoute();
const router = useRouter();
const beliefId = computed(() =>
  typeof route.params.beliefId === "string" ? route.params.beliefId : null,
);
</script>

<template>
  <MemoryDetail
    v-if="beliefId"
    :key="beliefId"
    :project-id="props.projectId"
    :belief-id="beliefId"
    :api="props.api"
    @corrected="router.push('/memories')"
  />
  <MemoryList v-else :project-id="props.projectId" :api="props.api" />
</template>

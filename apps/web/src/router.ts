import { createRouter, createWebHistory } from "vue-router";
import MemoriesView from "./views/MemoriesView.vue";
import ConversationsView from "./views/ConversationsView.vue";

/** Web 记忆中心路由：列表/详情均由项目 gate 提供 projectId。 */
export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/memories" },
    { path: "/memories", name: "memories", component: MemoriesView },
    { path: "/memories/:beliefId", name: "memory-detail", component: MemoriesView },
    { path: "/conversations", name: "conversations", component: ConversationsView },
    {
      path: "/conversations/:conversationId",
      name: "conversation-detail",
      component: ConversationsView,
    },
  ],
});

import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type {
  ApiClient,
  ConversationDetail as ConversationDetailData,
  ConversationListItem,
} from "@mnemic/shared";
import ConversationDetailView from "../src/conversations/ConversationDetail.vue";
import ConversationListView from "../src/conversations/ConversationList.vue";

const projectId = "0192af7d-b792-7a41-90f8-9f0b2d6c6d8a";
const conversationId = "0192af91-0000-7000-8000-000000000200";

const listItem: ConversationListItem = {
  id: conversationId,
  title: "db 讨论",
  started_at: "2026-09-24T09:00:00Z",
  ended_at: "2026-09-24T09:02:00Z",
  message_count: 4,
};

const detail: ConversationDetailData = {
  id: conversationId,
  project_id: projectId,
  title: "db 讨论",
  started_at: "2026-09-24T09:00:00Z",
  ended_at: "2026-09-24T09:02:00Z",
  messages: [
    {
      id: "message-1",
      speaker: "user",
      raw_text: "数据库用什么？",
      msg_time: "2026-09-24T09:00:00Z",
      memories: null,
    },
    {
      id: "message-2",
      speaker: "assistant",
      raw_text: "用 PostgreSQL。",
      msg_time: "2026-09-24T09:00:05Z",
      memories: [
        {
          belief_version_id: "version-1",
          belief_id: "belief-1",
          subject: "my-project",
          attribute: "database",
          value: "PostgreSQL",
        },
      ],
    },
  ],
};

const routerStub = {
  stubs: {
    RouterLink: { props: ["to"], template: '<a :href="String(to)"><slot /></a>' },
  },
};

describe("ConversationList", () => {
  it("paginates forward and backward without hiding conversations beyond the first 50", async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({ ...listItem, id: `conversation-${i}` }));
    const listConversations = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([{ ...listItem, title: "page two" }])
      .mockResolvedValueOnce(page);
    const wrapper = mount(ConversationListView, {
      props: { projectId, api: { listConversations } as unknown as ApiClient },
      global: routerStub,
    });
    await flushPromises();
    expect(wrapper.get("button[aria-label='上一页']").attributes("disabled")).toBeDefined();

    await wrapper.get("button[aria-label='下一页']").trigger("click");
    await flushPromises();
    expect(listConversations).toHaveBeenLastCalledWith(projectId, { limit: 50, offset: 50 });
    expect(wrapper.text()).toContain("page two");
    expect(wrapper.get("button[aria-label='下一页']").attributes("disabled")).toBeDefined();

    await wrapper.get("button[aria-label='上一页']").trigger("click");
    await flushPromises();
    expect(listConversations).toHaveBeenLastCalledWith(projectId, { limit: 50, offset: 0 });
    expect(wrapper.text()).toContain("db 讨论");
  });

  it("shows an error when fetching a later conversation page fails", async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({ ...listItem, id: `conversation-${i}` }));
    const listConversations = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockRejectedValueOnce(new Error("page unavailable"));
    const wrapper = mount(ConversationListView, {
      props: { projectId, api: { listConversations } as unknown as ApiClient },
      global: routerStub,
    });
    await flushPromises();
    await wrapper.get("button[aria-label='下一页']").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("page unavailable");
    expect(wrapper.text()).not.toContain("db 讨论");
  });

  it("loads conversations and shows the read-only timeline metadata", async () => {
    const listConversations = vi.fn().mockResolvedValue([listItem]);
    const wrapper = mount(ConversationListView, {
      props: { projectId, api: { listConversations } as unknown as ApiClient },
      global: routerStub,
    });
    await flushPromises();

    expect(listConversations).toHaveBeenCalledWith(projectId, { limit: 50, offset: 0 });
    expect(wrapper.text()).toContain("db 讨论");
    expect(wrapper.text()).toContain("4 条消息");
    expect(wrapper.find(`a[href='/conversations/${conversationId}']`).exists()).toBe(true);
  });

  it("shows an empty state with direction", async () => {
    const listConversations = vi.fn().mockResolvedValue([]);
    const wrapper = mount(ConversationListView, {
      props: { projectId, api: { listConversations } as unknown as ApiClient },
      global: routerStub,
    });
    await flushPromises();

    expect(wrapper.text()).toContain("暂无对话");
    const hint = wrapper.findAll("p").find((p) => p.text().includes("通过 CLI 产生对话后"));
    expect(hint?.classes()).toContain("text-zinc-500");
  });
});

describe("ConversationDetail", () => {
  it("labels tool output separately from user messages", async () => {
    const getConversation = vi.fn().mockResolvedValue({
      ...detail,
      messages: [
        {
          id: "tool-result",
          speaker: "tool",
          raw_text: "查询结果",
          msg_time: "2026-09-24T09:00:03Z",
          memories: null,
        },
      ],
    });
    const wrapper = mount(ConversationDetailView, {
      props: { projectId, conversationId, api: { getConversation } as unknown as ApiClient },
      global: routerStub,
    });
    await flushPromises();
    expect(wrapper.get("li span").text()).toBe("工具");
  });

  it("renders messages in order and links cited memories to belief detail", async () => {
    const getConversation = vi.fn().mockResolvedValue(detail);
    const wrapper = mount(ConversationDetailView, {
      props: { projectId, conversationId, api: { getConversation } as unknown as ApiClient },
      global: routerStub,
    });
    await flushPromises();

    expect(getConversation).toHaveBeenCalledWith(projectId, conversationId);
    expect(wrapper.text()).toContain("db 讨论");
    expect(wrapper.text()).toContain("数据库用什么？");
    expect(wrapper.text()).toContain("用 PostgreSQL。");
    expect(wrapper.text()).toContain("my-project / database");
    expect(wrapper.find("a[href='/memories/belief-1']").exists()).toBe(true);
  });

  it("renders messages without cited memories cleanly", async () => {
    const getConversation = vi.fn().mockResolvedValue({
      ...detail,
      messages: [
        {
          id: "message-3",
          speaker: "assistant",
          raw_text: "没有引用。",
          msg_time: "2026-09-24T09:01:00Z",
          memories: [],
        },
      ],
    });
    const wrapper = mount(ConversationDetailView, {
      props: { projectId, conversationId, api: { getConversation } as unknown as ApiClient },
      global: routerStub,
    });
    await flushPromises();

    expect(wrapper.text()).toContain("没有引用。");
    expect(wrapper.text()).not.toContain("引用记忆");
  });
});

import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, BeliefDetail, ConversationDetail } from "@mnemic/shared";
import ConversationsView from "../src/views/ConversationsView.vue";
import MemoriesView from "../src/views/MemoriesView.vue";
import { router } from "../src/router.js";

const projectId = "0192aaaa-0000-7000-8000-000000000001";
const beliefId = "0192aaaa-0000-7000-8000-000000000040";
const conversationId = "0192aaaa-0000-7000-8000-000000000010";

const beliefDetail: BeliefDetail = {
  id: beliefId,
  project_id: projectId,
  subject: "web-smoke",
  attribute: "database",
  status: "active",
  is_profile: false,
  confidence: 0.9,
  salience: 0.7,
  importance: 0.9,
  evidence_count: 2,
  created_at: "2026-09-24T09:00:00Z",
  current_value: "PostgreSQL",
  versions: [],
};

const conversationDetail: ConversationDetail = {
  id: conversationId,
  project_id: projectId,
  title: "数据库选型",
  started_at: "2026-09-24T09:00:00Z",
  ended_at: null,
  messages: [],
};

describe("route parameter views", () => {
  beforeEach(async () => {
    await router.push("/memories");
    await router.isReady();
  });

  it("switches from memory list to detail without remounting the view", async () => {
    const api = {
      listBeliefs: vi.fn().mockResolvedValue([]),
      getBelief: vi.fn().mockResolvedValue(beliefDetail),
      listResolutions: vi.fn().mockResolvedValue([]),
    } as unknown as ApiClient;
    const wrapper = mount(MemoriesView, {
      props: { projectId, api },
      global: { plugins: [router] },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("Belief ledger");

    await router.push(`/memories/${beliefId}`);
    await flushPromises();

    expect(api.getBelief).toHaveBeenCalledWith(projectId, beliefId);
    expect(wrapper.text()).toContain("当前值");
  });

  it("switches from conversation list to detail without remounting the view", async () => {
    const api = {
      listConversations: vi.fn().mockResolvedValue([]),
      getConversation: vi.fn().mockResolvedValue(conversationDetail),
    } as unknown as ApiClient;
    await router.push("/conversations");
    const wrapper = mount(ConversationsView, {
      props: { projectId, api },
      global: { plugins: [router] },
    });
    await flushPromises();
    expect(wrapper.text()).toContain("Conversation archive");

    await router.push(`/conversations/${conversationId}`);
    await flushPromises();

    expect(api.getConversation).toHaveBeenCalledWith(projectId, conversationId);
    expect(wrapper.text()).toContain("数据库选型");
  });

  it("reloads memory detail when the belief id changes while the view stays mounted", async () => {
    const otherId = "0192aaaa-0000-7000-8000-000000000041";
    const api = {
      listBeliefs: vi.fn().mockResolvedValue([]),
      getBelief: vi
        .fn()
        .mockResolvedValueOnce(beliefDetail)
        .mockResolvedValueOnce({ ...beliefDetail, id: otherId, subject: "other-subject" }),
      listResolutions: vi.fn().mockResolvedValue([]),
    } as unknown as ApiClient;
    await router.push(`/memories/${beliefId}`);
    const wrapper = mount(MemoriesView, {
      props: { projectId, api },
      global: { plugins: [router] },
    });
    await flushPromises();

    await router.push(`/memories/${otherId}`);
    await flushPromises();

    expect(api.getBelief).toHaveBeenLastCalledWith(projectId, otherId);
    expect(wrapper.text()).toContain("other-subject");
  });

  it("reloads conversation detail when the conversation id changes while the view stays mounted", async () => {
    const otherId = "0192aaaa-0000-7000-8000-000000000011";
    const api = {
      listConversations: vi.fn().mockResolvedValue([]),
      getConversation: vi
        .fn()
        .mockResolvedValueOnce(conversationDetail)
        .mockResolvedValueOnce({ ...conversationDetail, id: otherId, title: "另一个对话" }),
    } as unknown as ApiClient;
    await router.push(`/conversations/${conversationId}`);
    const wrapper = mount(ConversationsView, {
      props: { projectId, api },
      global: { plugins: [router] },
    });
    await flushPromises();

    await router.push(`/conversations/${otherId}`);
    await flushPromises();

    expect(api.getConversation).toHaveBeenLastCalledWith(projectId, otherId);
    expect(wrapper.text()).toContain("另一个对话");
  });
});

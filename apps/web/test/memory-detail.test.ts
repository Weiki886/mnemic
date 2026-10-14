import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, BeliefDetail, ResolutionTrace } from "@mnemic/shared";
import { ApiError } from "@mnemic/shared";
import MemoryDetail from "../src/memories/MemoryDetail.vue";

const projectId = "0192af7d-b792-7a41-90f8-9f0b2d6c6d8a";
const beliefId = "0192af90-0000-7000-8000-000000000100";
const conversationId = "0192af91-0000-7000-8000-000000000200";

const detail: BeliefDetail = {
  id: beliefId,
  project_id: projectId,
  subject: "my-project",
  attribute: "database",
  status: "active",
  is_profile: false,
  confidence: 0.9,
  salience: 0.6,
  importance: 0.8,
  evidence_count: 2,
  created_at: "2026-09-01T08:00:00Z",
  current_value: "PostgreSQL",
  versions: [
    {
      id: "0192af92-0000-7000-8000-000000000301",
      value: "MySQL",
      valid_from: "2026-09-01",
      valid_to: "2026-09-10",
      recorded_from: "2026-09-01T08:00:00Z",
      recorded_to: "2026-09-10T08:00:00Z",
      supersedes_version_id: null,
      confidence: 0.7,
      resolver_version: null,
      source: {
        observation_id: "0192af93-0000-7000-8000-000000000401",
        message_id: "0192af94-0000-7000-8000-000000000501",
        conversation_id: conversationId,
      },
    },
    {
      id: "0192af92-0000-7000-8000-000000000302",
      value: "PostgreSQL",
      valid_from: "2026-09-10",
      valid_to: null,
      recorded_from: "2026-09-10T08:00:00Z",
      recorded_to: null,
      supersedes_version_id: "0192af92-0000-7000-8000-000000000301",
      confidence: 0.9,
      resolver_version: "resolver-a0",
      source: {
        observation_id: "0192af93-0000-7000-8000-000000000402",
        message_id: "0192af94-0000-7000-8000-000000000502",
        conversation_id: conversationId,
      },
    },
  ],
};

const trace: ResolutionTrace = {
  id: "0192af95-0000-7000-8000-000000000600",
  projectId,
  beliefId,
  observationId: "0192af93-0000-7000-8000-000000000402",
  previousVersionId: "0192af92-0000-7000-8000-000000000301",
  resultVersionId: "0192af92-0000-7000-8000-000000000302",
  relation: "supersede",
  confidenceBefore: 0.7,
  confidenceAfter: 0.9,
  policies: { authority: true, conflict: true },
  modelSnapshot: null,
  resolverVersion: "resolver-a0",
  createdAt: "2026-09-10T08:00:00Z",
};

function mountDetail(api: Pick<ApiClient, "getBelief" | "listResolutions" | "correctBelief">) {
  return mount(MemoryDetail, {
    props: { projectId, beliefId, api: api as ApiClient },
    global: {
      stubs: {
        RouterLink: { props: ["to"], template: '<a :href="String(to)"><slot /></a>' },
      },
    },
  });
}

describe("MemoryDetail", () => {
  it("shows a rejected correction's 409 detail without navigating or losing the input", async () => {
    const getBelief = vi.fn().mockResolvedValue(detail);
    const message = "已删除的记忆必须先恢复，再进行修正";
    const correctBelief = vi.fn().mockRejectedValue(new ApiError(409, "CONFLICT", message));
    const wrapper = mountDetail({
      getBelief,
      listResolutions: vi.fn().mockResolvedValue([]),
      correctBelief,
    });
    await flushPromises();

    const input = wrapper.get("input[aria-label='人工修正后的新值']");
    await input.setValue("CockroachDB");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(correctBelief).toHaveBeenCalledWith(projectId, beliefId, "CockroachDB");
    expect(wrapper.get("form p.text-red-700").text()).toBe(message);
    expect(wrapper.text()).toContain("PostgreSQL");
    expect(wrapper.emitted("corrected")).toBeUndefined();
    expect(getBelief).toHaveBeenCalledTimes(1);
    expect((input.element as HTMLInputElement).value).toBe("CockroachDB");
    expect(wrapper.get("button[type='submit']").attributes("disabled")).toBeUndefined();
    expect(wrapper.get("button[type='submit']").text()).toBe("保存修正");
  });

  it("requires restoring a deleted memory before offering a correction", async () => {
    const correctBelief = vi.fn();
    const wrapper = mountDetail({
      getBelief: vi.fn().mockResolvedValue({ ...detail, status: "deleted" }),
      listResolutions: vi.fn().mockResolvedValue([]),
      correctBelief,
    });
    await flushPromises();

    expect(wrapper.find("form").exists()).toBe(false);
    expect(wrapper.find("input[aria-label='人工修正后的新值']").exists()).toBe(false);
    expect(wrapper.text()).toContain("请先在记忆列表恢复，再进行修正");
    expect(correctBelief).not.toHaveBeenCalled();
  });

  it.each(["deleted", "retracted"])("uses a neutral badge for %s memories", async (status) => {
    const wrapper = mountDetail({
      getBelief: vi.fn().mockResolvedValue({ ...detail, status }),
      listResolutions: vi.fn().mockResolvedValue([]),
      correctBelief: vi.fn(),
    });
    await flushPromises();

    const badge = wrapper.get("header span");
    expect(badge.classes()).toContain("bg-zinc-100");
    expect(badge.classes()).not.toContain("bg-valid-50");
  });

  it("keeps correction available for retracted memories", async () => {
    const wrapper = mountDetail({
      getBelief: vi.fn().mockResolvedValue({ ...detail, status: "retracted" }),
      listResolutions: vi.fn().mockResolvedValue([]),
      correctBelief: vi.fn(),
    });
    await flushPromises();

    expect(wrapper.find("input[aria-label='人工修正后的新值']").exists()).toBe(true);
  });

  it("renders current value, dual-time version history, source link, and resolution trace", async () => {
    const getBelief = vi.fn().mockResolvedValue(detail);
    const listResolutions = vi.fn().mockResolvedValue([trace]);
    const wrapper = mountDetail({ getBelief, listResolutions, correctBelief: vi.fn() });
    await flushPromises();

    expect(getBelief).toHaveBeenCalledWith(projectId, beliefId);
    expect(listResolutions).toHaveBeenCalledWith(projectId, beliefId);
    expect(wrapper.text()).toContain("PostgreSQL");
    expect(wrapper.text()).toContain("MySQL");
    expect(wrapper.text()).toContain("事实时间");
    expect(wrapper.text()).toContain("记录时间");
    expect(wrapper.text()).toContain("消解历史");
    expect(wrapper.text()).toContain("取代");
    expect(wrapper.text()).toContain("70% → 90%");
    expect(wrapper.find(`a[href='/conversations/${conversationId}']`).exists()).toBe(true);
  });

  it("submits a manual correction, reloads the detail, and signals navigation back to the list", async () => {
    const corrected = {
      ...detail,
      current_value: "CockroachDB",
      confidence: 1,
    };
    const getBelief = vi.fn().mockResolvedValueOnce(detail).mockResolvedValueOnce(corrected);
    const listResolutions = vi
      .fn()
      .mockResolvedValueOnce([trace])
      .mockResolvedValueOnce([trace, { ...trace, id: "new-trace", relation: "supersede" }]);
    const correctBelief = vi
      .fn()
      .mockResolvedValue({ beliefId, route: "updated", relation: "supersede" });
    const wrapper = mountDetail({ getBelief, listResolutions, correctBelief });
    await flushPromises();

    await wrapper.find("input[aria-label='人工修正后的新值']").setValue("CockroachDB");
    await wrapper.find("button[type='submit']").trigger("submit");
    await flushPromises();

    expect(correctBelief).toHaveBeenCalledWith(projectId, beliefId, "CockroachDB");
    expect(wrapper.emitted("corrected")?.[0]).toEqual([expect.objectContaining({ beliefId })]);
    expect(wrapper.text()).toContain("CockroachDB");
  });

  it("does not submit an empty correction", async () => {
    const getBelief = vi.fn().mockResolvedValue(detail);
    const listResolutions = vi.fn().mockResolvedValue([]);
    const correctBelief = vi.fn();
    const wrapper = mountDetail({ getBelief, listResolutions, correctBelief });
    await flushPromises();

    expect(wrapper.find("button[type='submit']").attributes("disabled")).toBeDefined();
    await wrapper.find("form").trigger("submit.prevent");
    expect(correctBelief).not.toHaveBeenCalled();
  });
});

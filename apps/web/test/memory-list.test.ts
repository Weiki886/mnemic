import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, BeliefListItem } from "@mnemic/shared";
import MemoryList from "../src/memories/MemoryList.vue";

const projectId = "0192af7d-b792-7a41-90f8-9f0b2d6c6d8a";

const row = (overrides: Partial<BeliefListItem> = {}): BeliefListItem => ({
  id: "0192af90-0000-7000-8000-000000000001",
  subject: "my-project",
  attribute: "database",
  status: "active",
  is_profile: false,
  confidence: 0.9,
  salience: 0.6,
  importance: 0.8,
  evidence_count: 2,
  created_at: "2026-09-24T09:00:00Z",
  current_value: "PostgreSQL",
  ...overrides,
});

function mountList(api: Pick<ApiClient, "listBeliefs" | "deleteBelief" | "restoreBelief">) {
  return mount(MemoryList, {
    props: { projectId, api: api as ApiClient },
    global: {
      stubs: {
        RouterLink: { props: ["to"], template: '<a :href="String(to)"><slot /></a>' },
      },
    },
  });
}

describe("MemoryList", () => {
  it.each(["success", "failure"])(
    "ignores stale request %s after a newer search completes",
    async (outcome) => {
      let resolveOld!: (rows: BeliefListItem[]) => void;
      let rejectOld!: (error: Error) => void;
      const oldRequest = new Promise<BeliefListItem[]>((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      });
      const listBeliefs = vi
        .fn()
        .mockReturnValueOnce(oldRequest)
        .mockResolvedValueOnce([row({ current_value: "Newest result" })]);
      const wrapper = mountList({ listBeliefs, deleteBelief: vi.fn(), restoreBelief: vi.fn() });

      await wrapper.get("input[aria-label='搜索主体或属性']").setValue("new");
      await wrapper.get("form").trigger("submit");
      await flushPromises();
      expect(wrapper.text()).toContain("Newest result");

      if (outcome === "success") resolveOld([row({ current_value: "Stale result" })]);
      else rejectOld(new Error("stale error"));
      await flushPromises();

      expect(wrapper.text()).toContain("Newest result");
      expect(wrapper.text()).not.toContain("Stale result");
      expect(wrapper.text()).not.toContain("stale error");
    },
  );

  it("keeps loading until the latest search completes", async () => {
    let resolveOld!: (rows: BeliefListItem[]) => void;
    let resolveNew!: (rows: BeliefListItem[]) => void;
    const oldRequest = new Promise<BeliefListItem[]>((resolve) => {
      resolveOld = resolve;
    });
    const newRequest = new Promise<BeliefListItem[]>((resolve) => {
      resolveNew = resolve;
    });
    const listBeliefs = vi.fn().mockReturnValueOnce(oldRequest).mockReturnValueOnce(newRequest);
    const wrapper = mountList({ listBeliefs, deleteBelief: vi.fn(), restoreBelief: vi.fn() });
    await wrapper.get("form").trigger("submit");

    resolveOld([row()]);
    await flushPromises();
    expect(wrapper.text()).toContain("正在读取记忆");

    resolveNew([row({ current_value: "Newest result" })]);
    await flushPromises();
    expect(wrapper.text()).toContain("Newest result");
    expect(wrapper.text()).not.toContain("正在读取记忆");
  });

  it("loads active memories and renders their current value and confidence", async () => {
    const listBeliefs = vi.fn().mockResolvedValue([row()]);
    const wrapper = mountList({ listBeliefs, deleteBelief: vi.fn(), restoreBelief: vi.fn() });
    await flushPromises();

    expect(listBeliefs).toHaveBeenCalledWith(projectId, {
      status: "active",
      limit: 50,
      offset: 0,
    });
    expect(wrapper.text()).toContain("my-project");
    expect(wrapper.text()).toContain("database");
    expect(wrapper.text()).toContain("PostgreSQL");
    expect(wrapper.text()).toContain("90%");
  });

  it("searches with status and profile filters", async () => {
    const listBeliefs = vi.fn().mockResolvedValue([]);
    const wrapper = mountList({ listBeliefs, deleteBelief: vi.fn(), restoreBelief: vi.fn() });
    await flushPromises();

    await wrapper.find("select[aria-label='状态']").setValue("deleted");
    await wrapper.find("input[aria-label='只看项目画像']").setValue(true);
    await wrapper.find("input[aria-label='搜索主体或属性']").setValue("database");
    await wrapper.find("button[type='submit']").trigger("submit");
    await flushPromises();

    expect(listBeliefs).toHaveBeenLastCalledWith(projectId, {
      status: "deleted",
      profile: "true",
      q: "database",
      limit: 50,
      offset: 0,
    });
  });

  it("soft deletes an active memory and reloads the list", async () => {
    const listBeliefs = vi.fn().mockResolvedValueOnce([row()]).mockResolvedValueOnce([]);
    const deleteBelief = vi.fn().mockResolvedValue({ id: row().id, status: "deleted" });
    const wrapper = mountList({ listBeliefs, deleteBelief, restoreBelief: vi.fn() });
    await flushPromises();

    await wrapper.find("button[aria-label='删除记忆 my-project / database']").trigger("click");
    await flushPromises();

    expect(deleteBelief).toHaveBeenCalledWith(projectId, row().id);
    expect(listBeliefs).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain("暂无记忆");
  });

  it("restores a deleted memory and reloads the list", async () => {
    const deleted = row({ id: "0192af90-0000-7000-8000-000000000002", status: "deleted" });
    const listBeliefs = vi
      .fn()
      .mockResolvedValueOnce([deleted])
      .mockResolvedValueOnce([{ ...deleted, status: "active" }]);
    const restoreBelief = vi.fn().mockResolvedValue({ id: deleted.id, status: "active" });
    const wrapper = mountList({ listBeliefs, deleteBelief: vi.fn(), restoreBelief });
    await flushPromises();

    await wrapper.find("button[aria-label='恢复记忆 my-project / database']").trigger("click");
    await flushPromises();

    expect(restoreBelief).toHaveBeenCalledWith(projectId, deleted.id);
    expect(wrapper.text()).toContain("生效中");
  });

  it("paginates with offset and resets offset when filters change", async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      row({ id: `0192af90-0000-7000-8000-000000000${String(i).padStart(2, "0")}` }),
    );
    const next = row({ id: "0192af90-0000-7000-8000-000000000099" });
    const listBeliefs = vi
      .fn()
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([next])
      .mockResolvedValueOnce([]);
    const wrapper = mountList({ listBeliefs, deleteBelief: vi.fn(), restoreBelief: vi.fn() });
    await flushPromises();

    await wrapper.find("button[aria-label='下一页']").trigger("click");
    await flushPromises();
    expect(listBeliefs).toHaveBeenLastCalledWith(projectId, {
      status: "active",
      limit: 50,
      offset: 50,
    });

    await wrapper.find("input[aria-label='搜索主体或属性']").setValue("postgres");
    await wrapper.find("button[type='submit']").trigger("submit");
    await flushPromises();
    expect(listBeliefs).toHaveBeenLastCalledWith(projectId, {
      status: "active",
      q: "postgres",
      limit: 50,
      offset: 0,
    });
  });

  it("shows a useful empty state", async () => {
    const listBeliefs = vi.fn().mockResolvedValue([]);
    const wrapper = mountList({ listBeliefs, deleteBelief: vi.fn(), restoreBelief: vi.fn() });
    await flushPromises();

    expect(wrapper.text()).toContain("暂无记忆");
  });

  it("shows API errors without losing the filter form", async () => {
    const listBeliefs = vi.fn().mockRejectedValue(new Error("network offline"));
    const wrapper = mountList({ listBeliefs, deleteBelief: vi.fn(), restoreBelief: vi.fn() });
    await flushPromises();

    expect(wrapper.text()).toContain("记忆加载失败");
    expect(wrapper.find("input[aria-label='搜索主体或属性']").exists()).toBe(true);
  });
});

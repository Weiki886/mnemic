/**
 * 对话闭环的后台任务注册表（#7）：提取写记忆为进程内异步（A1 #21 队列化后替换）。
 * 任务必须自捕获异常（只落日志，绝不未捕获拒绝）；测试经 waitForChatJobs 等待排空。
 */

const pending = new Set<Promise<void>>();

export function trackJob(job: () => Promise<void>, onError: (err: unknown) => void): void {
  const p = job()
    .catch((err) => onError(err))
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** 等待当前及等待期间新登记的任务全部 settle（测试用） */
export async function waitForChatJobs(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
}

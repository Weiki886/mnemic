import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-vue 基础工具：条件类名合并 + tailwind 冲突消解 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

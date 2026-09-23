import { parse } from "yaml";

/**
 * 轻量规范化（Proposal 能力清单 1.5）：subject/attribute 在召回比对前做
 * 小写化、空白归一、别名映射。A0 存储 = 代码内置 YAML 静态映射（不入库）。
 */
const ALIASES_YAML = `
postgres: postgresql
pgsql: postgresql
node: nodejs
k8s: kubernetes
ts: typescript
js: javascript
py: python
mongo: mongodb
`;

const ALIASES: Record<string, string> = parse(ALIASES_YAML);

export function normalizeTerm(input: string): string {
  const normalized = input.trim().replace(/\s+/g, " ").toLowerCase();
  return ALIASES[normalized] ?? normalized;
}

export { ALIASES };

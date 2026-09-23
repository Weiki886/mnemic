/**
 * Secret/敏感信息检测（#15）：命中模式整体替换为 [REDACTED]。
 * A0 只做 Secret 检测，不承诺完整 PII（手机号/身份证等归后续）。
 * 铁律：命中记录与审计 meta 只含模式名，绝不含密钥本体。
 */

export const REDACTED = "[REDACTED]";

export interface SecretHit {
  pattern: string;
}

interface SecretPattern {
  name: string;
  regex: RegExp;
}

const PATTERNS: SecretPattern[] = [
  {
    name: "github_pat",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|github_pat_[A-Za-z0-9_]{20,}/g,
  },
  { name: "aws_access_key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "openai_style_key", regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  {
    name: "password_assignment",
    regex: /\b(?:password|passwd|pwd)\s*[:=]\s*[^\s,;，；]{4,}/gi,
  },
  {
    name: "private_key_block",
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

export interface SanitizeResult {
  text: string;
  hits: SecretHit[];
}

export function sanitizeText(input: string): SanitizeResult {
  let text = input;
  const hits: SecretHit[] = [];
  for (const { name, regex } of PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text)) {
      hits.push({ pattern: name });
      regex.lastIndex = 0;
      text = text.replace(regex, REDACTED);
    }
  }
  return { text, hits };
}

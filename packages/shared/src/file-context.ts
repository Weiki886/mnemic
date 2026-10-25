import { z } from "zod";

const utf8 = (text: string) => new TextEncoder().encode(text);
const privateNames = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  "node_modules",
  "dist",
  "coverage",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
/** Common sensitive/generated names only; not complete secret detection or a gitignore engine. */
export function isBlockedProjectPath(path: string): boolean {
  return path.split("/").some((part) => {
    const name = part.toLowerCase();
    return (
      privateNames.has(name) ||
      name === ".env" ||
      name.startsWith(".env.") ||
      /\.(pem|key|p12|pfx)$/i.test(name)
    );
  });
}
/** Canonical relative paths only. This validates client declarations, never reads server paths. */
const Path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !/[\p{Cc}\u202a-\u202e\u2066-\u2069\\]/u.test(path) &&
      !path.startsWith("/") &&
      !path.startsWith("~") &&
      !/^[a-z]:/i.test(path) &&
      !isBlockedProjectPath(path) &&
      (path === "." ||
        path.split("/").every((part) => part !== "" && part !== "." && part !== "..")),
    "非法项目相对路径",
  );
const fields = {
  kind: z.enum(["file", "directory"]),
  path: Path,
  truncated: z.boolean(),
};
const validKind = (value: { kind: string; path: string }) =>
  value.path !== "." || value.kind === "directory";
export const ProjectAttachmentSchema = z
  .object({
    ...fields,
    content: z
      .string()
      .max(16_384)
      .refine(
        (text) => utf8(text).length <= 16_384 && new TextDecoder().decode(utf8(text)) === text,
        "文件须为合法 Unicode 且不超过 16 KiB",
      ),
  })
  .strict()
  .refine(validKind, "根路径只能表示目录");
export const FileEvidenceMetadataSchema = z
  .object({
    ...fields,
    version: z.literal(1),
    parent_message_id: z.string().uuid().toLowerCase(),
    source_type: z.literal("PROJECT_FILE"),
  })
  .strict()
  .refine(validKind, "根路径只能表示目录");
export const ChatMessageInputSchema = z
  .object({
    text: z.string().min(1).max(8000),
    attachments: z.array(ProjectAttachmentSchema).max(16).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const files = value.attachments ?? [];
    if (
      files.filter((f) => f.kind === "file").length > 8 ||
      files.filter((f) => f.kind === "directory").length > 8 ||
      files.reduce((n, file) => n + utf8(file.content).length, 0) > 65_536 ||
      new Set(files.map((file) => file.path)).size !== files.length
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attachments"],
        message: "附件数量、总字节数或路径重复不合法",
      });
  });
export type ProjectAttachment = z.infer<typeof ProjectAttachmentSchema>;
export type FileEvidenceMetadata = z.infer<typeof FileEvidenceMetadataSchema>;

/** A data boundary, not protection against model prompt injection. */
export function renderFileEvidence(
  files: readonly (FileEvidenceMetadata & { content: string })[],
): string {
  if (!files.length) return "";
  const payload = JSON.stringify({ files }).replace(
    /[<>\u202a-\u202e\u2066-\u2069]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `<mnemic-file-context>\n${payload}\n</mnemic-file-context>`;
}

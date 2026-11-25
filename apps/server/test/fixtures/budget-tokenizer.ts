import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Minimal offline WordPiece vocabulary with a prefix template. */
export function writeBudgetTokenizerFixture(dir: string) {
  const tokenizerFile = join(dir, "tokenizer.json");
  const tokenizerConfigFile = join(dir, "tokenizer_config.json");
  writeFileSync(
    tokenizerFile,
    JSON.stringify({
      model: {
        type: "WordPiece",
        unk_token: "[UNK]",
        continuing_subword_prefix: "##",
        max_input_chars_per_word: 100,
        vocab: { "[UNK]": 0, "[CLS]": 1, hello: 2, 中: 3, "##文": 4 },
      },
      added_tokens: [],
      normalizer: null,
      pre_tokenizer: { type: "WhitespaceSplit" },
      decoder: null,
      post_processor: {
        type: "TemplateProcessing",
        single: [
          { SpecialToken: { id: "[CLS]", type_id: 0 } },
          { Sequence: { id: "A", type_id: 0 } },
        ],
        pair: [],
        special_tokens: { "[CLS]": { id: "[CLS]", ids: [1], tokens: ["[CLS]"] } },
      },
    }),
  );
  writeFileSync(tokenizerConfigFile, "{}");
  return { tokenizerFile, tokenizerConfigFile };
}

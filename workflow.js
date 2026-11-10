// workflow.js — one round: generate -> in-memory exact dedup -> review
// Read by the main agent and passed as the workflow tool's `script`;
// the main agent passes `meta` separately (see AGENTS.md).
//
// args = {
//   words:            [{ word, pos, sense }], // pending words for this round
//   history:          [string],           // full history of non-duplicate sentences
//   generatorPrompt:  string,             // prompts/generator.md text (rules + output contract, no word list)
//   reviewerPrompt:   string              // prompts/reviewer.md text (rules + output contract, no candidates)
// }

const GEN_SCHEMA = {
  type: "object",
  properties: {
    sentences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: { type: "string" },
          sentence: { type: "string" }
        },
        required: ["word", "sentence"],
        additionalProperties: false
      }
    }
  },
  required: ["sentences"],
  additionalProperties: false
};

const REV_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sentence: { type: "string" },
          decision: { type: "string", enum: ["pass", "reject"] },
          reason: { type: "string" }
        },
        required: ["sentence", "decision", "reason"],
        additionalProperties: false
      }
    }
  },
  required: ["verdicts"],
  additionalProperties: false
};

const words = Array.isArray(args.words) ? args.words : [];
const wordInfo = new Map(
  words.map((w) => [
    String(w.word),
    { pos: String(w.pos || "").trim(), sense: String(w.sense || "").trim() }
  ])
);
const validWords = new Set(wordInfo.keys());
const seen = new Set((Array.isArray(args.history) ? args.history : []).map((s) => String(s).trim()));

// 1. generate
const genInput = [
  args.generatorPrompt,
  "",
  "Target words (word | part of speech | sense)",
  ...words.map((w) => {
    const info = wordInfo.get(String(w.word)) || { pos: "", sense: "" };
    return [w.word, info.pos, info.sense].join(" | ");
  })
].join("\n");

const gen = await agent(genInput, { schema: GEN_SCHEMA, label: "generator" });
if (!gen || !Array.isArray(gen.sentences)) {
  return { ok: false, error: "generator_failed", fresh: [], verdicts: [] };
}

// 2. in-memory exact dedup (against full history + within-batch)
const fresh = [];
for (const it of gen.sentences) {
  const word = String(it && it.word);
  const sentence = String(it && it.sentence).trim();
  if (!validWords.has(word) || sentence === "") continue;
  if (seen.has(sentence)) continue;
  seen.add(sentence);
  const info = wordInfo.get(word) || { pos: "", sense: "" };
  fresh.push({ word, pos: info.pos, sense: info.sense, sentence });
}

if (fresh.length === 0) {
  return { ok: true, fresh: [], verdicts: [] };
}

// 3. review (only the deduped new sentences)
const candidateBlock = fresh
  .map((f, i) => {
    const pos = f.pos ? ` (POS: ${f.pos})` : "";
    const sense = f.sense ? ` (sense: ${f.sense})` : "";
    return `${i + 1}. Word: ${f.word}${pos}${sense}\n   Sentence: ${f.sentence}`;
  })
  .join("\n");

const revInput = [
  args.reviewerPrompt,
  "",
  "Candidate sentences",
  candidateBlock
].join("\n");

const rev = await agent(revInput, { schema: REV_SCHEMA, label: "reviewer" });
if (!rev || !Array.isArray(rev.verdicts)) {
  return { ok: false, error: "reviewer_failed", fresh, verdicts: [] };
}

// 4. validate verdicts cover all fresh sentences and fields are valid
const verdicts = rev.verdicts;
const bySentence = new Map();
for (const v of verdicts) {
  if (!v || typeof v.sentence !== "string" || typeof v.decision !== "string" || typeof v.reason !== "string") {
    return { ok: false, error: "reviewer_invalid", fresh, verdicts };
  }
  if (v.decision !== "pass" && v.decision !== "reject") {
    return { ok: false, error: "reviewer_invalid", fresh, verdicts };
  }
  if (v.decision === "reject" && v.reason.trim() === "") {
    return { ok: false, error: "reviewer_invalid", fresh, verdicts };
  }
  if (bySentence.has(v.sentence)) {
    return { ok: false, error: "reviewer_duplicate_verdict", fresh, verdicts };
  }
  bySentence.set(v.sentence, v);
}
for (const f of fresh) {
  if (!bySentence.has(f.sentence)) {
    return { ok: false, error: "reviewer_missing_verdict", fresh, verdicts };
  }
}
if (bySentence.size !== fresh.length) {
  return { ok: false, error: "reviewer_extra_verdict", fresh, verdicts };
}

return { ok: true, fresh, verdicts };

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const receipt = JSON.parse(readFileSync(
  resolve(process.cwd(), "config/tam-score-normalization-receipt.json"),
  "utf8",
));

describe("retired signal-layer normalization receipt", () => {
  it("durably records the exact production cohort and post-state law", () => {
    expect(receipt.scope).toMatchObject({
      current_tam_rows: 6949,
      labeled_normalization_cohort: 418,
      fractional_inflated_rows_corrected: 312,
      whole_number_inflated_rows_corrected: 70,
      pre_equal_record_dead_rows_hard_zeroed: 36,
    });
    expect(receipt.post_state_readback).toMatchObject({
      current_nondead_tam_codex_mismatches: 0,
      current_record_dead_nonzero_tam_rows: 0,
      current_signal_layer_score_notes: 0,
      current_record_dead_rows_with_nonzero_raw_codex_score: 2801,
    });
    expect(receipt.provenance.kind).toContain("independent_exact_readback");
    expect(receipt.invariant).toContain("record-dead tam_score is 0");
  });
});

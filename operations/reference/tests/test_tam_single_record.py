from __future__ import annotations

import ast
import hashlib
import json
import tempfile
import unittest
import urllib.error
from argparse import Namespace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from tools import run_tam_single_record as runner
from tools import stage_tam_final_grades as stager


class ControlTests(unittest.TestCase):
    def test_requires_explicit_single_record_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "control.json"
            valid = {
                "tamRegrade": {
                    "enabled": True,
                    "mode": runner.CONTROL_MODE,
                    "maxConcurrentRecords": 1,
                }
            }
            path.write_text(json.dumps(valid), encoding="utf-8")
            self.assertEqual(runner.require_enabled(path), valid["tamRegrade"])

            valid["tamRegrade"]["mode"] = "legacy-multirecord-pool"
            path.write_text(json.dumps(valid), encoding="utf-8")
            with self.assertRaises(runner.RunnerBlocked):
                runner.require_enabled(path)

    def test_cli_accepts_only_one_exact_id(self) -> None:
        self.assertEqual(runner.parse_args(["--id", "123"]).id, "123")
        defaults = runner.parse_args(["--id", "123"])
        self.assertIsNone(defaults.effort)
        self.assertEqual(defaults.reader_effort, "medium")
        self.assertEqual(defaults.validator_effort, "high")
        self.assertIsNone(defaults.model)
        self.assertEqual(defaults.reader_model, "gpt-5.6-terra")
        self.assertEqual(defaults.validator_model, "gpt-5.6-sol")
        overridden = runner.parse_args(["--id", "123", "--effort", "high"])
        self.assertEqual(overridden.reader_effort, "high")
        self.assertEqual(overridden.validator_effort, "high")
        model_overridden = runner.parse_args(
            ["--id", "123", "--model", "gpt-5.6-sol"]
        )
        self.assertEqual(model_overridden.reader_model, "gpt-5.6-sol")
        self.assertEqual(model_overridden.validator_model, "gpt-5.6-sol")
        with self.assertRaises(SystemExit):
            runner.parse_args(["--id", "123,456"])


class NoRetryTests(unittest.TestCase):
    def test_http_transport_is_attempted_once(self) -> None:
        calls = 0

        def fail(*_args: object, **_kwargs: object) -> object:
            nonlocal calls
            calls += 1
            raise urllib.error.URLError("offline")

        with self.assertRaises(runner.RunnerBlocked):
            runner.request_json_once(
                "GET", "/test", "secret", "", opener=fail
            )
        self.assertEqual(calls, 1)

    def test_staging_lock_can_fail_fast(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / ".stage.lock").mkdir()
            with self.assertRaises(TimeoutError):
                stager.acquire_stage_lock(root, attempts=1)

    def test_coordination_failure_has_no_direct_publish_fallback(self) -> None:
        source = Path(runner.__file__).read_text(encoding="utf-8")
        self.assertNotIn("coordination_unavailable_direct_mode", source)
        self.assertNotIn("direct_publisher.publish_final", source)
        self.assertNotIn("direct_published_readback_verified", source)
        self.assertIn("coordination_required_unavailable", source)

    def test_new_work_claims_before_opening_local_or_live_record_evidence(self) -> None:
        source = Path(runner.__file__).read_text(encoding="utf-8")
        run_one = source.split("def run_one", 1)[1].split("def parse_args", 1)[0]
        ordinary = run_one.split("stage = \"claim\"", 1)[1]
        self.assertLess(ordinary.index("claimed_record = claim("), ordinary.index("package = local_preflight("))
        self.assertLess(ordinary.index("claimed_record = claim("), ordinary.index("attach_live_company_context("))


class SupersededHoldTests(unittest.TestCase):
    def test_publish_success_archives_an_existing_hold_by_content_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            pool_root = Path(temporary)
            hold_path = pool_root / "holds" / "123.json"
            hold_path.parent.mkdir(parents=True)
            hold_path.write_text('{"reason":"resolved"}\n', encoding="utf-8")
            expected_sha = runner.core.sha256_file(hold_path)

            receipt = runner.archive_superseded_hold(
                "123", pool_root=pool_root
            )

            self.assertIsNotNone(receipt)
            assert receipt is not None
            self.assertEqual(receipt["holdSha256"], expected_sha)
            self.assertFalse(hold_path.exists())
            history = Path(receipt["historyPath"])
            self.assertTrue(history.is_file())
            self.assertEqual(runner.core.sha256_file(history), expected_sha)

    def test_no_hold_is_a_noop(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            self.assertIsNone(
                runner.archive_superseded_hold(
                    "123", pool_root=Path(temporary)
                )
            )


class SecretSelectionTests(unittest.TestCase):
    def test_redacted_cron_secret_falls_back_to_agent_token_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            env_path = root / ".env.local"
            vercel_env_path = root / ".env.production.local"
            project = root / "project"
            token_path = project / ".vercel" / ".codex-agent-token"
            token_path.parent.mkdir(parents=True)
            env_path.write_text("", encoding="utf-8")
            vercel_env_path.write_text(
                "CRON_SECRET=\"[SENSITIVE]\"\n", encoding="utf-8"
            )
            token_path.write_text("agent-token", encoding="utf-8")
            with (
                mock.patch.object(runner, "ENV_PATH", env_path),
                mock.patch.object(runner, "VERCEL_ENV_PATH", vercel_env_path),
                mock.patch.object(runner.core, "PROJECT", project),
                mock.patch.dict(
                    runner.os.environ,
                    {
                        "CRON_SECRET": "",
                        "CODEX_AGENT_TOKEN": "",
                        "VERCEL_AUTOMATION_BYPASS_SECRET": "",
                    },
                ),
            ):
                secret, bypass = runner.read_api_secrets()
            self.assertEqual(secret, "agent-token")
            self.assertEqual(bypass, "")


class ArtifactTests(unittest.TestCase):
    def test_reader_opportunity_sentence_uses_reader_digest_field(self) -> None:
        candidate = {
            "exact_id": "123",
            "candidate_score": 30,
            "full_record_text_read": True,
            "full_pdf_read": True,
            "pdf_pages_read": 1,
            "every_dq_occurrence_reviewed": True,
            "every_status_change_contextualized": True,
            "opportunity_records_reviewed": True,
            "intro_call_records_reviewed": True,
            "budget_threshold_applied": True,
            "opportunity_exists": True,
            "opportunity_created_date": "",
            "chronological_digest": (
                "Opportunity confirmed: 2024-01-01 — creation date not exposed."
            ),
            "old_gold_reasons": [],
            "intro_call_exists": False,
        }
        runner.core.validate_candidate("123", {"pdf_pages": 1}, candidate)

    def test_opportunity_unexposed_date_with_linkage_suffix_is_not_creation_date(self) -> None:
        candidate = {
            "exact_id": "123",
            "candidate_score": 30,
            "full_record_text_read": True,
            "full_pdf_read": True,
            "pdf_pages_read": 1,
            "every_dq_occurrence_reviewed": True,
            "every_status_change_contextualized": True,
            "opportunity_records_reviewed": True,
            "intro_call_records_reviewed": True,
            "budget_threshold_applied": True,
            "opportunity_exists": True,
            "opportunity_created_date": "creation date not exposed; linked by 2023-01-20",
            "chronological_digest": "Opportunity confirmed: 2023-01-20 — creation date not exposed.",
            "old_gold_reasons": [],
            "intro_call_exists": False,
        }
        runner.core.validate_candidate("123", {"pdf_pages": 1}, candidate)

    def test_display_contract_deterministically_surfaces_opportunity(self) -> None:
        final = {
            "opportunity_exists": True,
            "opportunity_created_date": "creation date not exposed; linked by 2023-01-20",
            "opportunity_status": "Closed Lost",
            "opportunity_summary": "#123 ERP evaluation",
            "intro_call_exists": False,
            "record_digest": "Full record reviewed.",
            "old_gold_reasons": [],
        }
        normalized = runner.core.with_display_contract(
            final, digest_field="record_digest"
        )
        self.assertEqual(final["old_gold_reasons"], [])
        self.assertIn("Opportunity confirmed:", normalized["old_gold_reasons"][0])
        self.assertIn("creation date not exposed", normalized["old_gold_reasons"][0])
        self.assertNotIn("Opportunity created:", normalized["old_gold_reasons"][0])

    def test_receipt_reuse_is_bound_to_exact_evidence_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "candidate.json"
            artifact.write_text('{"exact_id":"123"}', encoding="utf-8")
            identity = {
                "exactId": "123",
                "pdfSha256": "a" * 64,
                "recordTextSha256": "b" * 64,
            }
            receipt = {
                "schema": "tam-full-evidence-model-artifact",
                "version": 1,
                "role": "reader",
                "evidence": identity,
                "artifactSha256": runner.core.sha256_file(artifact),
                "candidateSha256": None,
                "completeRawEvidenceCoverage": True,
                "modelConcurrency": 1,
            }
            self.assertTrue(
                runner.receipt_matches(
                    receipt, artifact, identity, "reader", None
                )
            )
            changed = {**identity, "pdfSha256": "c" * 64}
            self.assertFalse(
                runner.receipt_matches(
                    receipt, artifact, changed, "reader", None
                )
            )

    def test_reader_and_validator_calls_are_serial(self) -> None:
        calls: list[str] = []

        def fake_run_codex(**kwargs: object) -> dict[str, object]:
            calls.append(str(kwargs["schema"]))
            return {"ok": True}

        package = {"pdf_pages": 1}
        args = {
            "internal_id": "123",
            "package": package,
            "artifact_path": Path("out.json"),
            "logs": Path("logs"),
            "codex_home": Path("home"),
            "model": "gpt-5.6-sol",
            "effort": "high",
            "timeout_seconds": 60,
            "maximum_prompt_characters": 100_000,
            "chunk_characters": 50_000,
        }
        with (
            mock.patch.object(runner.core, "reader_prompt", return_value="r"),
            mock.patch.object(
                runner.core, "validator_prompt", return_value="v"
            ),
            mock.patch.object(runner.core, "run_codex", fake_run_codex),
        ):
            runner.run_role(role="reader", candidate=None, **args)
            runner.run_role(role="validator", candidate={"x": 1}, **args)
        self.assertEqual(
            calls,
            [str(runner.core.READER_SCHEMA), str(runner.core.VALIDATOR_SCHEMA)],
        )

    def test_reader_and_validator_share_the_complete_evidence_prefix(self) -> None:
        package = {"pdf_pages": 1}
        with mock.patch.object(
            runner.core,
            "evidence_block",
            return_value="record evidence\npdf evidence",
        ):
            reader = runner.core.reader_prompt("123", package)
            validator = runner.core.validator_prompt("123", package, {"x": 1})
        marker = "\n===== FIRST-PASS ROLE AND GRADING RULES =====\n"
        self.assertIn(marker, reader)
        shared_prefix = reader.split(marker, 1)[0]
        self.assertTrue(validator.startswith(shared_prefix))
        self.assertIn("record evidence", shared_prefix)
        self.assertIn("pdf evidence", shared_prefix)
        self.assertIn("MANDATORY FINAL CONSISTENCY GATE", reader)
        self.assertIn("MANDATORY FINAL CONSISTENCY GATE", validator)
        self.assertIn("old_gold_score exactly 0", reader)
        self.assertIn("old_gold_score exactly 0", validator)
        self.assertTrue(reader.rstrip().endswith("single final JSON object."))
        self.assertTrue(validator.rstrip().endswith("single final JSON object."))
        rules_marker = "===== INDEPENDENT VALIDATOR ROLE AND GRADING RULES ====="
        candidate_marker = "===== FIRST-PASS CANDIDATE (CHECK, DO NOT TRUST) ====="
        validator_rules = validator.split(rules_marker, 1)[1].split(
            candidate_marker, 1
        )[0]
        normalized_rules = " ".join(validator_rules.split())
        self.assertIn("has embedded every policy", normalized_rules)
        self.assertIn("Do not call tools", normalized_rules)
        self.assertIn("PowerShell commands", normalized_rules)
        self.assertIn("project or repository files", normalized_rules)
        self.assertIn("Any tool call invalidates this run", normalized_rules)
        self.assertIn("interim/provisional/hold", normalized_rules)
        self.assertIn("final schema-valid JSON object", normalized_rules)
        self.assertLess(validator.index("Do not call tools"), validator.index(candidate_marker))


class ReadbackTests(unittest.TestCase):
    def test_exact_publish_readback_must_match_every_final_field(self) -> None:
        payload = {
            "netsuiteInternalId": "123",
            "finalScore": 64,
            "codexScore": 64,
            "recordDigest": "digest",
            "provenance": {"sha256": "a" * 64},
            "validation": {"validatedBy": "independent"},
        }
        live = {
            "netsuite_internal_id": "123",
            "grade_status": "published",
            "final_score": 64,
            "codex_score": 64,
            "record_digest": "digest",
            "grade_provenance_sha256": "a" * 64,
            "validation_status": "passed",
            "validated_by": "independent",
        }
        runner.verify_published_readback(live, payload)
        live["record_digest"] = "wrong"
        with self.assertRaises(runner.RunnerBlocked):
            runner.verify_published_readback(live, payload)

    def test_publish_payload_uses_validated_raw_grade_and_claim_token(self) -> None:
        provenance_data = {"exact": "123", "note": "full record — verified"}
        prepared = runner.prepare_publish_payload(
            {
                "finalScore": 64,
                "codexScore": 61,
                "provenance": {
                    "sha256": hashlib.sha256(
                        runner.canonical_bytes(provenance_data)
                    ).hexdigest(),
                    "objectPath": "ars-bs-tam-current/123/provenance.json",
                    "data": provenance_data,
                },
            },
            {"final_score": 64},
            "11111111-1111-4111-8111-111111111111",
        )
        self.assertEqual(prepared["codexScore"], 64)
        self.assertEqual(
            prepared["claimToken"],
            "11111111-1111-4111-8111-111111111111",
        )
        self.assertEqual(
            prepared["provenance"]["canonicalJson"],
            runner.canonical_bytes(provenance_data).decode("ascii"),
        )


class LeaseTransportTests(unittest.TestCase):
    def test_inflight_checkpoint_preserves_but_terminal_drops_claim_token(self) -> None:
        token = "11111111-1111-4111-8111-111111111111"
        with tempfile.TemporaryDirectory() as temporary:
            checkpoint_path = Path(temporary) / "checkpoint.json"
            with mock.patch.object(runner, "CHECKPOINT_PATH", checkpoint_path):
                runner.checkpoint(
                    "123", "working", "claimed", claimToken=token
                )
                carried = runner.checkpoint("123", "working", "validator")
                terminal = runner.checkpoint("123", "complete", "done")
        self.assertEqual(carried["claimToken"], token)
        self.assertNotIn("claimToken", terminal)

    def test_claim_resume_and_status_mutation_carry_fencing_token(self) -> None:
        token = "11111111-1111-4111-8111-111111111111"
        calls: list[dict[str, object]] = []
        # Fixture follows the existing 0058 claim/heartbeat contract. It used
        # to omit required fencing fields and accidentally read live state.
        now = datetime.now(timezone.utc)
        claim_row = {"netsuite_internal_id": "123", "pdf_status": "verified",
                     "grade_status": "reading", "last_actor": runner.ACTOR_KEY,
                     "claim_actor": runner.ACTOR_KEY, "claim_token": token,
                     "company_id": "22222222-2222-4222-8222-222222222222",
                     "claim_generation": 1, "claim_heartbeat_at": now.isoformat(),
                     "claim_expires_at": (now + timedelta(minutes=30)).isoformat()}
        run_id = "33333333-3333-4333-8333-333333333333"
        baseline = {"runSlug": runner.RUN_SLUG, "seedId": None,
                    "companyId": claim_row["company_id"], "exactId": "123",
                    "actorKey": runner.ACTOR_KEY, "claimGeneration": 1,
                    "claimTokenSha256": hashlib.sha256(token.encode()).hexdigest(), "runId": run_id}

        def fake_post(
            _secret: str,
            _bypass: str,
            action: dict[str, object],
        ) -> dict[str, object]:
            calls.append(action)
            if action["action"] == "claim":
                return {"record": claim_row}
            if action["action"] == "heartbeat":
                return {"actor": {"run_id": run_id, "actor_key": runner.ACTOR_KEY,
                                  "status": action["status"], "current_work": action["currentWork"]},
                        "claim": claim_row}
            return {"ok": True}

        with (mock.patch.object(runner, "coordination_post", fake_post),
              mock.patch.object(runner, "ROUND_CONTEXT", None),
              mock.patch.object(runner, "load_checkpoint", return_value={"claimIdentity": baseline, "claimGeneration": 1}),
              mock.patch.object(runner, "coordination_checkpoint")):
            runner.claim(
                "secret",
                "",
                "123",
                include_hold=False,
                claim_token=token,
            )
            runner.heartbeat(
                "secret", "", "123", "working", "validator", token
            )
            runner.set_grade_status_once(
                "secret", "", "123", token, "pending"
            )

        self.assertEqual(calls[0]["claimToken"], token)
        self.assertEqual(calls[0]["leaseSeconds"], runner.CLAIM_LEASE_SECONDS)
        self.assertEqual(calls[1]["claimToken"], token)
        self.assertEqual(calls[1]["netsuiteInternalId"], "123")
        self.assertEqual(calls[2]["claimToken"], token)


class StaticShapeTests(unittest.TestCase):
    def test_runner_has_no_polling_loop_or_concurrency_import(self) -> None:
        source = Path(runner.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        self.assertFalse(any(isinstance(node, ast.While) for node in ast.walk(tree)))
        imports = {
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        }
        self.assertNotIn("threading", imports)
        self.assertNotIn("concurrent.futures", imports)
        self.assertNotIn("selenium", imports)

    def test_extracted_core_has_no_pool_or_launcher_shapes(self) -> None:
        source = Path(runner.core.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        self.assertFalse(any(isinstance(node, ast.While) for node in ast.walk(tree)))
        imports = {
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        }
        self.assertTrue(
            imports.isdisjoint(
                {"concurrent.futures", "queue", "threading"}
            )
        )
        self.assertNotIn("ThreadPoolExecutor", source)
        self.assertNotIn("subprocess.Popen", source)

    def test_full_reader_and_independent_validator_contract_is_preserved(
        self,
    ) -> None:
        self.assertIn("EVERY CHARACTER", runner.core.READER_RULES)
        self.assertIn("EVERY numbered PDF page", runner.core.READER_RULES)
        self.assertIn("independent final validator", runner.core.VALIDATOR_RULES)
        self.assertIn("EVERY CHARACTER", runner.core.VALIDATOR_RULES)
        self.assertIn("EVERY numbered PDF page", runner.core.VALIDATOR_RULES)
        self.assertIn("Work only from this complete embedded prompt", runner.core.VALIDATOR_RULES)
        self.assertIn("Do not call tools", runner.core.VALIDATOR_RULES)
        self.assertIn("interim/provisional/hold", runner.core.VALIDATOR_RULES)
        self.assertIn("$3,000 per month", runner.core.READER_RULES)
        self.assertIn("bare status", runner.core.READER_RULES)
        self.assertIn("dead band is a present-day sales judgment", runner.core.READER_RULES)
        self.assertIn("payroll-only or another non-ERP point need", runner.core.READER_RULES)
        self.assertIn("ambiguous shorthand or an uncorroborated DQ code is insufficient", runner.core.READER_RULES)
        self.assertIn('"might reconsider" in two or three years', runner.core.READER_RULES)
        self.assertIn("preserve a concrete ERP need/project", runner.core.READER_RULES)
        self.assertIn("Treat the dead band as a present-day sales judgment", runner.core.VALIDATOR_RULES)
        self.assertIn("hypothetical future broadening alone", runner.core.VALIDATOR_RULES)
        self.assertIn("Do not apply this from a keyword, ambiguous shorthand, or bare DQ code", runner.core.VALIDATOR_RULES)
        self.assertIn('A vague "might reconsider in 2-3 years" is hypothetical', runner.core.VALIDATOR_RULES)
        self.assertIn("Opportunity created:", runner.core.READER_RULES)
        self.assertIn("timing_arrived", runner.core.READER_RULES)


if __name__ == "__main__":
    unittest.main()

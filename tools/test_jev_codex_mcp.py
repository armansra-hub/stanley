import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import jev_codex_mcp as mcp

class ConnectorTests(unittest.TestCase):
    def test_initialize_and_tools_without_credentials_or_paid_call(self):
        with patch.object(mcp, "request", side_effect=AssertionError("network")):
            self.assertEqual(mcp.dispatch({"method": "initialize", "params": {"protocolVersion": "2025-03-26"}})["protocolVersion"], "2025-03-26")
            self.assertEqual(len(mcp.dispatch({"method": "tools/list"})["tools"]), 3)

    def test_paid_success_reuses_exact_answer_only(self):
        args = {"state": "public source", "privacy": "public", "questions": {"match": {"type": "noul", "instructions": "Relevant?"}}}
        result = {"status": "complete", "evaluation": {"ok": True, "provider_result": {"answers": {"match": {"type": "noul", "noul": .8}}}}}
        with tempfile.TemporaryDirectory() as folder, patch.object(mcp, "CACHE", Path(folder)), patch.object(mcp, "request", return_value=result) as send:
            self.assertFalse(mcp.evaluate(args)["localReuse"])
            self.assertTrue(mcp.evaluate(args)["localReuse"])
            self.assertEqual(send.call_count, 1)
            self.assertFalse(mcp.evaluate({**args, "state": "changed source"})["localReuse"])
            self.assertEqual(send.call_count, 2)

    def test_unknown_acceptance_does_not_repeat(self):
        args = {"state": "private excerpt", "questions": {"match": {"type": "noul", "instructions": "Relevant?"}}}
        with tempfile.TemporaryDirectory() as folder, patch.object(mcp, "CACHE", Path(folder)), patch.object(mcp, "request", side_effect=TimeoutError) as send:
            self.assertEqual(mcp.evaluate(args)["error"], "provider_acceptance_unknown")
            self.assertEqual(mcp.evaluate(args)["error"], "request_in_progress_or_acceptance_unknown")
            self.assertEqual(send.call_count, 1)

    def test_known_budget_deferral_can_resume(self):
        args = {"state": "source", "questions": {"match": {"type": "noul", "instructions": "Relevant?"}}}
        with tempfile.TemporaryDirectory() as folder, patch.object(mcp, "CACHE", Path(folder)), patch.object(mcp, "request", return_value={"status": "budget_deferred"}):
            self.assertEqual(mcp.evaluate(args)["status"], "budget_deferred")
            self.assertFalse(list(Path(folder).glob("*.intent")))

    def test_no_arbitrary_url_or_path_tool(self):
        with self.assertRaises(ValueError):
            mcp.dispatch({"method": "tools/call", "params": {"name": "jev_account_context", "arguments": {"internalId": "../../secrets"}}})

if __name__ == "__main__":
    unittest.main()

import unittest

from foundation_inc5000_2026 import pending_profile_urls


class FailedProfileRecoveryTests(unittest.TestCase):
    def test_refresh_retries_failed_and_missing_profiles_once_but_keeps_success(self):
        candidates = [{"inc_profile_url": url} for url in ["good", "failed", "new", "failed"]]
        cached = {"good": {"ok": True, "rank": 1}, "failed": {"ok": False, "error": "HTTP 403"}}
        self.assertEqual(pending_profile_urls(candidates, cached), ["new"])
        self.assertEqual(pending_profile_urls(candidates, cached, refresh_failed=True), ["failed", "new"])
        self.assertEqual(cached["good"], {"ok": True, "rank": 1})
        self.assertEqual(cached["failed"]["error"], "HTTP 403")


if __name__ == "__main__":
    unittest.main()

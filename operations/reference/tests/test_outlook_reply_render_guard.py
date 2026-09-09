import unittest

from tools.outlook_reply_render_guard import validate_followup1


SIGNATURE_AND_QUOTE = """
**Arman Sra** | **Account Executive**

* * *
**From:** Arman Sra
**Subject:** Original
"""


class OutlookReplyRenderGuardTests(unittest.TestCase):
    def test_accepts_good_followup(self):
        body = f"""Oracle Confidential

Hi Wade,

Just wanted to make sure this didn’t get buried in your inbox. Did you get a chance to view my note below?

Looking forward to speaking,

{SIGNATURE_AND_QUOTE}"""
        self.assertTrue(validate_followup1(body, "Wade").ok)

    def test_rejects_luke_sentence_reordering(self):
        body = f"""Oracle Confidential

Hi Luke,

Looking forward to speaking,


Just wanted to make sure this didn’t get buried in your inbox. Did you get a chance to view my note below?
{SIGNATURE_AND_QUOTE}"""
        result = validate_followup1(body, "Luke")
        self.assertFalse(result.ok)
        self.assertIn("followup_copy_out_of_order", result.failures)

    def test_rejects_ty_duplicate_classification(self):
        body = f"""Oracle Confidential

Oracle Confidential

Oracle Confidential

Hi Ty,

Just wanted to make sure this didn’t get buried in your inbox. Did you get a chance to view my note below?

Looking forward to speaking,

{SIGNATURE_AND_QUOTE}"""
        result = validate_followup1(body, "Ty")
        self.assertFalse(result.ok)
        self.assertIn("classification_count_not_one", result.failures)

    def test_rejects_howard_extra_blank_paragraphs(self):
        body = f"""Oracle Confidential

Hi Howard,

Just wanted to make sure this didn’t get buried in your inbox. Did you get a chance to view my note below?




Looking forward to speaking,

{SIGNATURE_AND_QUOTE}"""
        result = validate_followup1(body, "Howard")
        self.assertFalse(result.ok)
        self.assertIn("excess_blank_paragraphs_after_note", result.failures)

    def test_rejects_unexpected_thanks(self):
        body = f"""Oracle Confidential

Hi Wade,

Just wanted to make sure this didnâ€™t get buried in your inbox. Did you get a chance to view my note below?

Looking forward to speaking,

Thanks,
{SIGNATURE_AND_QUOTE}"""
        result = validate_followup1(body, "Wade")
        self.assertFalse(result.ok)
        self.assertIn("unexpected_thanks_present", result.failures)


if __name__ == "__main__":
    unittest.main()

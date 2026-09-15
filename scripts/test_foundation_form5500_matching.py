"""Pure identity tests: no source downloads, credentials or app requests."""
import unittest
from collections import defaultdict
import foundation_form5500 as subject


def row(name="GLOBAL, INC.", state="PA", city="SOMERSET", dba=""):
    return {"SF_SPONSOR_NAME": name, "SF_SPONS_US_STATE": state,
            "SF_SPONS_US_CITY": city, "SF_SPONSOR_DFE_DBA_NAME": dba}


def index(*companies):
    result = defaultdict(list)
    for company in companies:
        result[subject.norm(company["name"])].append(company)
    return result


def company(identifier="global", state="PA", city="Somerset", name="Global Inc"):
    return {"id": identifier, "name": name, "state": state, "city": city}


class MatchingTests(unittest.TestCase):
    def test_actual_global_other_state_never_falls_back(self):
        self.assertIsNone(subject.match_company(row(), index(company(state="CA", city=None, name="LLP Global Inc"))))

    def test_exact_state_and_city_support_high_confidence(self):
        self.assertEqual(subject.match_company(row(), index(company())), ("global", "exact_name_state_city", 0.98))

    def test_missing_company_city_cannot_claim_city_match(self):
        self.assertEqual(subject.match_company(row(), index(company(city=None))), ("global", "unique_exact_name", 0.91))

    def test_different_company_city_cannot_claim_city_match(self):
        self.assertEqual(subject.match_company(row(), index(company(city="Pittsburgh"))), ("global", "unique_exact_name", 0.91))

    def test_unknown_company_state_remains_name_only(self):
        self.assertEqual(subject.match_company(row(), index(company(state=None))), ("global", "unique_exact_name", 0.91))

    def test_source_without_state_remains_name_only(self):
        self.assertEqual(subject.match_company(row(state=""), index(company())), ("global", "unique_exact_name", 0.91))

    def test_source_without_city_remains_name_only(self):
        self.assertEqual(subject.match_company(row(city=""), index(company())), ("global", "unique_exact_name", 0.91))

    def test_exact_state_preferred_to_unknown(self):
        self.assertEqual(subject.match_company(row(), index(company(), company("unknown", state=None))), ("global", "exact_name_state_city", 0.98))

    def test_contradictory_candidate_removed_before_city_disambiguation(self):
        self.assertEqual(subject.match_company(row(), index(company(), company("other", state="CA"))), ("global", "exact_name_state_city", 0.98))

    def test_multiple_same_state_and_city_stay_ambiguous(self):
        self.assertIsNone(subject.match_company(row(), index(company(), company("second"))))

    def test_city_disambiguates_actual_same_state_candidates(self):
        self.assertEqual(subject.match_company(row(), index(company(), company("second", city="Erie"))), ("global", "exact_name_state_city", 0.98))

    def test_dba_lookup_obeys_same_location_rules(self):
        self.assertIsNone(subject.match_company(row(name="Unrelated Sponsor", dba="Global Inc"), index(company(state="CA"))))

    def test_normalized_state_case_and_whitespace_match(self):
        self.assertEqual(subject.match_company(row(state=" pa "), index(company(state=" pa "))), ("global", "exact_name_state_city", 0.98))


if __name__ == "__main__": unittest.main()

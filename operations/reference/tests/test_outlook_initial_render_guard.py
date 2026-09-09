from tools.outlook_initial_render_guard import validate_initial


BLOCKS = [
    "Hi Jarelle,",
    "I saw that you guys were growing.",
    "NetSuite works with similar companies.",
    "We usually come into play when companies outgrow QuickBooks and Excel.",
    "Do you have time for a 15-minute meeting this/next week?",
    "Thanks,",
]


def test_valid_initial_passes():
    body = "\n\n".join(BLOCKS) + "\n\nArman Sra | Account Executive"
    assert validate_initial(body, BLOCKS).ok


def test_missing_middle_block_fails():
    body = "\n\n".join(BLOCKS[:2] + BLOCKS[3:]) + "\n\nArman Sra | Account Executive"
    result = validate_initial(body, BLOCKS)
    assert not result.ok
    assert "block_2_count_not_one" in result.failures


def test_out_of_order_and_em_dash_fail():
    broken = [BLOCKS[0], BLOCKS[2], BLOCKS[1], "bad \u2014 copy", *BLOCKS[3:]]
    body = "\n\n".join(broken) + "\n\nArman Sra | Account Executive"
    result = validate_initial(body, BLOCKS)
    assert not result.ok
    assert "initial_copy_out_of_order" in result.failures
    assert "em_dash_present" in result.failures

import argparse
import hashlib
import json
import os
import tempfile
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any


STATE_PATH = Path(__file__).with_name("linkedin-cadence-state.json")
LOCK_PATH = Path(__file__).with_name("linkedin-cadence-run.lock.json")

AFFIRMATIVE_LIVE_SOURCE = "automation_live_action"
AFFIRMATIVE_AUDIT_SOURCE = "automation_sequence_audit"
BLOCKED_PROFILE_STATUSES = {
    "cadence_complete_two_followups",
    "company_identity_mismatch_skip",
    "manual_conversation_skip",
    "review_excluded_missing_visible_send",
    "stopped_company_dnc",
    "stopped_company_inactive",
    "stopped_company_mismatch",
    "stopped_prior_decline",
    "stopped_reply",
}
ACTIVE_PROSPECTING_STATUSES = {
    "blocked_current_lead_review",
    "blocked_linkedin_outbound_rejected",
    "pending_below_nine",
    "pending_company_identity_resolution",
}
BLOCKING_TAL_TYPES = {"REP ENGAGED"}
BLOCKING_BDR_STATUSES = {"SQL", "MEETING SCHEDULED"}
COMMUNICATION_CLEAR = "clear_or_generic_only"
COMMUNICATION_BLOCKED = "blocked_substantive_recent_communication"
AUTHORIZED_SALES_REP = "Arman Sra"
AUTHORIZED_SALES_REP_VALUES = {"arman sra", "sra, arman"}


def is_authorized_sales_rep(value: str | None) -> bool:
    return str(value or "").strip().casefold() in AUTHORIZED_SALES_REP_VALUES


def now_iso() -> str:
    return datetime.now().astimezone().isoformat()


def load_state() -> dict:
    with STATE_PATH.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def save_state(state: dict) -> None:
    state["updated_at"] = now_iso()
    fd, temp_name = tempfile.mkstemp(
        prefix=f"{STATE_PATH.name}.", suffix=".tmp", dir=STATE_PATH.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            # The ledger is machine state, not a prompt artifact. Compact JSON keeps
            # the same semantics while avoiding a 3x whitespace expansion on every
            # atomic checkpoint.
            json.dump(
                state,
                handle,
                ensure_ascii=False,
                separators=(",", ":"),
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, STATE_PATH)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def get_profile(state: dict, profile_url: str) -> dict:
    profile = state.get("profiles", {}).get(profile_url)
    if profile is None:
        raise SystemExit(f"Unknown exact profile URL: {profile_url}")
    return profile


def parse_local_date(value: str | None) -> date:
    if value is None:
        return datetime.now().astimezone().date()
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise SystemExit("local-date must be YYYY-MM-DD.") from error


def is_weekend(local_date: date) -> bool:
    return local_date.weekday() >= 5


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def affirmative_provenance(profile: dict) -> bool:
    """Return true only for the two policy-authorized provenance forms."""
    provenance = profile.get("provenance") or {}
    if provenance.get("action") != "connection_request_sent":
        return False
    source = provenance.get("source")
    if source == AFFIRMATIVE_LIVE_SOURCE:
        # Live records are created only after visible confirmation.
        return True
    return (
        source == AFFIRMATIVE_AUDIT_SOURCE
        and provenance.get("visible_result") == "sent"
        and bool(provenance.get("audit_record_id"))
    )


def provenance_summary(profile: dict) -> dict:
    provenance = profile.get("provenance") or {}
    return {
        "qualified": affirmative_provenance(profile),
        "action": provenance.get("action"),
        "source": provenance.get("source"),
        "audit_record_id": provenance.get("audit_record_id"),
        "visible_result": provenance.get("visible_result"),
        "visible_confirmation": provenance.get("visible_confirmation"),
    }


def event_local_date(profile: dict) -> str | None:
    timestamp = profile.get("request_time")
    if not timestamp:
        timestamp = (profile.get("provenance") or {}).get("call_timestamp_utc")
    if not timestamp or not isinstance(timestamp, str):
        return None
    normalized = timestamp[:-1] + "+00:00" if timestamp.endswith("Z") else timestamp
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.date().isoformat()
    return parsed.astimezone().date().isoformat()


def request_counts(state: dict) -> tuple[Counter, Counter]:
    lifetime: Counter = Counter()
    daily: Counter = Counter()
    for profile in state.get("profiles", {}).values():
        if not affirmative_provenance(profile):
            continue
        company_key = profile.get("company_key")
        if not company_key:
            continue
        lifetime[company_key] += 1
        request_date = event_local_date(profile)
        if request_date:
            daily[(company_key, request_date)] += 1
    return lifetime, daily


def company_guard(
    state: dict,
    company_key: str | None,
    local_date: date,
    counts: tuple[Counter, Counter] | None = None,
) -> dict:
    lifetime, daily = counts or request_counts(state)
    company = state.get("companies", {}).get(company_key, {}) if company_key else {}
    stored_lifetime = int(company.get("automation_request_count") or 0)
    derived_lifetime = int(lifetime.get(company_key, 0))
    stored_daily = int(
        (company.get("daily_request_counts") or {}).get(local_date.isoformat(), 0)
    )
    derived_daily = int(daily.get((company_key, local_date.isoformat()), 0))
    # Counters are monotonic. A mismatch is reported, and the larger verified
    # ledger value is used so a read-path defect can never reopen a cap.
    effective_lifetime = max(stored_lifetime, derived_lifetime)
    effective_daily = max(stored_daily, derived_daily)
    lifetime_limit = int(state.get("company_connection_request_limit") or 9)
    daily_limit = int(state.get("daily_company_request_limit") or 3)
    outreach_status = company.get("outreach_status")
    bdr_status = company.get("bdr_status")
    bdr_status_missing = not bool(str(bdr_status or "").strip())
    normalized_bdr_status = str(bdr_status or "").strip().upper()
    bdr_status_is_sql = normalized_bdr_status == "SQL"
    bdr_status_is_meeting_scheduled = normalized_bdr_status == "MEETING SCHEDULED"
    bdr_status_is_blocked = normalized_bdr_status in BLOCKING_BDR_STATUSES
    tal_type = company.get("tal_type")
    tal_type_is_rep_engaged = (
        str(tal_type or "").strip().upper() in BLOCKING_TAL_TYPES
    )
    return {
        "company_key": company_key,
        "company_name": company.get("company_name"),
        "do_not_contact": bool(company.get("do_not_contact")),
        "dnc_reason": company.get("dnc_reason"),
        "outreach_status": outreach_status,
        "bdr_status": bdr_status,
        "bdr_status_missing": bdr_status_missing,
        "bdr_status_is_sql": bdr_status_is_sql,
        "bdr_status_is_meeting_scheduled": bdr_status_is_meeting_scheduled,
        "bdr_status_is_blocked": bdr_status_is_blocked,
        "tal_type": tal_type,
        "tal_type_is_rep_engaged": tal_type_is_rep_engaged,
        "lifetime_request_count": effective_lifetime,
        "lifetime_request_limit": lifetime_limit,
        "lifetime_counter_matches_exact_profiles": (
            stored_lifetime == derived_lifetime
        ),
        "daily_local_date": local_date.isoformat(),
        "daily_request_count": effective_daily,
        "daily_request_limit": daily_limit,
        "daily_counter_matches_exact_timestamps": stored_daily == derived_daily,
        "remaining_lifetime_slots": max(0, lifetime_limit - effective_lifetime),
        "remaining_daily_slots": max(0, daily_limit - effective_daily),
        "connection_request_allowed_by_ledger": (
            bool(company_key)
            and not bool(company.get("do_not_contact"))
            and not bdr_status_missing
            and not bdr_status_is_blocked
            and not tal_type_is_rep_engaged
            and outreach_status != "company_inactive_ceased_operations"
            and effective_lifetime < lifetime_limit
            and effective_daily < daily_limit
        ),
    }


def mission_lead(state: dict, lead_id: str | None) -> dict | None:
    if not lead_id:
        return None
    return next(
        (
            lead
            for lead in (state.get("full_tal_mission") or {}).get("leads", [])
            if str(lead.get("internal_id")) == str(lead_id)
        ),
        None,
    )


def current_lead_review(
    state: dict, lead_id: str | None, local_date: date
) -> dict | None:
    lead = mission_lead(state, lead_id)
    review = (lead or {}).get("live_review")
    if not isinstance(review, dict):
        return None
    if review.get("local_date") != local_date.isoformat():
        return None
    return review


def lead_review_blockers(review: dict | None) -> list[str]:
    if not review:
        return ["missing_current_live_lead_review"]
    blockers = list(review.get("blockers") or [])
    sales_rep = str(review.get("sales_rep") or "").strip()
    if not sales_rep:
        blockers.append("missing_current_sales_rep")
    elif not is_authorized_sales_rep(sales_rep):
        blockers.append("sales_rep_not_arman_sra")
    if review.get("eligible") is not True and not blockers:
        blockers.append("lead_review_not_eligible")
    return sorted(set(blockers))


def lock_status(owner_id: str | None) -> dict:
    result = {
        "required": True,
        "owner_id_supplied": bool(owner_id),
        "owned_and_unexpired": False,
        "lock_present": LOCK_PATH.exists(),
    }
    if not LOCK_PATH.exists():
        return result
    try:
        with LOCK_PATH.open("r", encoding="utf-8-sig") as handle:
            lock = json.load(handle)
        expiry_text = lock.get("expires_at_utc")
        expiry = datetime.fromisoformat(str(expiry_text).replace("Z", "+00:00"))
        heartbeat_text = lock.get("heartbeat_at_utc")
        heartbeat = datetime.fromisoformat(
            str(heartbeat_text).replace("Z", "+00:00")
        )
        now_utc = datetime.now(timezone.utc)
        unexpired = expiry.astimezone(timezone.utc) > now_utc
        heartbeat_age_seconds = (
            now_utc - heartbeat.astimezone(timezone.utc)
        ).total_seconds()
        heartbeat_recent = -30 <= heartbeat_age_seconds <= 300
        owner_matches = bool(owner_id) and lock.get("owner_id") == owner_id
        result.update(
            {
                "recorded_owner_id": lock.get("owner_id"),
                "heartbeat_at_utc": heartbeat_text,
                "heartbeat_age_seconds": round(heartbeat_age_seconds, 1),
                "heartbeat_recent_within_5_minutes": heartbeat_recent,
                "expires_at_utc": expiry_text,
                "unexpired": unexpired,
                "owned_and_unexpired": owner_matches and unexpired,
                "owned_unexpired_and_recent": (
                    owner_matches and unexpired and heartbeat_recent
                ),
            }
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        result["error"] = f"unreadable_lock:{type(error).__name__}"
    return result


def require_recent_owned_lock(owner_id: str | None) -> None:
    current = lock_status(owner_id)
    if not current.get("owned_unexpired_and_recent"):
        raise SystemExit(
            "Refusing ledger mutation: acquire/heartbeat the LinkedIn cadence "
            "lock with the same owner ID within five minutes."
        )


def validate_recent_reply_check(timestamp: str | None) -> str:
    if not timestamp:
        raise SystemExit(
            "reply-checked-at is required; never infer or fabricate the live reply gate."
        )
    normalized = timestamp[:-1] + "+00:00" if timestamp.endswith("Z") else timestamp
    try:
        checked = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise SystemExit("reply-checked-at must be an ISO-8601 timestamp.") from error
    if checked.tzinfo is None:
        raise SystemExit("reply-checked-at must include a UTC offset.")
    age_seconds = (
        datetime.now(timezone.utc) - checked.astimezone(timezone.utc)
    ).total_seconds()
    if age_seconds < -30 or age_seconds > 600:
        raise SystemExit(
            "reply-checked-at must reflect a live check within the last ten minutes."
        )
    return timestamp


def followup_ledger_blockers(
    state: dict, profile_url: str, step: int, local_date: date
) -> list[str]:
    profile = get_profile(state, profile_url)
    cadence = profile.get("cadence") or {}
    followup = cadence.get(f"followup_{step}") or {}
    company = state.get("companies", {}).get(profile.get("company_key"), {})
    lead_id = lead_id_for_profile(state, profile)
    review = current_lead_review(state, lead_id, local_date)
    blockers: list[str] = []
    if is_weekend(local_date):
        blockers.append("weekend_automation_blocked")
    if profile.get("linkedin_profile_url") != profile_url:
        blockers.append("profile_key_url_mismatch")
    if not affirmative_provenance(profile):
        blockers.append("missing_affirmative_exact_profile_provenance")
    if profile.get("status") in BLOCKED_PROFILE_STATUSES:
        blockers.append(f"profile_status:{profile.get('status')}")
    if bool(company.get("do_not_contact")):
        blockers.append("company_do_not_contact")
    if not str(company.get("bdr_status") or "").strip():
        blockers.append("missing_current_bdr_status")
    elif str(company.get("bdr_status") or "").strip().upper() in BLOCKING_BDR_STATUSES:
        blockers.append(
            "company_bdr_status_"
            + str(company.get("bdr_status") or "").strip().lower().replace(" ", "_")
        )
    if str(company.get("tal_type") or "").strip().upper() in BLOCKING_TAL_TYPES:
        blockers.append("company_tal_type_rep_engaged")
    if company.get("outreach_status") == "company_inactive_ceased_operations":
        blockers.append("company_inactive")
    blockers.extend(lead_review_blockers(review))
    if state.get("maximum_followups") != 2 or cadence.get("max_followups") != 2:
        blockers.append("maximum_followups_policy_mismatch")
    if cadence.get("enabled") is not True:
        blockers.append("cadence_not_enabled")
    if (cadence.get("message_zero") or {}).get("status") != "sent_verified":
        blockers.append("message_zero_not_verified")
    if followup.get("status") != "pending":
        blockers.append(f"followup_status:{followup.get('status')}")
    due_text = followup.get("due_local_date")
    try:
        due_date = date.fromisoformat(str(due_text))
    except ValueError:
        due_date = None
        blockers.append("missing_or_invalid_due_local_date")
    if due_date and due_date > local_date:
        blockers.append("followup_not_due")
    if step == 2 and (cadence.get("followup_1") or {}).get("status") != "sent_verified":
        blockers.append("followup_1_not_verified")
    return blockers


def lead_id_for_profile(state: dict, profile: dict) -> str | None:
    provenance_lead = (profile.get("provenance") or {}).get(
        "netsuite_lead_internal_id"
    )
    if provenance_lead:
        return str(provenance_lead)
    company = state.get("companies", {}).get(profile.get("company_key"), {})
    lead_ids = [str(value) for value in company.get("netsuite_lead_internal_ids", [])]
    return lead_ids[0] if len(lead_ids) == 1 else None


def followup_item(state: dict, profile_url: str, step: int) -> dict:
    profile = get_profile(state, profile_url)
    cadence = profile.get("cadence") or {}
    followup = cadence.get(f"followup_{step}") or {}
    return {
        "profile_url": profile_url,
        "full_name": profile.get("full_name"),
        "company_name": profile.get("company_name"),
        "company_key": profile.get("company_key"),
        "netsuite_lead_internal_id": lead_id_for_profile(state, profile),
        "step": step,
        "due_local_date": followup.get("due_local_date"),
        "provenance": provenance_summary(profile),
        "required_live_gate": "inspect the exact full conversation history for any reply at any time or any manual message immediately before send",
    }


def gate(
    state: dict,
    profile_url: str,
    step: int,
    local_date: date,
    owner_id: str | None,
) -> dict:
    profile = get_profile(state, profile_url)
    company = state.get("companies", {}).get(profile.get("company_key"), {})
    followup = profile.get("cadence", {}).get(f"followup_{step}", {})
    ledger_blockers = followup_ledger_blockers(
        state, profile_url, step, local_date
    )
    current_lock = lock_status(owner_id)
    lock_blockers = []
    if not current_lock.get("owned_unexpired_and_recent"):
        lock_blockers.append("lock_not_owned_unexpired_and_recent_by_owner_id")
    return {
        "profile_url": profile_url,
        "full_name": profile.get("full_name"),
        "company_name": profile.get("company_name"),
        "company_key": profile.get("company_key"),
        "provenance": provenance_summary(profile),
        "profile_status": profile.get("status"),
        "cadence_enabled": profile.get("cadence", {}).get("enabled"),
        "message_zero_status": profile.get("cadence", {})
        .get("message_zero", {})
        .get("status"),
        "followup_status": followup.get("status"),
        "due_local_date": followup.get("due_local_date"),
        "company_do_not_contact": company.get("do_not_contact"),
        "maximum_followups": state.get("maximum_followups"),
        "local_date": local_date.isoformat(),
        "ledger_blockers": ledger_blockers,
        "lock": current_lock,
        "lock_blockers": lock_blockers,
        "ready_for_visible_reply_check": not ledger_blockers and not lock_blockers,
        "send_authorized_by_this_query": False,
        "remaining_required_gate": (
            "Open the exact LinkedIn conversation and verify the full available "
            "history contains no reply at any time and no manual/unrecorded message; "
            "heartbeat the same lock immediately "
            "before the visible send."
        ),
    }


def record_send(
    state: dict,
    profile_url: str,
    step: int,
    lead_id: str,
    next_due_local_date: str | None,
    owner_id: str | None,
    reply_checked_at: str | None,
) -> dict:
    if step not in (1, 2):
        raise SystemExit("Step must be 1 or 2.")
    require_recent_owned_lock(owner_id)
    verified_reply_check = validate_recent_reply_check(reply_checked_at)
    blockers = followup_ledger_blockers(
        state, profile_url, step, datetime.now().astimezone().date()
    )
    if blockers:
        raise SystemExit("Ledger send gate failed: " + ", ".join(blockers))
    profile = get_profile(state, profile_url)
    cadence = profile.get("cadence")
    if cadence is None:
        raise SystemExit("Missing cadence object.")
    followup = cadence.get(f"followup_{step}")
    if followup is None:
        raise SystemExit(f"Missing cadence step followup_{step}.")
    if followup.get("status") != "pending":
        raise SystemExit(
            f"Duplicate guard: followup_{step} status is "
            f"{followup.get('status')}, not pending."
        )

    timestamp = now_iso()
    followup.update(
        {
            "status": "sent_verified",
            "sent_at": timestamp,
            "verified_at": timestamp,
            "reply_checked_at": verified_reply_check,
            "netsuite_touch": {
                "status": "touch_pending",
                "subject": f"{profile.get('full_name')} - cadence {step}",
                "lead_id": lead_id,
            },
        }
    )

    if step == 1:
        if not next_due_local_date:
            raise SystemExit("next-due-local-date is required for follow-up 1.")
        next_step = cadence.get("followup_2")
        if next_step is None:
            raise SystemExit("Missing cadence step followup_2.")
        next_step["status"] = "pending"
        next_step["due_local_date"] = next_due_local_date
    else:
        profile["status"] = "cadence_complete_two_followups"
        cadence["enabled"] = False
        cadence["acceptance_scan_eligible"] = False
        cadence["max_followups"] = 2
        later = cadence.get("followup_3")
        if later is not None:
            later["status"] = "cancelled_policy_two_followups_max"
            later["enabled"] = False
            later["cancellation_reason"] = (
                "User policy permits exactly two LinkedIn follow-ups; cadence 2 is final."
            )
            for key in (
                "due_local_date",
                "due_rule",
                "sent_at",
                "verified_at",
                "reply_checked_at",
                "netsuite_touch",
            ):
                later.pop(key, None)

    queue_id = f"{profile_url}|cadence|{step}"
    queue = state.setdefault("netsuite_touch_retry_queue", [])
    if not any(item.get("id") == queue_id for item in queue):
        queue.append(
            {
                "id": queue_id,
                "profile_url": profile_url,
                "full_name": profile.get("full_name"),
                "company_name": profile.get("company_name"),
                "cadence_step": step,
                "lead_id": lead_id,
                "subject": f"{profile.get('full_name')} - cadence {step}",
                "touch_type": "TAL LinkedIn Touch",
                "status": "touch_pending",
                "created_at": timestamp,
            }
        )

    save_state(state)
    return {
        "profile_url": profile_url,
        "step": step,
        "status": followup["status"],
        "touch_status": followup["netsuite_touch"]["status"],
        "updated_at": state["updated_at"],
    }


def record_touch(
    state: dict,
    profile_url: str,
    step: int,
    activity_id: str,
    owner_id: str | None,
) -> dict:
    if step not in (1, 2):
        raise SystemExit("Step must be 1 or 2.")
    if not activity_id:
        raise SystemExit("activity-id is required.")
    require_recent_owned_lock(owner_id)
    profile = get_profile(state, profile_url)
    followup = profile.get("cadence", {}).get(f"followup_{step}")
    if followup is None:
        raise SystemExit(f"Missing cadence step followup_{step}.")
    if followup.get("status") != "sent_verified":
        raise SystemExit("Cannot verify NetSuite touch before a verified send.")
    touch = followup.get("netsuite_touch")
    if touch is None:
        raise SystemExit("Missing touch_pending record.")

    touch["status"] = "completed"
    touch["activity_id"] = activity_id
    touch["verified_at"] = now_iso()
    queue_id = f"{profile_url}|cadence|{step}"
    state["netsuite_touch_retry_queue"] = [
        item
        for item in state.get("netsuite_touch_retry_queue", [])
        if item.get("id") != queue_id
    ]
    save_state(state)
    return {
        "profile_url": profile_url,
        "step": step,
        "status": followup["status"],
        "touch_status": touch["status"],
        "activity_id": activity_id,
        "updated_at": state["updated_at"],
    }


def record_lead_review(
    state: dict,
    lead_id: str,
    company_name: str,
    company_key: str,
    sales_rep: str,
    bdr_status: str,
    tal_type: str,
    lsad_date: str,
    communication_status: str,
    owner_id: str | None,
    local_date: date,
) -> dict:
    """Checkpoint the current live NetSuite eligibility read for one exact lead."""
    require_recent_owned_lock(owner_id)
    if not all((lead_id, company_name, company_key, sales_rep, bdr_status, tal_type, lsad_date)):
        raise SystemExit(
            "lead-id, company-name, company-key, sales-rep, bdr-status, tal-type, and "
            "lsad-date are required."
        )
    try:
        date.fromisoformat(lsad_date)
    except ValueError as error:
        raise SystemExit("lsad-date must be YYYY-MM-DD.") from error
    if communication_status not in {COMMUNICATION_CLEAR, COMMUNICATION_BLOCKED}:
        raise SystemExit(
            "communication-status must be clear_or_generic_only or "
            "blocked_substantive_recent_communication."
        )

    normalized_bdr = bdr_status.strip()
    normalized_tal = tal_type.strip()
    normalized_sales_rep = sales_rep.strip()
    blockers: list[str] = []
    if not is_authorized_sales_rep(normalized_sales_rep):
        blockers.append("sales_rep_not_arman_sra")
    if normalized_bdr.upper() in BLOCKING_BDR_STATUSES:
        blockers.append(
            "company_bdr_status_" + normalized_bdr.lower().replace(" ", "_")
        )
    if normalized_tal.upper() in BLOCKING_TAL_TYPES:
        blockers.append("company_tal_type_rep_engaged")
    if communication_status == COMMUNICATION_BLOCKED:
        blockers.append("substantive_recent_communication")

    companies = state.setdefault("companies", {})
    company = companies.get(company_key)
    if company and str(company.get("company_name") or "").strip().casefold() != company_name.strip().casefold():
        raise SystemExit("Company-key collision with a different canonical company name.")
    if company is None:
        company = {
            "company_name": company_name,
            "automation_request_count": 0,
            "profile_keys": [],
            "daily_request_counts": {},
        }
        companies[company_key] = company
    company["bdr_status"] = normalized_bdr
    company["tal_type"] = normalized_tal
    company["sales_rep"] = normalized_sales_rep
    company["last_live_review_at"] = now_iso()
    lead_ids = company.setdefault("netsuite_lead_internal_ids", [])
    if str(lead_id) not in [str(value) for value in lead_ids]:
        lead_ids.append(str(lead_id))

    mission = state.setdefault("full_tal_mission", {})
    leads = mission.setdefault("leads", [])
    lead = mission_lead(state, lead_id)
    if lead is None:
        next_order = max(
            (int(item.get("order") or 0) for item in leads), default=0
        ) + 1
        lead = {"order": next_order, "internal_id": str(lead_id)}
        leads.append(lead)
    current_guard = company_guard(state, company_key, local_date)
    if blockers:
        mission_status = "blocked_current_lead_review"
    elif current_guard["remaining_lifetime_slots"] == 0:
        mission_status = "completed_at_nine"
    else:
        mission_status = "pending_below_nine"
    lead.update(
        {
            "company_name": company_name,
            "company_key": company_key,
            "lsad_date": lsad_date,
            "status": mission_status,
            "live_review": {
                "verified_at": now_iso(),
                "local_date": local_date.isoformat(),
                "lsad_date": lsad_date,
                "sales_rep": normalized_sales_rep,
                "bdr_status": normalized_bdr,
                "tal_type": normalized_tal,
                "communication_status": communication_status,
                "eligible": not blockers,
                "blockers": blockers,
            },
        }
    )
    save_state(state)
    return {
        "lead_id": str(lead_id),
        "company_key": company_key,
        "lsad_date": lsad_date,
        "eligible": not blockers,
        "blockers": blockers,
        "updated_at": state["updated_at"],
    }


def clear_stale_external_blocker_after_success(
    state: dict, profile_url: str, confirmation: str, timestamp: str
) -> dict | None:
    mission = state.setdefault("full_tal_mission", {})
    blocker = mission.get("external_blocker")
    if not isinstance(blocker, dict):
        return None
    cleared = dict(blocker)
    cleared.update(
        {
            "cleared_at": timestamp,
            "clear_reason": "later_visible_connection_request_success",
            "clear_evidence_profile_url": profile_url,
            "clear_visible_confirmation": confirmation,
        }
    )
    mission.setdefault("external_blocker_history", []).append(cleared)
    mission.pop("external_blocker", None)
    mission["status"] = "in_progress"
    return cleared


def record_request(
    state: dict,
    profile_url: str,
    full_name: str,
    company_name: str,
    company_key: str,
    lead_id: str,
    bdr_status: str,
    visible_confirmation: str,
    owner_id: str | None,
    local_date: date,
) -> dict:
    """Checkpoint one visibly confirmed new connection request, atomically."""
    require_recent_owned_lock(owner_id)
    if not (profile_url and profile_url.startswith("https://www.linkedin.com/in/")):
        raise SystemExit("profile-url must be an exact canonical LinkedIn profile URL.")
    if not all((full_name, company_name, company_key, lead_id, visible_confirmation)):
        raise SystemExit("full-name, company-name, company-key, lead-id, and visible-confirmation are required.")
    if not str(bdr_status or "").strip():
        raise SystemExit("A current nonblank BDR status is required.")
    if str(bdr_status).strip().upper() in BLOCKING_BDR_STATUSES:
        raise SystemExit(
            f"{str(bdr_status).strip()} is excluded from LinkedIn automation."
        )
    if profile_url in state.get("profiles", {}):
        raise SystemExit("Duplicate guard: exact profile already exists in ledger.")
    review = current_lead_review(state, lead_id, local_date)
    review_blockers = lead_review_blockers(review)
    if review_blockers:
        raise SystemExit(
            "Current live lead review gate failed: " + ", ".join(review_blockers)
        )
    if str(review.get("bdr_status") or "").strip().casefold() != str(bdr_status).strip().casefold():
        raise SystemExit("BDR status does not match the current live lead review.")
    if str((mission_lead(state, lead_id) or {}).get("company_key") or "") != company_key:
        raise SystemExit("Company key does not match the current live lead review.")

    companies = state.setdefault("companies", {})
    existing = companies.get(company_key)
    if existing and str(existing.get("company_name") or "").strip().casefold() != company_name.strip().casefold():
        raise SystemExit("Company-key collision with a different canonical company name.")
    if not existing:
        companies[company_key] = {
            "company_name": company_name,
            "automation_request_count": 0,
            "profile_keys": [],
            "daily_request_counts": {},
            "bdr_status": bdr_status,
        }
    else:
        existing["bdr_status"] = str(bdr_status).strip()
    guard = company_guard(state, company_key, local_date)
    if not guard["connection_request_allowed_by_ledger"]:
        raise SystemExit("Connection-request guard failed before checkpoint.")
    timestamp = now_iso()
    cleared_blocker = clear_stale_external_blocker_after_success(
        state, profile_url, visible_confirmation, timestamp
    )
    state.setdefault("profiles", {})[profile_url] = {
        "linkedin_profile_url": profile_url,
        "full_name": full_name,
        "company_name": company_name,
        "company_key": company_key,
        "status": "awaiting_acceptance",
        "request_time": timestamp,
        "request_note_sent": True,
        "provenance": {
            "source": "automation_live_action",
            "action": "connection_request_sent",
            "visible_confirmation": visible_confirmation,
            "netsuite_lead_internal_id": str(lead_id),
        },
        "cadence": {
            "enabled": True,
            "acceptance_scan_eligible": True,
            "max_followups": 2,
            "message_zero": {"status": "connection_note_sent_verified", "source": "connection_request_note"},
            "followup_1": {"status": "not_due_pending_acceptance"},
            "followup_2": {"status": "not_due_pending_acceptance"},
        },
    }
    company = companies[company_key]
    profile_keys = company.setdefault("profile_keys", [])
    if profile_url not in profile_keys:
        profile_keys.append(profile_url)
    company["automation_request_count"] = guard["lifetime_request_count"] + 1
    daily_counts = company.setdefault("daily_request_counts", {})
    daily_counts[local_date.isoformat()] = guard["daily_request_count"] + 1
    baseline = int(company.get("full_tal_baseline_request_count") or 0)
    company["new_requests_since_full_tal_baseline"] = max(
        0, company["automation_request_count"] - baseline
    )

    connect_touch_queued = None
    if company["automation_request_count"] % 3 == 0:
        batch_index = company["automation_request_count"] // 3
        completed = company.setdefault("connect_batch_activity_ids", {})
        queue_id = f"{company_key}|connect-batch|{batch_index}"
        if str(batch_index) not in completed:
            queue = state.setdefault("netsuite_connect_touch_queue", [])
            if not any(item.get("id") == queue_id for item in queue):
                queue.append(
                    {
                        "id": queue_id,
                        "kind": "connection_batch",
                        "company_key": company_key,
                        "company_name": company_name,
                        "lead_id": str(lead_id),
                        "batch_index": batch_index,
                        "subject": "LinkedIn connects",
                        "touch_type": "TAL LinkedIn Touch",
                        "status": "touch_pending",
                        "created_at": timestamp,
                    }
                )
            company["linkedin_connect_batch_status"] = "touch_pending"
            connect_touch_queued = queue_id

    lead = mission_lead(state, lead_id)
    if lead is not None:
        lead["verified_automation_request_count"] = company[
            "automation_request_count"
        ]
        lead["status"] = (
            "completed_at_nine"
            if company["automation_request_count"] >= int(
                state.get("company_connection_request_limit") or 9
            )
            else "pending_below_nine"
        )
    save_state(state)
    return {
        "profile_url": profile_url,
        "company_key": company_key,
        "lifetime_request_count": company["automation_request_count"],
        "daily_request_count": daily_counts[local_date.isoformat()],
        "stale_external_blocker_cleared": bool(cleared_blocker),
        "connect_touch_queued": connect_touch_queued,
        "status": "awaiting_acceptance",
        "updated_at": state["updated_at"],
    }


def record_connect_touch(
    state: dict,
    company_key: str,
    batch_index: int,
    lead_id: str,
    activity_id: str,
    owner_id: str | None,
) -> dict:
    """Verify one NetSuite activity for a completed lifetime request block of three."""
    require_recent_owned_lock(owner_id)
    if batch_index < 1:
        raise SystemExit("batch-index must be at least 1.")
    if not all((company_key, lead_id, activity_id)):
        raise SystemExit("company-key, lead-id, and activity-id are required.")
    company = state.get("companies", {}).get(company_key)
    if company is None:
        raise SystemExit("Unknown company-key.")
    minimum_requests = batch_index * 3
    if int(company.get("automation_request_count") or 0) < minimum_requests:
        raise SystemExit("Cannot verify a connect batch before three requests exist.")
    completed = company.setdefault("connect_batch_activity_ids", {})
    existing = completed.get(str(batch_index))
    if existing and str(existing.get("activity_id")) != str(activity_id):
        raise SystemExit("Duplicate guard: batch already has a different activity ID.")
    timestamp = now_iso()
    completed[str(batch_index)] = {
        "activity_id": str(activity_id),
        "lead_id": str(lead_id),
        "verified_at": timestamp,
    }
    queue_id = f"{company_key}|connect-batch|{batch_index}"
    state["netsuite_connect_touch_queue"] = [
        item
        for item in state.get("netsuite_connect_touch_queue", [])
        if item.get("id") != queue_id
    ]
    company["verified_linkedin_connect_batches"] = len(completed)
    still_pending = any(
        item.get("company_key") == company_key
        for item in state.get("netsuite_connect_touch_queue", [])
    )
    company["linkedin_connect_batch_status"] = (
        "touch_pending" if still_pending else "current"
    )
    save_state(state)
    return {
        "company_key": company_key,
        "batch_index": batch_index,
        "activity_id": str(activity_id),
        "status": "completed",
        "updated_at": state["updated_at"],
    }


def repair_company_profile_keys(
    state: dict,
    company_key: str,
    owner_id: str | None,
) -> dict:
    """Deterministically restore one company's exact-profile index."""
    require_recent_owned_lock(owner_id)
    companies = state.get("companies", {})
    company = companies.get(company_key)
    if company is None:
        raise SystemExit("Unknown company-key.")
    expected = sorted(
        profile_url
        for profile_url, profile in state.get("profiles", {}).items()
        if profile.get("company_key") == company_key
        and affirmative_provenance(profile)
    )
    company["profile_keys"] = expected
    save_state(state)
    return {
        "company_key": company_key,
        "profile_keys": expected,
        "profile_key_count": len(expected),
        "updated_at": state["updated_at"],
    }


def stop_profile(
    state: dict,
    profile_url: str,
    reason: str,
    summary: str,
    owner_id: str | None,
) -> dict:
    allowed = {
        "stopped_reply",
        "manual_conversation_skip",
        "stopped_company_mismatch",
    }
    if reason not in allowed:
        raise SystemExit(f"Unsupported stop reason: {reason}")
    if not summary:
        raise SystemExit("summary is required for stop.")
    require_recent_owned_lock(owner_id)

    profile = get_profile(state, profile_url)
    timestamp = now_iso()
    profile["status"] = reason
    profile["stopped_at"] = timestamp
    profile["stop_summary"] = summary
    cadence = profile.get("cadence")
    if cadence is not None:
        cadence["enabled"] = False
        cadence["acceptance_scan_eligible"] = False
        for step in ("followup_1", "followup_2", "followup_3"):
            item = cadence.get(step)
            if item is not None and not str(item.get("status", "")).startswith("sent"):
                item["status"] = "cancelled"

    alert_id = f"{profile_url}|{reason}"
    queue = state.setdefault("reply_alert_queue", [])
    if not any(item.get("id") == alert_id for item in queue):
        queue.append(
            {
                "id": alert_id,
                "profile_url": profile_url,
                "full_name": profile.get("full_name"),
                "company_name": profile.get("company_name"),
                "reason": reason,
                "summary": summary,
                "detected_at": timestamp,
                "status": "unreported",
            }
        )

    save_state(state)
    return {
        "profile_url": profile_url,
        "status": reason,
        "alert_queued": True,
        "updated_at": state["updated_at"],
    }


def state_meta(state: dict) -> dict:
    return {
        "path": str(STATE_PATH),
        "updated_at": state.get("updated_at"),
        "sha256": file_sha256(STATE_PATH),
        "bytes_on_disk": STATE_PATH.stat().st_size,
    }


def acceptance_items(
    state: dict,
    local_date: date,
    after_profile_url: str | None,
) -> tuple[list[dict], int]:
    counts = request_counts(state)
    items: list[dict] = []
    blocked = 0
    for profile_url in sorted(state.get("profiles", {})):
        if after_profile_url and profile_url <= after_profile_url:
            continue
        profile = state["profiles"][profile_url]
        if profile.get("status") != "awaiting_acceptance":
            continue
        cadence = profile.get("cadence") or {}
        guard = company_guard(state, profile.get("company_key"), local_date, counts)
        safe = (
            profile.get("linkedin_profile_url") == profile_url
            and affirmative_provenance(profile)
            and cadence.get("acceptance_scan_eligible") is not False
            and not guard["do_not_contact"]
            and guard["outreach_status"] != "company_inactive_ceased_operations"
        )
        if not safe:
            blocked += 1
            continue
        items.append(
            {
                "profile_url": profile_url,
                "full_name": profile.get("full_name"),
                "company_name": profile.get("company_name"),
                "company_key": profile.get("company_key"),
                "request_note_sent": profile.get("request_note_sent"),
                "request_time": profile.get("request_time"),
                "netsuite_lead_internal_id": lead_id_for_profile(state, profile),
                "provenance": provenance_summary(profile),
                "required_next_gate": (
                    "Find this exact automation-owned profile in LinkedIn Messages. "
                    "The invitation note date is the request date, not the acceptance "
                    "date. If the exact thread now exists because the request was "
                    "accepted, inspect its full history for any reply at any time or "
                    "manual exchange before enrolling "
                    "or sending follow-up 1."
                ),
            }
        )
    return items, blocked


def record_acceptance(
    state: dict,
    profile_url: str,
    lead_id: str,
    visible_confirmation: str,
    owner_id: str | None,
    local_date: date,
) -> dict:
    """Enroll an exact automation-owned request accepted in LinkedIn Messages."""
    require_recent_owned_lock(owner_id)
    if not lead_id or not visible_confirmation.strip():
        raise SystemExit("lead-id and visible-confirmation are required.")
    if is_weekend(local_date):
        raise SystemExit("Weekend automation is blocked.")

    profile = get_profile(state, profile_url)
    if profile.get("linkedin_profile_url") != profile_url:
        raise SystemExit("Exact profile URL mismatch.")
    if not affirmative_provenance(profile):
        raise SystemExit("Acceptance lacks affirmative exact-profile provenance.")
    if profile.get("status") in BLOCKED_PROFILE_STATUSES:
        raise SystemExit(f"Blocked profile status: {profile.get('status')}")

    company = state.get("companies", {}).get(profile.get("company_key"), {})
    if company.get("do_not_contact"):
        raise SystemExit("Company is do-not-contact.")
    if company.get("outreach_status") == "company_inactive_ceased_operations":
        raise SystemExit("Company is inactive.")

    attributable_lead = lead_id_for_profile(state, profile)
    if attributable_lead and str(attributable_lead) != str(lead_id):
        raise SystemExit("Acceptance lead-id does not match exact-profile provenance.")

    cadence = profile.get("cadence") or {}
    first = cadence.get("followup_1") or {}
    if first.get("status") in {"pending", "sent_verified"}:
        return {
            "profile_url": profile_url,
            "status": profile.get("status"),
            "followup_1_status": first.get("status"),
            "already_enrolled": True,
            "updated_at": state.get("updated_at"),
        }
    if profile.get("status") != "awaiting_acceptance":
        raise SystemExit(
            f"Acceptance enrollment requires awaiting_acceptance, got {profile.get('status')}."
        )
    if not profile.get("request_note_sent"):
        raise SystemExit("Request note was not verified; message-zero backfill is required.")

    observed_at = now_iso()
    profile["status"] = "accepted_cadence_active"
    profile["accepted_date"] = local_date.isoformat()
    profile["acceptance_observation"] = {
        "source": "linkedin_message_thread_scan",
        "observed_at": observed_at,
        "visible_confirmation": visible_confirmation.strip(),
        "invitation_note_date_treated_as_request_date": True,
    }
    cadence["enabled"] = True
    cadence["acceptance_scan_eligible"] = False
    cadence["max_followups"] = 2
    cadence["message_zero"] = {
        "status": "sent_verified",
        "source": "connection_request_note",
        "sent_at": profile.get("request_time"),
        "verified_at": observed_at,
    }
    cadence["followup_1"] = {
        "status": "pending",
        # The thread proves acceptance but LinkedIn displays the invitation's
        # request date. Treat unknown-time historical acceptances as backlog due
        # now instead of falsely dating acceptance from that invitation note.
        "due_local_date": local_date.isoformat(),
        "due_rule": "message_thread_acceptance_backlog_due_now",
    }
    cadence["followup_2"] = {"status": "not_due_pending_followup_1"}
    profile["cadence"] = cadence
    save_state(state)
    return {
        "profile_url": profile_url,
        "status": profile["status"],
        "accepted_date": profile["accepted_date"],
        "followup_1_status": cadence["followup_1"]["status"],
        "followup_1_due_local_date": cadence["followup_1"]["due_local_date"],
        "already_enrolled": False,
        "updated_at": state["updated_at"],
    }


def due_followup_items(
    state: dict, local_date: date
) -> tuple[list[dict], list[dict], str | None]:
    ready: list[dict] = []
    blocked: list[dict] = []
    future_dates: list[str] = []
    for profile_url, profile in state.get("profiles", {}).items():
        cadence = profile.get("cadence") or {}
        for step in (1, 2):
            followup = cadence.get(f"followup_{step}") or {}
            if followup.get("status") != "pending":
                continue
            due_text = followup.get("due_local_date")
            try:
                due_date = date.fromisoformat(str(due_text))
            except ValueError:
                due_date = None
            if due_date and due_date > local_date:
                future_dates.append(due_text)
                continue
            blockers = followup_ledger_blockers(
                state, profile_url, step, local_date
            )
            item = followup_item(state, profile_url, step)
            if blockers:
                item["ledger_blockers"] = blockers
                blocked.append(item)
            else:
                ready.append(item)
    key = lambda item: (
        item.get("due_local_date") or "",
        item.get("profile_url") or "",
        item.get("step") or 0,
    )
    ready.sort(key=key)
    blocked.sort(key=key)
    return ready, blocked, min(future_dates) if future_dates else None


def prospecting_summary(state: dict, local_date: date) -> dict:
    schedule = state.get("prospecting_schedule") or {}
    mission = state.get("full_tal_mission") or {}
    next_eligible_text = schedule.get("next_eligible_local_date")
    try:
        next_eligible = date.fromisoformat(str(next_eligible_text))
        schedule_open = local_date >= next_eligible and not is_weekend(local_date)
    except ValueError:
        schedule_open = False
    active_leads = [
        lead
        for lead in mission.get("leads", [])
        if lead.get("status") in ACTIVE_PROSPECTING_STATUSES
    ]
    active_leads.sort(key=lambda lead: int(lead.get("order") or 10**9))
    pointer_id = str((mission.get("next_lead") or {}).get("internal_id") or "")
    next_lead = next(
        (
            lead
            for lead in active_leads
            if str(lead.get("internal_id")) == pointer_id
        ),
        active_leads[0] if active_leads else None,
    )
    external_blocker = mission.get("external_blocker")
    next_reference = None
    if next_lead:
        next_reference = {
            "order": next_lead.get("order"),
            "internal_id": str(next_lead.get("internal_id")),
            "company_name": next_lead.get("company_name"),
            "company_key": next_lead.get("company_key"),
            "status": next_lead.get("status"),
            "prepared_candidate_count": len(
                next_lead.get("prepared_candidates") or []
            ),
            "research_candidate_count": len(
                next_lead.get("research_candidates") or []
            ),
        }
    worklist = prospect_worklist(state, local_date, 1, 0, include_source=False)
    return {
        "local_date": local_date.isoformat(),
        "weekday_automation_allowed": not is_weekend(local_date),
        "lsad_priority_required": True,
        "next_eligible_local_date": next_eligible_text,
        "schedule_open": schedule_open,
        "mission_status": mission.get("status"),
        "remaining_active_leads": len(active_leads),
        "external_blocker": (
            {
                "type": external_blocker.get("type"),
                "detected_at": external_blocker.get("detected_at"),
                "last_rechecked_at": external_blocker.get("last_rechecked_at"),
                "rule": external_blocker.get("rule"),
            }
            if isinstance(external_blocker, dict)
            else None
        ),
        "current_reviewed_eligible_leads": worklist["current_reviewed_eligible_leads"],
        "leads_requiring_current_live_review": worklist[
            "leads_requiring_current_live_review"
        ],
        "connection_submission_allowed": (
            schedule_open
            and not external_blocker
            and worklist["current_reviewed_eligible_leads"] > 0
        ),
        "next_lead": next_reference,
        "detail_query": (
            f"linkedin_followup_state_fast.py lead --lead-id "
            f"{next_reference['internal_id']} --local-date {local_date.isoformat()}"
            if next_reference
            else None
        ),
    }


def prospect_worklist(
    state: dict,
    local_date: date,
    limit: int,
    offset: int = 0,
    include_source: bool = True,
) -> dict:
    """Return a bounded, deterministic prospecting order without exposing the ledger."""
    mission = state.get("full_tal_mission") or {}
    rows: list[dict] = []
    needs_review: list[dict] = []
    blocked: list[dict] = []
    for lead in mission.get("leads", []):
        if lead.get("status") not in ACTIVE_PROSPECTING_STATUSES:
            continue
        company_key = lead.get("company_key")
        if not company_key:
            # Legacy mission rows predate the company-key field.  Resolve only
            # against the ledger's existing canonical keys; never invent a
            # parallel company record.
            needle = "".join(
                ch for ch in str(lead.get("company_name") or "").lower()
                if ch.isalnum()
            )
            matches = [
                key for key, company in state.get("companies", {}).items()
                if "".join(ch for ch in str(company.get("company_name") or "").lower() if ch.isalnum()) == needle
            ]
            company_key = matches[0] if len(matches) == 1 else None
        guard = company_guard(state, company_key, local_date)
        review = current_lead_review(state, str(lead.get("internal_id")), local_date)
        review_blockers = lead_review_blockers(review)
        hard_blockers: list[str] = []
        if guard["do_not_contact"]:
            hard_blockers.append("company_do_not_contact")
        if guard["bdr_status_is_blocked"]:
            hard_blockers.append(
                "company_bdr_status_"
                + str(guard.get("bdr_status") or "").strip().lower().replace(" ", "_")
            )
        if guard["tal_type_is_rep_engaged"]:
            hard_blockers.append("company_tal_type_rep_engaged")
        if review and review.get("communication_status") == COMMUNICATION_BLOCKED:
            hard_blockers.append("substantive_recent_communication")
        if hard_blockers:
            blocked.append(
                {
                    "internal_id": str(lead.get("internal_id")),
                    "company_name": lead.get("company_name"),
                    "company_key": company_key,
                    "blockers": sorted(set(hard_blockers)),
                }
            )
            continue
        if review_blockers:
            needs_review.append(
                {
                    "internal_id": str(lead.get("internal_id")),
                    "company_name": lead.get("company_name"),
                    "company_key": company_key,
                    "automation_request_count": guard["lifetime_request_count"],
                    "review_blockers": review_blockers,
                    "mission_order": lead.get("order"),
                }
            )
            continue
        rows.append({
            "internal_id": str(lead.get("internal_id")),
            "company_name": lead.get("company_name"),
            "company_key": company_key,
            "lsad_date": review.get("lsad_date"),
            "bdr_status": review.get("bdr_status"),
            "tal_type": review.get("tal_type"),
            "communication_status": review.get("communication_status"),
            "automation_request_count": guard["lifetime_request_count"],
            "remaining_lifetime_slots": guard["remaining_lifetime_slots"],
            "remaining_daily_slots": guard["remaining_daily_slots"],
            "mission_status": lead.get("status"),
            "mission_order": lead.get("order"),
        })
    rows.sort(key=lambda row: (
        int(row["automation_request_count"]),
        -date.fromisoformat(row["lsad_date"]).toordinal(),
        row["company_key"] or "",
    ))
    result = {
        "local_date": local_date.isoformat(),
        "selection_rule": (
            "ascending lifetime automation request count (zero first), then "
            "descending current live LSAD/TAL Type Date within each count tier"
        ),
        "current_reviewed_eligible_leads": len(rows),
        "leads_requiring_current_live_review": len(needs_review),
        "blocked_current_leads": len(blocked),
        "offset": offset,
        "worklist": rows[offset : offset + limit],
        "next_review_required": sorted(
            needs_review,
            key=lambda item: (
                int(item.get("automation_request_count") or 0),
                int(item.get("mission_order") or 10**9),
            ),
        )[:limit],
        "blocked": blocked[:limit],
    }
    if include_source:
        result["source"] = state_meta(state)
    return result


def snapshot(
    state: dict,
    local_date: date,
    limit: int,
    after_acceptance_url: str | None,
    include_acceptance_page: bool = False,
) -> dict:
    due, blocked_due, next_future_due = due_followup_items(state, local_date)
    acceptances, blocked_acceptances = acceptance_items(
        state, local_date, after_acceptance_url
    )
    retries = sorted(
        (
            item
            for item in state.get("netsuite_touch_retry_queue", [])
            if item.get("status") != "completed"
        ),
        key=lambda item: (item.get("created_at") or "", item.get("id") or ""),
    )
    connect_retries = sorted(
        (
            item
            for item in state.get("netsuite_connect_touch_queue", [])
            if item.get("status") != "completed"
        ),
        key=lambda item: (item.get("created_at") or "", item.get("id") or ""),
    )
    alerts = sorted(
        (
            item
            for item in state.get("reply_alert_queue", [])
            if item.get("status") == "unreported"
        ),
        key=lambda item: (item.get("detected_at") or "", item.get("id") or ""),
    )
    acceptance_page = acceptances[:limit] if include_acceptance_page else []
    acceptance_more = len(acceptances) > len(acceptance_page)
    return {
        "snapshot_schema_version": 1,
        "source": state_meta(state),
        "local_date": local_date.isoformat(),
        "policy_guards": {
            "timezone": state.get("timezone"),
            "company_lifetime_request_limit": state.get(
                "company_connection_request_limit"
            ),
            "company_daily_request_limit": state.get(
                "daily_company_request_limit"
            ),
            "maximum_followups": state.get("maximum_followups"),
            "exact_profile_affirmative_provenance_required": True,
            "same_owner_lock_heartbeat_required_before_each_action": True,
            "visible_reply_and_manual_conversation_check_required_before_send": True,
        },
        "counts": {
            "due_followups_ready_for_lock_and_live_reply_check": len(due),
            "due_followups_blocked_by_ledger": len(blocked_due),
            "acceptance_checks_after_cursor": len(acceptances),
            "acceptance_checks_blocked_by_ledger": blocked_acceptances,
            "netsuite_touch_retries": len(retries),
            "netsuite_connect_touch_retries": len(connect_retries),
            "unreported_reply_alerts": len(alerts),
        },
        "due_followups": due[:limit],
        "blocked_due_followups": blocked_due[:limit],
        "next_future_due_local_date": next_future_due,
        "acceptance_checks": acceptance_page,
        "acceptance_paging": {
            "included": include_acceptance_page,
            "preferred_scan": (
                "Inspect LinkedIn Messages for newly materialized exact threads from "
                "automation-owned invitations. Ignore the invitation note's displayed "
                "date as an acceptance date. Match each thread to its exact canonical "
                "profile URL, then run the exact profile query before enrollment."
            ),
            "fallback_query": (
                "snapshot --acceptance-page --limit 5 "
                "--after-acceptance-url <cursor>"
            ),
            "more": acceptance_more if include_acceptance_page else bool(acceptances),
            "next_after_profile_url": (
                acceptance_page[-1]["profile_url"]
                if acceptance_page and acceptance_more
                else None
            ),
        },
        "netsuite_touch_retries": retries[:limit],
        "netsuite_connect_touch_retries": connect_retries[:limit],
        "unreported_reply_alerts": alerts[:limit],
        "prospecting": prospecting_summary(state, local_date),
    }


def profile_query(state: dict, profile_url: str, local_date: date) -> dict:
    profile = get_profile(state, profile_url)
    return {
        "source": state_meta(state),
        "profile_url": profile_url,
        "identity": {
            "stored_profile_url": profile.get("linkedin_profile_url"),
            "full_name": profile.get("full_name"),
            "company_name": profile.get("company_name"),
            "company_key": profile.get("company_key"),
        },
        "status": profile.get("status"),
        "request_time": profile.get("request_time"),
        "request_note_sent": profile.get("request_note_sent"),
        "accepted_date": profile.get("accepted_date"),
        "provenance": profile.get("provenance"),
        "affirmative_exact_profile_provenance": affirmative_provenance(profile),
        "cadence": profile.get("cadence"),
        "company_guard": company_guard(
            state, profile.get("company_key"), local_date
        ),
        "required_live_gate": (
            "The query does not inspect LinkedIn. Before any outbound message, "
            "heartbeat the same-owner lock and inspect the exact full conversation "
            "history for a reply at any time or a manual/unrecorded message."
        ),
    }


def profile_name_query(state: dict, full_name: str, local_date: date) -> dict:
    """Return a bounded identity/provenance slice for an exact inbox name."""
    normalized = full_name.strip().casefold()
    if not normalized:
        raise SystemExit("full-name is required for profile-name.")
    matches = []
    for profile_url, profile in state.get("profiles", {}).items():
        if str(profile.get("full_name") or "").strip().casefold() != normalized:
            continue
        cadence = profile.get("cadence") or {}
        matches.append(
            {
                "profile_url": profile_url,
                "full_name": profile.get("full_name"),
                "company_name": profile.get("company_name"),
                "company_key": profile.get("company_key"),
                "netsuite_lead_internal_id": lead_id_for_profile(state, profile),
                "status": profile.get("status"),
                "request_note_sent": profile.get("request_note_sent"),
                "provenance": provenance_summary(profile),
                "message_zero_status": (cadence.get("message_zero") or {}).get("status"),
                "followup_1_status": (cadence.get("followup_1") or {}).get("status"),
                "company_guard": company_guard(state, profile.get("company_key"), local_date),
            }
        )
        if len(matches) >= 10:
            break
    return {
        "source": state_meta(state),
        "query_full_name": full_name,
        "match_count": len(matches),
        "matches": matches,
    }


def company_query(state: dict, company_key: str, local_date: date) -> dict:
    company = state.get("companies", {}).get(company_key)
    if company is None:
        raise SystemExit("Unknown company-key.")
    pending_batches = [
        item
        for item in state.get("netsuite_connect_touch_queue", [])
        if item.get("company_key") == company_key
        and item.get("status") != "completed"
    ]
    return {
        "source": state_meta(state),
        "company_key": company_key,
        "company_name": company.get("company_name"),
        "company_guard": company_guard(state, company_key, local_date),
        "netsuite_lead_internal_ids": company.get("netsuite_lead_internal_ids", []),
        "connect_batch_activity_ids": company.get(
            "connect_batch_activity_ids", {}
        ),
        "pending_connect_batch_touches": pending_batches,
    }


def audit_query(state: dict, local_date: date) -> dict:
    target = local_date.isoformat()
    requests = []
    followups = []
    completed_followup_touches = []
    for profile_url, profile in state.get("profiles", {}).items():
        if affirmative_provenance(profile) and event_local_date(profile) == target:
            requests.append(
                {
                    "profile_url": profile_url,
                    "full_name": profile.get("full_name"),
                    "company_name": profile.get("company_name"),
                }
            )
        cadence = profile.get("cadence") or {}
        for step in (1, 2):
            item = cadence.get(f"followup_{step}") or {}
            sent_at = item.get("sent_at")
            sent_date = None
            if isinstance(sent_at, str):
                try:
                    sent_date = datetime.fromisoformat(
                        sent_at.replace("Z", "+00:00")
                    ).astimezone().date().isoformat()
                except ValueError:
                    sent_date = None
            if sent_date == target:
                row = {
                    "profile_url": profile_url,
                    "full_name": profile.get("full_name"),
                    "company_name": profile.get("company_name"),
                    "step": step,
                    "sent_at": sent_at,
                    "netsuite_touch": item.get("netsuite_touch"),
                }
                followups.append(row)
                if (item.get("netsuite_touch") or {}).get("status") == "completed":
                    completed_followup_touches.append(row)
    worklist = prospect_worklist(state, local_date, 1, 0, include_source=False)
    return {
        "source": state_meta(state),
        "local_date": target,
        "new_connection_requests": requests,
        "new_connection_request_count": len(requests),
        "followups_sent": followups,
        "followups_sent_count": len(followups),
        "completed_followup_touch_count": len(completed_followup_touches),
        "pending_followup_touch_count": len(
            [
                item
                for item in state.get("netsuite_touch_retry_queue", [])
                if item.get("status") != "completed"
            ]
        ),
        "pending_connect_batch_touch_count": len(
            [
                item
                for item in state.get("netsuite_connect_touch_queue", [])
                if item.get("status") != "completed"
            ]
        ),
        "prospecting": worklist,
        "external_blocker": (state.get("full_tal_mission") or {}).get(
            "external_blocker"
        ),
    }


def repair_stale_external_blocker(state: dict, owner_id: str | None) -> dict:
    require_recent_owned_lock(owner_id)
    mission = state.get("full_tal_mission") or {}
    blocker = mission.get("external_blocker")
    if not isinstance(blocker, dict):
        return {"repaired": False, "reason": "no_external_blocker"}
    detected_text = blocker.get("detected_at")
    try:
        detected = datetime.fromisoformat(
            str(detected_text).replace("Z", "+00:00")
        ).astimezone(timezone.utc)
    except ValueError as error:
        raise SystemExit("External blocker has an invalid detected_at timestamp.") from error
    later = []
    for profile_url, profile in state.get("profiles", {}).items():
        if (profile.get("provenance") or {}).get("source") != AFFIRMATIVE_LIVE_SOURCE:
            continue
        request_time = profile.get("request_time")
        if not isinstance(request_time, str):
            continue
        try:
            observed = datetime.fromisoformat(
                request_time.replace("Z", "+00:00")
            ).astimezone(timezone.utc)
        except ValueError:
            continue
        if observed > detected:
            later.append((observed, profile_url, profile))
    if not later:
        raise SystemExit(
            "No later affirmative live request exists; blocker cannot be cleared."
        )
    observed, profile_url, profile = max(later, key=lambda item: item[0])
    cleared = clear_stale_external_blocker_after_success(
        state,
        profile_url,
        str((profile.get("provenance") or {}).get("visible_confirmation") or "visible_success"),
        observed.astimezone().isoformat(),
    )
    save_state(state)
    return {
        "repaired": True,
        "cleared_blocker_type": (cleared or {}).get("type"),
        "evidence_profile_url": profile_url,
        "evidence_request_time": profile.get("request_time"),
        "updated_at": state["updated_at"],
    }


def candidate_summary(state: dict, candidate: dict) -> dict:
    profile_url = candidate.get("linkedin_profile_url")
    existing = state.get("profiles", {}).get(profile_url) if profile_url else None
    qualified = bool(existing and affirmative_provenance(existing))
    blockers: list[str] = []
    if not profile_url:
        blockers.append("missing_exact_profile_url")
    elif existing and qualified:
        blockers.append("already_counted_automation_request")
    elif existing:
        blockers.append("ambiguous_existing_profile_record_requires_review")
    return {
        "priority": candidate.get("priority"),
        "full_name": candidate.get("full_name"),
        "linkedin_profile_url": profile_url,
        "reported_or_verified_current_role": (
            candidate.get("verified_current_role")
            or candidate.get("reported_current_role")
        ),
        "verification_status": candidate.get("verification_status"),
        "connect_available": candidate.get("connect_available"),
        "ledger_record_exists": bool(existing),
        "affirmative_automation_request_provenance": qualified,
        "candidate_blockers": blockers,
    }


def lead_query(state: dict, lead_id: str, local_date: date) -> dict:
    mission = state.get("full_tal_mission") or {}
    lead = next(
        (
            item
            for item in mission.get("leads", [])
            if str(item.get("internal_id")) == str(lead_id)
        ),
        None,
    )
    if lead is None:
        raise SystemExit(f"Unknown full-TAL lead internal ID: {lead_id}")
    merged: list[dict] = []
    seen_urls: set[str] = set()
    for source_name in ("prepared_candidates", "research_candidates"):
        for candidate in lead.get(source_name) or []:
            profile_url = candidate.get("linkedin_profile_url")
            dedupe_key = profile_url or f"{source_name}:{candidate.get('full_name')}"
            if dedupe_key in seen_urls:
                continue
            seen_urls.add(dedupe_key)
            item = candidate_summary(state, candidate)
            item["candidate_source"] = source_name
            merged.append(item)
    merged.sort(
        key=lambda item: (
            int(item.get("priority") or 10**9),
            item.get("linkedin_profile_url") or "",
        )
    )
    guard = company_guard(state, lead.get("company_key"), local_date)
    external_blocker = mission.get("external_blocker")
    return {
        "source": state_meta(state),
        "lead": {
            "order": lead.get("order"),
            "internal_id": str(lead.get("internal_id")),
            "company_name": lead.get("company_name"),
            "company_key": lead.get("company_key"),
            "status": lead.get("status"),
            "exception": lead.get("exception"),
            "research_shortfall": lead.get("research_shortfall"),
            "research_exclusion": lead.get("research_exclusion"),
            "research_source": lead.get("research_source"),
        },
        "company_guard": guard,
        "mission_external_blocker": (
            {
                "type": external_blocker.get("type"),
                "detected_at": external_blocker.get("detected_at"),
                "last_rechecked_at": external_blocker.get("last_rechecked_at"),
                "rule": external_blocker.get("rule"),
            }
            if isinstance(external_blocker, dict)
            else None
        ),
        "connection_submission_allowed": (
            guard["connection_request_allowed_by_ledger"]
            and not external_blocker
        ),
        "ranked_candidates": merged,
        "required_pre_connect_gates": [
            "Acquire or heartbeat the same-owner LinkedIn cadence lock.",
            "Reread this exact lead query immediately before Connect.",
            "Verify exact current-company identity and Connect availability in Chrome.",
            "Recheck the exact-profile ledger and lifetime/daily company counters.",
            "Record only after visible Pending or Sent confirmation.",
        ],
    }


def verify_state(state: dict, local_date: date) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    if state.get("company_connection_request_limit") != 9:
        errors.append("company_connection_request_limit must be 9")
    if state.get("daily_company_request_limit") != 3:
        errors.append("daily_company_request_limit must be 3")
    if state.get("maximum_followups") != 2:
        errors.append("maximum_followups must be 2")
    if state.get("timezone") != "America/Los_Angeles":
        errors.append("timezone must be America/Los_Angeles")

    lifetime, _daily = request_counts(state)
    profiles = state.get("profiles", {})
    for profile_url, profile in profiles.items():
        if profile.get("linkedin_profile_url") != profile_url:
            errors.append(f"profile URL key mismatch: {profile_url}")
        cadence = profile.get("cadence") or {}
        if cadence.get("enabled") is True and not affirmative_provenance(profile):
            errors.append(f"enabled cadence lacks affirmative provenance: {profile_url}")
        if cadence and cadence.get("max_followups") != 2:
            errors.append(f"cadence max_followups mismatch: {profile_url}")
        followup_3 = cadence.get("followup_3") or {}
        if followup_3.get("status") in {"pending", "sent", "sent_verified"}:
            errors.append(f"forbidden third follow-up active: {profile_url}")

    for company_key, company in state.get("companies", {}).items():
        stored_count = int(company.get("automation_request_count") or 0)
        if stored_count != int(lifetime.get(company_key, 0)):
            errors.append(
                f"company count mismatch: {company_key} stored={stored_count} "
                f"exact={int(lifetime.get(company_key, 0))}"
            )
        expected_urls = {
            url
            for url, profile in profiles.items()
            if profile.get("company_key") == company_key
            and affirmative_provenance(profile)
        }
        stored_urls = set(company.get("profile_keys") or [])
        if stored_urls != expected_urls:
            errors.append(f"company profile_keys mismatch: {company_key}")
        if company.get("do_not_contact"):
            for profile_url in stored_urls:
                cadence = (profiles.get(profile_url, {}).get("cadence") or {})
                if cadence.get("enabled") is True:
                    errors.append(
                        f"DNC company has enabled cadence: {company_key}:{profile_url}"
                    )
        if str(company.get("bdr_status") or "").strip().upper() in BLOCKING_BDR_STATUSES:
            for profile_url in stored_urls:
                cadence = (profiles.get(profile_url, {}).get("cadence") or {})
                if cadence.get("enabled") is True:
                    errors.append(
                        "Blocked-BDR company has enabled cadence: "
                        f"{company_key}:{profile_url}"
                    )

    retry_ids = [
        item.get("id") for item in state.get("netsuite_touch_retry_queue", [])
    ]
    if len(retry_ids) != len(set(retry_ids)):
        errors.append("duplicate NetSuite touch retry queue IDs")
    for item in state.get("netsuite_touch_retry_queue", []):
        profile = profiles.get(item.get("profile_url"))
        step = item.get("cadence_step")
        followup = (profile.get("cadence") or {}).get(f"followup_{step}") if profile else None
        if not profile or not followup or followup.get("status") != "sent_verified":
            errors.append(f"invalid NetSuite retry queue item: {item.get('id')}")

    connect_retry_ids = [
        item.get("id") for item in state.get("netsuite_connect_touch_queue", [])
    ]
    if len(connect_retry_ids) != len(set(connect_retry_ids)):
        errors.append("duplicate NetSuite connect-touch queue IDs")
    for item in state.get("netsuite_connect_touch_queue", []):
        company = state.get("companies", {}).get(item.get("company_key"))
        batch_index = int(item.get("batch_index") or 0)
        if (
            not company
            or batch_index < 1
            or int(company.get("automation_request_count") or 0)
            < batch_index * 3
        ):
            errors.append(f"invalid NetSuite connect-touch queue item: {item.get('id')}")

    blocker = (state.get("full_tal_mission") or {}).get("external_blocker")
    if isinstance(blocker, dict):
        try:
            detected = datetime.fromisoformat(
                str(blocker.get("detected_at")).replace("Z", "+00:00")
            ).astimezone(timezone.utc)
        except ValueError:
            errors.append("external blocker detected_at is invalid")
            detected = None
        if detected is not None:
            for profile_url, profile in profiles.items():
                if (profile.get("provenance") or {}).get("source") != AFFIRMATIVE_LIVE_SOURCE:
                    continue
                try:
                    request_time = datetime.fromisoformat(
                        str(profile.get("request_time")).replace("Z", "+00:00")
                    ).astimezone(timezone.utc)
                except ValueError:
                    continue
                if request_time > detected:
                    errors.append(
                        "stale external blocker contradicted by later visible send: "
                        + profile_url
                    )
                    break

    memory_only = sum(
        1
        for profile in profiles.values()
        if (profile.get("provenance") or {}).get("source") == "automation_memory"
    )
    if memory_only:
        warnings.append(
            f"{memory_only} memory-only profile records remain deliberately excluded"
        )
    compact_bytes = len(
        json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ) + 1
    test_snapshot = snapshot(state, local_date, 5, None, False)
    snapshot_bytes = len(
        json.dumps(test_snapshot, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
    )
    if snapshot_bytes > 65_536:
        errors.append(f"default snapshot exceeds 64 KiB: {snapshot_bytes}")
    return {
        "ok": not errors,
        "source": state_meta(state),
        "profile_count": len(profiles),
        "affirmative_profile_count": sum(lifetime.values()),
        "company_count": len(state.get("companies", {})),
        "compact_serialized_bytes": compact_bytes,
        "default_snapshot_bytes": snapshot_bytes,
        "errors": errors,
        "warnings": warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Bounded LinkedIn cadence ledger queries and guarded atomic updates. "
            "Snapshot/profile/lead modes never print the full ledger."
        )
    )
    parser.add_argument(
        "mode",
        choices=(
            "snapshot",
            "profile",
            "profile-name",
            "company",
            "lead",
            "prospect-worklist",
            "audit",
            "gate",
            "verify",
            "compact",
            "record-request",
            "record-lead-review",
            "record-acceptance",
            "record-send",
            "record-touch",
            "record-connect-touch",
            "repair-company-profile-keys",
            "repair-stale-external-blocker",
            "stop",
        ),
    )
    parser.add_argument("--profile-url")
    parser.add_argument("--full-name")
    parser.add_argument("--company-name")
    parser.add_argument("--company-key")
    parser.add_argument("--sales-rep")
    parser.add_argument("--bdr-status")
    parser.add_argument("--tal-type")
    parser.add_argument("--lsad-date")
    parser.add_argument(
        "--communication-status",
        choices=(COMMUNICATION_CLEAR, COMMUNICATION_BLOCKED),
    )
    parser.add_argument("--visible-confirmation")
    parser.add_argument("--step", type=int, choices=(1, 2))
    parser.add_argument("--lead-id")
    parser.add_argument("--local-date")
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--after-acceptance-url")
    parser.add_argument("--acceptance-page", action="store_true")
    parser.add_argument("--owner-id")
    parser.add_argument("--reply-checked-at")
    parser.add_argument("--next-due-local-date")
    parser.add_argument("--activity-id")
    parser.add_argument("--batch-index", type=int)
    parser.add_argument(
        "--reason",
        choices=(
            "stopped_reply",
            "manual_conversation_skip",
            "stopped_company_mismatch",
        ),
    )
    parser.add_argument("--summary")
    args = parser.parse_args()
    if not 1 <= args.limit <= 25:
        raise SystemExit("limit must be between 1 and 25.")

    state = load_state()
    local_date = parse_local_date(args.local_date)
    exit_code = 0
    if args.mode == "snapshot":
        result = snapshot(
            state,
            local_date,
            args.limit,
            args.after_acceptance_url,
            args.acceptance_page,
        )
    elif args.mode == "profile":
        if not args.profile_url:
            raise SystemExit("profile-url is required for profile.")
        result = profile_query(state, args.profile_url, local_date)
    elif args.mode == "profile-name":
        result = profile_name_query(state, args.full_name or "", local_date)
    elif args.mode == "company":
        if not args.company_key:
            raise SystemExit("company-key is required for company.")
        result = company_query(state, args.company_key, local_date)
    elif args.mode == "lead":
        if not args.lead_id:
            raise SystemExit("lead-id is required for lead.")
        result = lead_query(state, args.lead_id, local_date)
    elif args.mode == "prospect-worklist":
        if args.offset < 0:
            raise SystemExit("offset must be non-negative.")
        result = prospect_worklist(state, local_date, args.limit, args.offset)
    elif args.mode == "audit":
        result = audit_query(state, local_date)
    elif args.mode == "gate":
        if not args.profile_url:
            raise SystemExit("profile-url is required for gate.")
        if args.step is None:
            raise SystemExit("step is required for gate.")
        result = gate(
            state,
            args.profile_url,
            args.step,
            local_date,
            args.owner_id,
        )
    elif args.mode == "verify":
        result = verify_state(state, local_date)
        exit_code = 0 if result["ok"] else 1
    elif args.mode == "compact":
        require_recent_owned_lock(args.owner_id)
        validation = verify_state(state, local_date)
        if not validation["ok"]:
            result = {
                "ok": False,
                "saved": False,
                "errors": validation["errors"],
            }
            exit_code = 1
        else:
            before_bytes = STATE_PATH.stat().st_size
            save_state(state)
            compacted = load_state()
            result = {
                "ok": True,
                "saved": True,
                "before_bytes": before_bytes,
                "source": state_meta(compacted),
            }
    elif args.mode == "record-send":
        if not args.profile_url:
            raise SystemExit("profile-url is required for record-send.")
        if args.step is None:
            raise SystemExit("step is required for record-send.")
        if not args.lead_id:
            raise SystemExit("lead-id is required for record-send.")
        result = record_send(
            state,
            args.profile_url,
            args.step,
            args.lead_id,
            args.next_due_local_date,
            args.owner_id,
            args.reply_checked_at,
        )
    elif args.mode == "record-request":
        result = record_request(
            state,
            args.profile_url,
            args.full_name,
            args.company_name,
            args.company_key,
            args.lead_id,
            args.bdr_status,
            args.visible_confirmation,
            args.owner_id,
            local_date,
        )
    elif args.mode == "record-lead-review":
        result = record_lead_review(
            state,
            args.lead_id or "",
            args.company_name or "",
            args.company_key or "",
            args.sales_rep or "",
            args.bdr_status or "",
            args.tal_type or "",
            args.lsad_date or "",
            args.communication_status or "",
            args.owner_id,
            local_date,
        )
    elif args.mode == "record-acceptance":
        if not args.profile_url:
            raise SystemExit("profile-url is required for record-acceptance.")
        result = record_acceptance(
            state,
            args.profile_url,
            args.lead_id or "",
            args.visible_confirmation or "",
            args.owner_id,
            local_date,
        )
    elif args.mode == "record-touch":
        if not args.profile_url:
            raise SystemExit("profile-url is required for record-touch.")
        if args.step is None:
            raise SystemExit("step is required for record-touch.")
        result = record_touch(
            state,
            args.profile_url,
            args.step,
            args.activity_id or "",
            args.owner_id,
        )
    elif args.mode == "record-connect-touch":
        result = record_connect_touch(
            state,
            args.company_key or "",
            args.batch_index or 0,
            args.lead_id or "",
            args.activity_id or "",
            args.owner_id,
        )
    elif args.mode == "repair-company-profile-keys":
        if not args.company_key:
            raise SystemExit("company-key is required for repair-company-profile-keys.")
        result = repair_company_profile_keys(
            state,
            args.company_key,
            args.owner_id,
        )
    elif args.mode == "repair-stale-external-blocker":
        result = repair_stale_external_blocker(state, args.owner_id)
    else:
        if not args.profile_url:
            raise SystemExit("profile-url is required for stop.")
        result = stop_profile(
            state,
            args.profile_url,
            args.reason or "",
            args.summary or "",
            args.owner_id,
        )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()

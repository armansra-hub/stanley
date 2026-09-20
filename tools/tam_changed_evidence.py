"""Canonical changed-evidence handoff. No second grading queue or publisher.

Prepare and register are local evidence operations. Install/apply/activate acquire
the existing workflow locks and defer while a coordinator owns them. Scheduling
belongs to the existing Codex heartbeat, never a process/service in this helper.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import sys
import urllib.parse
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

POLICY = "fresh-full-record-changes-v1"
SHA = re.compile(r"[a-f0-9]{64}")
def require(value, message):
    if not value:
        raise ValueError(message)
def raw(value): return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))+"\n").encode()
def sha(value): return hashlib.sha256(value).hexdigest()
def timestamp(value):
    require(isinstance(value,str),"Source observation timestamp required")
    parsed=datetime.fromisoformat(value.replace("Z","+00:00"));require(parsed.tzinfo is not None,"Source observation timestamp needs timezone")
    return parsed.astimezone(timezone.utc)
def io_path(path):
    """Use Win32 extended-length paths only at the filesystem boundary.

    Canonical locators and immutable references retain ordinary relative paths.
    Callers still validate containment before converting a path for I/O.
    """
    path=Path(path)
    if os.name!="nt": return path
    value=os.path.abspath(path)
    if value.startswith("\\\\?\\"): return Path(value)
    return Path("\\\\?\\UNC\\"+value[2:] if value.startswith("\\\\") else "\\\\?\\"+value)

def read(path): return json.loads(io_path(path).read_bytes())
def write(path, value):
    path=io_path(path); path.parent.mkdir(parents=True,exist_ok=True)
    pending=path.with_name(path.name+".pending"); pending.write_bytes(raw(value)); os.replace(pending,path)
def workspace():
    for parent in Path(__file__).resolve().parents:
        if (parent/"stanley-source/stanley-main/config/tam-regrade-mission.json").is_file(): return parent
    raise ValueError("Canonical Stanley workspace not found")
def inside(root, path):
    result=Path(path).resolve(); require(result.is_relative_to(root.resolve()),"Path escapes canonical workspace"); return result
def reference(root,path):
    path=inside(root,path); return {"path":path.relative_to(root).as_posix(),"sha256":sha(io_path(path).read_bytes())}
def bound(root,ref):
    path=inside(root,root/ref["path"]); require(sha(io_path(path).read_bytes())==ref["sha256"],"Immutable reference changed"); return path
def canonical(root):
    mission_path=root/"stanley-source/stanley-main/config/tam-regrade-mission.json"
    mission=read(mission_path); context_path=bound(root,mission["activeGradingRound"]["context"])
    return mission_path,mission,context_path,read(context_path)
def modules(root):
    sys.path.insert(0,str(root/"tools"))
    import run_tam_single_record as single
    import tam_start_grading_round as initializer
    return single,initializer

@contextmanager
def safe_boundary(root, extra_roots=()):
    """The same OS locks as canonical grading; never kill/restart an owner."""
    single,_=modules(root); _,mission,context_path,context=canonical(root)
    roots={inside(root,root/context["artifact_root"]),*(inside(root,p) for p in extra_roots)}
    previous=context.get("predecessor_context_reference")
    if previous: roots.add(inside(root,root/read(bound(root,previous))["artifact_root"]))
    with ExitStack() as locks:
        for folder in sorted(roots):
            folder.mkdir(parents=True,exist_ok=True)
            locks.enter_context(single.SingleRunnerLock(folder/"foreground_coordinator.lock"))
            for slot in (1,2,3):
                lock=folder/f"grading/pipeline_locks/slot-{slot}.lock"; lock.parent.mkdir(parents=True,exist_ok=True)
                locks.enter_context(single.SingleRunnerLock(lock))
        locks.enter_context(single.SingleRunnerLock())
        require(canonical(root)[1]["activeGradingRound"]["context"]==mission["activeGradingRound"]["context"],"Canonical round changed during admission")
        yield single,mission,context_path,context

def bundle(root, output):
    output=inside(root,output); require(not output.exists(),"Use a new runtime bundle directory"); output.mkdir(parents=True)
    # This remains a prepared, reviewed bundle. It never patches live runtime
    # files and accepts the exact earlier locator/policy extension if installed.
    core_io='''def _evidence_io_path(path: Path) -> Path:
    """Keep canonical paths ordinary; extend only Windows filesystem I/O."""
    if os.name != "nt":
        return Path(path)
    value = os.path.abspath(path)
    if value.startswith("\\\\\\\\?\\\\"):
        return Path(value)
    return Path("\\\\\\\\?\\\\UNC\\\\" + value[2:] if value.startswith("\\\\\\\\") else "\\\\\\\\?\\\\" + value)


'''
    replacements={
      "tam_grading_round.py":[
       ('require(parts == lead or parts == lead + ("snapshots", snapshot),',
        'versioned = (len(parts) == len(lead) + 4 and parts[:len(lead)+3] == lead + ("snapshots", snapshot, "captures") and bool(re.fullmatch(r"[a-f0-9]{64}", parts[-1])))\n    require(parts == lead or parts == lead + ("snapshots", snapshot) or versioned,'),
       ('context.get("evidence_policy") == POLICY',f'context.get("evidence_policy") in (POLICY, "{POLICY}")')],
      "tam_record_core.py":[
       ('value.get("evidence_policy") != EVIDENCE_POLICY',f'value.get("evidence_policy") not in (EVIDENCE_POLICY, "{POLICY}")'),
       ('def sha256_file(path: Path) -> str:',core_io+'def sha256_file(path: Path) -> str:'),
       ('with path.open("rb") as handle:','with _evidence_io_path(path).open("rb") as handle:'),
       ('capture_raw = capture_path.read_bytes()','capture_raw = _evidence_io_path(capture_path).read_bytes()'),
       ('record_raw = record_path.read_bytes()','record_raw = _evidence_io_path(record_path).read_bytes()'),
       ('pdf = PdfReader(str(pdf_path))','pdf = PdfReader(str(_evidence_io_path(pdf_path)))')],
    }
    files=[]
    for name,changes in replacements.items():
        target=root/"tools"/name; original=target.read_bytes(); candidate=original.decode("utf-8")
        for old,new in changes:
            if candidate.count(new)==1: continue
            require(candidate.count(old)==1 and new not in candidate,f"Runtime precondition changed: {name}"); candidate=candidate.replace(old,new)
        compile(candidate,name,"exec")
        source=output/name; source.write_bytes(candidate.encode("utf-8"))
        files.append({"target":target.relative_to(root).as_posix(),"beforeSha256":sha(original),"candidate":reference(root,source)})
    manifest={"schema":"tam-changed-evidence-runtime-bundle","version":1,"files":files,"policy":POLICY}
    write(output/"bundle.json",manifest); return reference(root,output/"bundle.json")

def install(root, bundle_path):
    manifest=read(bundle_path); require(manifest.get("schema")=="tam-changed-evidence-runtime-bundle","Unknown runtime bundle")
    require(manifest.get("version")==1 and {f["target"] for f in manifest["files"]}=={"tools/tam_grading_round.py","tools/tam_record_core.py"} and len(manifest["files"])==2,"Exact versioned-locator runtime bundle required")
    with safe_boundary(root):
        control_path=root/"automation-control.json"; control=read(control_path)
        require(control["tamRegrade"].get("enabled") is False,"Disable dispatch at the verified idle boundary before installing")
        pairs=[]
        for item in manifest["files"]:
            target=inside(root,root/item["target"]); source=bound(root,item["candidate"]); before=target.read_bytes()
            require(sha(before)==item["beforeSha256"],"Runtime changed since offline preparation; rebuild the candidate bundle")
            pairs.append((target,before,source.read_bytes()))
        before_dir=Path(bundle_path).parent/"installed_before"; before_dir.mkdir(exist_ok=False)
        for target,before,_ in pairs: (before_dir/target.name).write_bytes(before)
        installed=[]
        try:
            for target,_,candidate in pairs:
                temporary=target.with_name(target.name+".changed-evidence-pending"); temporary.write_bytes(candidate); os.replace(temporary,target); installed.append(target)
            require(all(sha(target.read_bytes())==sha(candidate) for target,_,candidate in pairs),"Installed bundle readback differs")
        except BaseException:
            for target,before,_ in pairs:
                if target in installed:
                    temporary=target.with_name(target.name+".changed-evidence-rollback"); temporary.write_bytes(before); os.replace(temporary,target)
            raise
        receipt={"status":"installed","bundle":reference(root,bundle_path),"files":[reference(root,t) for t,_,_ in pairs],"beforeImages":[reference(root,before_dir/t.name) for t,_,_ in pairs],"at":datetime.now(timezone.utc).isoformat()}
        write(Path(bundle_path).parent/"installation.json",receipt); return receipt

def fresh_capture_entry(root, destination, inherited, receipt, verified, pdf, text):
    """Derive fresh physical/source metadata; never relabel inherited capture facts."""
    ident=receipt["internal_id"]
    require(receipt.get("status")=="verified" and timestamp(receipt["captured_at_utc"])==timestamp(receipt["observed_at_utc"]),"Fresh source capture date differs")
    require(receipt.get("renderer",{}).get("version")==5,"Fresh capture renderer must be version5")
    require(receipt["pdf"]["sha256"]==sha(pdf) and receipt["pdf"]["bytes"]==len(pdf)
      and receipt["record_text"]["sha256"]==sha(text) and receipt["record_text"]["bytes"]==len(text),"Fresh capture byte metadata differs")
    characters=len(text.decode("utf-8").encode("utf-16-le"))//2
    require(receipt["record_text"]["characters"]==characters,"Fresh text character metadata differs")
    require(verified.get("status")=="verified" and verified.get("every_page_parsed") is True
      and verified.get("internal_id")==ident and verified.get("pdf_sha256")==sha(pdf)
      and verified.get("record_text_sha256")==sha(text) and verified.get("page_count")==receipt["pdf"]["page_count"],"Exact fresh page verification required")
    # The canonical reader still consumes these supplement_* keys. Their own
    # dates/hashes remain unchanged and are explicitly separate from this capture.
    supplement={k:copy.deepcopy(v) for k,v in inherited.items() if k.startswith("supplement_")}
    membership={k:copy.deepcopy(v) for k,v in inherited.items() if k.startswith("membership_")}
    return {**supplement,**membership,"company_id":inherited["company_id"],"internal_id":ident,
      "package_path":destination.relative_to(root).as_posix(),"capture_sha256":sha(io_path(destination/"capture.json").read_bytes()),
      "pdf_sha256":sha(pdf),"pdf_bytes":len(pdf),"pdf_pages":receipt["pdf"]["page_count"],
      "record_text_sha256":sha(text),"record_text_bytes":len(text),"record_text_characters":characters,
      "captured_at":receipt["observed_at_utc"],"observed_at":receipt["observed_at_utc"],"rendered_at":receipt.get("rendered_at_utc"),
      "renderer_version":receipt["renderer"]["version"],"source_snapshot_sha256":receipt["snapshot_sha256"],
      "freshness":"fresh_full_record_capture","provenance_kind":"fresh_observed_print_dom_capture",
      "verification_status":"verified","physical_integrity_verified":True,"verified_at":verified["verified_at_utc"],"pdf_verified_at":verified["verified_at_utc"],
      "physical_checks":{"signature":pdf.startswith(b"%PDF-"),"eof":b"%%EOF" in pdf[-4096:],"hashes":True,"full_text_bytes":True,"exact_id_capture":True,"not_encrypted":True,"page_count":True},
      "anomalies":[],"provenance_receipts":[{"kind":name,**reference(root,destination/name)} for name in ("capture.json","artifact_verification.json","layout_verification.json","page_verification.json","visual_qa_receipt.json")],
      "membership_provenance":{k:copy.deepcopy(receipt[k]) for k in ("snapshot_sha256","table_rows_sha256","saved_search_row_count","source_coordinates","source_record_path","source_latest_page_captured_at_utc") if k in receipt},
      "inherited_supplement_provenance":supplement}

def rebuild_registration(root, registration_path, output):
    """Write corrected derived metadata elsewhere; registered source bytes stay immutable."""
    registration_path=inside(root,registration_path);prior=read(registration_path);change=prior["change"];ident=change["netsuite_internal_id"]
    _,_,_,context=canonical(root);inherited=read(bound(root,context["evidence_index_reference"]))["records"][ident]
    require(inherited["company_id"]==change["company_id"],"Registration exact company differs")
    destination=inside(root,root/prior["entry"]["package_path"])
    corpus=root/"outputs/tam_refresh_2026-07-27/current_lead_records_v6/leads"/ident/"snapshots"/context["snapshot_sha256"]/"captures"
    require(destination.parent==corpus and SHA.fullmatch(destination.name),"Registration is not an exact versioned capture")
    receipt=read(destination/"capture.json");pdf=io_path(destination/"print.pdf").read_bytes();text=io_path(destination/"record_text.txt").read_bytes()
    require(receipt["internal_id"]==ident and receipt["snapshot_sha256"]==context["snapshot_sha256"]
      and prior["entry"]["capture_sha256"]==sha(io_path(destination/"capture.json").read_bytes())
      and prior["entry"]["pdf_sha256"]==sha(pdf) and prior["entry"]["record_text_sha256"]==sha(text)==change["record_text_sha256"]
      and timestamp(receipt["observed_at_utc"])==timestamp(change["captured_at"]),"Registered immutable source binding differs")
    qa_path=bound(root,prior["visualQa"]);verified_path=bound(root,prior["pageVerification"])
    require(qa_path==destination/"visual_qa_receipt.json" and verified_path==destination/"page_verification.json","Registration verification references differ")
    qa=read(qa_path);verified=read(verified_path);pages=receipt["pdf"]["page_count"]
    require(qa.get("status")=="passed" and qa.get("internalId")==ident and qa.get("rendererVersion")==5 and qa.get("pdfSha256")==sha(pdf)
      and qa.get("pages")==pages and qa.get("visuallyInspectedPages")==list(range(1,pages+1)) and qa.get("blockingFindings")==[],"Exact stored visual QA required")
    result={**prior,"entry":fresh_capture_entry(root,destination,inherited,receipt,verified,pdf,text),"supersedesRegistration":reference(root,registration_path)}
    output=inside(root,output);require(not output.is_relative_to(destination) and not io_path(output).exists(),"Use a new metadata output outside the immutable package")
    write(output,result);return {"status":"registration_metadata_rebuilt","registration":reference(root,output),"sourcePackageUnchanged":True,"entry":result["entry"]}

def register_capture(root, preview, change, visual_qa):
    """Promote exact reviewed fresh bytes to a new immutable locator. Never replace
    the package bound to the active round. Existing verifier parses every page."""
    from pypdf import PdfReader
    preview=inside(root,preview); receipt=read(preview/"capture.json"); qa=read(visual_qa)
    ident=change["netsuite_internal_id"]; _,mission,_,context=canonical(root)
    index=read(bound(root,context["evidence_index_reference"]))["records"]
    require(ident in index and index[ident]["company_id"]==change["company_id"],"Capture is not a current exact company")
    require(receipt.get("status")=="verified" and receipt.get("internal_id")==ident and receipt.get("snapshot_sha256")==context["snapshot_sha256"],"Capture ID/snapshot differs")
    pdf=io_path(preview/"print.pdf").read_bytes(); text=io_path(preview/"record_text.txt").read_bytes()
    require(sha(text)==change["record_text_sha256"]==receipt["record_text"]["sha256"],"Fresh full-record bytes differ from change receipt")
    require(sha(pdf)==receipt["pdf"]["sha256"] and pdf.startswith(b"%PDF-") and b"%%EOF" in pdf[-4096:],"Fresh PDF integrity differs")
    reader=PdfReader(io_path(preview/"print.pdf"),strict=True); pages=len(reader.pages)
    require(not reader.is_encrypted and pages==receipt["pdf"]["page_count"] and pages>0,"Full PDF page count differs")
    for page in reader.pages:
        page.extract_text(); contents=page.get_contents()
        if contents is not None: contents.get_data()
    require(qa.get("schema")=="tam-pdf-independent-visual-qa" and qa.get("status")=="passed" and qa.get("internalId")==ident
            and qa.get("rendererVersion")==5 and qa.get("pages")==pages and qa.get("pdfSha256")==sha(pdf) and qa.get("visuallyInspectedPages")==list(range(1,pages+1)) and qa.get("blockingFindings")==[],"Exact all-page visual QA required")
    require(timestamp(receipt.get("observed_at_utc"))==timestamp(change["captured_at"]),"Actual browser observation differs from fresh change receipt")
    # Rendering time is not CRM freshness. Preserve both, and bind the grader's
    # capture date to the actual observed source rather than a later re-render.
    receipt["rendered_at_utc"]=receipt["captured_at_utc"];receipt["captured_at_utc"]=receipt["observed_at_utc"]
    corpus=root/"outputs/tam_refresh_2026-07-27/current_lead_records_v6"
    version=sha(raw({"recordTextSha256":sha(text),"pdfSha256":sha(pdf),"capturedAt":receipt["captured_at_utc"]}))
    destination=inside(corpus,corpus/"leads"/ident/"snapshots"/context["snapshot_sha256"]/"captures"/version)
    require(not io_path(destination).exists(),"Exact immutable capture already exists; inspect/reuse its receipt, never overwrite")
    io_path(destination).mkdir(parents=True)
    for name in ("print.pdf","record_text.txt","print_css.css","artifact_verification.json","layout_verification.json"):
        require(io_path(preview/name).is_file(),f"Capture evidence missing {name}"); shutil.copyfile(io_path(preview/name),io_path(destination/name))
    for field,filename in (("pdf","print.pdf"),("record_text","record_text.txt"),("shared_print_css","print_css.css")):
        require(sha(io_path(destination/filename).read_bytes())==receipt[field]["sha256"],f"Capture {field} changed")
        receipt[field]["path"]=(destination/filename).relative_to(corpus).as_posix()
    write(destination/"capture.json",receipt); shutil.copyfile(io_path(visual_qa),io_path(destination/"visual_qa_receipt.json"))
    artifact=read(destination/"artifact_verification.json"); artifact.update(pdf=receipt["pdf"],record_text=receipt["record_text"])
    write(destination/"artifact_verification.json",artifact)
    single,_=modules(root)
    import tam_verify_captured_pdf_pages as verifier
    prior=verifier.resolve_package_path
    try:
        verifier.resolve_package_path=lambda internal_id,snapshot=None: io_path(destination) if internal_id==ident and snapshot==context["snapshot_sha256"] else prior(internal_id,snapshot)
        verified=verifier.verify(ident,write=True,snapshot=context["snapshot_sha256"])
    finally: verifier.resolve_package_path=prior
    entry=fresh_capture_entry(root,destination,index[ident],receipt,verified,pdf,text)
    result={"change":change,"entry":entry,"visualQa":reference(root,destination/"visual_qa_receipt.json"),"pageVerification":reference(root,destination/"page_verification.json")}
    write(destination/"changed_evidence_registration.json",result); return result

def published_seed(row, base, successor, root, output):
    require(row.get("validation_status")=="passed" and row.get("grade_status")=="published","Only completed validated finals carry forward")
    prior_json=row["grade_provenance_canonical_json"]
    require(sha(prior_json.encode())==row["grade_provenance_sha256"],"Prior provenance bytes differ")
    provenance=json.loads(prior_json); require(provenance==row["grade_provenance"],"Prior provenance object differs")
    require(provenance["pdfSha256"]==base["pdfSha256"],"Unchanged final PDF differs")
    provenance.update(runSlug=successor,copiedFrom={"runId":row["run_id"],"provenanceSha256":row["grade_provenance_sha256"],"publishedAt":row["published_at"]})
    path=output/"inherited_finals"/(row["netsuite_internal_id"]+".json"); write(path,provenance)
    assessment=provenance["assessment"]
    return {**base,"recoveryCohort":"published_complete","historicalPublishedAt":row["published_at"],"historicalReceiptSha256":sha(raw(row)),
      "finalAssessmentLineSha256":sha(raw(assessment)),"publishQueueLineSha256":sha(raw(row)),"finalScore":assessment["final_score"],
      "scoreAdjustNote":assessment.get("score_adjust_note"),"recordDigest":assessment["record_digest"],
      "provenance":{"sha256":sha(path.read_bytes()),"objectPath":path.relative_to(root).as_posix(),"canonicalJson":path.read_text(encoding="utf-8"),"data":provenance},
      "validation":{"status":"passed","validatedBy":assessment["validation"]["validated_by"],"validatedAt":assessment["validation"]["validated_at"]}}

def predecessor_fingerprint(row):
    """Match the server's compact exact predecessor binding, without CRM text."""
    fields=[str(row[k]) for k in ("run_id","checkpoint_seed_id","netsuite_internal_id","company_id","membership_ordinal","table_rows_sha256","pdf_sha256","pdf_object_path","pdf_page_count")]
    require(all(row[k] is not None for k in ("run_id","checkpoint_seed_id","pdf_sha256","pdf_object_path","pdf_page_count")),"Predecessor lacks exact completed seed/PDF binding")
    fields.extend([timestamp(row["pdf_verified_at"]).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),row["grade_status"],row.get("grade_provenance_sha256") or "",sha(row["hold_reason"].encode()) if row.get("hold_reason") is not None else ""])
    return sha("\n".join(fields).encode())

def successor_initialize_payload(plan, records, registrations, manifest_json):
    manifest=plan["seedManifest"];common={"runSlug":plan["runSlug"],"actorKey":plan["actorKey"]}
    seeds={r["netsuiteInternalId"]:r for r in plan["seedRows"]}
    payload={"action":"evidence_successor_initialize","predecessorRunSlug":plan["oldRun"]["slug"],"predecessorSeedId":plan["oldRun"]["completed_checkpoint_seed_id"],
      "bootstrap":{k:plan[k] for k in ("runSlug","searchId","mission","sourceTotal","sourceSnapshotSha256")},
      "seed":{**common,"manifestSha256":plan["seedManifestSha256"],"manifestObjectPath":plan["seedManifestPath"],**{k:manifest[k] for k in ("releaseCommit","expectedCounts","cohortHashes","captureSnapshotHashes","sourceHashes")}},
      "manifestCanonicalJson":manifest_json,"expectedPredecessorBindings":[{"internalId":r["netsuite_internal_id"],"sha256":predecessor_fingerprint(r)} for r in sorted(records,key=lambda r:r["membership_ordinal"])],
      "changes":[{"receiptId":r["change"]["id"],"internalId":r["change"]["netsuite_internal_id"],"recordTextSha256":r["entry"]["record_text_sha256"],**{k:seeds[r["change"]["netsuite_internal_id"]][k] for k in ("pdfObjectPath","pdfSha256","pdfPageCount","pdfVerifiedAt","pdfCaptureSnapshotSha256")}} for r in registrations]}
    require(sha(manifest_json.encode())==plan["seedManifestSha256"],"Exact seed manifest bytes differ")
    require(len(raw(payload))<=4_000_000,"Successor initialization payload exceeds bounded transport")
    return payload

def prepare(root, board_path, records_path, registrations_path, release_commit, output):
    _,mission,context_path,context=canonical(root); _,initializer=modules(root)
    board=read(board_path); records=read(records_path); registrations=read(registrations_path)
    require(board["run"]["slug"]==context["run_slug"] and board["run"]["completed_checkpoint_seed_id"]==context["checkpoint_seed_id"],"Predecessor board/context differs")
    require(board["counts"]["grade_reading"]==0 and board["counts"]["grade_final"]==0,"Prepare only after admitted record work finishes")
    require(re.fullmatch(r"[a-f0-9]{40}",release_commit),"Exact deployment commit required")
    index=read(bound(root,context["evidence_index_reference"])); by_id={r["netsuite_internal_id"]:r for r in records}
    require(len(records)==len(by_id)==context["membership_count"] and set(by_id)==set(index["records"]),"Exact current board must cover canonical membership")
    changes={r["change"]["netsuite_internal_id"]:r for r in registrations}
    require(changes and len(changes)==len(registrations)<=200 and set(changes)<=set(by_id),"One to 200 distinct exact changed-ID registrations required")
    output=inside(root/"outputs/tam_refresh_2026-09-14",output); require(not output.exists(),"Use a new immutable successor directory"); output.mkdir(parents=True)
    changed_hash=sha(raw(registrations)); successor="ars-bs-tam-changes-"+datetime.now(timezone.utc).strftime("%Y%m%d")+"-"+changed_hash[:12]
    new_index=copy.deepcopy(index)
    for ident,item in changes.items():
        change=item["change"]; entry=item["entry"]; old=by_id[ident]
        require(change["predecessor_run_id"]==board["run"]["id"] and change["predecessor_provenance_sha256"]==old["grade_provenance_sha256"] and old["grade_status"]=="published","Changed source must bind this predecessor's completed final")
        require(entry["company_id"]==old["company_id"] and entry["record_text_sha256"]==change["record_text_sha256"]!=old["grade_provenance"]["recordTextSha256"],"Changed evidence identity/hash differs")
        require(entry["package_path"]!=index["records"][ident]["package_path"],"Fresh evidence cannot overwrite a predecessor locator")
        package=inside(root,root/entry["package_path"])
        for filename,key in (("capture.json","capture_sha256"),("print.pdf","pdf_sha256"),("record_text.txt","record_text_sha256")):
            require(sha(io_path(package/filename).read_bytes())==entry[key],"Registered capture bytes changed")
        bound(root,item["visualQa"]); bound(root,item["pageVerification"])
        new_index["records"][ident]=entry
    new_index["changed_evidence_registration_sha256"]=changed_hash
    write(output/"evidence_index.json",new_index); write(output/"registrations.json",registrations)
    authorization={"approved":True,"scope":"canonical-targeted-changed-evidence-successor","source":"User-authorized G15 continuous CRM change regrading; retain full read and independent validation","predecessorContext":reference(root,context_path)}
    write(output/"authorization.json",authorization)
    draft={**context,"run_slug":successor,"checkpoint_seed_id":None,"artifact_root":output.relative_to(root).as_posix(),
      "assessment_date":datetime.now(timezone.utc).date().isoformat(),"evidence_policy":POLICY,"evidence_index_reference":reference(root,output/"evidence_index.json"),
      "authorization":reference(root,output/"authorization.json"),"predecessor_context_reference":reference(root,context_path),"changed_evidence_reference":reference(root,output/"registrations.json")}
    write(output/"context.prepared.json",draft)
    membership=[]; seeds=[]
    for old in sorted(records,key=lambda r:r["membership_ordinal"]):
        ident=old["netsuite_internal_id"]; entry=new_index["records"][ident]
        membership.append({"netsuiteInternalId":ident,"companyName":old["company_name"],"membershipStatus":old["membership_status"],"tableRows":old["table_rows"],"sourceCoordinates":old["source_coordinates"],"savedSearchRowCount":old["saved_search_row_count"],"tableRowsSha256":old["table_rows_sha256"]})
        base={"netsuiteInternalId":ident,"membershipOrdinal":old["membership_ordinal"],"tableRowsSha256":old["table_rows_sha256"],"pdfObjectPath":entry["package_path"]+"/print.pdf",
          "pdfSha256":entry["pdf_sha256"],"pdfPageCount":entry["pdf_pages"],"pdfVerifiedAt":entry.get("pdf_verified_at",old["pdf_verified_at"]),"pdfCaptureSnapshotSha256":entry["source_snapshot_sha256"]}
        if ident not in changes and old["grade_status"]=="published": seed=published_seed(old,base,successor,root,output)
        elif old["grade_status"]=="hold": seed={**base,"recoveryCohort":"active_hold","holdFileSha256":sha(raw(old)),"holdReason":old["hold_reason"]}
        else: require(old["grade_status"] in ("pending","published"),"Predecessor has unfinished accepted work"); seed={**base,"recoveryCohort":"unrepresented"}
        seeds.append(seed)
    ids=[r["netsuiteInternalId"] for r in seeds]; hash_ids=initializer.id_hash
    cohorts={name:[r["netsuiteInternalId"] for r in seeds if r["recoveryCohort"]==code] for name,code in (("publishedComplete","published_complete"),("activeHold","active_hold"),("unrepresented","unrepresented"))}
    counts={"currentTotal":len(ids),"removedTotal":0,"pdfVerified":len(ids),"legacySchemaRecovery":0,"lostStagingRecovery":0,**{k:len(v) for k,v in cohorts.items()}}
    hashes={"current":hash_ids(ids),"removed":hash_ids([]),"legacySchemaRecovery":hash_ids([]),"lostStagingRecovery":hash_ids([]),**{k:hash_ids(v) for k,v in cohorts.items()}}
    refs={"context":reference(root,output/"context.prepared.json"),"evidenceIndex":reference(root,output/"evidence_index.json"),"registrations":reference(root,output/"registrations.json"),"oldBoard":reference(root,board_path),"oldRecords":reference(root,records_path),"predecessorContext":reference(root,context_path)}
    manifest={"schema":"tam-successor-checkpoint-manifest","version":1,"runSlug":successor,"historicalRunSlug":context["run_slug"],"expectedCounts":counts,"cohortHashes":hashes,
      "captureSnapshotHashes":{"current":context["snapshot_sha256"],"allowedPrior":sorted({r["pdfCaptureSnapshotSha256"] for r in seeds}-{context["snapshot_sha256"]})},
      "sourceHashes":{k:v["sha256"] for k,v in refs.items()},"evidencePolicy":POLICY,"rubricSha256":context["rubric_sha256"],"assessmentDate":draft["assessment_date"],
      "passedEvaluationWindowsRemainPositive":True,"checkpointRowsSha256":sha(raw(seeds)),"releaseCommit":release_commit}
    write(output/"seed_manifest.json",manifest)
    mission_new={**mission,"runSlug":successor,"changedEvidence":{"predecessorRunId":board["run"]["id"],"evidenceIndexSha256":refs["evidenceIndex"]["sha256"],"registrationSha256":changed_hash},
      "activeGradingRound":{"runSlug":successor,"status":"initializing","context":refs["context"],"historicalRunSlug":context["run_slug"],"rubricSha256":context["rubric_sha256"],"assessmentDate":draft["assessment_date"],"evidencePolicy":POLICY,"passedEvaluationWindowsRemainPositive":True}}
    plan={"schema":"tam-grading-round-initialization-plan","version":1,"runSlug":successor,"createdAt":datetime.now(timezone.utc).isoformat(),"references":refs,"oldRun":board["run"],"mission":mission_new,
      "sourceTotal":mission["membershipSource"]["currentSnapshot"]["sourceRows"],"sourceSnapshotSha256":context["snapshot_sha256"],"searchId":mission["membershipSource"]["currentSnapshot"]["savedSearchId"],
      "companies":{r["netsuite_internal_id"]:r["company_id"] for r in records},"membership":membership,"seedRows":seeds,"seedManifest":manifest,"seedManifestPath":(output/"seed_manifest.json").relative_to(root).as_posix(),
      "seedManifestSha256":sha(raw(manifest)),"actorKey":"codex","changedEvidenceBindings":[{"receiptId":r["change"]["id"],"recordTextSha256":r["entry"]["record_text_sha256"],"pdfSha256":r["entry"]["pdf_sha256"]} for r in registrations]}
    plan["successorInitialize"]=successor_initialize_payload(plan,records,registrations,(output/"seed_manifest.json").read_bytes().decode())
    write(output/"plan.json",plan); return {"status":"prepared","plan":reference(root,output/"plan.json"),"runSlug":successor,"counts":counts}

@contextmanager
def initializer_adapter(initializer,plan):
    """Reuse the canonical fenced transport; extend only the successor allowlist
    and final readback for unchanged historical published cohorts in this process."""
    successor=plan["runSlug"]; predecessor=plan["oldRun"]["slug"]
    previous=initializer.PREDECESSORS.copy(); verify=initializer.verify_board_records; operations=initializer.operations
    verify_ack=initializer.verify_ack; reconcile=initializer.reconcile
    initializer.PREDECESSORS[successor]=predecessor
    def verify_rows(rows, expected, final=False):
        verify(rows,expected,False)
        if not final: return
        by_id={r["netsuite_internal_id"]:r for r in rows}
        for seed in expected["seedRows"]:
            row=by_id[seed["netsuiteInternalId"]]
            initializer.verify_pdf(row,{"netsuiteInternalId":seed["netsuiteInternalId"],"objectPath":seed["pdfObjectPath"],"sha256":seed["pdfSha256"],"pageCount":seed["pdfPageCount"],"verifiedAt":seed["pdfVerifiedAt"]},expected["companies"])
            require(row["membership_ordinal"]==seed["membershipOrdinal"] and row["recovery_cohort"]==seed["recoveryCohort"],"Successor seed cohort differs")
            status={"published_complete":"published","active_hold":"hold","unrepresented":"pending"}[seed["recoveryCohort"]]
            require(row["grade_status"]==status,"Successor grading state differs")
            if status=="published": require(row["grade_provenance_sha256"]==seed["provenance"]["sha256"] and row["final_score"]==seed["finalScore"] and row["record_digest"]==seed["recordDigest"],"Carried final differs")
            else: require(row.get("final_score") is None and row.get("grade_provenance_sha256") is None and row.get("hold_reason")==seed.get("holdReason"),"Unexpected successor grade or hold")
    def steps(expected):
        for step in operations(expected):
            if expected["oldRun"]["status"]=="complete" and step.get("action")=="bootstrap" and step.get("runSlug")==predecessor: continue
            if expected.get("successorInitialize"):
                if step.get("action")=="bootstrap" and step.get("runSlug")==successor:
                    yield expected["successorInitialize"]; continue
                if step.get("action") in ("membership","pdf","checkpoint_seed_begin"): continue
            yield step
    def ack(payload,result,expected,state):
        if payload.get("action")!="evidence_successor_initialize":return verify_ack(payload,result,expected,state)
        bootstrap=payload["bootstrap"];run=result.get("run",{})
        for key,field in (("runSlug","slug"),("searchId","search_id"),("mission","mission"),("sourceTotal","source_total"),("sourceSnapshotSha256","source_snapshot_sha256")):
            require(run.get(field)==bootstrap[key],"Copied successor run identity differs")
        require(result.get("copied")==len(expected["companies"]) and result.get("changed")==len(payload["changes"]),"Copied successor counts differ")
        verify_ack({"action":"checkpoint_seed_begin"},result,expected,state)
    def recover(directory,*,api=None):
        directory=Path(directory);state=read(directory/"state.json");pending=state.get("pending_action") or {}
        if pending.get("action")!="evidence_successor_initialize":return reconcile(directory,api=api)
        with initializer.initialization_lock(directory):
            state=read(directory/"state.json");expected=read(directory/"plan.json");pending=state.get("pending_action") or {}
            require(pending.get("action")=="evidence_successor_initialize" and sha((directory/"plan.json").read_bytes())==state["plan_sha256"],"Pending successor plan differs")
            index=pending["operation_index"];payload=list(steps(expected))[index]
            require(payload.get("action")==pending["action"] and sha(initializer.raw_json(payload))==pending["payload_sha256"],"Pending successor payload differs")
            response_path=directory/f"response_{index:05d}.json"
            require(response_path.exists(),"Successor token response unavailable; manual exact seed-token recovery required, no replay")
            result=read(response_path);ack(payload,result,expected,state)
            status=initializer.board(api or initializer.Api(),expected["runSlug"]);seed=status.get("checkpointSeed") or {}
            require(seed.get("id")==state["seed_id"] and seed.get("manifest_sha256")==expected["seedManifestSha256"] and seed.get("status")=="building","Pending successor seed identity not proven")
            require(status.get("run",{}).get("id")==result["run"].get("id"),"Pending successor run differs")
            receipt=directory/f"reconciled_{index:05d}.json"
            initializer.exclusive(receipt,{"at":datetime.now(timezone.utc).isoformat(),"pending":pending,"result":result,"readOnlyVerified":True})
            state.update(next_operation=index+1,pending_action=None,status="running",last_reconciliation=receipt.name)
            initializer.atomic(directory/"state.json",state);return initializer.public_state(state)
    initializer.verify_board_records=verify_rows; initializer.operations=steps;initializer.verify_ack=ack;initializer.reconcile=recover
    try: yield
    finally: initializer.PREDECESSORS.clear(); initializer.PREDECESSORS.update(previous); initializer.verify_board_records=verify; initializer.operations=operations;initializer.verify_ack=verify_ack;initializer.reconcile=reconcile

def apply(root,directory,maximum=250,reconcile=False):
    directory=inside(root,directory); plan=read(directory/"plan.json"); _,initializer=modules(root)
    with safe_boundary(root,(directory,)):
        require(read(root/"automation-control.json")["tamRegrade"].get("enabled") is False,"Dispatch must remain disabled during successor admission")
        api=initializer.Api(); board=initializer.board(api,plan["oldRun"]["slug"])
        require(board["counts"]["grade_reading"]==0 and board["counts"]["grade_final"]==0,"Predecessor retains unfinished claims/finals")
        if not (directory/"state.json").exists():
            prior=read(bound(root,plan["references"]["oldRecords"]))
            fresh=initializer.records(api,plan["oldRun"]["slug"],current="true")
            require(sorted(prior,key=lambda r:r["netsuite_internal_id"])==sorted(fresh,key=lambda r:r["netsuite_internal_id"]),"Predecessor exact records changed since preparation")
        with initializer_adapter(initializer,plan):
            return initializer.reconcile(directory,api=api) if reconcile else initializer.apply(directory,sha((directory/"plan.json").read_bytes()),maximum,api=api)

def activate(root,directory):
    directory=inside(root,directory); plan=read(directory/"plan.json"); state=read(directory/"state.json"); _,initializer=modules(root)
    if (directory/"activation_receipt.json").exists():
        result=read(directory/"activation_receipt.json")
        require(canonical(root)[1]["activeGradingRound"]["context"]==result["context"],"Activation receipt belongs to another active round")
        return result
    require(state.get("status")=="complete" and not state.get("pending_action"),"Exact canonical initialization/readback must be complete")
    with safe_boundary(root,(directory,)):
        control_path=root/"automation-control.json"; control=read(control_path); require(control["tamRegrade"].get("enabled") is False,"Dispatch must remain disabled during activation")
        api=initializer.Api(); status=initializer.board(api,plan["runSlug"])
        require(status["run"]["completed_checkpoint_seed_id"]==state["checkpoint_seed_id"] and status["checkpointSeed"]["manifest_sha256"]==plan["seedManifestSha256"],"Live successor seed differs")
        with initializer_adapter(initializer,plan): initializer.verify_board_records(initializer.records(api,plan["runSlug"]),plan,True)
        payload={"action":"evidence_change_admit","runSlug":plan["runSlug"],"evidenceIndexSha256":plan["references"]["evidenceIndex"]["sha256"],"bindings":plan["changedEvidenceBindings"]}
        require(len(payload["bindings"])<=200,"Activate at most 200 exact changed records per successor")
        intent=directory/"changed_admission.intent.json"; response=directory/"changed_admission.response.json"
        if not intent.exists():
            write(intent,{"payloadSha256":sha(raw(payload)),"at":datetime.now(timezone.utc).isoformat()})
            result=api.request("POST",initializer.ENDPOINT,payload); write(response,result)
        require(response.exists() and read(intent)["payloadSha256"]==sha(raw(payload)),"Uncertain admission: retain intent and reconcile exact receipts, never replay")
        require(read(response).get("admitted")==len(payload["bindings"]),"Exact changed-evidence admission acknowledgment differs")
        draft=read(directory/"context.prepared.json"); draft["checkpoint_seed_id"]=state["checkpoint_seed_id"]; write(directory/"context.active.json",draft)
        context_ref=reference(root,directory/"context.active.json")
        authorization={"approved":True,"runSlug":plan["runSlug"],"contextSha256":context_ref["sha256"],"maxConcurrentRecords":3,"eachRecordSerialReaderThenValidator":True,"source":"Existing user-authorized three-slot canonical grading, new evidence only"}
        write(directory/"parallel_execution_authorization.json",authorization)
        mission_path,old,_,_=canonical(root); live_path=root/"stanley-source/stanley-main/config/tam-regrade-live-state.json"; live=read(live_path)
        before=directory/"activation_before"
        if before.exists():
            require(all(path.read_bytes()==(before/path.name).read_bytes() for path in (mission_path,live_path,control_path)),"Incomplete activation differs from saved before-images; reconcile before continuing")
        else:
            before.mkdir()
            for path in (mission_path,live_path,control_path): shutil.copyfile(path,before/path.name)
        active={**plan["mission"]["activeGradingRound"],"status":"grading","context":context_ref,"checkpointSeedId":state["checkpoint_seed_id"],"jevAnnotationsRequired":True,"currentTotal":len(plan["companies"]),
          "evidenceIndex":plan["references"]["evidenceIndex"],"authorization":reference(root,directory/"authorization.json")}
        try:
            write(mission_path,{**old,"runSlug":plan["runSlug"],"activeGradingRound":active,"changedEvidence":plan["mission"]["changedEvidence"]})
            write(live_path,{**live,"runSlug":plan["runSlug"],"activeGradingRound":active,"updatedAt":datetime.now(timezone.utc).isoformat()})
            # Read the freshly installed runtime in this process only. The
            # coordinator still cannot dispatch until control is enabled last.
            import importlib, tam_grading_round, tam_record_core
            importlib.reload(tam_grading_round); importlib.reload(tam_record_core)
            verified=tam_grading_round.load_round_context(directory/"context.active.json",mission_path=mission_path,root=root)
            tam_record_core.configure_round(verified)
            control["tamRegrade"].update(enabled=True,mode="checkpointed-parallel-records",maxConcurrentRecords=3,parallelAuthorization=reference(root,directory/"parallel_execution_authorization.json"))
            write(control_path,control)
        except BaseException:
            for path in (mission_path,live_path,control_path):
                temporary=path.with_name(path.name+".activation-rollback"); temporary.write_bytes((before/path.name).read_bytes()); os.replace(temporary,path)
            write(directory/"activation_rollback.json",{"status":"rolled_back","at":datetime.now(timezone.utc).isoformat()})
            raise
        result={"status":"active_canonical_successor","runSlug":plan["runSlug"],"context":context_ref,"changedIds":len(plan["changedEvidenceBindings"]),"coordinatorLaunched":False}
        write(directory/"activation_receipt.json",result); return result

def refresh_snapshot(root,directory,row_observation=None):
    """One read-only cloud snapshot and one browser-capture target. The only
    rotation state is an offset in the canonical current board, never a queue."""
    directory=inside(root/"outputs/tam_refresh_2026-09-14",directory); directory.mkdir(parents=True,exist_ok=True)
    _,_,_,context=canonical(root); _,initializer=modules(root); api=initializer.Api()
    state_path=directory/"refresh_state.json"; state=read(state_path) if state_path.exists() else {"offset":0,"turn":0}
    target_path=directory/"refresh_target.json"
    if target_path.exists() and not (directory/"refresh_result.json").exists():
        target=read(target_path); require(target["runSlug"]==context["run_slug"],"Unfinished refresh target belongs to prior round")
        return {"nextStep":"capture_exact_print_view","target":reference(root,target_path),"internalId":target["internalId"],"resumed":True}
    board=initializer.board(api,context["run_slug"])
    changes=api.request("GET",initializer.ENDPOINT+"?view=evidence_changes")
    actionable=[r for r in changes["changes"] if r["status"]=="observed" and r["predecessor_run_id"]==board["run"]["id"]]
    if actionable:
        write(directory/"change_snapshot.json",actionable)
    if state.get("runSlug")!=context["run_slug"]: state.update(offset=0,runSlug=context["run_slug"])
    priority=None
    if row_observation is not None and state.get("turn",0)%3!=2:
        observation=read(row_observation); ident=str(observation["internalId"])
        url=urllib.parse.urlparse(observation["sourceUrl"])
        require(url.hostname=="nlcorp.app.netsuite.com" and observation.get("savedSearchName")=="ARS - All Leads by LSAD" and isinstance(observation.get("rowText"),str),"Exact current LSAD observation required")
        rows=initializer.records(api,context["run_slug"],ident,current="true")
        row_hash=sha(observation["rowText"].encode())
        if len(rows)==1 and rows[0]["grade_status"]=="published" and state.get("priorityRows",{}).get(ident)!=row_hash:
            priority=(rows[0],{**reference(root,row_observation),"rowSha256":row_hash})
    offset=int(state["offset"])
    query={"run":context["run_slug"],"view":"records","current":"true","limit":100,"offset":offset}
    page=api.request("GET",initializer.ENDPOINT+"?"+urllib.parse.urlencode(query))
    eligible=[(i,r) for i,r in enumerate(page["records"]) if r["grade_status"]=="published" and r["validation_status"]=="passed"]
    if priority: row,source=priority; after=offset
    elif eligible: index,row=eligible[0]; after=offset+index+1; source=None
    else:
        state.update(offset=0 if offset+len(page["records"])>=page["total"] else offset+len(page["records"]),turn=state.get("turn",0)+1)
        write(state_path,state)
        return {"nextStep":"wait_for_next_heartbeat","reason":"No published account on bounded rotation page","observedChanges":len(actionable),"cursor":state["offset"]}
    ident=row["netsuite_internal_id"]
    target={"runSlug":context["run_slug"],"seedId":context["checkpoint_seed_id"],"companyId":row["company_id"],"internalId":ident,
      "predecessorProvenanceSha256":row["grade_provenance_sha256"],"previousRecordTextSha256":row["grade_provenance"]["recordTextSha256"],"record":row,
      "nextOffset":0 if after>=page["total"] else after,"prioritySource":source,"printUrl":f"https://nlcorp.app.netsuite.com/app/common/entity/custjob.nl?id={ident}&print=T",
      "sourceRecordPath":f"outputs/tam_refresh_2026-09-14/current_snapshot_evidence/records/{ident}.json","selectedAt":datetime.now(timezone.utc).isoformat()}
    if target_path.exists():
        archive=directory/"refresh_history"/sha(target_path.read_bytes()); archive.mkdir(parents=True,exist_ok=True)
        for name in ("refresh_target.json","refresh_result.json","upload.intent.json","upload.response.json"):
            path=directory/name
            if path.exists(): shutil.move(str(path),str(archive/name))
        state["lastReceipt"]=reference(root,archive/"refresh_result.json");write(state_path,state)
    write(target_path,target)
    return {"nextStep":"capture_exact_print_view","target":reference(root,target_path),"internalId":ident,"printUrl":target["printUrl"],"sourceRecordPath":target["sourceRecordPath"],"observedChanges":len(actionable),"coordinatorBusy":board["counts"]["grade_reading"]>0}

def refresh_ingest(root,directory,dom_path):
    """Push the exact full browser observation once, read back its hash, and
    advance the successful refresh rotation. No PDF/grade is overwritten."""
    directory=inside(root,directory); target=read(directory/"refresh_target.json"); dom=read(dom_path)
    if (directory/"refresh_result.json").exists():
        prior=read(directory/"refresh_result.json")
        require(prior["internalId"]==target["internalId"] and prior["dom"]==reference(root,dom_path),"Completed refresh has different evidence")
        return {k:v for k,v in prior.items() if k!="change"}
    _,_,_,context=canonical(root); _,initializer=modules(root)
    require(context["run_slug"]==target["runSlug"],"Refresh round changed")
    url=urllib.parse.urlparse(dom.get("metrics",{}).get("url","")); query=urllib.parse.parse_qs(url.query)
    require(dom.get("schema")=="tam-observed-print-dom" and dom.get("version")==1 and url.hostname=="nlcorp.app.netsuite.com" and url.path=="/app/common/entity/custjob.nl" and query.get("id")==[target["internalId"]] and query.get("print")==["T"],"DOM is not the exact current print record")
    require(dom.get("transport",{}).get("exact_lengths_verified") is True and dom.get("metrics",{}).get("ready_state")=="complete" and len(dom.get("text",""))>1000,"Complete observed DOM required")
    observed=timestamp(dom.get("observed_at_utc")); selected=timestamp(target.get("selectedAt"))
    require(selected<=observed<=datetime.now(timezone.utc),"Source DOM predates refresh selection or is future-dated")
    text=dom["text"]; digest=sha(text.encode()); api=initializer.Api()
    payload={"docs":[{"internalId":target["internalId"],"docType":"record_text","body":text,"sha256":digest,"capturedAt":dom["observed_at_utc"],"source":"canonical_changed_evidence_refresh"}]}
    intent=directory/"upload.intent.json"; response=directory/"upload.response.json"
    if not intent.exists():
        write(intent,{"payloadSha256":sha(raw(payload)),"dom":reference(root,dom_path),"at":datetime.now(timezone.utc).isoformat()})
        result=api.request("POST","/api/agent/documents",payload); write(response,result)
    require(read(intent)["payloadSha256"]==sha(raw(payload)),"Refresh upload intent differs; preserve exact observation")
    docs=api.request("GET","/api/agent/documents?internalId="+target["internalId"])
    matches=[d for d in docs["documents"] if d["doc_type"]=="record_text" and d["sha256"]==digest and sha(d["body"].encode())==digest]
    require(len(matches)==1,"Upload not conclusively read back; keep intent and do not replay")
    changes=api.request("GET",initializer.ENDPOINT+"?view=evidence_changes&id="+target["internalId"])
    matching=[r for r in changes["changes"] if r["record_text_sha256"]==digest and r["predecessor_provenance_sha256"]==target["predecessorProvenanceSha256"]]
    changed=digest!=target["previousRecordTextSha256"]
    require(not changed or len(matching)==1,"Changed body awaits exact canonical change receipt; retain source evidence")
    result={"status":"changed" if changed else "unchanged","internalId":target["internalId"],"recordTextSha256":digest,"dom":reference(root,dom_path),"documentId":matches[0]["id"],"change":matching[0] if matching else None,"nextStep":"render_fresh_preview_then_register" if changed else "refresh_next","verifiedAt":datetime.now(timezone.utc).isoformat()}
    write(directory/"refresh_result.json",result)
    state_path=directory/"refresh_state.json"; state=read(state_path) if state_path.exists() else {}
    if target.get("prioritySource"):state.setdefault("priorityRows",{})[target["internalId"]]=target["prioritySource"]["rowSha256"]
    state.update(runSlug=target["runSlug"],offset=target["nextOffset"],turn=state.get("turn",0)+1,lastReceipt=reference(root,directory/"refresh_result.json")); write(state_path,state)
    return {k:v for k,v in result.items() if k!="change"}

def reconcile_admission(root,directory):
    directory=inside(root,directory); plan=read(directory/"plan.json"); _,initializer=modules(root); api=initializer.Api()
    payload={"action":"evidence_change_admit","runSlug":plan["runSlug"],"evidenceIndexSha256":plan["references"]["evidenceIndex"]["sha256"],"bindings":plan["changedEvidenceBindings"]}
    require(read(directory/"changed_admission.intent.json")["payloadSha256"]==sha(raw(payload)),"Exact admission intent differs")
    state=read(directory/"state.json"); status=initializer.board(api,plan["runSlug"])
    require(status["run"]["completed_checkpoint_seed_id"]==state["checkpoint_seed_id"],"Successor seed differs")
    for binding in payload["bindings"]:
        registration=next(r for r in read(bound(root,plan["references"]["registrations"])) if r["change"]["id"]==binding["receiptId"])
        page=api.request("GET",initializer.ENDPOINT+"?view=evidence_changes&id="+registration["change"]["netsuite_internal_id"])
        rows=[r for r in page["changes"] if r["id"]==binding["receiptId"]]
        require(len(rows)==1 and rows[0]["status"]=="admitted" and rows[0]["successor_run_id"]==status["run"]["id"] and rows[0]["successor_seed_id"]==state["checkpoint_seed_id"]
                and rows[0]["successor_pdf_sha256"]==binding["pdfSha256"] and rows[0]["record_text_sha256"]==binding["recordTextSha256"] and rows[0]["successor_evidence_index_sha256"]==payload["evidenceIndexSha256"],"Admission not conclusively present; no POST replay")
    result={"admitted":len(payload["bindings"]),"runSlug":plan["runSlug"],"readOnlyReconciled":True}
    write(directory/"changed_admission.response.json",result); return result

def reconcile_activation(root,directory):
    """Read-only proof for a crash after enabling control but before writing
    its local receipt. Never reset an active coordinator or repeat admission."""
    directory=inside(root,directory);plan=read(directory/"plan.json");state=read(directory/"state.json")
    require(state.get("status")=="complete" and not state.get("pending_action"),"Initialization incomplete")
    context_ref=reference(root,directory/"context.active.json"); context=read(directory/"context.active.json")
    _,mission,_,_=canonical(root);live=read(root/"stanley-source/stanley-main/config/tam-regrade-live-state.json");control=read(root/"automation-control.json")["tamRegrade"]
    for checkpoint in (mission,live):
        require(checkpoint.get("runSlug")==plan["runSlug"] and checkpoint["activeGradingRound"]["context"]==context_ref and checkpoint["activeGradingRound"]["checkpointSeedId"]==state["checkpoint_seed_id"],"Canonical activation checkpoint differs")
    require(control.get("enabled") is True and control.get("mode")=="checkpointed-parallel-records" and control.get("maxConcurrentRecords")==3,"Canonical control is not this active successor")
    authorization=read(bound(root,control["parallelAuthorization"]))
    expected={"approved":True,"runSlug":plan["runSlug"],"contextSha256":context_ref["sha256"],"maxConcurrentRecords":3,"eachRecordSerialReaderThenValidator":True}
    require(all(authorization.get(k)==v for k,v in expected.items()) and context["checkpoint_seed_id"]==state["checkpoint_seed_id"],"Active authorization differs")
    _,initializer=modules(root);status=initializer.board(initializer.Api(),plan["runSlug"])
    require(status["run"]["completed_checkpoint_seed_id"]==state["checkpoint_seed_id"] and status["checkpointSeed"]["manifest_sha256"]==plan["seedManifestSha256"],"Live seed differs")
    result={"status":"active_canonical_successor","runSlug":plan["runSlug"],"context":context_ref,"changedIds":len(plan["changedEvidenceBindings"]),"coordinatorLaunched":False,"readOnlyReconciled":True}
    write(directory/"activation_receipt.json",result);return result

def quiesce(root,directory):
    """Disable future dispatch only while all existing coordinator/slot locks
    are free and the live board has no admitted readers or unpublished finals."""
    directory=inside(root,directory); directory.mkdir(parents=True,exist_ok=True)
    with safe_boundary(root) as (_,_,_,context):
        _,initializer=modules(root); status=initializer.board(initializer.Api(),context["run_slug"])
        require(status["counts"]["grade_reading"]==0 and status["counts"]["grade_final"]==0,"Canonical work has not drained")
        path=root/"automation-control.json"; control=read(path); before=directory/"control_before.json"
        require(not before.exists(),"Quiesce receipt exists; inspect existing handoff instead of overwriting")
        write(before,control); control["tamRegrade"].update(enabled=False,reason="Canonical changed-evidence admission at verified idle boundary")
        write(path,control); write(directory/"quiesce_receipt.json",{"runSlug":context["run_slug"],"controlBefore":reference(root,before),"at":datetime.now(timezone.utc).isoformat()})
        return {"status":"idle_dispatch_disabled","runSlug":context["run_slug"]}

def export_boundary(root,directory):
    directory=inside(root,directory);directory.mkdir(parents=True,exist_ok=True)
    with safe_boundary(root) as (_,_,_,context):
        require(read(root/"automation-control.json")["tamRegrade"].get("enabled") is False,"Export requires quiesced dispatch")
        _,initializer=modules(root);api=initializer.Api();status=initializer.board(api,context["run_slug"])
        require(status["counts"]["grade_reading"]==0 and status["counts"]["grade_final"]==0,"Predecessor retains admitted work")
        rows=initializer.records(api,context["run_slug"],current="true")
        require(len(rows)==context["membership_count"] and len({r["netsuite_internal_id"] for r in rows})==len(rows),"Exact canonical boundary export incomplete")
        for name,value in (("board.json",status),("records.json",rows)):
            path=directory/name
            if path.exists():require(read(path)==value,"Existing boundary export differs; use a fresh handoff directory")
            else:write(path,value)
        return {"status":"exported","board":reference(root,directory/"board.json"),"records":reference(root,directory/"records.json"),"count":len(rows)}

def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument("command",choices=["bundle","install","register","rebuild-registration","prepare","apply","reconcile","activate","refresh-snapshot","refresh-ingest","quiesce","reconcile-admission","reconcile-activation","export-boundary"])
    parser.add_argument("--directory",type=Path); parser.add_argument("--preview",type=Path); parser.add_argument("--change",type=Path); parser.add_argument("--visual-qa",type=Path)
    parser.add_argument("--board",type=Path); parser.add_argument("--records",type=Path); parser.add_argument("--registrations",type=Path); parser.add_argument("--release-commit"); parser.add_argument("--max-operations",type=int,default=250)
    parser.add_argument("--row-observation",type=Path); parser.add_argument("--dom",type=Path)
    parser.add_argument("--registration",type=Path);parser.add_argument("--output",type=Path)
    args=parser.parse_args(); root=workspace()
    if args.command=="bundle": result=bundle(root,args.directory)
    elif args.command=="install": result=install(root,args.directory/"bundle.json")
    elif args.command=="register":
        change=read(args.change);result=register_capture(root,args.preview,change.get("change",change),args.visual_qa)
    elif args.command=="rebuild-registration":result=rebuild_registration(root,args.registration,args.output)
    elif args.command=="prepare": result=prepare(root,args.board,args.records,args.registrations,args.release_commit,args.directory)
    elif args.command in ("apply","reconcile"): result=apply(root,args.directory,args.max_operations,args.command=="reconcile")
    elif args.command=="refresh-snapshot": result=refresh_snapshot(root,args.directory,args.row_observation)
    elif args.command=="refresh-ingest": result=refresh_ingest(root,args.directory,args.dom)
    elif args.command=="quiesce": result=quiesce(root,args.directory)
    elif args.command=="reconcile-admission": result=reconcile_admission(root,args.directory)
    elif args.command=="reconcile-activation": result=reconcile_activation(root,args.directory)
    elif args.command=="export-boundary": result=export_boundary(root,args.directory)
    else: result=activate(root,args.directory)
    print(json.dumps(result))
if __name__=="__main__": main()

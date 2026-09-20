"""Local-only inherited-final lineage manifest; never reads PDFs or calls a model/API."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone
from tam_changed_evidence import io_path

def sha(raw): return hashlib.sha256(raw).hexdigest()
def encoded(value): return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":"),allow_nan=False).encode()
def read(path): return json.loads(io_path(Path(path)).read_bytes())
def require(value,message):
    if not value: raise ValueError(message)
def timestamp(value): return datetime.fromisoformat(value.replace("Z","+00:00")).astimezone(timezone.utc)
def ref(path,root=None,expected=None):
    path=Path(path).resolve()
    if root: require(path.is_relative_to(root),"retained artifact escapes predecessor root")
    raw=io_path(path).read_bytes(); actual=sha(raw)
    if expected: require(actual==expected,"retained artifact hash differs: "+path.name)
    return {"path":str(path),"sha256":actual,"bytes":len(raw)}

def recovered_preparation(checkpoint,published,provenance,root):
    """Resolve omitted locators from exact retained witnesses, without editing them."""
    require(checkpoint.get("recoveredReadback") is True and published.get("recoveredReadback") is True,"required Jev preparation absent")
    ident=checkpoint["exactId"]; evidence=checkpoint["evidence"]
    def witness(folder,role,candidate_sha=None):
        paths=list(io_path(root/"grading"/folder).glob(ident+".*.json.receipt.json"))
        require(len(paths)<=20,"too many exact recovery artifact receipts")
        matches=[]
        for path in paths:
            item=read(path); source=item.get("evidence",{}); navhash=source.get("evidenceNavigationSha256")
            if (item.get("schema")!="tam-full-evidence-model-artifact" or item.get("version")!=1 or item.get("role")!=role
                or item.get("readMode")!="direct-full-evidence" or item.get("completeRawEvidenceCoverage") is not True
                or not isinstance(navhash,str) or len(navhash)!=64
                or source!={**evidence,"evidenceNavigationSha256":navhash}):continue
            if role=="reader" and item.get("artifactSha256")!=provenance["candidateFileSha256"]:continue
            if role=="validator" and item.get("candidateSha256")!=candidate_sha:continue
            artifact=Path(item["artifactPath"]).resolve()
            require(artifact.parent==(root/"grading"/folder).resolve() and artifact.name.startswith(ident+".")
                    and artifact.name.endswith(".json") and path.name==artifact.name+".receipt.json","recovery artifact locator differs")
            artifact_ref=ref(artifact,root,item["artifactSha256"])
            require(timestamp(item["createdAt"])<=timestamp(published["event"]["created_at"]),"recovery artifact postdates publication")
            # Keep ordinary manifest paths even when io_path/glob used extended paths.
            receipt_ref=ref(artifact.parent/path.name,root)
            matches.append((item,artifact_ref,receipt_ref))
        require(len(matches)==1,"recovery "+role+" receipt is missing or ambiguous")
        return matches[0]
    reader,candidate_ref,reader_ref=witness("candidates","reader")
    validator,validator_ref,validator_receipt_ref=witness("validator_raw","validator",candidate_ref["sha256"])
    require(reader["evidence"]==validator["evidence"],"recovery reader and validator source/navigation binding differs")
    require(timestamp(reader["createdAt"])<=timestamp(validator["createdAt"]),"recovery validator predates reader")
    navhash=reader["evidence"]["evidenceNavigationSha256"]
    paths=list(io_path(root/"grading/navigation"/ident).glob("*/frozen-navigation.json"))
    require(len(paths)<=20,"too many exact recovery navigation artifacts")
    matches=[]
    for path in paths:
        frozen=read(path)
        if frozen.get("navigation_sha256")==navhash and sha(encoded(frozen["view"]))==navhash:
            matches.append(root/"grading/navigation"/ident/path.parent.name/"receipt.json")
    require(len(matches)==1,"recovery frozen navigation is missing or ambiguous")
    additions={"candidatePath":candidate_ref["path"],"candidateSha256":candidate_ref["sha256"],
               "validatorPath":validator_ref["path"],"validatorSha256":validator_ref["sha256"]}
    require(all(key not in checkpoint or checkpoint[key]==value for key,value in additions.items()),"recovery checkpoint contradicts retained artifact witnesses")
    return {**checkpoint,**additions,"evidence":reader["evidence"],"navigationPreparation":{
        "status":"required_jev_accepted","policy":"successor-jev-acceptance-v1","path":str(matches[0]),"navigation_sha256":navhash}}, {
        "readerArtifactReceipt":reader_ref,"validatorArtifactReceipt":validator_receipt_ref}


def carried_lineage(old,seed,plan,root,copied,cache):
    """Reuse only a fixed, verified immediate predecessor manifest and its plan."""
    path=root/"inherited_final_lineage.json"
    if str(path) not in cache:
        prior=read(path); manifest_ref=ref(path,root)
        require(prior.get("schema")=="tam-inherited-final-lineage" and prior.get("status")=="verified" and prior.get("anomalies")==[],"prior inherited lineage is not verified")
        plan_ref=prior["inputs"]["plan"]
        require(Path(plan_ref["path"]).resolve()==(root/"plan.json").resolve(),"prior lineage does not reference the exact predecessor plan")
        ref(plan_ref["path"],root,plan_ref["sha256"])
        prior_plan=read(plan_ref["path"])
        rows={r["internalId"]:r for r in prior["records"]}
        require(len(rows)==len(prior["records"])==prior.get("verifiedCount")==prior.get("inheritedFinalCount"),"prior lineage exact record counts differ")
        cache[str(path)]=(prior,prior_plan,rows,manifest_ref)
    prior,prior_plan,rows,manifest_ref=cache[str(path)]
    ident=seed["netsuiteInternalId"]; entry=rows.get(ident)
    require(prior["runSlug"]==prior_plan["runSlug"]==old["grade_provenance"]["runSlug"] and entry is not None,"prior lineage run or exact ID differs")
    matching=[s for s in prior_plan["seedRows"] if s["netsuiteInternalId"]==ident]
    require(len(matching)==1 and matching[0]["recoveryCohort"]=="published_complete" and prior_plan["companies"][ident]==old["company_id"],"prior plan inherited company differs")
    inherited=matching[0]["provenance"]
    require(inherited["sha256"]==entry["successorProvenanceSha256"]==old["grade_provenance_sha256"] and inherited["data"]==old["grade_provenance"] and inherited["canonicalJson"]==old["grade_provenance_canonical_json"],"prior lineage successor provenance differs")
    require(entry["companyId"]==old["company_id"] and entry["copiedFrom"]==old["grade_provenance"]["copiedFrom"] and timestamp(entry["publishedAt"])==timestamp(old["published_at"]),"prior inherited identity or publication time differs")
    for artifact in entry["artifacts"].values(): ref(artifact["path"],expected=artifact["sha256"])
    parents=entry.get("parentManifests",[])
    for parent in parents: ref(parent["path"],expected=parent["sha256"])
    require(entry["evidence"]["pdfSha256"]==old["pdf_sha256"]==seed["pdfSha256"] and entry["evidence"]["pdfPageCount"]==old["pdf_page_count"]==seed["pdfPageCount"] and entry["evidence"]["recordTextSha256"]==old["grade_provenance"]["recordTextSha256"],"retained inherited source binding differs")
    return {**entry,"predecessorProvenanceSha256":old["grade_provenance_sha256"],"successorProvenanceSha256":seed["provenance"]["sha256"],"copiedFrom":copied,
            "parentManifests":[*parents,manifest_ref]}

def lineage(old,seed,plan,root,cache=None):
    ident=seed["netsuiteInternalId"]; provenance=old["grade_provenance"]; successor=seed["provenance"]["data"]
    require(old["grade_status"]=="published" and old["validation_status"]=="passed" and old["is_current"],"predecessor is not a current validated final")
    require(sha(old["grade_provenance_canonical_json"].encode())==old["grade_provenance_sha256"] and json.loads(old["grade_provenance_canonical_json"])==provenance,"predecessor canonical provenance differs")
    require(sha(seed["provenance"]["canonicalJson"].encode())==seed["provenance"]["sha256"] and json.loads(seed["provenance"]["canonicalJson"])==successor,"successor canonical provenance differs")
    copied={"runId":old["run_id"],"provenanceSha256":old["grade_provenance_sha256"],"publishedAt":old["published_at"]}
    require(successor.get("copiedFrom")==copied and successor["runSlug"]==plan["runSlug"],"successor copiedFrom differs")
    require({k:v for k,v in successor.items() if k not in ("runSlug","copiedFrom")}=={k:v for k,v in provenance.items() if k not in ("runSlug","copiedFrom")},"successor changed inherited assessment/evidence")
    if provenance.get("copiedFrom"):
        return carried_lineage(old,seed,plan,root,copied,cache if cache is not None else {})
    checkpoint_path=root/"grading/checkpoints"/(ident+".json"); published_path=root/"grading/published"/(ident+".json")
    checkpoint=read(checkpoint_path); published=read(published_path); record=published["readback"]; event=published["event"]
    require(checkpoint.get("exactId")==ident and checkpoint.get("runSlug")==provenance["runSlug"] and checkpoint.get("stage")=="published_readback_verified" and checkpoint.get("status")=="complete","checkpoint is not the exact completed publication")
    require(Path(checkpoint["publishedPath"]).resolve()==published_path.resolve(),"checkpoint publication locator differs")
    for key in ("run_id","netsuite_internal_id","company_id","grade_provenance_sha256","checkpoint_seed_id","pdf_sha256","pdf_page_count","validation_status"):
        require(record.get(key)==old.get(key),"published exact readback differs: "+key)
    require(record.get("grade_status")=="published" and record.get("grade_provenance")==provenance and record.get("grade_provenance_canonical_json")==old["grade_provenance_canonical_json"],"published provenance/readback differs")
    require(timestamp(record["published_at"])==timestamp(old["published_at"]),"publication timestamp differs")
    require(event.get("id") is not None and event.get("kind")=="grade.published" and event.get("run_id")==old["run_id"] and event.get("netsuite_internal_id")==ident and event["metadata"].get("company_id")==old["company_id"] and event["metadata"].get("provenance_sha256")==old["grade_provenance_sha256"],"publication event identity differs")
    require(published["payloadSha256"]==checkpoint["publishPayloadSha256"] and published["publish"].get("ok") is True,"publication payload receipt differs")
    evidence=checkpoint["evidence"]
    require(evidence["exactId"]==ident and evidence["runSlug"]==provenance["runSlug"] and evidence["pdfSha256"]==old["pdf_sha256"]==seed["pdfSha256"]==provenance["pdfSha256"] and evidence["pdfPageCount"]==old["pdf_page_count"]==seed["pdfPageCount"] and evidence["recordTextSha256"]==provenance["recordTextSha256"],"checkpoint source binding differs")
    context_path=root/"context.active.json"; context=read(context_path)
    context_ref=ref(context_path,root,evidence["roundContextSha256"])
    require(context["run_slug"]==provenance["runSlug"] and context["checkpoint_seed_id"]==old["checkpoint_seed_id"],"predecessor context differs")
    recovery_artifacts={}
    if "navigationPreparation" not in checkpoint:
        checkpoint,recovery_artifacts=recovered_preparation(checkpoint,published,provenance,root)
        evidence=checkpoint["evidence"]
    nav=checkpoint["navigationPreparation"]; require(nav.get("status")=="required_jev_accepted" and nav.get("policy")=="successor-jev-acceptance-v1","required Jev preparation absent")
    nav_path=Path(nav["path"]).resolve(); nav_ref=ref(nav_path,root); receipt=read(nav_path)
    frozen_path=nav_path.parent/"frozen-navigation.json"; frozen=read(frozen_path); frozen_ref=ref(frozen_path,root)
    acceptance=frozen["view"].get("jev_acceptance",{})
    require(frozen["navigation_sha256"]==sha(encoded(frozen["view"]))==nav["navigation_sha256"]==evidence["evidenceNavigationSha256"],"frozen navigation hash differs")
    require(receipt.get("schema")=="tam-required-jev-preparation" and receipt.get("policy")==nav["policy"]==acceptance.get("policy") and receipt.get("key")==frozen.get("cache_key") and acceptance.get("status")=="successful_annotations" and receipt.get("request_sha256")==acceptance.get("request_sha256") and receipt.get("source_sha256")==acceptance.get("source_sha256"),"Jev receipt and frozen navigation differ")
    candidate_ref=ref(checkpoint["candidatePath"],root,checkpoint["candidateSha256"]); validator_ref=ref(checkpoint["validatorPath"],root,checkpoint["validatorSha256"]); validated_ref=ref(checkpoint["validatedPath"],root)
    candidate=read(checkpoint["candidatePath"]); validator=read(checkpoint["validatorPath"]); validated=read(checkpoint["validatedPath"])
    # Existing publisher hashes the ASCII canonical record, excluding the JSONL
    # file's final newline. Preserve the separate physical file hash as well.
    validated_canonical_sha=sha(json.dumps(validated,ensure_ascii=True,sort_keys=True,separators=(",",":")).encode())
    require(provenance.get("validatorHashScope")=="canonical-record" and validated_canonical_sha==provenance["validatorOutputSha256"],"validated canonical-record hash differs")
    validated_ref["canonicalRecordSha256"]=validated_canonical_sha
    require(candidate.get("exact_id")==ident and validator.get("exact_id")==ident and validated.get("exact_id")==ident,"reader/validator exact ID differs")
    require(candidate.get("full_record_text_read") is True and candidate.get("full_pdf_read") is True and candidate.get("pdf_pages_read")==evidence["pdfPageCount"],"reader full-read receipt absent")
    require(validator.get("validation_status")=="passed" and validator.get("full_record_text_reread") is True and validator.get("full_pdf_reread") is True,"independent validator reread absent")
    validation=record["grade_provenance"]["assessment"]["validation"]
    require(validation==validated.get("validation") and validation.get("status")=="passed" and all(validation.get(k) is True for k in ("full_pdf_reread","full_record_text_reread","source_hashes_verified","page_count_verified")),"published validation full-reread flags differ")
    require(candidate_ref["sha256"]==provenance["candidateFileSha256"]==validated["candidate_file_sha256"] and validated["pdf_sha256"]==evidence["pdfSha256"] and validated["record_text_sha256"]==evidence["recordTextSha256"] and validated["assessment_context"]["context_sha256"]==context_ref["sha256"],"validated artifact source binding differs")
    return {"internalId":ident,"companyId":old["company_id"],"predecessorProvenanceSha256":old["grade_provenance_sha256"],"publishedAt":old["published_at"],"successorProvenanceSha256":seed["provenance"]["sha256"],"copiedFrom":copied,
      "artifacts":{"checkpoint":ref(checkpoint_path,root),"publication":ref(published_path,root),"context":context_ref,"navigationReceipt":nav_ref,"frozenNavigation":frozen_ref,"candidate":candidate_ref,"validator":validator_ref,"validated":validated_ref,**recovery_artifacts},
      **({"lineageRecovery":{"method":"recovered_readback_source_bound_artifacts","checkpointUnmodified":True}} if recovery_artifacts else {}),
      "evidence":evidence,"navigation":{"status":nav["status"],"navigationSha256":nav["navigation_sha256"],"requestSha256":receipt["request_sha256"],"sourceSha256":receipt["source_sha256"]},
      "publication":{"eventId":event["id"],"eventMetadata":event["metadata"],"eventCreatedAt":event["created_at"],"payloadSha256":published["payloadSha256"],"receiptPublishedAt":published["publishedAt"]},"validation":validation}

def build(records_path,plan_path,predecessor_root):
    root=Path(predecessor_root).resolve();records=read(records_path);plan=read(plan_path)
    require(isinstance(records,list),"exact boundary records must be an array")
    by_id={r["netsuite_internal_id"]:r for r in records}
    require(len(by_id)==len(records) and set(by_id)==set(plan["companies"]),"boundary membership differs from successor exact company set")
    seed_ids=[s["netsuiteInternalId"] for s in plan["seedRows"]]
    require(len(seed_ids)==len(set(seed_ids)) and set(seed_ids)==set(by_id) and all(i.isascii() and i.isdigit() for i in seed_ids),"successor seed membership differs or duplicates an exact ID")
    rows=[];anomalies=[];cache={}
    for seed in plan["seedRows"]:
        if seed["recoveryCohort"]!="published_complete":continue
        ident=seed["netsuiteInternalId"]
        try:
            old=by_id[ident];require(old["company_id"]==plan["companies"][ident],"canonical company differs")
            rows.append(lineage(old,seed,plan,root,cache))
        except (ValueError,KeyError,TypeError,OSError) as error:anomalies.append({"internalId":ident,"error":str(error)})
    result={"schema":"tam-inherited-final-lineage","version":1,"status":"failed" if anomalies else "verified","createdAt":datetime.now(timezone.utc).isoformat(),"runSlug":plan["runSlug"],"inputs":{"records":ref(records_path),"plan":ref(plan_path),"predecessorRoot":str(root)},"inheritedFinalCount":len(rows)+len(anomalies),"verifiedCount":len(rows),"records":rows,"anomalies":anomalies,"scope":"Retained artifact lineage only; no new source reread, grading, model or API call."}
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for key in ("records","plan","predecessor-root","output"):parser.add_argument("--"+key,type=Path,required=True)
    args=parser.parse_args();require(not io_path(args.output).exists(),"output must be a new immutable manifest")
    result=build(args.records,args.plan,args.predecessor_root)
    io_path(args.output.parent).mkdir(parents=True,exist_ok=True)
    with io_path(args.output).open("xb") as handle:handle.write(encoded(result)+b"\n")
    print(json.dumps({"status":result["status"],"verified":result["verifiedCount"],"anomalies":result["anomalies"],"output":str(args.output)}))
    require(not result["anomalies"],"Inherited lineage anomalies recorded; manifest is not verified")

if __name__=="__main__":main()

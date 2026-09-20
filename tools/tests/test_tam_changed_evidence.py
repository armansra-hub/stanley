"""Offline lifecycle tests; no canonical files, browser, credentials or APIs."""
import importlib.util
import io
import json
import os
import sys
from pathlib import Path
import tempfile
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

spec=importlib.util.spec_from_file_location("changed",Path(__file__).parents[1]/"tam_changed_evidence.py")
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
REAL_ROOT=Path(__file__).parents[3]

class Lifecycle(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup); self.root=Path(self.tmp.name).resolve()
  self.artifacts=self.root/"outputs/tam_refresh_2026-09-14"; self.artifacts.mkdir(parents=True)
  self.current=self.artifacts/"current"; self.current.mkdir()
  self.mission_path=self.root/"stanley-source/stanley-main/config/tam-regrade-mission.json"
  self.context={"schema":"tam-canonical-grading-round","version":1,"run_slug":"old-run","checkpoint_seed_id":"old-seed","artifact_root":self.current.relative_to(self.root).as_posix(),"snapshot_sha256":"a"*64,"membership_count":4,"rubric_sha256":"b"*64}
  self.index={"records":{str(i):{"company_id":"c"+str(i),"package_path":f"old/{i}","pdf_sha256":str(i)*64,"pdf_pages":1,"source_snapshot_sha256":"a"*64,"record_text_sha256":m.sha(f"old {i}".encode())} for i in range(1,5)}}
  m.write(self.current/"index.json",self.index); self.context["evidence_index_reference"]=m.reference(self.root,self.current/"index.json")
  m.write(self.current/"context.json",self.context)
  self.mission={"runSlug":"old-run","activeGradingRound":{"context":m.reference(self.root,self.current/"context.json")},"membershipSource":{"currentSnapshot":{"sourceRows":4,"savedSearchId":"1327786"}}}
  m.write(self.mission_path,self.mission)
  self.rows=[]
  for i in range(1,5):
   assessment={"final_score":75,"record_digest":"old digest","validation":{"validated_by":"independent","validated_at":"2026-09-18T00:00:00Z"}}
   prov={"pdfSha256":str(i)*64,"recordTextSha256":m.sha(f"old {i}".encode()),"assessment":assessment,"runSlug":"old-run"}; canonical=m.raw(prov).decode()
   self.rows.append({"netsuite_internal_id":str(i),"company_id":"c"+str(i),"run_id":"old-id","grade_status":"published" if i<3 else "hold" if i==3 else "pending","validation_status":"passed","membership_ordinal":i,"company_name":"Company","membership_status":"overlap","table_rows":[],"source_coordinates":[],"saved_search_row_count":1,"table_rows_sha256":"d"*64,"pdf_verified_at":"2026-09-18T00:00:00Z","grade_provenance":prov,"grade_provenance_canonical_json":canonical,"grade_provenance_sha256":m.sha(canonical.encode()),"published_at":"2026-09-18T00:00:00Z","hold_reason":"retain exact hold" if i==3 else None})
  for row in self.rows:
   ident=row["netsuite_internal_id"];row.update(checkpoint_seed_id="old-seed",pdf_sha256=ident*64,pdf_object_path=f"old/{ident}/print.pdf",pdf_page_count=1)
  self.board={"run":{"slug":"old-run","id":"old-id","completed_checkpoint_seed_id":"old-seed","status":"grading","search_id":"1327786","mission":self.mission,"source_total":4,"source_snapshot_sha256":"a"*64},"counts":{"grade_reading":0,"grade_final":0,"lease_expired":0}}
  self.board_path=self.artifacts/"board.json"; self.rows_path=self.artifacts/"rows.json"
  m.write(self.board_path,self.board);m.write(self.rows_path,self.rows)
  self.package=self.root/"new/1"; self.package.mkdir(parents=True)
  for name,body in (("capture.json",b"capture"),("print.pdf",b"pdf"),("record_text.txt",b"new record"),("visual.json",b"qa"),("pages.json",b"pages")): (self.package/name).write_bytes(body)
  self.registration={"change":{"id":"receipt-1","netsuite_internal_id":"1","company_id":"c1","predecessor_run_id":"old-id","predecessor_provenance_sha256":self.rows[0]["grade_provenance_sha256"],"record_text_sha256":m.sha(b"new record")},"entry":{**self.index["records"]["1"],"package_path":"new/1","record_text_sha256":m.sha(b"new record"),"capture_sha256":m.sha(b"capture"),"pdf_sha256":m.sha(b"pdf")},"visualQa":m.reference(self.root,self.package/"visual.json"),"pageVerification":m.reference(self.root,self.package/"pages.json")}
  self.registrations=self.artifacts/"registrations.json"; m.write(self.registrations,[self.registration])
  self.fake=SimpleNamespace(id_hash=lambda ids:m.sha("".join(i+"\n" for i in ids).encode()))

 def prepare(self):
  with patch.object(m,"modules",return_value=(None,self.fake)):
   return m.prepare(self.root,self.board_path,self.rows_path,self.registrations,"a"*40,self.artifacts/"successor")

 def test_successor_keeps_membership_hold_and_unchanged_final(self):
  result=self.prepare(); plan=m.read(self.artifacts/"successor/plan.json")
  self.assertEqual(result["counts"]["unrepresented"],2)
  self.assertEqual([s["recoveryCohort"] for s in plan["seedRows"]],["unrepresented","published_complete","active_hold","unrepresented"])
  self.assertEqual(plan["seedRows"][2]["holdReason"],"retain exact hold")
  self.assertEqual(plan["seedRows"][1]["provenance"]["data"]["assessment"],self.rows[1]["grade_provenance"]["assessment"])
  self.assertEqual(plan["seedRows"][1]["provenance"]["data"]["copiedFrom"]["provenanceSha256"],self.rows[1]["grade_provenance_sha256"])
  self.assertEqual(m.read(self.mission_path),self.mission,"prepare never changes canonical activation")
  self.assertEqual(m.read(self.current/"index.json"),self.index)

 def load_initializer(self):
  spec=importlib.util.spec_from_file_location("test_canonical_initializer",REAL_ROOT/"tools/tam_start_grading_round.py")
  initializer=importlib.util.module_from_spec(spec)
  with patch.dict(sys.modules,{"tam_grading_round":SimpleNamespace(WORKSPACE=self.root,MISSION=self.mission_path,load_round_context=lambda:None)}):spec.loader.exec_module(initializer)
  return initializer

 def test_fast_successor_uses_atomic_copy_then_original_seed_operations(self):
  self.prepare();directory=self.artifacts/"successor";plan=m.read(directory/"plan.json");initializer=self.load_initializer()
  request=plan["successorInitialize"]
  self.assertEqual(m.sha(request["manifestCanonicalJson"].encode()),plan["seedManifestSha256"])
  self.assertEqual(request["predecessorSeedId"],"old-seed")
  self.assertEqual(request["changes"][0]["internalId"],"1")
  self.assertEqual(request["changes"][0]["pdfObjectPath"],"new/1/print.pdf")
  self.assertEqual(len(request["expectedPredecessorBindings"]),4)
  # Same instant with different offset syntax must produce the exact SQL hash.
  row=self.rows[0];same={**row,"pdf_verified_at":"2026-09-17T17:00:00-07:00"}
  self.assertEqual(m.predecessor_fingerprint(row),m.predecessor_fingerprint(same))
  self.assertNotEqual(m.predecessor_fingerprint(row),m.predecessor_fingerprint({**row,"pdf_sha256":"f"*64}))
  self.assertNotEqual(m.predecessor_fingerprint({**row,"hold_reason":None}),m.predecessor_fingerprint({**row,"hold_reason":""}),"SQL distinguishes null from an empty hold string")
  with m.initializer_adapter(initializer,plan):
   steps=list(initializer.operations(plan))
   self.assertEqual([s.get("action",s.get("local")) for s in steps],["bootstrap","evidence_successor_initialize","verify_membership","checkpoint_seed_batch","checkpoint_seed_finalize","verify_final"])
   legacy={k:v for k,v in plan.items() if k!="successorInitialize"}
   legacy_steps=list(initializer.operations(legacy))
   self.assertEqual(sum(s.get("action")=="pdf" for s in legacy_steps),4,"Existing journal operation indexes stay unchanged")
   self.assertTrue(any(s.get("action")=="membership" for s in legacy_steps))

 def test_fast_successor_response_loss_reconciles_only_saved_token_without_repost(self):
  self.prepare();directory=self.artifacts/"successor";plan=m.read(directory/"plan.json");initializer=self.load_initializer();posts=[]
  seed_id="11111111-1111-1111-1111-111111111111";token="22222222-2222-2222-2222-222222222222"
  request=plan["successorInitialize"];boot=request["bootstrap"]
  new_run={"id":"new-id",**{dst:boot[src] for src,dst in (("runSlug","slug"),("searchId","search_id"),("mission","mission"),("sourceTotal","source_total"),("sourceSnapshotSha256","source_snapshot_sha256"))}}
  result={"run":new_run,"seed":{"seedId":seed_id,"seedToken":token,"status":"building"},"copied":4,"changed":1}
  class Api:
   def request(s,method,url,payload=None):
    self.assertEqual(method,"POST");posts.append(payload["action"])
    if payload["action"]=="bootstrap":return {"run":{**self.board["run"],"status":"paused"}}
    return result
  def board(api,slug):
   if slug=="old-run":return self.board
   if len(posts)<2:return {"missingRun":slug}
   return {"run":new_run,"checkpointSeed":{"id":seed_id,"manifest_sha256":plan["seedManifestSha256"],"status":"building"}}
  atomic=initializer.atomic
  def fail_after_response(path,state):
   if state.get("next_operation")==2:raise OSError("after saved response")
   return atomic(path,state)
  with m.initializer_adapter(initializer,plan),patch.object(initializer,"board",board),patch.object(initializer,"current_companies",return_value=[]):
   with patch.object(initializer,"atomic",fail_after_response):
    with self.assertRaisesRegex(OSError,"after saved response"):initializer.apply(directory,m.sha((directory/"plan.json").read_bytes()),2,api=Api())
   self.assertEqual(m.read(directory/"state.json")["pending_action"]["action"],"evidence_successor_initialize")
   self.assertTrue((directory/"response_00001.json").exists())
   initializer.reconcile(directory,api=Api())
   state=m.read(directory/"state.json")
   self.assertEqual((state["seed_id"],state["seed_token"],state["next_operation"]),(seed_id,token,2))
   self.assertIsNone(state["pending_action"])
   self.assertEqual(posts,["bootstrap","evidence_successor_initialize"])
   # With no original token response, even a matching live seed is insufficient.
   state.update(next_operation=1,pending_action={"action":"evidence_successor_initialize","operation_index":1,"payload_sha256":m.sha(initializer.raw_json(request))});m.write(directory/"state.json",state)
   (directory/"response_00001.json").unlink()
   with self.assertRaisesRegex(ValueError,"no replay"):initializer.reconcile(directory,api=Api())
   self.assertEqual(posts,["bootstrap","evidence_successor_initialize"])

 def test_refuses_active_read_or_changed_prior_binding(self):
  self.board["counts"]["grade_reading"]=1;m.write(self.board_path,self.board)
  with self.assertRaisesRegex(ValueError,"record work finishes"):self.prepare()
  self.board["counts"]["grade_reading"]=0;m.write(self.board_path,self.board)
  self.registration["change"]["predecessor_provenance_sha256"]="wrong";m.write(self.registrations,[self.registration])
  with self.assertRaisesRegex(ValueError,"predecessor's completed final"):self.prepare()

 def test_runtime_bundle_is_offline_and_exact_locator_only(self):
  (self.root/"tools").mkdir()
  for name in ("tam_grading_round.py","tam_record_core.py"):(self.root/"tools"/name).write_bytes((REAL_ROOT/"tools"/name).read_bytes())
  before=(self.root/"tools/tam_grading_round.py").read_bytes(); ref=m.bundle(self.root,self.artifacts/"bundle")
  self.assertEqual(before,(self.root/"tools/tam_grading_round.py").read_bytes())
  manifest=m.read(self.root/ref["path"]); namespace={"__file__":str(self.root/"tools/tam_grading_round.py")}
  exec(compile((self.artifacts/"bundle/tam_grading_round.py").read_text(),"candidate","exec"),namespace)
  corpus=("outputs","leads"); locator="outputs/leads/1/snapshots/"+"a"*64+"/captures/"+"b"*64
  self.assertEqual(namespace["package_locator_parts"](locator,"1","a"*64,corpus),tuple(locator.split("/")))
  for invalid in (locator.replace("/1/","/2/"),locator.replace("/captures/","/../"),locator+"/file"):
   with self.assertRaises(RuntimeError):namespace["package_locator_parts"](invalid,"1","a"*64,corpus)
  self.assertEqual(manifest["files"][0]["beforeSha256"],m.sha(before))

 def test_install_requires_idle_control_and_exact_before_hashes(self):
  (self.root/"tools").mkdir()
  for name in ("tam_grading_round.py","tam_record_core.py"):(self.root/"tools"/name).write_bytes((REAL_ROOT/"tools"/name).read_bytes())
  m.bundle(self.root,self.artifacts/"bundle"); manifest=self.artifacts/"bundle/bundle.json"
  @contextmanager
  def boundary(*a,**kw):yield None
  m.write(self.root/"automation-control.json",{"tamRegrade":{"enabled":True}})
  with patch.object(m,"safe_boundary",boundary):
   with self.assertRaisesRegex(ValueError,"Disable dispatch"):m.install(self.root,manifest)
   m.write(self.root/"automation-control.json",{"tamRegrade":{"enabled":False}})
   file=self.root/"tools/tam_record_core.py"; before=file.read_bytes();file.write_bytes(before+b"\n")
   with self.assertRaisesRegex(ValueError,"Runtime changed"):m.install(self.root,manifest)
   file.write_bytes(before)
   receipt=m.install(self.root,manifest)
  self.assertEqual(receipt["status"],"installed");self.assertEqual(len(receipt["beforeImages"]),2)

 def test_partial_runtime_install_rolls_back_every_replaced_file(self):
  (self.root/"tools").mkdir(); before={}
  for name in ("tam_grading_round.py","tam_record_core.py"):
   before[name]=(REAL_ROOT/"tools"/name).read_bytes();(self.root/"tools"/name).write_bytes(before[name])
  m.bundle(self.root,self.artifacts/"bundle");m.write(self.root/"automation-control.json",{"tamRegrade":{"enabled":False}})
  @contextmanager
  def boundary(*a,**kw):yield None
  replace=m.os.replace
  def fail_second(src,dst):
   if str(src).endswith("tam_record_core.py.changed-evidence-pending"):raise OSError("simulated install failure")
   return replace(src,dst)
  with patch.object(m,"safe_boundary",boundary),patch.object(m.os,"replace",fail_second):
   with self.assertRaises(OSError):m.install(self.root,self.artifacts/"bundle/bundle.json")
  for name,raw in before.items():self.assertEqual((self.root/"tools"/name).read_bytes(),raw)

 def test_refresh_rotates_only_after_verified_exact_ingestion(self):
  directory=self.artifacts/"refresh"; calls=[]
  body="Complete raw CRM record "*100; digest=m.sha(body.encode())
  change={"record_text_sha256":digest,"predecessor_provenance_sha256":self.rows[0]["grade_provenance_sha256"],"id":"receipt","status":"observed","predecessor_run_id":"old-id"}
  class Api:
   def request(s,method,url,payload=None):
    calls.append((method,url))
    if method=="POST":return {"stored":1}
    if "/documents?" in url:return {"documents":[{"doc_type":"record_text","sha256":digest,"body":body,"id":"document"}]}
    if "evidence_changes" in url:return {"changes":[change]}
    return {"records":self.rows,"total":4}
  self.fake.Api=Api;self.fake.ENDPOINT="/coordination";self.fake.board=lambda api,slug:self.board
  dom={"schema":"tam-observed-print-dom","version":1,"text":body,"observed_at_utc":"2026-09-20T00:00:00Z","transport":{"exact_lengths_verified":True},"metrics":{"ready_state":"complete","url":"https://nlcorp.app.netsuite.com/app/common/entity/custjob.nl?id=1&print=T"}}
  path=self.artifacts/"dom.json";m.write(path,dom)
  with patch.object(m,"modules",return_value=(None,self.fake)):
   first=m.refresh_snapshot(self.root,directory);self.assertEqual(first["internalId"],"1")
   dom["observed_at_utc"]=m.read(directory/"refresh_target.json")["selectedAt"];m.write(path,dom)
   self.assertEqual(m.refresh_snapshot(self.root,directory)["internalId"],"1","uncompleted target doesn't skip")
   result=m.refresh_ingest(self.root,directory,path);self.assertEqual(result["status"],"changed")
   m.refresh_ingest(self.root,directory,path)
   self.assertEqual(sum(method=="POST" for method,_ in calls),1,"repeat performs readback, never reuploads uncertain intent")
   self.assertEqual(m.read(directory/"refresh_state.json")["offset"],1)

 def test_refresh_uncertain_upload_does_not_advance_or_replay(self):
  directory=self.artifacts/"refresh";directory.mkdir()
  target={"runSlug":"old-run","internalId":"1","previousRecordTextSha256":"a"*64,"predecessorProvenanceSha256":"b"*64,"nextOffset":1,"selectedAt":"2026-09-19T23:59:00Z"}
  m.write(directory/"refresh_target.json",target)
  body="Full CRM "*200; dom={"schema":"tam-observed-print-dom","version":1,"text":body,"observed_at_utc":"2026-09-20T00:00:00Z","transport":{"exact_lengths_verified":True},"metrics":{"ready_state":"complete","url":"https://nlcorp.app.netsuite.com/app/common/entity/custjob.nl?id=1&print=T"}}
  path=self.artifacts/"dom.json";m.write(path,dom); calls=[]
  class Api:
   def request(s,method,url,payload=None):
    calls.append(method)
    if method=="POST":raise TimeoutError("accepted unknown")
    return {"documents":[]}
  self.fake.Api=Api
  with patch.object(m,"modules",return_value=(None,self.fake)):
   with self.assertRaises(TimeoutError):m.refresh_ingest(self.root,directory,path)
   with self.assertRaisesRegex(ValueError,"not conclusively read back"):m.refresh_ingest(self.root,directory,path)
  self.assertEqual(calls.count("POST"),1);self.assertFalse((directory/"refresh_state.json").exists())

 def test_stale_browser_dom_is_rejected_before_any_network_action(self):
  directory=self.artifacts/"refresh";directory.mkdir()
  m.write(directory/"refresh_target.json",{"runSlug":"old-run","internalId":"1","selectedAt":"2026-09-20T02:00:00Z"})
  path=self.artifacts/"dom.json";m.write(path,{"schema":"tam-observed-print-dom","version":1,"text":"Record "*200,"observed_at_utc":"2026-09-20T01:00:00Z","transport":{"exact_lengths_verified":True},"metrics":{"ready_state":"complete","url":"https://nlcorp.app.netsuite.com/app/common/entity/custjob.nl?id=1&print=T"}})
  with patch.object(m,"modules",return_value=(None,self.fake)):
   with self.assertRaisesRegex(ValueError,"predates refresh"):m.refresh_ingest(self.root,directory,path)

 def test_receipt_loss_after_activation_is_reconciled_without_mutation_or_post(self):
  directory=self.artifacts/"successor";directory.mkdir()
  m.write(directory/"state.json",{"status":"complete","checkpoint_seed_id":"seed"})
  m.write(directory/"plan.json",{"runSlug":"new-run","seedManifestSha256":"manifest","changedEvidenceBindings":[{"receiptId":"r"}]})
  m.write(directory/"context.active.json",{**self.context,"run_slug":"new-run","checkpoint_seed_id":"seed"})
  context_ref=m.reference(self.root,directory/"context.active.json")
  active={"context":context_ref,"checkpointSeedId":"seed"};checkpoint={"runSlug":"new-run","activeGradingRound":active}
  m.write(self.mission_path,checkpoint);live_path=self.mission_path.with_name("tam-regrade-live-state.json");m.write(live_path,checkpoint)
  auth={"approved":True,"runSlug":"new-run","contextSha256":context_ref["sha256"],"maxConcurrentRecords":3,"eachRecordSerialReaderThenValidator":True}
  m.write(directory/"auth.json",auth);control_path=self.root/"automation-control.json";m.write(control_path,{"tamRegrade":{"enabled":True,"mode":"checkpointed-parallel-records","maxConcurrentRecords":3,"parallelAuthorization":m.reference(self.root,directory/"auth.json")}})
  self.fake.Api=lambda:None;self.fake.board=lambda api,run:{"run":{"completed_checkpoint_seed_id":"seed"},"checkpointSeed":{"manifest_sha256":"manifest"}}
  before={p:p.read_bytes() for p in (self.mission_path,live_path,control_path)}
  with patch.object(m,"modules",return_value=(None,self.fake)):result=m.reconcile_activation(self.root,directory)
  self.assertTrue(result["readOnlyReconciled"])
  for path,raw in before.items():self.assertEqual(path.read_bytes(),raw)

 def test_long_capture_registers_and_prepared_core_reads_normal_canonical_locator(self):
  """Exercise real filesystem/PDF I/O past MAX_PATH, without active runtime edits."""
  if os.name=="nt":
   self.assertEqual(self.root.parent,Path(tempfile.gettempdir()).resolve())
   self.tmp.name=str(m.io_path(self.root)) # tempfile cleanup needs long-path I/O too.
  from pypdf import PdfWriter
  from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
  preview=self.artifacts/"preview";preview.mkdir()
  writer=PdfWriter();page=writer.add_blank_page(width=612,height=792)
  font=DictionaryObject({NameObject("/Type"):NameObject("/Font"),NameObject("/Subtype"):NameObject("/Type1"),NameObject("/BaseFont"):NameObject("/Helvetica")})
  page[NameObject("/Resources")]=DictionaryObject({NameObject("/Font"):DictionaryObject({NameObject("/F1"):font})})
  stream=DecodedStreamObject();stream.set_data(b"BT /F1 10 Tf 20 770 Td "+b"(Complete synthetic evidence line for path portability.) Tj 0 -14 Td "*45+b"ET")
  page[NameObject("/Contents")]=stream;buffer=io.BytesIO();writer.write(buffer);pdf=buffer.getvalue()
  text=("Complete synthetic record evidence café. "*60).encode();css=b"body { color: black; }"
  for name,body in (("print.pdf",pdf),("record_text.txt",text),("print_css.css",css)):(preview/name).write_bytes(body)
  observed="2026-09-20T01:00:00Z";url="https://nlcorp.app.netsuite.com/app/common/entity/custjob.nl?id=1&print=T"
  capture={"schema":"tam-current-lead-record-capture","status":"verified","internal_id":"1","snapshot_sha256":"a"*64,
   "captured_at_utc":"2026-09-20T01:01:00Z","observed_at_utc":observed,"print_url":url,"observed_url":url,
   "renderer":{"version":5},"pdf":{"sha256":m.sha(pdf),"bytes":len(pdf),"page_count":1},"record_text":{"sha256":m.sha(text),"bytes":len(text),"characters":len(text.decode())},"shared_print_css":{"sha256":m.sha(css)}}
  m.write(preview/"capture.json",capture);m.write(preview/"artifact_verification.json",{});m.write(preview/"layout_verification.json",{})
  qa=preview/"visual.json";m.write(qa,{"schema":"tam-pdf-independent-visual-qa","status":"passed","internalId":"1","rendererVersion":5,"pages":1,"pdfSha256":m.sha(pdf),"visuallyInspectedPages":[1],"blockingFindings":[]})
  change={**self.registration["change"],"record_text_sha256":m.sha(text),"captured_at":observed}
  self.index["records"]["1"].update(pdf_bytes=123,record_text_bytes=456,renderer_version=4,observed_at="2026-07-28T00:00:00Z",verified_at="2026-09-17T00:00:00Z",freshness="historical_captured_as_of_reuse",provenance_kind="july_registered_capture_reused_as_of_original_date",supplement_path="supplement.json",supplement_sha256="e"*64,supplement_captured_at="2026-09-15T00:00:00Z",membership_status="overlap")
  m.write(self.current/"index.json",self.index);self.context["evidence_index_reference"]=m.reference(self.root,self.current/"index.json")
  m.write(self.current/"context.json",self.context);self.mission["activeGradingRound"]["context"]=m.reference(self.root,self.current/"context.json");m.write(self.mission_path,self.mission)
  spec=importlib.util.spec_from_file_location("tam_verify_captured_pdf_pages",REAL_ROOT/"tools/tam_verify_captured_pdf_pages.py")
  verifier=importlib.util.module_from_spec(spec);spec.loader.exec_module(verifier)
  with patch.object(m,"modules",return_value=(None,self.fake)),patch.dict(sys.modules,{"tam_verify_captured_pdf_pages":verifier}):
   result=m.register_capture(self.root,preview,change,qa)
   with self.assertRaisesRegex(ValueError,"already exists"):m.register_capture(self.root,preview,change,qa)
  entry=result["entry"];package=self.root/entry["package_path"]
  self.assertGreater(len(str(package/"changed_evidence_registration.json")),260)
  self.assertFalse(entry["package_path"].startswith(("\\\\?\\","/")))
  self.assertEqual(m.read(package/"changed_evidence_registration.json")["entry"],entry)
  self.assertEqual(m.bound(self.root,result["pageVerification"]),package/"page_verification.json")
  self.assertEqual(entry["captured_at"],observed)
  self.assertEqual(entry["observed_at"],observed);self.assertEqual(entry["rendered_at"],capture["captured_at_utc"])
  self.assertEqual((entry["pdf_bytes"],entry["record_text_bytes"],entry["record_text_characters"]),(len(pdf),len(text),len(text.decode())))
  self.assertEqual(entry["renderer_version"],5);self.assertEqual(entry["freshness"],"fresh_full_record_capture")
  self.assertEqual(entry["provenance_kind"],"fresh_observed_print_dom_capture")
  self.assertEqual(entry["verified_at"],m.read(package/"page_verification.json")["verified_at_utc"])
  self.assertEqual(entry["supplement_captured_at"],"2026-09-15T00:00:00Z")
  self.assertEqual(entry["inherited_supplement_provenance"]["supplement_sha256"],"e"*64)
  self.assertEqual(entry["membership_status"],"overlap")
  # Repair an old registration outside its immutable package. All evidence and
  # its original registration remain byte-for-byte unchanged.
  before={p.name:p.read_bytes() for p in m.io_path(package).iterdir() if p.is_file()}
  historical={**result,"entry":{**entry,"pdf_bytes":123,"renderer_version":4,"freshness":"historical_captured_as_of_reuse"}}
  stale=self.artifacts/"old-registration.json";m.write(stale,historical)
  repaired=self.artifacts/"repaired-registration.json"
  repaired_result=m.rebuild_registration(self.root,stale,repaired)
  self.assertEqual(repaired_result["entry"],entry)
  self.assertEqual(m.read(repaired)["supersedesRegistration"],m.reference(self.root,stale))
  self.assertEqual(before,{p.name:p.read_bytes() for p in m.io_path(package).iterdir() if p.is_file()})
  with self.assertRaisesRegex(ValueError,"outside the immutable package"):
   m.rebuild_registration(self.root,stale,package/"repair.json")
  self.assertEqual(m.io_path(package/"print.pdf").read_bytes(),pdf)
  if os.name=="nt":self.assertTrue(str(m.io_path(package)).startswith("\\\\?\\"))
  (self.root/"tools").mkdir()
  for name in ("tam_grading_round.py","tam_record_core.py"):(self.root/"tools"/name).write_bytes((REAL_ROOT/"tools"/name).read_bytes())
  m.bundle(self.root,self.artifacts/"long_path_bundle")
  candidate=self.artifacts/"long_path_bundle/tam_record_core.py"
  namespace={"__file__":str(self.root/"tools/tam_record_core.py")}
  exec(compile(candidate.read_text(),str(candidate),"exec"),namespace)
  namespace.update(WORKSPACE=self.root,LEAD_ROOT=self.root/"outputs/tam_refresh_2026-07-27/current_lead_records_v6/leads",
   ROUND_CONTEXT={"evidence_index":{"1":entry}},PDF_TEXT_CACHE=self.artifacts/"pdf_text_cache",assessment_context=lambda:{})
  actual=namespace["trusted_package"]("1")
  self.assertEqual(actual["pdf_sha256"],m.sha(pdf));self.assertEqual(actual["record_text"],text.decode())
  self.assertEqual(actual["pdf_pages"],1);self.assertIn("Complete synthetic evidence",actual["pdf_text"])
  self.assertFalse(str(actual["pdf_path"]).startswith("\\\\?\\"),"I/O prefix must not leak into canonical provenance")
  self.assertEqual(namespace["sha256_file"](actual["capture_path"]),entry["capture_sha256"])
  # Preparing again from precisely the installed candidate is safe and makes
  # identical candidate bytes rather than stacking duplicate helper functions.
  for name in ("tam_grading_round.py","tam_record_core.py"):(self.root/"tools"/name).write_bytes((self.artifacts/"long_path_bundle"/name).read_bytes())
  m.bundle(self.root,self.artifacts/"already_extended_bundle")
  self.assertEqual(candidate.read_bytes(),(self.artifacts/"already_extended_bundle/tam_record_core.py").read_bytes())

if __name__=="__main__":unittest.main()

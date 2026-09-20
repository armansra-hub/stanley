"""Offline lifecycle tests; no canonical files, browser, credentials or APIs."""
import importlib.util
import json
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
  self.board={"run":{"slug":"old-run","id":"old-id","completed_checkpoint_seed_id":"old-seed","status":"grading"},"counts":{"grade_reading":0,"grade_final":0}}
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

if __name__=="__main__":unittest.main()

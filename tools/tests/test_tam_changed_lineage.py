import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import tam_changed_lineage as m

class Lineage(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();self.ident='123';self.time='2026-09-20T10:00:00Z'
        def put(name,data):
            p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(m.encoded(data)+b'\n');return p
        self.put=put
        ctx=put('context.active.json',{'run_slug':'old','checkpoint_seed_id':'seed'})
        candidate=put('grading/candidate.json',{'exact_id':'123','full_record_text_read':True,'full_pdf_read':True,'pdf_pages_read':2})
        validator=put('grading/validator.json',{'exact_id':'123','validation_status':'passed','full_record_text_reread':True,'full_pdf_reread':True})
        validation={'status':'passed','full_pdf_reread':True,'full_record_text_reread':True,'source_hashes_verified':True,'page_count_verified':True}
        validated_data={'exact_id':'123','validation':validation,'candidate_file_sha256':m.sha(candidate.read_bytes()),'pdf_sha256':'p'*64,'record_text_sha256':'t'*64,'assessment_context':{'context_sha256':m.sha(ctx.read_bytes())},'note':'Unicode € retained'}
        validated=put('grading/validated.jsonl',validated_data)
        provenance={'runSlug':'old','pdfSha256':'p'*64,'recordTextSha256':'t'*64,'candidateFileSha256':m.sha(candidate.read_bytes()),'validatorHashScope':'canonical-record','validatorOutputSha256':m.sha(json.dumps(validated_data,ensure_ascii=True,sort_keys=True,separators=(',',':')).encode()),'assessment':{'validation':validation}}
        canonical=m.encoded(provenance).decode()
        self.old={'run_id':'old-id','netsuite_internal_id':'123','company_id':'company','is_current':True,'grade_status':'published','validation_status':'passed','checkpoint_seed_id':'seed','pdf_sha256':'p'*64,'pdf_page_count':2,'published_at':self.time,'grade_provenance':provenance,'grade_provenance_canonical_json':canonical,'grade_provenance_sha256':m.sha(canonical.encode())}
        copied={'runId':'old-id','provenanceSha256':self.old['grade_provenance_sha256'],'publishedAt':self.time}
        successor={**copy.deepcopy(provenance),'runSlug':'new','copiedFrom':copied};text=m.encoded(successor).decode()
        self.seed={'netsuiteInternalId':'123','recoveryCohort':'published_complete','pdfSha256':'p'*64,'pdfPageCount':2,'provenance':{'data':successor,'canonicalJson':text,'sha256':m.sha(text.encode())}}
        self.plan={'runSlug':'new','companies':{'123':'company'},'seedRows':[self.seed]}
        acceptance={'policy':'successor-jev-acceptance-v1','status':'successful_annotations','request_sha256':['request'],'source_sha256':'source'}
        view={'jev_acceptance':acceptance};navhash=m.sha(m.encoded(view))
        put('grading/navigation/frozen-navigation.json',{'cache_key':'cache','navigation_sha256':navhash,'view':view})
        nav=put('grading/navigation/receipt.json',{'schema':'tam-required-jev-preparation','key':'cache',**{k:acceptance[k] for k in ('policy','request_sha256','source_sha256')}})
        event={'id':1,'kind':'grade.published','run_id':'old-id','netsuite_internal_id':'123','created_at':self.time,'metadata':{'company_id':'company','provenance_sha256':self.old['grade_provenance_sha256']}}
        publication=put('grading/published/123.json',{'readback':self.old,'event':event,'payloadSha256':'payload','publishedAt':self.time,'publish':{'ok':True}})
        evidence={'exactId':'123','runSlug':'old','pdfSha256':'p'*64,'pdfPageCount':2,'recordTextSha256':'t'*64,'roundContextSha256':m.sha(ctx.read_bytes()),'evidenceNavigationSha256':navhash}
        self.checkpoint={'exactId':'123','runSlug':'old','stage':'published_readback_verified','status':'complete','publishedPath':str(publication),'publishPayloadSha256':'payload','evidence':evidence,'navigationPreparation':{'status':'required_jev_accepted','policy':'successor-jev-acceptance-v1','path':str(nav),'navigation_sha256':navhash},'candidatePath':str(candidate),'candidateSha256':m.sha(candidate.read_bytes()),'validatorPath':str(validator),'validatorSha256':m.sha(validator.read_bytes()),'validatedPath':str(validated)}
        put('grading/checkpoints/123.json',self.checkpoint)
    def tearDown(self):self.tmp.cleanup()
    def test_exact_direct_lineage_binds_files_and_canonical_record_hash(self):
        result=m.lineage(self.old,self.seed,self.plan,self.root)
        self.assertEqual(len(result['artifacts']),8);self.assertEqual(result['copiedFrom']['provenanceSha256'],self.old['grade_provenance_sha256'])
        self.assertNotEqual(result['artifacts']['validated']['sha256'],result['artifacts']['validated']['canonicalRecordSha256'])
    def test_changed_reader_bytes_are_rejected(self):
        Path(self.checkpoint['candidatePath']).write_text('{}')
        with self.assertRaisesRegex(ValueError,'artifact hash differs'):m.lineage(self.old,self.seed,self.plan,self.root)
    def test_wrong_publication_event_is_rejected(self):
        p=self.root/'grading/published/123.json';data=m.read(p);data['event']['metadata']['provenance_sha256']='wrong';self.put('grading/published/123.json',data)
        with self.assertRaisesRegex(ValueError,'event identity'):m.lineage(self.old,self.seed,self.plan,self.root)
    def test_missing_checkpoint_becomes_explicit_failed_manifest(self):
        (self.root/'grading/checkpoints/123.json').unlink();records=self.put('records.json',[self.old]);plan=self.put('plan.json',self.plan)
        result=m.build(records,plan,self.root);self.assertEqual(result['status'],'failed');self.assertEqual(result['verifiedCount'],0);self.assertEqual(result['anomalies'][0]['internalId'],'123')
    def test_successor_cannot_change_preserved_assessment(self):
        self.seed['provenance']['data']['assessment']['validation']['full_pdf_reread']=False;text=m.encoded(self.seed['provenance']['data']).decode();self.seed['provenance'].update(canonicalJson=text,sha256=m.sha(text.encode()))
        with self.assertRaisesRegex(ValueError,'changed inherited'):m.lineage(self.old,self.seed,self.plan,self.root)
    def recovered_fixture(self):
        source=copy.deepcopy(self.checkpoint['evidence'])
        for role,folder,pathkey in [('reader','candidates','candidatePath'),('validator','validator_raw','validatorPath')]:
            artifact=self.put('grading/'+folder+'/123.original.json',m.read(self.checkpoint[pathkey]))
            receipt={'schema':'tam-full-evidence-model-artifact','version':1,'role':role,'readMode':'direct-full-evidence','completeRawEvidenceCoverage':True,
                     'artifactPath':str(artifact),'artifactSha256':m.ref(artifact)['sha256'],'candidateSha256':self.old['grade_provenance']['candidateFileSha256'] if role=='validator' else None,
                     'evidence':source,'createdAt':self.time}
            self.put('grading/'+folder+'/123.original.json.receipt.json',receipt)
        for name in ('receipt.json','frozen-navigation.json'):
            self.put('grading/navigation/123/original/'+name,m.read(self.root/'grading/navigation'/name))
        cp=copy.deepcopy(self.checkpoint)
        for key in ('navigationPreparation','candidatePath','candidateSha256','validatorPath','validatorSha256'):cp.pop(key)
        cp['evidence'].pop('evidenceNavigationSha256');cp['recoveredReadback']=True
        self.put('grading/checkpoints/123.json',cp)
        pub=m.read(self.root/'grading/published/123.json');pub['recoveredReadback']=True;self.put('grading/published/123.json',pub)
        return cp
    def test_recovered_readback_uses_original_witnesses_without_checkpoint_edit(self):
        cp=self.recovered_fixture();before=m.ref(self.root/'grading/checkpoints/123.json')
        result=m.lineage(self.old,self.seed,self.plan,self.root)
        self.assertEqual(result['artifacts']['checkpoint'],before);self.assertEqual(m.read(before['path']),cp)
        self.assertEqual(len(result['artifacts']),10);self.assertEqual(result['lineageRecovery']['method'],'recovered_readback_source_bound_artifacts')
        self.assertEqual(result['navigation']['navigationSha256'],self.checkpoint['evidence']['evidenceNavigationSha256'])
    def test_recovery_rejects_source_mismatch(self):
        self.recovered_fixture();name='grading/candidates/123.original.json.receipt.json';receipt=m.read(self.root/name)
        receipt['evidence']['recordTextSha256']='different';self.put(name,receipt)
        with self.assertRaisesRegex(ValueError,'reader receipt is missing'):m.lineage(self.old,self.seed,self.plan,self.root)
    def test_recovery_rejects_validator_navigation_mismatch(self):
        self.recovered_fixture();name='grading/validator_raw/123.original.json.receipt.json';receipt=m.read(self.root/name)
        receipt['evidence']['evidenceNavigationSha256']='0'*64;self.put(name,receipt)
        with self.assertRaisesRegex(ValueError,'source/navigation binding differs'):m.lineage(self.old,self.seed,self.plan,self.root)
    def test_recovery_rejects_ambiguous_reader_witness(self):
        self.recovered_fixture();name='grading/candidates/123.original.json.receipt.json';receipt=m.read(self.root/name)
        artifact=self.put('grading/candidates/123.other.json',m.read(receipt['artifactPath']));receipt['artifactPath']=str(artifact)
        self.put('grading/candidates/123.other.json.receipt.json',receipt)
        with self.assertRaisesRegex(ValueError,'reader receipt is missing or ambiguous'):m.lineage(self.old,self.seed,self.plan,self.root)
    def test_recovery_requires_accepted_jev_receipt(self):
        self.recovered_fixture();name='grading/navigation/123/original/receipt.json';receipt=m.read(self.root/name)
        receipt['request_sha256']=['wrong'];self.put(name,receipt)
        with self.assertRaisesRegex(ValueError,'Jev receipt and frozen navigation differ'):m.lineage(self.old,self.seed,self.plan,self.root)
    def second_successor(self):
        first=m.lineage(self.old,self.seed,self.plan,self.root)
        root=self.root/'successor';root.mkdir();plan_path=self.put('successor/plan.json',self.plan)
        self.put('successor/inherited_final_lineage.json',{'schema':'tam-inherited-final-lineage','status':'verified','anomalies':[],'runSlug':'new','verifiedCount':1,'inheritedFinalCount':1,'inputs':{'plan':m.ref(plan_path)},'records':[first]})
        old={**copy.deepcopy(self.old),'run_id':'new-id','checkpoint_seed_id':'new-seed','grade_provenance':copy.deepcopy(self.seed['provenance']['data']),'grade_provenance_sha256':self.seed['provenance']['sha256'],'grade_provenance_canonical_json':self.seed['provenance']['canonicalJson']}
        data={**copy.deepcopy(old['grade_provenance']),'runSlug':'third','copiedFrom':{'runId':old['run_id'],'provenanceSha256':old['grade_provenance_sha256'],'publishedAt':old['published_at']}}
        text=m.encoded(data).decode();seed={**copy.deepcopy(self.seed),'provenance':{'data':data,'canonicalJson':text,'sha256':m.sha(text.encode())}}
        return old,seed,{'runSlug':'third'},root,first
    def test_second_successor_preserves_original_evidence_and_parent_reference(self):
        old,seed,plan,root,first=self.second_successor();result=m.lineage(old,seed,plan,root)
        self.assertEqual(result['artifacts'],first['artifacts']);self.assertEqual(result['publication'],first['publication'])
        self.assertEqual(result['copiedFrom'],seed['provenance']['data']['copiedFrom']);self.assertEqual(len(result['parentManifests']),1)
    def test_tampered_prior_plan_is_rejected(self):
        old,seed,plan,root,_=self.second_successor();(root/'plan.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'artifact hash differs'):m.lineage(old,seed,plan,root)
    def test_tampered_original_artifact_is_rejected_on_second_successor(self):
        old,seed,plan,root,_=self.second_successor();Path(self.checkpoint['validatorPath']).write_text('{}')
        with self.assertRaisesRegex(ValueError,'artifact hash differs'):m.lineage(old,seed,plan,root)
    def test_tampered_parent_manifest_reference_is_rejected(self):
        old,seed,plan,root,_=self.second_successor();path=root/'inherited_final_lineage.json';prior=m.read(path)
        prior['records'][0]['parentManifests']=[{'path':str(self.root/'context.active.json'),'sha256':'wrong'}]
        self.put('successor/inherited_final_lineage.json',prior)
        with self.assertRaisesRegex(ValueError,'artifact hash differs'):m.lineage(old,seed,plan,root)
    def test_long_filesystem_path_keeps_ordinary_manifest_locator(self):
        path=self.root/('x'*100)/('y'*100)/('z'*100)/'artifact.json'
        m.io_path(path.parent).mkdir(parents=True);m.io_path(path).write_bytes(b'{}')
        try:
            self.assertEqual(m.read(path),{});reference=m.ref(path,self.root,m.sha(b'{}'))
            self.assertEqual(reference['path'],str(path));self.assertFalse(reference['path'].startswith('\\\\?\\'))
        finally:
            self.assertTrue(path.is_relative_to(self.root));m.io_path(path).unlink()
            for directory in (path.parent,path.parent.parent,path.parent.parent.parent):m.io_path(directory).rmdir()

if __name__=='__main__':unittest.main()

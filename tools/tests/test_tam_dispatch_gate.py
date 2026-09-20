import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tam_dispatch_gate as gate

class Api:
    def __init__(self, paused=False):
        self.calls=[];self.timeout=False
        self.state={"runId":"run-uuid","runSlug":"exact-run","seedId":"11111111-1111-4111-8111-111111111111","paused":paused,"revision":0,"operationId":None}
    def request(self,method,route,body=None):
        self.calls.append((method,route,copy.deepcopy(body)))
        if method=="GET":return {"gate":copy.deepcopy(self.state)}
        self.state.update(paused=body["paused"],revision=body["expectedRevision"]+1,operationId=body["operationId"])
        if self.timeout:raise TimeoutError("ambiguous response")
        return {"gate":copy.deepcopy(self.state),"operation":{"operationId":body["operationId"]}}

class DispatchGate(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve();self.directory=self.root/"pause"
        self.context=self.root/"context.json";self.context.write_text("{}",encoding="utf-8")
        self.exact={"runSlug":"exact-run","seedId":"11111111-1111-4111-8111-111111111111","context":gate.canonical.reference(self.root,self.context)}
        self.scope=patch.object(gate,"scope",return_value=self.exact);self.scope.start()
    def tearDown(self):self.scope.stop();self.temp.cleanup()
    def test_intent_precedes_write_and_exact_readback_completes(self):
        api=Api();original=api.request
        def request(method,route,body=None):
            if method=="POST":self.assertEqual(gate.canonical.read(self.directory/"intent.json")["payload"],body)
            return original(method,route,body)
        api.request=request
        result=gate.set_gate(self.root,self.directory,True,api)
        self.assertEqual(result["status"],"complete");self.assertEqual([x[0] for x in api.calls],["GET","POST","GET"])
    def test_ambiguous_applied_write_reconciles_with_get_only(self):
        api=Api();api.timeout=True
        with self.assertRaises(TimeoutError):gate.set_gate(self.root,self.directory,True,api)
        self.assertEqual(gate.canonical.read(self.directory/"result.json")["status"],"pending_reconciliation")
        count=len(api.calls);result=gate.reconcile(self.root,self.directory,api)
        self.assertTrue(result["readOnlyReconciled"]);self.assertEqual([x[0] for x in api.calls[count:]],["GET"])
        with self.assertRaisesRegex(ValueError,"never reposted"):gate.set_gate(self.root,self.directory,True,api)
        self.assertEqual(sum(c[0]=="POST" for c in api.calls),1)
    def test_no_retry_when_gate_does_not_prove_exact_operation(self):
        api=Api();api.timeout=True
        with self.assertRaises(TimeoutError):gate.set_gate(self.root,self.directory,True,api)
        api.state["operationId"]="other-operation"
        with self.assertRaisesRegex(ValueError,"without reposting"):gate.reconcile(self.root,self.directory,api)
        self.assertEqual(sum(c[0]=="POST" for c in api.calls),1)
    def test_already_paused_does_not_mutate(self):
        api=Api(paused=True);result=gate.set_gate(self.root,self.directory,True,api)
        self.assertEqual(result["status"],"already_requested_state");self.assertEqual([c[0] for c in api.calls],["GET"])
    def test_resume_is_distinct_expected_state_operation(self):
        api=Api(paused=True);result=gate.set_gate(self.root,self.directory,False,api)
        body=next(c[2] for c in api.calls if c[0]=="POST")
        self.assertTrue(body["expectedPaused"]);self.assertFalse(result["gate"]["paused"])
    def test_scope_mismatch_prevents_write(self):
        api=Api();api.state["seedId"]="wrong-seed"
        with self.assertRaisesRegex(ValueError,"readback differs"):gate.set_gate(self.root,self.directory,True,api)
        self.assertEqual([c[0] for c in api.calls],["GET"])
    def test_modified_intent_is_not_reconciled(self):
        api=Api();gate.set_gate(self.root,self.directory,True,api)
        intent=gate.canonical.read(self.directory/"intent.json");intent["payload"]["paused"]=False;gate.canonical.write(self.directory/"intent.json",intent)
        with self.assertRaisesRegex(ValueError,"intent differs"):gate.reconcile(self.root,self.directory,api)

if __name__=="__main__":unittest.main()

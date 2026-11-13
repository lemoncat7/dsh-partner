import unittest
from collections import OrderedDict
from unittest.mock import patch
import numpy as np
from classifier import Classifier

class FakeEncoder:
    def __init__(self): self.calls=[]
    def encode(self,texts):
        self.calls.append(texts)
        return np.array([[1.,0.] if t.startswith('related') else [0.,1.] for t in texts])

class Tests(unittest.TestCase):
    def fixture(self):
        m=Classifier.__new__(Classifier);m.encoder=FakeEncoder();m.cache=OrderedDict()
        m.labels=['engage','background'];m.weights=np.eye(2);m.bias=np.zeros(2)
        return m
    def test_context_does_not_change_current_intent(self):
        m=self.fixture();before=m.classify('related current')
        after=m.classify('related current',['unrelated history'])
        for key in before: self.assertEqual(before[key],after[key])
        self.assertEqual(after['contextSimilarity'],0)
        self.assertEqual(m.classify('related current',['related history'])['contextSimilarity'],1)
        calls=len(m.encoder.calls);m.classify('related current',['related history']);self.assertEqual(len(m.encoder.calls),calls)
    def test_cache_is_bounded_expires_and_contains_no_plain_text(self):
        m=self.fixture()
        with patch('classifier.time.monotonic',return_value=0):
            for i in range(140):m.classify('private-'+str(i))
        self.assertEqual(len(m.cache),128)
        self.assertTrue(all(isinstance(k,bytes) and len(k)==32 for k in m.cache))
        with patch('classifier.time.monotonic',return_value=121):m.classify('new')
        self.assertEqual(len(m.cache),1)

if __name__=='__main__':unittest.main()

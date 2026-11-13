import json, hashlib, time
from collections import OrderedDict
import numpy as np
from encoder import Encoder

class Classifier:
    def __init__(self, model_dir, head_path):
        self.encoder = Encoder(model_dir)
        self.cache = OrderedDict()
        head = json.loads(head_path.read_text())
        self.labels = head['labels']
        self.weights = np.array(head['weights'], dtype=np.float32)
        self.bias = np.array(head['bias'], dtype=np.float32)

    def classify(self, text, context=None):
        texts=[text]+list(context or [])[:4]
        now=time.monotonic()
        for key, (_, at) in list(self.cache.items()):
            if now-at>120: del self.cache[key]
        keys=[hashlib.sha256(value.encode()).digest() for value in texts]
        missing={key:value for key,value in zip(keys,texts) if key not in self.cache}
        # Encode intent alone: a long current message must not pad every short context row.
        current=missing.pop(keys[0],None)
        if current is not None:self.cache[keys[0]]=(self.encoder.encode([current])[0],now)
        if missing:
            vectors=self.encoder.encode(list(missing.values()))
            for key,vector in zip(missing,vectors): self.cache[key]=(vector,now)
        vectors=[self.cache[key][0] for key in keys]
        for key in keys: self.cache.move_to_end(key)
        while len(self.cache)>128: self.cache.popitem(last=False)
        x=np.array([vectors[0]])
        logits = x @ self.weights + self.bias
        probabilities = np.exp(logits - logits.max())
        probabilities = (probabilities / probabilities.sum())[0]
        order = np.argsort(probabilities)
        result={'label':self.labels[order[-1]], 'confidence':float(probabilities[order[-1]]),
                'margin':float(probabilities[order[-1]]-probabilities[order[-2]]),
                'scores':dict(zip(self.labels, map(float, probabilities)))}
        if len(vectors)>1: result['contextSimilarity']=float(np.clip(max(vectors[0] @ v for v in vectors[1:]),0,1))
        return result

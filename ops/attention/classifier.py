import json, hashlib, time
from collections import OrderedDict
import numpy as np
from encoder import Encoder
from dialogue import CONTEXT_FEATURES, MAX_TURNS, features, predict

class Classifier:
    def __init__(self, model_dir, head_path):
        self.encoder = Encoder(model_dir)
        self.cache = OrderedDict()
        head = json.loads(head_path.read_text())
        self.labels = head['labels']
        self.weights = np.array(head['weights'], dtype=np.float32)
        self.bias = np.array(head['bias'], dtype=np.float32)
        scene_path=head_path.with_name('scene-head.json')
        self.scene=json.loads(scene_path.read_text()) if scene_path.exists() else None
        if self.scene:
            self.scene['weights']=np.array(self.scene['weights'],dtype=np.float32)
            self.scene['bias']=np.array(self.scene['bias'],dtype=np.float32)
        head_file = head_path.with_name('dialogue-head.json')
        self.dialogue_head = None
        if head_file.exists():
            model = json.loads(head_file.read_text())
            if model['version'] != 2 or len(model['weights']) != 2 * self.weights.shape[0] + CONTEXT_FEATURES:
                raise ValueError('Incompatible dialogue ranker')
            self.dialogue_head = {'weights': np.array(model['weights'], dtype=np.float32)}

    def classify(self, text, context=None, frame=None):
        context=list(context or [])[:4]
        frame=frame or {}
        profile=list(frame.get('profile',[]))[:3]
        partner=frame.get('partnerText','')
        legacy_texts=[text]+context+profile+([partner] if partner else [])
        head = getattr(self, 'dialogue_head', None)
        dialogue = frame.get('dialogue', [])[-MAX_TURNS:] if head else []
        texts = legacy_texts + [turn['text'] for turn in dialogue]
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
        def similarity(rows):return float(np.clip(max(vectors[0] @ v for v in rows),0,1))
        if context:result['contextSimilarity']=similarity(vectors[1:1+len(context)])
        if profile:result['profileSimilarity']=similarity(vectors[1+len(context):1+len(context)+len(profile)])
        if partner:result['replySimilarity']=similarity(vectors[len(legacy_texts)-1:len(legacy_texts)])
        if dialogue:
            result['link'] = predict(head, *features(vectors[0], dialogue, vectors[len(legacy_texts):], text))
        scene=getattr(self,'scene',None)
        if scene:
            z=x @ scene['weights']+scene['bias'];p=np.exp(z-z.max());p=(p/p.sum())[0];order=np.argsort(p)
            result['scene']={'label':scene['labels'][order[-1]],'confidence':float(p[order[-1]]),'margin':float(p[order[-1]]-p[order[-2]])}
        return result

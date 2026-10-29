import json
import numpy as np
from encoder import Encoder

class Classifier:
    def __init__(self, model_dir, head_path):
        self.encoder = Encoder(model_dir)
        head = json.loads(head_path.read_text())
        self.labels = head['labels']
        self.weights = np.array(head['weights'], dtype=np.float32)
        self.bias = np.array(head['bias'], dtype=np.float32)

    def classify(self, text):
        x = self.encoder.encode([text])
        logits = x @ self.weights + self.bias
        probabilities = np.exp(logits - logits.max())
        probabilities = (probabilities / probabilities.sum())[0]
        order = np.argsort(probabilities)
        return {'label':self.labels[order[-1]], 'confidence':float(probabilities[order[-1]]),
                'margin':float(probabilities[order[-1]]-probabilities[order[-2]]),
                'scores':dict(zip(self.labels, map(float, probabilities)))}

"""Fit a small regularized softmax head on a frozen encoder (not SetFit fine-tuning)."""
import json, pathlib, argparse
import numpy as np
from encoder import Encoder
p = argparse.ArgumentParser();p.add_argument('--model-dir', required=True);p.add_argument('--output', required=True);args = p.parse_args()
root = pathlib.Path(__file__).parent
rows = json.loads((root / 'training.json').read_text())
labels = sorted({r['label'] for r in rows})
encoder = Encoder(pathlib.Path(args.model_dir))
x = np.concatenate([encoder.encode([r['text'] for r in rows[i:i+8]]) for i in range(0,len(rows),8)])
y = np.eye(len(labels))[[labels.index(r['label']) for r in rows]]
w = np.zeros((x.shape[1], len(labels))); b = np.zeros(len(labels))
for _ in range(1800):
    z = x @ w + b; z -= z.max(axis=1, keepdims=True)
    probabilities = np.exp(z); probabilities /= probabilities.sum(axis=1, keepdims=True)
    error = (probabilities-y)/len(rows)
    w -= 1.5 * (x.T @ error + .001*w); b -= 1.5*error.sum(axis=0)
result = {'version':1, 'encoder':'Xenova/paraphrase-multilingual-MiniLM-L12-v2', 'revision':'2c4055b12046f11709e9df2c122e59ffbdc2f900', 'labels':labels, 'weights':w.tolist(), 'bias':b.tolist(), 'trainingCount':len(rows)}
pathlib.Path(args.output).write_text(json.dumps(result, separators=(',',':')))
print(json.dumps({'trainingCount':len(rows),'trainingAccuracy':float(((x@w+b).argmax(axis=1)==y.argmax(axis=1)).mean())}))

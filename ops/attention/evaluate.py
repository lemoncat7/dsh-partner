import argparse, json, pathlib, time, resource
from classifier import Classifier
p=argparse.ArgumentParser();p.add_argument('--model-dir',required=True);p.add_argument('--head',required=True);args=p.parse_args()
model=Classifier(pathlib.Path(args.model_dir),pathlib.Path(args.head))
rows=json.loads(pathlib.Path(__file__).with_name('evaluation.json').read_text())
results=[];times=[]
for row in rows:
    start=time.perf_counter();result=model.classify(row['text']);times.append((time.perf_counter()-start)*1000)
    results.append({**row,'prediction':result['label'],'confidence':round(result['confidence'],3),'margin':round(result['margin'],3)})
# Relevant routing task: direct calls/sharing must not be excluded as other/background/closing.
positive=[r for r in results if r['label'] in ('address','engage')]
recall=sum(r['prediction'] in ('address','engage') for r in positive)/len(positive)
print(json.dumps({'examples':len(rows),'accuracy':sum(r['label']==r['prediction'] for r in results)/len(rows),'positiveRecall':recall,'p95Ms':sorted(times)[int(len(times)*.95)],'meanMs':sum(times)/len(times),'maxRssMb':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,'results':results},ensure_ascii=False,indent=2))

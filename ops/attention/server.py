"""Single-worker local classifier; no chat storage, outbound requests, or runtime downloads."""
import json, os, pathlib, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from classifier import Classifier
model=Classifier(pathlib.Path(os.environ.get('MODEL_DIR','/model')),pathlib.Path(os.environ.get('HEAD_PATH','/app/head.json')))
# Warm up before readiness. One CPU thread and one request at a time keep memory bounded.
model.classify('你好')
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def send_json(self,status,data):
        body=json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers()
        try:self.wfile.write(body)
        except (BrokenPipeError,ConnectionResetError):pass
    def do_GET(self):
        self.send_json(200 if self.path=='/health' else 404,{'ready':True,'version':1})
    def do_POST(self):
        if self.path!='/classify':return self.send_json(404,{'error':'not found'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=8192:return self.send_json(413,{'error':'invalid size'})
            self.connection.settimeout(2)
            data=json.loads(self.rfile.read(length));text=data.get('text')
            if not isinstance(text,str) or not text.strip() or len(text)>1200:return self.send_json(400,{'error':'invalid text'})
            start=time.perf_counter();result=model.classify(text)
            self.send_json(200,{**result,'elapsedMs':round((time.perf_counter()-start)*1000,2)})
        except (ValueError,TimeoutError,UnicodeError):self.send_json(400,{'error':'invalid request'})
        except Exception:self.send_json(500,{'error':'classification failed'})
HTTPServer(('0.0.0.0',8092),Handler).serve_forever()

"""Single-worker local classifier; no chat storage, outbound requests, or runtime downloads."""
import json, os, pathlib, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from classifier import Classifier
from dialogue import MAX_TURNS
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
        self.send_json(200 if self.path=='/health' else 404,{'ready':True,'version':4,'dialogue':model.dialogue_head is not None})
    def do_POST(self):
        if self.path!='/classify':return self.send_json(404,{'error':'not found'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=16384:return self.send_json(413,{'error':'invalid size'})
            self.connection.settimeout(2)
            data=json.loads(self.rfile.read(length));text=data.get('text')
            if not isinstance(text,str) or not text.strip() or len(text)>1200:return self.send_json(400,{'error':'invalid text'})
            context=data.get('context',[])
            if not isinstance(context,list) or len(context)>4 or any(not isinstance(t,str) or len(t)>48 for t in context):return self.send_json(400,{'error':'invalid context'})
            frame=data.get('frame',{})
            if not isinstance(frame,dict):return self.send_json(400,{'error':'invalid frame'})
            profile=frame.get('profile',[]);partner=frame.get('partnerText','')
            if not isinstance(profile,list) or len(profile)>3 or any(not isinstance(t,str) or len(t)>160 for t in profile) or not isinstance(partner,str) or len(partner)>160:return self.send_json(400,{'error':'invalid frame'})
            dialogue=frame.get('dialogue',[])
            if not isinstance(dialogue,list) or len(dialogue)>MAX_TURNS:return self.send_json(400,{'error':'invalid dialogue'})
            def actor(value):return type(value) is int and 0 <= value < 16
            for index, turn in enumerate(dialogue):
                if (not isinstance(turn,dict) or not actor(turn.get('speaker'))
                    or not isinstance(turn.get('text'),str) or len(turn['text'])>160
                    or ('recipient' in turn and not actor(turn['recipient']))
                    or ('replyTo' in turn and (type(turn['replyTo']) is not int or not 0 <= turn['replyTo'] < index))):
                    return self.send_json(400,{'error':'invalid dialogue turn'})
            start=time.perf_counter();result=model.classify(text,context,{'profile':profile,'partnerText':partner,'dialogue':dialogue})
            self.send_json(200,{**result,'elapsedMs':round((time.perf_counter()-start)*1000,2)})
        except (ValueError,TimeoutError,UnicodeError):self.send_json(400,{'error':'invalid request'})
        except Exception:self.send_json(500,{'error':'classification failed'})
HTTPServer(('0.0.0.0',8092),Handler).serve_forever()

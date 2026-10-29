"""Download pinned public weights ahead of deployment, validating every file."""
import hashlib,json,pathlib,urllib.request
root=pathlib.Path(__file__).parent
manifest=json.loads((root/'model-manifest.json').read_text())
target=root/'model';target.mkdir(exist_ok=True)
for entry in manifest['files']:
    path=target/entry['path']
    def valid(p):
        if not p.exists() or p.stat().st_size!=entry['bytes']:return False
        with p.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()==entry['sha256']
    if valid(path):continue
    temporary=path.with_suffix('.partial')
    url=f"https://huggingface.co/{manifest['repository']}/resolve/{manifest['revision']}/{entry['remotePath']}"
    with urllib.request.urlopen(url,timeout=300) as response,temporary.open('wb') as output:
        while block:=response.read(1024*1024):output.write(block)
    if not valid(temporary):raise RuntimeError(f"Model digest mismatch: {entry['path']}")
    temporary.replace(path);path.chmod(0o644)
print('Pinned model files verified')

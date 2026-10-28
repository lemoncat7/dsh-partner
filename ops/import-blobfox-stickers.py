"""Import selected unmodified PNGs from Volpeon's official Blobfox download.
Source: https://volpeon.ink/emojis/blobfox/ (Apache-2.0).
Usage: python3 ops/import-blobfox-stickers.py /path/to/blobfox.zip
No runtime remote fetches. Original bytes and old builtin IDs are preserved.
"""
from pathlib import Path
import base64, hashlib, json, sys, zipfile
source = Path(sys.argv[1])
expected = '6fe992c847558d795d5bf51025a5b2d9c9f4685fcd01dfd1051a16fcad2fd9b6'
assert hashlib.sha256(source.read_bytes()).hexdigest() == expected, 'Unexpected upstream archive'
choices = [
 ('happy','开心','happy',['开心','得意','赞同']),
 ('grumpy','气鼓鼓','angry',['生气','嘴硬','不满']),
 ('surprise','愣住','0_0',['惊讶','意外','疑惑']),
 ('tired','困了','sleep',['困','疲惫','晚安']),
 ('care','抱抱','catsnuggle',['安慰','陪伴','关心','抱抱']),
 ('skeptic','盯着你','glare',['怀疑','无语','吐槽']),
 ('fox-blush','害羞','blush',['害羞','不好意思']),
 ('fox-smug','小得意','comfysmug',['得意','骄傲','嘴硬']),
 ('fox-laugh','笑出声','crylaugh',['好笑','被逗','开心']),
 ('fox-cry','委屈巴巴','cry',['委屈','难过','哭']),
 ('fox-think','让我想想','thinking',['思考','疑问']),
 ('fox-facepalm','扶额','facepalm',['无语','吐槽','尴尬']),
 ('fox-peek','偷偷看','lurk',['想念','冒泡','在吗']),
 ('fox-heart','给你小心心','heartcute',['喜欢','感谢','关心']),
 ('fox-cheer','加油呀','cheer',['鼓励','庆祝','加油']),
 ('fox-boop','戳一戳','boop',['戳戳','撒娇','亲近']),
 ('fox-coffee','喝口饮料','cofe',['休息','放松','喝茶']),
 ('fox-cookie','吃块饼干','nomcookie',['吃饭','零食','分享']),
 ('fox-comfy','窝着休息','comfy',['放松','舒服','休息']),
 ('fox-flower','送你花花','flower',['感谢','夸奖','送花']),
]
z=zipfile.ZipFile(source);items=[];provenance=[]
for key,name,suffix,tags in choices:
 filename=f'blobfox{suffix}.png';data=z.read(filename)
 items.append(dict(id=f'builtin-{key}',name=name,tags=tags,mediaType='image/png',size=len(data),data=base64.b64encode(data).decode()))
 provenance.append(dict(id=f'builtin-{key}',file=filename,sha256=hashlib.sha256(data).hexdigest()))
root=Path(__file__).resolve().parents[1]
(root/'src/chat/sticker-builtins.ts').write_text('// Selected Blobfox art by Volpeon, Apache-2.0. See docs/THIRD_PARTY_LICENSES.md.\nexport const BUILTIN_STICKERS = '+json.dumps(items,ensure_ascii=False,indent=2)+'\n')
(root/'docs/blobfox-manifest.json').write_text(json.dumps(dict(author='Volpeon',license='Apache-2.0',page='https://volpeon.ink/emojis/blobfox/',download='https://strapi.volpeon.ink/uploads/blobfox_1703c01b78.zip',sha256=expected,files=provenance),ensure_ascii=False,indent=2)+'\n')
print(f'Imported {len(items)} unmodified PNGs, {sum(x["size"] for x in items)} bytes')

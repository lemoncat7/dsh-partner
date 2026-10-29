"""Frozen multilingual sentence encoder. No remote inference or model download at runtime."""
import os
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
os.environ.setdefault('OPENBLAS_NUM_THREADS', '1')
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

class Encoder:
    def __init__(self, directory):
        self.tokenizer = Tokenizer.from_file(str(directory / 'tokenizer.json'))
        self.tokenizer.enable_truncation(max_length=128)
        self.tokenizer.enable_padding(pad_id=0, pad_token='[PAD]')
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self.session = ort.InferenceSession(str(directory / 'model.onnx'), options, providers=['CPUExecutionProvider'])
        self.inputs = {x.name for x in self.session.get_inputs()}

    def encode(self, texts):
        rows = self.tokenizer.encode_batch([s[:1200] for s in texts])
        mask = np.array([r.attention_mask for r in rows], dtype=np.int64)
        feed = {'input_ids': np.array([r.ids for r in rows], dtype=np.int64), 'attention_mask': mask,
                'token_type_ids': np.array([r.type_ids for r in rows], dtype=np.int64)}
        hidden = self.session.run(None, {k: v for k, v in feed.items() if k in self.inputs})[0]
        vectors = (hidden * mask[:, :, None]).sum(axis=1) / np.maximum(mask.sum(axis=1, keepdims=True), 1) if hidden.ndim == 3 else hidden
        return vectors / np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-12)

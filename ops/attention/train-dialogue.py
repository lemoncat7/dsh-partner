"""Train the local previous-message ranker on authored conversation pairs."""
import argparse
import json
from pathlib import Path
import numpy as np
from dialogue import NO_REPLY, features, predict
from encoder import Encoder


def examples(scenarios):
    for number, scene in enumerate(scenarios):
        aside_scene = scenarios[(number + 1) % len(scenarios)]
        for actor in (0, 2):
            other = 2 if actor == 0 else 0
            begin = {'speaker': 1, 'text': scene['opening']}
            prior = {'speaker': actor, 'text': scene['cue']}
            unrelated = {'speaker': other, 'text': scene['aside']}
            yield scene['request'], [begin, prior], 1
            yield scene['request'], [begin, {**prior, 'recipient': 3}], 1
            yield scene['request'], [begin, prior, unrelated], 1
            yield scene['request'], [begin, unrelated, prior], 2
            yield scene['request'], [begin, {**prior, 'speaker': other}, prior], 2
            yield scene['request'], [begin, {**prior, 'replyTo': 0}, {**unrelated, 'replyTo': 0, 'recipient': 1}], 1
            opening = {'speaker': 3, 'text': scene['opening']}
            older = {'speaker': other, 'recipient': 1, 'text': aside_scene['cue'], 'replyTo': 0}
            off_topic = {'speaker': 1, 'text': aside_scene['opening']}
            yield scene['request'], [off_topic, older, opening, prior], 3
            yield scene['request'], [off_topic, older, opening, {**prior, 'recipient': 3}], 3
            yield scene['request'], [off_topic, older, opening, {**prior, 'recipient': 3, 'replyTo': 2}], 3
            yield scene['request'], [off_topic, older, opening], NO_REPLY
            # Opposite replies on the identical interleaved history force the
            # ranker to learn content pairing instead of recency or the author.
            merged = [{**off_topic, 'speaker': 4}, older, opening, {**prior, 'replyTo': 2}]
            yield scene['request'], merged, 3
            yield aside_scene['request'], merged, 1
            merged = [opening, {**prior, 'replyTo': 0}, {**off_topic, 'speaker': 4}, {**older, 'replyTo': 2}]
            yield scene['request'], merged, 1
            yield aside_scene['request'], merged, 3
            yield scene['request'], [begin, older, prior, {**unrelated, 'recipient': 3}], 2
            yield scene['reaction'], [begin, {**prior, 'replyTo': 0}], NO_REPLY
            yield scene['reaction'], [begin, unrelated], NO_REPLY
            yield scene['request'], [off_topic, older], NO_REPLY


def encode(rows, encoder):
    texts = list(dict.fromkeys(text for query, turns, _ in rows for text in [query, *(t['text'] for t in turns)]))
    vectors = {}
    for start in range(0, len(texts), 16):
        batch = texts[start:start + 16]
        vectors.update(zip(batch, encoder.encode(batch)))
    encoded = [features(vectors[query], turns, [vectors[t['text']] for t in turns], query) for query, turns, _ in rows]
    return np.stack([matrix for matrix, _ in encoded]), np.stack([eligible for _, eligible in encoded])


def train(matrix, eligible, labels):
    weights = np.zeros(matrix.shape[-1])
    expected = np.eye(matrix.shape[1])[labels]
    for _ in range(1600):
        logits = np.where(eligible, matrix @ weights, -np.inf)
        scores = np.exp(logits - logits.max(axis=1, keepdims=True))
        scores /= scores.sum(axis=1, keepdims=True)
        error = (scores - expected) / len(matrix)
        weights -= (np.einsum('nkd,nk->d', matrix, error) + .002 * weights)
    return {'weights': weights}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--training', type=Path, default=Path(__file__).with_name('dialogue-training.json'))
    parser.add_argument('--validate', type=Path)
    args = parser.parse_args()
    encoder = Encoder(args.model_dir)
    rows = list(examples(json.loads(args.training.read_text())))
    matrix, eligible = encode(rows, encoder)
    head = train(matrix, eligible, [label for _, _, label in rows])
    artifact = {'version': 2, 'trainingCount': len(rows), 'weights': head['weights'].round(7).tolist()}
    args.output.write_text(json.dumps(artifact, separators=(',', ':')) + '\n')
    report = {'trainingCount': len(rows)}
    if args.validate:
        validation = list(examples(json.loads(args.validate.read_text())))
        labels = [None if label == NO_REPLY else label for _, _, label in validation]
        matrices, eligible = encode(validation, encoder)
        predictions = [predict(head, matrix, flags) for matrix, flags in zip(matrices, eligible)]
        report['validationCount'] = len(labels)
        report['correct'] = sum(p['index'] == label for p, label in zip(predictions, labels))
        report['decisive'] = {
            str(cutoff): {
                'count': sum(p['confidence'] >= cutoff and p['margin'] >= .2 for p in predictions),
                'errors': sum(p['index'] != label and p['confidence'] >= cutoff and p['margin'] >= .2 for p, label in zip(predictions, labels)),
            } for cutoff in (.55, .6, .65, .7)
        }
    print(json.dumps(report))


if __name__ == '__main__':
    main()

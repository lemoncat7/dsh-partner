"""Choose the prior utterance that the current speaker is responding to."""
import numpy as np

MAX_TURNS = 6
NO_REPLY = MAX_TURNS
CONTEXT_FEATURES = 12


def bigrams(text):
    folded = ''.join(char for char in text.casefold() if char.isalnum())
    return {folded[index:index + 2] for index in range(len(folded) - 1)}


def overlap(left, right):
    if not left or not right:
        return 0.
    return len(left & right) / np.sqrt(len(left) * len(right))


def features(query, turns, vectors, text):
    matrix = np.zeros((MAX_TURNS + 1, 2 * len(query) + CONTEXT_FEATURES))
    eligible = np.zeros(MAX_TURNS + 1, dtype=bool)
    eligible[NO_REPLY] = True

    query_terms = bigrams(text)
    terms = [bigrams(turn['text']) for turn in turns]
    for index, (turn, vector) in enumerate(zip(turns, vectors)):
        if turn['speaker'] == 1:
            continue
        eligible[index] = True
        similarity = float(query @ vector)
        previous = turn.get('replyTo')
        parent_similarity = float(query @ vectors[previous]) if previous is not None and 0 <= previous < index else 0.
        separation = len(turns) - 1 - index
        answered = any(later.get('replyTo') == index for later in turns[index + 1:])
        lexical = overlap(query_terms, terms[index])
        parent_lexical = overlap(query_terms, terms[previous]) if previous is not None and 0 <= previous < index else 0.
        matrix[index] = np.concatenate([
            query, .5 * vector,
            [1., similarity, similarity**2, parent_similarity,
             separation / MAX_TURNS, float(turn.get('recipient') == 1),
             float(separation == 0), similarity / (1 + separation),
             float(turn.get('recipient') not in (None, 1)), float(answered), lexical, parent_lexical],
        ])
    # A learned no-reply option competes with every potential parent.
    return matrix, eligible


def predict(head, matrix, eligible):
    logits = np.where(eligible, matrix @ head['weights'], -np.inf)
    scores = np.exp(logits - logits.max())
    scores /= scores.sum()
    order = np.argsort(scores)
    winner, runner = order[-1], order[-2]
    return {'index': None if winner == NO_REPLY else int(winner),
            'confidence': float(scores[winner]), 'margin': float(scores[winner] - scores[runner])}

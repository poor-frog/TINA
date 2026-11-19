"""Only source-valid, actually heard clarification turns count as retries."""


def clarification_attempts(history):
    count=0
    for turn in reversed(history):
        if not turn.get('clarification'): break
        count+=1
    return min(count,3)

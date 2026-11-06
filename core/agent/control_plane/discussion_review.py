"""Owner-only manual discussion reviews; model inference runs in the isolated worker."""
import json
import logging
import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException, Request
from jsonschema import ValidationError
from pydantic import BaseModel, Field

from control_plane.meeting_knowledge import meeting_get, safe_dir
from shared.adapters import WorkspaceBusyError, workspace_write_lock
from shared.discussion_review import RUBRIC, fingerprint, prepare, validate_classification, validate_report


class ReviewRequest(BaseModel):
    model_config = {'extra': 'forbid'}
    agenda: str = Field(min_length=1, max_length=4000)
    expected_id: str | None = Field(default=None, pattern=r'^[a-f0-9]{32}$')


def register(app, subject_of, private_target, reader, meeting_api_url, complete):
    def load(request, meeting_id):
        if meeting_id < 1:
            raise HTTPException(422, 'Invalid meeting ID')
        subject = subject_of(request)
        row = meeting_get(meeting_api_url, subject, meeting_id, f'/meetings/{meeting_id}')
        canonical = meeting_get(meeting_api_url, subject, meeting_id, f'/transcripts/by-id/{meeting_id}/canonical')
        base = private_target(request, None)
        path = reader._workspace_child(base, f'.discussion-reviews/{meeting_id}.json')
        if path is None:
            raise HTTPException(409, 'Invalid discussion review storage')
        report = json.loads(path.read_text(encoding='utf-8')) if path.is_file() else None
        return base, row, canonical, report

    def state(canonical, report, row):
        return {'report': report, 'stale': bool(report and report['source_revision'] != fingerprint(canonical, report['agenda'])),
                'can_generate': row.get('status') == 'completed' and bool(canonical['segments'])}

    @app.get('/api/discussion-reviews/{meeting_id}')
    def review_state(request: Request, meeting_id: int):
        _, row, canonical, report = load(request, meeting_id)
        return state(canonical, report, row)

    @app.post('/api/discussion-reviews/{meeting_id}')
    def generate(request: Request, meeting_id: int, body: ReviewRequest):
        agenda = body.agenda.strip()
        if not agenda:
            raise HTTPException(422, 'Enter an agenda or objective')
        base, row, canonical, previous = load(request, meeting_id)
        if row.get('status') != 'completed':
            raise HTTPException(409, 'Complete the meeting before generating a discussion review')
        revision = fingerprint(canonical, agenda)
        if previous and previous['source_revision'] == revision:
            return state(canonical, previous, row)
        if (previous['id'] if previous else None) != body.expected_id:
            raise HTTPException(409, 'Review changed elsewhere. Reload before generating.')
        try:
            prepared = prepare(canonical, agenda)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        raw = complete(request, json.dumps(prepared, ensure_ascii=False))
        try:
            result = json.loads(raw)
            classified = validate_classification(result['classification'], prepared)
            report = dict(version='discussion-review.v1', id=uuid.uuid4().hex, meeting_id=meeting_id,
                          agenda=agenda, canonical_revision=canonical['revision'], source_revision=revision,
                          rubric=RUBRIC, created_at=datetime.now(timezone.utc).isoformat(), model=result['model'],
                          windows=classified['windows'], sources=prepared['sources'])
            validate_report(report)
        except (ValueError, KeyError, TypeError, ValidationError) as exc:
            logger = logging.getLogger(__name__)
            if isinstance(exc, ValidationError):
                logger.warning('discussion review report rejected by schema path=%s rule=%s',
                               '.'.join(str(part) for part in exc.absolute_path), exc.validator)
            else:
                logger.warning('discussion review model result rejected error=%s detail=%s',
                               type(exc).__name__, str(exc)[:300])
            raise HTTPException(502, 'The model returned invalid classifications or evidence. Please retry.') from exc
        try:
            with workspace_write_lock(base):
                latest_base, latest_row, latest, current = load(request, meeting_id)
                if latest_base != base or latest_row.get('status') != 'completed' or fingerprint(latest, agenda) != revision:
                    raise HTTPException(409, 'Transcript or workspace changed. Generate again from the current source.')
                if (current['id'] if current else None) != body.expected_id:
                    raise HTTPException(409, 'Review changed elsewhere. Reload before generating.')
                directory = safe_dir(reader, base, '.discussion-reviews')
                with tempfile.NamedTemporaryFile(dir=directory, mode='w', encoding='utf-8', delete=False) as out:
                    temporary = Path(out.name)
                    json.dump(report, out, ensure_ascii=False)
                try:
                    os.replace(temporary, directory / f'{meeting_id}.json')
                finally:
                    temporary.unlink(missing_ok=True)
        except WorkspaceBusyError as exc:
            raise HTTPException(409, 'Workspace is busy. Retry shortly.') from exc
        return state(latest, report, latest_row)

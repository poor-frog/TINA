ARG AGENT_API_BASE=tina/v012-agent-api:staging-reach
ARG RUNTIME_BASE=tina/v012-runtime:staging-with-agent
ARG GATEWAY_BASE=tina/v012-gateway:aws-staging

FROM ${AGENT_API_BASE} AS agent
COPY core/agent/control_plane/api.py core/agent/control_plane/dispatch.py core/agent/control_plane/meeting_knowledge.py /app/control_plane/
COPY core/agent/control_plane/post_meeting_draft_jobs.py /app/control_plane/
COPY core/agent/worker/post_meeting_draft.py /app/worker/

FROM ${RUNTIME_BASE} AS runtime
COPY core/runtime/src/runtime_kernel/ecs_backend.py core/runtime/src/runtime_kernel/kernel.py /app/src/runtime_kernel/

FROM ${GATEWAY_BASE} AS gateway
# The staging base has its own matching route manifests. Apply the identity
# change to that Gateway version without advancing its route surface.
RUN python - <<'PY'
from pathlib import Path

gateway = Path("/app/src/gateway/app.py")
source = gateway.read_text()
anchor = '        headers["x-user-id"] = str(user_id)\n'
if source.count(anchor) != 1:
    raise ValueError("Unexpected Gateway version")
gateway.write_text(source.replace(
    anchor,
    anchor + '        if _agent_present and request.url.path.startswith("/agent/"):\n'
             '            headers["x-gateway-verified"] = "1"\n',
))
PY

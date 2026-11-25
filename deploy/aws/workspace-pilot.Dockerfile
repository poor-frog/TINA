ARG WORKER_BASE
ARG AGENT_BASE
ARG RUNTIME_BASE

FROM ${WORKER_BASE} AS worker
RUN uv pip install --python /opt/venv/bin/python --no-cache boto3 && \
    mkdir -p /workspaces && chown 1000:1000 /workspaces && chmod 0755 /workspaces
COPY core/agent/shared/s3_workspace.py /app/shared/
COPY core/agent/llm/bedrock_converse.py core/agent/llm/bedrock_workspace.py core/agent/llm/claude_code.py core/agent/llm/registry.py /app/llm/
COPY core/agent/worker/engine.py core/agent/worker/workspace_stream.py core/agent/worker/workspace_sync.py /app/worker/

FROM ${AGENT_BASE} AS agent
COPY core/agent/shared/s3_workspace.py /app/shared/
COPY core/agent/llm/bedrock_converse.py /app/llm/
COPY core/agent/worker/local_completion.py /app/worker/
COPY core/agent/control_plane/api.py core/agent/control_plane/aws_voice_chatgpt.py core/agent/control_plane/dispatch.py core/agent/control_plane/git_credentials.py core/agent/control_plane/local_completion.py core/agent/control_plane/meeting_voice_completion.py core/agent/control_plane/system_mounts.py core/agent/control_plane/workspace_attach.py core/agent/control_plane/workspace_membership.py core/agent/control_plane/workspace_reader.py core/agent/control_plane/workspace_store.py core/agent/control_plane/routines.py core/agent/control_plane/workspace_routines.py core/agent/control_plane/config.v1.json /app/control_plane/

FROM ${RUNTIME_BASE} AS runtime
COPY core/runtime/src/runtime_kernel/__main__.py core/runtime/src/runtime_kernel/ecs_backend.py core/runtime/src/runtime_kernel/dynamic_workspace.py core/runtime/src/runtime_kernel/s3_workspace.py core/runtime/src/runtime_kernel/egress_proxy.py core/runtime/src/runtime_kernel/enforcement.py core/runtime/src/runtime_kernel/profiles.py core/runtime/src/runtime_kernel/workspace_tasks.py core/runtime/src/runtime_kernel/kernel.py core/runtime/src/runtime_kernel/config.v1.json /app/src/runtime_kernel/

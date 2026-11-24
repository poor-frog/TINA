ARG WORKER_BASE
ARG AGENT_BASE
ARG RUNTIME_BASE

FROM ${WORKER_BASE} AS worker
COPY core/agent/worker/engine.py core/agent/worker/workspace_stream.py /app/worker/

FROM ${AGENT_BASE} AS agent
COPY core/agent/control_plane/api.py core/agent/control_plane/aws_voice_chatgpt.py core/agent/control_plane/dispatch.py core/agent/control_plane/system_mounts.py core/agent/control_plane/workspace_reader.py core/agent/control_plane/routines.py core/agent/control_plane/workspace_routines.py core/agent/control_plane/config.v1.json /app/control_plane/

FROM ${RUNTIME_BASE} AS runtime
COPY core/runtime/src/runtime_kernel/ecs_backend.py core/runtime/src/runtime_kernel/profiles.py core/runtime/src/runtime_kernel/workspace_tasks.py core/runtime/src/runtime_kernel/kernel.py core/runtime/src/runtime_kernel/config.v1.json /app/src/runtime_kernel/

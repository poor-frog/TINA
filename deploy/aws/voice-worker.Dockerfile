FROM tina/v012-agent-api:staging-voice

RUN uv pip install --python /opt/venv/bin/python boto3==1.44.9
COPY core/agent/worker /app/worker
COPY core/agent/llm /app/llm
COPY core/agent/control_plane/api.py core/agent/control_plane/meeting_voice_completion.py core/agent/control_plane/meeting_knowledge.py core/agent/control_plane/openai_auth.py core/agent/control_plane/aws_voice_chatgpt.py /app/control_plane/

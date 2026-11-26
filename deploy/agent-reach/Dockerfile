FROM python:3.12-slim
RUN pip install --no-cache-dir uv==0.9.22
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_LINK_MODE=copy PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH=/opt/venv/bin:$PATH HOME=/tmp/tina-reach
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-install-project --no-default-groups
COPY server.py runner.py ./
RUN install -d -m 0700 -o 65532 -g 65532 /tmp/tina-reach/.agent-reach
VOLUME ["/tmp/tina-reach"]
USER 65532:65532
CMD ["python", "server.py"]

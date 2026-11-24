FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app/gipformer

RUN apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY deploy/transcription/requirements-asr.txt /app/requirements-asr.txt
COPY deploy/transcription/gipformer/requirements.txt ./requirements.txt
# The runtime is CPU-only; install official CPU wheels first so pip doesn't pull CUDA runtimes.
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu \
      torch==2.14.1+cpu torchaudio==2.11.0+cpu \
    && sed -i -e '/^torch==/d' -e '/^torchaudio==/d' /app/requirements-asr.txt \
    && pip install --no-cache-dir -r requirements.txt

COPY deploy/transcription/gipformer/server.py \
     deploy/transcription/gipformer/engine.py \
     deploy/transcription/gipformer/install-models.py \
     deploy/transcription/gipformer/model-assets.json ./

COPY deploy/transcription/http_worker.py deploy/transcription/asr_audio.py \
     deploy/transcription/asr_assets.py deploy/transcription/asr_telemetry.py \
     deploy/transcription/fsmn-assets.json /app/

EXPOSE 8000
CMD ["python", "server.py"]

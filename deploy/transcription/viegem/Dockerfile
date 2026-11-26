FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app/viegem

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential cmake libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY deploy/transcription/requirements-asr.txt /app/requirements-asr.txt
COPY deploy/transcription/viegem/requirements.txt ./requirements.txt
ARG TORCH_VARIANT=cpu
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/${TORCH_VARIANT} \
      torch==2.14.1+${TORCH_VARIANT} torchaudio==2.11.0+${TORCH_VARIANT} \
    && sed -i -e '/^torch==/d' -e '/^torchaudio==/d' /app/requirements-asr.txt \
    && pip install --no-cache-dir -r requirements.txt

COPY deploy/transcription/http_worker.py deploy/transcription/asr_audio.py \
     deploy/transcription/asr_assets.py deploy/transcription/asr_telemetry.py \
     deploy/transcription/fsmn-assets.json /app/
COPY deploy/transcription/viegem/server.py \
     deploy/transcription/viegem/engine.py \
     deploy/transcription/viegem/install-models.py \
     deploy/transcription/viegem/model-assets.json \
     deploy/transcription/viegem/custom_words.txt ./

EXPOSE 8000
CMD ["python", "server.py"]

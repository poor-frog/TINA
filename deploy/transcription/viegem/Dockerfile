FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app/viegem

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential cmake libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY deploy/transcription/gipformer/requirements.txt /app/gipformer/requirements.txt
COPY deploy/transcription/viegem/requirements.txt ./requirements.txt
ARG TORCH_VARIANT=cpu
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/${TORCH_VARIANT} \
      torch==2.14.1+${TORCH_VARIANT} torchaudio==2.11.0+${TORCH_VARIANT} \
    && sed -e '/^torch==/d' -e '/^torchaudio==/d' /app/gipformer/requirements.txt > /app/gipformer/requirements-rest.txt \
    && sed '/^-r /d' requirements.txt > requirements-viegem.txt \
    && pip install --no-cache-dir -r /app/gipformer/requirements-rest.txt -r requirements-viegem.txt

COPY deploy/transcription/gipformer/engine.py \
     deploy/transcription/gipformer/telemetry.py \
     deploy/transcription/gipformer/install-models.py \
     deploy/transcription/gipformer/model-assets.json /app/gipformer/
COPY deploy/transcription/http_worker.py /app/http_worker.py
COPY deploy/transcription/viegem/server.py \
     deploy/transcription/viegem/engine.py \
     deploy/transcription/viegem/install-models.py \
     deploy/transcription/viegem/model-assets.json \
     deploy/transcription/viegem/custom_words.txt ./

EXPOSE 8000
CMD ["python", "server.py"]

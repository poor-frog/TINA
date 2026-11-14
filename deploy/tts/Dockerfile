FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 HF_HOME=/models HF_HUB_OFFLINE=1 \
    TINA_TTS_HOST=0.0.0.0 TINA_TTS_PORT=8000 OMP_NUM_THREADS=2
COPY requirements.txt ./
RUN pip install --no-cache-dir --require-hashes -r requirements.txt
COPY engine.py server.py speech_text.py voice_profile.py benchmark.py pronunciations.json install_models.py model-assets.json ./
RUN useradd --uid 10001 --create-home tts
USER 10001:10001
EXPOSE 8000
CMD ["python", "server.py"]

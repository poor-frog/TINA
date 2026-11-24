FROM python:3.12-slim AS diarization
WORKDIR /app
COPY deploy/transcription/diarization/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY deploy/transcription/diarization/server.py ./
COPY deploy/aws/diarization-bootstrap.py ./
ENV TINA_DIARIZATION_MODELS=/tmp/tina-diarization
CMD ["python", "diarization-bootstrap.py"]

# MFA and its Kaldi dependencies are packaged for linux/amd64 in Bioconda.
FROM mambaorg/micromamba:2.5.0 AS alignment
USER root
WORKDIR /app
COPY deploy/transcription/alignment/requirements.txt ./
ENV MFA_CONDA_EXE=/bin/micromamba \
    MFA_CONDA_PREFIX=/opt/mfa \
    MFA_ROOT_DIR=/opt/mfa-data \
    MFA_DICTIONARY=/opt/mfa-data/pretrained_models/dictionary/vietnamese_mfa.dict \
    MFA_ACOUSTIC_MODEL=/opt/mfa-data/pretrained_models/acoustic/vietnamese_mfa.zip
RUN micromamba create --yes --prefix /opt/mfa -c conda-forge -c bioconda python=3.11 pip montreal-forced-aligner=3.3.4 \
    && /opt/mfa/bin/python -m pip install --no-cache-dir -r requirements.txt \
    && micromamba run --prefix /opt/mfa mfa model download acoustic vietnamese_mfa --version 3.0.0 \
    && micromamba run --prefix /opt/mfa mfa model download dictionary vietnamese_mfa --version 3.0.0 \
    && test -s "$MFA_ACOUSTIC_MODEL" && test -s "$MFA_DICTIONARY" \
    && micromamba clean --all --yes
COPY deploy/transcription/alignment/server.py ./
ENTRYPOINT []
CMD ["/bin/micromamba", "run", "--prefix", "/opt/mfa", "python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8015"]

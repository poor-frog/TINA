FROM tina/tts:dev

COPY --from=vieneu_assets --chown=10001:10001 . /models/
RUN --network=none python install_models.py

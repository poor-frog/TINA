FROM tina/v012-viegem:staging-cpu-base

COPY --from=viegem_assets base /app/models/viegem-fsmn/base
COPY --from=viegem_assets viegem /app/models/viegem-fsmn/viegem
COPY --from=viegem_assets fsmn-vad /app/models/viegem-fsmn/fsmn-vad
RUN python -c "from engine import verify_model_assets; from pathlib import Path; verify_model_assets(Path('/app/models/viegem-fsmn'))"

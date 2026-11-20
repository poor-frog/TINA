import time

# Monotonic process-local boot interval; model/provider cold start remains separately unavailable.
WORKER_BOOT_AT = time.perf_counter()

from worker.worker import main

main()

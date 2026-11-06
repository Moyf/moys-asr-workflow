"""Small shared MAW Python helpers."""

import os

# hf-xet's native TLS is still affected by RUSTSEC-2026-0382/0383.
# Apply before optional Hub imports, including standalone source CLI entrypoints.
# Worker environments also enforce this policy for their child processes.
os.environ["HF_HUB_DISABLE_XET"] = "1"

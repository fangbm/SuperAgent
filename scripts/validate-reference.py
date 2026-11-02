"""Run the v0.9 reference checks against canonical M0 schemas and frozen DDL.

No source platform, LLM or outbound API is contacted. Reference files stay intact.
"""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = ROOT / "docs/reference/v0.9"

with tempfile.TemporaryDirectory(prefix="superagent-contract-check-") as workspace:
    target = Path(workspace)
    for name in ("tests", "migrations"):
        shutil.copytree(REFERENCE / name, target / name)
    for name in ("schemas", "fixtures"):
        shutil.copytree(ROOT / "packages/contracts" / name, target / name)
    for config in (ROOT / "config").glob("*.json"):
        shutil.copy2(config, target / config.name)
    tests = sorted((target / "tests").glob("validate_*.py"))
    for test in tests:
        print(f"RUN {test.name}", flush=True)
        subprocess.run([sys.executable, "-X", "utf8", str(test)], check=True)
    print(f"PASS: {len(tests)} reference suites against canonical M0 schemas")

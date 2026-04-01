import os
import yaml
from pathlib import Path


def load_config(path: str = None) -> dict:
    if path is None:
        path = Path(__file__).parent.parent / "config.yaml"
    with open(path) as f:
        raw = f.read()
    # Resolve ${ENV_VAR:-default} patterns
    import re
    def _resolve(match):
        var = match.group(1)
        default = match.group(2) if match.group(2) else ""
        return os.environ.get(var, default)
    resolved = re.sub(r"\$\{(\w+)(?::-([^}]*))?\}", _resolve, raw)
    return yaml.safe_load(resolved)


def ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)
    return path

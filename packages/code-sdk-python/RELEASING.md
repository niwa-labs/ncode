# Verifying Python SDK packages

Ncode's **Python SDK package verification** workflow builds and checks the wheel and source
distribution. The SDK keeps the upstream distribution name `minimax-code-sdk` and import
`minimax_code`. The workflow saves the checked archives as a GitHub Actions artifact.

When changing the SDK version, update `version` in `pyproject.toml`, `__version__` in
`src/minimax_code/__init__.py`, and the first version heading in `CHANGELOG.md`. The checker
accepts canonical PEP 440 versions such as `0.1.0` and `0.1.0rc1`.

Run the checks from `packages/code-sdk-python`:

```bash
uv sync --locked
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest -W error
version="$(uv run --no-project python scripts/release_check.py metadata)"
out="$(mktemp -d)"
uv build --out-dir "$out/dist"
uvx twine check --strict "$out"/dist/*
uv run --no-project python scripts/release_check.py dist "$out/dist" --version "$version"
```

The workflow additionally scans the extracted archives with the repository's public text policy
and Gitleaks, then installs the wheel in an empty virtual environment and checks its import and
version.

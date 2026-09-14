"""Build an offline, single-file version using only the Python standard library."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
html = (ROOT / "dist/index.html").read_text(encoding="utf-8")
css = (ROOT / "dist/styles.css").read_text(encoding="utf-8")
core = (ROOT / "dist/core.js").read_text(encoding="utf-8")
app = (ROOT / "dist/app.js").read_text(encoding="utf-8")
html = html.replace('<link rel="stylesheet" href="styles.css">', '<style>' + css + '</style>')
html = html.replace('<script src="core.js"></script><script src="app.js"></script>', '<script>' + core + '</script><script>' + app + '</script>')
(ROOT / "work_analysis_mock.html").write_text(html, encoding="utf-8")
print("Built work_analysis_mock.html")

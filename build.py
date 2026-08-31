from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "js" / "modules-src"
OUT = ROOT / "js" / "app.bundle.js"
MODULES = [
    "core.js", "auth.js", "service-report.js", "customers.js", "admin.js",
    "email.js", "ui.js", "pdf.js", "history.js", "leave.js", "dispatch.js",
    "cash-advance.js", "home.js", "tracker.js", "announcements.js"
]
# encoding="utf-8" is required here — without it, Python on Windows falls back
# to the system's regional codepage (often cp1252), which crashes on the
# em-dashes, arrows, and emoji used throughout these source files.
body = "\n\n".join((SRC / name).read_text(encoding="utf-8") for name in MODULES)
OUT.write_text(
    '(function(){\n  "use strict";\n' + body + '\n})();\n',
    encoding="utf-8"
)
print(f"Built {OUT} from {len(MODULES)} source modules")

#!/bin/sh
# Start the practice simulator on http://127.0.0.1:5000
cd "$(dirname "$0")" || exit 1
exec .venv/bin/python app.py

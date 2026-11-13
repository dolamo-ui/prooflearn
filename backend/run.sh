#!/bin/bash
# Starts the ProofLearn backend on Mac / Linux:  bash run.sh
cd "$(dirname "$0")"
if [ ! -d venv ]; then
  echo "Creating the Python environment (first time only)..."
  python3 -m venv venv && . venv/bin/activate && pip install --upgrade pip && pip install -r requirements.txt
else
  . venv/bin/activate
fi
if [ ! -f .env ]; then
  cp .env.example .env
  echo; echo "A new file called .env was created. Open it, paste your GROQ_API_KEY, save it, then run this again."; exit 0
fi
python -m uvicorn app.main:app --reload --port 8000

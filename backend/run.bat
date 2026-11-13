@echo off
REM Starts the ProofLearn backend on Windows. Double-click it, or run:  run.bat
cd /d "%~dp0"
if not exist venv (
  echo Creating the Python environment (first time only)...
  python -m venv venv
  call venv\Scripts\activate.bat
  python -m pip install --upgrade pip
  pip install -r requirements.txt
) else (
  call venv\Scripts\activate.bat
)
if not exist .env (
  copy .env.example .env >nul
  echo.
  echo A new file called .env was created. Open it, paste your GROQ_API_KEY, save it, then run this again.
  pause
  exit /b
)
python -m uvicorn app.main:app --reload --port 8000

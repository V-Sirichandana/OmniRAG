# OmniRAG backend (FastAPI)
```
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # set JWT_SECRET and at least one LLM key
uvicorn app.main:app --reload --port 8000
```
Docs: http://localhost:8000/docs

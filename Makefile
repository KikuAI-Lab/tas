.PHONY: install run test lint format clean docker-build docker-run

install:
	poetry install

run:
	poetry run uvicorn app.main:app --reload

test:
	poetry run python tests/test_report_csv.py

lint:
	poetry run ruff check app/
	poetry run mypy app/ || true

format:
	poetry run ruff format app/

clean:
	find . -type d -name __pycache__ -exec rm -r {} +
	find . -type f -name "*.pyc" -delete
	find . -type f -name "*.pyo" -delete

docker-build:
	docker build -t tas .

docker-run:
	docker run -p 8000:8000 --env-file .env tas


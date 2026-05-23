FROM python:3.12-slim
WORKDIR /app
COPY server.py .
RUN pip install --no-cache-dir flask flask-cors google-cloud-storage gunicorn
ENV PORT=8080
CMD exec gunicorn --bind :$PORT --workers 1 --threads 4 --timeout 120 server:app

FROM python:3.12-slim
WORKDIR /app
COPY server.py ./server.py
COPY dist ./dist
ENV HOST=0.0.0.0 PORT=8080 PYTHONUNBUFFERED=1
EXPOSE 8080
USER 65532:65532
CMD ["python", "server.py"]

# hdnews — 정적 사이트 재현 실행용 이미지
# GitHub Pages 와 동일하게 저장소 파일을 그대로 서빙합니다 (별도 빌드 없음).
FROM python:3.12-slim

WORKDIR /app
COPY . .

# listen 포트는 실행 시 PORT 환경변수로 주입됩니다 (없으면 3000).
CMD ["sh", "-c", "python3 -m http.server ${PORT:-3000} --bind 0.0.0.0"]

IMAGE    ?= edunest
TAG      ?= latest
# UGREEN DXP NAS models are x86_64
PLATFORM ?= linux/amd64
PORT     ?= 18777

.PHONY: dev-backend dev-frontend sample build build-nas save push run stop

## Local development (two terminals): backend on :18777, Vite on :5173 (proxies /api)
dev-backend:
	cd backend && [ -d .venv ] || python3.12 -m venv .venv; \
	.venv/bin/pip install -q -r requirements.txt && \
	EDUNEST_DATA_DIR=$(CURDIR)/.data EDUNEST_LIBRARIES=$(CURDIR)/sample-media \
	.venv/bin/uvicorn app.main:app --reload --port $(PORT)

dev-frontend:
	cd frontend && npm install && npm run dev

## Generate fake sample videos into ./sample-media (needs Docker)
sample:
	./scripts/make_sample_media.sh

## Build image for this machine (for local testing)
build:
	docker build -t $(IMAGE):$(TAG) .

## Build image for the NAS (x86_64)
build-nas:
	docker buildx build --platform $(PLATFORM) --provenance=false --sbom=false -t $(IMAGE):$(TAG) --load .

## Export the NAS image to a .tar you can import in the UGREEN Docker app (Image → Import)
save: build-nas
	docker save $(IMAGE):$(TAG) -o $(IMAGE)-$(TAG).tar
	@echo "Copy $(IMAGE)-$(TAG).tar to the NAS and import it in the Docker app."

## Push to a registry, e.g. make push IMAGE=ghcr.io/<you>/edunest
push:
	docker buildx build --platform $(PLATFORM) -t $(IMAGE):$(TAG) --push .

## Run the locally built image against ./sample-media on http://localhost:8090
run: build
	docker rm -f edunest-local 2>/dev/null || true
	docker run -d --name edunest-local -p 8090:8080 \
	  -e EDUNEST_LIBRARIES=/media/sample \
	  -v $(CURDIR)/sample-media:/media/sample:ro \
	  -v edunest-local-data:/data $(IMAGE):$(TAG)
	@echo "EduNest running on http://localhost:8090"

stop:
	docker rm -f edunest-local

#!/usr/bin/env bash
# Generates a small fake course library in ./sample-media for local development.
# Uses ffmpeg inside a throwaway Docker container, so nothing needs installing on the host.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="$PWD/sample-media"
mkdir -p "$OUT"

docker run --rm -v "$OUT:/out" alpine:3.20 sh -c '
set -e
apk add --no-cache ffmpeg >/dev/null
mk() { # path seconds color label
  mkdir -p "$(dirname "/out/$1")"
  [ -f "/out/$1" ] && return 0
  ffmpeg -v error -f lavfi -i "testsrc2=size=1280x720:rate=25:duration=$2" \
    -f lavfi -i "sine=frequency=440:duration=$2" \
    -vf "drawbox=c=$3@0.6:t=fill,drawtext=text=$4:fontsize=64:fontcolor=white:x=(w-tw)/2:y=(h-th)/2" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest "/out/$1" 2>/dev/null \
  || ffmpeg -v error -f lavfi -i "testsrc2=size=1280x720:rate=25:duration=$2" \
    -f lavfi -i "sine=frequency=440:duration=$2" \
    -vf "drawbox=c=$3@0.6:t=fill" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest "/out/$1"
}
mk "Deep Learning/01 - Foundations/01 Introduction.mp4" 60 blue Intro
mk "Deep Learning/01 - Foundations/02 Perceptron.mp4" 90 navy Perceptron
mk "Deep Learning/01 - Foundations/10 Backpropagation.mp4" 120 purple Backprop
mk "Deep Learning/02 - CNNs/01 Convolutions.mp4" 75 green Conv
mk "Deep Learning/02 - CNNs/02 Pooling.mp4" 45 olive Pooling
mk "NLP/Attention Is All You Need [dQw4w9WgXcQ].mp4" 150 maroon Attention
mk "NLP/Tokenization_basics.mp4" 40 teal Tokens
mk "ML Systems/1. Overview.mp4" 50 orange Overview
'

# A yt-dlp style sidecar with chapters for the NLP lesson
cat > "$OUT/NLP/Attention Is All You Need [dQw4w9WgXcQ].info.json" <<'JSON'
{"id": "dQw4w9WgXcQ", "extractor_key": "Youtube", "title": "Attention Is All You Need — Paper Explained",
 "description": "A walkthrough of the Transformer paper.\nTimestamps in chapters.", "channel": "Sample Channel",
 "upload_date": "20240115", "duration": 150,
 "chapters": [{"start_time": 0, "end_time": 30, "title": "Intro"},
              {"start_time": 30, "end_time": 90, "title": "Self-attention"},
              {"start_time": 90, "end_time": 150, "title": "Multi-head attention"}]}
JSON

# Subtitles for one lesson
cat > "$OUT/Deep Learning/01 - Foundations/01 Introduction.en.srt" <<'SRT'
1
00:00:01,000 --> 00:00:05,000
Welcome to the deep learning course.

2
00:00:05,500 --> 00:00:10,000
Today we cover the foundations.
SRT

echo "Sample library ready in $OUT"
find "$OUT" -type f | sort

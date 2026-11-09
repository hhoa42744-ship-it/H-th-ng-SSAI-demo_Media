#!/usr/bin/env bash
# exit on error
set -o errexit

# Cài đặt ffmpeg trên môi trường Linux của Render
apt-get update && apt-get install -y ffmpeg
#!/bin/sh
set -eu

idlerpg_data_dir="${IDLERPG_DATA_DIR:-/data}"
mkdir -p "$idlerpg_data_dir"

if [ ! -f "$idlerpg_data_dir/events.txt" ]; then
  cp /app/data/events.example.txt "$idlerpg_data_dir/events.txt"
  echo "[IdleRPG] Created $idlerpg_data_dir/events.txt from the bundled defaults."
fi

if [ ! -f "$idlerpg_data_dir/events.pt-BR.txt" ]; then
  cp /app/data/events.pt-BR.example.txt "$idlerpg_data_dir/events.pt-BR.txt"
  echo "[IdleRPG] Created $idlerpg_data_dir/events.pt-BR.txt from the bundled Brazilian Portuguese defaults."
fi

if [ ! -f "$idlerpg_data_dir/config.json" ]; then
  cp /app/data/config.example.json "$idlerpg_data_dir/config.json"
  echo "[IdleRPG] Created $idlerpg_data_dir/config.json. Configure channelIds and DISCORD_TOKEN before restarting."
fi

exec "$@"

#!/bin/bash

# Development helper script for GClip Enhanced
# Syncs changes and reloads extension automatically

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/gclip-enhanced@abhiwizardbyte.dev"
DEV_DIR="$(pwd)"

echo "🔄 Syncing files to extension directory..."

# Copy modified files
rsync -av --exclude='.git' \
    --exclude='node_modules' \
    --exclude='dev.sh' \
    --exclude='watch.sh' \
    --exclude='README.md' \
    "$DEV_DIR/" "$EXT_DIR/"

echo "📦 Recompiling schemas..."
glib-compile-schemas "$EXT_DIR/schemas/"

echo "🔄 Reloading extension..."
gnome-extensions disable gclip-enhanced@abhiwizardbyte.dev 2>/dev/null
sleep 0.5
gnome-extensions enable gclip-enhanced@abhiwizardbyte.dev

echo "✅ Extension reloaded! Press Super+V to test"
echo "📋 Watching logs (Ctrl+C to stop):"
echo ""

# Show real-time logs
journalctl -f -o cat /usr/bin/gnome-shell | grep -i "gclip\|js error"

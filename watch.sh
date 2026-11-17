#!/bin/bash

# Auto-reload extension when file changes are detected

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/gclip-enhanced@abhiwizardbyte.dev"
DEV_DIR="$(pwd)"

echo "👀 Watching for changes in $DEV_DIR"
echo "Press Ctrl+C to stop"
echo ""

# Sync and reload helper
reload_extension() {
    echo ""
    echo "🔄 $(date '+%H:%M:%S') - Changes detected, reloading..."
    
    # Copy files
    rsync -a --exclude='.git' \
        --exclude='node_modules' \
        --exclude='*.sh' \
        --exclude='README.md' \
        "$DEV_DIR/" "$EXT_DIR/"
    
    # Recompile schemas if modified
    if [[ "$1" == *"gschema.xml"* ]]; then
        glib-compile-schemas "$EXT_DIR/schemas/"
    fi
    
    # Reload extension
    gnome-extensions disable gclip-enhanced@abhiwizardbyte.dev 2>/dev/null
    sleep 0.3
    gnome-extensions enable gclip-enhanced@abhiwizardbyte.dev
    
    echo "✅ Reloaded! Test with Super+V"
}

# Install inotify-tools if missing
if ! command -v inotifywait &> /dev/null; then
    echo "⚠️  inotify-tools not found. Installing..."
    sudo apt install -y inotify-tools || sudo dnf install -y inotify-tools
fi

# Watch for changes in .js, .css, .xml
inotifywait -m -r -e modify,create,delete \
    --exclude '.*\.(swp|swx|git|md|sh)$' \
    "$DEV_DIR" | while read path action file; do
    
    # Filter relevant files
    if [[ "$file" =~ \.(js|css|xml|json)$ ]]; then
        reload_extension "$file"
    fi
done

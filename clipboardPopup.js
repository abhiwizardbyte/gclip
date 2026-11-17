import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const MAX_PREVIEW_LENGTH = 200;
const THUMBNAIL_SIZE = 32;
const POPUP_WIDTH = 400;
const POPUP_HEIGHT = 390;

export const ClipboardPopup = GObject.registerClass(
class ClipboardPopup extends St.Widget {
    _init(history, clipboardManager, settings, openPreferences, onDestroy) {
        super._init({
            reactive: true,
            can_focus: true,
            track_hover: true
        });

        this._history = history;
        this._clipboardManager = clipboardManager;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._onDestroyCallback = onDestroy;
        this._targetWindow = global.display.focus_window;
        this._selectedIndex = 0;
        this._keyboardMode = false;
        this._activeTab = 'recent';

        this._buildUI();

        // Keep toggle switch synchronized if private mode changes externally
        this._settings.connectObject('changed::private-mode',
            () => this._updatePrivateSwitch(), this);
        // Populate list (or show placeholder if private mode is active)
        this._updatePrivateSwitch();
        
        // Add to layout manager
        Main.layoutManager.addTopChrome(this);
        this._positionPopup();
        
        // Capture global stage events
        this._capturedEventId = global.stage.connect('captured-event', 
            this._onCapturedEvent.bind(this));

        this.connect('destroy', () => {
            if (this._capturedEventId) {
                global.stage.disconnect(this._capturedEventId);
                this._capturedEventId = null;
            }
            if (this._onDestroyCallback) {
                this._onDestroyCallback();
                this._onDestroyCallback = null;
            }
        });
    }

    _positionPopup() {
        // Get current cursor position
        let [x, y] = global.get_pointer();
        let monitor = Main.layoutManager.currentMonitor;
        
        // Clamp coordinates to keep popup within monitor bounds
        x = Math.min(x, monitor.x + monitor.width - POPUP_WIDTH - 20);
        y = Math.min(y, monitor.y + monitor.height - POPUP_HEIGHT - 20);
        x = Math.max(x, monitor.x + 20);
        y = Math.max(y, monitor.y + 20);
        
        this.set_position(x, y);
        this.set_size(POPUP_WIDTH, POPUP_HEIGHT);
    }

    _buildUI() {
        // Main container: reuses shell popup menu background, border, and shadows
        let mainBox = new St.BoxLayout({
            vertical: true,
            style_class: 'popup-menu-content gclip-popup',
            width: POPUP_WIDTH,
            height: POPUP_HEIGHT
        });
        // 'system' uses the shell theme colors; other choices use custom palettes
        // getStyleVariant() does not exist in older versions where the shell is always dark
        const theme = this._settings.get_string('popup-theme');
        const light = theme === 'light' ||
            (theme === 'system' && Main.getStyleVariant?.() === 'light');

        if (theme !== 'system')
            mainBox.add_style_class_name(light ? 'gclip-theme-light' : 'gclip-theme-dark');
        if (theme === 'darker')
            mainBox.add_style_class_name('gclip-theme-darker');
        // Secondary text and keycaps for light backgrounds
        if (light)
            mainBox.add_style_class_name('gclip-light');

        // Search entry
        this._searchEntry = new St.Entry({
            style_class: 'gclip-search-entry',
            hint_text: 'Search clipboard…',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({
                icon_name: 'edit-find-symbolic',
                style_class: 'gclip-entry-icon'
            })
        });
        this._clearIcon = new St.Icon({
            icon_name: 'edit-clear-symbolic',
            style_class: 'gclip-entry-icon'
        });

        this._searchEntry.clutter_text.connect('text-changed', () => {
            this._searchEntry.secondary_icon =
                this._searchEntry.get_text() ? this._clearIcon : null;
            this._filterList();
        });
        this._searchEntry.connect('secondary-icon-clicked', () => {
            this._searchEntry.set_text('');
        });

        let searchRow = new St.BoxLayout({
            style_class: 'gclip-search-row',
            vertical: false,
            x_expand: true
        });
        searchRow.add_child(this._searchEntry);
        mainBox.add_child(searchRow);

        // View selector tabs (Recent / Bookmarks)
        let tabBar = new St.BoxLayout({
            style_class: 'gclip-tab-bar',
            vertical: false,
            x_expand: true
        });

        this._tabRecent = new St.Button({
            label: 'Recent',
            style_class: 'button flat gclip-tab',
            x_expand: true,
            checked: true
        });
        this._tabBookmarks = new St.Button({
            label: 'Bookmarks',
            style_class: 'button flat gclip-tab',
            x_expand: true
        });

        this._tabRecent.connect('clicked', () => {
            if (this._activeTab !== 'recent') this._switchTab();
        });
        this._tabBookmarks.connect('clicked', () => {
            if (this._activeTab !== 'bookmarks') this._switchTab();
        });

        tabBar.add_child(this._tabRecent);
        tabBar.add_child(this._tabBookmarks);
        mainBox.add_child(tabBar);

        // ScrollView for items list
        this._scrollView = new St.ScrollView({
            style_class: 'gclip-scroll-view',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            y_expand: true
        });

        this._listBox = new St.BoxLayout({
            vertical: true,
            style_class: 'gclip-list-box'
        });

        this._scrollView.add_child(this._listBox);
        mainBox.add_child(this._scrollView);

        // Footer: shortcut hints, private mode toggle, and settings button
        let footer = new St.BoxLayout({
            style_class: 'gclip-footer',
            vertical: false,
            x_expand: true
        });

        let hints = new St.BoxLayout({
            style_class: 'gclip-hints',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._addShortcutHint(hints, 'Ctrl+B', 'Bookmark');
        this._addShortcutHint(hints, 'Del', 'Delete');
        footer.add_child(hints);

        // Private mode switch; clicks are handled by the wrapping button
        this._privateSwitch = new PopupMenu.Switch(false);
        this._privateSwitch.reactive = false;

        let privateBox = new St.BoxLayout({
            style_class: 'gclip-private-box',
            vertical: false
        });
        privateBox.add_child(new St.Icon({
            icon_name: 'view-conceal-symbolic',
            style_class: 'gclip-footer-icon gclip-dim',
            y_align: Clutter.ActorAlign.CENTER
        }));
        privateBox.add_child(this._privateSwitch);

        let privateButton = new St.Button({
            style_class: 'gclip-private-button',
            child: privateBox,
            accessible_name: 'Private Mode',
            y_align: Clutter.ActorAlign.CENTER
        });
        privateButton.connect('clicked', () => this._togglePrivateMode());
        footer.add_child(privateButton);

        let settingsButton = new St.Button({
            style_class: 'icon-button flat gclip-settings-button',
            child: new St.Icon({
                icon_name: 'preferences-system-symbolic',
                style_class: 'gclip-footer-icon'
            }),
            accessible_name: 'Settings',
            y_align: Clutter.ActorAlign.CENTER
        });
        settingsButton.connect('clicked', () => {
            this.close();
            this._openPreferences();
        });
        footer.add_child(settingsButton);

        mainBox.add_child(footer);

        this.add_child(mainBox);
    }

    _addShortcutHint(box, key, description) {
        let hint = new St.BoxLayout({
            style_class: 'gclip-hint',
            vertical: false
        });
        hint.add_child(new St.Label({
            text: key,
            style_class: 'gclip-keycap',
            y_align: Clutter.ActorAlign.CENTER
        }));
        hint.add_child(new St.Label({
            text: description,
            style_class: 'gclip-dim',
            y_align: Clutter.ActorAlign.CENTER
        }));
        box.add_child(hint);
    }

    _togglePrivateMode() {
        this._settings.set_boolean('private-mode',
            !this._settings.get_boolean('private-mode'));
    }

    _updatePrivateSwitch() {
        const active = this._settings.get_boolean('private-mode');

        // setToggleState() in older versions; state property in recent versions
        if (this._privateSwitch.setToggleState)
            this._privateSwitch.setToggleState(active);
        else
            this._privateSwitch.state = active;

        // Items are hidden while private mode is active
        this._selectedIndex = 0;
        this._filterList();
    }

    _showPlaceholder(iconName, title, description) {
        this._listBox.destroy_all_children();
        this._items = [];

        let placeholder = new St.BoxLayout({
            style_class: 'gclip-placeholder',
            vertical: true,
            x_expand: true
        });
        placeholder.add_child(new St.Icon({
            icon_name: iconName,
            style_class: 'gclip-placeholder-icon gclip-dim',
            x_align: Clutter.ActorAlign.CENTER
        }));
        placeholder.add_child(new St.Label({
            text: title,
            style_class: 'gclip-placeholder-title',
            x_align: Clutter.ActorAlign.CENTER
        }));

        let descriptionLabel = new St.Label({
            text: description,
            style_class: 'gclip-placeholder-description gclip-dim',
            x_align: Clutter.ActorAlign.CENTER
        });
        descriptionLabel.clutter_text.line_wrap = true;
        placeholder.add_child(descriptionLabel);

        this._listBox.add_child(placeholder);
    }

    _onCapturedEvent(actor, event) {
        if (event.type() === Clutter.EventType.KEY_PRESS) {
            return this._onKeyPress(event);
        }
        
        if (event.type() === Clutter.EventType.MOTION) {
            // Disable keyboard mode on mouse motion
            this._keyboardMode = false;
        }
        
        if (event.type() === Clutter.EventType.BUTTON_PRESS) {
            // Close popup when clicking outside bounds
            let [x, y] = event.get_coords();
            let [popupX, popupY] = this.get_position();
            let [popupW, popupH] = this.get_size();
            
            if (x < popupX || x > popupX + popupW || 
                y < popupY || y > popupY + popupH) {
                this.close();
                return Clutter.EVENT_STOP;
            }
        }
        
        return Clutter.EVENT_PROPAGATE;
    }

    _getDisplayItems() {
        return this._history
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => this._activeTab === 'recent' ? !item.favorite : !!item.favorite);
    }

    _populateList() {
        if (this._settings.get_boolean('private-mode')) {
            this._showPlaceholder('view-conceal-symbolic',
                'Private Mode Is On',
                'History is hidden and nothing you copy is saved');
            return;
        }

        const displayItems = this._getDisplayItems();

        if (displayItems.length === 0) {
            if (this._activeTab === 'recent') {
                this._showPlaceholder('edit-paste-symbolic',
                    'No Clipboard History',
                    'Items you copy will appear here');
            } else {
                this._showPlaceholder('user-bookmarks-symbolic',
                    'No Bookmarks',
                    'Press Ctrl+B on an item to keep it here');
            }
            return;
        }

        this._listBox.destroy_all_children();
        this._items = [];

        displayItems.forEach(({ item, index }, displayPos) => {
            let itemWidget = this._createItemWidget(item, index, displayPos);
            this._listBox.add_child(itemWidget);
            this._items.push(itemWidget);
        });

        this._updateSelection();
    }

    _createItemWidget(item, index, displayIndex = index) {
        // track_hover disabled: highlighting is controlled by selection, not hover
        let itemBox = new St.BoxLayout({
            style_class: 'popup-menu-item gclip-item',
            vertical: false,
            reactive: true,
            x_expand: true
        });

        // Item index label
        let indexLabel = new St.Label({
            text: `${displayIndex + 1}`,
            style_class: 'gclip-item-index gclip-dim',
            y_align: Clutter.ActorAlign.CENTER
        });
        itemBox.add_child(indexLabel);

        if (item.mimetype === 'text/plain;charset=utf-8') {
            // Single-line preview; label truncates with ellipsis if too long
            let preview = item.contents
                .substring(0, MAX_PREVIEW_LENGTH)
                .replace(/\s+/g, ' ')
                .trim();

            let label = new St.Label({
                text: preview,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER
            });
            itemBox.add_child(label);

        } else if (item.mimetype && item.mimetype.startsWith('image/')) {
            // Image thumbnail preview
            let thumbnail = this._createImageThumbnail(item.contents);
            if (thumbnail) {
                itemBox.add_child(thumbnail);
            } else {
                // Fallback: generic image icon if loading fails
                let icon = new St.Icon({
                    icon_name: 'image-x-generic-symbolic',
                    style_class: 'gclip-dim',
                    icon_size: THUMBNAIL_SIZE
                });
                itemBox.add_child(icon);
            }

            // Image info label
            let label = new St.Label({
                text: 'Image',
                style_class: 'gclip-dim',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER
            });
            itemBox.add_child(label);
        }

        // Item action buttons; only shown when hovering the row
        let actions = new St.BoxLayout({
            style_class: 'gclip-item-actions',
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0
        });
        const bookmarked = this._activeTab === 'bookmarks';
        actions.add_child(this._createItemAction(itemBox,
            bookmarked ? 'user-bookmarks-symbolic' : 'bookmark-new-symbolic',
            bookmarked ? 'Remove Bookmark' : 'Bookmark',
            () => this._toggleBookmark(itemBox._historyIndex)));
        actions.add_child(this._createItemAction(itemBox,
            'user-trash-symbolic',
            'Delete',
            () => this._deleteItem(itemBox._historyIndex)));
        itemBox.add_child(actions);
        itemBox._actions = actions;

        // Store original history index on the widget
        itemBox._historyIndex = index;

        // Event handlers
        itemBox.connect('button-press-event', () => {
            this._selectedIndex = this._items.indexOf(itemBox);
            this._selectItem(itemBox._historyIndex);
            return Clutter.EVENT_STOP;
        });

        itemBox.connect('enter-event', () => {
            // Disable keyboard mode on mouse motion
            this._keyboardMode = false;
            this._selectedIndex = this._items.indexOf(itemBox);
            this._updateSelection();
            actions.opacity = 255;
        });

        itemBox.connect('leave-event', (actor, event) => {
            // Moving to child actor (action buttons) does not count as leaving row
            const related = event.get_related();
            if (!related || !itemBox.contains(related))
                actions.opacity = 0;
        });
        
        itemBox.connect('motion-event', () => {
            // Also disable keyboard mode on mouse motion
            this._keyboardMode = false;
            return Clutter.EVENT_PROPAGATE;
        });

        return itemBox;
    }

    _createItemAction(itemBox, iconName, accessibleName, callback) {
        let action = new St.Bin({
            style_class: 'gclip-item-action',
            reactive: true,
            track_hover: true,
            accessible_name: accessibleName,
            child: new St.Icon({
                icon_name: iconName,
                style_class: 'gclip-item-action-icon'
            })
        });

        action.connect('button-press-event', () => {
            // Hidden: click counts as clicking the parent row
            if (itemBox._actions.opacity === 0)
                return Clutter.EVENT_PROPAGATE;

            callback();
            return Clutter.EVENT_STOP;
        });

        return action;
    }

    _createImageThumbnail(imagePath) {
        try {
            let file = Gio.File.new_for_path(imagePath);
            if (!file.query_exists(null)) {
                return null;
            }

            // St.Icon loads and scales the image (Clutter.Image is removed in recent versions)
            return new St.Icon({
                gicon: Gio.FileIcon.new(file),
                icon_size: THUMBNAIL_SIZE,
                style_class: 'gclip-item-thumbnail'
            });
        } catch (e) {
           console.debug(`Error creating thumbnail: ${e}`);
            return null;
        }
    }

    _filterList() {
        const searchText = this._searchEntry.get_text().toLowerCase();

        if (!searchText || this._settings.get_boolean('private-mode')) {
            this._populateList();
            return;
        }

        const filtered = this._getDisplayItems().filter(({ item }) => {
            if (item.mimetype === 'text/plain;charset=utf-8') {
                return item.contents.toLowerCase().includes(searchText);
            }
            return false;
        });

        if (filtered.length === 0) {
            this._showPlaceholder('edit-find-symbolic',
                'No Results Found',
                'Try a different search');
            return;
        }

        this._listBox.destroy_all_children();
        this._items = [];

        filtered.forEach(({ item, index }, displayPos) => {
            let itemWidget = this._createItemWidget(item, index, displayPos);
            this._listBox.add_child(itemWidget);
            this._items.push(itemWidget);
        });

        this._selectedIndex = 0;
        this._updateSelection();
    }

    _switchTab() {
        this._activeTab = this._activeTab === 'recent' ? 'bookmarks' : 'recent';
        this._selectedIndex = 0;
        this._searchEntry.set_text('');
        this._updateTabBar();
        this._populateList();
    }

    _updateTabBar() {
        this._tabRecent.checked = this._activeTab === 'recent';
        this._tabBookmarks.checked = this._activeTab === 'bookmarks';
    }

    _updateSelection() {
        this._items.forEach((item, index) => {
            if (index === this._selectedIndex) {
                item.add_style_pseudo_class('selected');

                // Automatically scroll to keep the selected item visible
                this._scrollToItem(item);
            } else {
                item.remove_style_pseudo_class('selected');
            }
        });
    }
    
    _scrollToItem(item) {
        if (!this._scrollView || !this._keyboardMode) return;
        
        // get_vscroll_bar() is deprecated in recent versions; kept as fallback for older releases
        const adjustment = this._scrollView.vadjustment ??
            this._scrollView.get_vscroll_bar().get_adjustment();
        const pageSize = adjustment.page_size;
        const value = adjustment.value;

        const box = item.get_allocation_box();
        const itemY = box.y1;
        const itemHeight = box.y2 - itemY;

        const margin = 10; // Margin for optimal visibility

        if (itemY < value + margin) {
            // Item is above viewport, scroll up
            adjustment.value = Math.max(0, itemY - margin);
        } else if (itemY + itemHeight > value + pageSize - margin) {
            // Item is below viewport, scroll down
            adjustment.value = Math.min(
                adjustment.upper - pageSize,
                itemY + itemHeight - pageSize + margin
            );
        }
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;

        if (symbol === Clutter.KEY_Up) {
            this._keyboardMode = true;
            this._selectedIndex = Math.max(0, this._selectedIndex - 1);
            this._updateSelection();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Down) {
            this._keyboardMode = true;
            this._selectedIndex = Math.min(this._items.length - 1, this._selectedIndex + 1);
            this._updateSelection();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_Right) {
            this._keyboardMode = true;
            this._switchTab();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            const item = this._items[this._selectedIndex];
            if (item) this._selectItem(item._historyIndex);
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Delete || symbol === Clutter.KEY_KP_Delete) {
            const item = this._items[this._selectedIndex];
            if (item) this._deleteItem(item._historyIndex);
            return Clutter.EVENT_STOP;
        }

        if (ctrl && (symbol === Clutter.KEY_b || symbol === Clutter.KEY_B)) {
            const item = this._items[this._selectedIndex];
            if (item) this._toggleBookmark(item._historyIndex);
            return Clutter.EVENT_STOP;
        }

        if (ctrl && (symbol === Clutter.KEY_p || symbol === Clutter.KEY_P)) {
            this._togglePrivateMode();
            return Clutter.EVENT_STOP;
        }

        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _selectItem(index) {
        if (index >= 0 && index < this._history.length) {
            const item = this._history[index];
            this._clipboardManager.copyToClipboard(item);
            const targetWindow = this._targetWindow;
            this.close();
            this._pasteToActiveWindow(targetWindow);
        }
    }

    _pasteToActiveWindow(targetWindow) {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            try {
                if (targetWindow) {
                    try {
                        targetWindow.focus(global.display.get_current_time());
                        targetWindow.activate(global.display.get_current_time());
                    } catch (winErr) {
                        // ignore window focus quirks
                    }
                }

                const backend = global.stage.context?.get_backend?.() ?? Clutter.get_default_backend();
                const seat = backend?.get_default_seat();
                if (!seat) return GLib.SOURCE_REMOVE;

                const device = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
                if (!device) return GLib.SOURCE_REMOVE;

                const pressed = Clutter.KeyState?.PRESSED ?? 0;
                const released = Clutter.KeyState?.RELEASED ?? 1;

                let eventTime = Clutter.get_current_event_time();
                if (!eventTime || eventTime === 0) {
                    eventTime = GLib.get_monotonic_time();
                }

                device.notify_keyval(eventTime, Clutter.KEY_Control_L, pressed);
                device.notify_keyval(eventTime, Clutter.KEY_v, pressed);
                device.notify_keyval(eventTime, Clutter.KEY_v, released);
                device.notify_keyval(eventTime, Clutter.KEY_Control_L, released);
            } catch (e) {
                console.error('GClip: Auto-paste failed:', e);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _toggleBookmark(index) {
        if (this._activeTab === 'recent') {
            this._clipboardManager.addBookmark(index);
        } else {
            this._clipboardManager.removeBookmark(index);
        }
        this._selectedIndex = 0;
        this._populateList();
    }

    _deleteItem(index) {
        if (index < 0 || index >= this._history.length) return;

        if (this._activeTab === 'bookmarks') {
            this._clipboardManager.removeBookmark(index);
        } else {
            this._clipboardManager.deleteItem(index);
        }

        this._selectedIndex = Math.max(0, this._selectedIndex - 1);
        this._populateList();
    }

    open() {
        this.show();
        this.opacity = 0;
        this.set_pivot_point(0.5, 0.5);
        this.set_scale(0.96, 0.96);
        this.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
        global.stage.set_key_focus(this._searchEntry);
    }
    
    close() {
        if (this._closing) return;
        this._closing = true;
        
        global.stage.set_key_focus(null);

        if (this._capturedEventId) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = null;
        }
        
        this.ease({
            opacity: 0,
            scale_x: 0.96,
            scale_y: 0.96,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                Main.layoutManager.removeChrome(this);
                this.destroy();
            }
        });
    }
});

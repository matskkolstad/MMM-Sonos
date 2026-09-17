'use strict';

Module.register('MMM-Sonos', {
  defaults: {
    updateInterval: 15 * 1000,
    discoveryTimeout: 5 * 1000,
    hiddenSpeakers: [],
    hiddenGroups: [],
    knownDevices: [],
    maxGroups: 6,
    displayMode: 'row', // auto | grid | row
    columns: 2,
    fontScale: 1,
    textSize: null,
    albumArtSize: 80,
    wrapText: true,
    textAlignment: 'center',
    justifyContent: 'center',
    moduleWidth: null,
    forceHttps: false,
    hideWhenNothingPlaying: true,
    showWhenPaused: false,
    enableControls: false,
    controlShowIdleZones: true,
    favoritesRefreshInterval: 300000,
    maxFavorites: 12,
    controlVolumeStep: 5,
    fadePausedGroups: true,
    showGroupMembers: true,
    showPlaybackState: false,
    showLastUpdated: false,
    timeFormat24: true,
  dateLocale: 'en-US',
    maxTextLines: 2,
    accentuateActive: true,
    showAlbum: false,
    cardMinWidth: 150,
    cardMaxWidth: null,
    showTvSource: true,
    showTvIcon: true,
    tvIcon: '📺',
    tvIconMode: 'emoji', // 'emoji' | 'text' | 'svg'
    tvIconText: 'TV',
    tvIconSvgPath: null,
    tvLabel: null,
    showPlaybackSource: true,
    showProgress: true,
    showVolume: true,
    cacheAlbumArt: true,
    albumArtCacheTTL: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds (0 = cache forever)
    clearCacheOnStart: false,
    debug: false,
    // Accent colours extracted from album art (requires cacheAlbumArt: true)
    albumArtColors: false,
    albumArtColorsOpacity: 0.45,
    albumArtColorsMode: 'gradient', // 'gradient' | 'solid'
    // Track-change transition animations
    transitionAnimation: 'fade', // 'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right' | 'scale' | 'zoom-in' | 'zoom-out' | 'flip' | 'pixelate' | 'none'
    transitionDuration: 400,
    // Mini-mode display options
    miniAlbumArtSize: 40,
    miniShowGroupName: true,
    miniShowArtist: true,
    miniShowSource: false,
    miniWidth: null,          // max-width of the mini-mode wrapper, e.g. 400 or '400px'
    // Fullscreen-mode display options
    fullscreenSpeaker: null,       // name/ID of speaker to show; null = first playing speaker
    fullscreenAlbumArtSize: 300,   // album art size in pixels for fullscreen mode
    fullscreenWidth: null,         // max-width of the fullscreen wrapper, e.g. 600 or '600px'
    // Whitelist: if non-empty only matching speakers/groups are shown (per-instance)
    allowedSpeakers: [],      // e.g. ['Stue', 'Kjøkken'] — speaker/room names
    allowedGroups: []         // e.g. group names or coordinator IPs
  },

  start() {
    this.groups = [];
    this.error = null;
    this.lastUpdated = null;
    this.updateTimer = null;
    this.progressAnimationTimer = null;
    this._animTransitionTimer = null;
    this._fullUpdateDebounceTimer = null;
    this.favorites = [];
    this._activeControlZoneId = null;
    // Sonos re-assigns the zone group `id` on every topology change, so a group/ungroup
    // action we trigger ourselves makes the open overlay's own zone id go stale as soon as
    // the next refresh lands. We remember one member's name from when the overlay opened
    // and use it to re-locate the (now differently-id'd) zone that still contains it.
    this._activeControlAnchorName = null;
    this._controlOverlayEl = null;
    this._controlVolumeDebounceTimer = null;
    this._controlMemberVolumeDebounceTimers = new Map();
    this._moreSpeakersOverlayEl = null;
    this._speakersOverlayEl = null;
    this._speakersOverlayBusy = false;
    this._renderedFavoritesRef = null;
    this._renderedActiveTitle = null;
    this._renderedMemberNamesKey = null;

  this._log('Starting MMM-Sonos module');
    this.sendSocketNotification('SONOS_CONFIG', this.config);
    this.scheduleRefresh();
    this._startProgressAnimation();
  },

  // Called by MagicMirror when a page-manager (or module.hide()) hides this module.
  // Without this, a full-viewport control overlay left open would stay stuck on
  // screen with no way to dismiss it once the module itself is no longer visible.
  suspend() {
    this._closeControlOverlay();
    this._closeMoreSpeakersOverlay();
  },

  stop() {
    this._closeControlOverlay();
    this._closeMoreSpeakersOverlay();
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    if (this.progressAnimationTimer) {
      clearInterval(this.progressAnimationTimer);
      this.progressAnimationTimer = null;
    }
    if (this._animTransitionTimer) {
      clearTimeout(this._animTransitionTimer);
      this._animTransitionTimer = null;
    }
    if (this._fullUpdateDebounceTimer) {
      clearTimeout(this._fullUpdateDebounceTimer);
      this._fullUpdateDebounceTimer = null;
    }
  },

  scheduleRefresh() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }

    this.updateTimer = setInterval(() => {
  this._log('Requesting update from node_helper');
      this.sendSocketNotification('SONOS_REQUEST');
    }, Math.max(this.config.updateInterval, 5000));
  },

  socketNotificationReceived(notification, payload) {
  this._log('Received socket notification', notification);

    switch (notification) {
      case 'SONOS_DATA': {
        const newGroups = payload.groups || [];
        const newTimestamp = payload.timestamp || Date.now();

        // Analyse what changed BEFORE updating this.groups / this.lastUpdated
        const { needsFull, changedIds, volumeChangedIds } = this._analyzeChanges(newGroups, newTimestamp);

        this.groups = newGroups;
        this.lastUpdated = newTimestamp;
        this.error = null;

        if (this.config.enableControls && this._activeControlZoneId) {
          this._syncControlOverlay();
        }

        if (this.config.enableControls && this._moreSpeakersOverlayEl) {
          this._syncMoreSpeakersOverlay();
        }

        if (needsFull) {
          this._log('Structural change — full DOM update');
          this._animatedUpdateDom();
        } else if (changedIds.size > 0) {
          // Per-card animation for whichever group(s) actually changed track/art.
          // Works for all display modes (mini, row, grid) — only the affected card(s) animate.
          this._log('Per-group track change', [...changedIds]);
          this._animateGroupCards(changedIds, newGroups);
          // Update progress for cards that did NOT change track
          this._updateProgressDataFromServer(
            newGroups.filter((g) => !changedIds.has(g.id)),
            newTimestamp
          );
          // Silently update volume for groups with volume-only changes
          if (volumeChangedIds.size > 0) {
            this._updateVolumeInPlace(volumeChangedIds, newGroups);
          }
        } else {
          this._log('Only progress/volume changed, skipping animation');
          this._updateProgressDataFromServer(newGroups, newTimestamp);
          if (volumeChangedIds.size > 0) {
            this._updateVolumeInPlace(volumeChangedIds, newGroups);
          }
        }
        break;
      }

      case 'SONOS_ERROR':
        this.error = payload;
        this.groups = [];
        this.updateDom();
        break;

      case 'SONOS_DEBUG':
        this._log('[H]', payload);
        break;

      case 'SONOS_CACHE_CLEARED':
        this._log('Album art cache cleared', payload);
        break;

      case 'SONOS_CONTROL_RESULT':
        this._handleControlResult(payload);
        break;

      case 'SONOS_FAVORITES':
        this.favorites = payload?.favorites || [];
        if (this._activeControlZoneId) {
          this._renderControlOverlayFavorites();
        }
        break;
    }
  },

  getStyles() {
    return [
      this.file('css/MMM-Sonos.css')
    ];
  },

  // Only supplies an automatic header when the user hasn't set their own `header`
  // in config — an explicit header is always respected as-is. In touch control
  // mode, "Now Playing" style config headers become misleading once idle zones
  // are shown alongside playing ones, so we pick text that matches what's
  // actually on screen.
  getHeader() {
    if (this.data.header) {
      return this.data.header;
    }
    if (this.config.enableControls) {
      return this.config.controlShowIdleZones
        ? this.translate('SONOS_CONTROL')
        : this.translate('NOW_PLAYING');
    }
    return this.data.header;
  },

  getTranslations() {
    return {
      af: 'translations/af.json',
      ar: 'translations/ar.json',
      bg: 'translations/bg.json',
      bn: 'translations/bn.json',
      ca: 'translations/ca.json',
      cs: 'translations/cs.json',
      cy: 'translations/cy.json',
      da: 'translations/da.json',
      de: 'translations/de.json',
      el: 'translations/el.json',
      en: 'translations/en.json',
      es: 'translations/es.json',
      et: 'translations/et.json',
      fi: 'translations/fi.json',
      fr: 'translations/fr.json',
      fy: 'translations/fy.json',
      ga: 'translations/ga.json',
      gl: 'translations/gl.json',
      he: 'translations/he.json',
      hi: 'translations/hi.json',
      hr: 'translations/hr.json',
      hu: 'translations/hu.json',
      id: 'translations/id.json',
      is: 'translations/is.json',
      it: 'translations/it.json',
      ja: 'translations/ja.json',
      ko: 'translations/ko.json',
      lt: 'translations/lt.json',
      lv: 'translations/lv.json',
      ms: 'translations/ms.json',
      nb: 'translations/nb.json',
      nl: 'translations/nl.json',
      no: 'translations/nb.json',
      pl: 'translations/pl.json',
      pt: 'translations/pt.json',
      'pt-BR': 'translations/pt-BR.json',
      ro: 'translations/ro.json',
      ru: 'translations/ru.json',
      sk: 'translations/sk.json',
      sl: 'translations/sl.json',
      sv: 'translations/sv.json',
      th: 'translations/th.json',
      tr: 'translations/tr.json',
      uk: 'translations/uk.json',
      vi: 'translations/vi.json',
      'zh-CN': 'translations/zh-CN.json',
      'zh-TW': 'translations/zh-TW.json'
    };
  },

  getDom() {
    const wrapper = document.createElement('div');
    wrapper.classList.add('mmm-sonos');
    // Tag this wrapper with the module's unique identifier so in-place DOM updates
    // (per-card animation, progress, volume) can be scoped to this instance only.
    // This prevents one module instance from accidentally modifying another instance's cards,
    // which is the root cause of normal+mini dual-mode display corruption.
    wrapper.dataset.moduleId = this.identifier;
    const textSizeValue = this._coercePixelValue(this.config.textSize, null);
    if (textSizeValue) {
      wrapper.style.setProperty('--mmm-sonos-text-size', textSizeValue);
    } else {
      wrapper.style.setProperty('--mmm-sonos-font-scale', this.config.fontScale);
    }
    const albumSizeValue = this._coercePixelValue(this.config.albumArtSize, this.defaults.albumArtSize);
    if (albumSizeValue) {
      wrapper.style.setProperty('--mmm-sonos-album-size', albumSizeValue);
    }
    const gridColumns = this._getGridColumns();
    wrapper.style.setProperty('--mmm-sonos-columns', gridColumns);
    const cardMinValue = this._coercePixelValue(this.config.cardMinWidth, this.defaults.cardMinWidth);
    if (cardMinValue) {
      wrapper.style.setProperty('--mmm-sonos-card-min', cardMinValue);
    }
    const cardMaxValue = this._coercePixelValue(this.config.cardMaxWidth, null);
    if (cardMaxValue) {
      wrapper.style.setProperty('--mmm-sonos-card-max', cardMaxValue);
    }
    wrapper.style.justifyContent = this.config.justifyContent;
    wrapper.style.textAlign = this._mapTextAlign(this.config.textAlignment);

    if (!this.config.wrapText) {
      wrapper.classList.add('mmm-sonos--nowrap');
    }

    if (this.config.moduleWidth) {
      wrapper.style.maxWidth = this._normalizeSize(this.config.moduleWidth);
    }

    if (this.error) {
      wrapper.classList.add('mmm-sonos--error');
      wrapper.innerText = `${this.translate('ERROR')}: ${this.error.message || this.error}`;
      return wrapper;
    }

    if (!this.groups || this.groups.length === 0) {
      const emptyMessage = document.createElement('div');
      emptyMessage.classList.add('mmm-sonos__empty');
      emptyMessage.innerText = this.translate('NO_ACTIVE_SONOS');

      if (this.lastUpdated && this.config.showLastUpdated) {
        emptyMessage.appendChild(this._renderTimestamp());
      }

      if (this.config.hideWhenNothingPlaying) {
        wrapper.classList.add('mmm-sonos--hidden');
      }

      wrapper.appendChild(emptyMessage);
      return wrapper;
    }

  const displayMode = this._resolveDisplayMode();
  wrapper.classList.add(`mmm-sonos--mode-${displayMode}`);
  this._applyLayoutMode(wrapper, displayMode, cardMinValue, gridColumns);

    const isMiniMode = displayMode === 'mini';
    const isFullscreenMode = displayMode === 'fullscreen';

    let groupsToRender;
    if (isFullscreenMode) {
      const targetGroup = this._resolveFullscreenGroup();
      groupsToRender = targetGroup ? [this._renderFullscreenGroup(targetGroup)].filter(Boolean) : [];
    } else {
      groupsToRender = this.groups
        .slice(0, this.config.maxGroups)
        .map((group) => isMiniMode ? this._renderMiniGroup(group) : this._renderGroup(group))
        .filter(Boolean);
    }

    if (!groupsToRender.length) {
      const emptyMessage = document.createElement('div');
      emptyMessage.classList.add('mmm-sonos__empty');
      emptyMessage.innerText = this.translate('NO_VISIBLE_SONOS');
      wrapper.appendChild(emptyMessage);
    } else {
      groupsToRender.forEach((element) => wrapper.appendChild(element));
    }

    if (this.lastUpdated && this.config.showLastUpdated) {
      wrapper.appendChild(this._renderTimestamp());
    }

    if (!isMiniMode && !isFullscreenMode) {
      const hiddenIdleZones = this._getHiddenIdleZones();
      if (hiddenIdleZones.length > 0) {
        wrapper.appendChild(this._renderMoreSpeakersButton(hiddenIdleZones.length));
      }
    }

    return wrapper;
  },

  _getHiddenIdleZones() {
    if (!this.config.enableControls || this.config.controlShowIdleZones || this.config.showWhenPaused) {
      return [];
    }
    return (this.groups || [])
      .slice(0, this.config.maxGroups)
      .filter((group) => {
        if (this._isHidden(group)) {
          return false;
        }
        const playbackState = (group.playbackState || '').toLowerCase();
        const isPlaying = ['playing', 'transitioning', 'buffering'].includes(playbackState);
        return !isPlaying;
      });
  },

  _renderMoreSpeakersButton(count) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mmm-sonos__more-speakers-btn';
    button.innerText = '+';
    button.setAttribute('aria-label', this.translate('MORE_SPEAKERS'));
    button.title = this.translate('MORE_SPEAKERS');
    if (count > 1) {
      const badge = document.createElement('span');
      badge.className = 'mmm-sonos__more-speakers-badge';
      badge.innerText = String(count);
      button.appendChild(badge);
    }
    button.addEventListener('click', () => this._openMoreSpeakersOverlay());
    return button;
  },

  _openMoreSpeakersOverlay() {
    this._buildMoreSpeakersOverlay();
  },

  _closeMoreSpeakersOverlay() {
    if (this._moreSpeakersOverlayEl) {
      this._moreSpeakersOverlayEl.remove();
      this._moreSpeakersOverlayEl = null;
    }
  },

  // Shared shell for every full-screen overlay in this module: a backdrop (tap outside
  // to close) wrapping a sheet with a header (title + optional extra header buttons +
  // close button). Callers append their own body content to the returned `sheet`,
  // `document.body.append(backdrop)`, and track it in their own `_*OverlayEl` field —
  // this only builds the shared shell, not the overlay's specific content.
  _buildOverlayShell(titleText, onClose, extraHeaderButtons = []) {
    const backdrop = document.createElement('div');
    backdrop.className = 'mmm-sonos__overlay-backdrop';
    backdrop.dataset.moduleId = this.identifier;
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        onClose();
      }
    });

    const sheet = document.createElement('div');
    sheet.className = 'mmm-sonos__overlay-sheet';

    const header = document.createElement('div');
    header.className = 'mmm-sonos__overlay-header';
    const title = document.createElement('span');
    title.className = 'mmm-sonos__overlay-title';
    title.innerText = titleText;
    header.appendChild(title);
    extraHeaderButtons.forEach((button) => header.appendChild(button));
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'mmm-sonos__overlay-close';
    closeBtn.innerText = '×';
    closeBtn.setAttribute('aria-label', this.translate('CLOSE'));
    closeBtn.addEventListener('click', () => onClose());
    header.appendChild(closeBtn);
    sheet.appendChild(header);

    backdrop.appendChild(sheet);
    return { backdrop, sheet };
  },

  _buildMoreSpeakersOverlay() {
    this._closeMoreSpeakersOverlay();

    const { backdrop, sheet } = this._buildOverlayShell(
      this.translate('MORE_SPEAKERS'),
      () => this._closeMoreSpeakersOverlay()
    );

    const list = document.createElement('div');
    list.className = 'mmm-sonos__more-speakers-list';
    sheet.appendChild(list);

    document.body.appendChild(backdrop);
    this._moreSpeakersOverlayEl = backdrop;

    this._renderMoreSpeakersList();
  },

  _renderMoreSpeakersList() {
    if (!this._moreSpeakersOverlayEl) {
      return;
    }
    const list = this._moreSpeakersOverlayEl.querySelector('.mmm-sonos__more-speakers-list');
    if (!list) {
      return;
    }
    list.innerHTML = '';

    const zones = this._getHiddenIdleZones();
    zones.forEach((zone) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'mmm-sonos__more-speakers-item';
      item.innerText = zone.name || '';
      item.addEventListener('click', () => {
        this._closeMoreSpeakersOverlay();
        this._openControlOverlay(zone.id);
      });
      list.appendChild(item);
    });
  },

  _syncMoreSpeakersOverlay() {
    const zones = this._getHiddenIdleZones();
    if (zones.length === 0) {
      this._closeMoreSpeakersOverlay();
      return;
    }
    this._renderMoreSpeakersList();
  },

  // "Speakers" picker opened from the control overlay: lets the open zone absorb another
  // zone (group) or shed one of its own members (ungroup). Layers on top of the control
  // overlay the same way the more-speakers picker layers on top of the card grid.
  _openSpeakersOverlay() {
    this._buildSpeakersOverlay();
  },

  _closeSpeakersOverlay() {
    this._speakersOverlayBusy = false;
    if (this._speakersOverlayEl) {
      this._speakersOverlayEl.remove();
      this._speakersOverlayEl = null;
    }
  },

  _buildSpeakersOverlay() {
    this._closeSpeakersOverlay();

    const group = this._locateActiveGroup();
    if (!group) {
      return;
    }
    // No action in flight on a freshly-opened picker.
    this._speakersOverlayBusy = false;

    const { backdrop, sheet } = this._buildOverlayShell(
      this.translate('SPEAKERS'),
      () => this._closeSpeakersOverlay()
    );

    const currentSection = document.createElement('div');
    currentSection.className = 'mmm-sonos__speakers-current';
    sheet.appendChild(currentSection);

    const joinSection = document.createElement('div');
    joinSection.className = 'mmm-sonos__speakers-join';
    sheet.appendChild(joinSection);

    document.body.appendChild(backdrop);
    this._speakersOverlayEl = backdrop;

    this._renderSpeakersOverlayContent();
  },

  _renderSpeakersOverlayContent() {
    if (!this._speakersOverlayEl) {
      return;
    }
    const group = this._locateActiveGroup();
    if (!group) {
      this._closeSpeakersOverlay();
      return;
    }

    const currentSection = this._speakersOverlayEl.querySelector('.mmm-sonos__speakers-current');
    const joinSection = this._speakersOverlayEl.querySelector('.mmm-sonos__speakers-join');
    if (!currentSection || !joinSection) {
      return;
    }
    currentSection.innerHTML = '';
    joinSection.innerHTML = '';

    // While a join/leave is in flight, every row renders disabled — not just the one
    // tapped. A join calls joinGroup() on the OPEN zone's current coordinator; if that
    // zone was just made a satellite by a still-in-flight prior join, calling it again
    // before we know the real topology would peel that speaker back out into a new group
    // instead of extending it. Serializing taps sidesteps that race entirely. The list
    // re-enables itself as soon as the next SONOS_DATA tick confirms the real state (see
    // _syncSpeakersOverlay), whether the action succeeded or failed.
    const busy = this._speakersOverlayBusy;

    if ((group.members || []).length > 1) {
      const heading = document.createElement('div');
      heading.className = 'mmm-sonos__speakers-heading';
      heading.innerText = this.translate('CURRENT_GROUP');
      currentSection.appendChild(heading);

      group.members.forEach((memberName) => {
        const row = document.createElement('div');
        row.className = 'mmm-sonos__speakers-member-row';
        const label = document.createElement('span');
        label.innerText = memberName;
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'mmm-sonos__speakers-remove-btn';
        removeBtn.innerText = this.translate('REMOVE');
        removeBtn.disabled = busy;
        removeBtn.addEventListener('click', () => {
          this._speakersOverlayBusy = true;
          this.sendSocketNotification('SONOS_CONTROL_LEAVE_GROUP', { zoneId: group.id, memberName });
          this._renderSpeakersOverlayContent();
        });
        row.appendChild(label);
        row.appendChild(removeBtn);
        currentSection.appendChild(row);
      });
    }

    const otherZones = (this.groups || []).filter((g) => g.id !== group.id);
    const joinHeading = document.createElement('div');
    joinHeading.className = 'mmm-sonos__speakers-heading';
    joinHeading.innerText = this.translate('JOIN_SPEAKER');
    joinSection.appendChild(joinHeading);

    if (!otherZones.length) {
      const empty = document.createElement('div');
      empty.className = 'mmm-sonos__speakers-empty';
      empty.innerText = this.translate('NO_OTHER_SPEAKERS');
      joinSection.appendChild(empty);
      return;
    }

    otherZones.forEach((zone) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'mmm-sonos__speakers-join-item';
      item.innerText = zone.name || '';
      item.disabled = busy;
      item.addEventListener('click', () => {
        // Stay open (rather than close-on-tap) so several zones can be joined one after
        // another in one sitting — a joined zone naturally drops out of this list and its
        // members appear under "Current group" once the topology change lands.
        this._speakersOverlayBusy = true;
        this.sendSocketNotification('SONOS_CONTROL_JOIN_GROUP', { zoneId: group.id, targetZoneId: zone.id });
        this._renderSpeakersOverlayContent();
      });
      joinSection.appendChild(item);
    });
  },

  _syncSpeakersOverlay() {
    this._speakersOverlayBusy = false;
    this._renderSpeakersOverlayContent();
  },

  _renderGroup(group) {
    if (!group) {
      return null;
    }

    const isHidden = this._isHidden(group);
    if (isHidden) {
      return null;
    }

    const playbackState = (group.playbackState || '').toLowerCase();
    const isPlaying = ['playing', 'transitioning', 'buffering'].includes(playbackState);
    const controlAlwaysShows = this.config.enableControls && this.config.controlShowIdleZones;
    const isIdleControlCard = controlAlwaysShows && !isPlaying && !this.config.showWhenPaused;
    if (!isPlaying && !this.config.showWhenPaused && !controlAlwaysShows) {
      return null;
    }

    const isTvSource = this._isTvSource(group);

    // Determine alignment once for the entire group
    const alignment = this.config.textAlignment || 'center';

    const container = document.createElement('div');
    container.className = 'mmm-sonos__group';
    if (isIdleControlCard) {
      container.classList.add('mmm-sonos__group--idle');
    }
    container.dataset.groupId = group.id;
    container.style.display = 'flex';
    container.style.gap = '0.45rem';

    // Apply layout based on textAlignment
    // Note: The text-align values are intentionally opposite to the position
    // to make text "hug" the album art for a cleaner look
    if (alignment === 'center') {
      // Vertical layout: album art on top, text below
      container.style.flexDirection = 'column';
      container.style.alignItems = 'center';
      container.style.textAlign = 'center';
    } else if (alignment === 'left') {
      // Horizontal layout: text on left, album art on right
      // Text is right-aligned (towards the album) to hug it
      container.style.flexDirection = 'row-reverse';
      container.style.alignItems = 'center';
      container.style.textAlign = 'right';
    } else if (alignment === 'right') {
      // Horizontal layout: album art on left, text on right
      // Text is left-aligned (towards the album) to hug it
      container.style.flexDirection = 'row';
      container.style.alignItems = 'center';
      container.style.textAlign = 'left';
    }

    const cardMinValue = this._coercePixelValue(this.config.cardMinWidth, this.defaults.cardMinWidth);
    if (cardMinValue) {
      container.style.minWidth = cardMinValue;
    }

    // Apply cardMaxWidth constraint when configured (issue 3)
    const cardMaxValue = this._coercePixelValue(this.config.cardMaxWidth, null);
    if (cardMaxValue) {
      container.style.maxWidth = cardMaxValue;
    }

    if (this.config.accentuateActive && isPlaying) {
      container.classList.add('mmm-sonos__group--active');
    }

    if (this.config.fadePausedGroups && !isPlaying) {
      container.classList.add('mmm-sonos__group--paused');
    }

    // Apply accent colour derived from album-art analysis (albumArtColors: true)
    if (this.config.albumArtColors && group.accentColor) {
      const { r, g, b } = group.accentColor;
      container.style.setProperty('--mmm-sonos-card-accent-rgb', `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`);
      container.style.setProperty('--mmm-sonos-card-accent-opacity', String(this.config.albumArtColorsOpacity ?? 0.45));
      container.classList.add('mmm-sonos__group--accented');
      if ((this.config.albumArtColorsMode || 'gradient').toLowerCase() === 'solid') {
        container.classList.add('mmm-sonos__group--accented-solid');
      }
    }

    // Album art (or TV icon placeholder)
    const configuredSize = Number(this.config.albumArtSize);
    const sizeValue = !Number.isNaN(configuredSize) && configuredSize > 0 ? `${configuredSize}px` : null;
    const iconFontSize = !Number.isNaN(configuredSize) && configuredSize > 0 ? `${Math.round(configuredSize * 0.42)}px` : null;
    if (group.albumArt && !isIdleControlCard) {
      const artWrapper = document.createElement('div');
      artWrapper.className = 'mmm-sonos__art';
      if (sizeValue) {
        artWrapper.style.width = sizeValue;
        artWrapper.style.height = sizeValue;
      }

      const img = document.createElement('img');
      // Use eager loading: on a MagicMirror display every card is always visible,
      // so lazy loading only delays the image; eager gives instant display.
      img.loading = 'eager';
      img.src = group.albumArt;
      img.alt = `${group.title || ''}`.trim() || 'Album art';
      if (sizeValue) {
        img.style.width = sizeValue;
        img.style.height = sizeValue;
      }
      // If the image fails to load (e.g. radio station logo not available), hide the wrapper
      img.onerror = () => {
        artWrapper.style.display = 'none';
      };
      artWrapper.appendChild(img);
      container.appendChild(artWrapper);
    } else if (isTvSource) {
      const artWrapper = document.createElement('div');
      artWrapper.className = 'mmm-sonos__art mmm-sonos__art--tv';
      if (sizeValue) {
        artWrapper.style.width = sizeValue;
        artWrapper.style.height = sizeValue;
      }

      // Respect showTvIcon: keep the placeholder to preserve layout, but hide the icon if disabled
      if (this.config.showTvIcon !== false) {
        const mode = (this.config.tvIconMode || 'emoji').toLowerCase();

        if (mode === 'text') {
          const icon = document.createElement('span');
          icon.className = 'mmm-sonos__source-icon mmm-sonos__source-icon--text';
          icon.innerText = this.config.tvIconText || 'TV';
          icon.style.display = 'flex';
          icon.style.alignItems = 'center';
          icon.style.justifyContent = 'center';
          icon.style.width = sizeValue || '100%';
          icon.style.height = sizeValue || '100%';
          icon.style.fontWeight = '700';
          if (iconFontSize) {
            icon.style.fontSize = iconFontSize;
            icon.style.lineHeight = iconFontSize;
          }
          artWrapper.appendChild(icon);
        } else if (mode === 'svg') {
          const img = document.createElement('img');
          img.className = 'mmm-sonos__source-icon mmm-sonos__source-icon--svg';
          img.src = this._resolveTvSvgSource();
          img.alt = 'TV Icon';
          img.style.width = '100%';
          img.style.height = '100%';
          img.style.objectFit = 'contain';
          artWrapper.appendChild(img);
        } else {
          // emoji (default)
          const icon = document.createElement('span');
          icon.className = 'mmm-sonos__source-icon';
          icon.innerText = this.config.tvIcon || '📺';
          icon.style.display = 'flex';
          icon.style.alignItems = 'center';
          icon.style.justifyContent = 'center';
          icon.style.width = sizeValue || '100%';
          icon.style.height = sizeValue || '100%';
          if (iconFontSize) {
            icon.style.fontSize = iconFontSize;
            icon.style.lineHeight = iconFontSize;
          }
          artWrapper.appendChild(icon);
        }
      }

      container.appendChild(artWrapper);
    } else if (isIdleControlCard) {
      const idleWrapper = document.createElement('div');
      idleWrapper.className = 'mmm-sonos__art mmm-sonos__idle-icon';
      if (sizeValue) {
        idleWrapper.style.width = sizeValue;
        idleWrapper.style.height = sizeValue;
      }
      idleWrapper.innerText = '🔇';
      if (iconFontSize) {
        idleWrapper.style.fontSize = iconFontSize;
      }
      container.appendChild(idleWrapper);
    }

    const content = document.createElement('div');
    content.className = 'mmm-sonos__content';
    content.style.display = 'flex';
    content.style.flexDirection = 'column';
    content.style.gap = '0.3rem';
    content.style.width = '100%';

    // Align content based on textAlignment (matches container's text-align)
    if (alignment === 'center') {
      content.style.alignItems = 'center';
    } else if (alignment === 'left') {
      // Text on left: align items to flex-end (right) to hug album on the right
      content.style.alignItems = 'flex-end';
    } else if (alignment === 'right') {
      // Text on right: align items to flex-start (left) to hug album on the left
      content.style.alignItems = 'flex-start';
    }

    const header = document.createElement('div');
    header.className = 'mmm-sonos__header';
    header.style.display = 'flex';
    header.style.flexDirection = 'row';
    header.style.alignItems = 'center';
    header.style.gap = '0.35rem';

    // Align header based on textAlignment (matches container's text-align)
    if (alignment === 'center') {
      header.style.justifyContent = 'center';
    } else if (alignment === 'left') {
      // Text on left: align to flex-end (right) to hug album on the right
      header.style.justifyContent = 'flex-end';
    } else if (alignment === 'right') {
      // Text on right: align to flex-start (left) to hug album on the left
      header.style.justifyContent = 'flex-start';
    }

    const groupName = document.createElement('span');
    groupName.className = 'mmm-sonos__group-name';
    groupName.innerText = group.name;
    header.appendChild(groupName);

    if (this.config.showPlaybackState && group.playbackState) {
      const state = document.createElement('span');
      state.className = 'mmm-sonos__state';
      state.innerText = this.translate(group.playbackState.toUpperCase()) || group.playbackState;
      header.appendChild(state);
    }

    content.appendChild(header);

    const sourceElement = isTvSource ? this._renderSourceLabel(alignment) : null;
    if (sourceElement) {
      content.appendChild(sourceElement);
    }

    const hasTrackInfo = !isIdleControlCard && (group.title || group.artist);
    const titleIsDuplicateTv = isTvSource && (!group.artist) && typeof group.title === 'string' && group.title.trim().toLowerCase() === 'tv';

    if (hasTrackInfo && !titleIsDuplicateTv) {
      const titleWrapper = document.createElement('div');
      titleWrapper.className = 'mmm-sonos__track';
      titleWrapper.style.display = 'flex';
      titleWrapper.style.flexDirection = 'column';
      titleWrapper.style.gap = '0.08rem';

      // Align track info based on textAlignment (matches container's text-align)
      if (alignment === 'center') {
        titleWrapper.style.alignItems = 'center';
      } else if (alignment === 'left') {
        // Text on left: align items to flex-end (right) to hug album on the right
        titleWrapper.style.alignItems = 'flex-end';
      } else if (alignment === 'right') {
        // Text on right: align items to flex-start (left) to hug album on the left
        titleWrapper.style.alignItems = 'flex-start';
      }

      const title = document.createElement('div');
      title.className = 'mmm-sonos__title';
      title.innerText = group.title || this.translate('UNKNOWN_TRACK');
      if (this.config.maxTextLines > 0) {
        title.style.setProperty('--mmm-sonos-title-lines', this.config.maxTextLines);
      }
      titleWrapper.appendChild(title);

      if (group.artist) {
        const artist = document.createElement('div');
        artist.className = 'mmm-sonos__artist';
        artist.innerText = group.artist;
        titleWrapper.appendChild(artist);
      }

      if (this.config.showAlbum && group.album) {
        const album = document.createElement('div');
        album.className = 'mmm-sonos__album';
        album.innerText = group.album;
        titleWrapper.appendChild(album);
      }

      content.appendChild(titleWrapper);
    } else if (isIdleControlCard) {
      const idleLabel = document.createElement('div');
      idleLabel.className = 'mmm-sonos__idle-label';
      idleLabel.innerText = this.translate('IDLE_LABEL');
      content.appendChild(idleLabel);
    }

    // Playback source indicator
    if (this.config.showPlaybackSource && group.source && !isTvSource && !isIdleControlCard) {
      const sourceElement = this._renderPlaybackSource(group.source, alignment);
      if (sourceElement) {
        content.appendChild(sourceElement);
      }
    }

    // Progress indicator — show when duration is known and positive.
    // Treat a null position (e.g. track freshly started, RelTime not yet available) as 0.
    if (this.config.showProgress && group.duration != null && group.duration > 0) {
      const progressElement = this._renderProgress(group.position ?? 0, group.duration, alignment, isPlaying);
      if (progressElement) {
        content.appendChild(progressElement);
      }
    }

    // Volume display
    if (this.config.showVolume && group.volume != null) {
      const volumeElement = this._renderVolume(group.volume, alignment);
      if (volumeElement) {
        content.appendChild(volumeElement);
      }
    }

    if (this.config.showGroupMembers && group.members && group.members.length > 1) {
      const members = document.createElement('div');
      members.className = 'mmm-sonos__members';
      members.innerText = group.members.join(', ');
      content.appendChild(members);
    }

    if (this.config.enableControls) {
      container.classList.add('mmm-sonos__group--clickable');
      container.setAttribute('role', 'button');
      container.setAttribute('tabindex', '0');
      container.addEventListener('click', () => this._openControlOverlay(group.id));
      container.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this._openControlOverlay(group.id);
        }
      });
    }

    container.appendChild(content);
    return container;
  },

  _renderTimestamp() {
    const ts = document.createElement('div');
    ts.className = 'mmm-sonos__timestamp';
    const date = new Date(this.lastUpdated);
    const options = {
      hour: 'numeric',
      minute: '2-digit'
    };
    if (!this.config.timeFormat24) {
      options.hour12 = true;
    }
    ts.innerText = `${this.translate('UPDATED')} ${date.toLocaleTimeString(this.config.dateLocale, options)}`;
    return ts;
  },

  _limitFavorites(favorites, maxFavorites) {
    const list = favorites || [];
    if (!maxFavorites || maxFavorites <= 0) return list;
    return list.slice(0, maxFavorites);
  },

  _findGroupById(zoneId) {
    return (this.groups || []).find((g) => g.id === zoneId) || null;
  },

  // Resolves the zone currently shown in the control overlay, following it across a
  // group/ungroup action that changed its id — see `_activeControlAnchorName` above.
  //
  // Deliberate choice: the overlay follows the specific physical speaker whose card was
  // originally tapped (the anchor), not "the group" as an abstract entity. So if the
  // anchor speaker itself is the one removed from a group via the Speakers picker, the
  // overlay correctly follows it into its new standalone zone, rather than staying on
  // the larger group it just left. This only matters when the anchor happens to also be
  // the group's coordinator (id lookup below fails only when the coordinator changes).
  _locateActiveGroup() {
    let group = this._findGroupById(this._activeControlZoneId);
    if (!group && this._activeControlAnchorName) {
      const anchor = this._activeControlAnchorName.toLowerCase();
      group = (this.groups || []).find((g) => (g.members || []).some((m) => m.toLowerCase() === anchor)) || null;
      if (group) {
        this._activeControlZoneId = group.id;
      }
    }
    return group;
  },

  _openControlOverlay(zoneId) {
    if (!this.config.enableControls) {
      return;
    }
    this._activeControlZoneId = zoneId;
    const group = this._findGroupById(zoneId);
    this._activeControlAnchorName = group?.members?.[0] || null;
    this._buildControlOverlay();
  },

  _closeControlOverlay() {
    this._activeControlZoneId = null;
    this._activeControlAnchorName = null;
    // Cancel any pending debounced volume-set calls — clearing the Map alone drops our
    // reference to the timer IDs without canceling them, so an in-flight command would
    // still fire and reach the speaker after the overlay is gone.
    if (this._controlVolumeDebounceTimer) {
      clearTimeout(this._controlVolumeDebounceTimer);
      this._controlVolumeDebounceTimer = null;
    }
    this._controlMemberVolumeDebounceTimers.forEach((timer) => clearTimeout(timer));
    this._controlMemberVolumeDebounceTimers.clear();
    this._closeSpeakersOverlay();
    if (this._controlOverlayEl) {
      this._controlOverlayEl.remove();
      this._controlOverlayEl = null;
    }
  },

  _debounceSetVolume(zoneId, volume) {
    if (this._controlVolumeDebounceTimer) {
      clearTimeout(this._controlVolumeDebounceTimer);
    }
    this._controlVolumeDebounceTimer = setTimeout(() => {
      this._controlVolumeDebounceTimer = null;
      this.sendSocketNotification('SONOS_CONTROL_SET_VOLUME', { zoneId, volume });
    }, 150);
  },

  _debounceSetMemberVolume(zoneId, memberName, volume) {
    if (this._controlMemberVolumeDebounceTimers.has(memberName)) {
      clearTimeout(this._controlMemberVolumeDebounceTimers.get(memberName));
    }
    const timer = setTimeout(() => {
      this._controlMemberVolumeDebounceTimers.delete(memberName);
      this.sendSocketNotification('SONOS_CONTROL_SET_MEMBER_VOLUME', { zoneId, memberName, volume });
    }, 150);
    this._controlMemberVolumeDebounceTimers.set(memberName, timer);
  },

  _buildControlOverlay() {
    if (this._controlOverlayEl) {
      this._controlOverlayEl.remove();
      this._controlOverlayEl = null;
    }

    const group = this._locateActiveGroup();
    if (!group) {
      this._activeControlZoneId = null;
      this._activeControlAnchorName = null;
      return;
    }

    const speakersBtn = document.createElement('button');
    speakersBtn.type = 'button';
    speakersBtn.className = 'mmm-sonos__overlay-speakers-btn';
    speakersBtn.innerText = this.translate('SPEAKERS');
    speakersBtn.setAttribute('aria-label', this.translate('SPEAKERS'));
    speakersBtn.addEventListener('click', () => this._openSpeakersOverlay());

    const { backdrop, sheet } = this._buildOverlayShell(
      group.name || '',
      () => this._closeControlOverlay(),
      [speakersBtn]
    );

    const errorEl = document.createElement('div');
    errorEl.className = 'mmm-sonos__overlay-error';
    errorEl.hidden = true;
    sheet.appendChild(errorEl);

    const isPlaying = ['playing', 'transitioning', 'buffering'].includes((group.playbackState || '').toLowerCase());
    const playPauseBtn = document.createElement('button');
    playPauseBtn.type = 'button';
    playPauseBtn.className = 'mmm-sonos__overlay-playpause';
    playPauseBtn.innerText = isPlaying ? '⏸' : '▶';
    playPauseBtn.dataset.isPlaying = String(isPlaying);
    playPauseBtn.addEventListener('click', () => {
      const wasPlaying = playPauseBtn.dataset.isPlaying === 'true';
      const notification = wasPlaying ? 'SONOS_CONTROL_PAUSE' : 'SONOS_CONTROL_PLAY';
      // Optimistically flip the icon immediately — same pattern as the volume slider's
      // instant local update — so the button doesn't feel unresponsive while waiting
      // for the next SONOS_DATA tick to confirm. _syncControlOverlay() will correct
      // this if the command failed or the real state differs.
      const nowPlaying = !wasPlaying;
      playPauseBtn.innerText = nowPlaying ? '⏸' : '▶';
      playPauseBtn.dataset.isPlaying = String(nowPlaying);
      // Use the live zone id, not the `group` captured when this button was built —
      // a group/ungroup action can reassign the zone's id while the overlay stays
      // open (see _locateActiveGroup), and this handler is never rebuilt, only synced.
      this.sendSocketNotification(notification, { zoneId: this._activeControlZoneId });
    });
    sheet.appendChild(playPauseBtn);

    const volumeRow = document.createElement('div');
    volumeRow.className = 'mmm-sonos__overlay-volume';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = String(this.config.controlVolumeStep || 5);
    slider.value = String(group.volume ?? 0);
    slider.className = 'mmm-sonos__overlay-volume-slider';
    const volumeLabel = document.createElement('span');
    volumeLabel.className = 'mmm-sonos__overlay-volume-label';
    volumeLabel.innerText = `${slider.value}%`;
    slider.addEventListener('input', () => {
      volumeLabel.innerText = `${slider.value}%`;
      // See the play/pause handler above — use the live zone id, not `group.id`.
      this._debounceSetVolume(this._activeControlZoneId, Number(slider.value));
    });
    volumeRow.appendChild(slider);
    volumeRow.appendChild(volumeLabel);
    sheet.appendChild(volumeRow);

    const memberVolumesSection = document.createElement('div');
    memberVolumesSection.className = 'mmm-sonos__overlay-member-volumes';
    sheet.appendChild(memberVolumesSection);
    this._renderMemberVolumesSection(memberVolumesSection, group);

    const favoritesList = document.createElement('div');
    favoritesList.className = 'mmm-sonos__overlay-favorites';
    sheet.appendChild(favoritesList);

    document.body.appendChild(backdrop);
    this._controlOverlayEl = backdrop;
    this._renderedMemberNamesKey = (group.members || []).join('|');
    this._renderControlOverlayFavorites();
  },

  // Builds the collapsed-by-default "▾ Per-speaker volume" section, only shown once a
  // zone has more than one member — a single-speaker zone's own slider above already IS
  // that speaker's volume.
  _renderMemberVolumesSection(container, group) {
    container.innerHTML = '';
    if (!group.members || group.members.length <= 1) {
      return;
    }
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mmm-sonos__overlay-member-volumes-toggle';
    toggle.innerText = `▾ ${this.translate('PER_SPEAKER_VOLUME')}`;
    toggle.setAttribute('aria-expanded', 'false');
    const list = document.createElement('div');
    list.className = 'mmm-sonos__overlay-member-volumes-list';
    list.hidden = true;
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      list.hidden = expanded;
    });
    container.appendChild(toggle);
    container.appendChild(list);
    this._renderMemberVolumeRows(list, group);
  },

  _renderMemberVolumeRows(list, group) {
    list.innerHTML = '';
    (group.memberDetails || []).forEach((member) => {
      const row = document.createElement('div');
      row.className = 'mmm-sonos__overlay-member-volume-row';
      row.dataset.memberName = member.name;
      const label = document.createElement('span');
      label.className = 'mmm-sonos__overlay-member-volume-name';
      label.innerText = member.name;
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.step = String(this.config.controlVolumeStep || 5);
      slider.value = String(member.volume ?? 0);
      slider.className = 'mmm-sonos__overlay-member-volume-slider';
      const volumeLabel = document.createElement('span');
      volumeLabel.className = 'mmm-sonos__overlay-member-volume-label';
      volumeLabel.innerText = `${slider.value}%`;
      slider.addEventListener('input', () => {
        volumeLabel.innerText = `${slider.value}%`;
        this._debounceSetMemberVolume(group.id, member.name, Number(slider.value));
      });
      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(volumeLabel);
      list.appendChild(row);
    });
  },

  _syncControlOverlay() {
    const group = this._locateActiveGroup();
    if (!group) {
      this._showZoneUnavailableAndClose();
      return;
    }
    if (!this._controlOverlayEl) {
      return;
    }

    const title = this._controlOverlayEl.querySelector('.mmm-sonos__overlay-title');
    if (title) {
      title.innerText = group.name || '';
    }

    const playPauseBtn = this._controlOverlayEl.querySelector('.mmm-sonos__overlay-playpause');
    if (playPauseBtn) {
      const isPlaying = ['playing', 'transitioning', 'buffering'].includes((group.playbackState || '').toLowerCase());
      playPauseBtn.innerText = isPlaying ? '⏸' : '▶';
      playPauseBtn.dataset.isPlaying = String(isPlaying);
    }

    const slider = this._controlOverlayEl.querySelector('.mmm-sonos__overlay-volume-slider');
    const volumeLabel = this._controlOverlayEl.querySelector('.mmm-sonos__overlay-volume-label');
    if (slider && document.activeElement !== slider && group.volume != null) {
      slider.value = String(group.volume);
      if (volumeLabel) {
        volumeLabel.innerText = `${group.volume}%`;
      }
    }

    // Rebuild the per-speaker volume section only when the actual set of members changed
    // (e.g. a group/ungroup action) — otherwise just refresh the existing sliders' values,
    // same rationale as the favorites list below: don't yank an expanded section shut or
    // reset scroll position on every routine poll tick.
    const memberNamesKey = (group.members || []).join('|');
    const memberVolumesSection = this._controlOverlayEl.querySelector('.mmm-sonos__overlay-member-volumes');
    if (memberVolumesSection && memberNamesKey !== this._renderedMemberNamesKey) {
      this._renderMemberVolumesSection(memberVolumesSection, group);
      this._renderedMemberNamesKey = memberNamesKey;
    } else {
      (group.memberDetails || []).forEach((member) => {
        const row = this._controlOverlayEl.querySelector(
          `.mmm-sonos__overlay-member-volume-row[data-member-name="${CSS.escape(member.name)}"]`
        );
        if (!row) return;
        const memberSlider = row.querySelector('.mmm-sonos__overlay-member-volume-slider');
        const memberLabel = row.querySelector('.mmm-sonos__overlay-member-volume-label');
        if (memberSlider && document.activeElement !== memberSlider && member.volume != null) {
          memberSlider.value = String(member.volume);
          if (memberLabel) {
            memberLabel.innerText = `${member.volume}%`;
          }
        }
      });
    }

    if (this._speakersOverlayEl) {
      this._syncSpeakersOverlay();
    }

    // Only rebuild the favorites list when something that affects its rendered
    // output actually changed — the favorites array itself, or which favorite
    // is currently active (driven by the now-playing title). Rebuilding on every
    // tick resets scroll position and can yank a button out from under a tap.
    const favoritesChanged = this.favorites !== this._renderedFavoritesRef;
    const activeTitleChanged = (group.title || null) !== this._renderedActiveTitle;
    if (favoritesChanged || activeTitleChanged) {
      this._renderControlOverlayFavorites();
    }
  },

  _renderControlOverlayFavorites() {
    if (!this._controlOverlayEl) {
      return;
    }
    const list = this._controlOverlayEl.querySelector('.mmm-sonos__overlay-favorites');
    if (!list) {
      return;
    }
    list.innerHTML = '';

    const group = this._findGroupById(this._activeControlZoneId);
    const favorites = this._limitFavorites(this.favorites, this.config.maxFavorites);

    // Track what we just rendered so _syncControlOverlay can skip redundant rebuilds
    // (see _renderedFavoritesRef / _renderedActiveTitle).
    this._renderedFavoritesRef = this.favorites;
    this._renderedActiveTitle = group ? group.title : null;

    if (!favorites.length) {
      const empty = document.createElement('div');
      empty.className = 'mmm-sonos__overlay-favorites-empty';
      empty.innerText = this.translate('NO_FAVORITES');
      list.appendChild(empty);
      return;
    }

    favorites.forEach((favorite) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'mmm-sonos__overlay-favorite';
      const isActive = !!(group && group.title && group.title === favorite.title);
      if (isActive) {
        item.classList.add('mmm-sonos__overlay-favorite--active');
      }
      item.innerText = favorite.title;
      item.addEventListener('click', () => {
        this.sendSocketNotification('SONOS_CONTROL_PLAY_FAVORITE', {
          zoneId: this._activeControlZoneId,
          favoriteId: favorite.id
        });
      });
      list.appendChild(item);
    });
  },

  _showZoneUnavailableAndClose() {
    if (!this._controlOverlayEl) {
      this._activeControlZoneId = null;
      return;
    }
    const errorEl = this._controlOverlayEl.querySelector('.mmm-sonos__overlay-error');
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.innerText = this.translate('ZONE_UNAVAILABLE');
    }
    setTimeout(() => this._closeControlOverlay(), 1500);
  },

  _handleControlResult(payload) {
    if (!this._controlOverlayEl || !payload || payload.zoneId !== this._activeControlZoneId) {
      return;
    }
    const errorEl = this._controlOverlayEl.querySelector('.mmm-sonos__overlay-error');
    if (!errorEl) {
      return;
    }
    if (payload.success) {
      errorEl.hidden = true;
      errorEl.innerText = '';
    } else {
      errorEl.hidden = false;
      const group = this._findGroupById(this._activeControlZoneId);
      errorEl.innerText = `${this.translate('CONTROL_ERROR')}${group?.name ? ': ' + group.name : ''}`;
    }
  },

  _resolveDisplayMode() {
    if (['grid', 'row', 'mini', 'fullscreen'].includes(this.config.displayMode)) {
      return this.config.displayMode;
    }
    // auto mode: grid if more than columns else row
    const columnThreshold = this._getGridColumns();
    return this.groups.length > columnThreshold ? 'grid' : 'row';
  },

  _isHidden(group) {
    const byGroup = (this.config.hiddenGroups || []).map((g) => g.toLowerCase());
    const bySpeaker = (this.config.hiddenSpeakers || []).map((g) => g.toLowerCase());
    const allowedGroups = (this.config.allowedGroups || []).map((g) => g.toLowerCase());
    const allowedSpeakers = (this.config.allowedSpeakers || []).map((g) => g.toLowerCase());

    // Blacklist — explicit hide by group id/name
    if (byGroup.includes((group.id || '').toLowerCase()) || byGroup.includes((group.name || '').toLowerCase())) {
      return true;
    }

    // Blacklist — hide if any member is in the hidden list
    if (group.members && group.members.some((m) => bySpeaker.includes(m.toLowerCase()))) {
      return true;
    }

    // Blacklist — hide by coordinator IP
    if (group.coordinatorHost && bySpeaker.includes(group.coordinatorHost.toLowerCase())) {
      return true;
    }

    // Whitelist — if allowedGroups is set, only show matching group names/IDs/IPs
    if (allowedGroups.length > 0) {
      const matchGroup =
        allowedGroups.includes((group.id || '').toLowerCase()) ||
        allowedGroups.includes((group.name || '').toLowerCase()) ||
        (group.coordinatorHost && allowedGroups.includes(group.coordinatorHost.toLowerCase()));
      if (!matchGroup) return true;
    }

    // Whitelist — if allowedSpeakers is set, only show groups whose members are ALL listed,
    // or at least one member is listed (use any-match so a stereo pair is not blocked)
    if (allowedSpeakers.length > 0) {
      const hasAllowedMember =
        group.members &&
        group.members.some((m) => allowedSpeakers.includes(m.toLowerCase()));
      const hostAllowed = group.coordinatorHost && allowedSpeakers.includes(group.coordinatorHost.toLowerCase());
      if (!hasAllowedMember && !hostAllowed) return true;
    }

    return false;
  },

  _normalizeSize(value) {
    if (value == null) {
      return null;
    }
    if (typeof value === 'number') {
      return `${value}px`;
    }
    if (typeof value === 'string') {
      return value.match(/(px|rem|em|vw|vh|%|ch)$/) ? value : `${value}px`;
    }
    return null;
  },

  _applyLayoutMode(wrapper, mode, cardMinValue, gridColumns) {
    const gapValue = 'var(--mmm-sonos-gap)';
    wrapper.style.display = 'flex';
    wrapper.style.flexWrap = 'wrap';
    wrapper.style.overflowX = 'visible';
    wrapper.style.gap = gapValue;
    wrapper.style.gridTemplateColumns = '';
    wrapper.style.justifyItems = '';

    if (mode === 'row') {
      wrapper.style.display = 'flex';
      wrapper.style.flexWrap = 'nowrap';
      wrapper.style.overflowX = 'auto';
      wrapper.style.gap = gapValue;
      wrapper.style.alignItems = 'stretch';
    } else if (mode === 'grid') {
      const minWidth = cardMinValue || `${this.defaults.cardMinWidth}px`;
      const columns = Math.max(1, Number(gridColumns) || this.defaults.columns || 2);
      wrapper.style.display = 'grid';
      wrapper.style.gridTemplateColumns = `repeat(${columns}, minmax(${minWidth}, 1fr))`;
      wrapper.style.justifyItems = 'center';
      wrapper.style.gap = gapValue;
    } else if (mode === 'mini') {
      wrapper.style.display = 'flex';
      wrapper.style.flexDirection = 'column';
      wrapper.style.flexWrap = 'nowrap';
      wrapper.style.gap = '0.3rem';
      wrapper.style.overflowX = 'visible';
      const miniW = this._normalizeSize(this.config.miniWidth);
      if (miniW) {
        wrapper.style.maxWidth = miniW;
        wrapper.style.width = '100%';
      }
    } else if (mode === 'fullscreen') {
      wrapper.style.display = 'flex';
      wrapper.style.flexDirection = 'column';
      wrapper.style.flexWrap = 'nowrap';
      wrapper.style.gap = '0';
      wrapper.style.overflowX = 'visible';
      const fsWidth = this._normalizeSize(this.config.fullscreenWidth);
      if (fsWidth) {
        wrapper.style.maxWidth = fsWidth;
        wrapper.style.width = '100%';
      }
    }
  },

  _coercePixelValue(value, fallback) {
    if (value != null) {
      const numeric = Number(value);
      if (!Number.isNaN(numeric) && Number.isFinite(numeric) && numeric >= 0) {
        return `${numeric}px`;
      }
    }

    if (fallback == null) {
      return null;
    }

    const fallbackNumeric = Number(fallback);
    if (!Number.isNaN(fallbackNumeric) && Number.isFinite(fallbackNumeric) && fallbackNumeric >= 0) {
      return `${fallbackNumeric}px`;
    }

    return null;
  },

  _mapTextAlign(alignment) {
    switch (alignment) {
      case 'center':
        return 'center';
      case 'right':
        return 'right';
      case 'left':
      default:
        return 'left';
    }
  },

  _getGridColumns() {
    const candidate = Number(this.config.columns);
    if (!Number.isNaN(candidate) && Number.isFinite(candidate) && candidate >= 1) {
      return Math.max(1, Math.min(4, Math.round(candidate)));
    }

    const fallback = Number(this.defaults.columns);
    if (!Number.isNaN(fallback) && Number.isFinite(fallback) && fallback >= 1) {
      return Math.max(1, Math.min(4, Math.round(fallback)));
    }

    return 2;
  },

  _log(...args) {
    if (this.config.debug) {
      console.log('[MMM-Sonos]', ...args);
    }
  },

  /**
   * Clears the local album art cache.
   * Can be called from the browser console:
   *   MM.getModules().withClass('MMM-Sonos')[0].clearAlbumArtCache()
   */
  clearAlbumArtCache() {
    this.sendSocketNotification('SONOS_CLEAR_CACHE');
  },

  _renderSourceLabel(alignment) {
    if (!this.config.showTvSource) {
      return null;
    }

    const container = document.createElement('div');
    container.className = 'mmm-sonos__source mmm-sonos__source--label';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '0.08rem';

    if (alignment === 'center') {
      container.style.alignItems = 'center';
      container.style.textAlign = 'center';
      container.style.alignSelf = 'center';
    } else if (alignment === 'left') {
      container.style.alignItems = 'flex-end';
      container.style.textAlign = 'right';
      container.style.alignSelf = 'flex-end';
    } else {
      container.style.alignItems = 'flex-start';
      container.style.textAlign = 'left';
      container.style.alignSelf = 'flex-start';
    }

    const label = document.createElement('span');
    label.className = 'mmm-sonos__source-label';
    const labelText = this.config.tvLabel || this.translate('TV_SOURCE_LABEL') || 'Source: TV';
    label.innerText = labelText;
    container.appendChild(label);

    return container;
  },

  _renderPlaybackSource(source, alignment) {
    if (!source) {
      return null;
    }

    const container = document.createElement('div');
    container.className = 'mmm-sonos__playback-source';

    if (alignment === 'center') {
      container.style.justifyContent = 'center';
      container.style.alignSelf = 'center';
    } else if (alignment === 'left') {
      container.style.justifyContent = 'flex-end';
      container.style.alignSelf = 'flex-end';
    } else {
      container.style.justifyContent = 'flex-start';
      container.style.alignSelf = 'flex-start';
    }

    const label = document.createElement('span');
    label.className = 'mmm-sonos__playback-source-label';

    const sourceLower = source.toLowerCase();
    if (sourceLower.includes('spotify')) {
      label.innerText = this.translate('SOURCE_SPOTIFY');
    } else if (sourceLower.includes('apple')) {
      label.innerText = this.translate('SOURCE_APPLE_MUSIC');
    } else if (sourceLower.includes('radio') || sourceLower.includes('stream')) {
      label.innerText = this.translate('SOURCE_RADIO');
    } else if (sourceLower.includes('line') || sourceLower.includes('linein')) {
      label.innerText = this.translate('SOURCE_LINE_IN');
    } else {
      label.innerText = this.translate('SOURCE_UNKNOWN');
    }

    container.appendChild(label);

    return container;
  },

  _renderProgress(position, duration, alignment, isPlaying) {
    if (position == null || duration == null || duration <= 0) {
      return null;
    }

    const container = document.createElement('div');
    container.className = 'mmm-sonos__progress';

    if (alignment === 'center') {
      container.style.alignItems = 'center';
      container.style.alignSelf = 'center';
    } else if (alignment === 'left') {
      container.style.alignItems = 'flex-end';
      container.style.alignSelf = 'flex-end';
    } else {
      container.style.alignItems = 'flex-start';
      container.style.alignSelf = 'flex-start';
    }

    const barWrapper = document.createElement('div');
    barWrapper.className = 'mmm-sonos__progress-bar-wrapper';

    const bar = document.createElement('div');
    bar.className = 'mmm-sonos__progress-bar';

    // Store the initial position, duration, and timestamp for smooth animation
    // Use lastUpdated timestamp for consistency with when data was actually received
    bar.dataset.initialPosition = position;
    bar.dataset.duration = duration;
    bar.dataset.timestamp = this.lastUpdated || Date.now();
    bar.dataset.isPlaying = String(Boolean(isPlaying));

    const percentage = Math.min(100, Math.max(0, (position / duration) * 100));
    bar.style.width = `${percentage}%`;

    barWrapper.appendChild(bar);
    container.appendChild(barWrapper);

    const timeInfo = document.createElement('div');
    timeInfo.className = 'mmm-sonos__progress-time';
    timeInfo.dataset.initialPosition = position;
    timeInfo.dataset.duration = duration;
    timeInfo.dataset.timestamp = this.lastUpdated || Date.now();
    timeInfo.dataset.isPlaying = String(Boolean(isPlaying));
    timeInfo.innerText = `${this._formatTime(position)} / ${this._formatTime(duration)}`;
    container.appendChild(timeInfo);

    return container;
  },

  _renderVolume(volume, alignment) {
    if (volume == null) {
      return null;
    }

    const container = document.createElement('div');
    container.className = 'mmm-sonos__volume';

    if (alignment === 'center') {
      container.style.justifyContent = 'center';
      container.style.alignSelf = 'center';
    } else if (alignment === 'left') {
      container.style.justifyContent = 'flex-end';
      container.style.alignSelf = 'flex-end';
    } else {
      container.style.justifyContent = 'flex-start';
      container.style.alignSelf = 'flex-start';
    }

    const label = document.createElement('span');
    label.className = 'mmm-sonos__volume-label';
    label.innerText = `${this.translate('VOLUME')}: ${volume}%`;
    container.appendChild(label);

    return container;
  },

  _formatTime(seconds) {
    if (seconds == null || isNaN(seconds)) {
      return '0:00';
    }

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  },

  _isTvSource(group) {
    const source = (group?.source || '').toLowerCase();
    return group?.isTvSource || source === 'tv' || source === 'tvs';
  },

  _resolveTvSvgSource() {
    const candidate = this.config.tvIconSvgPath;
    if (candidate) {
      const isHttp = /^https?:\/\//i.test(candidate);
      if (isHttp) {
        return candidate;
      }
      return this.file(candidate);
    }
    return this.file('assets/tv-default.svg');
  },

  // Returns the module's own wrapper element from the live DOM.
  // By scoping all in-place DOM queries through this element we prevent one module
  // instance from accidentally finding or modifying cards that belong to another
  // instance (e.g. a normal-mode instance operating on mini-mode cards).
  _getModuleWrapper() {
    return document.querySelector(`[data-module-id="${this.identifier}"]`);
  },

  _startProgressAnimation() {
    // Only start the animation timer if progress display is enabled
    if (!this.config.showProgress) {
      return;
    }

    // Update progress bars every second for smooth animation
    if (this.progressAnimationTimer) {
      clearInterval(this.progressAnimationTimer);
    }
    
    this.progressAnimationTimer = setInterval(() => {
      this._updateProgressBars();
    }, 1000);
  },

  _updateProgressBars() {
    if (!this.config.showProgress) {
      return;
    }

    // Find all progress bars in the DOM
    const progressBars = document.querySelectorAll('.mmm-sonos__progress-bar');
    const timeDisplays = document.querySelectorAll('.mmm-sonos__progress-time');

    // If no progress bars exist, no need to continue
    if (progressBars.length === 0) {
      return;
    }

    progressBars.forEach((bar) => {
      const progressData = this._parseProgressData(bar.dataset);
      if (!progressData) {
        return;
      }

      const percentage = Math.min(100, Math.max(0, (progressData.currentPosition / progressData.duration) * 100));
      bar.style.width = `${percentage}%`;
    });

    timeDisplays.forEach((timeInfo) => {
      const progressData = this._parseProgressData(timeInfo.dataset);
      if (!progressData) {
        return;
      }

      timeInfo.innerText = `${this._formatTime(progressData.currentPosition)} / ${this._formatTime(progressData.duration)}`;
    });
  },

  _parseProgressData(dataset) {
    const initialPosition = parseFloat(dataset.initialPosition);
    const duration = parseFloat(dataset.duration);
    const timestamp = parseFloat(dataset.timestamp);
    const isPlaying = dataset.isPlaying === 'true';

    if (isNaN(initialPosition) || isNaN(duration) || isNaN(timestamp) || duration <= 0) {
      return null;
    }

    // While paused/stopped, the position doesn't move — extrapolating it forward
    // by elapsed wall-clock time would make a paused track appear to keep playing.
    if (!isPlaying) {
      return { initialPosition, duration, timestamp, elapsed: 0, currentPosition: initialPosition };
    }

    // Calculate elapsed time since the last update
    const elapsed = (Date.now() - timestamp) / 1000;
    const currentPosition = Math.min(duration, initialPosition + elapsed);

    return { initialPosition, duration, timestamp, elapsed, currentPosition };
  },

  // Analyse what changed between the last known groups and the newly received groups.
  // Returns { needsFull, changedIds, volumeChangedIds } where:
  //   needsFull       — true when a full re-render is required (structural change)
  //   changedIds      — Set of group IDs whose track/art changed (triggers per-card animation)
  //   volumeChangedIds — Set of group IDs whose volume changed but track did not (silent in-place update)
  _analyzeChanges(newGroups, newTimestamp) {
    const none = { needsFull: false, changedIds: new Set(), volumeChangedIds: new Set() };

    if (!this.groups || this.groups.length !== newGroups.length) {
      return { needsFull: true, changedIds: new Set(), volumeChangedIds: new Set() };
    }

    if (newGroups.length === 0) {
      return this.groups.length !== 0
        ? { needsFull: true, changedIds: new Set(), volumeChangedIds: new Set() }
        : none;
    }

    const oldGroupMap = new Map();
    this.groups.forEach((g) => { if (g.id) oldGroupMap.set(g.id, g); });

    // States that are all considered "actively playing" — transitions between them
    // should NOT trigger a full re-render. Only a change from/to a truly different
    // state (paused, stopped, etc.) is a structural change requiring full re-render.
    const isPlayingLike = (s) => ['playing', 'transitioning', 'buffering'].includes((s || '').toLowerCase());

    const timeElapsed = this.lastUpdated ? (newTimestamp - this.lastUpdated) / 1000 : 0;
    const changedIds = new Set();
    const volumeChangedIds = new Set();

    for (const newGroup of newGroups) {
      const oldGroup = oldGroupMap.get(newGroup.id);
      if (!oldGroup) return { needsFull: true, changedIds: new Set(), volumeChangedIds: new Set() };

      // Structural changes → full re-render
      // Playback state changes between playing-like states (PLAYING ↔ TRANSITIONING ↔ BUFFERING)
      // during a track change are NOT treated as structural — they only trigger per-card animation.
      const playbackStateChanged = oldGroup.playbackState !== newGroup.playbackState;
      const playbackStateIsStructural = playbackStateChanged &&
        !(isPlayingLike(oldGroup.playbackState) && isPlayingLike(newGroup.playbackState));

      if (oldGroup.name !== newGroup.name ||
          playbackStateIsStructural ||
          oldGroup.source !== newGroup.source) {
        return { needsFull: true, changedIds: new Set(), volumeChangedIds: new Set() };
      }

      if (oldGroup.members?.length !== newGroup.members?.length) {
        return { needsFull: true, changedIds: new Set(), volumeChangedIds: new Set() };
      }
      if (oldGroup.members && newGroup.members) {
        for (let j = 0; j < oldGroup.members.length; j++) {
          if (oldGroup.members[j] !== newGroup.members[j]) {
            return { needsFull: true, changedIds: new Set(), volumeChangedIds: new Set() };
          }
        }
      }

      // Track-level changes → animate only this card
      // Note: volume is intentionally excluded here; a volume-only change should not
      // trigger a visible track-change animation — it is handled silently below.
      if (oldGroup.title !== newGroup.title ||
          oldGroup.artist !== newGroup.artist ||
          oldGroup.album !== newGroup.album ||
          oldGroup.albumArt !== newGroup.albumArt ||
          oldGroup.duration !== newGroup.duration) {
        changedIds.add(newGroup.id);
        continue;
      }

      // Significant seek/position jump
      if (oldGroup.position != null && newGroup.position != null) {
        const diff = Math.abs(newGroup.position - (oldGroup.position + timeElapsed));
        if (diff > 3) {
          this._log('Seek detected', newGroup.id, diff);
          changedIds.add(newGroup.id);
          continue;
        }
      }

      // Volume-only change → silent in-place DOM update, no animation
      if (oldGroup.volume !== newGroup.volume) {
        volumeChangedIds.add(newGroup.id);
      }
    }

    return { needsFull: false, changedIds, volumeChangedIds };
  },

  // Animate only the specific group cards that changed — everything else stays untouched.
  // Works for all display modes (mini, row, grid, fullscreen).
  _animateGroupCards(changedIds, newGroups) {
    const animation = (this.config.transitionAnimation || 'fade').toLowerCase();
    const duration = Math.max(200, Number(this.config.transitionDuration) || 400);
    const halfDuration = Math.round(duration / 2);
    const displayMode = this._resolveDisplayMode();
    const isMini = displayMode === 'mini';
    const isFullscreen = displayMode === 'fullscreen';

    const newGroupMap = new Map();
    newGroups.forEach((g) => { if (g.id) newGroupMap.set(g.id, g); });

    const animOutClass = animation !== 'none' ? `mmm-sonos__card--anim-out-${animation}` : null;
    const animInClass  = animation !== 'none' ? `mmm-sonos__card--anim-in-${animation}`  : null;

    // Scope all queries to this module instance's own wrapper to avoid cross-instance interference
    const moduleWrapper = this._getModuleWrapper();

    for (const id of changedIds) {
      const el = moduleWrapper ? moduleWrapper.querySelector(`[data-group-id="${id}"]`) : null;
      if (!el || !el.parentNode) {
        // Element not in DOM yet — fall back to full re-render
        this._animatedUpdateDom();
        return;
      }

      const newGroup = newGroupMap.get(id);
      if (!newGroup) continue;

      // Preload the new album art during the out-animation so the image is already
      // browser-cached when the new card is inserted, eliminating the blank-art flash.
      if (newGroup.albumArt) {
        const preloadImg = new Image();
        preloadImg.loading = 'eager';
        preloadImg.src = newGroup.albumArt;
      }

      if (animOutClass) {
        el.style.setProperty('--mmm-sonos-card-anim-duration', `${halfDuration}ms`);
        el.classList.add(animOutClass);
      }

      const parent = el.parentNode;
      setTimeout(() => {
        let newEl;
        if (isMini) {
          newEl = this._renderMiniGroup(newGroup);
        } else if (isFullscreen) {
          newEl = this._renderFullscreenGroup(newGroup);
        } else {
          newEl = this._renderGroup(newGroup);
        }
        if (!newEl) { el.remove(); return; }

        if (animInClass) {
          newEl.style.setProperty('--mmm-sonos-card-anim-duration', `${halfDuration}ms`);
          newEl.classList.add(animInClass);
        }
        parent.replaceChild(newEl, el);

        if (animInClass) {
          setTimeout(() => newEl.classList.remove(animInClass), halfDuration);
        }
      }, animOutClass ? halfDuration : 0);
    }
  },

  _shouldUpdateDom() {
    // Legacy stub — kept so external callers don't break. Not used internally any more.
    return true;
  },

  // Use MagicMirror's built-in animate.css integration for full-module transitions
  // (structural changes: new group appeared, group removed, playback state changed, etc.)
  // Debounced: if called multiple times within a short window, only the last call fires.
  // This prevents double-animation when rapid successive SONOS_DATA notifications arrive
  // (e.g. PLAYING → TRANSITIONING → PLAYING during a track change on initial load).
  _animatedUpdateDom() {
    const debounceMs = 300;

    if (this._fullUpdateDebounceTimer) {
      clearTimeout(this._fullUpdateDebounceTimer);
      this._fullUpdateDebounceTimer = null;
    }

    this._fullUpdateDebounceTimer = setTimeout(() => {
      this._fullUpdateDebounceTimer = null;
      this._executeAnimatedUpdateDom();
    }, debounceMs);
  },

  _executeAnimatedUpdateDom() {
    const animation = (this.config.transitionAnimation || 'fade').toLowerCase();
    if (animation === 'none') {
      this.updateDom(0);
      return;
    }
    const duration = Math.max(200, Number(this.config.transitionDuration) || 400);
    const animMap = {
      'fade':        { out: 'fadeOut',      in: 'fadeIn' },
      'slide-up':    { out: 'fadeOutUp',    in: 'fadeInUp' },
      'slide-down':  { out: 'fadeOutDown',  in: 'fadeInDown' },
      'slide-left':  { out: 'fadeOutLeft',  in: 'fadeInRight' },
      'slide-right': { out: 'fadeOutRight', in: 'fadeInLeft' },
      'scale':       { out: 'zoomOut',      in: 'zoomIn' },
      'zoom-in':     { out: 'zoomOut',      in: 'zoomIn' },
      'zoom-out':    { out: 'zoomIn',       in: 'zoomOut' },
      'flip':        { out: 'flipOutX',     in: 'flipInX' },
      'pixelate':    { out: 'fadeOut',      in: 'fadeIn' }, // full-module fallback: CSS blur only works for per-card animations
    };
    const anim = animMap[animation] || animMap['fade'];
    this.updateDom({ options: { speed: duration, animate: { out: anim.out, in: anim.in } } });
  },

  // Render a compact single-row card for mini-mode display.
  _renderMiniGroup(group) {
    if (!group) return null;

    const isHidden = this._isHidden(group);
    if (isHidden) return null;

    const playbackState = (group.playbackState || '').toLowerCase();
    const isPlaying = ['playing', 'transitioning', 'buffering'].includes(playbackState);
    if (!isPlaying && !this.config.showWhenPaused) return null;

    const size = Math.max(24, Number(this.config.miniAlbumArtSize) || 40);
    const sizeValue = `${size}px`;

    const row = document.createElement('div');
    row.className = 'mmm-sonos__mini-group';
    row.dataset.groupId = group.id;

    // Apply miniWidth if configured
    const miniW = this._normalizeSize(this.config.miniWidth);
    if (miniW) {
      row.style.maxWidth = miniW;
      row.style.width = '100%';
    }

    if (this.config.accentuateActive && isPlaying) {
      row.classList.add('mmm-sonos__group--active');
    }

    // Apply accent colour on mini card too
    if (this.config.albumArtColors && group.accentColor) {
      const { r, g, b } = group.accentColor;
      row.style.setProperty('--mmm-sonos-card-accent-rgb', `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`);
      row.style.setProperty('--mmm-sonos-card-accent-opacity', String(this.config.albumArtColorsOpacity ?? 0.45));
      row.classList.add('mmm-sonos__group--accented');
      if ((this.config.albumArtColorsMode || 'gradient').toLowerCase() === 'solid') {
        row.classList.add('mmm-sonos__group--accented-solid');
      }
    }

    // Thumbnail artwork
    const art = document.createElement('div');
    art.className = 'mmm-sonos__mini-art' + (group.albumArt ? '' : ' mmm-sonos__mini-art--placeholder');
    art.style.width = sizeValue;
    art.style.height = sizeValue;
    if (group.albumArt) {
      const img = document.createElement('img');
      // Use eager loading: on a MagicMirror display every card is always visible,
      // so lazy loading only delays the image; eager gives instant display.
      img.loading = 'eager';
      img.src = group.albumArt;
      img.alt = '';
      img.style.width = sizeValue;
      img.style.height = sizeValue;
      img.onerror = () => { art.style.display = 'none'; };
      art.appendChild(img);
    }
    row.appendChild(art);

    // Text block
    const textWrap = document.createElement('div');
    textWrap.className = 'mmm-sonos__mini-text';

    if (this.config.miniShowGroupName && group.name) {
      const badge = document.createElement('span');
      badge.className = 'mmm-sonos__mini-badge';
      badge.innerText = group.name;
      textWrap.appendChild(badge);
    }

    const titleLine = document.createElement('div');
    titleLine.className = 'mmm-sonos__mini-title';
    let titleText = group.title || this.translate('UNKNOWN_TRACK');
    if (this.config.miniShowArtist && group.artist) {
      titleText += ` · ${group.artist}`;
    }
    titleLine.innerText = titleText;
    textWrap.appendChild(titleLine);

    if (this.config.miniShowSource && group.source && !group.isTvSource) {
      const sourceEl = document.createElement('div');
      sourceEl.className = 'mmm-sonos__mini-source';
      const s = (group.source || '').toLowerCase();
      if (s.includes('spotify')) sourceEl.innerText = this.translate('SOURCE_SPOTIFY');
      else if (s.includes('apple')) sourceEl.innerText = this.translate('SOURCE_APPLE_MUSIC');
      else if (s.includes('radio') || s.includes('stream')) sourceEl.innerText = this.translate('SOURCE_RADIO');
      else sourceEl.innerText = this.translate('SOURCE_UNKNOWN');
      textWrap.appendChild(sourceEl);
    }

    row.appendChild(textWrap);
    return row;
  },

  // Resolve which group to show in fullscreen mode.
  // If fullscreenSpeaker is configured, find the matching group; otherwise use the first group.
  _resolveFullscreenGroup() {
    if (!this.groups || !this.groups.length) {
      return null;
    }

    const speaker = (this.config.fullscreenSpeaker || '').toLowerCase().trim();
    if (speaker) {
      const match = this.groups.find((g) =>
        (g.name || '').toLowerCase() === speaker ||
        (g.id || '').toLowerCase() === speaker ||
        (g.coordinatorHost || '').toLowerCase() === speaker ||
        (g.members || []).some((m) => m.toLowerCase() === speaker)
      );
      return match || this.groups[0];
    }

    return this.groups[0];
  },

  // Render a large, full-width card for fullscreen mode.
  // Shows album art prominently, with title, artist, album, progress, and volume beneath.
  _renderFullscreenGroup(group) {
    if (!group) return null;

    const isHidden = this._isHidden(group);
    if (isHidden) return null;

    const playbackState = (group.playbackState || '').toLowerCase();
    const isPlaying = ['playing', 'transitioning', 'buffering'].includes(playbackState);
    if (!isPlaying && !this.config.showWhenPaused) return null;

    const artSize = Math.max(80, Number(this.config.fullscreenAlbumArtSize) || 300);
    const sizeValue = `${artSize}px`;
    const isTvSource = this._isTvSource(group);

    const container = document.createElement('div');
    container.className = 'mmm-sonos__fullscreen-group';
    container.dataset.groupId = group.id;

    if (!isPlaying) {
      container.classList.add('mmm-sonos__group--paused');
    }

    if (this.config.accentuateActive && isPlaying) {
      container.classList.add('mmm-sonos__group--active');
    }

    if (this.config.albumArtColors && group.accentColor) {
      const { r, g, b } = group.accentColor;
      container.style.setProperty('--mmm-sonos-card-accent-rgb', `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`);
      container.style.setProperty('--mmm-sonos-card-accent-opacity', String(this.config.albumArtColorsOpacity ?? 0.45));
      container.classList.add('mmm-sonos__group--accented');
      if ((this.config.albumArtColorsMode || 'gradient').toLowerCase() === 'solid') {
        container.classList.add('mmm-sonos__group--accented-solid');
      }
    }

    // Album art
    if (group.albumArt && !isTvSource) {
      const artWrapper = document.createElement('div');
      artWrapper.className = 'mmm-sonos__fullscreen-art';
      artWrapper.style.width = sizeValue;
      artWrapper.style.height = sizeValue;

      const img = document.createElement('img');
      img.loading = 'eager';
      img.src = group.albumArt;
      img.alt = '';
      img.onerror = () => { artWrapper.style.display = 'none'; };
      artWrapper.appendChild(img);
      container.appendChild(artWrapper);
    } else if (isTvSource) {
      const artWrapper = document.createElement('div');
      artWrapper.className = 'mmm-sonos__fullscreen-art mmm-sonos__art--tv';
      artWrapper.style.width = sizeValue;
      artWrapper.style.height = sizeValue;

      if (this.config.showTvIcon !== false) {
        const icon = document.createElement('span');
        icon.className = 'mmm-sonos__source-icon';
        icon.innerText = this.config.tvIcon || '📺';
        icon.style.display = 'flex';
        icon.style.alignItems = 'center';
        icon.style.justifyContent = 'center';
        icon.style.width = '100%';
        icon.style.height = '100%';
        icon.style.fontSize = `${Math.round(artSize * 0.5)}px`;
        artWrapper.appendChild(icon);
      }
      container.appendChild(artWrapper);
    }

    // Text content
    const content = document.createElement('div');
    content.className = 'mmm-sonos__fullscreen-content';

    // Group name
    const groupName = document.createElement('div');
    groupName.className = 'mmm-sonos__fullscreen-group-name';
    groupName.innerText = group.name;
    content.appendChild(groupName);

    // Playback state
    if (this.config.showPlaybackState && group.playbackState) {
      const state = document.createElement('span');
      state.className = 'mmm-sonos__state';
      state.innerText = this.translate(group.playbackState.toUpperCase()) || group.playbackState;
      content.appendChild(state);
    }

    // Track info
    const titleIsDuplicateTv = isTvSource && (!group.artist) && typeof group.title === 'string' && group.title.trim().toLowerCase() === 'tv';
    const hasTrackInfo = group.title || group.artist;

    if (hasTrackInfo && !titleIsDuplicateTv) {
      const title = document.createElement('div');
      title.className = 'mmm-sonos__fullscreen-title';
      title.innerText = group.title || this.translate('UNKNOWN_TRACK');
      content.appendChild(title);

      if (group.artist) {
        const artist = document.createElement('div');
        artist.className = 'mmm-sonos__fullscreen-artist';
        artist.innerText = group.artist;
        content.appendChild(artist);
      }

      if (this.config.showAlbum && group.album) {
        const album = document.createElement('div');
        album.className = 'mmm-sonos__fullscreen-album';
        album.innerText = group.album;
        content.appendChild(album);
      }
    }

    // TV source label
    if (isTvSource && this.config.showTvSource) {
      const sourceEl = this._renderSourceLabel('center');
      if (sourceEl) content.appendChild(sourceEl);
    }

    // Playback source
    if (this.config.showPlaybackSource && group.source && !isTvSource) {
      const sourceEl = this._renderPlaybackSource(group.source, 'center');
      if (sourceEl) content.appendChild(sourceEl);
    }

    // Progress bar
    if (this.config.showProgress && group.duration != null && group.duration > 0) {
      const progressEl = this._renderProgress(group.position ?? 0, group.duration, 'center', isPlaying);
      if (progressEl) content.appendChild(progressEl);
    }

    // Volume
    if (this.config.showVolume && group.volume != null) {
      const volumeEl = this._renderVolume(group.volume, 'center');
      if (volumeEl) content.appendChild(volumeEl);
    }

    // Group members
    if (this.config.showGroupMembers && group.members && group.members.length > 1) {
      const members = document.createElement('div');
      members.className = 'mmm-sonos__members';
      members.innerText = group.members.join(', ');
      content.appendChild(members);
    }

    container.appendChild(content);
    return container;
  },

  _updateProgressDataFromServer(newGroups, newTimestamp) {
    if (!this.config.showProgress) {
      return;
    }

    // Scope queries to this module instance to prevent cross-instance interference
    const moduleWrapper = this._getModuleWrapper();
    if (!moduleWrapper) {
      return;
    }

    // Update the dataset of existing progress bars without re-rendering
    newGroups.forEach((group) => {
      // Skip groups with no known duration (radio streams, TV, etc.)
      if (group.duration == null || group.duration <= 0) {
        return;
      }

      // Find the progress elements for this group, scoped to this module instance.
      const groupElement = moduleWrapper.querySelector(`[data-group-id="${group.id}"]`);
      if (!groupElement) {
        return;
      }

      // Treat null position (track at 0:00:00) as 0
      const safePosition = group.position ?? 0;
      const isPlaying = ['playing', 'transitioning', 'buffering'].includes((group.playbackState || '').toLowerCase());

      const progressBar = groupElement.querySelector('.mmm-sonos__progress-bar');
      const timeDisplay = groupElement.querySelector('.mmm-sonos__progress-time');

      if (progressBar) {
        progressBar.dataset.initialPosition = safePosition;
        progressBar.dataset.duration = group.duration;
        progressBar.dataset.timestamp = newTimestamp;
        progressBar.dataset.isPlaying = String(isPlaying);
      }

      if (timeDisplay) {
        timeDisplay.dataset.initialPosition = safePosition;
        timeDisplay.dataset.duration = group.duration;
        timeDisplay.dataset.timestamp = newTimestamp;
        timeDisplay.dataset.isPlaying = String(isPlaying);
      }
    });
  },

  // Silently update the volume label in the DOM for groups whose volume changed
  // but whose track did not change — no animation needed.
  _updateVolumeInPlace(volumeChangedIds, newGroups) {
    if (!this.config.showVolume) {
      return;
    }

    // Scope queries to this module instance to prevent cross-instance interference
    const moduleWrapper = this._getModuleWrapper();
    if (!moduleWrapper) {
      return;
    }

    newGroups.forEach((group) => {
      if (!volumeChangedIds.has(group.id)) {
        return;
      }
      const groupEl = moduleWrapper.querySelector(`[data-group-id="${group.id}"]`);
      if (!groupEl) {
        return;
      }
      const volumeLabel = groupEl.querySelector('.mmm-sonos__volume-label');
      if (volumeLabel && group.volume != null) {
        volumeLabel.innerText = `${this.translate('VOLUME')}: ${group.volume}%`;
      }
    });
  }
});

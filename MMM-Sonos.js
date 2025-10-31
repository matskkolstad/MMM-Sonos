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
    debug: false
  },

  start() {
    this.groups = [];
    this.error = null;
    this.lastUpdated = null;
    this.updateTimer = null;

  this._log('Starting MMM-Sonos module');
    this.sendSocketNotification('SONOS_CONFIG', this.config);
    this.scheduleRefresh();
  },

  stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
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
      case 'SONOS_DATA':
        this.groups = payload.groups || [];
        this.lastUpdated = payload.timestamp || Date.now();
        this.error = null;
        this.updateDom();
        break;

      case 'SONOS_ERROR':
        this.error = payload;
        this.groups = [];
        this.updateDom();
        break;

      case 'SONOS_DEBUG':
        this._log('[H]', payload);
        break;
    }
  },

  getStyles() {
    return ['MMM-Sonos.css'];
  },

  getTranslations() {
    return {
      en: 'translations/en.json',
      nb: 'translations/nb.json'
    };
  },

  getDom() {
    const wrapper = document.createElement('div');
    wrapper.classList.add('mmm-sonos');
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

    const groupsToRender = this.groups
      .slice(0, this.config.maxGroups)
      .map((group) => this._renderGroup(group))
      .filter(Boolean);

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

    return wrapper;
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
    if (!isPlaying && !this.config.showWhenPaused) {
      return null;
    }

    // Determine alignment once for the entire group
    const alignment = this.config.textAlignment || 'center';

    const container = document.createElement('div');
    container.className = 'mmm-sonos__group';
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

    const cardWidth = Number(this.config.cardMinWidth);
    if (!Number.isNaN(cardWidth) && cardWidth > 0) {
      const widthValue = `${cardWidth}px`;
      container.style.minWidth = widthValue;
      container.style.flexBasis = widthValue;
    }

    if (this.config.accentuateActive && isPlaying) {
      container.classList.add('mmm-sonos__group--active');
    }

    if (this.config.fadePausedGroups && !isPlaying) {
      container.classList.add('mmm-sonos__group--paused');
    }

    // Album art
    if (group.albumArt) {
      const artWrapper = document.createElement('div');
      artWrapper.className = 'mmm-sonos__art';

      const configuredSize = Number(this.config.albumArtSize);
      if (!Number.isNaN(configuredSize) && configuredSize > 0) {
        const sizeValue = `${configuredSize}px`;
        artWrapper.style.width = sizeValue;
        artWrapper.style.height = sizeValue;
      }

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = group.albumArt;
      img.alt = `${group.title || ''}`.trim() || 'Album art';
      if (!Number.isNaN(configuredSize) && configuredSize > 0) {
        const sizeValue = `${configuredSize}px`;
        img.style.width = sizeValue;
        img.style.height = sizeValue;
      }
      artWrapper.appendChild(img);
      container.appendChild(artWrapper);
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
    header.style.flexDirection = 'column';
    header.style.gap = '0.25rem';

    // Align header based on textAlignment (matches container's text-align)
    if (alignment === 'center') {
      header.style.alignItems = 'center';
    } else if (alignment === 'left') {
      // Text on left: align items to flex-end (right) to hug album on the right
      header.style.alignItems = 'flex-end';
    } else if (alignment === 'right') {
      // Text on right: align items to flex-start (left) to hug album on the left
      header.style.alignItems = 'flex-start';
    }

    const groupName = document.createElement('span');
    groupName.className = 'mmm-sonos__group-name';
    groupName.innerText = group.name;
    header.appendChild(groupName);

    if (this.config.showPlaybackState && group.playbackState) {
      const state = document.createElement('span');
      state.className = 'mmm-sonos__state';
      state.innerText = this.translate(group.playbackState.toUpperCase()) || group.playbackState;
      state.style.alignSelf = 'center';
      header.appendChild(state);
    }

    content.appendChild(header);

    if (group.title || group.artist) {
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
    }

    if (this.config.showGroupMembers && group.members && group.members.length > 1) {
      const members = document.createElement('div');
      members.className = 'mmm-sonos__members';
      members.innerText = group.members.join(', ');
      content.appendChild(members);
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

  _resolveDisplayMode() {
    if (['grid', 'row'].includes(this.config.displayMode)) {
      return this.config.displayMode;
    }
    // auto mode: grid if more than columns else row
    const columnThreshold = this._getGridColumns();
    return this.groups.length > columnThreshold ? 'grid' : 'row';
  },

  _isHidden(group) {
    const byGroup = (this.config.hiddenGroups || []).map((g) => g.toLowerCase());
    const bySpeaker = (this.config.hiddenSpeakers || []).map((g) => g.toLowerCase());

    if (byGroup.includes((group.id || '').toLowerCase()) || byGroup.includes((group.name || '').toLowerCase())) {
      return true;
    }

    if (!group.members) {
      return false;
    }

    return group.members.some((member) => bySpeaker.includes(member.toLowerCase()));
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
  }
});

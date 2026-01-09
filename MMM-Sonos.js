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
    debug: false
  },

  start() {
    this.groups = [];
    this.error = null;
    this.lastUpdated = null;
    this.updateTimer = null;
    this.progressAnimationTimer = null;

  this._log('Starting MMM-Sonos module');
    this.sendSocketNotification('SONOS_CONFIG', this.config);
    this.scheduleRefresh();
    this._startProgressAnimation();
  },

  stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    if (this.progressAnimationTimer) {
      clearInterval(this.progressAnimationTimer);
      this.progressAnimationTimer = null;
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
        
        // Only update DOM if there are meaningful changes, not just progress updates
        // Check this BEFORE updating this.groups and this.lastUpdated
        const shouldUpdateDom = this._shouldUpdateDom(newGroups, newTimestamp);
        
        this.groups = newGroups;
        this.lastUpdated = newTimestamp;
        this.error = null;
        
        if (shouldUpdateDom) {
          this._log('Content changed, updating DOM');
          this.updateDom();
        } else {
          this._log('Only progress changed, skipping DOM update');
          // Update progress bars with new server data without re-rendering
          this._updateProgressDataFromServer(newGroups, newTimestamp);
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
    }
  },

  getStyles() {
    return [
      this.file('css/MMM-Sonos.css')
    ];
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

    const isTvSource = this._isTvSource(group);

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

    // Album art (or TV icon placeholder)
    const configuredSize = Number(this.config.albumArtSize);
    const sizeValue = !Number.isNaN(configuredSize) && configuredSize > 0 ? `${configuredSize}px` : null;
    const iconFontSize = !Number.isNaN(configuredSize) && configuredSize > 0 ? `${Math.round(configuredSize * 0.42)}px` : null;
    if (group.albumArt) {
      const artWrapper = document.createElement('div');
      artWrapper.className = 'mmm-sonos__art';
      if (sizeValue) {
        artWrapper.style.width = sizeValue;
        artWrapper.style.height = sizeValue;
      }

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = group.albumArt;
      img.alt = `${group.title || ''}`.trim() || 'Album art';
      if (sizeValue) {
        img.style.width = sizeValue;
        img.style.height = sizeValue;
      }
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

    const sourceElement = isTvSource ? this._renderSourceLabel(alignment) : null;
    if (sourceElement) {
      content.appendChild(sourceElement);
    }

    const hasTrackInfo = group.title || group.artist;
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
    }

    // Playback source indicator
    if (this.config.showPlaybackSource && group.source && !isTvSource) {
      const sourceElement = this._renderPlaybackSource(group.source, alignment);
      if (sourceElement) {
        content.appendChild(sourceElement);
      }
    }

    // Progress indicator
    if (this.config.showProgress && group.position != null && group.duration != null && group.duration > 0) {
      const progressElement = this._renderProgress(group.position, group.duration, alignment);
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

  _renderProgress(position, duration, alignment) {
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

    const percentage = Math.min(100, Math.max(0, (position / duration) * 100));
    bar.style.width = `${percentage}%`;

    barWrapper.appendChild(bar);
    container.appendChild(barWrapper);

    const timeInfo = document.createElement('div');
    timeInfo.className = 'mmm-sonos__progress-time';
    timeInfo.dataset.initialPosition = position;
    timeInfo.dataset.duration = duration;
    timeInfo.dataset.timestamp = this.lastUpdated || Date.now();
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

    if (isNaN(initialPosition) || isNaN(duration) || isNaN(timestamp) || duration <= 0) {
      return null;
    }

    // Calculate elapsed time since the last update
    const elapsed = (Date.now() - timestamp) / 1000;
    const currentPosition = Math.min(duration, initialPosition + elapsed);

    return { initialPosition, duration, timestamp, elapsed, currentPosition };
  },

  _shouldUpdateDom(newGroups, newTimestamp) {
    // Always update if we don't have previous data or group count changed
    if (!this.groups || this.groups.length !== newGroups.length) {
      return true;
    }

    // If no groups at all, no need to update
    if (newGroups.length === 0) {
      return this.groups.length !== 0;
    }

    // Create maps by group ID for efficient comparison
    const oldGroupMap = new Map();
    this.groups.forEach((group) => {
      if (group.id) {
        oldGroupMap.set(group.id, group);
      }
    });

    // Calculate expected time elapsed since last update (using OLD timestamp)
    const timeElapsed = this.lastUpdated ? (newTimestamp - this.lastUpdated) / 1000 : 0;

    // Check if any meaningful content has changed
    for (const newGroup of newGroups) {
      const oldGroup = oldGroupMap.get(newGroup.id);

      // New group or group no longer exists
      if (!oldGroup) {
        return true;
      }

      // Check for changes in identifying or visible properties
      if (oldGroup.name !== newGroup.name ||
          oldGroup.title !== newGroup.title ||
          oldGroup.artist !== newGroup.artist ||
          oldGroup.album !== newGroup.album ||
          oldGroup.albumArt !== newGroup.albumArt ||
          oldGroup.playbackState !== newGroup.playbackState ||
          oldGroup.source !== newGroup.source ||
          oldGroup.volume !== newGroup.volume ||
          oldGroup.duration !== newGroup.duration) {
        return true;
      }

      // Check for significant position changes (e.g., user seeking in track)
      // Allow a tolerance of 3 seconds to account for normal drift and network delays
      if (oldGroup.position !== null && oldGroup.position !== undefined &&
          newGroup.position !== null && newGroup.position !== undefined) {
        const expectedPosition = oldGroup.position + timeElapsed;
        const positionDiff = Math.abs(newGroup.position - expectedPosition);
        if (positionDiff > 3) {
          this._log('Significant position change detected', {
            oldPosition: oldGroup.position,
            newPosition: newGroup.position,
            expectedPosition,
            timeElapsed,
            diff: positionDiff
          });
          return true;
        }
      }

      // Check for member changes
      if (oldGroup.members?.length !== newGroup.members?.length) {
        return true;
      }
      if (oldGroup.members && newGroup.members) {
        for (let j = 0; j < oldGroup.members.length; j++) {
          if (oldGroup.members[j] !== newGroup.members[j]) {
            return true;
          }
        }
      }
    }

    // Only position/progress has changed, no need to update DOM
    return false;
  },

  _updateProgressDataFromServer(newGroups, newTimestamp) {
    if (!this.config.showProgress) {
      return;
    }

    // Update the dataset of existing progress bars without re-rendering
    newGroups.forEach((group) => {
      if (!group.position || !group.duration || group.duration <= 0) {
        return;
      }

      // Find the progress elements for this group
      const groupElement = document.querySelector(`.mmm-sonos__group[data-group-id="${group.id}"]`);
      if (!groupElement) {
        return;
      }

      const progressBar = groupElement.querySelector('.mmm-sonos__progress-bar');
      const timeDisplay = groupElement.querySelector('.mmm-sonos__progress-time');

      if (progressBar) {
        // Update the dataset with new server position
        progressBar.dataset.initialPosition = group.position;
        progressBar.dataset.duration = group.duration;
        progressBar.dataset.timestamp = newTimestamp;
      }

      if (timeDisplay) {
        // Update the dataset with new server position
        timeDisplay.dataset.initialPosition = group.position;
        timeDisplay.dataset.duration = group.duration;
        timeDisplay.dataset.timestamp = newTimestamp;
      }
    });
  }
});

/**
 * LinkedIn Inbox Triage - Popup Script
 */

(function() {
  'use strict';

  // Constants
  const MESSAGES = {
    CLASSIFY_MESSAGES: 'CLASSIFY_MESSAGES',
    GET_CLASSIFICATIONS: 'GET_CLASSIFICATIONS',
    UPDATE_FILTERS: 'UPDATE_FILTERS',
    GET_FILTERS: 'GET_FILTERS',
    CLEAR_CACHE: 'CLEAR_CACHE',
    GET_USER_CONTEXT: 'GET_USER_CONTEXT',
    SET_USER_CONTEXT: 'SET_USER_CONTEXT'
  };

  const CategoryColors = {
    PROMOTIONS: '#ef4444',
    SHOULD_RESPOND: '#22c55e',
    WE_MET: '#eab308',
    IMPORTANT: '#3b82f6'
  };

  const CategoryLabels = {
    PROMOTIONS: 'Promotions',
    SHOULD_RESPOND: 'Possible Response',
    WE_MET: 'We Met',
    IMPORTANT: 'Important'
  };

  const DefaultFilters = {
    PROMOTIONS: false,
    SHOULD_RESPOND: true,
    WE_MET: true,
    IMPORTANT: true
  };

  // DOM Elements
  let filterToggles, clearCacheBtn, refreshBtn, totalCountEl;
  let userContextInput, saveContextBtn;

  // State
  let currentFilters = { ...DefaultFilters };

  /**
   * Initialize popup
   */
  async function init() {
    // Get DOM elements
    filterToggles = document.getElementById('filter-toggles');
    clearCacheBtn = document.getElementById('clear-cache');
    refreshBtn = document.getElementById('refresh');
    totalCountEl = document.getElementById('total-count');
    userContextInput = document.getElementById('user-context');
    saveContextBtn = document.getElementById('save-context');

    await loadFilters();
    await loadStats();
    await loadUserContext();
    setupEventListeners();
  }

  /**
   * Load user context from storage
   */
  async function loadUserContext() {
    try {
      const response = await chrome.runtime.sendMessage({ type: MESSAGES.GET_USER_CONTEXT });
      if (response && response.userContext && userContextInput) {
        userContextInput.value = response.userContext;
      }
    } catch (error) {
      console.error('Error loading user context:', error);
    }
  }

  /**
   * Save user context to storage
   */
  async function saveUserContext() {
    const context = userContextInput.value.trim();
    try {
      await chrome.runtime.sendMessage({
        type: MESSAGES.SET_USER_CONTEXT,
        userContext: context
      });
      showToast('Context saved! Clear cache to re-classify.', 'success');
    } catch (error) {
      console.error('Error saving user context:', error);
      showToast('Failed to save context', 'error');
    }
  }

  /**
   * Load filter settings
   */
  async function loadFilters() {
    try {
      const response = await chrome.runtime.sendMessage({ type: MESSAGES.GET_FILTERS });
      if (response && response.filters) {
        currentFilters = response.filters;
      }
      renderFilterToggles();
    } catch (error) {
      console.error('Error loading filters:', error);
      renderFilterToggles();
    }
  }

  /**
   * Render filter toggle switches
   */
  function renderFilterToggles() {
    const categories = ['IMPORTANT', 'SHOULD_RESPOND', 'WE_MET', 'PROMOTIONS'];

    if (!filterToggles) return;
    filterToggles.innerHTML = '';

    for (const category of categories) {
      const toggle = document.createElement('label');
      toggle.className = 'filter-toggle';

      const labelSpan = document.createElement('span');
      labelSpan.className = 'filter-toggle-label';

      const dot = document.createElement('span');
      dot.className = 'filter-dot';
      dot.style.backgroundColor = CategoryColors[category];
      labelSpan.appendChild(dot);

      const text = document.createElement('span');
      text.textContent = CategoryLabels[category];
      labelSpan.appendChild(text);

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = currentFilters[category] !== false;
      checkbox.addEventListener('change', function() {
        toggleFilter(category, checkbox.checked);
      });

      toggle.appendChild(labelSpan);
      toggle.appendChild(checkbox);
      filterToggles.appendChild(toggle);
    }
  }

  /**
   * Toggle a filter
   */
  async function toggleFilter(category, isEnabled) {
    currentFilters[category] = isEnabled;

    try {
      await chrome.runtime.sendMessage({
        type: MESSAGES.UPDATE_FILTERS,
        filters: currentFilters
      });
      showToast('Filter updated', 'success');
    } catch (error) {
      console.error('Error updating filter:', error);
      showToast('Failed to update filter', 'error');
    }
  }

  /**
   * Load classification statistics
   */
  async function loadStats() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATS' });

      if (response && response.stats) {
        const stats = response.stats;

        const personalEl = document.querySelector('.stat-personal .stat-count');
        const recruitingEl = document.querySelector('.stat-recruiting .stat-count');
        const salesEl = document.querySelector('.stat-sales .stat-count');
        const otherEl = document.querySelector('.stat-other .stat-count');

        if (personalEl) personalEl.textContent = stats.PERSONAL || 0;
        if (recruitingEl) recruitingEl.textContent = stats.RECRUITING || 0;
        if (salesEl) salesEl.textContent = stats.SALES || 0;
        if (otherEl) otherEl.textContent = stats.OTHER || 0;
        if (totalCountEl) totalCountEl.textContent = stats.total || 0;
      }
    } catch (error) {
      console.error('Error loading stats:', error);
    }
  }

  /**
   * Setup event listeners
   */
  function setupEventListeners() {
    // Clear cache
    if (clearCacheBtn) clearCacheBtn.addEventListener('click', async function() {
      try {
        await chrome.runtime.sendMessage({ type: MESSAGES.CLEAR_CACHE });
        await loadStats();
        showToast('Cache cleared', 'success');
      } catch (error) {
        console.error('Error clearing cache:', error);
        showToast('Failed to clear cache', 'error');
      }
    });

    // Refresh page
    if (refreshBtn) refreshBtn.addEventListener('click', async function() {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0] && tabs[0].url && tabs[0].url.includes('linkedin.com')) {
          // Also reload the tab to get fresh data
          await chrome.tabs.reload(tabs[0].id);
          showToast('Refreshing LinkedIn...', 'success');
        } else {
          showToast('Open LinkedIn messaging first', 'error');
        }
      } catch (error) {
        console.error('Refresh error:', error);
        showToast('Could not refresh - open LinkedIn messaging', 'error');
      }
    });

    // Save user context
    if (saveContextBtn) {
      saveContextBtn.addEventListener('click', saveUserContext);
    }
  }

  /**
   * Show toast message
   */
  function showToast(message, type) {
    type = type || 'info';

    // Remove existing toast
    const existing = document.querySelector('.toast');
    if (existing) {
      existing.remove();
    }

    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(function() {
      toast.remove();
    }, 3000);
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

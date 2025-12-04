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
    GET_API_KEY: 'GET_API_KEY',
    SET_API_KEY: 'SET_API_KEY',
    CLEAR_CACHE: 'CLEAR_CACHE'
  };

  const CategoryColors = {
    SALES: '#ef4444',
    RECRUITING: '#eab308',
    PERSONAL: '#22c55e',
    EVENT: '#3b82f6',
    CONTENT: '#8b5cf6',
    OTHER: '#6b7280'
  };

  const CategoryLabels = {
    SALES: 'Sales',
    RECRUITING: 'Recruiting',
    PERSONAL: 'Personal',
    EVENT: 'Event',
    CONTENT: 'Content',
    OTHER: 'Other'
  };

  const DefaultFilters = {
    SALES: false,
    RECRUITING: true,
    PERSONAL: true,
    EVENT: false,
    CONTENT: true,
    OTHER: true
  };

  // DOM Elements
  let apiStatus, apiForm, apiKeyInput, saveApiKeyBtn, changeApiKeyBtn;
  let filterToggles, clearCacheBtn, refreshBtn, totalCountEl;

  // State
  let currentFilters = { ...DefaultFilters };

  /**
   * Initialize popup
   */
  async function init() {
    // Get DOM elements
    apiStatus = document.getElementById('api-status');
    apiForm = document.getElementById('api-form');
    apiKeyInput = document.getElementById('api-key-input');
    saveApiKeyBtn = document.getElementById('save-api-key');
    changeApiKeyBtn = document.getElementById('change-api-key');
    filterToggles = document.getElementById('filter-toggles');
    clearCacheBtn = document.getElementById('clear-cache');
    refreshBtn = document.getElementById('refresh');
    totalCountEl = document.getElementById('total-count');

    // Check if this is onboarding
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('onboarding') === 'true') {
      document.body.classList.add('onboarding');
    }

    await checkApiKey();
    await loadFilters();
    await loadStats();
    setupEventListeners();
  }

  /**
   * Check if API key is configured
   */
  async function checkApiKey() {
    try {
      const response = await chrome.runtime.sendMessage({ type: MESSAGES.GET_API_KEY });

      if (response && response.hasApiKey) {
        showApiKeyConfigured();
      } else {
        showApiKeyNeeded();
      }
    } catch (error) {
      console.error('Error checking API key:', error);
      showApiKeyNeeded();
    }
  }

  /**
   * Show UI for configured API key
   */
  function showApiKeyConfigured() {
    apiStatus.classList.add('connected');
    apiStatus.classList.remove('disconnected');
    apiStatus.querySelector('.status-text').textContent = 'API Key configured';
    apiForm.classList.add('hidden');
    changeApiKeyBtn.classList.remove('hidden');
  }

  /**
   * Show UI for missing API key
   */
  function showApiKeyNeeded() {
    apiStatus.classList.add('disconnected');
    apiStatus.classList.remove('connected');
    apiStatus.querySelector('.status-text').textContent = 'API Key required';
    apiForm.classList.remove('hidden');
    changeApiKeyBtn.classList.add('hidden');
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
    const categories = ['PERSONAL', 'RECRUITING', 'SALES', 'EVENT', 'CONTENT', 'OTHER'];

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
        const eventEl = document.querySelector('.stat-event .stat-count');
        const contentEl = document.querySelector('.stat-content .stat-count');
        const otherEl = document.querySelector('.stat-other .stat-count');

        if (personalEl) personalEl.textContent = stats.PERSONAL || 0;
        if (recruitingEl) recruitingEl.textContent = stats.RECRUITING || 0;
        if (salesEl) salesEl.textContent = stats.SALES || 0;
        if (eventEl) eventEl.textContent = stats.EVENT || 0;
        if (contentEl) contentEl.textContent = stats.CONTENT || 0;
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
    // Save API key
    saveApiKeyBtn.addEventListener('click', async function() {
      const key = apiKeyInput.value.trim();

      if (!key) {
        showToast('Please enter an API key', 'error');
        return;
      }

      if (!key.startsWith('sk-ant-')) {
        showToast('Invalid API key format', 'error');
        return;
      }

      try {
        await chrome.runtime.sendMessage({
          type: MESSAGES.SET_API_KEY,
          apiKey: key
        });

        showApiKeyConfigured();
        showToast('API key saved!', 'success');
        apiKeyInput.value = '';
      } catch (error) {
        console.error('Error saving API key:', error);
        showToast('Failed to save API key', 'error');
      }
    });

    // Change API key
    changeApiKeyBtn.addEventListener('click', function() {
      showApiKeyNeeded();
    });

    // Clear cache
    clearCacheBtn.addEventListener('click', async function() {
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
    refreshBtn.addEventListener('click', async function() {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0] && tabs[0].url && tabs[0].url.includes('linkedin.com')) {
          await chrome.tabs.sendMessage(tabs[0].id, { type: 'REFRESH' });
          showToast('Refreshing...', 'success');
        } else {
          showToast('Open LinkedIn messaging first', 'error');
        }
      } catch (error) {
        showToast('Could not refresh - open LinkedIn messaging', 'error');
      }
    });
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

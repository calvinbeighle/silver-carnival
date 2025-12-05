/**
 * LinkedIn Inbox Triage - Content Script
 * Injects UI and coordinates message classification
 */

(function() {
  'use strict';

  console.log('[LinkedIn Triage] Content script loaded');

  // ============================================
  // Inject API Interceptor into page context
  // ============================================

  function injectApiInterceptor() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('src/content/api-interceptor.js');
    script.onload = function() {
      console.log('[LinkedIn Triage] API Interceptor injected');
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  // Inject immediately
  injectApiInterceptor();

  // ============================================
  // Listen for intercepted profile data
  // ============================================

  // Store for profiles extracted from API
  let interceptedProfiles = {};
  let conversationProfileMap = {};
  // Store for conversation dynamics (message counts, who initiated, etc.)
  let conversationDynamics = {};

  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (event.data.type !== 'LINKEDIN_TRIAGE_PROFILE_DATA') return;

    console.log('[LinkedIn Triage] Received intercepted profile data:', event.data);

    // Merge new profiles
    if (event.data.profiles) {
      Object.assign(interceptedProfiles, event.data.profiles);
      console.log('[LinkedIn Triage] Total profiles cached:', Object.keys(interceptedProfiles).length);
    }

    // Merge conversation-to-profile mappings
    if (event.data.conversationProfiles) {
      Object.assign(conversationProfileMap, event.data.conversationProfiles);
      console.log('[LinkedIn Triage] Total conversation mappings:', Object.keys(conversationProfileMap).length);

      // Send to background for caching
      chrome.runtime.sendMessage({
        type: MESSAGES.CACHE_CONVERSATION_PROFILES,
        conversationProfiles: event.data.conversationProfiles
      }).catch(() => {});
    }

    // Merge conversation dynamics
    if (event.data.conversationDynamics) {
      Object.assign(conversationDynamics, event.data.conversationDynamics);
      console.log('[LinkedIn Triage] Total conversation dynamics:', Object.keys(conversationDynamics).length);
    }

    // Re-process conversations with new data
    if (Object.keys(event.data.conversationProfiles || {}).length > 0 || Object.keys(event.data.conversationDynamics || {}).length > 0) {
      setTimeout(processConversations, 100);
    }
  });

  // Helper to get profile for a conversation
  function getProfileForConversation(conversationId) {
    const participants = conversationProfileMap[conversationId];
    if (participants && participants.length > 0) {
      // Return the first non-self participant
      // TODO: Could filter out current user
      return participants[0];
    }
    return null;
  }

  // Helper to get dynamics for a conversation
  function getDynamicsForConversation(conversationId) {
    return conversationDynamics[conversationId] || {
      userInitiated: false,
      theirMessageCount: 0,
      userMessageCount: 0
    };
  }

  // ============================================
  // Constants
  // ============================================

  const MESSAGES = {
    CLASSIFY_MESSAGES: 'CLASSIFY_MESSAGES',
    GET_CLASSIFICATIONS: 'GET_CLASSIFICATIONS',
    UPDATE_FILTERS: 'UPDATE_FILTERS',
    GET_FILTERS: 'GET_FILTERS',
    ENRICH_PROFILES: 'ENRICH_PROFILES',
    SET_USER_PROFILE: 'SET_USER_PROFILE',
    GET_USER_PROFILE: 'GET_USER_PROFILE',
    CACHE_CONVERSATION_PROFILES: 'CACHE_CONVERSATION_PROFILES'
  };

  // Multiple selector options for resilience against LinkedIn DOM changes
  const SELECTORS = {
    // Message list containers
    messageListSelectors: [
      '.msg-conversations-container__conversations-list',
      '.msg-conversations-container__convo-item-link',
      '[class*="msg-conversation-list"]',
      '.scaffold-layout__list'
    ],
    // Individual conversation items
    conversationItemSelectors: [
      '.msg-conversation-listitem',
      '.msg-conversation-card',
      '.msg-convo-wrapper',
      'li[class*="msg-conversation"]',
      '.msg-conversations-container__convo-item-link'
    ],
    // Participant name
    nameSelectors: [
      '.msg-conversation-listitem__participant-names',
      '.msg-conversation-card__participant-names',
      '.msg-conversation-listitem__title-row h3',
      '[class*="participant-names"]',
      '.msg-conversation-card__row h3'
    ],
    // Sender title/headline
    titleSelectors: [
      '.msg-conversation-listitem__participant-headline',
      '.msg-conversation-card__participant-headline',
      '[class*="participant-headline"]',
      '.msg-conversation-listitem__subtitle',
      '.msg-s-message-group__meta'
    ],
    // Message preview
    previewSelectors: [
      '.msg-conversation-listitem__message-snippet',
      '.msg-conversation-card__message-snippet',
      '[class*="message-snippet"]',
      '.msg-conversation-card__message-snippet-body'
    ],
    // Timestamp
    timestampSelectors: [
      '.msg-conversation-listitem__time-stamp',
      '.msg-conversation-card__time-stamp',
      'time',
      '[class*="time-stamp"]'
    ],
    // Header for toolbar injection
    headerSelectors: [
      '.msg-conversations-container__title-row',
      '.msg-overlay-list-bubble__header',
      '.msg-conversations-container__header',
      '.scaffold-layout__list-header'
    ]
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

  // ============================================
  // Helper: Find element using multiple selectors
  // ============================================

  function findElement(selectors, parent) {
    parent = parent || document;
    for (const selector of selectors) {
      try {
        const element = parent.querySelector(selector);
        if (element) return element;
      } catch (e) {
        // Invalid selector, skip
      }
    }
    return null;
  }

  function findAllElements(selectors, parent) {
    parent = parent || document;
    for (const selector of selectors) {
      try {
        const elements = parent.querySelectorAll(selector);
        if (elements.length > 0) {
          console.log('[LinkedIn Triage] Found', elements.length, 'elements with selector:', selector);
          return Array.from(elements);
        }
      } catch (e) {
        // Invalid selector, skip
      }
    }
    return [];
  }

  // ============================================
  // Message Parser Functions
  // ============================================

  function parseConversation(conversationElement) {
    try {
      // Get conversation ID and profile URL from link
      const link = conversationElement.querySelector('a[href*="/messaging/thread/"]') ||
                   conversationElement.querySelector('a[href*="messaging"]') ||
                   conversationElement.closest('a[href*="/messaging/thread/"]');
      let conversationId = null;

      if (link) {
        const href = link.getAttribute('href');
        const match = href.match(/\/messaging\/thread\/([^/?]+)/);
        if (match) {
          conversationId = match[1];
        }
      }

      // Fallback ID generation
      if (!conversationId) {
        conversationId = conversationElement.getAttribute('data-conversation-id') ||
          conversationElement.getAttribute('data-entity-urn') ||
          conversationElement.id ||
          generateIdFromContent(conversationElement);
      }

      // Get profile data from intercepted API responses
      let profileUrl = null;
      let senderHeadline = '';
      const interceptedProfile = getProfileForConversation(conversationId);
      if (interceptedProfile) {
        profileUrl = interceptedProfile.profileUrl;
        senderHeadline = interceptedProfile.headline || '';
        console.log('[LinkedIn Triage] Found intercepted profile for', conversationId, ':', interceptedProfile);
      }

      // Get participant name
      const nameElement = findElement(SELECTORS.nameSelectors, conversationElement);
      const participantName = nameElement ? nameElement.textContent.trim() : 'Unknown';

      // Get sender's title/headline - prefer intercepted data
      let senderTitle = senderHeadline; // From intercepted API data

      // Fallback to DOM extraction if no intercepted data
      if (!senderTitle) {
        const titleElement = findElement(SELECTORS.titleSelectors, conversationElement);
        senderTitle = titleElement ? titleElement.textContent.trim() : '';
      }

      // Also try to extract from aria-label or other attributes
      if (!senderTitle) {
        const ariaLabel = conversationElement.getAttribute('aria-label') || '';
        // LinkedIn often includes title in aria-label like "Conversation with Name, Title"
        const titleMatch = ariaLabel.match(/,\s*(.+?)(?:\s*\d+\s*(?:new\s*)?message|$)/i);
        if (titleMatch) {
          senderTitle = titleMatch[1].trim();
        }
      }

      // Get message preview
      const previewElement = findElement(SELECTORS.previewSelectors, conversationElement);
      const lastMessagePreview = previewElement ? previewElement.textContent.trim() : '';

      // Detect if the last message was sent by the current user
      // LinkedIn formats it as "You: message" or "Name: message" where Name is the current user
      const userName = getCurrentUserName();
      let lastMessageByUser = false;
      let userMessageCount = 0;
      let theirMessageCount = 0;

      if (userName && lastMessagePreview) {
        // Check if preview starts with "You:" or the user's name followed by ":"
        const youPattern = /^You:\s/i;
        const namePattern = new RegExp('^' + userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s', 'i');

        if (youPattern.test(lastMessagePreview) || namePattern.test(lastMessagePreview)) {
          lastMessageByUser = true;
          userMessageCount = 1; // At least one message from user
          console.log('[LinkedIn Triage] Detected: User sent last message to', participantName);
        } else {
          theirMessageCount = 1; // Last message from them
        }
      }

      // Check if this is an InMail (sponsored/paid message)
      const isInMail = conversationElement.textContent.toLowerCase().includes('inmail') ||
        conversationElement.querySelector('[class*="inmail"]') !== null ||
        conversationElement.querySelector('[class*="sponsored"]') !== null;

      // Get timestamp
      const timestampElement = findElement(SELECTORS.timestampSelectors, conversationElement);
      const timestampText = timestampElement ? timestampElement.textContent.trim() : '';

      // Check if 1st connection (look for degree indicator)
      const isFirstConnection = conversationElement.textContent.includes('1st') ||
        conversationElement.querySelector('[class*="degree"]') !== null;

      // Check if unread
      const isUnread = conversationElement.classList.contains('msg-conversation-listitem--unread') ||
        conversationElement.querySelector('.notification-badge') !== null ||
        conversationElement.querySelector('[class*="unread"]') !== null;

      return {
        conversationId,
        participantName,
        profileUrl,
        senderTitle,
        lastMessagePreview,
        fullMessage: lastMessagePreview,
        isFirstConnection,
        isInMail,
        timestamp: parseTimestamp(timestampText),
        isUnread,
        lastMessageByUser,
        userMessageCount,
        theirMessageCount,
        element: conversationElement
      };
    } catch (error) {
      console.error('[LinkedIn Triage] Error parsing conversation:', error);
      return null;
    }
  }

  function getConversationElements() {
    // First, try to find conversation items directly
    let elements = findAllElements(SELECTORS.conversationItemSelectors);

    if (elements.length > 0) {
      return elements;
    }

    // Fallback: find the list container and get its children
    const container = findElement(SELECTORS.messageListSelectors);
    if (container) {
      console.log('[LinkedIn Triage] Found container:', container.className);
      // Get all list items
      const listItems = container.querySelectorAll('li');
      if (listItems.length > 0) {
        console.log('[LinkedIn Triage] Found', listItems.length, 'list items in container');
        return Array.from(listItems);
      }
    }

    // Last resort: look for any element with conversation-related classes
    const fallback = document.querySelectorAll('[class*="conversation"], [class*="convo"]');
    console.log('[LinkedIn Triage] Fallback found', fallback.length, 'elements');
    return Array.from(fallback);
  }

  function parseAllConversations() {
    const elements = getConversationElements();
    const conversations = [];

    console.log('[LinkedIn Triage] Parsing', elements.length, 'conversation elements');

    for (const element of elements) {
      const conversation = parseConversation(element);
      if (conversation && conversation.conversationId && conversation.participantName !== 'Unknown') {
        conversations.push(conversation);
      }
    }

    console.log('[LinkedIn Triage] Successfully parsed', conversations.length, 'conversations');
    return conversations;
  }

  function generateIdFromContent(element) {
    const text = element.textContent || '';
    let hash = 0;
    for (let i = 0; i < Math.min(text.length, 100); i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return 'generated-' + Math.abs(hash);
  }

  function parseTimestamp(text) {
    const now = new Date();
    if (!text) return now;

    text = text.toLowerCase().trim();

    const relativeMatch = text.match(/(\d+)\s*(m|h|d|w|mo|y)/);
    if (relativeMatch) {
      const value = parseInt(relativeMatch[1]);
      const unit = relativeMatch[2];

      const msPerUnit = {
        'm': 60 * 1000,
        'h': 60 * 60 * 1000,
        'd': 24 * 60 * 60 * 1000,
        'w': 7 * 24 * 60 * 60 * 1000,
        'mo': 30 * 24 * 60 * 60 * 1000,
        'y': 365 * 24 * 60 * 60 * 1000
      };

      return new Date(now.getTime() - value * (msPerUnit[unit] || 0));
    }

    return now;
  }

  // ============================================
  // User Profile Extraction
  // ============================================

  // Store current user's name for message sender detection
  let currentUserName = null;

  function getCurrentUserName() {
    if (currentUserName) return currentUserName;

    // Try to get from the "Me" button
    const meButton = document.querySelector('.global-nav__me-photo');
    if (meButton) {
      currentUserName = meButton.getAttribute('alt');
      console.log('[LinkedIn Triage] Detected current user name:', currentUserName);
      return currentUserName;
    }

    // Try other selectors
    const nameSelectors = [
      '.global-nav__me .t-14',
      '.global-nav__me-content .t-bold',
      '[data-control-name="nav.settings_view_profile"] .t-bold'
    ];

    for (const selector of nameSelectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent.trim()) {
        currentUserName = el.textContent.trim();
        console.log('[LinkedIn Triage] Detected current user name from selector:', currentUserName);
        return currentUserName;
      }
    }

    return null;
  }

  function extractCurrentUserProfile() {
    // Try to get the user's profile URL from the "Me" dropdown
    // The profile link is in the nav menu
    const meButton = document.querySelector('.global-nav__me-photo');
    if (meButton) {
      const userName = meButton.getAttribute('alt');
      currentUserName = userName; // Store it
      console.log('[LinkedIn Triage] Found current user:', userName);
    }

    // Look for profile link in the dropdown or nav
    const profileLinks = [
      // Direct profile link in nav
      document.querySelector('a[href*="/in/"][data-control-name="identity_profile_photo"]'),
      // Profile link in me menu
      document.querySelector('.global-nav__me a[href*="/in/"]'),
      // Any link that goes to /in/ in the header area
      document.querySelector('header a[href*="/in/"]'),
      document.querySelector('nav a[href*="/in/"]'),
      // Fallback: look in the global nav area
      document.querySelector('.global-nav a[href*="/in/"]')
    ];

    for (const link of profileLinks) {
      if (link) {
        const href = link.getAttribute('href');
        const match = href.match(/\/in\/([^/?]+)/);
        if (match) {
          return 'https://www.linkedin.com/in/' + match[1];
        }
      }
    }

    // Alternative: Try to find it from any profile-related element
    const allProfileLinks = document.querySelectorAll('a[href*="/in/"]');
    for (const link of allProfileLinks) {
      const href = link.getAttribute('href');
      // Skip other people's profiles (in messaging, etc)
      if (href.includes('/in/') && link.closest('.global-nav, header, nav')) {
        const match = href.match(/\/in\/([^/?]+)/);
        if (match) {
          return 'https://www.linkedin.com/in/' + match[1];
        }
      }
    }

    return null;
  }

  async function sendUserProfileToBackground() {
    const profileUrl = extractCurrentUserProfile();
    if (profileUrl) {
      console.log('[LinkedIn Triage] Sending user profile to background:', profileUrl);
      try {
        await chrome.runtime.sendMessage({
          type: MESSAGES.SET_USER_PROFILE,
          profileUrl: profileUrl
        });
      } catch (error) {
        console.error('[LinkedIn Triage] Error sending user profile:', error);
      }
    } else {
      console.log('[LinkedIn Triage] Could not find current user profile URL');
    }
  }

  // ============================================
  // Main Content Script Logic
  // ============================================

  let currentFilters = { ...DefaultFilters };
  let classifications = {};
  let isInitialized = false;
  let pendingClassifications = new Set();
  let retryCount = 0;
  const MAX_RETRIES = 10;

  async function init() {
    if (isInitialized) return;

    console.log('[LinkedIn Triage] Initializing...');

    await loadSavedData();

    // Extract and send current user's profile for context
    await sendUserProfileToBackground();

    // Wait for LinkedIn to fully load with retries
    const loaded = await waitForLinkedInLoad();
    if (!loaded) {
      console.warn('[LinkedIn Triage] Could not find message list after retries');
      return;
    }

    isInitialized = true;

    // Inject the filter toolbar
    injectFilterToolbar();

    // Process initial conversations
    processConversations();

    // Watch for new conversations
    observeConversationList();

    // Watch for URL changes (LinkedIn is a SPA)
    observeUrlChanges();

    console.log('[LinkedIn Triage] Initialized successfully');
  }

  async function waitForLinkedInLoad() {
    return new Promise((resolve) => {
      const check = () => {
        // Look for any conversation elements
        const conversations = getConversationElements();
        const container = findElement(SELECTORS.messageListSelectors);

        console.log('[LinkedIn Triage] Checking for LinkedIn load... Found', conversations.length, 'conversations, container:', !!container);

        if (conversations.length > 0 || container) {
          resolve(true);
        } else if (retryCount < MAX_RETRIES) {
          retryCount++;
          setTimeout(check, 1000);
        } else {
          resolve(false);
        }
      };

      // Start checking after a short delay
      setTimeout(check, 500);
    });
  }

  async function loadSavedData() {
    try {
      const response = await chrome.runtime.sendMessage({ type: MESSAGES.GET_FILTERS });
      if (response && response.filters) {
        currentFilters = response.filters;
        console.log('[LinkedIn Triage] Loaded filters:', currentFilters);
      }

      const classResponse = await chrome.runtime.sendMessage({ type: MESSAGES.GET_CLASSIFICATIONS });
      if (classResponse && classResponse.classifications) {
        classifications = classResponse.classifications;
        console.log('[LinkedIn Triage] Loaded', Object.keys(classifications).length, 'cached classifications');
      }

      // Load cached conversation profiles from API interception
      const profileResponse = await chrome.runtime.sendMessage({ type: MESSAGES.GET_CONVERSATION_PROFILES });
      if (profileResponse && profileResponse.conversationProfiles) {
        conversationProfileMap = profileResponse.conversationProfiles;
        console.log('[LinkedIn Triage] Loaded', Object.keys(conversationProfileMap).length, 'cached conversation profiles');
      }
    } catch (error) {
      console.error('[LinkedIn Triage] Error loading saved data:', error);
    }
  }

  async function processConversations() {
    const conversations = parseAllConversations();
    const unclassified = [];

    console.log('[LinkedIn Triage] Processing', conversations.length, 'conversations');

    for (const conversation of conversations) {
      const existing = classifications[conversation.conversationId];

      if (existing) {
        applyClassificationUI(conversation.element, existing);
        applyFilterVisibility(conversation.element, existing.category);
      } else if (!pendingClassifications.has(conversation.conversationId)) {
        unclassified.push(conversation);
        pendingClassifications.add(conversation.conversationId);
        applyLoadingUI(conversation.element);
      }
    }

    if (unclassified.length > 0) {
      console.log('[LinkedIn Triage] Requesting classification for', unclassified.length, 'messages');
      requestClassification(unclassified);
    }
  }

  async function requestClassification(conversations) {
    const messagesToClassify = conversations.map(function(c) {
      // Get conversation dynamics from intercepted API data (may be empty)
      const dynamics = getDynamicsForConversation(c.conversationId);

      // Prefer DOM-detected values over API interceptor values
      // DOM detection checks if preview starts with "You:" or user's name
      const userMsgCount = c.userMessageCount || dynamics.userMessageCount || 0;
      const theirMsgCount = c.theirMessageCount || dynamics.theirMessageCount || 0;
      const lastByUser = c.lastMessageByUser || false;

      // If user sent the last message, they've definitely sent at least one
      const effectiveUserMsgCount = lastByUser ? Math.max(userMsgCount, 1) : userMsgCount;

      console.log('[LinkedIn Triage] Dynamics for', c.participantName,
        '- userMsgs:', effectiveUserMsgCount, 'theirMsgs:', theirMsgCount, 'lastByUser:', lastByUser);

      return {
        conversationId: c.conversationId,
        participantName: c.participantName,
        profileUrl: c.profileUrl || null,
        senderTitle: c.senderTitle || '',
        message: c.lastMessagePreview,
        isFirstConnection: c.isFirstConnection,
        isInMail: c.isInMail || false,
        // Include conversation dynamics for better classification
        userInitiated: dynamics.userInitiated || lastByUser, // If user sent last, likely initiated or engaged
        theirMessageCount: theirMsgCount,
        userMessageCount: effectiveUserMsgCount,
        lastMessageByUser: lastByUser
      };
    });

    try {
      const response = await chrome.runtime.sendMessage({
        type: MESSAGES.CLASSIFY_MESSAGES,
        messages: messagesToClassify
      });

      if (response && response.classifications) {
        Object.assign(classifications, response.classifications);

        for (const conversation of conversations) {
          const classification = response.classifications[conversation.conversationId];
          if (classification) {
            applyClassificationUI(conversation.element, classification);
            applyFilterVisibility(conversation.element, classification.category);
          }
          pendingClassifications.delete(conversation.conversationId);
        }

        console.log('[LinkedIn Triage] Applied classifications to', conversations.length, 'conversations');
      }
    } catch (error) {
      console.error('[LinkedIn Triage] Classification error:', error);
      for (const conversation of conversations) {
        removeLoadingUI(conversation.element);
        pendingClassifications.delete(conversation.conversationId);
      }
    }
  }

  function applyClassificationUI(element, classification) {
    if (!element || !classification) return;

    // Remove existing indicator if any
    const existing = element.querySelector('.li-triage-indicator');
    if (existing) {
      existing.remove();
    }

    // Create new indicator
    const indicator = document.createElement('div');
    indicator.className = 'li-triage-indicator';
    indicator.setAttribute('data-category', classification.category);
    indicator.setAttribute('data-priority', classification.priority);

    // Color dot
    const dot = document.createElement('span');
    dot.className = 'li-triage-dot';
    dot.style.backgroundColor = CategoryColors[classification.category] || CategoryColors.OTHER;
    indicator.appendChild(dot);

    // Priority stars
    const priority = document.createElement('span');
    priority.className = 'li-triage-priority';
    priority.textContent = getPriorityIndicator(classification.priority);
    indicator.appendChild(priority);

    // Tooltip - show category and priority
    const intentLabel = classification.category;
    indicator.title = intentLabel + ': ' + classification.summary + '\n' +
      'Priority: ' + classification.priority + '/10 (' + getPriorityLabel(classification.priority) + ')' +
      (classification.signals && classification.signals.length > 0 ? '\nSignals: ' + classification.signals.join(', ') : '');

    // Insert at the beginning of the conversation item
    element.style.position = 'relative';
    element.insertBefore(indicator, element.firstChild);

    // Add hover tooltip
    createHoverTooltip(element, classification);
  }

  function createHoverTooltip(element, classification) {
    const existingTooltip = element.querySelector('.li-triage-tooltip');
    if (existingTooltip) {
      existingTooltip.remove();
    }

    const tooltip = document.createElement('div');
    tooltip.className = 'li-triage-tooltip';

    const categoryLabel = classification.category;
    const signalsHtml = classification.signals && classification.signals.length > 0
      ? '<div class="li-triage-tooltip-signals">' + classification.signals.map(s => '<span class="li-triage-signal">' + escapeHtml(s) + '</span>').join('') + '</div>'
      : '';

    tooltip.innerHTML =
      '<div class="li-triage-tooltip-header" style="border-left: 3px solid ' + CategoryColors[classification.category] + '">' +
        '<span class="li-triage-tooltip-category">' + escapeHtml(categoryLabel) + '</span>' +
        '<span class="li-triage-tooltip-priority">' + getPriorityIndicator(classification.priority) + '</span>' +
      '</div>' +
      '<div class="li-triage-tooltip-summary">' + escapeHtml(classification.summary) + '</div>' +
      signalsHtml +
      '<div class="li-triage-tooltip-meta">Priority: ' + classification.priority + '/10</div>';

    element.appendChild(tooltip);
    element.classList.add('li-triage-has-tooltip');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function applyLoadingUI(element) {
    if (!element) return;

    const existing = element.querySelector('.li-triage-indicator');
    if (existing) return;

    const indicator = document.createElement('div');
    indicator.className = 'li-triage-indicator li-triage-loading';

    const dot = document.createElement('span');
    dot.className = 'li-triage-dot li-triage-dot-loading';
    indicator.appendChild(dot);

    element.style.position = 'relative';
    element.insertBefore(indicator, element.firstChild);
  }

  function removeLoadingUI(element) {
    if (!element) return;
    const loading = element.querySelector('.li-triage-loading');
    if (loading) {
      loading.remove();
    }
  }

  function applyFilterVisibility(element, category) {
    if (!element) return;
    const isVisible = currentFilters[category] !== false;
    element.classList.toggle('li-triage-hidden', !isVisible);
  }

  function getPriorityIndicator(priority) {
    // Show stars based on priority (1-10 scale, higher = more important)
    const p = Math.min(10, Math.max(1, priority));
    const starCount = Math.ceil(p / 2); // 1-2 = 1 star, 3-4 = 2 stars, etc.
    return '★'.repeat(starCount) + '☆'.repeat(5 - starCount);
  }

  function getPriorityLabel(priority) {
    const p = Math.min(10, Math.max(1, priority));
    if (p >= 9) return 'Very High';
    if (p >= 7) return 'High';
    if (p >= 5) return 'Medium';
    if (p >= 3) return 'Low';
    return 'Very Low';
  }

  function injectFilterToolbar() {
    if (document.querySelector('.li-triage-toolbar')) {
      console.log('[LinkedIn Triage] Toolbar already exists');
      return;
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'li-triage-toolbar';

    const categories = ['IMPORTANT', 'SHOULD_RESPOND', 'WE_MET', 'PROMOTIONS'];

    for (const category of categories) {
      const button = document.createElement('button');
      button.className = 'li-triage-filter-btn';
      button.setAttribute('data-category', category);

      const isActive = currentFilters[category] !== false;
      button.classList.toggle('li-triage-filter-active', isActive);

      const dot = document.createElement('span');
      dot.className = 'li-triage-filter-dot';
      dot.style.backgroundColor = CategoryColors[category];
      button.appendChild(dot);

      const label = document.createElement('span');
      label.textContent = CategoryLabels[category];
      button.appendChild(label);

      const checkmark = document.createElement('span');
      checkmark.className = 'li-triage-filter-check';
      checkmark.textContent = isActive ? '\u2713' : '\u2717';
      button.appendChild(checkmark);

      button.addEventListener('click', function() {
        toggleFilter(category, button);
      });

      toolbar.appendChild(button);
    }

    // Bulk action button
    const bulkActions = document.createElement('div');
    bulkActions.className = 'li-triage-bulk-actions';

    const archivePromosBtn = document.createElement('button');
    archivePromosBtn.className = 'li-triage-bulk-btn';
    archivePromosBtn.textContent = 'Hide Promotions';
    archivePromosBtn.addEventListener('click', function() {
      bulkHideCategory('PROMOTIONS');
    });
    bulkActions.appendChild(archivePromosBtn);

    toolbar.appendChild(bulkActions);

    // Find insertion point - try multiple locations
    let inserted = false;

    // Try finding header
    const header = findElement(SELECTORS.headerSelectors);
    if (header) {
      header.insertAdjacentElement('afterend', toolbar);
      inserted = true;
      console.log('[LinkedIn Triage] Injected toolbar after header');
    }

    // Fallback: find message list and insert before it
    if (!inserted) {
      const list = findElement(SELECTORS.messageListSelectors);
      if (list) {
        list.insertAdjacentElement('beforebegin', toolbar);
        inserted = true;
        console.log('[LinkedIn Triage] Injected toolbar before message list');
      }
    }

    // Last resort: prepend to main content area
    if (!inserted) {
      const main = document.querySelector('main') || document.querySelector('.scaffold-layout__main');
      if (main) {
        main.insertBefore(toolbar, main.firstChild);
        inserted = true;
        console.log('[LinkedIn Triage] Injected toolbar at start of main');
      }
    }

    if (!inserted) {
      console.warn('[LinkedIn Triage] Could not find insertion point for toolbar');
    }
  }

  async function toggleFilter(category, button) {
    currentFilters[category] = !currentFilters[category];
    const isActive = currentFilters[category];

    button.classList.toggle('li-triage-filter-active', isActive);
    const check = button.querySelector('.li-triage-filter-check');
    if (check) {
      check.textContent = isActive ? '\u2713' : '\u2717';
    }

    const conversations = parseAllConversations();
    for (const conversation of conversations) {
      const classification = classifications[conversation.conversationId];
      if (classification) {
        applyFilterVisibility(conversation.element, classification.category);
      }
    }

    try {
      await chrome.runtime.sendMessage({
        type: MESSAGES.UPDATE_FILTERS,
        filters: currentFilters
      });
    } catch (error) {
      console.error('[LinkedIn Triage] Error saving filters:', error);
    }
  }

  async function bulkHideCategory(category) {
    currentFilters[category] = false;

    const button = document.querySelector('.li-triage-filter-btn[data-category="' + category + '"]');
    if (button) {
      button.classList.remove('li-triage-filter-active');
      const check = button.querySelector('.li-triage-filter-check');
      if (check) {
        check.textContent = '\u2717';
      }
    }

    const conversations = parseAllConversations();
    for (const conversation of conversations) {
      const classification = classifications[conversation.conversationId];
      if (classification && classification.category === category) {
        applyFilterVisibility(conversation.element, category);
      }
    }

    try {
      await chrome.runtime.sendMessage({
        type: MESSAGES.UPDATE_FILTERS,
        filters: currentFilters
      });
    } catch (error) {
      console.error('[LinkedIn Triage] Error saving filters:', error);
    }
  }

  function observeConversationList() {
    const observer = new MutationObserver(function(mutations) {
      let shouldProcess = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          shouldProcess = true;
          break;
        }
      }

      if (shouldProcess) {
        // Debounce processing
        clearTimeout(observeConversationList.timeout);
        observeConversationList.timeout = setTimeout(function() {
          processConversations();
        }, 500);
      }
    });

    // Observe the entire body for changes (LinkedIn is a SPA)
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    console.log('[LinkedIn Triage] Started observing for changes');
  }

  function observeUrlChanges() {
    let lastUrl = location.href;

    const observer = new MutationObserver(function() {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        console.log('[LinkedIn Triage] URL changed to:', lastUrl);

        if (location.href.includes('/messaging')) {
          // Reset and re-initialize
          isInitialized = false;
          retryCount = 0;
          setTimeout(function() {
            init();
          }, 1000);
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Listen for messages from popup/background
  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    console.log('[LinkedIn Triage] Received message:', message.type);

    if (message.type === 'REFRESH') {
      processConversations();
      sendResponse({ success: true });
    } else if (message.type === 'FILTERS_UPDATED') {
      currentFilters = message.filters;
      const conversations = parseAllConversations();
      for (const conversation of conversations) {
        const classification = classifications[conversation.conversationId];
        if (classification) {
          applyFilterVisibility(conversation.element, classification.category);
        }
      }
      sendResponse({ success: true });
    }
    return true;
  });

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Small delay to ensure LinkedIn's React has rendered
    setTimeout(init, 1000);
  }

})();

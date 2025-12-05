/**
 * LinkedIn API Interceptor
 * Intercepts fetch/XHR calls to LinkedIn's messaging API
 * Extracts profile URLs from API responses
 */

(function() {
  'use strict';

  console.log('[LinkedIn Triage] API Interceptor loaded');

  // Store for intercepted profile data
  const profileDataStore = {};

  // Patterns to match LinkedIn messaging API endpoints
  const MESSAGING_API_PATTERNS = [
    /voyager\/api\/messaging\/conversations/,
    /voyager\/api\/messaging\/convos/,
    /voyagerMessagingDashConversations/,
    /voyagerMessagingDashMessengerMessages/,
    /graphql.*messaging/i,
    /messaging\/conversations/
  ];

  function isMessagingApiUrl(url) {
    return MESSAGING_API_PATTERNS.some(pattern => pattern.test(url));
  }

  // Extract profile data from LinkedIn API response
  function extractProfileData(data) {
    const profiles = {};

    try {
      // LinkedIn API responses can be nested in various ways
      // We need to recursively search for profile/member data
      const searchObject = (obj, path = '') => {
        if (!obj || typeof obj !== 'object') return;

        // Look for member/profile URNs and associated data
        if (obj.entityUrn && typeof obj.entityUrn === 'string') {
          const urn = obj.entityUrn;

          // Match member URNs like "urn:li:fsd_profile:ACoAABCD1234"
          const memberMatch = urn.match(/urn:li:(?:fsd_profile|member|fs_miniProfile):([A-Za-z0-9_-]+)/);
          if (memberMatch) {
            const memberId = memberMatch[1];
            const profileUrl = `https://www.linkedin.com/in/${memberId}`;

            profiles[memberId] = {
              memberId,
              profileUrl,
              firstName: obj.firstName || '',
              lastName: obj.lastName || '',
              fullName: obj.firstName && obj.lastName ? `${obj.firstName} ${obj.lastName}` : (obj.name || ''),
              headline: obj.headline || obj.occupation || '',
              publicIdentifier: obj.publicIdentifier || obj.vanityName || memberId
            };

            console.log('[LinkedIn Triage] Found profile:', profiles[memberId]);
          }
        }

        // Check for conversation participant data
        if (obj.participants && Array.isArray(obj.participants)) {
          obj.participants.forEach(p => searchObject(p));
        }

        // Check for miniProfile which contains headline
        if (obj.miniProfile) {
          searchObject(obj.miniProfile);
        }

        // Check for member data
        if (obj.member) {
          searchObject(obj.member);
        }

        // Recursively search arrays and objects
        if (Array.isArray(obj)) {
          obj.forEach((item, i) => searchObject(item, `${path}[${i}]`));
        } else {
          Object.keys(obj).forEach(key => {
            if (typeof obj[key] === 'object') {
              searchObject(obj[key], `${path}.${key}`);
            }
          });
        }
      };

      searchObject(data);
    } catch (error) {
      console.error('[LinkedIn Triage] Error extracting profile data:', error);
    }

    return profiles;
  }

  // Extract conversation-to-profile mapping
  function extractConversationProfiles(data) {
    const conversationProfiles = {};

    try {
      const searchForConversations = (obj) => {
        if (!obj || typeof obj !== 'object') return;

        // Look for conversation objects with participants
        if (obj.entityUrn && obj.entityUrn.includes('conversation')) {
          const convMatch = obj.entityUrn.match(/urn:li:(?:fs_conversation|msg_conversation):([^,\)]+)/);
          if (convMatch && obj.participants) {
            const convId = convMatch[1];
            const participants = [];

            // Extract participant info
            const extractParticipant = (p) => {
              if (p.entityUrn) {
                const memberMatch = p.entityUrn.match(/urn:li:(?:fsd_profile|member|fs_miniProfile):([A-Za-z0-9_-]+)/);
                if (memberMatch) {
                  participants.push({
                    memberId: memberMatch[1],
                    profileUrl: `https://www.linkedin.com/in/${memberMatch[1]}`,
                    name: p.firstName ? `${p.firstName} ${p.lastName || ''}`.trim() : '',
                    headline: p.headline || p.occupation || ''
                  });
                }
              }
              // Check nested structures
              if (p.member) extractParticipant(p.member);
              if (p.miniProfile) extractParticipant(p.miniProfile);
              if (p['com.linkedin.voyager.messaging.MessagingMember']) {
                extractParticipant(p['com.linkedin.voyager.messaging.MessagingMember']);
              }
            };

            if (Array.isArray(obj.participants)) {
              obj.participants.forEach(extractParticipant);
            }

            if (participants.length > 0) {
              conversationProfiles[convId] = participants;
              console.log('[LinkedIn Triage] Mapped conversation', convId, 'to participants:', participants);
            }
          }
        }

        // Recursively search
        if (Array.isArray(obj)) {
          obj.forEach(searchForConversations);
        } else {
          Object.values(obj).forEach(val => {
            if (typeof val === 'object') searchForConversations(val);
          });
        }
      };

      searchForConversations(data);
    } catch (error) {
      console.error('[LinkedIn Triage] Error extracting conversation profiles:', error);
    }

    return conversationProfiles;
  }

  // Extract conversation dynamics (who initiated, message counts)
  function extractConversationDynamics(data, currentUserUrn) {
    const dynamics = {};

    try {
      const searchForMessages = (obj, convId = null) => {
        if (!obj || typeof obj !== 'object') return;

        // Look for conversation with messages
        if (obj.entityUrn && obj.entityUrn.includes('conversation')) {
          const convMatch = obj.entityUrn.match(/urn:li:(?:fs_conversation|msg_conversation):([^,\)]+)/);
          if (convMatch) {
            convId = convMatch[1];
            dynamics[convId] = dynamics[convId] || {
              theirMessageCount: 0,
              userMessageCount: 0,
              userInitiated: false,
              firstMessageSender: null
            };
          }
        }

        // Look for messages array
        if (obj.messages && Array.isArray(obj.messages) && convId) {
          const messages = obj.messages;
          let firstMessage = null;

          for (const msg of messages) {
            const senderUrn = msg.sender?.entityUrn || msg.actor?.entityUrn ||
              msg['*sender'] || msg['*actor'] || '';

            // Check if this is the user's message
            const isUserMessage = currentUserUrn && senderUrn.includes(currentUserUrn);

            if (isUserMessage) {
              dynamics[convId].userMessageCount++;
            } else if (senderUrn) {
              dynamics[convId].theirMessageCount++;
            }

            // Track first message (messages are usually reverse chronological)
            if (!firstMessage || (msg.createdAt && msg.createdAt < (firstMessage.createdAt || Infinity))) {
              firstMessage = msg;
              dynamics[convId].firstMessageSender = senderUrn;
              dynamics[convId].userInitiated = isUserMessage;
            }
          }

          console.log('[LinkedIn Triage] Extracted dynamics for', convId, ':', dynamics[convId]);
        }

        // Look for events array (alternative structure)
        if (obj.events && Array.isArray(obj.events) && convId) {
          for (const event of obj.events) {
            if (event.eventContent && event.eventContent['com.linkedin.voyager.messaging.event.MessageEvent']) {
              const msgEvent = event.eventContent['com.linkedin.voyager.messaging.event.MessageEvent'];
              const senderUrn = event.from?.entityUrn || event['*from'] || '';
              const isUserMessage = currentUserUrn && senderUrn.includes(currentUserUrn);

              if (isUserMessage) {
                dynamics[convId].userMessageCount++;
              } else if (senderUrn) {
                dynamics[convId].theirMessageCount++;
              }
            }
          }
        }

        // Recursively search
        if (Array.isArray(obj)) {
          obj.forEach(item => searchForMessages(item, convId));
        } else {
          Object.values(obj).forEach(val => {
            if (typeof val === 'object') searchForMessages(val, convId);
          });
        }
      };

      searchForMessages(data);
    } catch (error) {
      console.error('[LinkedIn Triage] Error extracting conversation dynamics:', error);
    }

    return dynamics;
  }

  // Try to get current user's URN from the page
  function getCurrentUserUrn() {
    // LinkedIn stores user info in various places
    try {
      // Try to find in page scripts
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const content = script.textContent;
        if (content.includes('publicIdentifier') || content.includes('fsd_profile')) {
          const match = content.match(/urn:li:(?:fsd_profile|member):([A-Za-z0-9_-]+)/);
          if (match) {
            return match[1];
          }
        }
      }
    } catch (e) {}
    return null;
  }

  const currentUserUrn = getCurrentUserUrn();
  console.log('[LinkedIn Triage] Current user URN:', currentUserUrn);

  // Send extracted data to content script
  function sendProfileData(profiles, conversationProfiles, dynamics) {
    if (Object.keys(profiles).length > 0 || Object.keys(conversationProfiles).length > 0 || Object.keys(dynamics || {}).length > 0) {
      window.postMessage({
        type: 'LINKEDIN_TRIAGE_PROFILE_DATA',
        profiles,
        conversationProfiles,
        conversationDynamics: dynamics || {}
      }, '*');
    }
  }

  // Intercept fetch
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = args[0] instanceof Request ? args[0].url : args[0];

    const response = await originalFetch.apply(this, args);

    if (isMessagingApiUrl(url)) {
      console.log('[LinkedIn Triage] Intercepted messaging API call:', url);

      // Clone the response so we can read it without consuming the original
      const clonedResponse = response.clone();

      try {
        const data = await clonedResponse.json();
        const profiles = extractProfileData(data);
        const conversationProfiles = extractConversationProfiles(data);
        const dynamics = extractConversationDynamics(data, currentUserUrn);
        sendProfileData(profiles, conversationProfiles, dynamics);
      } catch (e) {
        // Response might not be JSON, that's fine
      }
    }

    return response;
  };

  // Intercept XMLHttpRequest
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._liTriageUrl = url;
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    if (isMessagingApiUrl(this._liTriageUrl)) {
      console.log('[LinkedIn Triage] Intercepted XHR messaging API call:', this._liTriageUrl);

      this.addEventListener('load', function() {
        try {
          const data = JSON.parse(this.responseText);
          const profiles = extractProfileData(data);
          const conversationProfiles = extractConversationProfiles(data);
          const dynamics = extractConversationDynamics(data, currentUserUrn);
          sendProfileData(profiles, conversationProfiles, dynamics);
        } catch (e) {
          // Response might not be JSON
        }
      });
    }

    return originalXHRSend.apply(this, args);
  };

  console.log('[LinkedIn Triage] API Interceptor ready - fetch and XHR patched');
})();

/**
 * LinkedIn Inbox Triage - Background Service Worker
 */

// ============================================
// Constants
// ============================================

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-3-haiku-20240307';
const MAX_TOKENS = 1024;
const BATCH_SIZE = 10;
const MAX_MESSAGE_LENGTH = 2000;
const CACHE_EXPIRY_DAYS = 7;

const MESSAGES = {
  CLASSIFY_MESSAGES: 'CLASSIFY_MESSAGES',
  GET_CLASSIFICATIONS: 'GET_CLASSIFICATIONS',
  UPDATE_FILTERS: 'UPDATE_FILTERS',
  GET_FILTERS: 'GET_FILTERS',
  GET_API_KEY: 'GET_API_KEY',
  SET_API_KEY: 'SET_API_KEY',
  CLEAR_CACHE: 'CLEAR_CACHE',
  GET_USER_CONTEXT: 'GET_USER_CONTEXT',
  SET_USER_CONTEXT: 'SET_USER_CONTEXT'
};

const DefaultFilters = {
  SALES: false,
  RECRUITING: true,
  PERSONAL: true,
  EVENT: false,
  CONTENT: true,
  OTHER: true
};

// This will be built dynamically with user context
function buildClassificationPrompt(userContext) {
  return `You are an expert at categorizing LinkedIn messages for busy professionals who receive hundreds of messages daily. Your job is to help them quickly identify what's worth their time.

## USER CONTEXT (IMPORTANT - use this to determine relevance):
${userContext || 'No specific context provided. Use general professional relevance.'}

## CATEGORIES:
- SALES: Cold outreach trying to sell products/services. Key signals:
  * Sender works at a company selling B2B services (SaaS, consulting, marketing, recruiting agencies, etc.)
  * Message mentions "helping companies like yours", "quick call", "demo", "solution"
  * Generic compliments followed by a pitch
  * InMail from someone not connected to you
  * Titles like "Account Executive", "Sales", "Business Development", "SDR", "Growth"

- RECRUITING: Job opportunities or hiring. Key signals:
  * Sender is a recruiter, talent acquisition, or HR
  * Message mentions roles, positions, opportunities, or "your background"
  * Headhunters reaching out about specific positions

- PERSONAL: Genuine connection worth responding to. Key signals:
  * Person's role/company is DIRECTLY relevant to user's work context above
  * Message references specific shared context (mutual connections, same company, met at event)
  * Follow-up to existing relationship
  * Substantive question or discussion, not a pitch
  * First-degree connection reaching out about something specific

- EVENT: Event invitations, webinars, conferences. Key signals:
  * Promoting attendance at an event
  * Webinar invitations
  * Conference speaking or sponsorship requests

- CONTENT: About posts or content. Key signals:
  * Commenting on or sharing user's posts
  * Content collaboration requests
  * Podcast/interview invitations

- OTHER: Doesn't fit above categories

## PRIORITY SCORING (1-5):
5 = MUST READ: Directly relevant to user's work, from someone important, or requires action
4 = LIKELY VALUABLE: Probably worth reading, relevant industry/role
3 = MAYBE: Could be useful, unclear intent
2 = PROBABLY SKIP: Generic outreach but might have value
1 = SAFE TO IGNORE: Obvious sales, mass-sent templates, irrelevant

## KEY SIGNALS FOR SALES DETECTION:
- InMail = almost always sales or recruiting (paid messages)
- Titles containing: Sales, Account Executive, SDR, BDR, Business Development, Growth, Partnerships (at non-relevant companies)
- Companies that are agencies, consultancies, or B2B SaaS selling to businesses
- Messages that are vague about why they're reaching out
- "I came across your profile" + pitch = SALES
- Asking for a "quick call" or "15 minutes" without clear value to recipient = SALES

## OUTPUT FORMAT:
For each message, return a JSON object with:
- category: One of SALES, RECRUITING, PERSONAL, EVENT, CONTENT, OTHER
- priority: 1-5 (be harsh - most cold outreach should be 1-2)
- summary: One sentence (max 15 words) - what do they actually want?
- effort: "template" (mass-sent, generic) or "personalized" (specific to recipient)

Messages to categorize:
`;
}

// ============================================
// Storage Functions
// ============================================

async function getStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      resolve(result);
    });
  });
}

async function setStorage(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, () => {
      resolve();
    });
  });
}

async function getApiKey() {
  const { apiKey } = await getStorage('apiKey');
  return apiKey || null;
}

async function setApiKey(key) {
  await setStorage({ apiKey: key });
}

async function getFilters() {
  const { filters } = await getStorage('filters');
  return filters || { ...DefaultFilters };
}

async function setFilters(filters) {
  await setStorage({ filters });
}

async function getUserContext() {
  const { userContext } = await getStorage('userContext');
  return userContext || '';
}

async function setUserContext(context) {
  await setStorage({ userContext: context });
}

async function getClassifications() {
  const { classifications, lastClassificationTime } = await getStorage([
    'classifications',
    'lastClassificationTime'
  ]);

  if (lastClassificationTime) {
    const expiryTime = CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    if (Date.now() - lastClassificationTime > expiryTime) {
      await clearClassifications();
      return {};
    }
  }

  return classifications || {};
}

async function saveClassifications(newClassifications) {
  const classifications = await getClassifications();
  Object.assign(classifications, newClassifications);
  await setStorage({
    classifications,
    lastClassificationTime: Date.now()
  });
}

async function clearClassifications() {
  await setStorage({
    classifications: {},
    lastClassificationTime: null
  });
}

async function getStats() {
  const classifications = await getClassifications();
  const counts = {
    SALES: 0,
    RECRUITING: 0,
    PERSONAL: 0,
    EVENT: 0,
    CONTENT: 0,
    OTHER: 0,
    total: 0
  };

  for (const classification of Object.values(classifications)) {
    if (classification && classification.category) {
      counts[classification.category]++;
      counts.total++;
    }
  }

  return counts;
}

// ============================================
// Classifier Functions
// ============================================

async function classifyMessages(messages) {
  const apiKey = await getApiKey();

  if (!apiKey) {
    console.warn('[LinkedIn Triage] No API key configured');
    return createFallbackClassifications(messages);
  }

  const results = {};
  const batches = chunkArray(messages, BATCH_SIZE);

  for (const batch of batches) {
    try {
      const batchResults = await classifyBatch(batch, apiKey);
      Object.assign(results, batchResults);
    } catch (error) {
      console.error('[LinkedIn Triage] Batch classification error:', error);
      Object.assign(results, createFallbackClassifications(batch));
    }
  }

  return results;
}

async function classifyBatch(messages, apiKey) {
  // Get user context
  const userContext = await getUserContext();
  let prompt = buildClassificationPrompt(userContext);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const truncatedMessage = truncateMessage(msg.message, MAX_MESSAGE_LENGTH);
    const connectionInfo = msg.isFirstConnection ? '1st-degree connection' : 'NOT connected';
    const inMailInfo = msg.isInMail ? ' [INMAIL - paid message]' : '';
    const senderTitle = msg.senderTitle ? msg.senderTitle : 'Unknown title';

    prompt += '\n---\nMessage ' + (i + 1) + ':\n';
    prompt += 'From: ' + msg.participantName + '\n';
    prompt += 'Title: ' + senderTitle + '\n';
    prompt += 'Connection: ' + connectionInfo + inMailInfo + '\n';
    prompt += 'Message: ' + truncatedMessage + '\n';
  }

  prompt += '\n---\n\nRespond with ONLY a JSON array, one object per message, in the same order. No other text.';

  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error('API error: ' + response.status + ' - ' + errorText);
    }

    const data = await response.json();
    const content = data.content && data.content[0] && data.content[0].text ? data.content[0].text : '';

    const classifications = parseClassificationResponse(content, messages);
    return classifications;
  } catch (error) {
    console.error('[LinkedIn Triage] API request failed:', error);
    throw error;
  }
}

function parseClassificationResponse(responseText, messages) {
  const results = {};

  try {
    let jsonStr = responseText.trim();

    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      jsonStr = arrayMatch[0];
    }

    const parsed = JSON.parse(jsonStr);

    if (Array.isArray(parsed)) {
      for (let i = 0; i < Math.min(parsed.length, messages.length); i++) {
        const classification = validateClassification(parsed[i]);
        results[messages[i].conversationId] = classification;
      }
    }
  } catch (parseError) {
    console.error('[LinkedIn Triage] Failed to parse response:', parseError, responseText);
    return createFallbackClassifications(messages);
  }

  for (const msg of messages) {
    if (!results[msg.conversationId]) {
      results[msg.conversationId] = createFallbackClassification(msg);
    }
  }

  return results;
}

function validateClassification(obj) {
  const validCategories = ['SALES', 'RECRUITING', 'PERSONAL', 'EVENT', 'CONTENT', 'OTHER'];
  const validEfforts = ['template', 'personalized'];

  return {
    category: validCategories.includes(obj.category && obj.category.toUpperCase())
      ? obj.category.toUpperCase()
      : 'OTHER',
    priority: Math.min(5, Math.max(1, parseInt(obj.priority) || 3)),
    summary: typeof obj.summary === 'string'
      ? obj.summary.slice(0, 100)
      : 'Unable to summarize',
    effort: validEfforts.includes(obj.effort && obj.effort.toLowerCase())
      ? obj.effort.toLowerCase()
      : 'template'
  };
}

function createFallbackClassifications(messages) {
  const results = {};
  for (const msg of messages) {
    results[msg.conversationId] = createFallbackClassification(msg);
  }
  return results;
}

function createFallbackClassification(msg) {
  const message = (msg.message || '').toLowerCase();
  const title = (msg.senderTitle || '').toLowerCase();

  let category = 'OTHER';
  let priority = 3;
  let effort = 'template';

  // Sales title indicators (very strong signal)
  const salesTitles = ['account executive', 'sales', 'sdr', 'bdr', 'business development',
    'growth', 'partnerships', 'customer success', 'revenue'];
  const hasSalesTitle = salesTitles.some(function(t) { return title.includes(t); });

  // Recruiting title indicators
  const recruitingTitles = ['recruiter', 'talent', 'hr ', 'human resources', 'people operations',
    'hiring', 'staffing'];
  const hasRecruitingTitle = recruitingTitles.some(function(t) { return title.includes(t); });

  // Sales message keywords
  const salesKeywords = ['demo', 'schedule a call', 'would love to connect', 'help your company',
    'services', 'solution', 'platform', 'offer', 'discount', 'free trial', 'pricing',
    'quick call', '15 minutes', 'i came across', 'reaching out because', 'love to chat',
    'helping companies', 'i noticed'];

  // Recruiting message keywords
  const recruitingKeywords = ['opportunity', 'position', 'hiring', 'role', 'job', 'recruit',
    'candidate', 'talent', 'career', 'compensation', 'salary', 'your background',
    'perfect fit', 'exciting role'];

  // Event keywords
  const eventKeywords = ['event', 'webinar', 'conference', 'meetup', 'invitation', 'join us',
    'register', 'rsvp', 'summit', 'workshop'];

  // InMail is almost always sales or recruiting
  if (msg.isInMail) {
    if (hasRecruitingTitle) {
      category = 'RECRUITING';
      priority = 2;
    } else {
      category = 'SALES';
      priority = 1;
    }
    effort = 'template';
  }
  // Sales detection
  else if (hasSalesTitle || salesKeywords.some(function(kw) { return message.includes(kw); })) {
    category = 'SALES';
    priority = 1;
    effort = 'template';
  }
  // Recruiting detection
  else if (hasRecruitingTitle || recruitingKeywords.some(function(kw) { return message.includes(kw); })) {
    category = 'RECRUITING';
    priority = 2;
  }
  // Event detection
  else if (eventKeywords.some(function(kw) { return message.includes(kw); })) {
    category = 'EVENT';
    priority = 2;
  }
  // First connections without sales signals are likely personal
  else if (msg.isFirstConnection) {
    category = 'PERSONAL';
    priority = 4;
    effort = 'personalized';
  }

  return {
    category: category,
    priority: priority,
    summary: 'Classification unavailable - check message manually',
    effort: effort
  };
}

function truncateMessage(message, maxLength) {
  if (!message) return '';
  if (message.length <= maxLength) return message;
  return message.slice(0, maxLength - 3) + '...';
}

function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

// ============================================
// Message Handling
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true;
});

async function handleMessage(message, sender) {
  try {
    switch (message.type) {
      case MESSAGES.CLASSIFY_MESSAGES:
        return await handleClassifyMessages(message.messages);

      case MESSAGES.GET_CLASSIFICATIONS:
        return { classifications: await getClassifications() };

      case MESSAGES.GET_FILTERS:
        return { filters: await getFilters() };

      case MESSAGES.UPDATE_FILTERS:
        await setFilters(message.filters);
        notifyAllTabs('FILTERS_UPDATED', { filters: message.filters });
        return { success: true };

      case MESSAGES.GET_API_KEY:
        const apiKey = await getApiKey();
        return { hasApiKey: !!apiKey };

      case MESSAGES.SET_API_KEY:
        await setApiKey(message.apiKey);
        return { success: true };

      case MESSAGES.CLEAR_CACHE:
        await clearClassifications();
        return { success: true };

      case MESSAGES.GET_USER_CONTEXT:
        return { userContext: await getUserContext() };

      case MESSAGES.SET_USER_CONTEXT:
        await setUserContext(message.userContext);
        return { success: true };

      case 'GET_STATS':
        return { stats: await getStats() };

      default:
        console.warn('[LinkedIn Triage] Unknown message type:', message.type);
        return { error: 'Unknown message type' };
    }
  } catch (error) {
    console.error('[LinkedIn Triage] Error handling message:', error);
    return { error: error.message };
  }
}

async function handleClassifyMessages(messages) {
  if (!messages || messages.length === 0) {
    return { classifications: {} };
  }

  const existingClassifications = await getClassifications();
  const needsClassification = [];
  const results = {};

  for (const msg of messages) {
    if (existingClassifications[msg.conversationId]) {
      results[msg.conversationId] = existingClassifications[msg.conversationId];
    } else {
      needsClassification.push(msg);
    }
  }

  if (needsClassification.length > 0) {
    const newClassifications = await classifyMessages(needsClassification);
    Object.assign(results, newClassifications);
    await saveClassifications(newClassifications);
  }

  return { classifications: results };
}

async function notifyAllTabs(type, data) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: type, ...data });
      } catch (e) {
        // Tab might not have content script loaded
      }
    }
  } catch (e) {
    console.error('[LinkedIn Triage] Error notifying tabs:', e);
  }
}

// ============================================
// Extension Lifecycle
// ============================================

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({
      url: chrome.runtime.getURL('src/popup/popup.html?onboarding=true')
    });
  }
});

console.log('[LinkedIn Triage] Service worker initialized');

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

// Vercel proxy URLs
const VERCEL_BASE_URL = 'https://linked-in-management-extension-q9bfesmoj.vercel.app';
const VERCEL_PROXY_URL = VERCEL_BASE_URL + '/api/enrich-profile';
const VERCEL_CLASSIFY_URL = VERCEL_BASE_URL + '/api/classify';
const PROFILE_CACHE_EXPIRY_DAYS = 30; // Cache profiles longer than classifications

const MESSAGES = {
  CLASSIFY_MESSAGES: 'CLASSIFY_MESSAGES',
  GET_CLASSIFICATIONS: 'GET_CLASSIFICATIONS',
  UPDATE_FILTERS: 'UPDATE_FILTERS',
  GET_FILTERS: 'GET_FILTERS',
  GET_API_KEY: 'GET_API_KEY',
  SET_API_KEY: 'SET_API_KEY',
  CLEAR_CACHE: 'CLEAR_CACHE',
  GET_USER_CONTEXT: 'GET_USER_CONTEXT',
  SET_USER_CONTEXT: 'SET_USER_CONTEXT',
  ENRICH_PROFILES: 'ENRICH_PROFILES',
  SET_USER_PROFILE: 'SET_USER_PROFILE',
  GET_USER_PROFILE: 'GET_USER_PROFILE',
  CACHE_CONVERSATION_PROFILES: 'CACHE_CONVERSATION_PROFILES',
  GET_CONVERSATION_PROFILES: 'GET_CONVERSATION_PROFILES'
};

const DefaultFilters = {
  PROMOTIONS: false,
  SHOULD_RESPOND: true,
  WE_MET: true,
  IMPORTANT: true
};

// This will be built dynamically with user context
function buildClassificationPrompt(userContext) {
  return `You are analyzing LinkedIn conversations to help a busy professional prioritize their inbox.

## USER CONTEXT:
${userContext || 'No specific context provided.'}

## CATEGORY DEFINITIONS (only use these 4):

**IMPORTANT** - VERY RARE (<5% of messages), only use for:
- User initiated the conversation (they messaged first)
- Someone the user is clearly already doing business with
- High-value person who is NOT trying to sell something
- ASK YOURSELF: "Is this person likely trying to sell me something?" If yes, it's not IMPORTANT.

**WE_MET** - You've actually met this person or have a warm intro:
- References a specific event: "Great meeting you at [conference]"
- References a real conversation: "Following up on our chat"
- Warm intro with context: "[Name] said to reach out about [specific thing]"
- Clear evidence of prior real-world interaction
- Alumni or colleagues you've worked with

**SHOULD_RESPOND** - Worth replying to:
- Recruiters with genuinely relevant, specific opportunities
- Professional inquiries that aren't sales pitches
- Reasonable requests from industry peers
- Thoughtful outreach with specific, relevant context
- Follow-ups on real conversations

**PROMOTIONS** - Sales, marketing, or mass outreach:
- Product demos, software, services pitches
- SDRs, AEs, Business Development roles cold outreaching
- "Great to connect!" followed by pitch
- Multiple follow-ups with no response from user
- Generic recruiting mass-blasts
- Event/webinar promotions
- Newsletter/content promotion

## PRIORITY SCORING (1-10):
10 = IMPORTANT - user initiated or true VIP
8-9 = WE_MET - real relationship
5-7 = SHOULD_RESPOND - worth a reply
1-4 = PROMOTIONS - low priority

## OUTPUT FORMAT:
Return valid JSON for each conversation:
{
  "category": "PROMOTIONS|SHOULD_RESPOND|WE_MET|IMPORTANT",
  "priority": 1-10,
  "summary": "One sentence - what do they want? Be direct.",
  "signals": ["signal1", "signal2"]
}

THE KEY QUESTION: "Is this person likely trying to sell me something?"
- If YES → PROMOTIONS (regardless of their title or seniority)
- If NO, and you've met them → WE_MET
- If NO, and worth responding → SHOULD_RESPOND
- If NO, and user initiated or existing relationship → IMPORTANT

CRITICAL: If the USER has been the one mostly reaching out (user sent more messages), this is NOT a promotion - the user clearly cares about this conversation. Likely IMPORTANT or SHOULD_RESPOND.

Be selective with IMPORTANT - less than 5% of messages qualify.

Conversations to analyze:
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
  // API key is now handled by Vercel proxy
  return 'VERCEL_PROXY';
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

async function getUserProfile() {
  const { userProfile } = await getStorage('userProfile');
  return userProfile || null;
}

async function setUserProfile(profileUrl) {
  // Check if we already have this profile enriched
  const existing = await getUserProfile();
  if (existing && existing.url === profileUrl) {
    console.log('[LinkedIn Triage] User profile already cached');
    return existing;
  }

  console.log('[LinkedIn Triage] Enriching user profile:', profileUrl);

  // Enrich the user's profile via Vercel proxy
  try {
    const profiles = await enrichProfiles([profileUrl]);
    const enrichedProfile = profiles[profileUrl];

    if (enrichedProfile) {
      const userProfile = {
        url: profileUrl,
        ...enrichedProfile
      };
      await setStorage({ userProfile });
      console.log('[LinkedIn Triage] User profile enriched and cached:', userProfile);
      return userProfile;
    }
  } catch (error) {
    console.error('[LinkedIn Triage] Failed to enrich user profile:', error);
  }

  // Store URL even if enrichment failed
  const basicProfile = { url: profileUrl };
  await setStorage({ userProfile: basicProfile });
  return basicProfile;
}

// Build user context from enriched profile
async function buildUserContextFromProfile() {
  const profile = await getUserProfile();
  if (!profile || !profile.headline) {
    return await getUserContext(); // Fall back to manual context
  }

  let context = '';
  if (profile.headline) {
    context += `User's role: ${profile.headline}\n`;
  }
  if (profile.company) {
    context += `User's company: ${profile.company}\n`;
  }
  if (profile.title) {
    context += `User's job title: ${profile.title}\n`;
  }

  // Add any manual context as well
  const manualContext = await getUserContext();
  if (manualContext) {
    context += `Additional context: ${manualContext}\n`;
  }

  return context || 'No specific context provided. Use general professional relevance.';
}

// ============================================
// Conversation Profile Cache (from API interception)
// ============================================

async function getConversationProfiles() {
  const { conversationProfiles } = await getStorage('conversationProfiles');
  return conversationProfiles || {};
}

async function cacheConversationProfiles(newProfiles) {
  const existing = await getConversationProfiles();
  Object.assign(existing, newProfiles);
  await setStorage({ conversationProfiles: existing });
  console.log('[LinkedIn Triage] Cached', Object.keys(newProfiles).length, 'conversation profiles. Total:', Object.keys(existing).length);
  return existing;
}

async function getProfileForConversation(conversationId) {
  const profiles = await getConversationProfiles();
  const participants = profiles[conversationId];
  if (participants && participants.length > 0) {
    return participants[0]; // Return first participant (non-self)
  }
  return null;
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
    OTHER: 0,
    total: 0
  };

  for (const classification of Object.values(classifications)) {
    if (classification && classification.category) {
      // Map old categories to new ones
      const category = classification.category;
      if (counts.hasOwnProperty(category)) {
        counts[category]++;
      } else {
        counts.OTHER++;
      }
      counts.total++;
    }
  }

  return counts;
}

// ============================================
// Profile Cache Functions
// ============================================

async function getProfileCache() {
  const { profileCache, profileCacheTime } = await getStorage([
    'profileCache',
    'profileCacheTime'
  ]);

  if (profileCacheTime) {
    const expiryTime = PROFILE_CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    if (Date.now() - profileCacheTime > expiryTime) {
      await setStorage({ profileCache: {}, profileCacheTime: null });
      return {};
    }
  }

  return profileCache || {};
}

async function getCachedProfile(profileUrl) {
  const cache = await getProfileCache();
  return cache[profileUrl] || null;
}

async function cacheProfiles(profiles) {
  const cache = await getProfileCache();
  Object.assign(cache, profiles);
  await setStorage({
    profileCache: cache,
    profileCacheTime: Date.now()
  });
}

// ============================================
// Profile Enrichment Functions
// ============================================

async function enrichProfiles(profileUrls) {
  // Filter out already cached profiles and invalid URLs
  const cache = await getProfileCache();
  const urlsToEnrich = profileUrls.filter(url =>
    url &&
    url.startsWith('https://www.linkedin.com/in/') &&
    !cache[url]
  );

  if (urlsToEnrich.length === 0) {
    console.log('[LinkedIn Triage] All profiles already cached');
    return cache;
  }

  console.log('[LinkedIn Triage] Enriching', urlsToEnrich.length, 'profiles via Vercel proxy');

  try {
    const response = await fetch(VERCEL_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: urlsToEnrich })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[LinkedIn Triage] Vercel proxy error:', response.status, errorText);
      return cache;
    }

    const enrichedProfiles = await response.json();

    // Cache the results
    const newCache = {};
    for (const profile of enrichedProfiles) {
      if (profile && profile.url) {
        newCache[profile.url] = {
          headline: profile.headline || '',
          title: profile.title || '',
          company: profile.company || '',
          location: profile.location || '',
          connectionDegree: profile.connectionDegree || '',
          enrichedAt: Date.now()
        };
      }
    }

    await cacheProfiles(newCache);
    console.log('[LinkedIn Triage] Cached', Object.keys(newCache).length, 'enriched profiles');

    return { ...cache, ...newCache };
  } catch (error) {
    console.error('[LinkedIn Triage] Profile enrichment failed:', error);
    return cache;
  }
}

// ============================================
// Classifier Functions
// ============================================

async function classifyMessages(messages) {
  const apiKey = await getApiKey();

  if (!apiKey) {
    console.warn('[LinkedIn Triage] No API key configured');
    return await createFallbackClassifications(messages);
  }

  const results = {};
  const batches = chunkArray(messages, BATCH_SIZE);

  for (const batch of batches) {
    try {
      const batchResults = await classifyBatch(batch, apiKey);
      Object.assign(results, batchResults);
    } catch (error) {
      console.error('[LinkedIn Triage] Batch classification error:', error);
      Object.assign(results, await createFallbackClassifications(batch));
    }
  }

  return results;
}

async function classifyBatch(messages, apiKey) {
  // Get user context from their LinkedIn profile
  const userContext = await buildUserContextFromProfile();
  let prompt = buildClassificationPrompt(userContext);

  // Collect profile URLs and enrich them
  const profileUrls = messages
    .map(m => m.profileUrl)
    .filter(url => url && url.startsWith('https://'));

  // Try to enrich profiles (non-blocking, uses cache)
  const profileCache = await enrichProfiles(profileUrls);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const truncatedMessage = truncateMessage(msg.message, MAX_MESSAGE_LENGTH);
    const connectionInfo = msg.isFirstConnection ? '1st-degree connection' : 'NOT connected';
    const inMailInfo = msg.isInMail ? ' [INMAIL - paid message]' : '';

    // Get enriched profile data if available
    const enrichedProfile = msg.profileUrl ? profileCache[msg.profileUrl] : null;

    // Use enriched headline/title if available, otherwise fall back to DOM-extracted title
    let senderTitle = msg.senderTitle || '';
    let senderCompany = '';
    if (enrichedProfile) {
      senderTitle = enrichedProfile.headline || enrichedProfile.title || senderTitle;
      senderCompany = enrichedProfile.company || '';
    }

    // Analyze conversation dynamics
    const userInitiated = msg.userInitiated || false;
    const theirMessageCount = msg.theirMessageCount || 0;
    const userMessageCount = msg.userMessageCount || 0;

    prompt += '\n---\nConversation ' + (i + 1) + ':\n';
    prompt += 'From: ' + msg.participantName + '\n';
    prompt += 'Their Title/Headline: ' + (senderTitle || 'Unknown') + '\n';
    if (senderCompany) {
      prompt += 'Their Company: ' + senderCompany + '\n';
    }
    prompt += 'Connection: ' + connectionInfo + inMailInfo + '\n';

    // Add conversation dynamics
    if (userInitiated) {
      prompt += 'IMPORTANT: User initiated this conversation (user messaged first)\n';
    }
    if (theirMessageCount > 0 && userMessageCount === 0) {
      prompt += 'SIGNAL: They sent ' + theirMessageCount + ' messages, user has NOT replied\n';
    } else if (theirMessageCount > 0 && userMessageCount > 0) {
      prompt += 'Messages: ' + theirMessageCount + ' from them, ' + userMessageCount + ' from user\n';
    }

    prompt += 'Latest message preview: ' + truncatedMessage + '\n';
  }

  prompt += '\n---\n\nRespond with ONLY a JSON array, one object per message, in the same order. No other text.';

  try {
    // Use Vercel proxy which has the API key
    const response = await fetch(VERCEL_CLASSIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error('API error: ' + response.status + ' - ' + errorText);
    }

    const data = await response.json();
    const content = data.content && data.content[0] && data.content[0].text ? data.content[0].text : '';

    const classifications = await parseClassificationResponse(content, messages);
    return classifications;
  } catch (error) {
    console.error('[LinkedIn Triage] API request failed:', error);
    throw error;
  }
}

async function parseClassificationResponse(responseText, messages) {
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

    // Fix common JSON issues from LLM output:
    // 1. Smart quotes to regular quotes
    jsonStr = jsonStr.replace(/[\u201C\u201D]/g, '"');
    jsonStr = jsonStr.replace(/[\u2018\u2019]/g, "'");

    // 2. Try to parse first, only fix if needed
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (initialError) {
      console.log('[LinkedIn Triage] Initial parse failed, attempting fixes...');

      // More aggressive fix: find patterns like "word" inside JSON strings and replace with 'word'
      // Pattern: Look for quotes that are NOT at JSON structural positions
      // JSON structural quote positions: after { or , or [ or :, or before } or , or ] or :

      // First, replace obvious quoted words inside strings (e.g., "perks" -> 'perks')
      // This regex looks for a quote followed by a word followed by a quote, but NOT at structural positions
      jsonStr = jsonStr.replace(/"([^"]{1,30})"/g, function(match, content, offset) {
        // Check what comes before and after this match
        const before = jsonStr.slice(Math.max(0, offset - 10), offset);
        const after = jsonStr.slice(offset + match.length, offset + match.length + 10);

        // If this looks like a JSON key or value start/end, keep it
        // JSON value start: after : or , or [ or {
        // JSON value end: before , or ] or }
        const isJsonStart = /[:\[{,]\s*$/.test(before);
        const isJsonEnd = /^\s*[,\]}:]/.test(after);

        if (isJsonStart && isJsonEnd) {
          // This is a proper JSON string value
          return match;
        }

        // This is likely a quoted word inside a string - replace with single quotes
        return "'" + content + "'";
      });

      try {
        parsed = JSON.parse(jsonStr);
      } catch (secondError) {
        // Even more aggressive: manually fix by finding and replacing all nested quotes
        let fixed = '';
        let depth = 0; // Track JSON structure depth
        let inString = false;
        let stringStart = -1;

        for (let i = 0; i < jsonStr.length; i++) {
          const char = jsonStr[i];
          const prevChar = i > 0 ? jsonStr[i - 1] : '';

          // Skip escaped characters
          if (prevChar === '\\' && char !== '\\') {
            fixed += char;
            continue;
          }

          if (char === '"') {
            if (!inString) {
              // Starting a string
              inString = true;
              stringStart = i;
              fixed += char;
            } else {
              // Might be ending a string or a nested quote
              // Look ahead to see if this is really the end
              const rest = jsonStr.slice(i + 1);
              const nextStructural = rest.match(/^\s*([,\]}\:])/);

              if (nextStructural) {
                // This is the end of the string
                inString = false;
                fixed += char;
              } else {
                // This is a nested quote - replace with apostrophe
                fixed += "'";
              }
            }
          } else {
            fixed += char;
          }
        }

        jsonStr = fixed;
        parsed = JSON.parse(jsonStr);
      }
    }

    if (Array.isArray(parsed)) {
      for (let i = 0; i < Math.min(parsed.length, messages.length); i++) {
        const classification = validateClassification(parsed[i]);
        results[messages[i].conversationId] = classification;
      }
    }
  } catch (parseError) {
    console.error('[LinkedIn Triage] Failed to parse response:', parseError, responseText);

    // Try a more aggressive fix - parse each object individually
    try {
      const objectMatches = responseText.matchAll(/\{\s*"intent"[\s\S]*?"signals"\s*:\s*\[[^\]]*\]\s*\}/g);
      let i = 0;
      for (const match of objectMatches) {
        if (i >= messages.length) break;
        try {
          let objStr = match[0];
          // Clean up the object string
          objStr = objStr.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
          const obj = JSON.parse(objStr);
          results[messages[i].conversationId] = validateClassification(obj);
        } catch (e) {
          // Skip this object, will use fallback
        }
        i++;
      }
    } catch (e) {
      // Regex failed, use fallback for all
    }

    // Fill in any missing with fallbacks
    for (const msg of messages) {
      if (!results[msg.conversationId]) {
        results[msg.conversationId] = await createFallbackClassification(msg);
      }
    }
    return results;
  }

  for (const msg of messages) {
    if (!results[msg.conversationId]) {
      results[msg.conversationId] = await createFallbackClassification(msg);
    }
  }

  return results;
}

function validateClassification(obj) {
  // Only 4 valid categories
  const validCategories = ['PROMOTIONS', 'SHOULD_RESPOND', 'WE_MET', 'IMPORTANT'];

  // Get category directly
  let category = (obj.category || 'SHOULD_RESPOND').toUpperCase();

  // Map old category names to new ones
  if (category === 'SALES') category = 'PROMOTIONS';
  if (category === 'RECRUITING') category = 'SHOULD_RESPOND';
  if (category === 'PERSONAL' || category === 'NETWORKING' || category === 'WARM_INTRO') category = 'WE_MET';
  if (category === 'OTHER') category = 'SHOULD_RESPOND';
  if (category === 'INVESTOR' || category === 'CUSTOMER') category = 'IMPORTANT';

  if (!validCategories.includes(category)) {
    category = 'SHOULD_RESPOND'; // Default - give benefit of the doubt
  }

  return {
    category: category,
    priority: Math.min(10, Math.max(1, parseInt(obj.priority) || 5)),
    summary: typeof obj.summary === 'string'
      ? obj.summary.slice(0, 150)
      : 'Unable to summarize',
    signals: Array.isArray(obj.signals) ? obj.signals.slice(0, 5) : []
  };
}

async function createFallbackClassifications(messages) {
  const results = {};
  for (const msg of messages) {
    results[msg.conversationId] = await createFallbackClassification(msg);
  }
  return results;
}

async function createFallbackClassification(msg) {
  const message = (msg.message || '').toLowerCase();
  let title = (msg.senderTitle || '').toLowerCase();
  const signals = [];

  // Try to get enriched profile data for better fallback classification
  if (msg.profileUrl && msg.profileUrl.startsWith('https://')) {
    const cachedProfile = await getCachedProfile(msg.profileUrl);
    if (cachedProfile) {
      title = (cachedProfile.headline || cachedProfile.title || title).toLowerCase();
    }
  }

  // Default to SHOULD_RESPOND - give benefit of the doubt
  let category = 'SHOULD_RESPOND';
  let priority = 5;

  // Check conversation dynamics first - these are most important
  const userInitiated = msg.userInitiated || false;
  const theirMessageCount = msg.theirMessageCount || 0;
  const userMessageCount = msg.userMessageCount || 0;

  // If user sent more messages, they care about this conversation
  if (userMessageCount > theirMessageCount) {
    signals.push('User mostly reaching out');
    priority = 9;
    category = 'IMPORTANT';
  } else if (userInitiated) {
    signals.push('User initiated');
    priority = 10;
    category = 'IMPORTANT';
  }

  if (theirMessageCount >= 3 && userMessageCount === 0) {
    signals.push('Multiple follow-ups with no reply');
    priority = Math.min(priority, 2);
    category = 'PROMOTIONS';
  }

  // Check for warm intro signals - WE_MET
  const warmIntroPatterns = ['said to reach out', 'mentioned you', 'recommended I contact', 'introduced me'];
  if (warmIntroPatterns.some(p => message.includes(p))) {
    signals.push('Warm intro mentioned');
    category = 'WE_MET';
    priority = Math.max(priority, 8);
  }

  // Check for event/meeting reference - WE_MET
  const meetingPatterns = ['nice to meet you', 'great meeting you', 'good to see you at', 'after our conversation', 'following up on our'];
  if (meetingPatterns.some(p => message.includes(p))) {
    signals.push('References real meeting');
    category = 'WE_MET';
    priority = Math.max(priority, 8);
  }

  // Sales title indicators
  const salesTitles = ['account executive', 'sales', 'sdr', 'bdr', 'business development',
    'growth', 'partnerships', 'customer success', 'revenue', 'ae ', ' ae,', 'commercial'];
  const hasSalesTitle = salesTitles.some(function(t) { return title.includes(t); });

  // Recruiting title indicators - these go to SHOULD_RESPOND, not PROMOTIONS
  const recruitingTitles = ['recruiter', 'talent', 'hr ', 'human resources', 'people operations', 'hiring', 'staffing'];
  const hasRecruitingTitle = recruitingTitles.some(function(t) { return title.includes(t); });

  // Promotion message keywords
  const promoKeywords = ['demo', 'schedule a call', 'help your company',
    'services', 'solution', 'platform', 'offer', 'discount', 'free trial', 'pricing',
    'quick call', '15 minutes', 'i came across', 'reaching out because',
    'helping companies', 'any thoughts', 'checking in', 'circling back'];

  // Only apply title-based classification if user didn't initiate and no meeting reference
  if (!userInitiated && category !== 'WE_MET') {
    // InMail is often promotions
    if (msg.isInMail) {
      signals.push('InMail (paid message)');
      if (hasRecruitingTitle) {
        category = 'SHOULD_RESPOND';
        priority = 5;
      } else {
        category = 'PROMOTIONS';
        priority = 3;
      }
    }
    // Sales title = promotions
    else if (hasSalesTitle) {
      signals.push('Sales title');
      category = 'PROMOTIONS';
      priority = 2;
    }
    // Recruiting title = should respond (job opportunities)
    else if (hasRecruitingTitle) {
      signals.push('Recruiter');
      category = 'SHOULD_RESPOND';
      priority = 5;
    }
    // Promo keywords in message
    else if (promoKeywords.some(function(kw) { return message.includes(kw); })) {
      signals.push('Promo language detected');
      category = 'PROMOTIONS';
      priority = 3;
    }
  }

  return {
    category: category,
    priority: priority,
    summary: 'Classification unavailable - check message manually',
    signals: signals
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

      case MESSAGES.SET_USER_PROFILE:
        const profile = await setUserProfile(message.profileUrl);
        return { success: true, profile };

      case MESSAGES.GET_USER_PROFILE:
        return { profile: await getUserProfile() };

      case MESSAGES.CACHE_CONVERSATION_PROFILES:
        await cacheConversationProfiles(message.conversationProfiles);
        return { success: true };

      case MESSAGES.GET_CONVERSATION_PROFILES:
        return { conversationProfiles: await getConversationProfiles() };

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

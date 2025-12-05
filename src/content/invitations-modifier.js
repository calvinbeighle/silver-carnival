/**
 * LinkedIn Invitation Triage - Content Script for Invitations Page
 * Classifies connection invitations to help prioritize accepts
 */

(function() {
  'use strict';

  // Only run on the invitations/network page
  if (!window.location.href.includes('/mynetwork') && !window.location.href.includes('/invitations')) {
    return;
  }

  console.log('[LinkedIn Triage] Invitations modifier loaded');

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

  // Track processed invitations
  const processedInvitations = new Set();
  let isProcessing = false;

  // Inject styles
  function injectStyles() {
    if (document.getElementById('li-invite-triage-styles')) return;

    const styles = document.createElement('style');
    styles.id = 'li-invite-triage-styles';
    styles.textContent = `
      .li-invite-triage-indicator {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border-radius: 12px;
        font-size: 11px;
        font-weight: 600;
        margin-left: 8px;
        white-space: nowrap;
      }
      .li-invite-triage-hidden {
        display: none !important;
      }
      .li-invite-triage-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        background: #f3f2ef;
        border-bottom: 1px solid #e0e0e0;
        flex-wrap: wrap;
      }
      .li-invite-triage-filter-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 12px;
        border-radius: 16px;
        border: 1px solid #666;
        background: white;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s;
      }
      .li-invite-triage-filter-btn.active {
        background: #0a66c2;
        color: white;
        border-color: #0a66c2;
      }
      .li-invite-triage-filter-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
      .li-invite-triage-priority {
        font-size: 10px;
        opacity: 0.8;
      }
      .li-invite-triage-bulk-btn {
        padding: 4px 12px;
        border-radius: 16px;
        border: 1px solid #ef4444;
        background: white;
        color: #ef4444;
        cursor: pointer;
        font-size: 12px;
        margin-left: auto;
      }
      .li-invite-triage-bulk-btn:hover {
        background: #ef4444;
        color: white;
      }
    `;
    document.head.appendChild(styles);
  }

  // Extract invitation data from DOM element
  function extractInvitationData(invitationEl) {
    const data = {
      element: invitationEl,
      id: null,
      name: null,
      headline: null,
      profileUrl: null,
      mutualConnections: null
    };

    // Get invitation ID from componentkey
    const componentKey = invitationEl.getAttribute('componentkey');
    if (componentKey) {
      data.id = componentKey;
    }

    // Get profile link
    const profileLink = invitationEl.querySelector('a[href*="/in/"]');
    if (profileLink) {
      data.profileUrl = profileLink.href.split('?')[0];
    }

    // Get name
    const nameEl = invitationEl.querySelector('strong');
    if (nameEl) {
      data.name = nameEl.textContent.trim();
    }

    // Get headline - the paragraph after the name
    const paragraphs = invitationEl.querySelectorAll('p');
    for (const p of paragraphs) {
      const text = p.textContent.trim();
      // Skip if it's the name or mutual connections
      if (text && !text.includes(data.name) && !text.includes('mutual connection')) {
        data.headline = text;
        break;
      }
    }

    // Get mutual connections
    for (const p of paragraphs) {
      const text = p.textContent.trim();
      if (text.includes('mutual connection')) {
        data.mutualConnections = text;
        break;
      }
    }

    return data;
  }

  // Classify invitation based on headline and other signals
  function classifyInvitation(data) {
    const headline = (data.headline || '').toLowerCase();
    const mutualConnections = data.mutualConnections || '';

    let category = 'SHOULD_RESPOND';
    let priority = 5;
    const signals = [];

    // Check for mutual connections - good signal
    if (mutualConnections) {
      signals.push('Has mutual connections');
      priority = Math.max(priority, 6);
    }

    // Sales/promo title indicators
    const promoTitles = ['account executive', 'sales', 'sdr', 'bdr', 'business development',
      'growth', 'partnerships', 'customer success', 'revenue', 'ae ', ' ae,', 'commercial',
      'marketing', 'demand gen', 'lead gen', 'outbound'];
    const hasPromoTitle = promoTitles.some(t => headline.includes(t));

    // Recruiting title indicators
    const recruitingTitles = ['recruiter', 'talent', 'hr ', 'human resources', 'people operations',
      'hiring', 'staffing', 'talent acquisition', 'headhunter'];
    const hasRecruitingTitle = recruitingTitles.some(t => headline.includes(t));

    // Valuable connection indicators
    const valuableTitles = ['ceo', 'cto', 'cfo', 'coo', 'founder', 'co-founder', 'president',
      'vp ', 'vice president', 'director', 'head of', 'partner'];
    const hasValuableTitle = valuableTitles.some(t => headline.includes(t));

    // Industry-relevant titles (data center focused based on context)
    const industryTitles = ['data center', 'datacenter', 'infrastructure', 'cloud', 'engineer',
      'architect', 'developer', 'software', 'hardware', 'operations'];
    const hasIndustryTitle = industryTitles.some(t => headline.includes(t));

    if (hasPromoTitle) {
      signals.push('Sales/Marketing title');
      category = 'PROMOTIONS';
      priority = 2;
    } else if (hasRecruitingTitle) {
      signals.push('Recruiter');
      category = 'PROMOTIONS';
      priority = 3;
    } else if (hasValuableTitle && !hasPromoTitle) {
      signals.push('Executive/Leader');
      category = 'SHOULD_RESPOND';
      priority = 7;
    } else if (hasIndustryTitle) {
      signals.push('Industry relevant');
      category = 'SHOULD_RESPOND';
      priority = 6;
    }

    // Check if headline suggests they're trying to sell
    const sellSignals = ['help you', 'helping companies', 'grow your', 'scale your',
      'increase your', 'boost your', 'transform your', '@'];
    if (sellSignals.some(s => headline.includes(s))) {
      signals.push('Likely selling');
      category = 'PROMOTIONS';
      priority = Math.min(priority, 3);
    }

    return {
      category,
      priority,
      signals,
      summary: data.headline || 'No headline'
    };
  }

  // Add visual indicator to invitation
  function addIndicator(invitationEl, classification) {
    // Check if already has indicator
    if (invitationEl.querySelector('.li-invite-triage-indicator')) return;

    const indicator = document.createElement('span');
    indicator.className = 'li-invite-triage-indicator';
    indicator.style.backgroundColor = CategoryColors[classification.category] + '20';
    indicator.style.color = CategoryColors[classification.category];
    indicator.style.border = `1px solid ${CategoryColors[classification.category]}`;

    const label = document.createElement('span');
    label.textContent = CategoryLabels[classification.category];
    indicator.appendChild(label);

    const priority = document.createElement('span');
    priority.className = 'li-invite-triage-priority';
    const starCount = Math.ceil(classification.priority / 2);
    priority.textContent = ' ' + '\u2605'.repeat(starCount) + '\u2606'.repeat(5 - starCount);
    indicator.appendChild(priority);

    indicator.title = classification.signals.join(', ') + '\n' + classification.summary;

    // Store category on element for filtering
    invitationEl.dataset.triageCategory = classification.category;

    // Find the name element and insert after it
    const nameEl = invitationEl.querySelector('strong');
    if (nameEl && nameEl.parentElement) {
      nameEl.parentElement.appendChild(indicator);
    }
  }

  // Process all visible invitations
  async function processInvitations() {
    if (isProcessing) return;
    isProcessing = true;

    try {
      // Find pending invitations
      const invitations = document.querySelectorAll('[data-view-name="pending-invitation"] [role="listitem"]');

      console.log(`[LinkedIn Triage] Found ${invitations.length} invitations`);

      for (const invEl of invitations) {
        const componentKey = invEl.getAttribute('componentkey');
        if (!componentKey || processedInvitations.has(componentKey)) continue;

        const data = extractInvitationData(invEl);
        if (!data.name) continue;

        const classification = classifyInvitation(data);
        addIndicator(invEl, classification);
        processedInvitations.add(componentKey);

        console.log(`[LinkedIn Triage] Classified ${data.name}: ${classification.category}`);
      }
    } catch (error) {
      console.error('[LinkedIn Triage] Error processing invitations:', error);
    } finally {
      isProcessing = false;
    }
  }

  // Set up mutation observer
  function setupObserver() {
    const observer = new MutationObserver((mutations) => {
      let shouldProcess = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          shouldProcess = true;
          break;
        }
      }
      if (shouldProcess) {
        setTimeout(processInvitations, 500);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Initialize
  function init() {
    console.log('[LinkedIn Triage] Initializing invitations modifier');
    injectStyles();
    setupObserver();

    // Initial processing with delay for page load
    setTimeout(processInvitations, 1000);
    setTimeout(processInvitations, 3000);
  }

  // Wait for page to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

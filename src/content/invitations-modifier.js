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

  const CategoryLabels = {
    IMPORTANT: 'Important',
    REVIEW: 'Review',
    SPAM: 'Spam'
  };

  const CategoryColors = {
    IMPORTANT: '#22c55e',  // Green - auto-accept
    REVIEW: '#3b82f6',     // Blue - worth checking
    SPAM: '#ef4444'        // Red - ignore
  };

  // Filter state
  let filters = {
    IMPORTANT: true,
    REVIEW: true,
    SPAM: true
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
        display: inline-block;
        padding: 4px 8px;
        border-radius: 16px;
        font-size: 12px;
        font-weight: 500;
        margin-top: 4px;
        white-space: nowrap;
      }
      .li-invite-triage-indicator.important {
        background-color: #f0fdf4;
        color: #16a34a;
        border: 1px solid #bbf7d0;
      }
      .li-invite-triage-indicator.review {
        background-color: #eff6ff;
        color: #2563eb;
        border: 1px solid #bfdbfe;
      }
      .li-invite-triage-indicator.spam {
        background-color: #fef2f2;
        color: #dc2626;
        border: 1px solid #fecaca;
      }
      .li-triage-hidden {
        display: none !important;
      }
    `;
    document.head.appendChild(styles);
  }

  // Inject filter buttons after Invitations header
  function injectFilterButtons() {
    if (document.querySelector('.li-triage-toolbar')) return;

    // Find the "Invitations (X)" h2 header
    const headers = document.querySelectorAll('h2');
    let invitationsHeader = null;
    for (const h2 of headers) {
      if (h2.textContent.trim().startsWith('Invitations')) {
        invitationsHeader = h2;
        break;
      }
    }

    if (!invitationsHeader) {
      console.log('[LinkedIn Triage] Could not find Invitations header');
      return;
    }

    // Create toolbar
    const toolbar = document.createElement('span');
    toolbar.className = 'li-triage-toolbar';
    toolbar.style.display = 'inline-flex';
    toolbar.style.marginLeft = '12px';
    toolbar.style.padding = '0';
    toolbar.style.background = 'transparent';
    toolbar.style.border = 'none';
    toolbar.style.position = 'relative';
    toolbar.style.top = '-2px';

    // Create filter buttons
    for (const category of ['IMPORTANT', 'REVIEW', 'SPAM']) {
      const btn = document.createElement('button');
      btn.className = 'li-triage-filter-btn li-triage-filter-active';
      btn.setAttribute('data-category', category);

      const dot = document.createElement('span');
      dot.className = 'li-triage-filter-dot';
      dot.style.backgroundColor = CategoryColors[category];
      btn.appendChild(dot);

      const label = document.createElement('span');
      label.textContent = CategoryLabels[category];
      btn.appendChild(label);

      const check = document.createElement('span');
      check.className = 'li-triage-filter-check';
      check.textContent = '✓';
      btn.appendChild(check);

      btn.addEventListener('click', () => toggleFilter(category, btn));
      toolbar.appendChild(btn);
    }

    // Insert after h2
    invitationsHeader.appendChild(toolbar);
    console.log('[LinkedIn Triage] Filter buttons injected');
  }

  // Toggle filter
  function toggleFilter(category, btn) {
    filters[category] = !filters[category];
    const isActive = filters[category];

    btn.classList.toggle('li-triage-filter-active', isActive);
    const check = btn.querySelector('.li-triage-filter-check');
    if (check) {
      check.textContent = isActive ? '✓' : '✗';
    }

    // Apply filter visibility to all invitations
    applyFilters();
  }

  // Apply filters to all invitations
  function applyFilters() {
    const invitations = document.querySelectorAll('[data-triage-category]');
    for (const inv of invitations) {
      const category = inv.dataset.triageCategory;
      const shouldShow = filters[category] !== false;
      inv.classList.toggle('li-triage-hidden', !shouldShow);
    }
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

    // Get invitation ID from componentkey or generate one
    const componentKey = invitationEl.getAttribute('componentkey') ||
                         invitationEl.getAttribute('data-id') ||
                         invitationEl.id;
    if (componentKey) {
      data.id = componentKey;
    }

    // Get profile link
    const profileLink = invitationEl.querySelector('a[href*="/in/"]');
    if (profileLink) {
      data.profileUrl = profileLink.href.split('?')[0];
      // Generate ID from profile URL if no other ID
      if (!data.id) {
        data.id = data.profileUrl;
      }
    }

    // Get name - try multiple selectors
    const nameSelectors = [
      'strong',
      '.invitation-card__name',
      '.entity-result__title-text a span',
      '[class*="name"]',
      'a[href*="/in/"] span[dir="ltr"]',
      'a[href*="/in/"]'
    ];

    for (const selector of nameSelectors) {
      const nameEl = invitationEl.querySelector(selector);
      if (nameEl) {
        const text = nameEl.textContent.trim();
        // Skip if it looks like a button or action
        if (text && text.length < 50 && !['Accept', 'Ignore', 'Message'].includes(text)) {
          data.name = text;
          break;
        }
      }
    }

    // Get headline - look for text that appears to be a job title
    const allText = invitationEl.querySelectorAll('span, p, div');
    for (const el of allText) {
      const text = el.textContent.trim();
      // Skip if it's the name, mutual connections, or action buttons
      if (text &&
          text !== data.name &&
          !text.includes('mutual connection') &&
          !['Accept', 'Ignore', 'Message', 'Show all', 'Invitations'].includes(text) &&
          text.length > 5 &&
          text.length < 150 &&
          (text.includes('@') || text.includes(' at ') || text.includes(' - ') ||
           text.match(/\b(manager|director|engineer|developer|founder|ceo|cto|specialist|analyst|consultant)\b/i))) {
        data.headline = text;
        break;
      }
    }

    // Fallback: just get the second line of text
    if (!data.headline) {
      const paragraphs = invitationEl.querySelectorAll('p, span.t-14, span.t-black--light');
      for (const p of paragraphs) {
        const text = p.textContent.trim();
        if (text && text !== data.name && !text.includes('mutual') && text.length > 5) {
          data.headline = text;
          break;
        }
      }
    }

    // Get mutual connections
    const allElements = invitationEl.querySelectorAll('span, p');
    for (const el of allElements) {
      const text = el.textContent.trim();
      if (text.includes('mutual connection')) {
        data.mutualConnections = text;
        break;
      }
    }

    // Generate ID from name if we still don't have one
    if (!data.id && data.name) {
      data.id = 'inv-' + data.name.replace(/\s+/g, '-').toLowerCase();
    }

    console.log('[LinkedIn Triage] Extracted invitation data:', data);
    return data;
  }

  // Classify invitation based on headline and other signals
  // IMPORTANT: Senior title at large company (1000+) - auto-accept
  // REVIEW: Senior title, unknown company - worth checking
  // NETWORK: Has mutual connections - social proof
  // SPAM: Sales, recruiters, selling language - ignore
  function classifyInvitation(data) {
    const headline = (data.headline || '').toLowerCase();
    const mutualConnections = data.mutualConnections || '';

    let category = 'SPAM'; // Default to spam
    let priority = 3;
    const signals = [];

    // SPAM INDICATORS - Sales/promo title indicators
    const promoTitles = ['account executive', 'sales', 'sdr', 'bdr', 'business development',
      'growth', 'partnerships', 'customer success', 'revenue', 'ae ', ' ae,', 'commercial',
      'marketing', 'demand gen', 'lead gen', 'outbound'];
    const hasPromoTitle = promoTitles.some(t => headline.includes(t));

    // Recruiting title indicators
    const recruitingTitles = ['recruiter', 'talent', 'hr ', 'human resources', 'people operations',
      'hiring', 'staffing', 'talent acquisition', 'headhunter'];
    const hasRecruitingTitle = recruitingTitles.some(t => headline.includes(t));

    // Check if headline suggests they're trying to sell
    const sellSignals = ['help you', 'helping companies', 'grow your', 'scale your',
      'increase your', 'boost your', 'transform your', '@', 'i help', 'we help'];
    const hasSellSignal = sellSignals.some(s => headline.includes(s));

    // SENIOR TITLES ONLY: C-suite, VPs, Directors (NOT managers - too common)
    const seniorTitles = [
      // C-suite
      'ceo', 'cto', 'cfo', 'coo', 'cio', 'cmo', 'cro', 'cpo', 'cso',
      'chief executive', 'chief technology', 'chief financial', 'chief operating',
      'chief information', 'chief marketing', 'chief revenue', 'chief product',
      'chief ', // catches other chief X officer
      // President/Founder level
      'president', 'founder', 'co-founder', 'owner',
      // VP level
      'vp ', 'vp,', 'vp.', 'vice president', 'v.p.',
      'evp', 'svp', 'avp', 'gvp', 'cvp',
      'senior vice', 'executive vice', 'group vice',
      // Director level
      'director', 'dir ',
      // Partner (consulting/law/VC)
      'partner', 'managing director', 'general partner',
      // Board
      'board member', 'board of directors', 'advisory board'
    ];
    const hasSeniorTitle = seniorTitles.some(t => headline.includes(t));

    // Exclude if title includes junior/associate indicators
    const juniorIndicators = ['associate director', 'assistant director', 'junior', 'intern', 'entry'];
    const hasJuniorIndicator = juniorIndicators.some(t => headline.includes(t));

    // Ivy League and Ivy Plus schools - students worth reviewing
    const ivySchools = [
      // Ivy League
      'harvard', 'yale', 'princeton', 'columbia', 'penn', 'upenn', 'university of pennsylvania',
      'brown', 'dartmouth', 'cornell',
      // Ivy Plus
      'stanford', 'mit', 'massachusetts institute', 'duke', 'uchicago', 'university of chicago',
      'northwestern', 'caltech', 'johns hopkins', 'berkeley', 'uc berkeley'
    ];
    const isIvyStudent = headline.includes('student') && ivySchools.some(s => headline.includes(s));

    // Company size indicators - look for signs of large companies (1000+)
    const largeCompanyIndicators = [
      'fortune', 'f500', 'f1000', 'enterprise', 'global', 'worldwide', 'international',
      'google', 'microsoft', 'amazon', 'meta', 'apple', 'netflix', 'salesforce',
      'oracle', 'ibm', 'cisco', 'intel', 'nvidia', 'adobe', 'vmware', 'dell',
      'hp ', 'hewlett', 'accenture', 'deloitte', 'kpmg', 'pwc', 'ey ', 'ernst',
      'mckinsey', 'bain', 'bcg', 'jpmorgan', 'goldman', 'morgan stanley',
      'bank of america', 'wells fargo', 'citi', 'walmart', 'target', 'costco',
      'home depot', 'boeing', 'lockheed', 'raytheon', 'northrop',
      'pfizer', 'johnson & johnson', 'j&j', 'merck', 'abbott', 'medtronic',
      'at&t', 'verizon', 't-mobile', 'comcast', 'disney', 'warner', 'sony',
      'uber', 'lyft', 'airbnb', 'doordash', 'stripe', 'square', 'paypal',
      'visa', 'mastercard', 'slack', 'zoom', 'dropbox', 'docusign', 'servicenow',
      'workday', 'splunk', 'linkedin', 'twitter', 'snap', 'pinterest', 'reddit',
      'equinix', 'digital realty', 'coresite', 'qts', 'cyrusone', 'vantage',
      'aws', 'azure', 'gcp'
    ];
    const isLargeCompany = largeCompanyIndicators.some(c => headline.includes(c));

    // Check for employee count mentions (e.g., "10,000+ employees")
    const employeeCountMatch = headline.match(/(\d+[,\d]*)\+?\s*(employees|people|team)/i);
    const hasLargeEmployeeCount = employeeCountMatch &&
      parseInt(employeeCountMatch[1].replace(/,/g, '')) >= 1000;

    // Classification logic - 4 categories (STRICT for high-volume exec inbox)
    // Check spam signals first
    if (hasPromoTitle || hasRecruitingTitle || hasSellSignal) {
      signals.push(hasPromoTitle ? 'Sales title' : hasRecruitingTitle ? 'Recruiter' : 'Selling language');
      category = 'SPAM';
      priority = 1;
    }
    // Only elevate if senior title AND not junior AND not spam
    else if (hasSeniorTitle && !hasJuniorIndicator) {
      if (isLargeCompany || hasLargeEmployeeCount) {
        // IMPORTANT - C-suite/VP/Director at VERIFIED large company only
        signals.push('Senior exec at large company (1000+)');
        category = 'IMPORTANT';
        priority = 10;
      } else {
        // REVIEW - Senior title but can't verify company size
        signals.push('Senior title, verify company');
        category = 'REVIEW';
        priority = 6;
      }
    }
    // Ivy League / Ivy Plus students - worth reviewing
    else if (isIvyStudent) {
      signals.push('Ivy/Ivy+ student');
      category = 'REVIEW';
      priority = 5;
    }
    // Everything else is SPAM (other students, ICs, managers, mutual connections, unknown)

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
    indicator.className = 'li-invite-triage-indicator ' + classification.category.toLowerCase();
    indicator.textContent = CategoryLabels[classification.category];
    indicator.title = classification.signals.join(', ');

    // Store category on element for filtering
    invitationEl.dataset.triageCategory = classification.category;

    // Find where to insert - look for the headline/title paragraph
    // Insert after the name paragraph, not inside the link
    const headlineParagraph = invitationEl.querySelector('p:nth-of-type(2)') ||
                              invitationEl.querySelector('p + p');

    if (headlineParagraph) {
      // Insert after the headline
      headlineParagraph.insertAdjacentElement('afterend', indicator);
    } else {
      // Fallback: find the name link's parent paragraph and insert after
      const nameLink = invitationEl.querySelector('a[href*="/in/"]');
      if (nameLink) {
        const parentP = nameLink.closest('p');
        if (parentP) {
          parentP.insertAdjacentElement('afterend', indicator);
        } else {
          nameLink.parentElement.appendChild(indicator);
        }
      } else {
        // Last resort: append to the card
        invitationEl.appendChild(indicator);
      }
    }

    console.log('[LinkedIn Triage] Added indicator for:', classification.category, 'to element');
  }

  // Process all visible invitations
  async function processInvitations() {
    if (isProcessing) return;
    isProcessing = true;

    try {
      // Find pending invitations - multiple selectors for different page layouts
      let invitations = [];

      // Fallback first: Find cards that contain "Accept" buttons (most reliable)
      const allButtons = document.querySelectorAll('button');
      const acceptButtons = Array.from(allButtons).filter(btn => {
        const text = btn.textContent.trim().toLowerCase();
        return text === 'accept' || btn.getAttribute('aria-label')?.toLowerCase().includes('accept');
      });

      console.log('[LinkedIn Triage] Found Accept buttons:', acceptButtons.length);

      for (const acceptBtn of acceptButtons) {
        // Go up to find the invitation card container
        let container = acceptBtn.closest('li') ||
                        acceptBtn.closest('[class*="card"]') ||
                        acceptBtn.closest('[class*="invitation"]') ||
                        acceptBtn.closest('section')?.querySelector('li');

        // If we got a section, we need the specific li containing this button
        if (!container || container.tagName === 'SECTION') {
          // Walk up 4-5 levels to find the card
          let el = acceptBtn;
          for (let i = 0; i < 6; i++) {
            el = el.parentElement;
            if (!el) break;
            if (el.tagName === 'LI' || el.classList.toString().includes('card')) {
              container = el;
              break;
            }
          }
        }

        if (container && !invitations.includes(container)) {
          invitations.push(container);
          console.log('[LinkedIn Triage] Found invitation container:', container.className || container.tagName);
        }
      }

      // Secondary: try known selectors
      if (invitations.length === 0) {
        const selectors = [
          '[data-view-name="pending-invitation"] [role="listitem"]',
          '.invitation-card',
          '.invitation-card__container',
          '[class*="invitation"]',
          '.artdeco-card li',
          '.artdeco-list li'
        ];

        for (const selector of selectors) {
          const found = document.querySelectorAll(selector);
          if (found.length > 0) {
            console.log('[LinkedIn Triage] Found invitations with selector:', selector, found.length);
            invitations = Array.from(found);
            break;
          }
        }
      }

      console.log(`[LinkedIn Triage] Total invitations found: ${invitations.length}`);

      for (const invEl of invitations) {
        // Skip if already processed (check for indicator)
        if (invEl.querySelector('.li-invite-triage-indicator')) continue;

        const data = extractInvitationData(invEl);
        if (!data.name || !data.id) continue;

        // Skip if we've processed this ID before
        if (processedInvitations.has(data.id)) continue;

        const classification = classifyInvitation(data);
        addIndicator(invEl, classification);
        processedInvitations.add(data.id);

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
    console.log('[LinkedIn Triage] Initializing invitations modifier on:', window.location.href);
    injectStyles();
    setupObserver();

    // Initial processing with multiple delays for page load
    setTimeout(() => { injectFilterButtons(); processInvitations(); }, 500);
    setTimeout(() => { injectFilterButtons(); processInvitations(); }, 1500);
    setTimeout(() => { injectFilterButtons(); processInvitations(); }, 3000);
    setTimeout(() => { injectFilterButtons(); processInvitations(); }, 5000);

    // Also process when scrolling (LinkedIn lazy loads)
    document.addEventListener('scroll', debounce(processInvitations, 500));
  }

  // Debounce helper
  function debounce(fn, delay) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // Wait for page to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

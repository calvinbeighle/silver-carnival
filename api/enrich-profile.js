/**
 * Vercel Serverless Function - LinkedIn Profile Enrichment Proxy
 *
 * This function acts as a secure proxy between the browser extension and Apify,
 * keeping the Apify API token server-side and not exposed in the extension.
 *
 * Endpoint: POST /api/enrich-profile
 * Body: { urls: ["https://www.linkedin.com/in/username", ...] }
 * Returns: Array of enriched profile objects
 */

// Using anchor/linkedin-profile-enrichment actor
const APIFY_API_URL = 'https://api.apify.com/v2/acts/anchor~linkedin-profile-enrichment/run-sync-get-dataset-items';

export default async function handler(req, res) {
  // CORS headers for browser extension
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { urls } = req.body;

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls array is required' });
  }

  // Validate all URLs are LinkedIn profile URLs
  const validUrls = urls.filter(url =>
    typeof url === 'string' &&
    (url.includes('linkedin.com/in/') || url.includes('linkedin.com/company/'))
  );

  if (validUrls.length === 0) {
    return res.status(400).json({ error: 'No valid LinkedIn profile URLs provided' });
  }

  // Limit batch size to avoid timeout
  const urlsToProcess = validUrls.slice(0, 5);

  const apifyToken = process.env.APIFY;
  if (!apifyToken) {
    console.error('APIFY environment variable not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    console.log(`Enriching ${urlsToProcess.length} profiles via Apify anchor/linkedin-profile-enrichment`);

    // Format for anchor/linkedin-profile-enrichment actor
    const response = await fetch(
      `${APIFY_API_URL}?token=${apifyToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrls: urlsToProcess.map((url, idx) => ({ url, id: String(idx + 1) }))
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Apify API error:', response.status, errorText);
      return res.status(response.status).json({
        error: 'Profile enrichment failed',
        details: errorText
      });
    }

    const data = await response.json();

    // Map anchor/linkedin-profile-enrichment response to our simplified format
    const profiles = data.map(profile => ({
      url: profile.url,
      fullName: profile.full_name || `${profile.first_name || ''} ${profile.last_name || ''}`.trim(),
      headline: profile.headline || '',
      summary: profile.summary || '',
      title: profile.experiences?.[0]?.title || '',
      company: profile.company_name || profile.experiences?.[0]?.company || '',
      companyIndustry: profile.company_industry || '',
      location: profile.city ? `${profile.city}, ${profile.country}` : profile.country || '',
      firstName: profile.first_name || '',
      lastName: profile.last_name || '',
      experiences: profile.experiences || [],
      education: profile.education || []
    }));

    console.log(`Successfully enriched ${profiles.length} profiles`);
    return res.status(200).json(profiles);

  } catch (error) {
    console.error('Profile enrichment error:', error);
    return res.status(500).json({
      error: 'Profile enrichment failed',
      details: error.message
    });
  }
}

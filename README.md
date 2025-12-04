# LinkedIn Inbox Triage

AI-powered inbox triage for LinkedIn messages. Color-code, filter, and summarize your messages instantly.

## The Problem

Receiving hundreds of LinkedIn messages daily makes the inbox unusable. The signal-to-noise ratio is too low to find what's worth your time.

## The Solution

A lightweight Chrome extension that adds visual triage directly into the LinkedIn messaging interface:

- **Color-coded dots** instantly show message categories
- **One-click filtering** to hide entire categories (like sales pitches)
- **Hover summaries** tell you what someone wants in one sentence
- **Bulk actions** to dismiss entire categories at once

## Features

### Instant Visual Triage
Each conversation shows:
- **Red dot**: Likely sales pitch / cold outreach
- **Yellow dot**: Recruiting / job opportunity
- **Green dot**: Appears personal / from real connection
- **Blue dot**: Event or content related
- **Purple dot**: Content engagement
- **Gray dot**: Uncategorized / needs review

Plus a priority score (1-5 stars) based on connection degree, message effort, and personalization.

### One-Click Filtering
A toolbar above your message list lets you toggle category visibility. Hide all sales messages forever with one click.

### Hover Summaries
Hover over any conversation to see:
- One-sentence summary of what they want
- Whether it appears mass-sent or personalized
- Category and priority at a glance

### Bulk Actions
- "Hide All Sales" button to clear the clutter instantly

## Installation

### From Source (Developer Mode)

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the `LinkedInManagementExtension` folder
6. The extension icon should appear in your toolbar

### API Key Setup

1. Go to [console.anthropic.com](https://console.anthropic.com/settings/keys)
2. Create a new API key
3. Click the extension icon and paste your key
4. Your key is stored locally and only used to contact Claude directly

## Usage

1. Navigate to [LinkedIn Messaging](https://www.linkedin.com/messaging/)
2. The extension automatically analyzes visible conversations
3. Use the filter toolbar to show/hide categories
4. Hover over conversations for quick summaries
5. Click the extension icon to change settings or view stats

## Privacy

- **No external servers**: All processing happens locally or directly with Claude API
- **No analytics**: Zero tracking or data collection
- **Your API key**: Stored only in your browser's local storage
- **Message content**: Only sent to Claude for categorization, never stored elsewhere

## Technical Details

- **Manifest V3** Chrome extension
- **Claude Haiku** for fast, cost-effective classification
- **Local caching** to minimize API calls
- **Resilient DOM selectors** that adapt to LinkedIn changes

## Project Structure

```
linkedin-triage-extension/
├── manifest.json              # Extension manifest (MV3)
├── src/
│   ├── content/
│   │   ├── inbox-modifier.js  # Main content script (DOM injection, UI)
│   │   └── styles.css         # Injected styles
│   ├── background/
│   │   └── service-worker.js  # Background worker (API, storage, classification)
│   └── popup/
│       ├── popup.html         # Settings popup
│       ├── popup.js           # Popup logic
│       └── popup.css          # Popup styles
├── icons/                     # Extension icons
└── README.md
```

## Troubleshooting

### Extension not working on LinkedIn

LinkedIn's DOM can change. Try:
1. Refresh the page
2. Click the extension icon and hit "Refresh Page"
3. Check the browser console for errors

### API errors

- Verify your API key is correct
- Check your Anthropic account has credits
- The extension will fall back to heuristic classification if API fails

### Messages not being categorized

- New messages are batched for efficiency
- Wait a few seconds after opening messaging
- Check that your API key is configured

## Development

To modify the extension:

1. Make changes to files in `src/`
2. Go to `chrome://extensions/`
3. Click the refresh icon on the extension
4. Reload the LinkedIn messaging page

## License

MIT License - feel free to modify and distribute.

## Acknowledgments

Built for humans overwhelmed by LinkedIn messages.
Uses Claude AI by Anthropic for intelligent categorization.

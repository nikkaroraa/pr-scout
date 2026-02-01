# pr-scout 🔍

AI-powered PR review tool that helps you understand pull requests before approving them.

## Features

- **AI Summary** - Brief summary of what the PR is about
- **Feature-Based Traversal** - Groups related files by feature, not alphabetically
- **Interactive Walkthrough** - Shows changes one by one with explanations
- **Quiz Mode** - Tests your understanding before allowing approval

## Requirements

- Node.js >= 18
- GitHub CLI (`gh`) installed and authenticated
- An AI model accessible via CLI (uses `claude` by default, configurable)

## Installation

```bash
# Clone the repo
git clone https://github.com/nikkaroraa/pr-scout.git
cd pr-scout

# Make it executable
chmod +x scripts/review.js

# Link globally (optional)
npm link
```

## Usage

```bash
# Basic usage with PR URL
pr-scout https://github.com/owner/repo/pull/123

# Or just the PR number if you're in the repo
pr-scout 123

# Skip quiz mode (just review, no test)
pr-scout https://github.com/owner/repo/pull/123 --no-quiz

# Use a different AI model
pr-scout https://github.com/owner/repo/pull/123 --model gpt-4
```

## How It Works

1. **Fetch** - Uses `gh` CLI to fetch PR details and diff
2. **Analyze** - AI analyzes the changes and groups files by feature
3. **Summarize** - Shows a brief summary of the PR intent
4. **Walkthrough** - Takes you through each feature group, explaining changes
5. **Quiz** - Asks questions to verify you understood the changes
6. **Approve** - Only allows approval if you pass the quiz

## Example Session

```
$ pr-scout https://github.com/acme/app/pull/42

🔍 PR Scout - AI-Powered Review

📋 Fetching PR #42...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 PR SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Title: Add user authentication with OAuth
Author: @developer
Files changed: 8

This PR adds OAuth-based authentication using GitHub as the provider.
It includes login/logout flows, session management, and protected routes.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📁 FEATURE GROUPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[1] 🔐 OAuth Configuration (2 files)
    - lib/auth/oauth.js
    - config/oauth.json

[2] 🚪 Login/Logout UI (3 files)
    - components/LoginButton.jsx
    - components/LogoutButton.jsx
    - pages/login.jsx

[3] 🛡️ Route Protection (3 files)
    - middleware/auth.js
    - hooks/useAuth.js
    - pages/_app.jsx

Press [Enter] to start walkthrough...
```

## Configuration

Create a `.pr-scoutrc` file in your home directory for defaults:

```json
{
  "model": "claude",
  "quizQuestions": 3,
  "autoApprove": false
}
```

## License

MIT

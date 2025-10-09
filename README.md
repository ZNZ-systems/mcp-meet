# mcp-meet

If like me you hate running google apps locally because they kill your battery life and you prefer to run the native apple apps, you will know that scheduling calendar events is really annoying with google meet. If you install this mcp you can just ask claude to schedule the event for you and it will schedule it in your apple calendar and generate a google meet link.

## Features

- 🔍 **Contact Search** - Find people in your Google Contacts by name or email
- 📅 **Smart Availability** - Check free/busy status across multiple calendars and attendees
- 🎯 **Common Slots** - Find times when everyone is actually available
- 🤝 **One-Click Scheduling** - Automatically find the best slot and book it
- 🔗 **Google Meet Links** - Every meeting comes with a Meet link ready to go
- 🍎 **Apple Calendar Sync** - Meetings automatically appear in your macOS Calendar app

## How it works


1. **`search_invitees`** - Search your Google Contacts to find email addresses
2. **`find_slots`** - Get a list of common free time slots across all attendees
3. **`create_meet_and_calendar`** - Create a Google Calendar event with Meet link and mirror to Apple Calendar
4. **`plan_and_schedule`** - The smart one: finds the first available slot that fits your duration and books it instantly

## Setup

### Prerequisites

- Node.js 18 or later
- A Google Cloud project with Calendar and People API enabled
- OAuth 2.0 credentials (Client ID and Secret)
- macOS (for Apple Calendar integration)

### Installation

```bash
npm install mcp-meet
```

Or clone and build from source:

```bash
git clone https://github.com/znz-systems/mcp-meet.git
cd mcp-meet
pnpm install
pnpm build
```

### Configuration

Create a `.env` file with your Google OAuth credentials:

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:5173

# Optional: Specify which calendars to check for availability (comma-separated)
CALENDAR_IDS=primary,your-other-calendar@gmail.com

# Optional: Name of the Apple Calendar to create events in (defaults to "Meetings")
APPLE_CALENDAR_NAME=Work
```

### Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select existing)
3. Enable the **Google Calendar API** and **People API**
4. Create OAuth 2.0 credentials (Desktop app type)
5. Add `http://localhost:5173` as an authorized redirect URI
6. Copy your Client ID and Client Secret to your `.env` file

### First-time authentication

Run the authentication flow to grant access:

```bash
pnpm cli auth
```

This will open your browser for Google sign-in. Once complete, tokens are saved to `~/.config/mcp-meet/tokens.json` and you're good to go.

## Usage

### As an MCP Server

Start the server using stdio transport (for AI assistant integration):

```bash
node dist/index.js
```

Or in development:

```bash
pnpm dev
```

Your MCP client (like Claude Desktop) can then call the available tools.


## License

MIT

## Contributing

Issues and pull requests welcome!


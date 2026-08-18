# IdleRPG for Discord

This is a vibe-coded Discord.js port of the classic [IdleRPG](https://idlerpg.net/) 3.1.2 bot. Each configured Discord channel is a completely separate game: accounts, timers, map positions, items, battles, random events, alignments, admins, and quests never cross channel boundaries.

The original progression and event formulas are retained. Discord account IDs replace IRC nick/password login. There is no login command and the bot never sends DMs; command results are ephemeral interaction replies and game events are posted in the configured channel.

## Persistent data

All mutable and administrator-editable files live in one directory:

```text
data/
  config.json       # Active configuration (ignored by git)
  config.example.json
  events.txt        # Editable English runtime events (ignored by git)
  events.example.txt # Tracked default calamities, godsends, and quests
  events.pt-BR.txt  # Editable Brazilian Portuguese runtime events (ignored by git)
  events.pt-BR.example.txt # Tracked Portuguese defaults
  idlerpg.sqlite    # Player and game state (ignored by git)
  idlerpg.sqlite-wal
  idlerpg.sqlite-shm
```

Mount or back up the complete `data/` directory rather than only the SQLite file. SQLite uses the sibling WAL and SHM files while the bot is running. Stop the bot before making a file-level copy of this directory, or use a SQLite-aware online backup tool.

Both local startup and Docker automatically create missing runtime event files from their matching examples. Existing event files are never overwritten, so customized events survive upgrades and image rebuilds.

## Local setup

1. Install Node.js 20 or newer and run `npm install`.
2. Copy `data/config.example.json` to `data/config.json` if an active config does not already exist, then set `channelIds` and `ownerIds`. `defaultLocale` is used when Discord's server locale is unsupported, and `eventsPaths` maps each language to its event file.
3. Set the bot token as `DISCORD_TOKEN` (recommended) or put it in `data/config.json`.
4. In the Discord Developer Portal, enable the **Server Members Intent** and **Message Content Intent** for the bot. Enable **Presence Intent** to apply penalties when players go offline.
5. Invite the bot with the `bot` and `applications.commands` scopes. It needs View Channel, Send Messages, and Use Application Commands in every game channel.
6. Run `npm start`.

Bash example:

```bash
cp data/config.example.json data/config.json
export DISCORD_TOKEN='your-token'
npm start
```

`npm start` uses `./data/config.json` by default. `IDLERPG_DATA_DIR` can select another data directory, and `IDLERPG_CONFIG` can select a specific config file.

Commands are installed as guild commands when the bot starts. Discord may display them in other channels in the same server, but the bot rejects them anywhere not listed in `channelIds`.

You can also configure IDs without a JSON file:

```bash
export DISCORD_TOKEN='your-token'
export IDLERPG_CHANNEL_IDS='123456789012345678,234567890123456789'
export IDLERPG_OWNER_IDS='345678901234567890'
npm start
```

## Docker Compose

The Docker image contains only application code and dependencies. Compose mounts the host's `./data` directory at `/data`, runs the bot as a non-root user, and forwards `SIGTERM` so SQLite is saved cleanly.

Compose builds and tags the image as `saadbruno/idlerpg:latest`. To publish that tag to Docker Hub after authenticating, run `docker compose build` followed by `docker push saadbruno/idlerpg:latest`.

With `data/config.json` configured, start the bot with:

```sh
docker compose up -d
```

Follow logs or stop it with:

```sh
docker compose logs -f idlerpg
docker compose down
```

To keep the token out of `data/config.json`, copy `.env.example` to `.env` and set `DISCORD_TOKEN`. Compose reads `.env` automatically. An environment token overrides the value in the JSON config.

On a fresh empty `data/` mount, the container seeds `config.json`, `events.txt`, and `events.pt-BR.txt` from bundled templates. Configure the generated file, then restart with `docker compose up -d`.

### Deploy from Docker Hub without cloning

You only need Docker Compose and the published `saadbruno/idlerpg:latest` image. Create an empty deployment directory:

```bash
mkdir -p idlerpg/data
cd idlerpg
```

Create `docker-compose.yml` with the following content:

```yaml
services:
  idlerpg:
    image: saadbruno/idlerpg:latest
    restart: unless-stopped
    init: true
    environment:
      IDLERPG_DATA_DIR: /data
      IDLERPG_CONFIG: /data/config.json
      DISCORD_TOKEN: ${DISCORD_TOKEN}
    volumes:
      - ./data:/data
    stop_grace_period: 30s
```

Create `.env` beside it and add your bot token:

```dotenv
DISCORD_TOKEN=your-token
```

Pull the image and run its setup once. The `true` command lets the image create the initial files without starting the bot yet:

```bash
docker compose pull
docker compose run --rm idlerpg true
```

Edit `data/config.json` and replace the example `channelIds` and `ownerIds`. You can also customize `data/events.txt` and `data/events.pt-BR.txt`. Then start the bot:

```bash
docker compose up -d
docker compose logs -f idlerpg
```

To update later without cloning or building anything:

```bash
docker compose pull
docker compose up -d
```

The database, configuration, and custom events remain under `./data`; back up that entire directory. If the container cannot write there because the host uses a different user ID, grant UID `1000` write access to the directory—the image runs as that non-root user.

## Commands

Player commands are under `/idlerpg`:

- `register`, `status`, `whoami`, `quest`, `align`
- `items`, `leaderboard`, `removeme`, `help`

Classic administration operations that still apply to Discord are under `/idlerpg-admin`:

- `delete`, `delete-old`, `make-admin`, `remove-admin`
- `rename`, `change-class`, `push`, `hand-of-god`, `pause`, `silent`
- `language` — set the language for every configured game channel in the server

Passwords, `login`, `logout`, IRC reconnect controls, raw Perl evaluation, and IRC mode/queue controls are intentionally absent because Discord authentication and transport replace them.

## Languages

English (`en-US`) and Brazilian Portuguese (`pt-BR`) are included. On first startup in a server, the bot uses Discord's preferred server locale when it is supported, then stores the selection in SQLite. A member with Discord's **Manage Server** permission, or a user listed in `ownerIds`, can change it with:

```text
/idlerpg-admin language locale:Português (Brasil)
```

Game announcements, command replies, validation errors, embeds, durations, item names, artifacts, and quests all use the stored server language. Every configured channel still has independent players and game state; channels in the same server only share the language setting.

Discord localizes slash-command names and descriptions according to each user's Discord client language. Their canonical internal names remain in English, so documentation and logs are stable. Public output follows the server language rather than changing based on the user who invoked a command.

Translation catalogs are under `locales/<locale>/messages.json`. Locale catalogs must have the same keys and placeholders; the bot validates them at startup. Custom random events remain in the mounted `data/` directory and are selected through `eventsPaths`:

```json
"eventsPaths": {
  "en-US": "./events.txt",
  "pt-BR": "./events.pt-BR.txt"
}
```

The older single `eventsPath` setting remains supported as an override for `defaultLocale`, with a startup warning to make the migration visible. If the language changes while a quest is already active, that quest's stored custom text remains in its original language until it finishes; subsequent quests use the newly selected event pack.

## Discord equivalents for IRC activity

- A normal message in a configured channel receives the original message-length penalty.
- A server nickname/display-name change receives the original nickname penalty in each configured game in that server.
- With the Presence Intent available, going offline for longer than `offlineGraceSeconds` (60 seconds by default) receives the original quit penalty and makes the character inactive. Returning to online, idle, or Do Not Disturb automatically activates it; no command is needed. Invisible appears offline to bots and follows the same rule.
- At startup, the bot explicitly fetches registered guild members with their presences before restoring character state. Temporary fetch failures leave existing state unchanged and are retried instead of treating an incomplete Discord cache as proof that a player is offline.
- When an inactive character is automatically reactivated, the channel receives the original-style “is now online” announcement with the character's Discord mention and time to the next level. Set `announceLoginMessages` to `false` to suppress these announcements without preventing reactivation. Returning during the offline grace period does not announce a login because the character never became inactive.
- Quests require four active level-40-or-higher characters who have each remained online longer than `questEligibilitySeconds` (four hours by default).
- Leaving the server applies the quit penalty immediately. If the privileged Presence Intent is unavailable, this server-leave behavior remains active as the fallback and the bot logs a warning at startup.
- Slash commands do not receive message penalties, matching the original private bot-command behavior.

The SQLite database defaults to `data/idlerpg.sqlite` and uses WAL mode. Channel IDs are included in every game-state key, which enforces the isolation between games.

## Console logging

Logs use timestamped `[IdleRPG]` entries with JSON context. They cover startup configuration, channel discovery, guild-language initialization and changes, slash-command deployment, presence-intent availability, registrations, online/offline transitions, grace-period start/cancellation/expiry, automatic reactivation, server leave/rejoin, nickname penalties, administrative actions, command failures, per-channel tick failures, and shutdown. Message contents and the Discord token are never logged.

## License

Original contributions to this project are available under the [MIT License](./LICENSE). The classic IdleRPG source under `original/`, and any other upstream material, retain their respective copyright notices and terms and are not relicensed by the MIT grant.

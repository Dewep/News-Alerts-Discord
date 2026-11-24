# News-Alerts-Discord

Send news live direct alerts to a Discord channel.

Every 15 minutes, articles are collected from the sources below, then filtered by Claude Haiku
(`claude-haiku-5-5`) to only keep the essential/important ones (few per day, less sport, more tech).
Each published message ends with the importance score given by the filter (e.g. `(7/10)`).

- FranceInfo (general news, curated headlines, heavily AFP-sourced) https://www.franceinfo.fr/titres.rss
- LeMonde Pixels (tech) https://www.lemonde.fr/pixels/rss_full.xml

Le Figaro Flash Actu would be a richer general wire but lefigaro.fr blocks datacenter IPs
(Datadome bot challenge).

Adding a source is a one-line entry in the `providers` list (any RSS 2.0 feed).
Articles older than 12 hours are ignored, so a fresh start (no `handled-news.json`)
or a long downtime does not flood the channel with the whole feed backlog.

![Discord Screenshot](./images/News-Alerts-Discord-screenshot.png)

## Discord BOT

- Create a Discord Application: https://discord.com/developers/applications
- Generate a Bot for this application (use the token for the DISCORD_BOT_AUTHORIZATION env variable)
- Add your bot to your Discord server: https://discord.com/oauth2/authorize?client_id=xxxx&scope=bot&permissions=2048 (xxxx is your app ID)
- The Discord Channel ID is the second part of the URL: https://discord.com/channels/xxxx/yyyy (yyyy here)

## Anthropic API key

The news filtering uses the Anthropic API (Claude Haiku). Create an API key on
https://platform.claude.com/ and put it in a `.env` file next to `docker-compose.yml`
(this file is gitignored):

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Usage

For the first run, exec `zx --install main.mjs` to install dependencies.

```bash
DISCORD_CHANNEL_ID=123456789 DISCORD_BOT_AUTHORIZATION=xxx.yyy.zzz ANTHROPIC_API_KEY=sk-ant-... zx main.mjs
```

To test the collection + filtering without sending anything to Discord (and without
persisting state):

```bash
ANTHROPIC_API_KEY=sk-ant-... zx main.mjs --dry-run
```

Handled article IDs are persisted in `handled-news.json` so a restart does not re-send
already-processed news.

## Tuning the filter

Each article gets an importance score from 0 to 10; only articles scoring at or above the
threshold are published. The default threshold is 6 (a handful of news per day). Set
`NEWS_IMPORTANCE_THRESHOLD=7` for fewer news, `8` for major events only.

The titles published over the last 48 hours are given back to the filter so the same event
coming later from another source is not published twice.

The filter model defaults to `claude-haiku-5-5` (10x cheaper than Haiku 4.5) and can be
changed with `NEWS_FILTER_MODEL` (any Anthropic model ID, e.g. `claude-sonnet-5-5`).

## Docker

```
git pull
docker compose stop
docker compose rm
docker compose build
docker compose up -d
```

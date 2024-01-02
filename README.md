# FranceTVInfo-Alerts-Discord

Send FranceTV live direct alerts to a Discord channel

## Discord BOT

- Create a Discord Application: https://discord.com/developers/applications
- Generate a Bot for this application (use the token for the DISCORD_BOT_AUTHORIZATION env variable)
- Add your bot to your Discord server: https://discord.com/oauth2/authorize?client_id=xxxx&scope=bot&permissions=2048 (xxxx is your app ID)
- The Discord Channel ID is the second part of the URL: https://discord.com/channels/xxxx/yyyy (yyyy here)

## Usage

```bash
DISCORD_CHANNEL_ID=123456789 DISCORD_BOT_AUTHORIZATION=xxx.yyy.zzz go run main.go
```

## Service

Create `/lib/systemd/system/francetvinfo-alerts-discord.service`, from the `francetvinfo-alerts-discord.service` file.

Update the WorkingDirectory, and Environment variables.

Then: `systemctl daemon-reload && systemctl start francetvinfo-alerts-discord && systemctl enable francetvinfo-alerts-discord`

For updates: `systemctl restart francetvinfo-alerts-discord`

For logs: `journalctl -u francetvinfo-alerts-discord -f`

## Usage (zx alternative)

```bash
DISCORD_CHANNEL_ID=123456789 DISCORD_BOT_AUTHORIZATION=xxx.yyy.zzz zx main.mjs
```

For the first run, exec `zx --install main.mjs` to install dependencies.

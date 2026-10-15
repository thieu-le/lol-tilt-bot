// Discord client wiring. We intentionally stay minimal:
//   - Only the `Guilds` intent is needed for slash commands.
//   - All command logic lives in commands.js.
//   - Slash commands are (re)registered on ready, so a deploy that adds or
//     changes a command needs no manual `npm run register-commands`.
//   - The poller is started after the client signals ready.

import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { handleInteraction, commandData } from './commands.js';
import { startPoller, stopPoller } from './poller.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async (c) => {
  logger.info(`Logged in as ${c.user.tag}`);
  // Same targeting as scripts/registerCommands.js: guild-scoped when
  // DISCORD_GUILD_ID is set (instant), otherwise global (up to ~1h).
  try {
    await c.application.commands.set(commandData, config.discord.guildId ?? undefined);
    logger.info(`Registered ${commandData.length} slash command(s)`);
  } catch (err) {
    // Non-fatal: previously registered commands keep working.
    logger.warn(`Failed to register slash commands: ${err.message}`);
  }
  try {
    await startPoller({ client });
  } catch (err) {
    logger.error(`Failed to start poller: ${err.message}`);
    // A poller that can't resolve the configured channel is unrecoverable —
    // exit so a process supervisor (pm2/systemd/etc.) can restart cleanly.
    process.exit(1);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await handleInteraction(interaction);
  } catch (err) {
    // handleInteraction does its own try/catch; this is the safety net.
    logger.error(`Unhandled interaction error: ${err.stack ?? err.message}`);
  }
});

export async function start() {
  await client.login(config.discord.token);
}

export async function shutdown() {
  stopPoller();
  await client.destroy();
}

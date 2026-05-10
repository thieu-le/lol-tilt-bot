// One-shot script to (re)register slash commands with Discord.
//   - If DISCORD_GUILD_ID is set, registers per-guild (instant propagation).
//   - Otherwise registers globally (can take up to ~1h to propagate).
//
// Run via: `npm run register-commands`

import { REST, Routes } from 'discord.js';
import { config } from '../src/config.js';
import { commandData } from '../src/commands.js';
import { logger } from '../src/logger.js';

async function main() {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const route = config.discord.guildId
    ? Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId)
    : Routes.applicationCommands(config.discord.clientId);

  const target = config.discord.guildId
    ? `guild ${config.discord.guildId}`
    : 'global scope';
  logger.info(`Registering ${commandData.length} command(s) to ${target}…`);

  const result = await rest.put(route, { body: commandData });
  logger.info(`Done. Discord acknowledged ${Array.isArray(result) ? result.length : 'n/a'} command(s).`);
}

main().catch((err) => {
  logger.error(`Failed to register commands: ${err.stack ?? err.message}`);
  process.exit(1);
});

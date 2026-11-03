# Discord Community lifecycle module

`DiscordCommunity` provides archive-first ticket and temporary voice-room workflows without opening a second Gateway connection. The runner owns Gateway dispatch, public and private archive hosts, the namespace-scoped JSON state implementation, and the periodic `tick` call.

## API

- `new DiscordCommunity(config, host, api)` validates the guild, owner, bot, role, and channel identifiers.
- `acknowledge(packet)` immediately opens a bilingual ticket modal or defers an ephemeral command/component response. It does not claim that a ticket has been accepted.
- `handleDispatch(packet, signal)` commits submitted ticket text to the private archive and persists compact lifecycle intents. It does not call Discord REST for lifecycle actions.
- `tick(signal)` creates/reconciles ticket channels and voice rooms, posts private ticket controls, applies ticket access/status changes, updates voice room settings, and performs archive-first cleanup. Call it periodically outside the serialized Gateway callback.
- `managedTicketChannelIds()` returns registered ticket channel IDs for private archive allowlisting.
- `registerCommands(signal)` registers the bilingual `/ticket` and `/room` command groups for this guild.
- `publishPanels(signal)` idempotently publishes the ticket and voice lobby instruction panels.

Ticket state lives under `ticket:` and `ticket:open:`. Room state lives under `room:` and `room:owner:`. Interaction de-duplication records only status and entity/evidence references. Submitted text is stored only as a private archive event and is fetched from that archive when creating the ticket intro. Interaction tokens are never stored; deferred replies are best-effort in-memory follow-ups after durable state changes.

Unknown ticket channel creates use deterministic topic markers; voice rooms use a human-readable party-code suffix in the channel name. An unresolved create remains held for manual review instead of being repeated. Unknown deletes are checked with GET before another DELETE. The voice gateway snapshot reconciles occupancy after reconnect; rooms are deleted only after the empty interval and final channel flush. Use the existing repository `pnpm discord:bot` entry point; see [bot behavior and privacy](../../docs/DISCORD-BOT.md).

`DiscordREST` is a small Node `fetch` client. It retries GETs and definitive 429 responses. Network failures or 5xx responses for mutations throw `OUTCOME_UNKNOWN`; callers must reconcile before another create. It has no Discord.js dependency and uses only the plugin SDK and Node built-ins.

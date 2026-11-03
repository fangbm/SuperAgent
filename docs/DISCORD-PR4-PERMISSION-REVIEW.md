# PR #4 permission review

Discord's [Edit Channel Permissions endpoint](https://docs.discord.com/developers/resources/channel#edit-channel-permissions) and its matching delete endpoint require `MANAGE_ROLES`. The bot install URL did not request that permission, and ticket channel overwrites did not grant it locally. As a result, closing a ticket could update durable state while Discord rejected the overwrite that makes the ticket read-only; staff add/remove access operations could also fail.

The install URL now requests the documented `MANAGE_ROLES` bit (28) while continuing to omit `Administrator`. The implementation uses this permission for channel overwrites; it has no code that creates, edits, or assigns guild roles. A focused fake-Discord test verifies that overwrite PUT/DELETE requests fail without the permission and succeed after it is restored, and that ticket state remains retryable after a 403.

Create reconciliation remains deliberately conservative after an ambiguous channel-create result: if a successful marker lookup finds no channel, the bot does not blindly repeat the create. A crash after persisting `creating` but before sending the request can therefore leave the ticket or room awaiting manual reconciliation. This review records that limitation without changing the retry policy.
